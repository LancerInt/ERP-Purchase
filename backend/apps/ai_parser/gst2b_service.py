"""GSTR-2B parsing + reconciliation.

Reads the portal Excel (B2B sheet), matches each supplier invoice against our
Purchase Bills, and classifies every row into one of four buckets:
    MATCHED · MISMATCH · ONLY_2B (missing in our books) · ONLY_BOOKS (missing in 2B)

Read-only against our data — VendorBills are only read, never changed.
"""
import io
import logging
import re
from datetime import date
from decimal import Decimal, InvalidOperation

logger = logging.getLogger(__name__)

GSTIN_RE = re.compile(r'^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$')
_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def _dec(v):
    if v is None or v == '':
        return Decimal('0')
    try:
        return Decimal(str(v).replace(',', '').strip())
    except (InvalidOperation, ValueError):
        return Decimal('0')


def _pdate(v):
    if v is None or v == '':
        return None
    if hasattr(v, 'year'):          # already a datetime/date
        return v.date() if hasattr(v, 'hour') else v
    from datetime import datetime
    for fmt in ('%d/%m/%Y', '%d-%m-%Y', '%Y-%m-%d', '%d-%b-%Y'):
        try:
            return datetime.strptime(str(v).strip(), fmt).date()
        except ValueError:
            continue
    return None


def parse_2b(file_bytes):
    """Return list of B2B invoice dicts from the 2B workbook."""
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
    out = []
    if 'B2B' not in wb.sheetnames:
        return out
    ws = wb['B2B']
    # Column order (0-based): 0 gstin, 1 name, 2 inv_no, 3 type, 4 date, 5 inv_value,
    # 6 place, 7 reverse, 8 taxable, 9 igst, 10 cgst, 11 sgst, 12 cess, 15 itc.
    for r in ws.iter_rows(values_only=True):
        g = (str(r[0]).strip() if r[0] else '')
        if not GSTIN_RE.match(g):
            continue    # skips titles / header / sub-header / totals
        out.append({
            'section': 'B2B',
            'supplier_gstin': g,
            'supplier_name': (str(r[1] or '').strip())[:255],
            'invoice_no': (str(r[2] or '').strip())[:100],
            'invoice_date': _pdate(r[4]),
            'invoice_value': _dec(r[5]),
            'taxable': _dec(r[8]),
            'igst': _dec(r[9]), 'cgst': _dec(r[10]), 'sgst': _dec(r[11]), 'cess': _dec(r[12]),
            'itc_available': (str(r[15] or '').strip())[:8] if len(r) > 15 else '',
        })
    return out


def _norm_inv(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def period_from_name(filename):
    """GST 2B files start with MMYYYY (e.g. 062026_...). Return (label, start, end)."""
    m = re.match(r'^(\d{2})(\d{4})', filename or '')
    if not m:
        return '', None, None
    mm, yyyy = int(m.group(1)), int(m.group(2))
    if not (1 <= mm <= 12):
        return '', None, None
    start = date(yyyy, mm, 1)
    end = date(yyyy + (mm == 12), (mm % 12) + 1, 1)
    from datetime import timedelta
    end = end - timedelta(days=1)
    return f"{_MONTHS[mm - 1]} {yyyy}", start, end


def reconcile(upload):
    """Parse the upload, match every 2B row against our bills, store results."""
    from django.db.models import Q
    from master.models import Vendor
    from purchase.models import VendorBill
    from .gst2b_models import Gst2BRow

    upload.file.open('rb')
    try:
        data = upload.file.read()
    finally:
        upload.file.close()

    try:
        rows = parse_2b(data)
    except Exception as e:  # noqa: BLE001
        logger.exception('2B parse failed')
        upload.error_message = f'Could not read the file: {e}'
        upload.save(update_fields=['error_message'])
        return upload

    upload.rows.all().delete()
    counts = {'MATCHED': 0, 'MISMATCH': 0, 'ONLY_2B': 0, 'ONLY_BOOKS': 0}
    matched_bill_ids = set()
    supplier_gstins = {r['supplier_gstin'].upper() for r in rows}

    # Which supplier GSTINs exist as ANY vendor (duplicates included).
    vendor_gstins = {(x or '').upper() for x in
                     Vendor.objects.filter(gstin__in=supplier_gstins).values_list('gstin', flat=True)}

    # Preload our bills per supplier GSTIN (across ALL duplicate vendor masters).
    # Books store OUR ref in the invoice field (e.g. "SSB-0230"), NOT the
    # supplier's number ("SG26-25") — so we match on GSTIN + taxable amount +
    # date, with invoice-number as a bonus. Amount+date is the reliable key.
    from collections import defaultdict
    bills_by_gstin = defaultdict(list)
    inv_index = {}     # (gstin, norm-inv) -> bill  (exact invoice-no bonus match)
    for b in (VendorBill.objects.filter(vendor__gstin__in=supplier_gstins, is_active=True)
              .select_related('vendor')
              .exclude(vendor_invoice_no__iexact='OPENING').exclude(bill_no__iexact='OPENING')):
        g = (b.vendor.gstin or '').upper()
        bills_by_gstin[g].append(b)
        for key in {_norm_inv(b.vendor_invoice_no), _norm_inv(b.bill_no)}:
            if key:
                inv_index.setdefault((g, key), b)

    def _find_bill(g, rd):
        # 1. exact supplier invoice number (works only if books happen to store it)
        b = inv_index.get((g, _norm_inv(rd['invoice_no'])))
        if b and b.id not in matched_bill_ids:
            return b, ''
        # 2. taxable amount (±2%) + date (±15 days) — the reliable match
        tax = rd['taxable']
        if tax:
            tol = max(Decimal('1'), tax * Decimal('0.02'))
            best, best_dd = None, None
            for cand in bills_by_gstin.get(g, []):
                if cand.id in matched_bill_ids:
                    continue
                if abs((cand.subtotal or Decimal('0')) - tax) <= tol:
                    dd = (abs((cand.bill_date - rd['invoice_date']).days)
                          if cand.bill_date and rd['invoice_date'] else 999)
                    # ±45 days: a supplier often reports in a later return period
                    # than we booked the bill (a timing difference, not a missing
                    # bill). 15 days was too tight and left real matches as
                    # "only in 2B". The amount is the strong key; the date only
                    # breaks ties between same-amount bills.
                    if dd <= 45 and (best_dd is None or dd < best_dd):
                        best, best_dd = cand, dd
            if best:
                return best, ''
        return None, ''

    for rd in rows:
        g = rd['supplier_gstin'].upper()
        total_tax = rd['igst'] + rd['cgst'] + rd['sgst'] + rd['cess']
        bill, note = _find_bill(g, rd)
        if bill is None:
            status = 'ONLY_2B'
            note = ('Invoice not found in our books' if g in vendor_gstins
                    else 'Supplier GSTIN not in ERP vendors')
        else:
            matched_bill_ids.add(bill.id)
            # A bill matched on taxable+date can still carry a DIFFERENT tax than
            # the 2B (wrong rate, or we booked CGST+SGST where the supplier
            # charged IGST, etc.). That is a genuine amount mismatch — the ITC we
            # can claim differs from what we booked — so flag it instead of
            # calling it a clean match. Tolerance: ₹1 or 0.5% of the 2B tax.
            bill_tax = bill.tax_amount or Decimal('0')
            tax_tol = max(Decimal('1'), total_tax * Decimal('0.005'))
            if abs(total_tax - bill_tax) > tax_tol:
                status = 'MISMATCH'
                note = (f'Tax differs — 2B {total_tax:,.2f} vs books {bill_tax:,.2f} '
                        f'(Δ {total_tax - bill_tax:,.2f})')
            else:
                status = 'MATCHED'
                note = ''
        Gst2BRow.objects.create(
            upload=upload, matched_bill=bill, status=status, note=note[:255],
            total_tax=total_tax, **{k: rd[k] for k in (
                'section', 'supplier_gstin', 'supplier_name', 'invoice_no', 'invoice_date',
                'invoice_value', 'taxable', 'igst', 'cgst', 'sgst', 'cess', 'itc_available')})
        counts[status] += 1

    # ONLY_BOOKS — bills of these suppliers in the period that the supplier did
    # NOT report in 2B (our input-tax-credit at risk).
    if upload.period_start and upload.period_end and supplier_gstins:
        vendor_ids = list(Vendor.objects.filter(gstin__in=supplier_gstins).values_list('id', flat=True))
        book_bills = (VendorBill.objects.filter(
            vendor_id__in=vendor_ids, is_active=True,
            bill_date__gte=upload.period_start, bill_date__lte=upload.period_end)
            .exclude(id__in=matched_bill_ids)
            .exclude(vendor_invoice_no__iexact='OPENING')
            .exclude(bill_no__iexact='OPENING')
            .select_related('vendor'))
        for b in book_bills:
            Gst2BRow.objects.create(
                upload=upload, matched_bill=b, status='ONLY_BOOKS',
                supplier_gstin=(b.vendor.gstin or ''), supplier_name=b.vendor.vendor_name,
                invoice_no=(b.vendor_invoice_no or b.bill_no)[:100], invoice_date=b.bill_date,
                invoice_value=b.total_amount, taxable=b.subtotal, total_tax=b.tax_amount,
                note='Supplier has not reported this in 2B — ITC at risk')
            counts['ONLY_BOOKS'] += 1

    upload.total_rows = len(rows)
    upload.matched = counts['MATCHED']
    upload.mismatch = counts['MISMATCH']
    upload.only_in_2b = counts['ONLY_2B']
    upload.only_in_books = counts['ONLY_BOOKS']
    upload.error_message = ''
    upload.save(update_fields=['total_rows', 'matched', 'mismatch', 'only_in_2b',
                               'only_in_books', 'error_message'])
    return upload

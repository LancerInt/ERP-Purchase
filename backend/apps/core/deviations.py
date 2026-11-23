"""Compute layer for the unified Deviations report.

Each `*_rows()` helper returns deviations for one category as a list of
NORMALISED rows (see ROW SHAPE below) plus a {count, total} summary, computed
on the fly from the existing source data. `build_report()` fans out to the
requested categories and overlays the persisted acknowledge/resolve state
(DeviationAck) by each row's stable `dedup_key`.

ROW SHAPE (common to every category, so one FE table renders all):
    {
      'dedup_key': str,     # stable business identity (NOT a volatile PK)
      'category':  str,     # DeviationAck.CATEGORY_CHOICES key
      'party':     str,     # vendor / customer name
      'ref':       str,     # invoice / bill number
      'ref_id':    str|None,# source id for the drill link
      'date':      str,     # 'YYYY-MM-DD'
      'days_overdue': int|None,
      'amount':    str,     # ₹ outstanding / value at risk
      'detail':    str,     # short note (interest estimate, mismatch reason…)
      'severity':  'high'|'med'|'low',
      'link':      str|None,# FE drill path
      'ack':       None,    # {status, note} filled in by build_report()
    }
"""
import datetime
import math
from decimal import Decimal, ROUND_HALF_UP
from urllib.parse import quote

CATEGORIES = ('MSME_PAY', 'MSME_RECV', 'GSTR1', 'GSTR2B', 'TALLY_ERP',
              'PAYMENT_MADE', 'PAYMENT_RECV', 'EXCEPTION')


def _sev(days):
    if days is None:
        return 'med'
    if days > 90:
        return 'high'
    if days > 30:
        return 'med'
    return 'low'


# ── MSME receivables (we are the MSME supplier; customers overdue > 45d) ──────
def msme_receivable_report(company, rate='18'):
    """Backward-compatible payload for /companies/<id>/msme-receivables/.

    Returns {is_msme, rate_used, rows:[{invoice_no, customer, invoice_date,
    appointed_day, days_overdue, balance, interest_estimate}], summary}.
    """
    from sales.models import ReceivableLedger

    if not getattr(company, 'is_msme', False):
        return {'is_msme': False, 'rows': [], 'summary': {}}
    try:
        annual = Decimal(str(rate or '18'))
    except (ValueError, ArithmeticError):
        annual = Decimal('18')
    today = datetime.date.today()
    APPOINTED_DAYS = 45  # §15 maximum credit period

    qs = (ReceivableLedger.objects
          .filter(invoice_reference__company_id=company.id, is_active=True,
                  balance__gt=0)
          .select_related('customer', 'invoice_reference')
          .only('balance', 'invoice_date', 'due_date', 'invoice_reference_id',
                'customer__customer_name', 'invoice_reference__invoice_no'))
    rows, total_bal, total_int = [], Decimal('0'), Decimal('0')
    for r in qs:
        base_date = r.invoice_date or r.due_date
        if not base_date:
            continue
        appointed = base_date + datetime.timedelta(days=APPOINTED_DAYS)
        days_overdue = (today - appointed).days
        if days_overdue <= 0:
            continue
        bal = Decimal(r.balance or 0)
        months = days_overdue / 30.0
        factor = math.pow(1.0 + float(annual) / 1200.0, months)
        interest = (bal * Decimal(str(factor - 1.0))).quantize(
            Decimal('1'), rounding=ROUND_HALF_UP)
        total_bal += bal
        total_int += interest
        rows.append({
            'invoice_id': str(r.invoice_reference_id) if r.invoice_reference_id else None,
            'invoice_no': r.invoice_reference.invoice_no,
            'customer': r.customer.customer_name if r.customer_id else '',
            'invoice_date': base_date.isoformat(),
            'appointed_day': appointed.isoformat(),
            'days_overdue': days_overdue,
            'balance': str(bal),
            'interest_estimate': str(interest),
        })
    rows.sort(key=lambda x: -x['days_overdue'])
    return {
        'is_msme': True, 'rate_used': str(annual), 'rows': rows,
        'summary': {
            'count': len(rows),
            'total_balance': str(total_bal),
            'total_interest_estimate': str(total_int),
        },
    }


def msme_recv_rows(company):
    rep = msme_receivable_report(company)
    out = []
    for r in rep['rows']:
        out.append({
            'dedup_key': f"msme_recv:{company.id}:{r.get('invoice_id') or r['invoice_no']}",
            'category': 'MSME_RECV',
            'party': r['customer'],
            'ref': r['invoice_no'],
            'ref_id': r.get('invoice_id'),
            'date': r['invoice_date'],
            'days_overdue': r['days_overdue'],
            'amount': r['balance'],
            'detail': f"Interest est. ₹{r['interest_estimate']} · appointed day {r['appointed_day']}",
            'severity': _sev(r['days_overdue']),
            'link': f"/sales/invoices/{r['invoice_id']}" if r.get('invoice_id') else None,
            'ack': None,
        })
    total = sum(Decimal(r['balance']) for r in rep['rows']) if rep['rows'] else Decimal('0')
    return out, {'count': len(out), 'total': str(total)}


# ── MSME payables (we owe MSME vendors past the §15 limit; 43B(h) risk) ───────
def msme_payable_rows(company):
    """Open MSME-vendor bills past the statutory payment limit.

    Only MICRO/SMALL vendors are protected (§15); the limit is 45 days when a
    written supply agreement exists, else 15. Outstanding = total_amount −
    amount_paid. Excludes draft/cancelled/opening bills.
    """
    from django.db.models import Q, F
    from purchase.models import VendorBill

    today = datetime.date.today()
    qs = (VendorBill.objects
          .filter(is_active=True, vendor__is_msme=True,
                  vendor__msme_category__in=['MICRO', 'SMALL'])
          .exclude(status__in=['DRAFT', 'CANCELLED', 'TALLY_OPENING'])
          .annotate(outstanding=F('total_amount') - F('amount_paid'))
          .filter(outstanding__gt=0))
    if company is not None:
        qs = qs.filter(
            Q(purchase_order__company_id=company.id)
            | Q(receipt_advice__warehouse__company_id=company.id)
            | Q(vendor__company_id=company.id))
    qs = qs.select_related('vendor').only(
        'id', 'bill_no', 'vendor_invoice_no', 'bill_date', 'total_amount',
        'amount_paid', 'vendor__vendor_name', 'vendor__has_written_agreement',
        'vendor__msme_category')

    rows, total = [], Decimal('0')
    for b in qs:
        if not b.bill_date:
            continue
        limit = 45 if getattr(b.vendor, 'has_written_agreement', False) else 15
        appointed = b.bill_date + datetime.timedelta(days=limit)
        days_overdue = (today - appointed).days
        if days_overdue <= 0:
            continue
        outstanding = (b.total_amount or Decimal('0')) - (b.amount_paid or Decimal('0'))
        if outstanding <= 0:
            continue
        total += outstanding
        rows.append({
            'dedup_key': f"msme_pay:{company.id if company else 'all'}:{b.id}",
            'category': 'MSME_PAY',
            'party': getattr(b.vendor, 'vendor_name', '') or '',
            'ref': b.vendor_invoice_no or b.bill_no,
            'ref_id': str(b.id),
            'date': b.bill_date.isoformat(),
            'days_overdue': days_overdue,
            'amount': str(outstanding),
            'detail': f"{limit}-day limit ({'with' if limit == 45 else 'no'} written agreement) · "
                      f"{b.vendor.get_msme_category_display() if b.vendor.msme_category else 'MSME'}",
            'severity': _sev(days_overdue),
            'link': f"/purchase/bills/{b.id}",
            'ack': None,
        })
    rows.sort(key=lambda x: -(x['days_overdue'] or 0))
    return rows, {'count': len(rows), 'total': str(total)}


# ── Remaining categories (GSTR-1, GSTR-2B, ERP↔Tally, Exceptions) ─────────────
# Implemented in follow-up layers; each returns (rows, summary) in the shape
# above so build_report() and the FE need no change when they land.
_GSTR_LABEL = {
    'MISMATCH': 'Tax / value mismatch',
    'ONLY_GSTR1': 'In GSTR-1, not in books',
    'ONLY_BOOKS': 'In books, not in GSTR-1',
    'ONLY_2B': 'In GSTR-2B, not in books',
}
_GSTR_SEV = {'MISMATCH': 'med', 'ONLY_GSTR1': 'high', 'ONLY_BOOKS': 'high',
             'ONLY_2B': 'high'}

# Plain-language explanations so a Deviations row says what the problem IS and
# what to do about it, instead of repeating the terse bucket name. The old
# detail ("In GSTR-2B, not in books · ITC Yes · Apr 2026") told the reader the
# bucket but not the meaning or the action.
_GSTR2B_DETAIL = {
    'ONLY_2B': "Supplier reported this invoice in GSTR-2B, but there's no matching "
               "purchase bill in your books — book it to claim the ITC",
    'ONLY_BOOKS': "You have booked this bill, but the supplier has NOT filed it in "
                  "GSTR-2B — your input-tax credit is blocked until they do",
    'MISMATCH': "The taxable value in GSTR-2B differs from your purchase bill — "
                "check which figure is correct",
}
_GSTR1_DETAIL = {
    'ONLY_GSTR1': "Reported to the government in GSTR-1, but no matching sales "
                  "invoice exists in your books — check it",
    'ONLY_BOOKS': "In your sales invoices but NOT reported in GSTR-1 — a filing "
                  "gap; include it in your next return",
    'MISMATCH': "The taxable value in GSTR-1 differs from your sales invoice — "
                "check which figure is correct",
}


def gstr1_rows(company, dfrom, dto):
    """Non-matched rows from the latest GSTR-1 reconciliation upload for the
    company. (GSTR uploads are period-bound to the filed return, so we use the
    most recent upload rather than mapping the page period to its free text.)"""
    if company is None:
        return [], {'count': 0, 'total': '0'}
    from ai_parser.gstr1_models import Gstr1Upload
    up = (Gstr1Upload.objects.filter(company_id=company.id, is_active=True)
          .order_by('-created_at').first())
    if up is None:
        return [], {'count': 0, 'total': '0'}
    unmatched = list(up.rows.filter(is_active=True).exclude(status='MATCHED')
                     .select_related('matched_invoice'))
    # Resolve customer GSTIN → the EXACT ERP customer name, so an unmatched
    # GSTR-1 row deep-links reliably to that customer's invoices even when the
    # filed name differs from the ERP master (GSTIN is the matching key). One
    # query for the page; first customer wins on duplicate masters.
    from master.models import Customer
    cust_gstins = {(r.customer_gstin or '').upper() for r in unmatched if r.customer_gstin}
    customer_by_gstin = {}
    if cust_gstins:
        for g, name in (Customer.objects.filter(gstin__in=cust_gstins)
                        .values_list('gstin', 'customer_name')):
            customer_by_gstin.setdefault((g or '').upper(), name)
    rows, total = [], Decimal('0')
    for r in unmatched:
        amt = r.invoice_value or Decimal('0')
        total += amt
        inv_id = str(r.matched_invoice_id) if r.matched_invoice_id else None
        erp_customer = customer_by_gstin.get((r.customer_gstin or '').upper())
        rows.append({
            'dedup_key': f"gstr1:{company.id}:{up.period}:{r.section}:{r.invoice_no}",
            'category': 'GSTR1',
            'party': r.customer_name or erp_customer or '',
            'ref': r.invoice_no or '—',
            'ref_id': inv_id,
            'date': r.invoice_date.isoformat() if r.invoice_date else None,
            'days_overdue': None,
            'amount': str(amt),
            # Explain the deviation, then add the row's own specific reason (for
            # "only in GSTR-1" that names WHY — e.g. customer GSTIN not in the
            # ERP) and the return period. For the other buckets the note just
            # restates the bucket, so it's folded into the explanation above.
            'detail': (
                _GSTR1_DETAIL.get(r.status, _GSTR_LABEL.get(r.status, r.status))
                + (f" ({r.note})" if r.status == 'ONLY_GSTR1' and r.note else "")
                + f" · {up.period or up.file_name}"
            ),
            'severity': _GSTR_SEV.get(r.status, 'med'),
            # Matched invoice → open it; else, if the customer exists in the ERP
            # (resolved by GSTIN), that customer's invoices by EXACT name; else
            # plain text (the customer isn't in the ERP — a search would be empty).
            'link': (f"/sales/invoices/{inv_id}" if inv_id
                     else f"/sales/invoices?customer={quote(erp_customer)}" if erp_customer
                     else None),
            'ack': None,
        })
    return rows, {'count': len(rows), 'total': str(total)}


def gstr2b_rows(company, dfrom, dto):
    """Non-matched rows from the latest GSTR-2B reconciliation upload."""
    if company is None:
        return [], {'count': 0, 'total': '0'}
    from ai_parser.gst2b_models import Gst2BUpload
    up = (Gst2BUpload.objects.filter(company_id=company.id, is_active=True)
          .order_by('-created_at').first())
    if up is None:
        return [], {'count': 0, 'total': '0'}
    unmatched = list(up.rows.filter(is_active=True).exclude(status='MATCHED')
                     .select_related('matched_bill'))
    # Resolve supplier GSTIN → the EXACT ERP vendor name, so an unbooked 2B row
    # can deep-link to that vendor's bills reliably. The 2B supplier name
    # ("ABT Logistics") routinely differs from the ERP vendor name ("ABT Parcel
    # Service"), so a name search would miss a vendor that actually exists —
    # GSTIN is the key the reconciliation itself matches on. One query for the
    # whole page; first vendor wins when a GSTIN has duplicate masters.
    from master.models import Vendor
    gstins = {(r.supplier_gstin or '').upper() for r in unmatched if r.supplier_gstin}
    vendor_by_gstin = {}
    if gstins:
        for g, name in (Vendor.objects.filter(gstin__in=gstins)
                        .values_list('gstin', 'vendor_name')):
            vendor_by_gstin.setdefault((g or '').upper(), name)
    rows, total = [], Decimal('0')
    for r in unmatched:
        amt = r.invoice_value or Decimal('0')
        total += amt
        bill_id = str(r.matched_bill_id) if r.matched_bill_id else None
        erp_vendor = vendor_by_gstin.get((r.supplier_gstin or '').upper())
        rows.append({
            'dedup_key': f"gstr2b:{company.id}:{up.period}:{r.supplier_gstin}:{r.invoice_no}",
            'category': 'GSTR2B',
            'party': r.supplier_name or '',
            'ref': r.invoice_no or '—',
            'ref_id': bill_id,
            'date': None,
            'days_overdue': None,
            'amount': str(amt),
            # Explain the deviation, then add the row's own specific reason (for
            # "only in 2B" that names WHY it's unmatched — supplier GSTIN not in
            # the ERP, or the bill simply isn't entered), the ITC-eligibility
            # flag from 2B, and the return period. For "only in books" the note
            # restates the bucket, so it's folded into the explanation above.
            'detail': (
                _GSTR2B_DETAIL.get(r.status, _GSTR_LABEL.get(r.status, r.status))
                + (f" ({r.note})" if r.status == 'ONLY_2B' and r.note else "")
                + (f" · ITC {r.itc_available}" if r.itc_available else "")
                + f" · {up.period or up.file_name}"
            ),
            'severity': _GSTR_SEV.get(r.status, 'med'),
            # Make the reference open something USEFUL and RELIABLE:
            #  • matched bill  → open it directly;
            #  • vendor exists in the ERP (resolved by GSTIN) → that vendor's
            #    bills, by EXACT name + all bill types, so the bill shows even if
            #    it's an expense/transfer and even when the 2B name differs;
            #  • supplier not a vendor at all → plain text (a search would always
            #    be empty — that's the finding).
            'link': (f"/purchase/bills/{bill_id}" if bill_id
                     else f"/purchase/bills?vend={quote(erp_vendor)}&type=all" if erp_vendor
                     else None),
            'ack': None,
        })
    return rows, {'count': len(rows), 'total': str(total)}


def _fy_window(dfrom, dto):
    """Use the given window, else default to the current financial year to date."""
    today = datetime.date.today()
    if dfrom and dto:
        return dfrom, dto
    fy = today.year if today.month >= 4 else today.year - 1
    return f"{fy}-04-01", today.isoformat()


def tally_erp_rows(company, dfrom, dto):
    """Bills that exist on one side only: in ERP but not synced to Tally
    (only_scan — the actionable gap), or imported from Tally but never captured
    by ERP scan (only_tally). Capped per bucket to keep the list readable."""
    from purchase.dashboard_views import PurchaseDashboardView
    from purchase.source_classify import annotate_source, _TALLY_Q, _SCAN_Q

    start, end = _fy_window(dfrom, dto)
    base = (PurchaseDashboardView._bill_qs(company.id if company else None, None, None)
            .filter(bill_date__gte=start, bill_date__lte=end)
            .exclude(status='CANCELLED').exclude(tally_guid__startswith='OPENING'))
    base = annotate_source(base)
    CAP = 200
    rows, total = [], Decimal('0')

    def add(bqs, bucket, label_text, sev):
        count = 0
        for b in (bqs.select_related('vendor').only(
                'id', 'bill_no', 'vendor_invoice_no', 'bill_date', 'total_amount',
                'vendor__vendor_name')[:CAP]):
            nonlocal_total.append(b.total_amount or Decimal('0'))
            rows.append({
                'dedup_key': f"tallyerp:{company.id if company else 'all'}:bill:{b.id}",
                'category': 'TALLY_ERP',
                'party': getattr(b.vendor, 'vendor_name', '') or '',
                'ref': b.vendor_invoice_no or b.bill_no,
                'ref_id': str(b.id),
                'date': b.bill_date.isoformat() if b.bill_date else None,
                'days_overdue': None,
                'amount': str(b.total_amount or Decimal('0')),
                'detail': label_text,
                'severity': sev,
                'link': f"/purchase/bills/{b.id}",
                'ack': None,
            })
            count += 1
        return count

    # Only the actionable gap: bills in ERP that haven't synced to Tally.
    # (only_tally bills are legitimately in both — imported from Tally — so they
    # are not deviations and would just flood the list.)
    nonlocal_total = []
    add(base.filter(~_TALLY_Q), 'only_scan', 'In ERP, not in Tally', 'high')
    total = sum(nonlocal_total) if nonlocal_total else Decimal('0')
    return rows, {'count': len(rows), 'total': str(total)}


def exception_rows(company, dfrom, dto):
    """Operational exceptions: bills overdue (balance > 0, past due date) and
    unfinalised DRAFT bills. Period-scoped on bill_date."""
    from django.db.models import Q, F
    from purchase.dashboard_views import PurchaseDashboardView

    today = datetime.date.today()
    start, end = _fy_window(dfrom, dto)
    base = (PurchaseDashboardView._bill_qs(company.id if company else None, None, None)
            .exclude(tally_guid__startswith='OPENING')
            .exclude(status='TALLY_OPENING'))
    rows, total = [], Decimal('0')

    overdue = (base.exclude(status__in=['PAID', 'CANCELLED', 'DRAFT'])
               .annotate(outstanding=F('total_amount') - F('amount_paid'))
               .filter(outstanding__gt=0, due_date__isnull=False, due_date__lt=today)
               .select_related('vendor')
               .only('id', 'bill_no', 'vendor_invoice_no', 'due_date', 'total_amount',
                     'amount_paid', 'vendor__vendor_name')[:500])
    for b in overdue:
        out = (b.total_amount or Decimal('0')) - (b.amount_paid or Decimal('0'))
        days = (today - b.due_date).days
        total += out
        rows.append({
            'dedup_key': f"exc:{company.id if company else 'all'}:overdue:{b.id}",
            'category': 'EXCEPTION',
            'party': getattr(b.vendor, 'vendor_name', '') or '',
            'ref': b.vendor_invoice_no or b.bill_no,
            'ref_id': str(b.id),
            'date': b.due_date.isoformat(),
            'days_overdue': days,
            'amount': str(out),
            'detail': f"Overdue {days}d (due {b.due_date.isoformat()})",
            'severity': _sev(days),
            'link': f"/purchase/bills/{b.id}",
            'ack': None,
        })

    draft = (base.filter(status='DRAFT',
                         bill_date__gte=start, bill_date__lte=end)
             .select_related('vendor')
             .only('id', 'bill_no', 'vendor_invoice_no', 'bill_date', 'total_amount',
                   'vendor__vendor_name')[:500])
    for b in draft:
        amt = b.total_amount or Decimal('0')
        total += amt
        rows.append({
            'dedup_key': f"exc:{company.id if company else 'all'}:draft:{b.id}",
            'category': 'EXCEPTION',
            'party': getattr(b.vendor, 'vendor_name', '') or '',
            'ref': b.vendor_invoice_no or b.bill_no,
            'ref_id': str(b.id),
            'date': b.bill_date.isoformat() if b.bill_date else None,
            'days_overdue': None,
            'amount': str(amt),
            'detail': 'Draft (unfinalised) bill',
            'severity': 'med',
            'link': f"/purchase/bills/{b.id}",
            'ack': None,
        })
    rows.sort(key=lambda x: -(x['days_overdue'] or 0))
    return rows, {'count': len(rows), 'total': str(total)}


# ── Bank payment sheets (CMS / bank statements) ───────────────────────────────
# The uploaded SS/UAI payment sheets (CA/CC, EXP/LF, Salary) are parsed into
# finance.BankStatementLine rows, each tagged MATCHED / UNMATCHED /
# AMOUNT_MISMATCH / DATE_MISMATCH by reconciliation. A non-MATCHED line is a
# deviation: money moved through the bank that the ERP hasn't cleanly tied to a
# bill, expense or entry. Split made (debit) vs received (credit) — receipts are
# mostly Tally-managed, so unmatched credits are lower severity.
_PAY_REASON = {
    'UNMATCHED': 'Not recorded in ERP',
    'AMOUNT_MISMATCH': 'Amount differs from the matched entry',
    'DATE_MISMATCH': 'Date differs from the matched entry',
}


def _payment_rows(company, dfrom, dto, side):
    """side='made' → debit lines; side='recv' → credit lines. Period-scoped on
    txn_date, company-scoped via the statement's bank account."""
    if company is None:
        return [], {'count': 0, 'total': '0'}
    from finance.models import BankStatementLine

    start, end = _fy_window(dfrom, dto)
    qs = (BankStatementLine.objects
          .filter(is_active=True,
                  upload__bank_account__company_id=company.id,
                  txn_date__gte=start, txn_date__lte=end)
          .exclude(match_status='MATCHED')
          .select_related('upload', 'upload__bank_account')
          .only('id', 'txn_date', 'narration', 'reference_no', 'debit', 'credit',
                'match_status', 'line_no', 'upload_id',
                'upload__bank_account__bank_name'))
    qs = qs.filter(debit__gt=0) if side == 'made' else qs.filter(credit__gt=0)
    cat = 'PAYMENT_MADE' if side == 'made' else 'PAYMENT_RECV'

    def sev(status):
        if status == 'UNMATCHED':
            return 'high' if side == 'made' else 'med'
        return 'med' if status == 'AMOUNT_MISMATCH' else 'low'

    # Dedup identical lines. The same bank statement re-imported creates
    # duplicate rows (seen live: one RTGS appearing 11×), which would multiply
    # the "deviation" money. A real transaction is unique on
    # account + date + amount + narration (the narration carries the UTR/ref),
    # so collapse repeats and count each once. (Root cause — duplicate statement
    # uploads — is handled at import; this keeps the tile honest regardless.)
    rows, total, seen = [], Decimal('0'), set()
    for ln in qs:
        amt = (ln.debit if side == 'made' else ln.credit) or Decimal('0')
        acct_id = getattr(ln.upload, 'bank_account_id', None) if ln.upload_id else None
        dkey = (acct_id, ln.txn_date, amt, (ln.narration or '').strip())
        if dkey in seen:
            continue
        seen.add(dkey)
        total += amt
        acct = getattr(ln.upload.bank_account, 'bank_name', '') if ln.upload_id else ''
        rows.append({
            'dedup_key': f"{cat.lower()}:{company.id}:{ln.id}",
            'category': cat,
            'party': (ln.narration or '').strip()[:120] or '—',
            'ref': ln.reference_no or (f"Line {ln.line_no}" if ln.line_no else '—'),
            'ref_id': str(ln.id),
            'date': ln.txn_date.isoformat() if ln.txn_date else None,
            'days_overdue': None,
            'amount': str(amt),
            'detail': _PAY_REASON.get(ln.match_status, ln.match_status)
                      + (f" · {acct}" if acct else ''),
            'severity': sev(ln.match_status),
            'link': f"/bank/reconcile/{ln.upload_id}" if ln.upload_id else "/bank/reconcile",
            'ack': None,
        })
    rows.sort(key=lambda x: -Decimal(x['amount']))
    return rows, {'count': len(rows), 'total': str(total)}


def payment_made_rows(company, dfrom, dto):
    return _payment_rows(company, dfrom, dto, 'made')


def payment_recv_rows(company, dfrom, dto):
    return _payment_rows(company, dfrom, dto, 'recv')


_DISPATCH = {
    'MSME_PAY': lambda c, f, t: msme_payable_rows(c),
    'MSME_RECV': lambda c, f, t: msme_recv_rows(c),
    'GSTR1': lambda c, f, t: gstr1_rows(c, f, t),
    'GSTR2B': lambda c, f, t: gstr2b_rows(c, f, t),
    'TALLY_ERP': lambda c, f, t: tally_erp_rows(c, f, t),
    'PAYMENT_MADE': lambda c, f, t: payment_made_rows(c, f, t),
    'PAYMENT_RECV': lambda c, f, t: payment_recv_rows(c, f, t),
    'EXCEPTION': lambda c, f, t: exception_rows(c, f, t),
}


def build_report(company, dfrom=None, dto=None, only_category=None):
    """Fan out to the requested categories, overlay ack status, return
    {summary:{cat:{count,total}}, tabs:{cat:{rows:[...]}}}.
    """
    from .models import DeviationAck

    cats = [only_category] if only_category in _DISPATCH else list(CATEGORIES)
    summary, tabs, all_keys = {}, {}, []
    for cat in cats:
        rows, summ = _DISPATCH[cat](company, dfrom, dto)
        summary[cat] = summ
        tabs[cat] = {'rows': rows}
        all_keys.extend((cat, r['dedup_key']) for r in rows)

    # One query for every ack touching these rows, then overlay.
    if all_keys:
        keys = [k for _, k in all_keys]
        acks = {
            (a.category, a.dedup_key): a
            for a in DeviationAck.objects.filter(
                dedup_key__in=keys, is_active=True)
        }
        for cat in cats:
            for r in tabs[cat]['rows']:
                a = acks.get((cat, r['dedup_key']))
                if a is not None:
                    r['ack'] = {'status': a.status, 'note': a.note or ''}
    return {'summary': summary, 'tabs': tabs}

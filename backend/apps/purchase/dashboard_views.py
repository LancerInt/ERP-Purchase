"""Purchase Dashboard — work-tracking summary endpoint.

One endpoint that returns every metric the purchase dashboard renders:
stat cards, trend series, top vendors, by-company breakdown. The
frontend never makes per-card requests — a single GET fetches the
whole payload so the dashboard is one round-trip.

Mirrors apps/sales/dashboard_views.py (SalesDashboardView) in structure,
period-window semantics, query-param parsing, previous-period deltas and
response shape so the two dashboards stay consistent.

Date semantics:
    today  : just today                       prev = yesterday
    week   : Monday -> today                  prev = equal-length window before
    month  : 1st of this month -> today       prev = equal-length window before
    custom : ?from=YYYY-MM-DD&to=YYYY-MM-DD   prev = equal-length window before

Numeric amounts / quantities are returned as JSON numbers (floats,
quantized) to match the frontend contract; counts are plain ints.

Which model + date/amount field feeds each metric:
    purchase_requests   PurchaseRequest.request_date (DateTimeField) / approval_status
    purchase_orders     PurchaseOrder.po_date (DateField) / amount = SUM over
                        POLine of (qty*price - qty*price*discount/100)
                        (mirrors PurchaseOrder.get_total_order_value)
    quantity_billed     VendorBill.bill_date, VendorBillLine.quantity grouped by
                        VendorBillLine.uom — i.e. the SAME documents that feed
                        total_purchase / bills, so money and quantity always
                        describe the same set. (This replaced a receipt-sourced
                        quantity: receipts are ERP-native and only exist from
                        the month the warehouse team started using this app, so
                        every earlier month read as "money but no quantity".)
    bills               VendorBill.bill_date (DateField) / total_amount
    amount_paid         PaymentMade.payment_date (DateField) / amount
    outstanding_payables VendorBill (live) SUM(total_amount - amount_paid),
                        excluding PAID / CANCELLED
"""
from datetime import date, datetime, timedelta
from decimal import Decimal

from django.db.models import Count, Sum, F, Q, DecimalField, ExpressionWrapper, Min
from django.db.models.functions import Coalesce, TruncDate
from django.utils import timezone
from rest_framework import permissions
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.response import Response
from rest_framework.views import APIView

from rbac.permissions import HasModulePermission

from .models import (
    PurchaseRequest,
    PurchaseOrder,
    POLine,
    ReceiptAdvice,
    ReceiptLine,
    VendorBill,
    VendorBillLine,
    PaymentMade,
)
from .branch_transfer import branch_transfer_q

# PR approval_status buckets (see PurchaseRequest.APPROVAL_STATUS_CHOICES).
PR_PENDING_STATUSES = ('DRAFT', 'EDITED', 'PENDING', 'PENDING_APPROVAL')
PR_APPROVED_STATUSES = ('APPROVED', 'PARTIALLY_APPROVED')
# A vendor bill is still "owed" unless it's fully paid or cancelled.
BILL_SETTLED_STATUSES = ('PAID', 'CANCELLED')

_ZERO = Decimal('0')
_DATE_MAX = date(9999, 12, 31)   # sort sentinel: undated bills go last (oldest-first)
# Spend categories Tally books OUTSIDE Purchase Accounts (Freight/Machinery/other
# expenses). A bill is "expense-like" — not a real RM+Packing purchase — when its
# category is one of these OR it was flagged is_expense OR it's a journal voucher.
# Mirrors the Bills page's isExpenseLike so the Bills tile count matches the list.
_EXPENSE_CATS = ('FREIGHT', 'EXPENSES', 'MACHINERY', 'LAB_EXPENSE')
# A bill is expense-like (not a real RM+Packing purchase) when flagged
# is_expense, OR in an expense category, OR booked as a journal voucher. Shared
# by the Bills tile and the Outstanding views so they count the same universe.
_OUTSTANDING_EXPENSE_LIKE = (Q(is_expense=True)
                             | Q(purchase_category__in=_EXPENSE_CATS)
                             | Q(tally_voucher_type__icontains='journal'))

# A PAYMENT is expense-like (freight / expense, NOT an RM+Packing purchase) when
# the bill it settles is expense-like; for an on-account payment (no bill) fall
# back to the vendor's role. Lets the Purchase dashboard's Amount Paid show ONLY
# purchase payments, the way its Total Purchase / Bills / Outstanding tiles
# already exclude expense-like bills. Freight/Expense analytics own those.
# Prefixed with 'bill__' / 'vendor__' to filter a PaymentMade queryset.
_PAYMENT_EXPENSE_LIKE = (
    # settles an expense-like bill
    Q(bill__is_expense=True)
    | Q(bill__purchase_category__in=_EXPENSE_CATS)
    | Q(bill__tally_voucher_type__icontains='journal')
    # on-account (no bill) → classify by the vendor's role
    | (Q(bill__isnull=True)
       # vendor_type is a JSONField (list of role codes). The `__contains`
       # list-membership lookup works on PostgreSQL but NOT on SQLite (local
       # dev), where it raises NotSupportedError and 500s the dashboard. Use
       # `__icontains`, a text LIKE over the serialized JSON that behaves the
       # same on both backends — the role codes are distinctive, so a substring
       # match carries no false positives.
       # TRANSPORTER is the canonical transporter value (Tally import stamps it).
       # The 'TRANSPORT' substring icontains matches both TRANSPORTER and any
       # legacy 'TRANSPORT'; FREIGHT is the old manual equivalent. All are
       # freight — kept out of the purchase-only Amount Paid.
       & (Q(vendor__vendor_type__icontains='EXPENSE')
          | Q(vendor__vendor_type__icontains='FREIGHT')
          | Q(vendor__vendor_type__icontains='TRANSPORT')
          | Q(vendor__vendor_type__icontains='CONTRACTOR')
          | Q(vendor__vendor_type__icontains='EMPLOYEE')))
)


def _expense_like_vendor_ids(company_id=None):
    """Vendor ids whose TALLY CREDITOR GROUP is freight/expense (Transport,
    Freight, Labour, Service, R&D, Expenses...). This is the SAME authoritative
    signal bills use (bill_classification.category_from_creditor_group) — needed
    because freight/expense is NOT a Vendor.vendor_type value, so an on-account
    payment to a transporter can only be recognised by its creditor group.
    Cached-cheap: one indexed query over CreditorBalance."""
    from .models import CreditorBalance
    from .bill_classification import category_from_creditor_group
    qs = CreditorBalance.objects.filter(vendor__isnull=False)
    if company_id:
        qs = qs.filter(company_id=company_id)
    ids = set()
    for vid, grp in qs.values_list('vendor_id', 'parent_group').distinct():
        if category_from_creditor_group(grp) in _EXPENSE_CATS:
            ids.add(vid)
    return ids


def _payment_expense_like_q(company_id=None):
    """_PAYMENT_EXPENSE_LIKE plus the on-account creditor-group rule: an
    on-account payment (no bill) to a freight/expense-grouped vendor is
    expense-like too. Use this in .exclude() wherever the purchase Amount-Paid
    figures are built so freight/expense on-account money (e.g. transporters paid
    in round lots with no single bill) stays out of the Purchase dashboard."""
    vids = _expense_like_vendor_ids(company_id)
    q = _PAYMENT_EXPENSE_LIKE
    if vids:
        q = q | (Q(bill__isnull=True) & Q(vendor_id__in=vids))
    return q


# PO line net value = qty*price - qty*price*discount/100 (mirrors
# PurchaseOrder.get_total_order_value). unit_price/discount are non-null.
_PO_LINE_VALUE = (
    F('quantity_ordered') * F('unit_price')
    - F('quantity_ordered') * F('unit_price') * F('discount') / 100
)
# Gross PO line value INCLUDING GST — comparable to a vendor bill's total_amount
# (which is GST-inclusive), so Ordered vs Billed line up.
_PO_LINE_GROSS = _PO_LINE_VALUE + _PO_LINE_VALUE * F('gst') / 100
# ── Product filter ───────────────────────────────────────────────────────
# A row in the "All products" dropdown is either ONE product (a uuid) or a
# whole CATEGORY ("cat:RAW_MATERIAL"). Categories exist because the master is
# 2,600+ products of which 865 are machine spares: "how much did we spend on
# packing this year" is a question people actually have, and picking one bolt
# out of that list is not.
#
# Both shapes resolve to a LIST of ids here, so every filter downstream is a
# plain __in and nothing else needs to know which was chosen.
_PRODUCT_CATEGORY_PREFIX = 'cat:'
# A category matching no product must show NOTHING, not everything. An empty
# list is falsy, and every call site guards with `if product_id:`, so it would
# silently mean "no filter" — the one answer that is certainly wrong. An
# impossible id keeps the filter real and empty.
_NO_SUCH_PRODUCT = '00000000-0000-0000-0000-000000000000'


def resolve_product_filter(value):
    """'<uuid>' -> [uuid];  'cat:RAW_MATERIAL' -> every id in that category.

    Returns None for "no filter at all", which is the only falsy result.
    """
    value = (value or '').strip()
    if not value:
        return None
    if not value.startswith(_PRODUCT_CATEGORY_PREFIX):
        # Several ids at once (a product family) arrive comma-separated. Kept
        # in step with sales.product_scope so both dashboards accept the same
        # values.
        if ',' in value:
            return [p for p in (x.strip() for x in value.split(',')) if p] or None
        return [value]
    sub_type = value[len(_PRODUCT_CATEGORY_PREFIX):].strip()
    if not sub_type:
        return None
    from master.models import Product
    ids = [str(i) for i in Product.objects.filter(
        goods_sub_type=sub_type).values_list('id', flat=True)]
    return ids or [_NO_SUCH_PRODUCT]


_BILL_BALANCE = ExpressionWrapper(
    F('total_amount') - F('amount_paid'),
    output_field=DecimalField(max_digits=20, decimal_places=2),
)


def _money(value):
    """Decimal|None -> float rounded to paise, JSON-safe."""
    return float((value or _ZERO).quantize(Decimal('0.01')))


def _qty(value):
    """Decimal|None -> float rounded to 3 dp, JSON-safe."""
    return float((value or _ZERO).quantize(Decimal('0.001')))


# Unit-of-measure normalisation. Tally / scanned data carries the same unit under
# many spellings ("NOS" / "Nos" / "nos ", "KG" / "KGS", "LTR" / "LTRS", "PIECE" /
# "PCS"), which showed up as DUPLICATE rows on the Quantity Billed card ("two NOS,
# two MTR" — same label, separate rows). Fold the synonyms so each real unit is
# one line. MTS (metric tonnes) is kept DISTINCT from MTR (metres) on purpose.
_UOM_CANON = {
    'NOS': 'NOS', 'NO': 'NOS', 'NOS.': 'NOS', 'NUMBER': 'NOS', 'NUMBERS': 'NOS', 'N': 'NOS',
    'PCS': 'PCS', 'PC': 'PCS', 'PCS.': 'PCS', 'PIECE': 'PCS', 'PIECES': 'PCS', 'PCE': 'PCS',
    'KG': 'KG', 'KGS': 'KG', 'KGM': 'KG', 'KILOGRAM': 'KG', 'KILOGRAMS': 'KG',
    'LTR': 'LTR', 'LTRS': 'LTR', 'LT': 'LTR', 'LITRE': 'LTR', 'LITRES': 'LTR',
    'LITER': 'LTR', 'LITERS': 'LTR',
    'MTR': 'MTR', 'MTRS': 'MTR', 'RMT': 'MTR', 'METER': 'MTR', 'METERS': 'MTR',
    'METRE': 'MTR', 'METRES': 'MTR',
    'MT': 'MTS', 'MTS': 'MTS', 'TON': 'MTS', 'TONS': 'MTS', 'TONNE': 'MTS', 'TONNES': 'MTS',
    'REAM': 'REAM', 'REAMS': 'REAM',
}


def _norm_uom(u):
    k = (u or '').strip().upper()
    return _UOM_CANON.get(k, k)


def _merge_uom(pairs):
    """[(uom, Decimal qty)] -> [{'uom','qty'}] merged by NORMALISED unit, largest
    first. Collapses case / spelling variants so each unit shows exactly once."""
    merged = {}
    for u, q in pairs:
        q = q or _ZERO
        if q == _ZERO:
            continue
        key = _norm_uom(u)
        merged[key] = merged.get(key, _ZERO) + q
    return [{'uom': u, 'qty': _qty(q)}
            for u, q in sorted(merged.items(), key=lambda kv: kv[1], reverse=True)]


def _cached_dup_bill_ids(qs, cache=None):
    """Wrapper around category_views._dup_bill_ids that caches results per
    request.  The cache is a plain dict keyed by the queryset's compiled SQL
    (query string + params).  Pass the SAME dict through every call site inside
    one request so the expensive per-row scan runs at most once per distinct
    queryset.  When *cache* is None it falls through to the uncached original."""
    from .category_views import _dup_bill_ids
    if cache is None:
        return _dup_bill_ids(qs)
    # Compile the queryset to its SQL + params tuple — two querysets that
    # would hit the DB identically share the same key.
    key = str(qs.query)
    if key not in cache:
        cache[key] = _dup_bill_ids(qs)
    return cache[key]


class PurchaseDashboardView(APIView):
    """GET /api/purchase/dashboard/?period=today|week|month|custom&from=...&to=...
    &company=<uuid>&warehouse=<uuid>&vendor=<uuid>&product=<uuid>"""

    permission_classes = [permissions.IsAuthenticated, HasModulePermission]
    module_name = 'Purchase Dashboard'
    # 0066 split 'Purchase Dashboard' into three page modules (Dashboard overview,
    # Analytics, Vendor Insights) that all read this shared endpoint. Accept any
    # of them so unticking 'Purchase Dashboard' but keeping 'Purchase Analytics'
    # still loads the Analytics page instead of 403-ing ("Failed to load
    # dashboard"). Page visibility is gated separately by the nav/route module.
    alternate_modules = ['Purchase Analytics', 'Vendor Insights']

    # ── period helpers (identical semantics to SalesDashboardView) ──────────
    @staticmethod
    def _resolve_range(period, frm, to):
        today = timezone.localdate()
        if period == 'all':
            # All-time: a window wide enough to cover every record. Used by the
            # "All" chip on the standard period navigator so every page can offer
            # it consistently (the records/list endpoints treat a very early
            # start as "no lower bound" in practice).
            return date(2000, 4, 1), today, 'All Time'
        if period == 'today':
            return today, today, 'Today'
        if period == 'week':
            # Honour an explicit window (a chosen PAST week) the navigator sends;
            # fall back to the current week. from/to MUST be read here for the same
            # reason as fy/custom below — the records endpoint forwards `period`
            # verbatim, so ignoring them silently answers "this week".
            try:
                s = datetime.strptime(frm, '%Y-%m-%d').date() if frm else None
                e = datetime.strptime(to, '%Y-%m-%d').date() if to else None
            except (TypeError, ValueError):
                s = e = None
            if s and e:
                if s > e:
                    s, e = e, s
                return s, e, '{:%d %b} - {:%d %b %Y}'.format(s, e)
            start = today - timedelta(days=today.weekday())
            return start, today, 'This Week'
        if period == 'month':
            # Same: a chosen PAST month arrives as from/to (Apr = 2026-04-01..30).
            # Ignoring them was the bug that made every month drill answer "This
            # Month" (the current month) regardless of the picker.
            try:
                s = datetime.strptime(frm, '%Y-%m-%d').date() if frm else None
                e = datetime.strptime(to, '%Y-%m-%d').date() if to else None
            except (TypeError, ValueError):
                s = e = None
            if s and e:
                if s > e:
                    s, e = e, s
                return s, e, '{:%b %Y}'.format(s)
            start = today.replace(day=1)
            return start, today, 'This Month'
        if period == 'fy':
            # Indian financial year: 1 Apr → 31 Mar. The FY navigator sends an
            # explicit window (a whole FY or one of its halves, already capped
            # at today) — honour it; without one, fall back to the current FY
            # to date. Unlike today/week/month above, from/to must be read
            # here: the records endpoint forwards `period` verbatim, so
            # ignoring them would silently answer with "this month".
            try:
                s = datetime.strptime(frm, '%Y-%m-%d').date() if frm else None
                e = datetime.strptime(to, '%Y-%m-%d').date() if to else None
            except (TypeError, ValueError):
                s = e = None
            if s and e:
                if s > e:
                    s, e = e, s
                return s, e, '{:%d %b %Y} - {:%d %b %Y}'.format(s, e)
            fy_start_year = today.year if today.month >= 4 else today.year - 1
            start = date(fy_start_year, 4, 1)
            return start, today, 'FY {}-{:02d} (to date)'.format(fy_start_year, (fy_start_year + 1) % 100)
        if period == 'custom':
            try:
                s = datetime.strptime(frm, '%Y-%m-%d').date() if frm else today
                e = datetime.strptime(to, '%Y-%m-%d').date() if to else today
            except (TypeError, ValueError):
                raise ValidationError("Custom period requires 'from' and 'to' as YYYY-MM-DD.")
            if s > e:
                s, e = e, s
            return s, e, "{} - {}".format(s.isoformat(), e.isoformat())
        # default → this month (matches the endpoint's documented default)
        start = today.replace(day=1)
        return start, today, 'This Month'

    @staticmethod
    def _previous_range(start, end):
        length = (end - start).days
        prev_end = start - timedelta(days=1)
        prev_start = prev_end - timedelta(days=length)
        return prev_start, prev_end

    # ── purchase requests ───────────────────────────────────────────────────
    @staticmethod
    def _pr_stats(start, end, company_id, warehouse_id, product_id):
        """PR count in window + pending/approved breakdown. PR has no vendor
        dimension in this build, so vendor filter is intentionally ignored."""
        qs = PurchaseRequest.objects.filter(
            request_date__date__gte=start, request_date__date__lte=end, is_active=True,
        )
        if company_id:
            qs = qs.filter(company_id=company_id)
        if warehouse_id:
            qs = qs.filter(warehouse_id=warehouse_id)
        if product_id:
            # product lives on PRLine.product_service; the reverse join fans a
            # PR out once per matching line, so distinct() keeps counts honest.
            qs = qs.filter(lines__product_service_id__in=product_id).distinct()
        return {
            'count': qs.count(),
            'pending_count': qs.filter(approval_status__in=PR_PENDING_STATUSES).count(),
            'approved_count': qs.filter(approval_status__in=PR_APPROVED_STATUSES).count(),
        }

    # ── purchase orders ─────────────────────────────────────────────────────
    @staticmethod
    def _po_header_qs(start, end, company_id, warehouse_id, vendor_id, product_id):
        qs = PurchaseOrder.objects.filter(
            po_date__gte=start, po_date__lte=end, is_active=True,
        )
        if company_id:
            qs = qs.filter(company_id=company_id)
        if warehouse_id:
            qs = qs.filter(warehouse_id=warehouse_id)
        if vendor_id:
            qs = qs.filter(vendor_id=vendor_id)
        if product_id:
            qs = qs.filter(po_lines__product_service_id__in=product_id).distinct()
        return qs

    @staticmethod
    def _po_line_qs(start, end, company_id, warehouse_id, vendor_id, product_id):
        """POLine rows for the window's POs — the amount base. Built off the
        line table directly (not header __in) so a product filter never
        double-counts and no distinct-subquery is needed for the Sum."""
        qs = POLine.objects.filter(
            po__po_date__gte=start, po__po_date__lte=end,
            po__is_active=True, is_active=True,
        )
        if company_id:
            qs = qs.filter(po__company_id=company_id)
        if warehouse_id:
            qs = qs.filter(po__warehouse_id=warehouse_id)
        if vendor_id:
            qs = qs.filter(po__vendor_id=vendor_id)
        if product_id:
            qs = qs.filter(product_service_id__in=product_id)
        return qs

    @classmethod
    def _po_stats(cls, start, end, company_id, warehouse_id, vendor_id, product_id):
        header = cls._po_header_qs(start, end, company_id, warehouse_id, vendor_id, product_id)
        line_qs = cls._po_line_qs(start, end, company_id, warehouse_id, vendor_id, product_id)
        total = (
            line_qs.annotate(line_value=_PO_LINE_VALUE)
            .aggregate(t=Sum('line_value'))['t'] or _ZERO
        )
        return {'count': header.count(), 'amount': _money(total)}

    @classmethod
    def _top_vendors(cls, start, end, company_id, warehouse_id, vendor_id, product_id, limit=10):
        rows = (
            cls._po_line_qs(start, end, company_id, warehouse_id, vendor_id, product_id)
            .annotate(line_value=_PO_LINE_VALUE)
            .values('po__vendor_id', 'po__vendor__vendor_name')
            .annotate(amount=Sum('line_value'), po_count=Count('po', distinct=True))
            .order_by('-amount')[:limit]
        )
        return [
            {
                'vendor_id': str(r['po__vendor_id']) if r['po__vendor_id'] else None,
                'vendor_name': r['po__vendor__vendor_name'] or '(no vendor)',
                'po_count': r['po_count'],
                'amount': _money(r['amount']),
            }
            for r in rows
        ]

    @classmethod
    def _by_company(cls, start, end, company_id, warehouse_id, vendor_id, product_id):
        rows = (
            cls._po_line_qs(start, end, company_id, warehouse_id, vendor_id, product_id)
            .annotate(line_value=_PO_LINE_VALUE)
            .values('po__company_id', 'po__company__legal_name')
            .annotate(amount=Sum('line_value'), po_count=Count('po', distinct=True))
            .order_by('-amount')
        )
        return [
            {
                'company_id': str(r['po__company_id']) if r['po__company_id'] else None,
                'company_name': r['po__company__legal_name'] or '(unnamed)',
                'po_count': r['po_count'],
                'amount': _money(r['amount']),
            }
            for r in rows
        ]

    @classmethod
    def _po_fulfillment(cls, start, end, company_id, warehouse_id, vendor_id, product_id, limit=100,
                         include_transfers=False):
        """Per-PO quantity fulfilment for the window: ordered vs received vs
        pending. Ordered comes from POLine, received from ReceiptLine (linked
        via po_line) — two aggregate queries merged in Python, no join fan-out.
        Newest PO first, capped at `limit`."""
        header = (
            cls._po_header_qs(start, end, company_id, warehouse_id, vendor_id, product_id)
            .select_related('vendor', 'company')
            .order_by('company__legal_name', '-po_date', '-po_no')
        )
        pos = list(header[:limit])
        po_ids = [p.id for p in pos]
        if not po_ids:
            return []
        ordered = {
            r['po_id']: r
            for r in cls._po_line_qs(start, end, company_id, warehouse_id, vendor_id, product_id)
            .filter(po_id__in=po_ids).values('po_id')
            .annotate(o=Sum('quantity_ordered'), ov=Sum(_PO_LINE_GROSS))
        }
        # Receipt lines carry no PO link (po_line is always null in this data),
        # so "fulfilled" is measured by the vendor BILLS raised against each PO
        # (VendorBill.purchase_order is populated). Billed value = GST-inclusive
        # total, comparable to the gross ordered value above.
        billed_qs = VendorBill.objects.filter(purchase_order_id__in=po_ids, is_active=True).exclude(status='CANCELLED')
        if not include_transfers:
            # Branch transfers (DC/-prefixed challans OR a branch-entity vendor)
            # raised against a PO aren't purchases (see _bill_qs) — keep this column
            # consistent with the page's default "Purchases" (no transfers) view.
            billed_qs = billed_qs.exclude(branch_transfer_q())
        billed = {
            r['purchase_order_id']: (r['b'] or _ZERO)
            for r in billed_qs.values('purchase_order_id').annotate(b=Sum('total_amount'))
        }
        out = []
        for po in pos:
            oa = ordered.get(po.id) or {}
            ov = oa.get('ov') or _ZERO           # ordered VALUE incl GST (₹)
            bv = billed.get(po.id) or _ZERO      # billed VALUE incl GST (₹)
            pend_v = ov - bv
            if pend_v < _ZERO:
                pend_v = _ZERO
            out.append({
                'po_id': str(po.id),
                'po_no': po.po_no or '',
                'company_name': (getattr(po.company, 'legal_name', '') or '') if po.company_id else '',
                'vendor_name': (getattr(po.vendor, 'vendor_name', '') or '') if po.vendor_id else '',
                'status': getattr(po, 'status', '') or '',
                'ordered_value': _money(ov),
                'billed_value': _money(bv),
                'pending_value': _money(pend_v),
            })
        return out

    # ── quantity received (Goods Receipt / GRN) ─────────────────────────────
    @staticmethod
    def _receipt_line_qs(start, end, company_id, warehouse_id, vendor_id, product_id):
        qs = ReceiptLine.objects.filter(
            receipt__receipt_date__date__gte=start,
            receipt__receipt_date__date__lte=end,
            receipt__is_active=True, is_active=True,
        )
        if company_id:
            qs = qs.filter(receipt__warehouse__company_id=company_id)
        if warehouse_id:
            qs = qs.filter(receipt__warehouse_id=warehouse_id)
        if vendor_id:
            qs = qs.filter(receipt__vendor_id=vendor_id)
        if product_id:
            qs = qs.filter(product_id__in=product_id)
        return qs

    @staticmethod
    def _receipt_header_qs(start, end, company_id, warehouse_id, vendor_id, product_id):
        qs = ReceiptAdvice.objects.filter(
            receipt_date__date__gte=start, receipt_date__date__lte=end, is_active=True,
        )
        if company_id:
            qs = qs.filter(warehouse__company_id=company_id)
        if warehouse_id:
            qs = qs.filter(warehouse_id=warehouse_id)
        if vendor_id:
            qs = qs.filter(vendor_id=vendor_id)
        if product_id:
            qs = qs.filter(receipt_lines__product_id__in=product_id).distinct()
        return qs

    @classmethod
    def _receipt_stats(cls, start, end, company_id, warehouse_id, vendor_id, product_id):
        header = cls._receipt_header_qs(start, end, company_id, warehouse_id, vendor_id, product_id)
        line_qs = cls._receipt_line_qs(start, end, company_id, warehouse_id, vendor_id, product_id)
        total_qty = line_qs.aggregate(t=Sum('quantity_received'))['t'] or _ZERO
        uom_rows = (
            line_qs.values('uom')
            .annotate(qty=Sum('quantity_received'))
            .order_by('-qty')
        )
        uom_breakdown = [
            {'uom': (r['uom'] or 'N/A'), 'qty': _qty(r['qty'])}
            for r in uom_rows if (r['qty'] or _ZERO) != _ZERO
        ]
        return {
            'total_qty': _qty(total_qty),
            'receipt_count': header.count(),
            'uom_breakdown': uom_breakdown,
        }

    # ── vendor bills ────────────────────────────────────────────────────────
    @staticmethod
    def _bill_qs(company_id, vendor_id, product_id=None, include_transfers=False, source=None, msme=None,
                 transfers_only=False):
        """VendorBill's company comes from its PO or receipt, OR — for bills with
        neither (Zoho-imported, farmer/Tally-only) — from the vendor's company,
        since vendors are company-scoped. This keeps those bills in the totals
        when a company filter is applied.

        product_id restricts to bills that CONTAIN that product on a line. It's
        applied as an id__in subquery (not a bill_lines join) so a bill with the
        product on two lines is not counted twice in Sum(total_amount).

        include_transfers=False (default) EXCLUDES branch-transfer delivery
        challans — bills whose invoice no starts "DC/". Those are internal
        stock movements between the company's own branches ("NOT FOR SALE"),
        NOT purchases, so Tally's Purchase Register excludes them and so do we.
        Pass include_transfers=True to count them (the "Include transfers" view).

        transfers_only=True flips it the other way: keep ONLY the branch
        transfers (the "Transfers" pill). It wins over include_transfers."""
        qs = VendorBill.objects.filter(is_active=True, is_expense=False)
        if transfers_only:
            qs = qs.filter(branch_transfer_q())
        elif not include_transfers:
            qs = qs.exclude(branch_transfer_q())
        if vendor_id:
            qs = qs.filter(vendor_id=vendor_id)
        if company_id:
            qs = qs.filter(
                Q(purchase_order__company_id=company_id)
                | Q(receipt_advice__warehouse__company_id=company_id)
                | Q(vendor__company_id=company_id)
            )
        if product_id:
            from .models import VendorBillLine
            qs = qs.filter(id__in=VendorBillLine.objects.filter(
                product_id__in=product_id).values('bill_id'))
        if source and source.lower() in ('tally', 'scan', 'erp', 'sync', 'both', 'not_in_tally'):
            from .source_classify import annotate_source, filter_by_source
            qs = filter_by_source(annotate_source(qs), source.lower())
        if msme is True:
            qs = qs.filter(vendor__is_msme=True)
        elif msme is False:
            qs = qs.filter(vendor__is_msme=False)
        return qs

    @classmethod
    def _bill_stats(cls, start, end, company_id, vendor_id, product_id=None, include_transfers=False, source=None, msme=None,
                    transfers_only=False, _dup_cache=None):
        # CANCELLED bills keep is_active=True (status-only cancel, mirroring
        # sales invoices) and opening-balance carriers are ledger-only — both
        # must not count as bills booked this period. Reconcile views keep
        # using the raw _bill_qs (a cancelled bill still counts as imported).
        # Expense-like bills excluded so the Bills count/total describes the same
        # "Purchases = RM+Packing" set as the Total Purchase card and the Bills
        # page's Purchases view = Tally's Purchase Register. That's not just the
        # is_expense FLAG: a bill tagged FREIGHT/EXPENSES/MACHINERY or booked as a
        # journal is an expense even when the flag wasn't set (e.g. two EXPENSES
        # bills that used to leak in and made the tile read 168 vs the list's 166).
        base = cls._bill_qs(company_id, vendor_id, product_id, include_transfers, source=source, msme=msme,
                            transfers_only=transfers_only).filter(
            bill_date__gte=start, bill_date__lte=end,
        ).exclude(status='CANCELLED').exclude(tally_guid__startswith='OPENING')
        # Same duplicate-invoice dedup the Total Purchase tile applies, so the Bills
        # count/amount ties it (a '-N' collision re-import must not count twice).
        _d = _cached_dup_bill_ids(base, _dup_cache)
        if _d:
            base = base.exclude(id__in=_d)
        # Expense-like = flagged is_expense OR a Freight/Expenses/Machinery
        # category OR a journal voucher — not a real RM+Packing purchase. Same rule
        # as the Bills page's isExpenseLike, so the tile's Purchase/Expenses toggle
        # ties the list. Return BOTH sets so the tile can switch between them
        # (Purchase is the default; Expenses is the complement).
        expense_like = (Q(is_expense=True) | Q(purchase_category__in=_EXPENSE_CATS)
                        | Q(tally_voucher_type__icontains='journal'))
        pur = base.exclude(expense_like).aggregate(t=Sum('total_amount'), n=Count('id'))
        exp = base.filter(expense_like).aggregate(t=Sum('total_amount'), n=Count('id'))
        return {'count': pur['n'] or 0, 'amount': _money(pur['t'] or _ZERO),
                'expense_count': exp['n'] or 0, 'expense_amount': _money(exp['t'] or _ZERO)}

    @classmethod
    def _billed_qty_stats(cls, start, end, company_id, vendor_id, product_id=None, include_transfers=False, source=None,
                          transfers_only=False, _dup_cache=None):
        """Quantity BILLED in the period, per UOM, from VendorBillLine.

        Deliberately sourced from the same bills that feed `total_purchase` and
        `bills`, so the quantity and the money on the dashboard always describe
        the same documents. Units are never summed together — mixing litres
        with kilos is meaningless — so the caller renders one figure per UOM.

        Lines with a BLANK uom are skipped: the Tally importer synthesises a
        qty=1 / uom='' line for vouchers that carry no stock items (service and
        expense purchases), which would otherwise pile up as a large, wholly
        fictitious "no unit" bucket.
        """
        # is_expense excluded to stay consistent with total_purchase / bills — the
        # quantity describes the same purchase documents as the Bills tile, so
        # apply the identical expense-like exclusion (flag + category + journal).
        bqs = cls._bill_qs(company_id, vendor_id, product_id, include_transfers, source=source,
                           transfers_only=transfers_only).filter(
            bill_date__gte=start, bill_date__lte=end,
        ).exclude(status='CANCELLED').exclude(tally_guid__startswith='OPENING').exclude(
            is_expense=True).exclude(purchase_category__in=_EXPENSE_CATS).exclude(
            tally_voucher_type__icontains='journal')
        # Dedup duplicate-imported invoices (as Total Purchase does) so the quantity
        # describes the same documents and isn't inflated by a '-N' re-import.
        _d = _cached_dup_bill_ids(bqs, _dup_cache)
        if _d:
            bqs = bqs.exclude(id__in=_d)
        line_qs = VendorBillLine.objects.filter(
            bill__in=bqs, is_active=True,
        ).exclude(uom='')
        if product_id:
            line_qs = line_qs.filter(product_id__in=product_id)
        uom_rows = line_qs.values('uom').annotate(qty=Sum('quantity')).order_by()
        uom_breakdown = _merge_uom((r['uom'], r['qty']) for r in uom_rows)
        return {
            'uom_breakdown': uom_breakdown,
            # Bills that actually carry a quantified line — the headline count
            # already lives on the Bills card, and repeating it here would
            # overstate what this figure is measured from.
            'bill_count': line_qs.values('bill_id').distinct().count(),
        }

    @classmethod
    def _total_purchase(cls, start, end, company_id, vendor_id, product_id=None, include_transfers=False, source=None, msme=None,
                        transfers_only=False, _dup_cache=None):
        """Total purchases for the period, in Tally's own terms.

        `gross`   the **Purchase Register** grand total — every purchase
                  voucher at its party-line value, incl GST.
        `taxable` **Trial Balance > Purchase Accounts** — what Tally itself
                  files under that group, and nothing else.
        `charges` the rest of the bill's cost, which Tally groups elsewhere:
                  freight and insurance (Direct Expenses) and inter-branch
                  stock (its own primary group). Real spend, but not in
                  Purchase Accounts — so it must not be in Ex-GST either, or
                  the two Tally screens stop agreeing with the two tiles here.

        The importer decides that split from Tally's group HIERARCHY rather
        than from ledger names, and stores the second part in `other_charges`;
        this only nets it back off. Opening carriers excluded, returns (debit
        notes) reported separately. Scoped to one company."""
        from sales.models import DebitNote
        bqs = (cls._bill_qs(company_id, vendor_id, product_id, include_transfers, source=source, msme=msme,
                            transfers_only=transfers_only)
               .filter(bill_date__gte=start, bill_date__lte=end)
               .exclude(tally_guid__startswith='OPENING')
               .exclude(status='CANCELLED')
               # Expense-like bills excluded — same rule as _bill_stats so Total
               # Purchase and Bills always describe the same set of documents.
               .exclude(is_expense=True)
               .exclude(purchase_category__in=_EXPENSE_CATS)
               .exclude(tally_voucher_type__icontains='journal'))
        # Drop duplicate bills (same invoice imported twice under a collision "-N"
        # bill number) so the scope totals aren't double-counted — same read-time
        # dedup the By-Category page uses. Self-correcting once the data is cleaned.
        _dups = _cached_dup_bill_ids(bqs, _dup_cache)
        if _dups:
            bqs = bqs.exclude(id__in=_dups)
        agg = bqs.aggregate(sub=Sum('subtotal'), oc=Sum('other_charges'),
                            tax=Sum('tax_amount'), tot=Sum('total_amount'))
        # Ex-GST = the FULL taxable value (goods + the freight/testing/packing a
        # supplier charges ON the purchase invoice). Tally books those on-bill
        # charges INTO Purchase Accounts — verified against SS Biochem April: the
        # real Trial Balance > Purchase Accounts screen (Rs 12,57,86,851.30)
        # INCLUDES them, so netting them out left the Ex-GST tile Rs 97,108 BELOW
        # Tally. `charges` is still reported separately below as an informational
        # sub-total (how much of Ex-GST is non-goods charges); it is NOT netted
        # out. The standalone / RCM freight Tally really keeps outside Purchase
        # Accounts lives on its own Freight Inward page, not in other_charges, so
        # nothing is double-counted. The stored subtotal is untouched.
        charges = agg['oc'] or _ZERO       # freight/testing/packing ON bills (a subset of taxable)
        taxable = agg['sub'] or _ZERO                            # Purchase A/c (ex-GST), charges included
        gross = agg['tot'] or _ZERO        # incl GST (reference)
        gst = agg['tax'] or _ZERO          # combined input GST (no CGST/SGST/IGST split on bills)
        # TDS: the on-bill tds_amount field is only sparsely filled — Tally books
        # 194Q as its own ledger leg, not on the bill (SS Biochem April had Rs 2,394
        # on bills vs Rs 86,811 actually deducted). The authoritative 194Q lives in
        # TdsPayable (imported from Tally's TDS-Payable group), so read it there:
        # the deductions (credits) booked on PURCHASE vouchers in the period. That
        # equals Tally's "TDS on purchases" to the rupee and excludes opening /
        # at-payment legs. Reporting-only — vendor bills are never touched.
        from purchase.models import TdsPayable
        _tds_q = TdsPayable.objects.filter(
            section='194Q', amount__gt=0, voucher_type__icontains='purchase',
            voucher_date__gte=start, voucher_date__lte=end)
        if company_id:
            _tds_q = _tds_q.filter(company_id=company_id)
        if vendor_id:
            _tds_q = _tds_q.filter(vendor_id=vendor_id)
        tds = _tds_q.aggregate(t=Sum('amount'))['t'] or _ZERO
        # Purchase-side debit notes = purchase returns (reduce purchases).
        dn = DebitNote.objects.filter(is_active=True, side='PURCHASE', note_type='DEBIT',
                                      note_date__gte=start, note_date__lte=end)
        if company_id:
            dn = dn.filter(company_id=company_id)
        if vendor_id:
            dn = dn.filter(vendor_id=vendor_id)
        # Only a note booked on a PURCHASE ledger is a goods RETURN. One booked to
        # Indirect Incomes / Rate-Difference / an expense ledger is a price ADJUSTMENT,
        # not goods going back, so it must NOT reduce purchases (mirrors the by-category
        # page). Blank tally_group = hand-entered / pre-field -> kept, old behaviour.
        dn = dn.exclude(Q(tally_group__regex=r'\S') & ~Q(tally_group__icontains='purchase'))
        if product_id:
            # A purchase note has no product line, so none of its value can be
            # attributed to one product. Showing the whole figure next to a
            # product-scoped Total Purchase invited exactly the wrong
            # subtraction; it is reported as nil under a product filter and
            # belongs in the unfiltered view.
            dn = dn.none()
        returns = dn.aggregate(t=Sum('amount'))['t'] or _ZERO
        # Purchase-side CREDIT notes — vendor credits (raise payable). Its own tile
        # so returns and adjustments are visible; PURCHASE-side only, so a sales
        # debit/credit note never lands on the purchase dashboard.
        cn = DebitNote.objects.filter(is_active=True, side='PURCHASE', note_type='CREDIT',
                                      note_date__gte=start, note_date__lte=end)
        if company_id:
            cn = cn.filter(company_id=company_id)
        if vendor_id:
            cn = cn.filter(vendor_id=vendor_id)
        if product_id:
            cn = cn.none()   # same reason as the debit notes above
        credit_notes = cn.aggregate(t=Sum('amount'))['t'] or _ZERO
        # NATIVE net purchase (NO Tally import) = Ex-GST − returns(ex-GST). This is
        # as close as the ERP's OWN data gets to Tally's Purchase Accounts group.
        # Verified from prod (SSB Apr): lands Rs 12,41,81,524.65 vs the group's
        # Rs 12,43,17,395.65 — within ~Rs 1.36L (99.9%). The residual is NOT in the
        # bill data: ~Rs 1.24L of purchases were booked via JOURNAL in Tally (ledger
        # entries, never entered as bills) + a ~Rs 11k returns-classification diff.
        # Do NOT subtract other_charges — those on-bill charges (Rs 97,108) are
        # INSIDE Purchase Accounts (the group includes them). Returns use
        # DebitNote.taxable (ex-GST, which IS stored) to match the group's ex-GST
        # credit. For the exact rupee use the imported 'tally_taxable' (Tally A/c).
        _ret_exgst = dn.aggregate(t=Sum('taxable'))['t']
        if _ret_exgst is None:            # ex-GST split not stored -> fall back
            _ret_exgst = returns
        net_purchase = taxable - _ret_exgst
        # Tally's own Purchase Accounts GROUP total for this exact period, if it was
        # imported (import_purchase_accounts from a Trial Balance). The bill-derived
        # `taxable` above can never equal it — Tally files charges/journals in other
        # groups — so this lets the Ex-GST tile also show Tally's figure to the rupee
        # (the group screen the boss reads). None when not imported for the period.
        from purchase.models import PurchaseAccountsTotal
        _pa = None
        if company_id:
            _pa = (PurchaseAccountsTotal.objects
                   .filter(company_id=company_id, from_date=start, to_date=end, is_active=True)
                   .first())
        # Verified against Tally to the rupee: the Purchase Register grand total
        # = GROSS bill value (incl GST), Σ total_amount — NOT taxable, NOT net of
        # returns. So the headline "total" is the gross figure.
        # Split by the Tally voucher type the bill came from, so farmer buying
        # can be read on its own. "Purchase-Bought Note" is raw fruit and seed
        # bought direct from growers — exempt, no GST, no supplier invoice —
        # and it behaves nothing like trade purchasing: for SS Biochem it is
        # 694 of 1,617 vouchers, so leaving it folded into one number hides
        # both halves. Keyed on tally_voucher_type, which the import already
        # stores verbatim, so a voucher type that appears later needs no code.
        by_type = {}
        for row in (bqs.values('tally_voucher_type')
                    .annotate(n=Count('id'), g=Sum('total_amount'),
                              sub=Sum('subtotal'), oc=Sum('other_charges'),
                              tax=Sum('tax_amount'), td=Sum('tds_amount'))
                    .order_by('-g')):
            key = (row['tally_voucher_type'] or '').strip() or 'Other'
            by_type[key] = {
                'count': row['n'],
                'total': _money(row['g'] or _ZERO),
                'gross': _money(row['g'] or _ZERO),
                'taxable': _money(row['sub'] or _ZERO),   # charges included (see _total_purchase)
                'charges': _money(row['oc'] or _ZERO),
                'gst': _money(row['tax'] or _ZERO),
                'tds': _money(row['td'] or _ZERO),
            }
        # ── Scope split for the redesigned Total Purchase tile ──
        # Purchase = RM+Packing (ties Tally Purchase Accounts) · Expenses =
        # Freight+Machinery+Expenses (Tally Direct/Indirect Expenses) · Branch =
        # inter-branch purchases (a branch vendor — its name carries 'branch' or a
        # branch marker like 'Blre'; Tally's separate "Purchase - Branch" group) ·
        # Total = everything. Branch takes precedence over the category. Each scope
        # carries ex-GST (Σsubtotal) / GST (Σtax) / incl-GST (Σtotal).
        _EXP_CATS = ['FREIGHT', 'EXPENSES', 'MACHINERY', 'LAB_EXPENSE']
        _PUR_CATS = ['RM', 'MAIZE', 'BOUGHT_NOTE', 'PACKING', 'FRUIT']
        # Branch = real inter-branch purchases. `bqs` already DROPPED every branch
        # transfer (include_transfers=False → branch_transfer_q excluded upstream),
        # so a `bqs.filter(name~'branch')` could only ever be empty. Source them from
        # a transfers-INCLUDED base and match on the REAL signal branch_transfer_q()
        # (is_branch vendor / DC/ invoice / BRANCH category), with the same
        # OPENING/CANCELLED/is_expense/dedup treatment as the purchase base so the
        # figure is comparable. Shown as its own tile; Total stays purchases-only.
        _branch_base = (cls._bill_qs(company_id, vendor_id, product_id, include_transfers=True)
                        .filter(bill_date__gte=start, bill_date__lte=end)
                        .exclude(tally_guid__startswith='OPENING').exclude(status='CANCELLED')
                        .exclude(is_expense=True))
        _branch_base = _branch_base.exclude(id__in=_cached_dup_bill_ids(_branch_base, _dup_cache))
        _branch_qs = _branch_base.filter(branch_transfer_q())
        _rest_qs = bqs   # already non-branch (branch transfers excluded upstream)
        _exp_qs = _rest_qs.filter(purchase_category__in=_EXP_CATS)
        _pur_qs = _rest_qs.filter(purchase_category__in=_PUR_CATS)   # RM + Maize + Bought Note + Packing
        _uncl_qs = _rest_qs.exclude(purchase_category__in=_PUR_CATS + _EXP_CATS)  # blank/untagged — its own bucket
        # Journal expenses: bills marked is_expense at entry (rent/bank/professional,
        # booked as Journal, so bqs excludes them). Per the design choice, these ALSO
        # belong under the "Expenses" toggle and inside "Total" — so Expenses = the
        # expense-category purchase bills PLUS these journals, matching Tally's
        # Direct+Indirect Expenses. Branch vendors excluded so scopes never overlap.
        _exp_jrnl_qs = (cls._bill_qs(company_id, vendor_id, product_id, include_transfers, source=source)
                        .filter(bill_date__gte=start, bill_date__lte=end, is_expense=True)
                        .exclude(status='CANCELLED')
                        .exclude(tally_guid__startswith='OPENING'))
        _exp_jrnl_qs = _exp_jrnl_qs.exclude(branch_transfer_q())  # keep branch out of journals
        _exp_jrnl_qs = _exp_jrnl_qs.exclude(id__in=_cached_dup_bill_ids(_exp_jrnl_qs, _dup_cache))

        def _scope(qs):
            # `n` rides along with the sums - see the note above; this one runs
            # once per scope, so it was the costliest of the three.
            a = qs.aggregate(ex=Sum('subtotal'), g=Sum('tax_amount'),
                             inc=Sum('total_amount'), n=Count('id'))
            return {'exgst': _money(a['ex'] or _ZERO),
                    'gst': _money(a['g'] or _ZERO),
                    'inclgst': _money(a['inc'] or _ZERO),
                    'count': a['n'] or 0}

        def _add(a, b):
            return {k: a[k] + b[k] for k in ('exgst', 'gst', 'inclgst', 'count')}

        _jrnl = _scope(_exp_jrnl_qs)
        scopes = {
            'purchase': _scope(_pur_qs),
            'expenses': _add(_scope(_exp_qs), _jrnl),   # expense-category bills + journals
            'branch': _scope(_branch_qs),
            'unclassified': _scope(_uncl_qs),           # bills not yet tagged — kept out of Purchase
            'total': _add(_scope(bqs), _jrnl),          # P + E(incl journals) + Unclassified — EXCLUDES branch (not a purchase; shown on its own tile)
        }
        # Purchase (ex-GST) is netted of purchase returns so it ties Tally's Purchase
        # Accounts group (itself net of its Debit Notes). The TOTAL is left GROSS on
        # purpose: it must equal the Bills list's whole-filter total — the sum of every
        # bill BEFORE returns — so returns are shown apart (the Debit Notes tile) rather
        # than hidden inside Total. Total already excludes branch transfers (bqs is
        # non-branch), per the chosen "exclude branch transfers" definition.
        _ret_ex = _money(_ret_exgst)
        _ret_inc = _money(returns)
        _ret_g = round(_ret_inc - _ret_ex, 2)
        scopes['purchase']['exgst'] = round(scopes['purchase']['exgst'] - _ret_ex, 2)
        scopes['purchase']['gst'] = round(scopes['purchase']['gst'] - _ret_g, 2)
        scopes['purchase']['inclgst'] = round(scopes['purchase']['inclgst'] - _ret_inc, 2)
        # Purchase (ex-GST, net of returns) ties Tally's Purchase Accounts group.
        scopes['purchase']['tally'] = _money(_pa.amount) if _pa else None

        # ── Per-category split of each scope — the "one tile per category" breakup on
        # the by-scope card. Built from the SAME querysets as the scopes (_pur_qs /
        # _exp_qs + journal) so the tiles sum to their scope total. The period's
        # purchase returns (RM / packing goods) are netted off RM, the dominant goods
        # category, so the four goods tiles tie the NET Purchase figure to the rupee.
        _CAT_LABEL = {'RM': 'RM', 'MAIZE': 'Maize', 'BOUGHT_NOTE': 'Bought Note',
                      'PACKING': 'Packing', 'FREIGHT': 'Freight',
                      'MACHINERY': 'Machinery', 'EXPENSES': 'Expenses'}

        def _cat_split(qs, order):
            agg = {r['purchase_category']: r for r in
                   qs.values('purchase_category')
                   .annotate(ex=Sum('subtotal'), inc=Sum('total_amount'), n=Count('id'))}
            rows = []
            for key in order:
                r = agg.get(key)
                if not r or not (r['ex'] or r['inc']):
                    continue
                rows.append({'key': key, 'label': _CAT_LABEL.get(key, key),
                             'exgst': _money(r['ex']), 'inclgst': _money(r['inc']),
                             'count': r['n'] or 0})
            return rows

        # Goods tiles are GROSS — the value that is ON the bills (so RM etc. match the
        # by-category page, which shows what you were billed). Purchase returns are
        # shown as their OWN negative tile rather than hidden inside RM, so the tiles
        # still sum to the NET Purchase scope above (which stays net to tie Tally).
        pur_split = _cat_split(_pur_qs, _PUR_CATS)
        _ret_ex_f, _ret_inc_f = _money(_ret_exgst), _money(returns)
        if _ret_ex_f or _ret_inc_f:
            pur_split.append({'key': 'RETURNS', 'label': 'Less: purchase returns',
                              'exgst': round(-_ret_ex_f, 2), 'inclgst': round(-_ret_inc_f, 2),
                              'count': 0})
        exp_split = _cat_split(_exp_qs, _EXP_CATS)

        def _into_expenses(amt_ex, amt_inc, cnt):
            """Fold a value into the EXPENSES tile (create it if missing)."""
            _ex = next((r for r in exp_split if r['key'] == 'EXPENSES'), None)
            if _ex is None:
                _ex = {'key': 'EXPENSES', 'label': 'Expenses',
                       'exgst': 0.0, 'inclgst': 0.0, 'count': 0}
                exp_split.append(_ex)
            _ex['exgst'] = round(_ex['exgst'] + amt_ex, 2)
            _ex['inclgst'] = round(_ex['inclgst'] + amt_inc, 2)
            _ex['count'] += cnt

        if _jrnl['exgst'] or _jrnl['inclgst']:    # journal expenses ride under EXPENSES
            _into_expenses(_jrnl['exgst'], _jrnl['inclgst'], _jrnl['count'])
        # Machinery is grouped UNDER Expenses (one number, like the by-category page) —
        # fold its tile into Expenses instead of showing it as a separate line.
        _mach = next((r for r in exp_split if r['key'] == 'MACHINERY'), None)
        if _mach:
            exp_split = [r for r in exp_split if r['key'] != 'MACHINERY']
            _into_expenses(_mach['exgst'], _mach['inclgst'], _mach['count'])

        return {
            'total': _money(gross),
            'gross': _money(gross),
            'taxable': _money(taxable),
            'charges': _money(charges),
            'gst': _money(gst),
            'tds': _money(tds),
            'returns': _money(returns),
            'credit_notes': _money(credit_notes),
            # NATIVE (no Tally): rebuilds Tally's Purchase Accounts group from ERP
            # data alone — goods (freight removed) − returns ex-GST + journal
            # purchases. Aims to equal the imported 'Tally A/c' figure without any
            # Tally import. See the computation above.
            'net_purchase': _money(net_purchase),
            'tally_taxable': _money(_pa.amount) if _pa else None,
            'tally_taxable_breakdown': (_pa.breakdown or []) if _pa else [],
            # Tally's OWN figures for the period, when imported — so the tiles show
            # Tally's number to the rupee instead of the Zoho/scan bill-derived one.
            # Ex-GST(Tally) = gross − gst (Purchase Register value before GST).
            'tally_gst': _money(_pa.gst) if (_pa and _pa.gst is not None) else None,
            'tally_gross': _money(_pa.gross) if (_pa and _pa.gross is not None) else None,
            'tally_tds': _money(_pa.tds) if (_pa and _pa.tds is not None) else None,
            'tally_exgst': (_money(_pa.gross - (_pa.gst or _ZERO))
                            if (_pa and _pa.gross is not None) else None),
            'bill_count': bqs.count(),
            'return_count': dn.count(),
            'credit_note_count': cn.count(),
            'by_voucher_type': by_type,
            # Redesigned tile: Purchase / Expenses / Branch / Total, each ex/gst/incl.
            'scopes': scopes,
            # Per-category tiles under Purchase / Expenses (sum to their scope).
            'scope_breakdown': {'purchase': pur_split, 'expenses': exp_split},
        }

    @classmethod
    def _outstanding_payables(cls, company_id, vendor_id, product_id=None, start=None, end=None, include_transfers=False, source=None, msme=None,
                              transfers_only=False, _dup_cache=None):
        """Unpaid vendor balance + unpaid bill count. When start/end are given it's
        the still-unpaid balance of bills DATED in that window (so it moves with the
        period filter); with no window it's the LIVE all-time outstanding."""
        qs = (cls._bill_qs(company_id, vendor_id, product_id, include_transfers, source=source, msme=msme,
                           transfers_only=transfers_only)
              .exclude(status__in=BILL_SETTLED_STATUSES)
              .exclude(vendor_invoice_no='OPENING')
              .exclude(vendor_invoice_no__startswith='OPEN-')
              .exclude(tally_guid__startswith='OPENING'))
        if start:
            qs = qs.filter(bill_date__gte=start)
        if end:
            qs = qs.filter(bill_date__lte=end)
        # Count the SAME kind of bills as the Bills tile — real purchases only:
        # drop expense-like bills (flag OR Freight/Expenses/Machinery/Lab OR
        # journal) and duplicate '-N' re-imports. Without this, Outstanding
        # counted expenses + dupes the Bills tile never did, so "unpaid" could
        # exceed "total bills". (Outstanding stays ALL-TIME — no date floor — so
        # older-year unpaid purchases still count, which is correct.)
        qs = qs.exclude(_OUTSTANDING_EXPENSE_LIKE)
        _d = _cached_dup_bill_ids(qs, _dup_cache)
        if _d:
            qs = qs.exclude(id__in=_d)
        agg = qs.aggregate(total=Sum(_BILL_BALANCE), count=Count('id'))
        out = {'total': _money(agg['total']), 'count': agg['count'] or 0}
        # Real payment total from PaymentMade records (top-level only, not per-vendor/product drills)
        if not vendor_id and not product_id:
            from purchase.models import PaymentMade
            # Branch/internal-ledger vendors (OD-interest, bank/cash/loan contra
            # wrongly imported as vendors) are excluded here so this header total
            # matches the Amount-Paid-by-account split in _payment_stats, which
            # excludes them too — otherwise the buckets never summed to the
            # headline (the "Untagged + Creditor > total" the card showed).
            _pay_qs = (PaymentMade.objects
                       .filter(is_active=True)
                       .exclude(status='CANCELLED').exclude(is_transfer=True)
                       .exclude(vendor__is_branch=True)
                       # Purchase dashboard = RM+Packing purchases only. Freight
                       # and expense payments belong to their own analytics, so
                       # drop them here like the other tiles drop expense bills.
                       # Company-aware so on-account freight/expense (by creditor
                       # group) is dropped too.
                       .exclude(_payment_expense_like_q(company_id)))
            if company_id:
                _pay_qs = _pay_qs.filter(vendor__company_id=company_id)
            if source == 'tally':
                _pay_qs = _pay_qs.exclude(reference_no='')
            if start:
                _pay_qs = _pay_qs.filter(payment_date__gte=start)
            if end and source != 'scan':
                _pay_qs = _pay_qs.filter(payment_date__lte=end)
            _paid = _pay_qs.aggregate(t=Sum('amount'))['t'] or _ZERO
            out['amount_paid'] = _money(_paid)
            out['paid_count'] = _pay_qs.count()
        return out

    @classmethod
    def _vendor_breakdown(cls, company_id, vendor_id, product_id=None, start=None, end=None, include_transfers=False, msme=None, include_expense=False):
        """Per-vendor TALLY-STYLE running balance — identical to each vendor's
        ledger drill (and Tally): Billed GROSS, ALL payments (incl on-account
        advances) + purchase debit notes counted as paid, and the resulting balance
        (positive = Cr, we owe; negative = Dr, advance/overpaid). TDS is NOT
        subtracted because Tally credits vendors GROSS and debits TDS separately.

        It USED to be bill-based (paid = Σ amount_paid on bills, outstanding =
        Σ total − amount_paid), which ignored on-account advances entirely — so a
        vendor paid ahead (Sperrholz: ₹17.13 cr paid vs ₹8.46 cr billed) read
        '100% paid / ₹0 outstanding' here while its ledger correctly showed
        ₹8.67 cr Dr. Now the table and the ledger agree.

        `end` is the AS-OF date (statement is cumulative to that date, matching the
        ledger's closing); `start` is ignored for the balance."""
        from sales.models import DebitNote
        from .models import PaymentMade
        today = timezone.localdate()
        asof = end  # closing as-of the period end; None = all-time

        # ── bills up to as-of: gross billed, count, overdue (keyed by vendor) ──
        bqs = (cls._bill_qs(company_id, vendor_id, product_id, include_transfers)
               .exclude(vendor_invoice_no='OPENING')
               .exclude(tally_guid__startswith='OPENING')
               .exclude(status='CANCELLED')
               .exclude(purchase_category__in=_EXPENSE_CATS)
               .exclude(tally_voucher_type__icontains='journal'))
        if asof:
            bqs = bqs.filter(bill_date__lte=asof)
        bills = {r['vendor_id']: r for r in bqs.values('vendor_id', 'vendor__vendor_name').annotate(
            billed=Sum('total_amount'),
            bill_count=Count('id', distinct=True),
            overdue=Coalesce(Sum(_BILL_BALANCE,
                filter=Q(due_date__lt=today) & ~Q(status__in=BILL_SETTLED_STATUSES)), _ZERO),
            # Oldest still-unpaid overdue due date → drives the days-overdue
            # column (today − this = how long the longest-overdue bill has run).
            oldest_overdue=Min('due_date',
                filter=Q(due_date__lt=today) & ~Q(status__in=BILL_SETTLED_STATUSES)),
        )}

        # ── ALL payments per vendor (bill-applied AND on-account advances) ─────
        # Transfers (bank/cash contra) are internal, not creditor payments.
        pqs = (PaymentMade.objects.filter(is_active=True)
               .exclude(status='CANCELLED').exclude(is_transfer=True))
        if company_id:
            pqs = pqs.filter(vendor__company_id=company_id)
        if vendor_id:
            pqs = pqs.filter(vendor_id=vendor_id)
        if product_id:
            # The BILLED column is product-scoped, so this has to be too.
            # Without it a vendor showed one product's billing against its
            # entire payment history: Sperrholz read billed Rs -4,48,699 and
            # paid Rs 58,78,85,634 — "-131020% paid" — and the Outstanding
            # beside it was a number belonging to neither.
            from .models import VendorBillLine as _VBL
            pqs = pqs.filter(bill_id__in=_VBL.objects.filter(
                product_id__in=product_id).values('bill_id'))
        if asof:
            pqs = pqs.filter(payment_date__lte=asof)
        pays = {r['vendor_id']: (r['t'] or _ZERO)
                for r in pqs.values('vendor_id').annotate(t=Sum('amount'))}

        # ── advances per vendor (VendorCredit, type ADVANCE) ──────────────────
        # Surfaced as a green "adv ₹X" chip on the vendor row — ALL advances
        # recorded for the vendor (any balance), so an advance paid shows at a
        # glance even when the net ledger isn't in debit. Reporting-only; it does
        # not change the billed/paid/outstanding arithmetic above.
        from .models import VendorCredit
        aqs = VendorCredit.objects.filter(is_active=True, credit_type='ADVANCE').exclude(status='CANCELLED')
        if company_id:
            aqs = aqs.filter(vendor__company_id=company_id)
        if vendor_id:
            aqs = aqs.filter(vendor_id=vendor_id)
        if asof:
            aqs = aqs.filter(credit_date__lte=asof)
        adv_by_vid = {r['vendor_id']: (r['t'] or _ZERO)
                      for r in aqs.values('vendor_id').annotate(t=Sum('total_amount'))}

        # ── purchase debit (reduce payable) / credit (raise payable) notes ────
        nqs = DebitNote.objects.filter(side='PURCHASE', is_active=True, vendor__isnull=False)
        if company_id:
            nqs = nqs.filter(company_id=company_id)
        if vendor_id:
            nqs = nqs.filter(vendor_id=vendor_id)
        if product_id:
            # A purchase note carries no product line, so none of it can be
            # attributed to one product. Counting it whole against a
            # product-scoped billing would overstate the vendor's position by
            # the entire note. Left out rather than guessed at — the
            # unfiltered view is where notes belong.
            nqs = nqs.none()
        if asof:
            nqs = nqs.filter(note_date__lte=asof)
        dn_dr, dn_cr = {}, {}
        for r in nqs.values('vendor_id', 'note_type').annotate(t=Sum('amount')):
            (dn_dr if r['note_type'] == 'DEBIT' else dn_cr)[r['vendor_id']] = r['t'] or _ZERO

        # ── Tally FY-start openings (VendorOpeningBalance) ────────────────────
        # The ERP holds no per-vendor opening of its own, so a supplier whose
        # balance predates the ERP's first bill reads short. Add each vendor's
        # opening on top of its ERP movement so the row rolls forward to Tally's
        # closing. Parties with no ERP master yet are shown as their own rows.
        from .models import VendorOpeningBalance
        op_by_vid, op_names = {}, []
        oq = VendorOpeningBalance.objects.filter(is_active=True, as_of_date__lte=(asof or today))
        if product_id:
            # Same reason as the notes: an opening balance is a party-level
            # figure with no product in it.
            oq = oq.none()
        if company_id:
            oq = oq.filter(company_id=company_id)
        if vendor_id:
            oq = oq.filter(vendor_id=vendor_id)
        for op in oq.order_by('as_of_date'):   # latest as-of wins per vendor
            if op.vendor_id:
                op_by_vid[op.vendor_id] = (op.amount, op.vendor_name)
            elif not vendor_id:
                op_names.append((op.vendor_name, op.amount))

        # Which company each vendor belongs to. Vendors are company-scoped,
        # so this is one value per vid — the Vendor-details table shows it as a
        # group header when BOTH companies are in view (no company filter), so
        # two same-named rows (e.g. "Amutha Roadways" in each company) can be
        # told apart.
        from master.models import Vendor
        _vids = [v for v in (set(bills) | set(op_by_vid)) if v]
        _vrows = list(Vendor.objects.filter(id__in=_vids)
                      .values('id', 'company__legal_name', 'is_msme', 'vendor_type')) if _vids else []
        co_by_vid = {r['id']: (r['company__legal_name'] or '') for r in _vrows}
        # is_msme per vendor — lets the dashboard's MSME toggle filter this table
        # too, so "MSME only" doesn't leave every vendor on screen.
        msme_by_vid = {r['id']: bool(r['is_msme']) for r in _vrows}
        _EXPENSE_VT = {'EXPENSE', 'FREIGHT', 'CONTRACTOR', 'EMPLOYEE'}
        exp_name = {}
        if include_expense:
            # Ledger path: discover expense vendors from the MASTER, not just the
            # ones already in `bills`/openings. An expense vendor whose bills are
            # ALL expense-category is excluded from `bills` above, so it would
            # never be found via _vrows — leaving most expense creditors invisible.
            # Grab name/company/msme here too, so a payment-only expense vendor
            # (no bill row to read a name from) doesn't fall back to '(unknown)'.
            evq = Vendor.objects.all()
            if company_id:
                evq = evq.filter(company_id=company_id)
            if vendor_id:
                evq = evq.filter(id=vendor_id)
            expense_vids = set()
            for r in evq.values('id', 'vendor_name', 'company__legal_name',
                                'is_msme', 'vendor_type'):
                if not (set(t.upper() for t in (r['vendor_type'] or [])) & _EXPENSE_VT):
                    continue
                vid = r['id']
                expense_vids.add(vid)
                exp_name[vid] = r['vendor_name']
                co_by_vid.setdefault(vid, r['company__legal_name'] or '')
                msme_by_vid.setdefault(vid, bool(r['is_msme']))
        else:
            expense_vids = {r['id'] for r in _vrows
                            if set(t.upper() for t in (r['vendor_type'] or [])) & _EXPENSE_VT}

        # ── Expense creditors (ledger-only) ──────────────────────────────────
        # Expense-type vendors are dropped below to keep the Purchase dashboard
        # purchase-only. The all-party ledger (include_expense=True) DOES want
        # them, tagged as Expense. Their 'billed' above is understated — the main
        # bill query excludes expense categories AND journal vouchers — so
        # re-count ALL their bills here with neither exclusion: expense spend is
        # usually booked as a journal voucher, and dropping it left payment-only
        # vendors with a phantom Dr (advance) closing. Counting journals as billed
        # nets the payment against the expense so the closing is correct. Only the
        # OPENING/CANCELLED exclusions remain. Payments, debit notes and openings
        # already cover every vendor, so only 'billed'/name/count/overdue is here.
        exp_bills = {}
        if include_expense and expense_vids:
            ebqs = (cls._bill_qs(company_id, vendor_id, product_id, include_transfers)
                    .filter(vendor_id__in=expense_vids)
                    .exclude(vendor_invoice_no='OPENING')
                    .exclude(tally_guid__startswith='OPENING')
                    .exclude(status='CANCELLED'))
            if asof:
                ebqs = ebqs.filter(bill_date__lte=asof)
            exp_bills = {r['vendor_id']: r for r in ebqs.values(
                'vendor_id', 'vendor__vendor_name').annotate(
                billed=Sum('total_amount'),
                bill_count=Count('id', distinct=True),
                overdue=Coalesce(Sum(_BILL_BALANCE,
                    filter=Q(due_date__lt=today) & ~Q(status__in=BILL_SETTLED_STATUSES)), _ZERO),
                oldest_overdue=Min('due_date',
                    filter=Q(due_date__lt=today) & ~Q(status__in=BILL_SETTLED_STATUSES)),
            )}
            # (name / company / msme for every expense vendor were resolved
            # from the master above, so no per-bill backfill is needed here.)

        # PURCHASE-ONLY (sales-twin netting removed). A vendor marked "Also a
        # customer" carries a linked_customer, and this table USED to net that
        # customer's sales (invoices − receipts) into the vendor's creditor
        # balance, on the assumption Tally keeps them on one combined ledger.
        # That holds only for genuine one-ledger parties; most (e.g. Greenstar)
        # have SEPARATE Tally creditor/debtor ledgers, so the netting pulled a
        # sales receivable into the purchase outstanding — and it disagreed with
        # the headline Outstanding tile, which is already purchase-only. The
        # sales side dropped the mirror of this merge for the same reason. The
        # combined net position lives in the Vendor-Customer report instead.
        out = []
        _loop_vids = set(bills) | set(op_by_vid) | set(exp_bills)
        if include_expense:
            # An expense vendor with only payments (advances, no bills/opening)
            # is in `pays` but none of the above — add it so it isn't dropped.
            _loop_vids |= {v for v in expense_vids if v in pays}
        for vid in _loop_vids:
            is_exp = vid in expense_vids
            if is_exp and not include_expense:
                continue
            # MSME toggle: keep only vendors whose flag matches the request.
            if msme is not None and msme_by_vid.get(vid, False) != msme:
                continue
            # Expense vendors use the full-bill recount (exp_bills); everyone
            # else uses the purchase-only query (bills).
            b = exp_bills.get(vid) if is_exp else bills.get(vid)
            billed_net = ((b['billed'] if b else _ZERO) or _ZERO)
            paid = pays.get(vid, _ZERO) + dn_dr.get(vid, _ZERO)          # debit side
            opening = op_by_vid.get(vid, (_ZERO, None))[0]
            balance = billed_net + dn_cr.get(vid, _ZERO) - paid + opening
            pct = (paid / billed_net * 100) if billed_net else _ZERO
            name = ((b['vendor__vendor_name'] if b else None)
                    or op_by_vid.get(vid, (None, None))[1]
                    or exp_name.get(vid) or '(unknown)')
            out.append({
                'vendor_id': str(vid) if vid else None,
                'vendor_name': name,
                'company_name': co_by_vid.get(vid, ''),
                'is_msme': msme_by_vid.get(vid, False),
                'bill_count': b['bill_count'] if b else 0,
                'billed': _money(billed_net),
                'paid': _money(paid),
                'opening': _money(opening),
                'outstanding': _money(balance),
                'overdue': _money((b['overdue'] if b else _ZERO) or _ZERO),
                'overdue_days': ((today - b['oldest_overdue']).days
                                 if (b and b.get('oldest_overdue')) else 0),
                'paid_pct': round(float(pct), 1),
                'advance': _money(adv_by_vid.get(vid, _ZERO)),
                'is_expense': is_exp,
                '_sort': abs(float(balance)),
            })
        for nm, amt in (op_names if msme is None else []):
            out.append({
                'vendor_id': None, 'vendor_name': nm, 'company_name': '', 'bill_count': 0,
                'billed': _money(_ZERO), 'paid': _money(_ZERO), 'opening': _money(amt),
                'outstanding': _money(amt), 'overdue': _money(_ZERO), 'overdue_days': 0,
                'paid_pct': 0.0, '_sort': abs(float(amt)),
            })
        out.sort(key=lambda r: -r.pop('_sort'))
        return out

    # ── payables calendar (authoritative, ledger-tied) ───────────────────────
    @classmethod
    def _payables_calendar(cls, company_id, vendor_id=None, msme=None):
        """Each open bill with a LEDGER-TIED balance, for the payment calendar.

        The Payables calendar used to sum each bill's own balance_due
        (total − amount_paid). That ignores on-account advances entirely, so a
        vendor whose payments were booked on-account (not applied to a specific
        bill) read as fully unpaid — the audit measured this over-stating UAI by
        ₹8.9cr and SSB by ₹16.2cr, and even showed vendors paid in ADVANCE as
        large payables (Sperrholz −₹8.3cr authoritative vs the bill-sum's ~0).

        This instead starts from the SAME per-vendor authoritative balance the
        vendor ledger and Tally agree on (_vendor_breakdown: opening + billed −
        all payments incl on-account − debit notes), then ALLOCATES that balance
        across the vendor's open bills OLDEST-FIRST: the vendor's payments settle
        the oldest bills first, so whatever is still owed lands on the newest
        bills — each keeping its real due date for bucketing. A vendor whose
        authoritative balance is ≤ 0 (paid up or in advance) contributes nothing.

        Returns a flat list of dicts, one per bill carrying a positive allocated
        balance:
            {bill_id, vendor_id, vendor_name, company_name, vendor_is_msme,
             bill_no, vendor_invoice_no, bill_date, due_date, balance}
        Σ balance == Σ authoritative outstanding == the vendor ledger, to the
        rupee."""
        # 1) authoritative per-vendor balance (positive = we owe).
        auth = {}
        for r in cls._vendor_breakdown(company_id, vendor_id, msme=msme):
            vid = r.get('vendor_id')
            if not vid:
                continue                        # opening-only parties w/o a master: no bills to place
            bal = Decimal(str(r.get('outstanding') or '0'))
            if bal > 0:
                auth[vid] = bal

        if not auth:
            return []

        # 2) the open bills to spread it over — same universe the breakdown
        #    billed from (real purchases, no opening carriers / expenses /
        #    journals / branch transfers), oldest-first by due date then bill date.
        bqs = (cls._bill_qs(company_id, vendor_id, msme=msme)
               .filter(vendor_id__in=list(auth.keys()))
               .exclude(status='CANCELLED')
               .exclude(status__in=BILL_SETTLED_STATUSES)
               .exclude(vendor_invoice_no='OPENING')
               .exclude(tally_guid__startswith='OPENING')
               .exclude(purchase_category__in=_EXPENSE_CATS)
               .exclude(tally_voucher_type__icontains='journal')
               .select_related('vendor', 'vendor__company')
               .only('id', 'bill_no', 'vendor_invoice_no', 'bill_date', 'due_date',
                     'total_amount', 'purchase_category', 'vendor_id', 'vendor__vendor_name',
                     'vendor__is_msme', 'vendor__company__legal_name'))

        # Key by STRING vendor id: _vendor_breakdown returns vendor_id as str, so
        # auth is string-keyed — bucketing bills by the raw UUID here and then
        # auth.get(uuid) would always miss (every vendor read owed=0, calendar
        # empty). Caught by test_payables_calendar.
        by_vendor = {}
        for b in bqs:
            by_vendor.setdefault(str(b.vendor_id), []).append(b)

        out = []
        for vid, bills in by_vendor.items():
            owed = auth.get(vid, _ZERO)
            if owed <= 0:
                continue
            # oldest-first: due date, then bill date, then id (stable).
            bills.sort(key=lambda b: (b.due_date or b.bill_date or _DATE_MAX,
                                      b.bill_date or _DATE_MAX, str(b.id)))
            total_billed = sum((Decimal(str(b.total_amount or 0)) for b in bills), _ZERO)
            # Amount already settled = billed − still-owed. Pay down the oldest
            # bills with it; the remainder of the balance falls on the newest.
            settled = total_billed - owed
            if settled < 0:
                settled = _ZERO                 # owe more than billed (e.g. opening-heavy): all bills open
            for b in bills:
                amt = Decimal(str(b.total_amount or 0))
                if settled >= amt:
                    settled -= amt
                    continue                    # this old bill is fully covered
                bal = amt - settled             # partially or fully still owed
                settled = _ZERO
                if bal <= 0:
                    continue
                out.append({
                    'bill_id': str(b.id),
                    'vendor_id': str(vid),
                    'vendor_name': b.vendor.vendor_name if b.vendor_id else '',
                    'company_name': (getattr(getattr(b.vendor, 'company', None), 'legal_name', '') or ''),
                    'vendor_is_msme': bool(getattr(b.vendor, 'is_msme', False)),
                    'bill_no': b.bill_no or '',
                    'vendor_invoice_no': b.vendor_invoice_no or '',
                    'purchase_category': b.purchase_category or '',
                    'bill_date': b.bill_date.isoformat() if b.bill_date else None,
                    'due_date': b.due_date.isoformat() if b.due_date else None,
                    'balance': _money(bal),
                })
        return out

    # ── payments made ───────────────────────────────────────────────────────
    @staticmethod
    def _payment_qs(company_id, vendor_id, product_id=None):
        # CANCELLED payments are status-only (like bills) — keep them out of
        # Amount Paid, matching the analytics MoM trend which already does.
        # TRANSFERS (bank/cash contra mis-booked as a vendor payment) are internal
        # money movement, NOT a payment to a creditor, so they never count toward
        # Amount Paid / Outstanding.
        # Purchase dashboard = RM+Packing purchase payments only; freight and
        # expense payments live in their own analytics. Excluded here so every
        # Purchase Amount-Paid figure (settled, recorded, the daily trend) is
        # purchase-only and consistent with Total Purchase / Bills / Outstanding.
        qs = (PaymentMade.objects.filter(is_active=True)
              .exclude(status='CANCELLED').exclude(is_transfer=True)
              .exclude(_payment_expense_like_q(company_id)))
        if vendor_id:
            qs = qs.filter(vendor_id=vendor_id)
        if company_id:
            qs = qs.filter(
                Q(bill__purchase_order__company_id=company_id)
                | Q(bill__receipt_advice__warehouse__company_id=company_id)
                | Q(bill__vendor__company_id=company_id)
            )
        if product_id:
            from .models import VendorBillLine
            qs = qs.filter(bill_id__in=VendorBillLine.objects.filter(
                product_id__in=product_id).values('bill_id'))
        return qs

    @classmethod
    def _payment_stats(cls, start, end, company_id, vendor_id, product_id=None,
                       include_transfers=False, source=None, _dup_cache=None):
        """How much of THIS PERIOD'S bills has been settled.

        Read off VendorBill.amount_paid, not off PaymentMade. The other two
        tiles on this card already do: Outstanding Payables is
        SUM(total_amount - amount_paid) and the Vendor details table sums the
        same field. Reading payment RECORDS here made Amount Paid the odd one
        out, and the card stopped adding up the moment a bill carried a paid
        figure without a matching PaymentMade row - which is every bill the
        Zoho import creates, because that import brings the settled amount on
        the bill and no payment vouchers at all. April showed Rs 13.28 crore
        billed, Rs 0.00 paid and Rs 11.74 crore outstanding, leaving Rs 1.54
        crore unaccounted for while the vendor table beneath it plainly listed
        Senthil at 98% paid.

        The two are genuinely different measures - money that MOVED in the
        window versus how much of the window's bills is settled - and the
        second is the one that belongs beside Total Purchase and Outstanding.
        `payments_recorded` keeps the cash-flow figure available for anyone who
        wants it, and stays 0 until payment vouchers are actually imported.
        """
        recorded = cls._payment_qs(company_id, vendor_id, product_id).filter(
            payment_date__gte=start, payment_date__lte=end,
        ).aggregate(t=Sum('amount'))['t'] or _ZERO

        # Exactly the set _bill_stats counts, so Paid and Outstanding describe
        # the same bills Total Purchase does.
        bills = cls._bill_qs(company_id, vendor_id, product_id, include_transfers, source=source).filter(
            bill_date__gte=start, bill_date__lte=end,
        ).exclude(status='CANCELLED').exclude(tally_guid__startswith='OPENING')
        # Same dedup as Bills / Total Purchase so settled Paid ties them.
        _d = _cached_dup_bill_ids(bills, _dup_cache)
        if _d:
            bills = bills.exclude(id__in=_d)
        # Bought Notes are cash purchases settled with the farmer on the spot (not paid
        # from a bank account), so their amount_paid must NOT count as "Amount Paid" —
        # that figure tracks money paid to vendors from the company's accounts.
        settled = (bills.exclude(purchase_category='BOUGHT_NOTE').exclude(is_cash=True)
                   # Purchase-only, like the Total Purchase / Bills tiles: drop
                   # freight/expense/machinery bills (is_expense already filtered
                   # by _bill_qs; this also drops category-tagged ones).
                   .exclude(_OUTSTANDING_EXPENSE_LIKE)
                   .aggregate(t=Sum('amount_paid'))['t'] or _ZERO)

        # Split the period's actual payments by the CATEGORY of purchase they paid
        # for (RM / Maize / Bought Note / Packing / Fruit) — the "Amount Paid by
        # account" view. Category comes from the bill each payment is linked to,
        # or (for on-account money with no bill) the vendor's usual category, so
        # it is known for every purchase payment. This replaces the old
        # split-by-bank-account, which left connector-imported payments (no bank
        # leg captured) in an "Untagged" bucket. There is no untagged bucket now:
        # anything unresolved lands in a labelled "Other purchases". Filtered by
        # vendor's company so on-account payments are still counted.
        from purchase.payment_buckets import (
            category_bucket, CATEGORY_BUCKET_LABEL, CATEGORY_BUCKET_ORDER)
        acct_qs = (PaymentMade.objects.filter(is_active=True)
                   .exclude(status='CANCELLED')
                   .exclude(is_transfer=True)  # bank/cash contra is internal, not
                   #   a creditor payment — excluded on the Amount-Paid header
                   #   (_outstanding_payables) too, so the buckets sum to it.
                   .exclude(vendor__is_branch=True)  # internal ledgers (bank/cash/
                   #   loan/interest wrongly imported as vendors, and true branch
                   #   entities) — their payments are OD-interest / transfers, not
                   #   supplier cash, so keep them out of Amount-Paid-by-account.
                   .exclude(_payment_expense_like_q(company_id))  # purchase only,
                   #   same as the Amount-Paid header — freight/expense have their
                   #   own analytics, so the buckets stay purchase-only and sum.
                   .filter(payment_date__gte=start, payment_date__lte=end))
        if vendor_id:
            acct_qs = acct_qs.filter(vendor_id=vendor_id)
        if company_id:
            acct_qs = acct_qs.filter(vendor__company_id=company_id)
        if product_id:
            # Every other figure on this card is product-scoped; leaving the
            # by-account split whole made Amount Paid read Rs 134.9 cr beside
            # a Total Purchase of Rs 0.00.
            from .models import VendorBillLine as _VBL
            acct_qs = acct_qs.filter(bill_id__in=_VBL.objects.filter(
                product_id__in=product_id).values('bill_id'))
        # Vendor -> usual purchase category, for on-account payments that have no
        # bill to read the category from. A vendor's category is the one their
        # own bills carry; take the highest-value category across this vendor's
        # bills (one grouped query) so the on-account money is tagged the same
        # way the vendor's billed money is.
        # Every vendor here — so a blank bill category or an on-account payment
        # can fall back to the vendor's usual BILLED category, then the vendor
        # master type (same chain as PaidByCategoryView), instead of 'other'.
        all_vendor_ids = set(acct_qs.values_list('vendor_id', flat=True))
        vendor_cat = {}
        vendor_type = {}
        if all_vendor_ids:
            from .models import VendorBill as _VB
            from master.models import Vendor as _V
            best = {}  # vendor_id -> (category, total_value)
            for r in (_VB.objects.filter(vendor_id__in=all_vendor_ids, is_active=True)
                      .exclude(purchase_category='')
                      .values('vendor_id', 'purchase_category')
                      .annotate(t=Sum('total_amount'))):
                vid, cat, tot = r['vendor_id'], r['purchase_category'], (r['t'] or _ZERO)
                if cat and (vid not in best or tot > best[vid][1]):
                    best[vid] = (cat, tot)
            vendor_cat = {vid: cat for vid, (cat, _t) in best.items()}
            for vid, vt in (_V.objects.filter(id__in=all_vendor_ids)
                            .values_list('id', 'vendor_type')):
                if isinstance(vt, (list, tuple)) and vt:
                    vendor_type[vid] = str(vt[0]).upper()

        def _route(cat, vid):
            b = category_bucket(cat)
            if b != 'other':
                return b
            b = category_bucket(vendor_cat.get(vid))
            if b != 'other':
                return b
            return category_bucket(vendor_type.get(vid))

        acct = {}
        # Payments WITH a bill: bill category, with vendor fallback.
        for row in (acct_qs.filter(bill__isnull=False)
                    .values('bill__purchase_category', 'vendor_id').annotate(t=Sum('amount'))):
            b = _route(row['bill__purchase_category'], row['vendor_id'])
            acct[b] = acct.get(b, _ZERO) + (row['t'] or _ZERO)
        # On-account payments (no bill): vendor's usual category, then type.
        for row in (acct_qs.filter(bill__isnull=True)
                    .values('vendor_id').annotate(t=Sum('amount'))):
            b = _route(None, row['vendor_id'])
            acct[b] = acct.get(b, _ZERO) + (row['t'] or _ZERO)
        paid_by_account = [
            {'key': k, 'label': CATEGORY_BUCKET_LABEL[k], 'amount': _money(acct[k])}
            for k in CATEGORY_BUCKET_ORDER if acct.get(k)]
        return {'total': _money(settled), 'payments_recorded': _money(recorded),
                'paid_by_account': paid_by_account,
                'paid_by_account_total': _money(sum(acct.values(), _ZERO))}

    @classmethod
    def _payment_status_split(cls, start, end, company_id, vendor_id, product_id=None,
                              include_transfers=False, source=None, msme=None, _dup_cache=None):
        """Split THIS PERIOD'S bills into fully-paid / partially-paid / unpaid
        by comparing each bill's amount_paid to its total_amount. Returns the
        COUNT and the amount in each bucket so the Amount Paid / Payable tiles
        can show 'X bills paid, Y partial, Z pending'."""
        bills = cls._bill_qs(company_id, vendor_id, product_id, include_transfers,
                             source=source, msme=msme).filter(
            bill_date__gte=start, bill_date__lte=end,
        ).exclude(status='CANCELLED').exclude(tally_guid__startswith='OPENING')
        _d = _cached_dup_bill_ids(bills, _dup_cache)
        if _d:
            bills = bills.exclude(id__in=_d)
        # Purchase-only — exclude expense-like bills, the SAME rule as the Amount
        # Billed / Total Purchase tiles, so the paid/partial/pending counts sum to
        # the billed count (not to every bill incl. expenses).
        expense_like = (Q(is_expense=True) | Q(purchase_category__in=_EXPENSE_CATS)
                        | Q(tally_voucher_type__icontains='journal'))
        bills = bills.exclude(expense_like)

        paid_c = paid_amt = partial_c = partial_paid = partial_bal = unpaid_c = unpaid_amt = 0
        paid_c = partial_c = unpaid_c = 0
        paid_amt = partial_paid = partial_bal = unpaid_amt = _ZERO
        for b in bills.only('total_amount', 'amount_paid'):
            total = b.total_amount or _ZERO
            ap = b.amount_paid or _ZERO
            if ap <= 0:
                unpaid_c += 1
                unpaid_amt += total
            elif ap >= total:
                paid_c += 1
                paid_amt += total
            else:
                partial_c += 1
                partial_paid += ap
                partial_bal += (total - ap)
        return {
            'paid': {'count': paid_c, 'amount': _money(paid_amt)},
            'partial': {'count': partial_c, 'paid': _money(partial_paid),
                        'balance': _money(partial_bal)},
            'unpaid': {'count': unpaid_c, 'amount': _money(unpaid_amt)},
        }

    # ── daily trend ─────────────────────────────────────────────────────────
    @classmethod
    def _trend(cls, start, end, company_id, warehouse_id, vendor_id, product_id):
        days = {}
        cursor = start
        while cursor <= end:
            days[cursor.isoformat()] = {
                'date': cursor.isoformat(),
                'po_count': 0,
                'pr_count': 0,
                'received_qty': 0.0,
                'amount_paid': 0.0,
            }
            cursor += timedelta(days=1)

        # POs by po_date (DateField). distinct id → product join can't inflate.
        po_qs = cls._po_header_qs(start, end, company_id, warehouse_id, vendor_id, product_id)
        for row in po_qs.values('po_date').annotate(c=Count('id', distinct=True)):
            key = row['po_date'].isoformat()
            if key in days:
                days[key]['po_count'] = row['c']

        # PRs by request_date (DateTimeField → TruncDate).
        pr_qs = PurchaseRequest.objects.filter(
            request_date__date__gte=start, request_date__date__lte=end, is_active=True,
        )
        if company_id:
            pr_qs = pr_qs.filter(company_id=company_id)
        if warehouse_id:
            pr_qs = pr_qs.filter(warehouse_id=warehouse_id)
        if product_id:
            pr_qs = pr_qs.filter(lines__product_service_id__in=product_id)
        for row in pr_qs.annotate(d=TruncDate('request_date')).values('d').annotate(c=Count('id', distinct=True)):
            key = row['d'].isoformat()
            if key in days:
                days[key]['pr_count'] = row['c']

        # Received qty per day (ReceiptLine → receipt.receipt_date).
        rl_qs = cls._receipt_line_qs(start, end, company_id, warehouse_id, vendor_id, product_id)
        for row in rl_qs.annotate(d=TruncDate('receipt__receipt_date')).values('d').annotate(q=Sum('quantity_received')):
            key = row['d'].isoformat()
            if key in days:
                days[key]['received_qty'] = _qty(row['q'])

        # Amount paid per day (PaymentMade.payment_date). vendor/company only.
        pay_qs = cls._payment_qs(company_id, vendor_id).filter(
            payment_date__gte=start, payment_date__lte=end,
        )
        for row in pay_qs.values('payment_date').annotate(amt=Sum('amount')):
            key = row['payment_date'].isoformat()
            if key in days:
                days[key]['amount_paid'] = _money(row['amt'])

        return list(days.values())

    # ── entrypoint ──────────────────────────────────────────────────────────
    def get(self, request, *args, **kwargs):
        period = (request.query_params.get('period') or 'month').lower()
        frm = request.query_params.get('from')
        to = request.query_params.get('to')
        company_id = request.query_params.get('company') or None
        warehouse_id = request.query_params.get('warehouse') or None
        vendor_id = request.query_params.get('vendor') or None
        product_id = resolve_product_filter(request.query_params.get('product'))
        source = (request.query_params.get('source') or 'all').lower()
        _msme_p = request.query_params.get('msme', '')
        msme = True if _msme_p == 'true' else (False if _msme_p == 'false' else None)

        start, end, label = self._resolve_range(period, frm, to)
        prev_start, prev_end = self._previous_range(start, end)

        # Per-request cache for _dup_bill_ids — avoids re-scanning the same
        # queryset multiple times across the many stat helpers below.
        _dup_cache = {}

        pr_now = self._pr_stats(start, end, company_id, warehouse_id, product_id)
        pr_prev = self._pr_stats(prev_start, prev_end, company_id, warehouse_id, product_id)

        po_now = self._po_stats(start, end, company_id, warehouse_id, vendor_id, product_id)
        po_prev = self._po_stats(prev_start, prev_end, company_id, warehouse_id, vendor_id, product_id)

        rcv_now = self._receipt_stats(start, end, company_id, warehouse_id, vendor_id, product_id)
        rcv_prev = self._receipt_stats(prev_start, prev_end, company_id, warehouse_id, vendor_id, product_id)

        # Branch-transfer toggle: by default the purchase figures EXCLUDE "DC/"
        # branch-transfer delivery challans (internal stock moves — Tally's
        # Purchase Register excludes them). ?include_transfers=1 counts them.
        # ?transfers=only flips to showing ONLY the branch transfers (the
        # "Transfers" pill) — it forces include and sets transfers_only so every
        # tile re-scopes to the DC set.
        _transfers_mode = (request.query_params.get('transfers') or '').lower()
        t_only = _transfers_mode == 'only'
        inc = t_only or str(request.query_params.get('include_transfers', '')).lower() in ('1', 'true', 'yes')
        # The transfers figure itself (always the DC-only total for the period),
        # so the UI can show "Branch Transfers Rs X" alongside Total Purchase.
        _tqs = (self._bill_qs(company_id, vendor_id, product_id, include_transfers=True)
                .filter(branch_transfer_q(), bill_date__gte=start, bill_date__lte=end)
                .exclude(status='CANCELLED').exclude(tally_guid__startswith='OPENING'))
        _ta = _tqs.aggregate(t=Sum('total_amount'), n=Count('id'))
        branch_transfers = {'total': _money(_ta['t'] or _ZERO),
                            'count': _ta['n'] or 0}

        bill_now = self._bill_stats(start, end, company_id, vendor_id, product_id, inc, source=source, msme=msme, transfers_only=t_only, _dup_cache=_dup_cache)
        bill_prev = self._bill_stats(prev_start, prev_end, company_id, vendor_id, product_id, inc, source=source, msme=msme, transfers_only=t_only, _dup_cache=_dup_cache)
        qty_now = self._billed_qty_stats(start, end, company_id, vendor_id, product_id, inc, source=source, transfers_only=t_only, _dup_cache=_dup_cache)

        pay_now = self._payment_stats(start, end, company_id, vendor_id, product_id, inc, source=source, _dup_cache=_dup_cache)
        pay_prev = self._payment_stats(prev_start, prev_end, company_id, vendor_id, product_id, inc, source=source, _dup_cache=_dup_cache)
        _status_split = self._payment_status_split(start, end, company_id, vendor_id, product_id, inc, source=source, msme=msme, _dup_cache=_dup_cache)

        return Response({
            'period': {
                'label': label,
                'from': start.isoformat(),
                'to': end.isoformat(),
                'previous_from': prev_start.isoformat(),
                'previous_to': prev_end.isoformat(),
            },
            'company_id': company_id,
            'warehouse_id': warehouse_id,
            'vendor_id': vendor_id,
            'product_id': product_id,
            'stats': {
                'purchase_requests': {
                    'count': pr_now['count'],
                    'previous_count': pr_prev['count'],
                    'pending_count': pr_now['pending_count'],
                    'approved_count': pr_now['approved_count'],
                },
                'purchase_orders': {
                    'count': po_now['count'],
                    'amount': po_now['amount'],
                    'previous_count': po_prev['count'],
                },
                # Quantity comes from the BILLS, not from receipts — same
                # documents as total_purchase / bills, so the two can never
                # disagree about which period they cover. `quantity_received`
                # is still emitted (receipt-sourced) for any caller that wants
                # the goods-inward view, but the dashboard no longer shows it.
                'quantity_billed': qty_now,
                'quantity_received': {
                    'total_qty': rcv_now['total_qty'],
                    'receipt_count': rcv_now['receipt_count'],
                    'previous_receipt_count': rcv_prev['receipt_count'],
                    'uom_breakdown': rcv_now['uom_breakdown'],
                },
                'bills': {
                    'count': bill_now['count'],
                    'amount': bill_now['amount'],
                    'previous_count': bill_prev['count'],
                    'expense_count': bill_now['expense_count'],
                    'expense_amount': bill_now['expense_amount'],
                },
                'total_purchase': self._total_purchase(start, end, company_id, vendor_id, product_id, inc, source=source, msme=msme, transfers_only=t_only, _dup_cache=_dup_cache),
                'branch_transfers': branch_transfers,
                'include_transfers': inc,
                'transfers_only': t_only,
                'amount_paid': {
                    'total': pay_now['total'],
                    'previous_total': pay_prev['total'],
                    'paid_by_account': pay_now.get('paid_by_account', []),
                    'paid_by_account_total': pay_now.get('paid_by_account_total'),
                    'status_split': _status_split,
                },
                'outstanding_payables': self._outstanding_payables(company_id, vendor_id, product_id, start, end, inc, source=source, msme=msme, transfers_only=t_only, _dup_cache=_dup_cache),
                'payment_status_split': _status_split,
            },
            'top_vendors': self._top_vendors(start, end, company_id, warehouse_id, vendor_id, product_id),
            'vendor_breakdown': self._vendor_breakdown(company_id, vendor_id, product_id, start, end, inc, msme=msme),
            'by_company': self._by_company(start, end, company_id, warehouse_id, vendor_id, product_id),
            'po_fulfillment': self._po_fulfillment(start, end, company_id, warehouse_id, vendor_id, product_id,
                                                    include_transfers=inc),
            'trend': self._trend(start, end, company_id, warehouse_id, vendor_id, product_id),
        })


class PurchaseDashboardRecordsView(APIView):
    """GET /api/purchase/dashboard/records/?type=payables_buckets&company=&vendor=

    Outstanding-payables drill-down: vendor bills split by payment terms (each
    bill's due date) — the payables mirror of the sales receivables buckets.
      Within Payment Terms  → Paid Early / Still Open
      Exceeded Payment Terms→ Paid Late / Overdue (unpaid)
    Rows carry the bill + its Purchase Order (hyperlinked). Live snapshot."""

    permission_classes = [permissions.IsAuthenticated, HasModulePermission]
    module_name = 'Purchase Order'

    def _payables_buckets(self, company_id, vendor_id=None, product_id=None, start=None, end=None,
                           include_transfers=False):
        from django.db.models import Max
        from .category_views import _dup_bill_ids
        today = timezone.localdate()
        # This drill DELIBERATELY keeps settled bills: it shows paid-early/
        # paid-late history and an "incl. settled" Total beside the owed figure
        # (outstanding_total below is the owed-only number the tile uses). So it
        # drops only CANCELLED — but it MUST exclude OPENING-balance carriers
        # (a ledger carry-forward), plus expense-like bills and duplicate
        # re-imports, so its owed figure counts the SAME purchases-only universe
        # as the tile + aging panel and can't exceed total bills.
        qs = (PurchaseDashboardView._bill_qs(company_id, vendor_id, product_id, include_transfers)
              .exclude(status='CANCELLED')
              .exclude(vendor_invoice_no='OPENING')
              .exclude(vendor_invoice_no__startswith='OPEN-')
              .exclude(tally_guid__startswith='OPENING')
              .exclude(_OUTSTANDING_EXPENSE_LIKE)
              .select_related('vendor', 'purchase_order')
              .annotate(last_pay=Max('payments__payment_date')))
        _d = _dup_bill_ids(qs)
        if _d:
            qs = qs.exclude(id__in=_d)
        # Optional date window — restrict to bills dated in the period.
        if start and end:
            qs = qs.filter(bill_date__gte=start, bill_date__lte=end)

        def _row(bill, amount, days, days_label):
            is_open = (bill.vendor_invoice_no or '') == 'OPENING'
            po = bill.purchase_order if not is_open else None
            return {
                'bill_id': str(bill.id),
                'bill_no': 'Opening Balance' if is_open else (bill.bill_no or bill.vendor_invoice_no or ''),
                'is_opening': bool(is_open),
                'vendor_id': str(bill.vendor_id) if bill.vendor_id else None,
                'vendor_name': bill.vendor.vendor_name if bill.vendor_id else '',
                'po_no': (po.po_no if po else '') or '',
                'po_id': str(po.id) if po else None,
                'bill_date': bill.bill_date.isoformat() if bill.bill_date else None,
                'due_date': bill.due_date.isoformat() if bill.due_date else None,
                'amount': str((amount or _ZERO).quantize(Decimal('0.01'))),
                'days': days,
                'days_label': days_label,
                'status': bill.status,
            }

        b = {'paid_early': [], 'still_open': [], 'paid_late': [], 'overdue_unpaid': []}
        for bill in qs:
            bal = (bill.total_amount or _ZERO) - (bill.amount_paid or _ZERO)
            due = bill.due_date
            if bal > 0:  # still owed
                if due and due < today:
                    d = (today - due).days
                    b['overdue_unpaid'].append(_row(bill, bal, d, f'{d} days overdue'))
                else:
                    d = (due - today).days if due else 0
                    b['still_open'].append(_row(bill, bal, d, f'{d} days to due' if d > 0 else 'due today'))
            else:  # settled
                paid_amt = bill.amount_paid or bill.total_amount or _ZERO
                ref = bill.last_pay or bill.bill_date
                if due and ref and ref > due:
                    d = (ref - due).days
                    b['paid_late'].append(_row(bill, paid_amt, d, f'{d} days late'))
                else:
                    d = (due - ref).days if (due and ref) else 0
                    b['paid_early'].append(_row(bill, paid_amt, max(d, 0), f'{d} days early' if d > 0 else 'on due date'))

        # Group by vendor (party) first so every bill for the same vendor sits
        # together, then order within each vendor by the bucket's timing metric.
        def _vk(r):
            return (r.get('vendor_name') or '').strip().lower()
        b['paid_early'].sort(key=lambda r: (_vk(r), -r['days']))
        b['still_open'].sort(key=lambda r: (_vk(r), r['days']))
        b['overdue_unpaid'].sort(key=lambda r: (_vk(r), -r['days']))
        b['paid_late'].sort(key=lambda r: (_vk(r), -r['days']))

        def _sub(key, label, rows):
            tot = sum((Decimal(r['amount']) for r in rows), _ZERO)
            return {'key': key, 'label': label, 'count': len(rows),
                    'total': str(tot.quantize(Decimal('0.01'))), 'rows': rows}

        def _grp(key, label, subs):
            tot = sum((Decimal(s['total']) for s in subs), _ZERO)
            return {'key': key, 'label': label, 'total': str(tot.quantize(Decimal('0.01'))),
                    'count': sum(s['count'] for s in subs), 'sub': subs}

        groups = [
            _grp('within_terms', 'Within Payment Terms', [
                _sub('paid_early', 'Paid Early (on/before due)', b['paid_early']),
                _sub('still_open', 'Still Open (not yet due)', b['still_open']),
            ]),
            _grp('exceeded_terms', 'Exceeded Payment Terms', [
                _sub('paid_late', 'Paid Late (after due)', b['paid_late']),
                _sub('overdue_unpaid', 'Overdue — Unpaid', b['overdue_unpaid']),
            ]),
        ]
        grand = sum((Decimal(g['total']) for g in groups), _ZERO)
        outstanding = sum((Decimal(s['total']) for g in groups for s in g['sub']
                           if s['key'] in ('still_open', 'overdue_unpaid')), _ZERO)
        return {'groups': groups, 'total': str(grand.quantize(Decimal('0.01'))),
                'outstanding_total': str(outstanding.quantize(Decimal('0.01')))}

    def _aging_buckets(self, company_id, vendor_id=None, product_id=None, include_transfers=False):
        """Bills grouped by days since bill_date into 0-30/31-60/61-90/91-180/180+ buckets.

        Only unpaid/partially-paid bills are included (balance > 0).
        Each bucket returns summary + top-3 bills for preview; full bill list is
        fetched separately via the /api/purchase/bills/ endpoint.
        """
        from .category_views import _dup_bill_ids
        today = timezone.localdate()
        BUCKETS = [
            ('0_30',   '0–30 days',   0,   30,  'emerald'),
            ('31_60',  '31–60 days',  31,  60,  'sky'),
            ('61_90',  '61–90 days',  61,  90,  'amber'),
            ('91_180', '91–180 days', 91,  180, 'orange'),
            ('180p',   '180+ days',   181, None, 'rose'),
        ]
        # Match the Outstanding tile (_outstanding_payables) EXACTLY: drop
        # PAID/CANCELLED and the OPENING-balance carriers. The panel already
        # kept only balance>0 bills, but it did NOT exclude OPENING bills while
        # the tile does — that mismatch is why the panel header read e.g. "1686
        # unpaid" against the tile's 1654 (the ~32 opening carriers). Opening
        # balances are a ledger carry-forward, not an unpaid purchase bill.
        qs = (PurchaseDashboardView._bill_qs(company_id, vendor_id, product_id, include_transfers)
              .exclude(status__in=('CANCELLED', 'PAID'))
              .exclude(vendor_invoice_no='OPENING')
              .exclude(vendor_invoice_no__startswith='OPEN-')
              .exclude(tally_guid__startswith='OPENING')
              .exclude(_OUTSTANDING_EXPENSE_LIKE)
              .select_related('vendor')
              .order_by('-bill_date'))
        # Same purchases-only universe as the Bills tile + Outstanding tile:
        # drop expense-like and duplicate re-imports so the panel count can't
        # exceed total bills.
        _d = _dup_bill_ids(qs)
        if _d:
            qs = qs.exclude(id__in=_d)

        # Collect all bills with positive balance
        bills = []
        for b in qs:
            bal = (b.total_amount or _ZERO) - (b.amount_paid or _ZERO)
            if bal > _ZERO:
                age = (today - b.bill_date).days if b.bill_date else 0
                bills.append({
                    'bill_id': str(b.id),
                    'bill_no': b.bill_no or b.vendor_invoice_no or '',
                    'vendor_name': b.vendor.vendor_name if b.vendor_id else '',
                    'vendor_id': str(b.vendor_id) if b.vendor_id else None,
                    'bill_date': b.bill_date.isoformat() if b.bill_date else None,
                    'outstanding': bal,
                    'days': age,
                })

        grand = sum((r['outstanding'] for r in bills), _ZERO)
        oldest_overall = min((r['bill_date'] for r in bills if r['bill_date']), default=None)

        result_buckets = []
        for key, label, lo, hi, color in BUCKETS:
            bucket_bills = [r for r in bills if r['days'] >= lo and (hi is None or r['days'] <= hi)]
            bucket_bills.sort(key=lambda r: r['days'], reverse=(hi is None))  # oldest first for 180+
            total = sum((r['outstanding'] for r in bucket_bills), _ZERO)
            oldest = min((r['bill_date'] for r in bucket_bills if r['bill_date']), default=None)
            pct = int(round(float(total / grand * 100))) if grand else 0
            preview = [{
                'bill_id': r['bill_id'],
                'bill_no': r['bill_no'],
                'vendor_name': r['vendor_name'],
                'vendor_id': r['vendor_id'],
                'bill_date': r['bill_date'],
                'days': r['days'],
                'outstanding': str(r['outstanding'].quantize(Decimal('0.01'))),
            } for r in bucket_bills[:3]]
            result_buckets.append({
                'key': key,
                'label': label,
                'color': color,
                'count': len(bucket_bills),
                'total': str(total.quantize(Decimal('0.01'))),
                'pct': pct,
                'oldest_bill_date': oldest,
                'preview': preview,
            })

        return {
            'buckets': result_buckets,
            'total': str(grand.quantize(Decimal('0.01'))),
            'bill_count': len(bills),
            'oldest_bill_date': oldest_overall,
        }

    # ── flat record drill-downs for the KEY METRICS tiles (like the sales
    #    dashboard's records modal). Each kind reuses the SAME querysets the KPI
    #    cards are built from, so a drill total equals the tile it opened from. ──
    _CAP = 3000

    def _records(self, kind, company_id, vendor_id, product_id, start, end, inc, account=None):
        from .models import VendorBillLine
        from sales.models import DebitNote   # notes live on the sales app
        Q2 = Decimal('0.01')

        def _bills_base():
            qs = (PurchaseDashboardView._bill_qs(company_id, vendor_id, product_id, inc)
                  .exclude(status='CANCELLED')
                  .exclude(vendor_invoice_no='OPENING')
                  .exclude(tally_guid__startswith='OPENING')
                  .select_related('vendor'))
            if start and end:
                qs = qs.filter(bill_date__gte=start, bill_date__lte=end)
            return qs.order_by('-bill_date', '-bill_no')

        if kind == 'bills':
            # Match the Bills tile (_bill_stats) EXACTLY: expense/journal vouchers
            # live in the Expenses tab, not the Purchase Register, so exclude them
            # here too or the drill count/total overshoots the card that opened it.
            # The tile's exclusion is NOT just the is_expense flag — it is the full
            # expense-like rule (flag OR Freight/Expenses/Machinery category OR a
            # journal voucher) PLUS the duplicate-import dedup. Excluding only
            # is_expense=True left the popup at 243 against the tile's 237: the 6
            # extra were expense-like by category/journal (flag never set) or
            # '-N' re-import duplicates. Scoped to this branch only — 'payments'
            # below shares _bills_base and legitimately includes paid expense bills.
            expense_like = (Q(is_expense=True)
                            | Q(purchase_category__in=_EXPENSE_CATS)
                            | Q(tally_voucher_type__icontains='journal'))
            qs = _bills_base().exclude(expense_like)
            from .category_views import _dup_bill_ids
            _d = _dup_bill_ids(qs)
            if _d:
                qs = qs.exclude(id__in=_d)
            total = _ZERO
            rows = []
            for b in qs[:self._CAP]:
                amt = b.total_amount or _ZERO
                total += amt
                rows.append({'id': str(b.id), 'date': b.bill_date.isoformat() if b.bill_date else None,
                             'bill_no': b.bill_no or b.vendor_invoice_no or '',
                             'vendor': b.vendor.vendor_name if b.vendor_id else '',
                             'type': b.tally_voucher_type or '',
                             'amount': str(amt.quantize(Q2))})
            return {'columns': [
                        {'key': 'date', 'label': 'Date'},
                        {'key': 'bill_no', 'label': 'Bill No', 'link': 'bill'},
                        {'key': 'vendor', 'label': 'Vendor'},
                        {'key': 'type', 'label': 'Type'},
                        {'key': 'amount', 'label': 'Amount', 'align': 'right', 'money': True}],
                    'rows': rows, 'row_count': qs.count(), 'total': str(total.quantize(Q2))}

        if kind == 'payments':
            # Amount Paid is read off VendorBill.amount_paid (matches the KPI),
            # so the drill lists bills that carry a paid figure.
            qs = _bills_base().filter(amount_paid__gt=0)
            total = _ZERO
            rows = []
            for b in qs[:self._CAP]:
                amt = b.amount_paid or _ZERO
                total += amt
                rows.append({'id': str(b.id), 'date': b.bill_date.isoformat() if b.bill_date else None,
                             'bill_no': b.bill_no or b.vendor_invoice_no or '',
                             'vendor': b.vendor.vendor_name if b.vendor_id else '',
                             'amount': str(amt.quantize(Q2))})
            return {'columns': [
                        {'key': 'date', 'label': 'Date'},
                        {'key': 'bill_no', 'label': 'Bill No', 'link': 'bill'},
                        {'key': 'vendor', 'label': 'Vendor'},
                        {'key': 'amount', 'label': 'Paid', 'align': 'right', 'money': True}],
                    'rows': rows, 'row_count': qs.count(), 'total': str(total.quantize(Q2))}

        if kind == 'payment_account':
            # The actual PAYMENTS in one purchase CATEGORY (RM / Maize / Bought
            # Note / Packing / Fruit / Other) — the drill behind each row of the
            # Amount Paid "by category" breakdown. `account` is a category-bucket
            # key; category comes from the linked bill, or (on-account) the
            # vendor's usual category — the SAME resolution as the split, so this
            # drill sums to the bucket it opened.
            from purchase.payment_buckets import (
                category_bucket, CATEGORY_BUCKET_LABEL)
            want = category_bucket(account)  # normalise (e.g. 'rm' -> 'RM')
            # Same exclusions as the by-category split (_payment_stats.acct_qs) so
            # this drill sums to the bucket it opened: no transfers, no internal/
            # branch ledgers, and purchase-only (freight/expense live elsewhere).
            pqs = (PaymentMade.objects.filter(is_active=True).exclude(status='CANCELLED')
                   .exclude(is_transfer=True).exclude(vendor__is_branch=True)
                   .exclude(_payment_expense_like_q(company_id))
                   .select_related('vendor', 'bill'))
            if company_id:
                pqs = pqs.filter(vendor__company_id=company_id)
            if vendor_id:
                pqs = pqs.filter(vendor_id=vendor_id)
            if start and end:
                pqs = pqs.filter(payment_date__gte=start, payment_date__lte=end)
            # Vendor -> usual category, for on-account payments with no bill (same
            # as _payment_stats): highest-value category across the vendor's bills.
            onacct_vids = set(pqs.filter(bill__isnull=True)
                              .values_list('vendor_id', flat=True))
            vendor_cat = {}
            if onacct_vids:
                from .models import VendorBill as _VB
                best = {}
                for r in (_VB.objects.filter(vendor_id__in=onacct_vids, is_active=True)
                          .values('vendor_id', 'purchase_category')
                          .annotate(t=Sum('total_amount'))):
                    vid, c, tot = r['vendor_id'], r['purchase_category'], (r['t'] or _ZERO)
                    if vid not in best or tot > best[vid][1]:
                        best[vid] = (c, tot)
                vendor_cat = {vid: c for vid, (c, _t) in best.items()}
            total = _ZERO
            rows = []
            n = 0
            for p in pqs.order_by('-payment_date'):
                cat = (p.bill.purchase_category if p.bill_id
                       else vendor_cat.get(p.vendor_id))
                if category_bucket(cat) != want:
                    continue
                n += 1
                amt = p.amount or _ZERO
                total += amt
                if len(rows) < self._CAP:
                    rows.append({'id': str(p.id),
                                 'date': p.payment_date.isoformat() if p.payment_date else None,
                                 'ref': p.reference_no or p.payment_no or '',
                                 'bill_id': str(p.bill_id) if p.bill_id else '',
                                 'bill_no': ((p.bill.bill_no or p.bill.vendor_invoice_no or '')
                                             if p.bill_id else ''),
                                 'vendor': p.vendor.vendor_name if p.vendor_id else '',
                                 'amount': str(amt.quantize(Q2))})
            return {'columns': [
                        {'key': 'date', 'label': 'Date'},
                        # Row carries PaymentMade.id (see the append above), so the
                        # reference opens the payment instead of sitting there as the
                        # one obvious thing to click that does nothing.
                        {'key': 'ref', 'label': 'Payment Ref', 'link': 'payment'},
                        {'key': 'bill_no', 'label': 'Bill', 'link': 'bill', 'linkId': 'bill_id'},
                        {'key': 'vendor', 'label': 'Vendor'},
                        {'key': 'amount', 'label': 'Paid', 'align': 'right', 'money': True}],
                    'rows': rows, 'row_count': n, 'total': str(total.quantize(Q2)),
                    'account_label': CATEGORY_BUCKET_LABEL.get(want, want)}

        if kind in ('debit_notes', 'credit_notes'):
            # Purchase-side notes. A DEBIT note is a purchase return (we debit
            # the vendor, payable goes down); a CREDIT note pushes it back up.
            #
            # The filter is deliberately IDENTICAL to the one _total_purchase
            # uses for `returns` — is_active, side, note_type, note_date window,
            # company, vendor — so this drill reconciles to the KPI it opens
            # from. In particular product_id is NOT applied here, exactly as it
            # is not applied there: notes are raised against a vendor, not a
            # product line, so filtering them by product would silently drop
            # rows the headline figure still counts.
            want = 'DEBIT' if kind == 'debit_notes' else 'CREDIT'
            nqs = DebitNote.objects.filter(is_active=True, side='PURCHASE', note_type=want)
            if start and end:
                nqs = nqs.filter(note_date__gte=start, note_date__lte=end)
            if company_id:
                nqs = nqs.filter(company_id=company_id)
            if vendor_id:
                nqs = nqs.filter(vendor_id=vendor_id)
            nqs = nqs.select_related('vendor').order_by('-note_date', '-note_no')
            total = _ZERO
            rows = []
            for n in nqs[:self._CAP]:
                amt = n.amount or _ZERO
                total += amt
                rows.append({'id': str(n.id),
                             'date': n.note_date.isoformat() if n.note_date else None,
                             'note_no': n.note_no or '',
                             'vendor': n.vendor.vendor_name if n.vendor_id else '',
                             'taxable': str((n.taxable if n.taxable is not None else _ZERO).quantize(Q2)),
                             'tds': str((n.tds or _ZERO).quantize(Q2)),
                             'amount': str(amt.quantize(Q2))})
            return {'columns': [
                        {'key': 'date', 'label': 'Date'},
                        # `id` is the DebitNote's own id and the row already
                        # carries it, so the number can open the note instead
                        # of being a dead string. The detail screen lives under
                        # /sales/debit-notes/<id> because ONE model holds all
                        # four (note_type x side) cases — there is no separate
                        # purchase-side page. The frontend hides the link from
                        # anyone without that module rather than walking them
                        # into a route guard.
                        {'key': 'note_no', 'label': 'Note No', 'link': 'note'},
                        {'key': 'vendor', 'label': 'Vendor'},
                        {'key': 'taxable', 'label': 'Taxable', 'align': 'right', 'money': True},
                        {'key': 'tds', 'label': 'TDS', 'align': 'right', 'money': True},
                        {'key': 'amount', 'label': 'Amount', 'align': 'right', 'money': True}],
                    'rows': rows, 'row_count': nqs.count(), 'total': str(total.quantize(Q2))}

        if kind == 'quantity':
            # ONE ROW PER ITEM (bill line) — mirrors the Sales dispatched drill.
            # A bill with several products lists each on its own row with a CLEAN
            # item label (the product name, or the line's own description when it
            # has no product master), its quantity and unit. Per-item rows are what
            # let the shared drill turn on the "By Item" pivot + Item filter (both
            # key off an 'item' column) and page like Sales, and they show the item
            # NAME instead of "N items". Excludes is_expense to match the card.
            bqs = _bills_base().exclude(is_expense=True)
            lqs = (VendorBillLine.objects.filter(bill__in=bqs, is_active=True)
                   .exclude(uom='').select_related('bill', 'bill__vendor', 'product')
                   .order_by('-bill__bill_date'))
            if product_id:
                lqs = lqs.filter(product_id__in=product_id)
            rows = []
            for l in lqs:
                if len(rows) >= self._CAP:
                    break
                q = l.quantity or _ZERO
                if q == _ZERO:
                    continue
                b = l.bill
                item = ((l.product.product_name if l.product_id else '')
                        or (l.description or '').strip() or '—')
                rows.append({'id': str(b.id),
                             'date': b.bill_date.isoformat() if b.bill_date else None,
                             'bill_no': b.bill_no or '',
                             'vendor': b.vendor.vendor_name if b.vendor_id else '',
                             'item': item,
                             'qty': _qty(q),
                             'uom': _norm_uom(l.uom)})
            return {'columns': [
                        {'key': 'date', 'label': 'Date'},
                        {'key': 'bill_no', 'label': 'Bill No', 'link': 'bill'},
                        {'key': 'vendor', 'label': 'Vendor'},
                        {'key': 'item', 'label': 'Item'},
                        {'key': 'qty', 'label': 'Qty', 'align': 'right'},
                        {'key': 'uom', 'label': 'UOM'}],
                    'rows': rows, 'row_count': len(rows), 'total': None}

        if kind == 'outstanding':
            # Live open balance per bill (total - paid > 0); matches the KPI.
            qs = (PurchaseDashboardView._bill_qs(company_id, vendor_id, product_id, inc)
                  .exclude(status='CANCELLED').select_related('vendor').order_by('-bill_date'))
            total = _ZERO
            rows = []
            for b in qs:
                bal = (b.total_amount or _ZERO) - (b.amount_paid or _ZERO)
                if bal <= 0:
                    continue
                total += bal
                rows.append({'id': str(b.id), 'date': b.bill_date.isoformat() if b.bill_date else None,
                             'bill_no': b.bill_no or b.vendor_invoice_no or '',
                             'vendor': b.vendor.vendor_name if b.vendor_id else '',
                             'total': str((b.total_amount or _ZERO).quantize(Q2)),
                             'paid': str((b.amount_paid or _ZERO).quantize(Q2)),
                             'balance': str(bal.quantize(Q2))})
                if len(rows) >= self._CAP:
                    break
            return {'columns': [
                        {'key': 'date', 'label': 'Date'},
                        {'key': 'bill_no', 'label': 'Bill No', 'link': 'bill'},
                        {'key': 'vendor', 'label': 'Vendor'},
                        {'key': 'total', 'label': 'Total', 'align': 'right', 'money': True},
                        {'key': 'paid', 'label': 'Paid', 'align': 'right', 'money': True},
                        {'key': 'balance', 'label': 'Balance', 'align': 'right', 'money': True}],
                    'rows': rows, 'row_count': len(rows), 'total': str(total.quantize(Q2))}

        raise ValidationError("unknown record type")

    def _payables_monthly(self, company_id, vendor_id=None, product_id=None,
                           start=None, end=None, include_transfers=False):
        """Month-wise payables: bills / paid / partial / open counts + billed + outstanding per month.
        Also returns an `opening` block for bills dated before the period start."""
        from django.db.models.functions import TruncMonth
        from datetime import datetime
        Q2 = Decimal('0.01')
        base_qs = (PurchaseDashboardView._bill_qs(company_id, vendor_id, product_id, include_transfers)
                   .exclude(status='CANCELLED'))

        def _aggregate_qs(qs):
            rows = qs.values('status', 'total_amount', 'amount_paid')
            bucket = {'total': 0, 'paid': 0, 'partial': 0, 'open': 0,
                      'billed': Decimal('0'), 'outstanding': Decimal('0')}
            for r in rows:
                bucket['total'] += 1
                amt = Decimal(str(r['total_amount'] or 0))
                paid = Decimal(str(r['amount_paid'] or 0))
                bucket['billed'] += amt
                bucket['outstanding'] += max(amt - paid, Decimal('0'))
                s = r['status']
                if s == 'PAID':
                    bucket['paid'] += 1
                elif s == 'PARTIALLY_PAID':
                    bucket['partial'] += 1
                else:
                    bucket['open'] += 1
            return bucket

        # Opening block: bills dated before period start, still unpaid
        opening = None
        if start:
            pre_qs = base_qs.filter(bill_date__lt=start).exclude(status__in=BILL_SETTLED_STATUSES)
            if pre_qs.exists():
                b = _aggregate_qs(pre_qs)
                opening = {
                    'total': b['total'],
                    'paid': b['paid'],
                    'partial': b['partial'],
                    'open': b['open'],
                    'billed': str(b['billed'].quantize(Q2)),
                    'outstanding': str(b['outstanding'].quantize(Q2)),
                }

        # Period bills grouped by month
        qs = base_qs
        if start and end:
            qs = qs.filter(bill_date__gte=start, bill_date__lte=end)

        rows_qs = (qs
                   .annotate(month=TruncMonth('bill_date'))
                   .values('month', 'status', 'total_amount', 'amount_paid')
                   .order_by('month'))

        from collections import defaultdict
        buckets = defaultdict(lambda: {'total': 0, 'paid': 0, 'partial': 0, 'open': 0,
                                       'billed': Decimal('0'), 'outstanding': Decimal('0')})
        for r in rows_qs:
            m = r['month'].strftime('%Y-%m') if r['month'] else 'Unknown'
            b = buckets[m]
            b['total'] += 1
            amt = Decimal(str(r['total_amount'] or 0))
            paid = Decimal(str(r['amount_paid'] or 0))
            b['billed'] += amt
            b['outstanding'] += max(amt - paid, Decimal('0'))
            s = r['status']
            if s == 'PAID':
                b['paid'] += 1
            elif s == 'PARTIALLY_PAID':
                b['partial'] += 1
            else:
                b['open'] += 1

        months = []
        for m_key in sorted(buckets.keys()):
            b = buckets[m_key]
            try:
                dt = datetime.strptime(m_key, '%Y-%m')
                label = dt.strftime('%b %Y')
            except Exception:
                label = m_key
            months.append({
                'month': m_key,
                'label': label,
                'total': b['total'],
                'paid': b['paid'],
                'partial': b['partial'],
                'open': b['open'],
                'billed': str(b['billed'].quantize(Q2)),
                'outstanding': str(b['outstanding'].quantize(Q2)),
            })

        total_billed = sum(Decimal(r['billed']) for r in months)
        total_outstanding = sum(Decimal(r['outstanding']) for r in months)
        result = {
            'months': months,
            'total_billed': str(total_billed.quantize(Q2)),
            'total_outstanding': str(total_outstanding.quantize(Q2)),
        }
        if opening:
            result['opening'] = opening
        return result

    def get(self, request, *args, **kwargs):
        kind = (request.query_params.get('type') or '').lower()
        company_id = request.query_params.get('company') or None
        vendor_id = request.query_params.get('vendor') or None
        product_id = resolve_product_filter(request.query_params.get('product'))
        # Mirror the dashboard's own "Purchases / +Transfers" toggle so a
        # drill-down's total doesn't disagree with the KPI card it opened from.
        include_transfers = str(request.query_params.get('include_transfers', '')).lower() in ('1', 'true', 'yes')
        # Optional period window (bills dated in it); default = live/all-time.
        period = (request.query_params.get('period') or 'all').lower()
        start = end = None
        label = 'Live'
        if period and period != 'all':
            start, end, label = PurchaseDashboardView._resolve_range(
                period, request.query_params.get('from'), request.query_params.get('to'))

        if kind == 'payables_buckets':
            data = self._payables_buckets(company_id, vendor_id, product_id, start=start, end=end,
                                          include_transfers=include_transfers)
        elif kind == 'payables_monthly':
            data = self._payables_monthly(company_id, vendor_id, product_id, start=start, end=end,
                                          include_transfers=include_transfers)
        elif kind == 'aging_buckets':
            data = self._aging_buckets(company_id, vendor_id, product_id,
                                       include_transfers=include_transfers)
        elif kind in ('bills', 'payments', 'quantity', 'outstanding',
                      'debit_notes', 'credit_notes', 'payment_account'):
            data = self._records(kind, company_id, vendor_id, product_id, start, end,
                                 include_transfers, account=request.query_params.get('account'))
        else:
            raise ValidationError(
                "type must be one of: payables_buckets, payables_monthly, aging_buckets, bills, payments, quantity, "
                "outstanding, debit_notes, credit_notes, payment_account")

        return Response({'type': kind,
                         'period': {'label': label,
                                    'from': start.isoformat() if start else None,
                                    'to': end.isoformat() if end else None},
                         'include_transfers': include_transfers,
                         **data})


class PurchaseAnalyticsView(APIView):
    """GET /api/purchase/dashboard/analytics/

    Party-wise purchase analytics (the procurement mirror of SalesAnalyticsView):
    top vendors, top products purchased, a rolling 12-month billed-vs-paid trend,
    and exception reports. Shares the period / company / vendor / product filters.
    All money is JSON floats. The MoM trend spans the current financial year.
    """

    permission_classes = [permissions.IsAuthenticated, HasModulePermission]
    module_name = 'Purchase Dashboard'
    # Analytics tab for the same three dashboard-family pages — see
    # PurchaseDashboardView. 'Purchase Analytics' is the natural grant here.
    alternate_modules = ['Purchase Analytics', 'Vendor Insights']

    @staticmethod
    def _bill_qs(company_id, vendor_id, product_id=None):
        # Exclude internal branch transfers (DC/ challans, an is_branch vendor like
        # "SS Biochem - Blre", or BRANCH category) — they're not purchases, same as
        # the main Total-Purchase tile. Without this the dashboard ranked the
        # company's OWN branch as a top supplier and folded transfers into the trend.
        qs = VendorBill.objects.filter(is_active=True, is_expense=False).exclude(
            vendor_invoice_no='OPENING').exclude(tally_guid__startswith='OPENING').exclude(
            status='CANCELLED').exclude(branch_transfer_q())
        if vendor_id:
            qs = qs.filter(vendor_id=vendor_id)
        if company_id:
            qs = qs.filter(
                Q(purchase_order__company_id=company_id)
                | Q(receipt_advice__warehouse__company_id=company_id)
                | Q(vendor__company_id=company_id))
        if product_id:
            # Product filter = bill membership (id__in subquery, so a bill with the
            # product on two lines isn't double-counted in Sum(total_amount)).
            from .models import VendorBillLine
            qs = qs.filter(id__in=VendorBillLine.objects.filter(
                product_id__in=product_id).values('bill_id'))
        return qs

    def _top_vendors(self, start, end, company_id, vendor_id, product_id=None, limit=10):
        qs = self._bill_qs(company_id, vendor_id, product_id).filter(
            bill_date__gte=start, bill_date__lte=end)
        rows = list(
            qs.values('vendor_id', 'vendor__vendor_name')
            .annotate(amount=Sum('total_amount'), bill_count=Count('id', distinct=True))
            .order_by('-amount')[:limit]
        )
        vendors = [
            {
                'vendor_id': str(r['vendor_id']) if r['vendor_id'] else None,
                'vendor_name': r['vendor__vendor_name'] or '(unknown)',
                'bill_count': r['bill_count'],
                'amount': _money(r['amount']),
                'qty_breakdown': [],
            }
            for r in rows
        ]
        # Attach a per-UOM quantity breakdown for the shown vendors. Quantities
        # across unit types (PCS vs KGS) can't be summed into one figure, so we
        # keep them split — same convention as the "Quantity Billed" card. Blank
        # UOMs (synthesised service lines) are skipped.
        ids = [r['vendor_id'] for r in rows if r['vendor_id']]
        if ids:
            from .models import VendorBillLine
            lqs = VendorBillLine.objects.filter(
                bill__vendor_id__in=ids, bill__bill_date__gte=start, bill__bill_date__lte=end,
                bill__is_active=True, is_active=True,
            ).exclude(bill__vendor_invoice_no='OPENING').exclude(
                bill__tally_guid__startswith='OPENING').exclude(
                bill__status='CANCELLED').exclude(uom='')
            if company_id:
                lqs = lqs.filter(
                    Q(bill__purchase_order__company_id=company_id)
                    | Q(bill__receipt_advice__warehouse__company_id=company_id)
                    | Q(bill__vendor__company_id=company_id))
            if product_id:
                lqs = lqs.filter(product_id__in=product_id)
            by_vendor = {}
            for r in (lqs.values('bill__vendor_id', 'uom')
                      .annotate(qty=Sum('quantity')).order_by()):
                q = abs(r['qty'] or _ZERO)
                if q == _ZERO:
                    continue
                by_vendor.setdefault(r['bill__vendor_id'], []).append(
                    {'uom': r['uom'], 'qty': _qty(q)})
            for vendor, r in zip(vendors, rows):
                bd = by_vendor.get(r['vendor_id'], [])
                bd.sort(key=lambda x: x['qty'], reverse=True)
                vendor['qty_breakdown'] = bd
        return vendors

    def _top_products(self, start, end, company_id, vendor_id, product_id, limit=10):
        from .models import VendorBillLine
        qs = VendorBillLine.objects.filter(
            bill__bill_date__gte=start, bill__bill_date__lte=end,
            bill__is_active=True, is_active=True,
        ).exclude(bill__vendor_invoice_no='OPENING').exclude(
            bill__tally_guid__startswith='OPENING').exclude(bill__status='CANCELLED').exclude(
            # Same branch-transfer exclusion as _bill_qs, prefixed to the bill, so
            # an internal-transfer line never ranks as a top product.
            Q(bill__vendor_invoice_no__istartswith='DC/')
            | Q(bill__vendor__is_branch=True)
            | Q(bill__purchase_category='BRANCH'))
        qs = qs.filter(product__isnull=False)   # real products only (skip service lines)
        if vendor_id:
            qs = qs.filter(bill__vendor_id=vendor_id)
        if company_id:
            qs = qs.filter(
                Q(bill__purchase_order__company_id=company_id)
                | Q(bill__receipt_advice__warehouse__company_id=company_id)
                | Q(bill__vendor__company_id=company_id))
        if product_id:
            qs = qs.filter(product_id__in=product_id)
        # Group by product AND uom so a product's quantity stays split per unit
        # type (PCS vs KGS can't be added). Bill-line amounts SHOULD be negative
        # (purchase sign convention), but the sign is NOT consistent across entry
        # paths — big RM/Packing lines come in POSITIVE while machine-spare lines are
        # negative. Ranking by "most negative" therefore buried all the RM/PM value
        # and surfaced only the few negative spares. We rank by MAGNITUDE (|amount|)
        # instead, and display the absolute value — so the largest purchases win
        # regardless of sign.
        rows = (
            qs.values('product_id', 'product__product_name', 'uom')
            .annotate(qty=Sum('quantity'), amount=Sum('amount'))
            .order_by()
        )
        # Group by a NORMALISED English name so the same raw material under several
        # spellings (neem seed/fruit; Tamil/Hindi names) counts as ONE product — the
        # top-N isn't filled by duplicates and reads in English. Mirrors the frontend
        # utils/itemName.js. PROCESSED neem (oil/cake/extract/azadirachtin) stays its
        # own product.
        import re
        _neem = re.compile(r'neem|limbod|limdi|limbd', re.I)
        _neem_s = re.compile(r'வேப்ப|வேம்ப|நீம|नीम|लिंब')
        _proc = re.compile(r'\boil\b|cake|de-?oil|deoil|concentrat|extract|azadiracht|technical|powder', re.I)

        def _display(nm):
            s = (nm or '').strip()
            if not (_neem.search(s) or _neem_s.search(s)):
                return s or '(unknown)'
            return s if _proc.search(s) else 'Neem Seed / Fruit'

        agg = {}
        for r in rows:
            name = _display(r['product__product_name'])
            amt = r['amount'] or _ZERO
            e = agg.setdefault(name, {
                'product_id': str(r['product_id']) if r['product_id'] else None,
                'product_name': name,
                'amount': _ZERO, 'uoms': {}, '_pidamt': _ZERO,
            })
            e['amount'] += amt
            # keep the biggest single product's id as the merged group's drill target
            if abs(amt) > e['_pidamt']:
                e['_pidamt'] = abs(amt)
                e['product_id'] = str(r['product_id']) if r['product_id'] else None
            u = (r['uom'] or '').strip()
            if u:
                e['uoms'][u] = e['uoms'].get(u, _ZERO) + abs(r['qty'] or _ZERO)
        items = sorted(agg.values(), key=lambda x: abs(x['amount']), reverse=True)[:limit]
        out = []
        for e in items:
            bd = sorted(
                [{'uom': u, 'qty': _qty(q)} for u, q in e['uoms'].items() if q != _ZERO],
                key=lambda x: x['qty'], reverse=True)
            out.append({
                'product_id': e['product_id'],
                'product_name': e['product_name'],
                'qty': _qty(sum(e['uoms'].values(), _ZERO)),
                'qty_breakdown': bd,
                'amount': _money(abs(e['amount'] or _ZERO)),
            })
        return out

    def _mom_trend(self, company_id, vendor_id, product_id=None, months=12):
        from django.db.models.functions import TruncMonth
        today = timezone.localdate()
        first_of_this = today.replace(day=1)
        fy_start_year = today.year if today.month >= 4 else today.year - 1
        start_month = first_of_this.replace(year=fy_start_year, month=4)
        n_months = ((first_of_this.year - start_month.year) * 12
                    + (first_of_this.month - start_month.month) + 1)

        keys = []
        yy, mm = start_month.year, start_month.month
        for _ in range(n_months):
            keys.append('{:04d}-{:02d}'.format(yy, mm))
            mm += 1
            if mm == 13:
                mm = 1
                yy += 1
        buckets = {k: {'billed': _ZERO, 'paid': _ZERO} for k in keys}

        billed = self._bill_qs(company_id, vendor_id, product_id).filter(bill_date__gte=start_month)
        for r in (billed.annotate(mth=TruncMonth('bill_date')).values('mth')
                  .annotate(t=Sum('total_amount')).order_by('mth')):
            if not r['mth']:
                continue
            k = r['mth'].strftime('%Y-%m')
            if k in buckets:
                buckets[k]['billed'] = r['t'] or _ZERO

        paid = (PaymentMade.objects.filter(payment_date__gte=start_month, is_active=True)
                .exclude(status='CANCELLED').exclude(is_transfer=True))
        if vendor_id:
            paid = paid.filter(vendor_id=vendor_id)
        if company_id:
            # Filter by the payment's OWN vendor company, NOT via its bill: an
            # on-account advance has no bill, so the bill-based filter silently
            # dropped it and understated the Paid line (e.g. big Sperrholz advances).
            # vendor is a non-null FK, so this is complete. Mirrors _vendor_breakdown.
            paid = paid.filter(vendor__company_id=company_id)
        if product_id:
            from .models import VendorBillLine
            paid = paid.filter(bill_id__in=VendorBillLine.objects.filter(
                product_id__in=product_id).values('bill_id'))
        for r in (paid.annotate(mth=TruncMonth('payment_date')).values('mth')
                  .annotate(t=Sum('amount')).order_by('mth')):
            if not r['mth']:
                continue
            k = r['mth'].strftime('%Y-%m')
            if k in buckets:
                buckets[k]['paid'] = r['t'] or _ZERO

        month_labels = {1: 'Jan', 2: 'Feb', 3: 'Mar', 4: 'Apr', 5: 'May', 6: 'Jun',
                        7: 'Jul', 8: 'Aug', 9: 'Sep', 10: 'Oct', 11: 'Nov', 12: 'Dec'}
        out = []
        for k in keys:
            yr, mo = k.split('-')
            out.append({
                'month': k,
                'label': '{} {}'.format(month_labels[int(mo)], yr),
                'billed': _money(buckets[k]['billed']),
                'paid': _money(buckets[k]['paid']),
            })
        return out

    def _exceptions(self, start, end, company_id, vendor_id, product_id=None):
        from django.db.models import Max
        from sales.models import DebitNote
        today = timezone.localdate()
        cutoff_90 = today - timedelta(days=90)

        led = self._bill_qs(company_id, vendor_id, product_id).exclude(status__in=BILL_SETTLED_STATUSES)
        # Pre-anchor bills are Tally's domain. The team keyed the ERP only from the
        # opening month, so pre-opening payments were never recorded here and those
        # bills read FALSELY overdue (a bill paid in Tally in April showing 210d late).
        # Drop each company's bills dated before ITS Tally opening (VendorOpeningBalance)
        # — their net payable already sits in that opening, like the Payables Overview.
        # Works for a SINGLE company AND the all-companies view (different companies may
        # have different opening dates, so it's a per-company exclude, not one global cut).
        from .models import VendorOpeningBalance
        if company_id:
            _anchor = (VendorOpeningBalance.objects.filter(company_id=company_id)
                       .order_by('-as_of_date').values_list('as_of_date', flat=True).first())
            if _anchor:
                led = led.filter(bill_date__gte=_anchor)
        else:
            from django.db.models import Max, Q as _Q
            _excl = _Q()
            for _row in VendorOpeningBalance.objects.values('company_id').annotate(_a=Max('as_of_date')):
                if _row['_a']:
                    _excl |= _Q(vendor__company_id=_row['company_id'], bill_date__lt=_row['_a'])
            if _excl:
                led = led.exclude(_excl)
        # Overdue = money STILL OWED past its due date, so the balance decides.
        #
        # This used to test the status alone, and status is a weaker signal than
        # it looks: a bill only becomes PAID when something walks the payment
        # path (apply_payment_to_bill, the Tally payment import, the advance
        # applier). A bill that reaches a nil balance any other way — imported
        # at zero value, settled by journal rather than against the bill, or
        # written back by one of the older repair commands — keeps whatever
        # status it had. It was then listed as overdue while the Balance column
        # beside it, computed independently as total_amount - amount_paid,
        # honestly read 0.00. The row contradicted itself on screen.
        #
        # It also made the two headline figures disagree: the COUNT included
        # those rows, while the AMOUNT (Sum of balance) did not — so "521 bills,
        # Rs 17.71 Cr" was not 521 bills' worth of money.
        #
        # Sales has always read it this way (ReceivableLedger: due_date < today
        # AND balance > 0), as does the Zoho-shaped payables view. Purchase was
        # the odd one out.
        overdue = led.annotate(_bal=_BILL_BALANCE).filter(due_date__lt=today, _bal__gt=0)
        o = overdue.aggregate(c=Count('id', distinct=True), s=Sum(_BILL_BALANCE))
        severe = overdue.filter(due_date__lt=cutoff_90)
        sv = severe.aggregate(c=Count('id', distinct=True), s=Sum(_BILL_BALANCE))

        overdue_rows = []
        for b in (overdue.select_related('vendor').order_by('due_date')[:10]):
            days = (today - b.due_date).days if b.due_date else None
            overdue_rows.append({
                # The bill itself is in hand; without its id the row is a dead
                # end on the one screen that is telling you to go chase it.
                'bill_id': str(b.id),
                'bill_no': b.bill_no or '-',
                'bill_date': b.bill_date.isoformat() if b.bill_date else None,
                'vendor_name': b.vendor.vendor_name if b.vendor_id else '(unknown)',
                'due_date': b.due_date.isoformat() if b.due_date else None,
                'days_overdue': days,
                'balance': _money((b.total_amount or _ZERO) - (b.amount_paid or _ZERO)),
            })

        # Purchase returns = purchase-side debit notes we raise on the vendor.
        dn = DebitNote.objects.filter(side='PURCHASE', note_type='DEBIT', is_active=True,
                                      note_date__gte=start, note_date__lte=end)
        if company_id:
            dn = dn.filter(company_id=company_id)
        if vendor_id:
            dn = dn.filter(vendor_id=vendor_id)
        d = dn.aggregate(c=Count('id'), s=Sum('amount'))

        drafts = self._bill_qs(company_id, vendor_id, product_id).filter(
            bill_date__gte=start, bill_date__lte=end, status='DRAFT')
        dr = drafts.aggregate(c=Count('id'), s=Sum('total_amount'))

        allbills = self._bill_qs(company_id, vendor_id, product_id)
        dormant_qs = (
            allbills.values('vendor_id', 'vendor__vendor_name')
            .annotate(last_bill=Max('bill_date'), bill_count=Count('id'))
            .filter(last_bill__lt=cutoff_90)
            .order_by('last_bill')
        )
        dormant_rows = [
            {
                'vendor_id': str(r['vendor_id']) if r['vendor_id'] else None,
                'vendor_name': r['vendor__vendor_name'] or '(unknown)',
                'last_bill': r['last_bill'].isoformat() if r['last_bill'] else None,
                'bill_count': r['bill_count'],
            }
            for r in dormant_qs[:10]
        ]
        dormant_total = dormant_qs.count()

        return {
            'overdue': {'count': o['c'] or 0, 'amount': _money(o['s'])},
            'severely_overdue': {'count': sv['c'] or 0, 'amount': _money(sv['s'])},
            'overdue_rows': overdue_rows,
            'returns': {'count': d['c'] or 0, 'amount': _money(d['s'])},
            'draft_bills': {'count': dr['c'] or 0, 'amount': _money(dr['s'])},
            'dormant_vendors': {'count': dormant_total, 'rows': dormant_rows},
        }

    def get(self, request, *args, **kwargs):
        period = (request.query_params.get('period') or 'month').lower()
        frm = request.query_params.get('from')
        to = request.query_params.get('to')
        company_id = request.query_params.get('company') or None
        vendor_id = request.query_params.get('vendor') or None
        product_id = resolve_product_filter(request.query_params.get('product'))

        start, end, label = PurchaseDashboardView._resolve_range(period, frm, to)

        return Response({
            'period': {'label': label, 'from': start.isoformat(), 'to': end.isoformat()},
            'company_id': company_id,
            'vendor_id': vendor_id,
            'product_id': product_id,
            'top_vendors': self._top_vendors(start, end, company_id, vendor_id, product_id),
            'top_products': self._top_products(start, end, company_id, vendor_id, product_id),
            'mom_trend': self._mom_trend(company_id, vendor_id, product_id),
            'exceptions': self._exceptions(start, end, company_id, vendor_id, product_id),
        })


def _month_iter(start, end):
    """Yield (ym_label, month_start, month_end) for every calendar month that
    the [start, end] window touches, clipped to the window at both ends."""
    cur = date(start.year, start.month, 1)
    while cur <= end:
        # last day of this month
        nxt = date(cur.year + 1, 1, 1) if cur.month == 12 else date(cur.year, cur.month + 1, 1)
        m_end = nxt - timedelta(days=1)
        yield (
            cur.strftime('%Y-%m'),
            max(cur, start),
            min(m_end, end),
        )
        cur = nxt


class PurchaseMonthlyBreakdownView(APIView):
    """GET /api/purchase/monthly-breakdown/?company=&from=&to=&vendor=

    Per-calendar-month purchase turnover breakdown (the procurement mirror of
    the Sales "Monthly Turnover Breakdown" + "Detailed figures" tables):

        Purchases (ex-GST taxable)  +  Debit Notes (returns)
          − Credit Notes (vendor credits)  =  Net
        plus, reported separately (already excluded from Purchases above):
          Branch Transfers · Freight / Charges

    Every figure reuses the exact querysets behind the Total-Purchase tile
    (PurchaseDashboardView._total_purchase), so the monthly numbers reconcile
    with the dashboard. All values are EXACT (paise), for Tally verification.
    """

    permission_classes = [permissions.IsAuthenticated, HasModulePermission]
    module_name = 'Purchase Dashboard'
    alternate_modules = ['Purchase Analytics', 'Vendor Insights']

    @staticmethod
    def _purchases_taxable(start, end, company_id, vendor_id, dup_cache):
        """Ex-GST taxable purchases for [start, end] — the same scope as
        _total_purchase's `taxable` (RM+Packing purchases, charges included,
        OPENING/CANCELLED/expense-like/journal excluded, dups removed)."""
        bqs = (PurchaseDashboardView._bill_qs(company_id, vendor_id)
               .filter(bill_date__gte=start, bill_date__lte=end)
               .exclude(tally_guid__startswith='OPENING')
               .exclude(status='CANCELLED')
               .exclude(is_expense=True)
               .exclude(purchase_category__in=_EXPENSE_CATS)
               .exclude(tally_voucher_type__icontains='journal'))
        dups = _cached_dup_bill_ids(bqs, dup_cache)
        if dups:
            bqs = bqs.exclude(id__in=dups)
        agg = bqs.aggregate(sub=Sum('subtotal'), oc=Sum('other_charges'))
        return (agg['sub'] or _ZERO), (agg['oc'] or _ZERO)   # (taxable, on-bill charges/freight)

    @staticmethod
    def _notes(start, end, company_id, vendor_id, note_type):
        """Purchase-side DebitNote total for the month. note_type 'DEBIT' =
        returns (reduce purchases), 'CREDIT' = vendor credits. Same ledger /
        tally_group filter the Total-Purchase tile uses."""
        from sales.models import DebitNote
        q = DebitNote.objects.filter(is_active=True, side='PURCHASE', note_type=note_type,
                                     note_date__gte=start, note_date__lte=end)
        if company_id:
            q = q.filter(company_id=company_id)
        if vendor_id:
            q = q.filter(vendor_id=vendor_id)
        if note_type == 'DEBIT':
            # Only notes booked on a PURCHASE ledger are goods returns (mirrors
            # _total_purchase); a note on another ledger is a price adjustment.
            q = q.exclude(Q(tally_group__regex=r'\S') & ~Q(tally_group__icontains='purchase'))
        return q.aggregate(t=Sum('amount'))['t'] or _ZERO

    @staticmethod
    def _branch(start, end, company_id, vendor_id, dup_cache):
        """Branch-transfer value for the month — the same signal as the
        Total-Purchase tile's Branch scope (branch_transfer_q over a
        transfers-included base, OPENING/CANCELLED/is_expense/dups treated the
        same). Reported as 'already excluded from Purchases above'."""
        base = (PurchaseDashboardView._bill_qs(company_id, vendor_id, include_transfers=True)
                .filter(bill_date__gte=start, bill_date__lte=end)
                .exclude(tally_guid__startswith='OPENING')
                .exclude(status='CANCELLED')
                .exclude(is_expense=True))
        base = base.exclude(id__in=_cached_dup_bill_ids(base, dup_cache))
        return base.filter(branch_transfer_q()).aggregate(t=Sum('subtotal'))['t'] or _ZERO

    def get(self, request, *args, **kwargs):
        frm = request.query_params.get('from')
        to = request.query_params.get('to')
        company_id = request.query_params.get('company') or None
        vendor_id = request.query_params.get('vendor') or None
        # Reuse the shared range resolver (custom window, capped & ordered).
        start, end, label = PurchaseDashboardView._resolve_range('custom', frm, to)

        dup_cache = {}
        months = []
        keys = ('purchases', 'debit_notes', 'credit_notes', 'net', 'branch_transfers', 'freight')
        rows = {k: {'total': _ZERO} for k in keys}

        for ym, m_start, m_end in _month_iter(start, end):
            months.append({'month': ym, 'label': '{:%b %Y}'.format(m_start)})
            taxable, charges = self._purchases_taxable(m_start, m_end, company_id, vendor_id, dup_cache)
            dn = self._notes(m_start, m_end, company_id, vendor_id, 'DEBIT')      # returns
            cn = self._notes(m_start, m_end, company_id, vendor_id, 'CREDIT')     # vendor credits
            branch = self._branch(m_start, m_end, company_id, vendor_id, dup_cache)
            net = taxable + dn - cn
            per = {
                'purchases': taxable, 'debit_notes': dn, 'credit_notes': cn,
                'net': net, 'branch_transfers': branch, 'freight': charges,
            }
            for k, v in per.items():
                rows[k][ym] = _money(v)
                rows[k]['total'] += (v or _ZERO)

        for k in keys:
            rows[k]['total'] = _money(rows[k]['total'])

        return Response({
            'period': {'label': label, 'from': start.isoformat(), 'to': end.isoformat()},
            'company_id': company_id,
            'vendor_id': vendor_id,
            'months': months,
            'rows': rows,
        })


class PurchaseBranchTransfersView(APIView):
    """GET /api/purchase/branch-transfers/?company=&from=&to=

    Internal branch-transfer bills (the procurement mirror of the Sales
    "Branch Transfers" page): bills that branch_transfer_q() matches — a
    "DC/"-prefixed invoice no, a vendor flagged is_branch, or a bill the
    operator tagged purchase_category='BRANCH'. These are stock movements
    between the company's own branches, EXCLUDED from Purchases, so this
    gives them their own view: a per-branch x month summary + the bill list.

    Uses the same branch scope as the Total-Purchase tile / monthly-breakdown
    (transfers-included base, OPENING/CANCELLED/is_expense/dups removed, then
    branch_transfer_q()), so the figures reconcile.
    """
    permission_classes = [permissions.IsAuthenticated, HasModulePermission]
    module_name = 'Purchase Dashboard'
    alternate_modules = ['Purchase Analytics', 'Vendor Insights']

    def get(self, request, *args, **kwargs):
        frm = request.query_params.get('from')
        to = request.query_params.get('to')
        company_id = request.query_params.get('company') or None
        start, end, label = PurchaseDashboardView._resolve_range('custom', frm, to)

        base = (PurchaseDashboardView._bill_qs(company_id, None, include_transfers=True)
                .filter(bill_date__gte=start, bill_date__lte=end)
                .exclude(tally_guid__startswith='OPENING')
                .exclude(status='CANCELLED')
                .exclude(is_expense=True))
        base = base.exclude(id__in=_cached_dup_bill_ids(base))
        qs = (base.filter(branch_transfer_q())
              .select_related('vendor')
              .order_by('-bill_date'))

        months = [{'month': ym, 'label': '{:%b %Y}'.format(m_start)}
                  for ym, m_start, _m_end in _month_iter(start, end)]

        # Per-branch (vendor) x month taxable (ex-GST) value, + the bill list.
        branch_acc = {}   # vendor_name -> {'vendor_id', 'by_month': {ym: val}}
        bills = []
        total = _ZERO
        for bill in qs:
            vname = bill.vendor.vendor_name if bill.vendor_id else '—'
            ym = bill.bill_date.strftime('%Y-%m') if bill.bill_date else None
            sub = Decimal(str(bill.subtotal or 0))
            tot = Decimal(str(bill.total_amount or 0))
            total += sub
            b = branch_acc.setdefault(vname, {
                'branch': vname,
                'vendor_id': str(bill.vendor_id) if bill.vendor_id else None,
                'by_month': {},
            })
            if ym:
                b['by_month'][ym] = b['by_month'].get(ym, _ZERO) + sub
            bills.append({
                'bill_id': str(bill.id),
                'bill_no': bill.bill_no or bill.vendor_invoice_no or '',
                'bill_date': bill.bill_date.isoformat() if bill.bill_date else None,
                'branch': vname,
                'taxable': _money(sub),
                'total': _money(tot),
            })

        branches = []
        for b in branch_acc.values():
            row_total = sum(b['by_month'].values(), _ZERO)
            by_month = {ym: _money(b['by_month'].get(ym, _ZERO)) for ym in (m['month'] for m in months)}
            by_month['total'] = _money(row_total)
            branches.append({'branch': b['branch'], 'vendor_id': b['vendor_id'], 'by_month': by_month})
        branches.sort(key=lambda r: r['by_month']['total'], reverse=True)

        company_pan = ''
        if company_id:
            from core.models import Company
            company_pan = (Company.objects.filter(id=company_id)
                           .values_list('pan', flat=True).first()) or ''

        return Response({
            'period': {'label': label, 'from': start.isoformat(), 'to': end.isoformat()},
            'company_id': company_id,
            'total': _money(total),
            'branch_count': len(branch_acc),
            'company_pan': company_pan,
            'months': months,
            'branches': branches,
            'bills': bills,
        })


class PurchaseImportReconcileView(APIView):
    """Date-wise import reconciliation for purchases (Purchase Analytics footer).

    GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&company=<uuid>&tally_company=&tally=0|1

    One row per date:
      - erp_count / erp_amount   -> from the REAL VendorBills (bill_date), so it
                                    reflects what's actually imported, not a log.
      - tally_count / tally_amount (only when tally=1) -> the purchase vouchers
                                    Tally holds for that date. On the cloud this
                                    goes through the connector (TallyPending ->
                                    202, the client retries — same as import).
      - gap_count / gap_amount   -> Tally minus ERP: what's still to import.

    The ERP side is instant (DB); the Tally side is opt-in (tally=1) because it
    hits Tally. Lets the operator clear the backlog one day at a time.
    """
    permission_classes = [permissions.IsAuthenticated, HasModulePermission]
    module_name = 'Vendor Bill'

    def dispatch(self, request, *args, **kwargs):
        # Connector mode: a Tally read was parked for the on-prem connector and
        # isn't back yet -> tell the client to retry (202), same as the import.
        from sales.tally_sync import TallyPending
        try:
            return super().dispatch(request, *args, **kwargs)
        except TallyPending:
            resp = Response({'queued': True, 'connector': True,
                             'detail': 'Waiting for your office Tally via the connector…'},
                            status=202)
            return self.finalize_response(self.request, resp, *args, **kwargs)

    def get(self, request):
        from core.models import Company
        p = request.query_params
        today = timezone.now().date()
        try:
            start = datetime.strptime(p.get('from'), '%Y-%m-%d').date()
            end = datetime.strptime(p.get('to'), '%Y-%m-%d').date()
        except (ValueError, TypeError):
            # Tolerant default: current financial year (Apr 1) -> today, so a
            # missing/garbled range never 400s the reconciliation.
            fy = today.year if today.month >= 4 else today.year - 1
            start, end = datetime(fy, 4, 1).date(), today
        company_id = p.get('company') or None
        want_tally = str(p.get('tally', '0')).lower() in ('1', 'true', 'yes')

        # ERP side (always) — the actual bills, grouped by their bill_date.
        bqs = (PurchaseDashboardView._bill_qs(company_id, None)
               .filter(bill_date__gte=start, bill_date__lte=end)
               .exclude(tally_guid__startswith='OPENING'))
        erp = {}
        for r in bqs.values('bill_date').annotate(c=Count('id'), a=Sum('total_amount')):
            erp[r['bill_date']] = {'count': r['c'], 'amount': r['a'] or Decimal('0')}

        tally = {}
        if want_tally:
            from sales.tally_import import classify
            from sales.tally_daybook import fetch_vouchers_daybook
            from sales.tally_import_run import _split_ledgers
            company = Company.objects.filter(id=company_id).first() if company_id else None
            tally_company = p.get('tally_company') or (getattr(company, 'legal_name', '') if company else '')
            try:
                # Chunked Day-Book reader, not fetch_vouchers — see the note in
                # sales.tally_import_views. The raw Voucher collection ignores
                # the date range, returns the WHOLE company, and kills Tally
                # with c0000005, which is what takes port 9000 down mid-import.
                vouchers, _ = fetch_vouchers_daybook(start, end, tally_company)
            except Exception as e:  # noqa: BLE001 — TallyPending re-raises past this
                from sales.tally_sync import TallyPending
                if isinstance(e, TallyPending):
                    raise
                return Response(
                    {'detail': f'Could not reach Tally: {e}. Open Tally, load the '
                               'company, and enable the gateway on port 9000.'},
                    status=502)
            for v in vouchers:
                if classify(v.get('vtype')) != 'purchase':
                    continue
                d = v.get('date')
                if not d or not (start <= d <= end):
                    continue
                party, taxable, cgst, sgst, igst, tds = _split_ledgers(v)
                grand = abs(party) or (taxable + cgst + sgst + igst - tds)
                slot = tally.setdefault(d, {'count': 0, 'amount': Decimal('0')})
                slot['count'] += 1
                slot['amount'] += abs(grand)

        rows = []
        for d in sorted(set(erp) | set(tally)):
            e = erp.get(d, {'count': 0, 'amount': Decimal('0')})
            t = tally.get(d, {'count': 0, 'amount': Decimal('0')})
            rows.append({
                'date': d.isoformat(),
                'erp_count': e['count'],
                'erp_amount': _money(e['amount']),
                'tally_count': t['count'] if want_tally else None,
                'tally_amount': _money(t['amount']) if want_tally else None,
                'gap_count': (t['count'] - e['count']) if want_tally else None,
                'gap_amount': _money(t['amount'] - e['amount']) if want_tally else None,
            })
        totals = {
            'erp_count': sum(r['erp_count'] for r in rows),
            'tally_count': sum((r['tally_count'] or 0) for r in rows) if want_tally else None,
        }
        return Response({'rows': rows, 'has_tally': want_tally, 'totals': totals})


class PurchaseImportReconcileFileView(APIView):
    """OFFLINE date + voucher-type reconciliation from an uploaded Tally register
    export (e.g. SS_Purchase Register.xml) — no live Tally / connector needed.

    POST multipart: file=<xml>, company=<uuid?>
    Parses the file, compares it against the actual Bills per (date, voucher
    type), and returns the gap. Also BACKFILLS tally_voucher_type onto any bill
    whose tally_guid matches a file voucher, so the Bills side splits by type.
    """
    permission_classes = [permissions.IsAuthenticated, HasModulePermission]
    module_name = 'Vendor Bill'
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        from .tally_register import parse_register_file
        f = request.FILES.get('file')
        if not f:
            raise ValidationError('Upload a Tally register XML file (field "file").')
        company_id = request.data.get('company') or None

        vouchers = [v for v in parse_register_file(f.read()) if v.get('date')]
        if not vouchers:
            return Response({'detail': 'No vouchers found — is this a Tally voucher '
                                       'export (Import Data / All Masters)?'}, status=400)

        # Tally side (the file): per (date, voucher type), keeping each voucher's
        # MATCH KEY so we can reconcile bill-by-bill, not just by count.
        #   GST Purchase / GST Purchase-Fruit -> supplier invoice number (ref)
        #   Purchase-Bought Note             -> its own BNP voucher number
        # ref is blank for bought notes, so (ref or number) yields the correct
        # key for every type — the same value the importer stores in
        # vendor_invoice_no, so it lines up with a bill.
        tally = {}
        for v in vouchers:
            slot = tally.setdefault((v['date'], v['vtype'] or '(no type)'),
                                    {'count': 0, 'amount': Decimal('0'), 'items': []})
            slot['count'] += 1
            slot['amount'] += (v['amount'] or Decimal('0'))
            slot['items'].append({
                'ref': (v.get('ref') or '').strip().lower(),        # supplier invoice no (GST types)
                'ref_disp': (v.get('ref') or '').strip(),
                'number': (v.get('number') or '').strip(),          # Tally voucher no (BNP for bought notes)
                'party': (v.get('party') or '').strip(),
                'amount': v.get('amount') or Decimal('0'),
            })
        fdates = [v['date'] for v in vouchers]
        start, end = min(fdates), max(fdates)

        # Backfill the voucher type onto matching bills (by Tally GUID), so the
        # Bills side can be grouped by type too. Cheap — only bills we actually
        # have for these GUIDs are touched.
        guid_type = {v['guid']: v['vtype'] for v in vouchers if v.get('guid')}
        backfilled = 0
        if guid_type:
            for b in (VendorBill.objects
                      .filter(tally_guid__in=list(guid_type.keys()))
                      .exclude(tally_guid='')
                      .only('id', 'tally_guid', 'tally_voucher_type')):
                vt = guid_type.get(b.tally_guid)
                if vt and b.tally_voucher_type != vt:
                    b.tally_voucher_type = vt
                    b.save(update_fields=['tally_voucher_type'])
                    backfilled += 1

        # Every identifier we already hold for this company (ANY date) — BOTH the
        # supplier invoice no (vendor_invoice_no) AND the Tally voucher no
        # (bill_no). A file voucher counts as "imported" if EITHER its supplier
        # invoice no (GST) OR its voucher no (BNP for bought notes, or older GST
        # bills that stored the voucher no) is here. Covers old + new bills with
        # no data rewrite, even when the ERP bill's date differs from Tally's.
        erp_keys = set()
        for inv, bno in (PurchaseDashboardView._bill_qs(company_id, None)
                         .exclude(tally_guid__startswith='OPENING')
                         .values_list('vendor_invoice_no', 'bill_no')):
            for k in ((inv or '').strip().lower(), (bno or '').strip().lower()):
                if k:
                    erp_keys.add(k)

        # Reverse: every key the FILE holds — so a Bill can be flagged EXTRA (it's
        # in the ERP but not in this Tally register).
        tally_keys = set()
        for v in vouchers:
            for k in ((v.get('ref') or '').strip().lower(), (v.get('number') or '').strip().lower()):
                if k:
                    tally_keys.add(k)

        # ERP side (real bills) over the file's date span: per (date, type) counts,
        # plus the EXTRA bills (dated here, not found in the file).
        bqs = (PurchaseDashboardView._bill_qs(company_id, None)
               .filter(bill_date__gte=start, bill_date__lte=end)
               .exclude(tally_guid__startswith='OPENING'))
        erp = {}
        for b in bqs.values('bill_date', 'tally_voucher_type', 'total_amount',
                            'vendor_invoice_no', 'bill_no', 'vendor__vendor_name'):
            key = (b['bill_date'], b['tally_voucher_type'] or '(no type)')
            slot = erp.setdefault(key, {'count': 0, 'amount': Decimal('0'), 'extra_items': []})
            slot['count'] += 1
            slot['amount'] += (b['total_amount'] or Decimal('0'))
            binv = (b['vendor_invoice_no'] or '').strip().lower()
            bno = (b['bill_no'] or '').strip().lower()
            if not ((binv and binv in tally_keys) or (bno and bno in tally_keys)):
                slot['extra_items'].append({
                    'number': b['bill_no'] or b['vendor_invoice_no'] or '',
                    'invoice_no': b['vendor_invoice_no'] or '',
                    'party': b['vendor__vendor_name'] or '',
                    'amount': _money(b['total_amount'] or 0),
                    'status': 'extra',
                })

        def _matched(it):
            return bool((it['ref'] and it['ref'] in erp_keys)
                        or (it['number'] and it['number'].lower() in erp_keys))

        types = sorted({k[1] for k in tally} | {k[1] for k in erp})
        rows = []
        for (d, vt) in sorted(set(tally) | set(erp)):
            t = tally.get((d, vt), {'count': 0, 'amount': Decimal('0'), 'items': []})
            e = erp.get((d, vt), {'count': 0, 'amount': Decimal('0'), 'extra_items': []})
            # Per-voucher detail: Tally vouchers (matched / missing) + ERP bills
            # that are EXTRA (in Bills, not in the file). Missing & extra float up.
            tally_items = [
                {'number': it['number'] or it['ref_disp'], 'invoice_no': it['ref_disp'],
                 'party': it['party'], 'amount': _money(it['amount']),
                 'status': 'matched' if _matched(it) else 'missing'}
                for it in t['items']]
            missing_n = sum(1 for it in tally_items if it['status'] == 'missing')
            extra_n = len(e['extra_items'])
            order = {'missing': 0, 'extra': 1, 'matched': 2}
            items = sorted(tally_items + e['extra_items'],
                           key=lambda x: (order.get(x['status'], 3), x['number']))
            rows.append({
                'date': d.isoformat(),
                'vtype': vt,
                'tally_count': t['count'], 'tally_amount': _money(t['amount']),
                'erp_count': e['count'], 'erp_amount': _money(e['amount']),
                # matched = Tally voucher found in Bills; missing = not in Bills;
                # extra = Bill here that's not in the Tally file.
                'matched_count': len(tally_items) - missing_n,
                'missing_count': missing_n,
                'extra_count': extra_n,
                'items': items,
                'gap_amount': _money(t['amount'] - e['amount']),
            })
        return Response({
            'rows': rows, 'types': types,
            'from': start.isoformat(), 'to': end.isoformat(),
            'backfilled': backfilled,
            'totals': {
                'tally_count': sum(r['tally_count'] for r in rows),
                'erp_count': sum(r['erp_count'] for r in rows),
                'missing_count': sum(r['missing_count'] for r in rows),
                'extra_count': sum(r['extra_count'] for r in rows),
            },
        })


class PaidByCategoryView(APIView):
    """GET /api/purchase/dashboard/paid-by-category/?period=...&company=...

    The ACTUAL cash paid (PaymentMade.amount) in the window, grouped into the
    three analytics buckets by the SAME category resolution the Payment Entries
    hub uses (linked bill's purchase_category -> vendor's usual category ->
    vendor_type), so each analytics page can show its own slice of real cash:

        PURCHASE : RM / MAIZE / BOUGHT_NOTE / PACKING / FRUIT
        FREIGHT  : freight / transporter payments
        EXPENSE  : expense / machinery / lab / contractor / employee / wages
        OTHER    : unresolved (shown to no page; kept so buckets sum to total)

    This is the money-that-MOVED measure (like the Purchase dashboard's
    payments-by-category split), not bill.amount_paid — so Purchase + Freight +
    Expense here add up to the Payment Entries total for the period.
    """
    permission_classes = [permissions.IsAuthenticated, HasModulePermission]
    module_name = 'Purchase Dashboard'

    # Values that belong to each analytics page. Covers BOTH vocabularies:
    # bill.purchase_category (RM/MAIZE/PACKING/...) AND vendor_type
    # (RAW_MATERIAL/PACKING_MATERIAL/MATERIAL/TRANSPORTER/...), because the
    # on-account fallback reads vendor_type, which uses the longer codes.
    _PURCHASE_CATS = {'RM', 'RAW_MATERIAL', 'MATERIAL', 'PURCHASE',
                      'MAIZE', 'BOUGHT_NOTE',
                      'PACKING', 'PACKING_MATERIAL', 'FRUIT'}
    _FREIGHT_CATS = {'FREIGHT', 'TRANSPORT', 'TRANSPORTER'}
    _EXPENSE_CATS = {'EXPENSES', 'EXPENSE', 'MACHINERY', 'LAB_EXPENSE',
                     'CONTRACTOR', 'EMPLOYEE', 'WAGES'}

    @classmethod
    def _page_for(cls, cat):
        c = (cat or '').strip().upper()
        if c in cls._PURCHASE_CATS:
            return 'PURCHASE'
        if c in cls._FREIGHT_CATS:
            return 'FREIGHT'
        if c in cls._EXPENSE_CATS:
            return 'EXPENSE'
        return 'OTHER'

    def get(self, request, *args, **kwargs):
        from .models import PaymentMade
        period = (request.query_params.get('period') or 'month').lower()
        frm = request.query_params.get('from')
        to = request.query_params.get('to')
        company_id = request.query_params.get('company') or None

        # 'all' = no window (every payment). _resolve_range has no 'all' branch
        # and 'custom' with no dates collapses to today — which would make an
        # all-time Amount Paid read ~0. Handle it here with a wide window.
        if period == 'all' or (period == 'custom' and not frm and not to):
            start, end = date(2000, 1, 1), date(2100, 1, 1)
            label = 'All time'
        else:
            start, end, label = PurchaseDashboardView._resolve_range(period, frm, to)

        # Real payments in the window: no transfers, no branch, not cancelled.
        qs = (PaymentMade.objects.filter(is_active=True)
              .exclude(status='CANCELLED')
              .exclude(is_transfer=True)
              .exclude(vendor__is_branch=True)
              # Bank/cash ledgers wrongly imported as vendors (e.g.
              # "ICICI Bank-CA-...Creditor", "...Exp DLOD Ac") are internal
              # accounts, not suppliers — their "payments" are contra/OD
              # movements, not category spend. Keep them out so they don't
              # pollute OTHER.
              .exclude(vendor__vendor_name__istartswith='ICICI Bank')
              .exclude(vendor__vendor_name__istartswith='ICICI CA')
              .filter(payment_date__gte=start, payment_date__lte=end))
        if company_id:
            qs = qs.filter(vendor__company_id=company_id)

        # Every vendor in the window — so a blank bill category (bill-linked) or
        # an on-account payment can fall back to the vendor's usual billed
        # category, and finally to the vendor master's type.
        all_vids = set(qs.values_list('vendor_id', flat=True))
        vendor_cat = {}   # vendor_id -> highest-value billed purchase_category
        if all_vids:
            best = {}
            for r in (VendorBill.objects.filter(vendor_id__in=all_vids, is_active=True)
                      .exclude(purchase_category='')
                      .values('vendor_id', 'purchase_category')
                      .annotate(t=Sum('total_amount'))):
                vid, c, t = r['vendor_id'], r['purchase_category'], (r['t'] or _ZERO)
                if c and (vid not in best or t > best[vid][1]):
                    best[vid] = (c, t)
            vendor_cat = {vid: c for vid, (c, _t) in best.items()}
        vendor_type = {}  # vendor_id -> vendor_type[0]
        vkeys = {}         # vendor_id -> (company_id, vendor_name_key)
        if all_vids:
            from master.models import Vendor
            for vid, vt, cid, nk in (Vendor.objects.filter(id__in=all_vids)
                                     .values_list('id', 'vendor_type',
                                                  'company_id', 'vendor_name_key')):
                if isinstance(vt, (list, tuple)) and vt:
                    vendor_type[vid] = str(vt[0]).upper()
                if nk:
                    vkeys[vid] = (cid, nk)

        # Transporter-master fallback: a vendor whose NAME matches a Transporter
        # record is freight even with NO bill and NO vendor_type — this is how
        # OUTWARD / LOCAL freight payees (paid via Tally as plain vouchers, with
        # their freight living in LocalFreight/FreightAdvice, not a VendorBill)
        # route to Freight instead of leaking into OTHER.
        transporter_vids = set()
        if vkeys:
            from master.models import Transporter
            from master.merge_utils import vkey as _vkey
            company_ids = {cid for (cid, _nk) in vkeys.values() if cid}
            tq = Transporter.objects.filter(active_flag=True)
            if company_ids:
                tq = tq.filter(Q(company_id__in=company_ids) | Q(company_id__isnull=True))
            tpt_keys = set()  # (company_id, name_key) and (None, name_key)
            for name, cid in tq.values_list('name', 'company_id'):
                k = _vkey(name or '')
                if k:
                    tpt_keys.add((cid, k))
            for vid, (cid, nk) in vkeys.items():
                if (cid, nk) in tpt_keys or (None, nk) in tpt_keys:
                    transporter_vids.add(vid)

        def route(cat, vid):
            """Bill/own category first; if it doesn't route, fall back to the
            vendor's usual billed category, then the vendor master type, and
            finally a Transporter-master name match (outward/local freight)."""
            page = self._page_for(cat)
            if page != 'OTHER':
                return page
            page = self._page_for(vendor_cat.get(vid))
            if page != 'OTHER':
                return page
            page = self._page_for(vendor_type.get(vid))
            if page != 'OTHER':
                return page
            return 'FREIGHT' if vid in transporter_vids else 'OTHER'

        buckets = {'PURCHASE': _ZERO, 'FREIGHT': _ZERO, 'EXPENSE': _ZERO, 'OTHER': _ZERO}
        # Bill-linked payments -> bill's purchase_category (with vendor fallback).
        for r in (qs.filter(bill__isnull=False)
                  .values('bill__purchase_category', 'vendor_id').annotate(t=Sum('amount'))):
            buckets[route(r['bill__purchase_category'], r['vendor_id'])] += (r['t'] or _ZERO)
        # On-account payments -> vendor's usual category, else vendor_type.
        for r in (qs.filter(bill__isnull=True)
                  .values('vendor_id').annotate(t=Sum('amount'))):
            buckets[route(None, r['vendor_id'])] += (r['t'] or _ZERO)

        total = sum(buckets.values(), _ZERO)
        return Response({
            'period': {'label': label, 'from': start.isoformat(), 'to': end.isoformat()},
            'company_id': company_id,
            'purchase': _money(buckets['PURCHASE']),
            'freight': _money(buckets['FREIGHT']),
            'expense': _money(buckets['EXPENSE']),
            'other': _money(buckets['OTHER']),
            'total': _money(total),
        })


class PurchaseVendorActivityView(APIView):
    """GET /api/purchase/vendor-activity/?company=&from=&to=

    Per-vendor purchase activity — the data behind the workspace Vendors group
    (Top Vendors / Inactive / New Vendors / Concentration). Mirrors the Sales
    Customers sections for the purchase side.

    Each vendor carries BOTH scopes:
      - period_value / period_bills : ex-GST taxable + bill count IN [from,to]
        (Top Vendors, New Vendors, Concentration).
      - first_bill_date / last_bill_date / days_inactive / lifetime_value /
        outstanding : ALL-TIME (so Inactive = no bill in 30/60/90d and New =
        first bill inside the window both work regardless of the chosen period).

    Scope reuses PurchaseDashboardView._bill_qs + the Total-Purchase exclusions
    (CANCELLED / OPENING / is_expense / _EXPENSE_CATS / journal / branch
    transfers / duplicate re-imports) so the figures reconcile with the tiles.
    """

    permission_classes = [permissions.IsAuthenticated, HasModulePermission]
    module_name = 'Purchase Dashboard'
    alternate_modules = ['Purchase Analytics', 'Vendor Insights']

    @staticmethod
    def _purchase_bills(company_id):
        """Real-purchase bills for a company (no vendor/date filter) — the same
        universe _total_purchase sums, so every vendor aggregate reconciles."""
        return (PurchaseDashboardView._bill_qs(company_id, None)
                .exclude(tally_guid__startswith='OPENING')
                .exclude(status='CANCELLED')
                .exclude(is_expense=True)
                .exclude(purchase_category__in=_EXPENSE_CATS)
                .exclude(tally_voucher_type__icontains='journal'))

    def get(self, request, *args, **kwargs):
        from collections import Counter, defaultdict
        from django.db.models import Max
        company_id = request.query_params.get('company') or None
        frm = request.query_params.get('from')
        to = request.query_params.get('to')
        start, end, label = PurchaseDashboardView._resolve_range('custom', frm, to)
        today = timezone.localdate()

        base = self._purchase_bills(company_id)
        # Drop duplicate re-imports once, up front (same read-time dedup as the
        # tiles), so no vendor total double-counts a '-N' collision bill.
        dups = _cached_dup_bill_ids(base)
        if dups:
            base = base.exclude(id__in=dups)

        # ALL-TIME per vendor: first/last bill, lifetime ex-GST value, bill count,
        # and outstanding (Σ total_amount − Σ amount_paid, since balance_due is a
        # property not a column).
        life = (base.values('vendor_id', 'vendor__vendor_name', 'vendor__is_msme')
                .annotate(first_bill=Min('bill_date'), last_bill=Max('bill_date'),
                          lifetime_value=Sum('subtotal'), bill_count=Count('id'),
                          billed=Sum('total_amount'), paid=Sum('amount_paid')))

        # WINDOWED per vendor: ex-GST value + bill count inside [start, end].
        win = (base.filter(bill_date__gte=start, bill_date__lte=end)
               .values('vendor_id')
               .annotate(period_value=Sum('subtotal'), period_bills=Count('id')))
        win_by = {r['vendor_id']: r for r in win}

        # WINDOWED per vendor: purchase returns (debit notes) & vendor credits
        # (credit notes), grouped once each — same side/ledger filter the
        # Total-Purchase tile uses, so a vendor's return rate reconciles.
        from sales.models import DebitNote
        _dn_base = DebitNote.objects.filter(is_active=True, side='PURCHASE',
                                            note_date__gte=start, note_date__lte=end)
        if company_id:
            _dn_base = _dn_base.filter(company_id=company_id)
        _returns = (_dn_base.filter(note_type='DEBIT')
                    .exclude(Q(tally_group__regex=r'\S') & ~Q(tally_group__icontains='purchase'))
                    .values('vendor_id').annotate(t=Sum('amount')))
        returns_by = {r['vendor_id']: (r['t'] or _ZERO) for r in _returns}
        _credits = (_dn_base.filter(note_type='CREDIT')
                    .values('vendor_id').annotate(t=Sum('amount')))
        credits_by = {r['vendor_id']: (r['t'] or _ZERO) for r in _credits}

        # Dominant purchase_category per vendor (simple majority over its bills).
        cat_counter = defaultdict(Counter)
        for r in base.exclude(purchase_category='').values('vendor_id', 'purchase_category'):
            cat_counter[r['vendor_id']][r['purchase_category']] += 1

        vendors = []
        for r in life:
            vid = r['vendor_id']
            w = win_by.get(vid, {})
            last_bill = r['last_bill']
            outstanding = (r['billed'] or _ZERO) - (r['paid'] or _ZERO)
            cat = cat_counter[vid].most_common(1)[0][0] if cat_counter.get(vid) else ''
            pv = w.get('period_value') or _ZERO
            ret = returns_by.get(vid, _ZERO)
            cn = credits_by.get(vid, _ZERO)
            vendors.append({
                'vendor_id': str(vid) if vid else None,
                'vendor_name': r['vendor__vendor_name'] or '(unknown)',
                'is_msme': bool(r['vendor__is_msme']),
                'purchase_category': cat,
                'period_value': _money(w.get('period_value')),
                'period_bills': w.get('period_bills', 0) or 0,
                'outstanding': _money(outstanding if outstanding > 0 else _ZERO),
                'first_bill_date': r['first_bill'].isoformat() if r['first_bill'] else None,
                'last_bill_date': last_bill.isoformat() if last_bill else None,
                'lifetime_value': _money(r['lifetime_value']),
                'days_inactive': (today - last_bill).days if last_bill else None,
                # Windowed purchase returns / vendor credits + return rate (a
                # vendor-reliability signal for the Scorecard section).
                'returns': _money(ret),
                'credit_notes': _money(cn),
                'return_rate': round(float(ret) / float(pv) * 100, 1) if pv else 0.0,
            })

        vendors.sort(key=lambda v: v['period_value'], reverse=True)
        return Response({
            'as_of': today.isoformat(),
            'period': {'label': label, 'from': start.isoformat(), 'to': end.isoformat()},
            'company_id': company_id,
            'vendors': vendors,
        })


class PurchaseAccountsSummaryView(APIView):
    """GET /api/purchase/accounts-summary/?company=&from=&to=

    Company-level accounting summaries behind the workspace Accounts group:
      - gst     : input GST (Ex-GST / Total GST / Incl GST), CGST/SGST/IGST
                  breakup, on-bill charges + round-off, DN/CN, monthly GST pivot.
      - notes   : purchase-side debit notes (returns) & credit notes (vendor
                  credits) — totals, counts, net adjustment, recent lists.
      - payment : DPO, payment rate, outstanding/overdue, a month-wise
                  billed/paid trend, and the slowest-paying vendors.

    Scope reuses PurchaseDashboardView._bill_qs + the Total-Purchase exclusions
    (CANCELLED / OPENING / is_expense / _EXPENSE_CATS / journal / branch
    transfers / duplicate re-imports) so every figure reconciles with the tiles.
    """

    permission_classes = [permissions.IsAuthenticated, HasModulePermission]
    module_name = 'Purchase Dashboard'
    alternate_modules = ['Purchase Analytics', 'Vendor Insights']

    def get(self, request, *args, **kwargs):
        from collections import defaultdict
        from django.db.models import Max
        from sales.models import DebitNote

        company_id = request.query_params.get('company') or None
        frm = request.query_params.get('from')
        to = request.query_params.get('to')
        start, end, label = PurchaseDashboardView._resolve_range('custom', frm, to)
        today = timezone.localdate()

        # Real-purchase bills (same universe as the Total-Purchase tile), windowed.
        base = (PurchaseDashboardView._bill_qs(company_id, None)
                .exclude(tally_guid__startswith='OPENING')
                .exclude(status='CANCELLED')
                .exclude(is_expense=True)
                .exclude(purchase_category__in=_EXPENSE_CATS)
                .exclude(tally_voucher_type__icontains='journal'))
        dups = _cached_dup_bill_ids(base)
        if dups:
            base = base.exclude(id__in=dups)
        win = base.filter(bill_date__gte=start, bill_date__lte=end)

        # ── GST ──────────────────────────────────────────────────────────────
        g = win.aggregate(
            exgst=Sum('subtotal'), total_gst=Sum('tax_amount'), inclgst=Sum('total_amount'),
            cgst=Sum('cgst_amount'), sgst=Sum('sgst_amount'), igst=Sum('igst_amount'),
            charges=Sum('other_charges'), round_off=Sum('adjustment'))

        # ── Debit / Credit notes (purchase side) ─────────────────────────────
        def _notes_qs(note_type):
            q = DebitNote.objects.filter(is_active=True, side='PURCHASE', note_type=note_type,
                                         note_date__gte=start, note_date__lte=end)
            if company_id:
                q = q.filter(company_id=company_id)
            if note_type == 'DEBIT':
                # Only a note on a PURCHASE ledger is a goods return (same rule as
                # _total_purchase); one on another ledger is a price adjustment.
                q = q.exclude(Q(tally_group__regex=r'\S') & ~Q(tally_group__icontains='purchase'))
            return q

        dn_qs = _notes_qs('DEBIT')
        cn_qs = _notes_qs('CREDIT')
        dn_agg = dn_qs.aggregate(t=Sum('amount'), n=Count('id'))
        cn_agg = cn_qs.aggregate(t=Sum('amount'), n=Count('id'))
        dn_total = dn_agg['t'] or _ZERO
        cn_total = cn_agg['t'] or _ZERO

        def _recent(qs):
            rows = (qs.select_related('vendor').order_by('-note_date', '-id')[:25])
            return [{
                'no': r.note_no or str(r.id)[:8],
                'vendor': (r.vendor.vendor_name if r.vendor_id else '—'),
                'date': r.note_date.isoformat() if r.note_date else None,
                'amount': _money(r.amount),
            } for r in rows]

        # ── Monthly GST pivot ────────────────────────────────────────────────
        monthly_gst = []
        for ym, m_start, m_end in _month_iter(start, end):
            m = base.filter(bill_date__gte=m_start, bill_date__lte=m_end).aggregate(
                cgst=Sum('cgst_amount'), sgst=Sum('sgst_amount'),
                igst=Sum('igst_amount'), total_gst=Sum('tax_amount'))
            monthly_gst.append({
                'month': ym, 'label': '{:%b %Y}'.format(m_start),
                'cgst': _money(m['cgst']), 'sgst': _money(m['sgst']),
                'igst': _money(m['igst']), 'total_gst': _money(m['total_gst']),
            })

        # ── Payment efficiency ───────────────────────────────────────────────
        # Per-vendor outstanding / overdue from the open bills (balance = total −
        # paid; overdue when the bill is past its due date and still owes).
        pay_rows = (base.values('vendor_id', 'vendor__vendor_name')
                    .annotate(billed=Sum('total_amount'), paid=Sum('amount_paid')))
        # Overdue balance per vendor: Σ (total − paid) over bills whose due_date
        # (or bill_date) is before today and still owe something.
        overdue_bills = base.annotate(
            _bal=ExpressionWrapper(F('total_amount') - F('amount_paid'),
                                   output_field=DecimalField(max_digits=18, decimal_places=2)))
        ov_by = defaultdict(lambda: _ZERO)
        for r in (overdue_bills.filter(_bal__gt=0)
                  .values('vendor_id', 'due_date', 'bill_date', '_bal')):
            due = r['due_date'] or r['bill_date']
            if due and due < today:
                ov_by[r['vendor_id']] += r['_bal'] or _ZERO

        slowest = []
        tot_billed = _ZERO
        tot_paid = _ZERO
        tot_out = _ZERO
        tot_overdue = _ZERO
        for r in pay_rows:
            billed = r['billed'] or _ZERO
            paid = r['paid'] or _ZERO
            out = billed - paid
            tot_billed += billed
            tot_paid += paid
            if out <= 0:
                continue
            overdue = ov_by.get(r['vendor_id'], _ZERO)
            tot_out += out
            tot_overdue += overdue
            pct = float(overdue / out) if out else 0.0
            rating = 'POOR' if pct > 0.60 else ('FAIR' if pct > 0.30 else 'GOOD')
            slowest.append({
                'vendor': r['vendor__vendor_name'] or '(unknown)',
                'outstanding': _money(out),
                'overdue': _money(overdue),
                'rating': rating,
            })
        slowest.sort(key=lambda x: x['outstanding'], reverse=True)
        slowest = slowest[:15]

        # DPO = outstanding / (windowed purchases / 365).
        purchases_win = g['inclgst'] or _ZERO
        dpo = 0
        if purchases_win > 0:
            dpo = int(round(float(tot_out) / (float(purchases_win) / 365.0)))
        payment_rate = round(float(tot_paid) / float(tot_billed) * 100, 1) if tot_billed else 0.0

        # Monthly billed (bills' total) vs paid (PaymentMade amount) in scope.
        from purchase.models import PaymentMade
        pay_base = PaymentMade.objects.filter(payment_date__gte=start, payment_date__lte=end)
        if company_id:
            pay_base = pay_base.filter(vendor__company_id=company_id)
        monthly_pay = []
        for ym, m_start, m_end in _month_iter(start, end):
            billed_m = base.filter(bill_date__gte=m_start, bill_date__lte=m_end).aggregate(
                t=Sum('total_amount'))['t'] or _ZERO
            paid_m = pay_base.filter(payment_date__gte=m_start, payment_date__lte=m_end).aggregate(
                t=Sum('amount'))['t'] or _ZERO
            pct = round(float(paid_m) / float(billed_m) * 100, 0) if billed_m else None
            monthly_pay.append({
                'month': ym, 'label': '{:%b %Y}'.format(m_start),
                'billed': _money(billed_m), 'paid': _money(paid_m), 'pct': pct,
            })

        return Response({
            'as_of': today.isoformat(),
            'period': {'label': label, 'from': start.isoformat(), 'to': end.isoformat()},
            'company_id': company_id,
            'gst': {
                'exgst': _money(g['exgst']), 'total_gst': _money(g['total_gst']),
                'inclgst': _money(g['inclgst']),
                'cgst': _money(g['cgst']), 'sgst': _money(g['sgst']), 'igst': _money(g['igst']),
                'charges': _money(g['charges']), 'round_off': _money(g['round_off']),
                'debit_notes': _money(dn_total), 'credit_notes': _money(cn_total),
                'monthly': monthly_gst,
            },
            'notes': {
                'credit_total': _money(cn_total), 'credit_count': cn_agg['n'] or 0,
                'debit_total': _money(dn_total), 'debit_count': dn_agg['n'] or 0,
                'net_adjustment': _money(dn_total - cn_total),
                'recent_credit': _recent(cn_qs),
                'recent_debit': _recent(dn_qs),
            },
            'payment': {
                'dpo': dpo,
                'payment_rate': payment_rate,
                'outstanding': _money(tot_out),
                'overdue': _money(tot_overdue),
                'monthly': monthly_pay,
                'slowest': slowest,
            },
        })


class PurchasePayablesCalendarView(APIView):
    """GET /api/purchase/payables-calendar/?company=<uuid>&vendor=<uuid>&msme=true|false

    Open vendor bills with a LEDGER-TIED balance for the Payables payment
    calendar. Each bill's balance is the vendor's authoritative outstanding
    (opening + billed − all payments incl on-account − debit notes, exactly as
    the vendor ledger / Tally compute it) allocated across the vendor's bills
    oldest-first. Σ balance ties to the vendor ledger, so the calendar no longer
    over-states dues the way summing per-bill total−amount_paid did.
    """
    permission_classes = [permissions.IsAuthenticated, HasModulePermission]
    module_name = 'Purchase Dashboard'
    alternate_modules = ['Purchase Analytics', 'Vendor Insights', 'Reports']

    def get(self, request):
        company_id = request.query_params.get('company') or None
        vendor_id = request.query_params.get('vendor') or None
        _m = (request.query_params.get('msme') or '').lower()
        msme = True if _m == 'true' else (False if _m == 'false' else None)
        rows = PurchaseDashboardView._payables_calendar(company_id, vendor_id, msme=msme)
        total = _money(sum((Decimal(str(r['balance'])) for r in rows), _ZERO))
        return Response({'bills': rows, 'count': len(rows), 'total': total})

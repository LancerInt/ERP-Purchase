"""TDS Reconciliation endpoint — bill-wise & vendor-wise, Tally-vs-ERP.

GET /api/purchase/tds-bills/?company=&from=&to=&regime=PURCHASE|EXPENSE|FREIGHT
                            &view=bill|vendor&vendor_id=&only_missing=true

The companion to /api/purchase/tds-summary/ (tds_summary_views.py). Where the
summary is one row per VENDOR, this returns one row per BILL (view=bill) so a
single missing deduction surfaces — the Sperrholz SETN2627-02 case: Tally
deducted ₹40,630 (the bill's total is stored already NET of it) but the TdsPayable
row never linked, so the ledger TDS column reads blank. view=vendor rolls the same
bill rows up per vendor.

Reconciliation rule ("one TDS, not two"):
  * The displayed TDS is TALLY's actual deduction — taken from the bill's linked
    TdsPayable rows, falling back to VendorBill.tds_amount when nothing is linked
    (so a deduction Tally made but whose link broke is NOT lost).
  * The ERP's EXPECTED TDS (tds_fresh) sits beside it for verification only; it is
    NEVER added on top. One figure per bill.
  * The ₹50L (194Q goods) / 194C threshold decides whether a deduction was DUE —
    reused verbatim from the summary so the two pages always agree.

Per-bill status:
  * MISSING_IN_ERP — Tally deducted (tds_amount > 0) but nothing is linked and the
    ledger shows blank → a broken link (run relink_tds_to_bills to fix the data).
  * UNDER_DEDUCTED — ERP expected materially more than Tally deducted.
  * NOT_DUE        — no deduction due (below threshold) and none made.
  * MATCHED        — Tally's deduction is present and ≈ expected.

Reporting-only: reads bills + TdsPayable, writes NOTHING.
"""
from datetime import date
from decimal import Decimal

from django.db.models import Sum
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated

from .tds_fresh import compute_for_bill, _d
from .tds_regime import regime_for_bill, PURCHASE, EXPENSE, FREIGHT, REGIMES

Z = Decimal('0')
# Goods categories count toward the 194Q FY aggregate (mirror tds_summary_views).
_GOODS = ('RM', 'PACKING', 'MAIZE', 'BOUGHT_NOTE', '')
# Tolerance: expected-vs-actual within this (rupees) is treated as MATCHED, not a
# mismatch — rounding and the 194Q lump-at-payment timing make exact ties rare.
_TOL = Decimal('2')


def _fy_bounds_for(d):
    """Indian FY (1 Apr–31 Mar) containing date d → (start, end)."""
    y = d.year if d.month >= 4 else d.year - 1
    return date(y, 4, 1), date(y + 1, 3, 31)


def _parse_date(s):
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def _bill_base(b):
    """Ex-GST taxable base for a bill: subtotal, else total − tax."""
    sub = _d(b.subtotal)
    if sub > 0:
        return sub
    return _d(b.total_amount) - _d(b.tax_amount)


def _tally_tds_for(b, linked_by_bill):
    """TALLY's actual TDS for this bill, as ONE figure, plus whether it is linked.

    Prefer the sum of linked TdsPayable rows (what the ledger TDS column shows).
    When nothing is linked, fall back to the bill's own tds_amount (Tally DID
    deduct — e.g. a net-total scan — but the TdsPayable link broke). Returns
    (amount, is_linked)."""
    linked = linked_by_bill.get(b.id)
    if linked and linked > 0:
        return linked, True
    own = _d(b.tds_amount)
    if own > 0:
        return own, False      # Tally deducted but the ledger row isn't linked
    return Z, False


class TdsBillsView(APIView):
    permission_classes = [IsAuthenticated]
    module_name = 'TDS Reconciliation'

    def get(self, request):
        from .models import VendorBill, TdsPayable

        q = request.query_params
        company = q.get('company') or None
        regime_f = (q.get('regime') or '').upper()
        if regime_f not in REGIMES:
            regime_f = ''
        view = (q.get('view') or 'bill').lower()
        vendor_id = q.get('vendor_id') or None
        only_missing = (q.get('only_missing') or '').lower() in ('1', 'true', 'yes')

        # Date window: explicit from/to, else the FY of `to`/today. The 194Q FY
        # aggregate is always computed over the WHOLE financial year that contains
        # the window end, so the ₹50L threshold is assessed correctly even when the
        # user filters to a single month.
        start = _parse_date(q.get('from'))
        end = _parse_date(q.get('to'))
        if start is None or end is None:
            fy_s, fy_e = _fy_bounds_for(end or start or date.today())
            start = start or fy_s
            end = end or fy_e
        fy_start, fy_end = _fy_bounds_for(end)

        base_qs = (VendorBill.objects.filter(is_active=True)
                   .exclude(status='CANCELLED')
                   .exclude(vendor__is_branch=True)
                   .select_related('vendor'))
        if company:
            # VendorBill has no company field — company lives on the vendor
            # (matches tds_summary_views.py). TdsPayable below DOES have company_id.
            base_qs = base_qs.filter(vendor__company_id=company)
        if vendor_id:
            base_qs = base_qs.filter(vendor_id=vendor_id)

        # FY aggregate per vendor (goods base, whole FY) — the 194Q ₹50L threshold
        # is assessed on this, not on the windowed bills.
        fy_bills = base_qs.filter(bill_date__gte=fy_start, bill_date__lte=fy_end)
        goods_agg = {}
        for b in fy_bills.only('vendor_id', 'subtotal', 'total_amount',
                               'tax_amount', 'purchase_category'):
            cat = (b.purchase_category or '').upper()
            if cat in _GOODS:
                goods_agg[b.vendor_id] = goods_agg.get(b.vendor_id, Z) + _bill_base(b)

        # Linked Tally TDS per bill (what the ledger column shows). Exclude the
        # synthetic FY-start "Opening Balance" leg — it is the brought-forward
        # TDS-payable balance, not a deduction against this bill, and counting it
        # would inflate the bill's TDS (the summary view + vendor-ledger exclude it
        # the same way).
        tds_qs = (TdsPayable.objects.filter(is_active=True, amount__gt=0,
                                            vendor_bill__isnull=False)
                  .exclude(voucher_type='Opening Balance'))
        if company:
            tds_qs = tds_qs.filter(company_id=company)
        linked_by_bill = {r['vendor_bill_id']: _d(r['t'])
                          for r in tds_qs.values('vendor_bill_id').annotate(t=Sum('amount'))}

        # The bills IN the display window.
        win_bills = (base_qs.filter(bill_date__gte=start, bill_date__lte=end)
                     .order_by('bill_date', 'bill_no'))

        bill_rows = []
        for b in win_bills:
            v = b.vendor
            if v is None:
                continue
            regime = regime_for_bill(b)
            if regime_f and regime != regime_f:
                continue

            base = _bill_base(b)
            fy_base = goods_agg.get(v.id, Z)
            # ── Expected TDS for THIS bill ───────────────────────────────────
            # 194C (expense/freight) is deducted PER BILL, so its expected ties to
            # the bill directly. 194Q (goods) is fundamentally a VENDOR-LEVEL tax —
            # 0.1% on the FY aggregate above ₹50L, deducted in lumps at payment — so
            # it CANNOT tie per bill (see tds_regime.py). Charging every goods bill
            # the whole year's excess (the naive approach) makes each bill look
            # massively under-deducted. Instead a goods bill carries its PROPORTIONAL
            # SHARE of the FY excess-TDS (base / fy_base), so the per-bill figures
            # SUM to the correct vendor 194Q total and no single bill is falsely
            # flagged. The reconciliation verdict for 194Q is therefore assessed at
            # the VENDOR level (rollup), not per bill.
            if regime == PURCHASE:
                fy_excess = max(fy_base - Decimal('5000000'), Z)
                fy_tds = (fy_excess * Decimal('0.001')).quantize(Decimal('0.01'))
                erp_expected = (fy_tds * (base / fy_base)).quantize(Decimal('0.01')) \
                    if fy_base > 0 else Z
                comp = compute_for_bill(b, v, taxable_base=Z, fy_aggregate=fy_base)
            else:
                comp = compute_for_bill(b, v, taxable_base=base, fy_aggregate=fy_base)
                erp_expected = _d(comp['tds_amount'])

            tally_tds, is_linked = _tally_tds_for(b, linked_by_bill)
            threshold_crossed = (fy_base > Decimal('5000000')) if regime == PURCHASE \
                else (base >= Decimal('30000'))

            # ── Per-bill reconciliation verdict ──────────────────────────────
            # MISSING_IN_ERP is the headline defect: Tally deducted (the bill's own
            # tds_amount > 0) but no TdsPayable is linked, so the ledger reads blank.
            # For 194Q the expected can't tie per bill, so a present-and-linked
            # deduction is treated as reconciled per-bill (the real expected-vs-actual
            # check happens in the vendor rollup); only 194C is checked per bill.
            own_tds = _d(b.tds_amount)
            if own_tds > Z and not is_linked:
                status = 'MISSING_IN_ERP'        # deducted but link broken (Sperrholz)
            elif tally_tds <= Z and erp_expected > _TOL:
                status = 'TDS_DUE_NONE'          # expected a deduction, none at all
            elif regime != PURCHASE and erp_expected - tally_tds > _TOL and tally_tds > Z:
                status = 'UNDER_DEDUCTED'        # per-bill only valid for 194C
            elif tally_tds <= Z:
                status = 'NOT_DUE'
            else:
                status = 'MATCHED'

            if only_missing and status in ('MATCHED', 'NOT_DUE'):
                continue

            bill_rows.append({
                'bill_id': str(b.id),
                'date': b.bill_date.isoformat() if b.bill_date else None,
                'bill_no': b.bill_no,
                'vendor_invoice_no': b.vendor_invoice_no or '',
                'vendor_id': str(v.id),
                'vendor': v.vendor_name,
                'pan': (v.pan or '').strip() or '—',
                'regime': regime,
                'section': comp['section'],
                'rate_pct': str((_d(comp['rate']) * Decimal('100')).quantize(Decimal('0.01'))),
                'billed_value': str(_d(b.total_amount).quantize(Decimal('0.01'))),
                'base': str(base.quantize(Decimal('0.01'))),
                'total_payable': str(_d(b.total_amount).quantize(Decimal('0.01'))),
                'total_is_net': bool(b.total_is_net),
                'tally_tds': str(tally_tds.quantize(Decimal('0.01'))),
                'erp_expected_tds': str(erp_expected.quantize(Decimal('0.01'))),
                'difference': str((erp_expected - tally_tds).quantize(Decimal('0.01'))),
                'tds_linked': is_linked,
                'threshold_crossed': bool(threshold_crossed),
                'status': status,
                'reason': comp['reason'],
            })

        if view == 'vendor':
            rows = self._rollup(bill_rows)
        else:
            rows = bill_rows

        tally_total = sum((_d(r['tally_tds']) for r in bill_rows), Z)
        erp_total = sum((_d(r['erp_expected_tds']) for r in bill_rows), Z)
        missing = [r for r in bill_rows if r['status'] in ('MISSING_IN_ERP', 'TDS_DUE_NONE')]
        return Response({
            'window': {'from': start.isoformat(), 'to': end.isoformat()},
            'fy': {'from': fy_start.isoformat(), 'to': fy_end.isoformat()},
            'company_id': company,
            'regime': regime_f,
            'view': 'vendor' if view == 'vendor' else 'bill',
            'tally_total': str(tally_total.quantize(Decimal('0.01'))),
            'erp_total': str(erp_total.quantize(Decimal('0.01'))),
            'difference_total': str((erp_total - tally_total).quantize(Decimal('0.01'))),
            'bill_count': len(bill_rows),
            'missing_count': len(missing),
            'missing_amount': str(sum((_d(r['tally_tds']) + _d(r['erp_expected_tds'])
                                       for r in missing), Z).quantize(Decimal('0.01'))),
            'rows': rows,
        })

    @staticmethod
    def _rollup(bill_rows):
        """Roll bill rows up to one row per vendor (for view=vendor)."""
        by_v = {}
        for r in bill_rows:
            g = by_v.setdefault(r['vendor_id'], {
                'vendor_id': r['vendor_id'], 'vendor': r['vendor'], 'pan': r['pan'],
                'regime': r['regime'], 'section': r['section'],
                'bills': 0, 'tally_tds': Z, 'erp_expected_tds': Z,
                'missing_bills': 0,
            })
            g['bills'] += 1
            g['tally_tds'] += _d(r['tally_tds'])
            g['erp_expected_tds'] += _d(r['erp_expected_tds'])
            if r['status'] in ('MISSING_IN_ERP', 'TDS_DUE_NONE'):
                g['missing_bills'] += 1
        out = []
        for g in by_v.values():
            diff = g['erp_expected_tds'] - g['tally_tds']
            out.append({
                'vendor_id': g['vendor_id'], 'vendor': g['vendor'], 'pan': g['pan'],
                'regime': g['regime'], 'section': g['section'], 'bills': g['bills'],
                'tally_tds': str(g['tally_tds'].quantize(Decimal('0.01'))),
                'erp_expected_tds': str(g['erp_expected_tds'].quantize(Decimal('0.01'))),
                'difference': str(diff.quantize(Decimal('0.01'))),
                'missing_bills': g['missing_bills'],
                'status': 'MISSING_IN_ERP' if g['missing_bills'] else (
                    'UNDER_DEDUCTED' if diff > _TOL else 'MATCHED'),
            })
        out.sort(key=lambda r: (r['missing_bills'], abs(_d(r['difference']))), reverse=True)
        return out

"""TDS Summary endpoint — the fresh, standalone TDS page.

GET /api/purchase/tds-summary/?company=&fy=YYYY&regime=PURCHASE|EXPENSE|FREIGHT

Per vendor (non-branch, with purchases this FY) it returns: vendor, PAN, section,
rate %, FY aggregate, the ERP's EXPECTED TDS (computed by tds_fresh) AND Tally's
ACTUAL deducted TDS (from the imported TdsPayable records), plus the difference —
so the ERP figure can be reconciled against what Tally really withheld. The
`regime` filter narrows to Purchase (194Q goods) / Expense / Freight (both 194C).
Reporting-only; reads bills + TdsPayable, writes nothing.
"""
from datetime import date
from decimal import Decimal

from django.db.models import Sum, Q
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated

from .tds_fresh import tds_profile, tds_due, _fresh_category, _fresh_party_type
from .tds_regime import PURCHASE, EXPENSE, FREIGHT, REGIMES

Z = Decimal('0')
# Goods categories count toward the 194Q FY aggregate (agri/branch excluded).
_GOODS = ('RM', 'PACKING', 'MAIZE', 'BOUGHT_NOTE', '')
# Spend categories that are expense bookings (194C) vs freight (194C).
_FREIGHT_CATS = ('FREIGHT',)
_EXPENSE_CATS = ('EXPENSES', 'EXPENSE', 'MACHINERY', 'LAB_EXPENSE')


def _regime_of_cat(cat):
    """Dominant spend category → regime, matching tds_regime's bill rule."""
    cat = (cat or '').upper()
    if cat in _FREIGHT_CATS:
        return FREIGHT
    if cat in _EXPENSE_CATS:
        return EXPENSE
    return PURCHASE


def _fy_window(fy):
    """fy=2026 → (2026-04-01, 2027-03-31). Defaults to the current FY."""
    try:
        y = int(fy)
    except (TypeError, ValueError):
        today = date.today()
        y = today.year if today.month >= 4 else today.year - 1
    return date(y, 4, 1), date(y + 1, 3, 31), f'FY {y}-{str(y + 1)[-2:]}'


class TdsSummaryView(APIView):
    permission_classes = [IsAuthenticated]
    module_name = 'TDS Summary'

    def get(self, request):
        from .models import VendorBill, TdsPayable
        from .tds_engine import derive_pan_status, derive_deductee_category

        company = request.query_params.get('company') or None
        start, end, label = _fy_window(request.query_params.get('fy'))
        regime_f = (request.query_params.get('regime') or '').upper()
        if regime_f not in REGIMES:
            regime_f = ''   # '' = all regimes

        bills = (VendorBill.objects.filter(is_active=True, bill_date__gte=start, bill_date__lte=end)
                 .exclude(status='CANCELLED')
                 .exclude(vendor__is_branch=True)
                 .select_related('vendor'))
        if company:
            # VendorBill has no company field — company lives on the vendor.
            # (company_id here raised a FieldError 500 whenever a company was
            # selected on the TDS Summary page.)
            bills = bills.filter(vendor__company_id=company)

        # Aggregate per vendor: goods FY total (194Q base), the dominant category
        # (decides the section), and the base for each regime so an expense /
        # freight vendor's 194C is taxed on its OWN base, not a zero goods total.
        agg = {}
        for b in bills.only('vendor_id', 'subtotal', 'total_amount', 'tax_amount',
                            'purchase_category', 'is_expense', 'vendor__vendor_name', 'vendor__pan',
                            'vendor__deductee_category', 'vendor__is_msme'):
            v = b.vendor
            if v is None:
                continue
            row = agg.setdefault(v.id, {'vendor': v, 'goods': Z, 'cats': {}, 'base_by_regime': {}})
            base = Decimal(b.subtotal or 0) or (Decimal(b.total_amount or 0) - Decimal(b.tax_amount or 0))
            cat = (b.purchase_category or '').upper()
            if cat in _GOODS:
                row['goods'] += base
            row['cats'][cat] = row['cats'].get(cat, Z) + base
            # is_expense-flagged bills are EXPENSE even if the category is blank.
            reg = EXPENSE if (b.is_expense and cat not in _FREIGHT_CATS) else _regime_of_cat(cat)
            row['base_by_regime'][reg] = row['base_by_regime'].get(reg, Z) + base

        # Tally's REAL deducted TDS per vendor (credits, excl opening) for the FY.
        tally_qs = (TdsPayable.objects.filter(is_active=True, amount__gt=0)
                    .exclude(voucher_type='Opening Balance')
                    .filter(Q(voucher_date__gte=start, voucher_date__lte=end) | Q(voucher_date__isnull=True)))
        if company:
            tally_qs = tally_qs.filter(company_id=company)
        tally_by_vendor = {r['vendor_id']: Decimal(r['t'] or 0)
                           for r in tally_qs.values('vendor_id').annotate(t=Sum('amount'))}

        rows = []
        for data in agg.values():
            v = data['vendor']
            # Dominant spend category decides goods vs freight/expense for the section.
            dom = max(data['cats'].items(), key=lambda kv: kv[1])[0] if data['cats'] else ''
            vendor_regime = _regime_of_cat(dom)
            if regime_f and vendor_regime != regime_f:
                continue
            pan_status = derive_pan_status(v)
            real_pan = (v.pan or '').strip()
            pan_for_logic = '' if pan_status in ('MISSING', 'INVALID', 'INOPERATIVE') else (real_pan or 'ASSUMEDVALID')
            # 194Q is taxed on the goods FY aggregate (excess over ₹50L); 194C on
            # this vendor's own expense/freight base.
            fy_base = data['goods'] if vendor_regime == PURCHASE else data['base_by_regime'].get(vendor_regime, Z)
            prof = tds_profile({
                'pan': pan_for_logic,
                'category': _fresh_category(dom),
                'party_type': _fresh_party_type(derive_deductee_category(v)),
                'is_msme': bool(v.is_msme),
                'transporter_decl': False,
                'fy_aggregate': fy_base,
                'this_bill_base': fy_base,   # 194C threshold uses the FY base here
            })
            erp_due = tds_due(prof, taxable_base=fy_base)
            tally_tds = tally_by_vendor.get(v.id, Z)
            rows.append({
                'vendor': v.vendor_name,
                'pan': real_pan or '—',
                'regime': vendor_regime,
                'section': prof['section'],
                'rate_pct': str((prof['rate'] * Decimal('100')).quantize(Decimal('0.01'))),
                'fy_aggregate': str(fy_base.quantize(Decimal('0.01'))),
                'erp_tds': str(erp_due),
                'tally_tds': str(tally_tds.quantize(Decimal('0.01'))),
                'difference': str((erp_due - tally_tds).quantize(Decimal('0.01'))),
                'reason': prof['reason'],
            })

        rows.sort(key=lambda r: abs(Decimal(r['difference'])), reverse=True)
        erp_total = sum((Decimal(r['erp_tds']) for r in rows), Z)
        tally_total = sum((Decimal(r['tally_tds']) for r in rows), Z)
        return Response({
            'fy': {'label': label, 'from': start.isoformat(), 'to': end.isoformat()},
            'company_id': company,
            'regime': regime_f,
            'erp_total': str(erp_total.quantize(Decimal('0.01'))),
            'tally_total': str(tally_total.quantize(Decimal('0.01'))),
            'difference_total': str((erp_total - tally_total).quantize(Decimal('0.01'))),
            # Back-compat: the old page read total_due (ERP expected).
            'total_due': str(erp_total.quantize(Decimal('0.01'))),
            'vendor_count': len(rows),
            'rows': rows,
        })

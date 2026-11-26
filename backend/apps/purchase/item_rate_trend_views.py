"""Purchase item rate / qty trend + vendor comparison — the data behind the
Purchase Report's "Top purchased items", "Item qty & rate trend" and
"Vendor comparison" sub-reports.

All computed from VendorBillLine (non-cancelled bills), so every bill source
(scan / receipt / manual) is included. No Tally. Company + date window scoped,
matching the other report endpoints.

GET /api/purchase/item-rate-trend/?from=&to=&company=&mode=
  default              -> { items: [{item, uom, category, total_qty, total_value,
                                     months{YYYY-MM: rate}, change_pct}], months: [] }
  mode=vendor-comparison -> { items: [{item, category, cheapest_vendor,
                                       vendors:[{vendor, qty, rate, amount}]}] }
"""
from collections import defaultdict
from decimal import Decimal
import datetime

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated


Z = Decimal('0')


def _branch_line_q():
    """branch_transfer_q() prefixed for a VendorBillLine queryset. Branch
    transfers are internal stock moves, not purchases, so every item/vendor
    analytic here excludes them — the same rule the dashboard applies to bills."""
    from django.db.models import Q
    return (Q(bill__vendor_invoice_no__istartswith='DC/')
            | Q(bill__vendor__is_branch=True)
            | Q(bill__purchase_category='BRANCH'))


def _pd(s):
    try:
        return datetime.date.fromisoformat((s or '')[:10])
    except (ValueError, TypeError):
        return None


class PurchaseItemRateTrendView(APIView):
    """Purchase-side item rate/qty trend and vendor comparison, from bill lines."""
    permission_classes = [IsAuthenticated]
    module_name = 'Consolidated Report'

    def get(self, request):
        from .models import VendorBillLine
        from .stock_views import product_category  # dominant RM/PM per product
        self._product_category = product_category

        company = (request.query_params.get('company') or '').strip() or None
        frm = _pd(request.query_params.get('from'))
        to = _pd(request.query_params.get('to'))
        mode = (request.query_params.get('mode') or '').strip().lower()

        # Branch transfers are internal stock moves, NOT purchases — excluded
        # (see _branch_line_q), else a branch vendor's bills inflate item
        # qty/value and show up as a "vendor" in the comparisons.
        qs = (VendorBillLine.objects.filter(is_active=True, product__isnull=False)
              .exclude(bill__status='CANCELLED')
              .exclude(_branch_line_q())
              .select_related('bill', 'bill__vendor', 'product'))
        if company:
            qs = qs.filter(bill__vendor__company_id=company)
        if frm:
            qs = qs.filter(bill__bill_date__gte=frm)
        if to:
            qs = qs.filter(bill__bill_date__lte=to)

        if mode == 'vendor-comparison':
            return Response(self._vendor_comparison(qs))
        if mode == 'pivot':
            # include_single=1 keeps single-vendor items too (the Item Analytics
            # expand renders the same vendor x month grid for every product);
            # default keeps the multi-vendor-only "comparison" behaviour.
            include_single = str(request.query_params.get('include_single', '')).lower() in ('1', 'true', 'yes')
            return Response(self._pivot(qs, include_single=include_single))
        return Response(self._rate_trend(qs))

    # ── item × vendor × month pivot (trend + comparison in one grid) ──────────
    def _pivot(self, qs, include_single=False):
        # Clubs the rate/qty trend and the vendor comparison. Per item:
        #   - months[]                      (aligned column list)
        #   - vendors[]: each with a per-month {rate, qty} cell, its own
        #     total_qty / total_value / avg_rate, and a cheapest flag
        #   - month_avg{month: {rate, qty}} (qty-weighted, across vendors) and
        #     change_pct (first->last rated month) — the trend row
        # Only items bought from 2+ vendors are kept (same rule as the vendor
        # comparison — a single-vendor item has nothing to pivot).
        from collections import Counter
        months_seen = set()
        # item -> vendor -> month -> [qty, value]
        acc = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: [Z, Z])))
        uom_votes = defaultdict(Counter)
        pid_of = {}
        for ln in qs:
            name = (ln.product.product_name if ln.product_id else (ln.description or '')).strip() or '—'
            vend = (ln.bill.vendor.vendor_name if (ln.bill_id and ln.bill.vendor_id) else '—')
            if not (ln.bill_id and ln.bill.bill_date):
                continue
            qty = Decimal(str(ln.quantity or 0))
            val = Decimal(str(ln.amount or 0))
            ym = ln.bill.bill_date.strftime('%Y-%m')
            months_seen.add(ym)
            cell = acc[name][vend][ym]
            cell[0] += qty
            cell[1] += val
            if ln.uom:
                uom_votes[name][ln.uom.strip().upper()] += 1
            if ln.product_id and name not in pid_of:
                pid_of[name] = ln.product_id

        months = sorted(months_seen)
        items = []
        for name, vends in acc.items():
            if len(vends) < 2 and not include_single:
                continue  # only multi-vendor items are worth a pivot (unless asked)
            vendors = []
            # month -> [qty, value] rolled up across vendors, for the trend row.
            month_roll = defaultdict(lambda: [Z, Z])
            for vend, by_month in vends.items():
                vq = Z; vv = Z
                cells = {}
                for ym in months:
                    q, v = by_month.get(ym, (Z, Z))
                    cells[ym] = {
                        'rate': round(float(v / q), 2) if q else None,
                        'qty': float(q) if q else None,
                    }
                    vq += q; vv += v
                    mr = month_roll[ym]
                    mr[0] += q; mr[1] += v
                vendors.append({
                    'vendor': vend,
                    'total_qty': str(vq),
                    'total_value': str(vv),
                    'avg_rate': round(float(vv / vq), 2) if vq else None,
                    'cells': cells,
                })
            # cheapest = lowest overall avg rate; sort vendors cheapest-first.
            vendors.sort(key=lambda x: (x['avg_rate'] is None, x['avg_rate'] or 0))
            cheapest = next((v['vendor'] for v in vendors if v['avg_rate'] is not None), None)
            month_avg = {}
            for ym in months:
                q, v = month_roll[ym]
                month_avg[ym] = {
                    'rate': round(float(v / q), 2) if q else None,
                    'qty': float(q) if q else None,
                }
            rated = [month_avg[ym]['rate'] for ym in months if month_avg[ym]['rate'] is not None]
            change_pct = round((rated[-1] - rated[0]) / rated[0] * 100, 2) if (len(rated) >= 2 and rated[0]) else None
            # price spread across vendors (max avg - min avg) / min avg.
            avgs = [v['avg_rate'] for v in vendors if v['avg_rate'] is not None]
            spread_pct = round((max(avgs) - min(avgs)) / min(avgs) * 100, 2) if (len(avgs) >= 2 and min(avgs)) else None
            pid = pid_of.get(name)
            items.append({
                'item': name,
                'uom': (uom_votes[name].most_common(1)[0][0] if uom_votes[name] else ''),
                'category': self._product_category(pid) if pid else '',
                'cheapest_vendor': cheapest,
                'spread_pct': spread_pct,
                'change_pct': change_pct,
                'vendors': vendors,
                'month_avg': month_avg,
            })
        items.sort(key=lambda x: x['item'].lower())
        return {'items': items, 'months': months}

    # ── item qty & rate trend + top items ───────────────────────────────────
    def _rate_trend(self, qs):
        # Per item: total qty, total value, a per-MONTH average rate, and the
        # % change from the first month with a rate to the last.
        items = {}          # item name -> aggregate
        months_seen = set()
        # month -> item -> [qty, value] for a qty-weighted average rate.
        month_acc = defaultdict(lambda: defaultdict(lambda: [Z, Z]))

        from collections import Counter
        uom_votes = defaultdict(Counter)   # item -> Counter of uoms seen
        pid_of = {}                        # item -> a product id (for category)
        for ln in qs:
            name = (ln.product.product_name if ln.product_id else (ln.description or '')).strip() or '—'
            qty = Decimal(str(ln.quantity or 0))
            val = Decimal(str(ln.amount or 0))
            it = items.setdefault(name, {
                'item': name, 'uom': '', 'category': '',
                'total_qty': Z, 'total_value': Z,
            })
            it['total_qty'] += qty
            it['total_value'] += val
            if ln.uom:
                uom_votes[name][ln.uom.strip().upper()] += 1
            if ln.product_id and name not in pid_of:
                pid_of[name] = ln.product_id
            if ln.bill_id and ln.bill.bill_date:
                ym = ln.bill.bill_date.strftime('%Y-%m')
                months_seen.add(ym)
                acc = month_acc[ym][name]
                acc[0] += qty
                acc[1] += val

        months = sorted(months_seen)
        out = []
        for name, it in items.items():
            # Category = the product's DOMINANT purchase category (RM / PM),
            # same rule as the Stock page — not whatever a single line's bill
            # happened to be tagged. UOM = the most-seen unit for the item.
            pid = pid_of.get(name)
            it['category'] = self._product_category(pid) if pid else ''
            it['uom'] = (uom_votes[name].most_common(1)[0][0] if uom_votes[name] else '')
            # One point per month (aligned to `months`): qty-weighted avg rate +
            # total qty, or nulls when nothing was bought that month. This is the
            # exact shape the Report's rate-trend table renders (it.points).
            points = []
            for ym in months:
                q, v = month_acc[ym].get(name, (Z, Z))
                points.append({
                    'month': ym,
                    'rate': round(float(v / q), 2) if q else None,
                    'qty': float(q) if q else None,
                })
            rated = [p['rate'] for p in points if p['rate'] is not None]
            change_pct = None
            if len(rated) >= 2 and rated[0]:
                change_pct = (rated[-1] - rated[0]) / rated[0] * 100
            out.append({
                'item': name, 'uom': it['uom'], 'category': it['category'],
                'total_qty': str(it['total_qty']),
                'total_value': str(it['total_value']),
                'points': points,
                # 'dropped' = the latest rate fell vs the previous one (flag the
                # most-recent cell red in the table).
                'dropped': bool(len(rated) >= 2 and rated[-1] < rated[-2]),
                'change_pct': round(change_pct, 2) if change_pct is not None else None,
            })
        out.sort(key=lambda x: Decimal(x['total_value']), reverse=True)
        return {'items': out, 'months': months}

    # ── vendor comparison ────────────────────────────────────────────────────
    def _vendor_comparison(self, qs):
        # Per item, the vendors who supplied it and each vendor's qty / avg rate /
        # amount, flagging the cheapest (lowest avg rate). Only items bought from
        # 2+ vendors are interesting, so filter to those.
        acc = defaultdict(lambda: {'pid': None, 'vendors': defaultdict(lambda: [Z, Z])})
        for ln in qs:
            name = (ln.product.product_name if ln.product_id else (ln.description or '')).strip() or '—'
            vend = (ln.bill.vendor.vendor_name if (ln.bill_id and ln.bill.vendor_id) else '—')
            qty = Decimal(str(ln.quantity or 0))
            val = Decimal(str(ln.amount or 0))
            entry = acc[name]
            if entry['pid'] is None and ln.product_id:
                entry['pid'] = ln.product_id
            v = entry['vendors'][vend]
            v[0] += qty
            v[1] += val

        items = []
        for name, entry in acc.items():
            vendors = []
            for vend, (qty, val) in entry['vendors'].items():
                rate = float(val / qty) if qty else 0.0
                vendors.append({'vendor': vend, 'qty': str(qty), 'rate': round(rate, 2), 'amount': str(val)})
            if len(vendors) < 2:
                continue   # only multi-vendor items are worth comparing
            vendors.sort(key=lambda x: x['rate'])
            items.append({
                'item': name,
                'category': self._product_category(entry['pid']) if entry['pid'] else '',
                'cheapest_vendor': vendors[0]['vendor'] if vendors else None,
                'vendors': vendors,
            })
        items.sort(key=lambda x: x['item'].lower())
        return {'items': items}


class PurchaseItemVendorBillsView(APIView):
    """Bills for ONE item from ONE vendor — the expandable drill under the Item
    Drill-down's vendor-wise row.

    GET /api/purchase/item-vendor-bills/?item=<name>&vendor=<name>&company=&from=&to=

    Item + vendor are matched by the SAME keys the item-rate-trend view uses:
      item   = product.product_name (fallback to the line description)
      vendor = bill.vendor.vendor_name
    so the rows reconcile with the vendor-wise table that opened them.
    """
    permission_classes = [IsAuthenticated]
    module_name = 'Consolidated Report'

    def get(self, request):
        from .models import VendorBillLine

        item = (request.query_params.get('item') or '').strip()
        vendor = (request.query_params.get('vendor') or '').strip()
        company = (request.query_params.get('company') or '').strip() or None
        frm = _pd(request.query_params.get('from'))
        to = _pd(request.query_params.get('to'))

        if not item or not vendor:
            return Response({'item': item, 'vendor': vendor, 'rows': [],
                             'total_qty': 0.0, 'total_value': 0.0})

        qs = (VendorBillLine.objects.filter(is_active=True)
              .exclude(bill__status='CANCELLED')
              .exclude(_branch_line_q())
              .select_related('bill', 'bill__vendor', 'product'))
        if company:
            qs = qs.filter(bill__vendor__company_id=company)
        if frm:
            qs = qs.filter(bill__bill_date__gte=frm)
        if to:
            qs = qs.filter(bill__bill_date__lte=to)
        # Narrow by vendor name early to keep the scan small.
        qs = qs.filter(bill__vendor__vendor_name=vendor)

        rows = []
        tot_qty = Z
        tot_val = Z
        for ln in qs:
            name = (ln.product.product_name if ln.product_id else (ln.description or '')).strip() or '—'
            if name != item:
                continue
            bill = ln.bill
            qty = Decimal(str(ln.quantity or 0))
            val = Decimal(str(ln.amount or 0))
            tot_qty += qty
            tot_val += val
            rows.append({
                'bill_id': str(bill.id) if bill else None,
                'bill_no': (bill.bill_no or bill.vendor_invoice_no or '') if bill else '',
                'bill_date': bill.bill_date.isoformat() if (bill and bill.bill_date) else None,
                'month': bill.bill_date.strftime('%Y-%m') if (bill and bill.bill_date) else '',
                'qty': float(qty),
                'uom': ln.uom or '',
                'rate': float(Decimal(str(ln.rate or 0))),
                'amount': float(val),
                'tax_percent': float(Decimal(str(ln.tax_percent or 0))),
                'status': bill.status if bill else '',
            })

        rows.sort(key=lambda r: r['bill_date'] or '', reverse=True)
        return Response({
            'item': item, 'vendor': vendor, 'rows': rows,
            'total_qty': float(tot_qty), 'total_value': float(tot_val),
        })


# The Item Drill-down's category chips use these raw keys; product_category()
# normalizes them (MAIZE/BOUGHT_NOTE -> RM, PACKING -> PM), so a chip's key is
# mapped through the same table before comparison, keeping the dropdown both
# consistent with that filter AND actually matching the normalized category.
_CAT_NORMALIZE = {'RM': 'RM', 'PACKING': 'PM', 'MAIZE': 'RM', 'BOUGHT_NOTE': 'RM',
                  'PM': 'PM', 'FRUIT': 'FRUIT'}


class PurchaseVendorTurnoverView(APIView):
    """Vendor turnover pivot — vendor × month billed value, each vendor drilling
    into the items it supplied. The purchase analogue of the Sales Customer
    Turnover section.

    GET /api/purchase/vendor-turnover/?company=&from=&to=&category=<optional>

    Same keying + base scope as the item-rate-trend view (VendorBillLine,
    non-cancelled bills, company + date window; item = product.product_name or
    description; vendor = bill.vendor.vendor_name; month = bill_date %Y-%m).
    `category` filters to lines whose product's dominant purchase category
    (product_category(), normalized RM/PM/FRUIT) matches.
    """
    permission_classes = [IsAuthenticated]
    module_name = 'Consolidated Report'

    def get(self, request):
        from .models import VendorBillLine
        from .stock_views import product_category

        company = (request.query_params.get('company') or '').strip() or None
        frm = _pd(request.query_params.get('from'))
        to = _pd(request.query_params.get('to'))
        cat_key = (request.query_params.get('category') or '').strip().upper()
        want_cat = _CAT_NORMALIZE.get(cat_key, cat_key) if cat_key else None

        qs = (VendorBillLine.objects.filter(is_active=True)
              .exclude(bill__status='CANCELLED')
              .exclude(_branch_line_q())
              .select_related('bill', 'bill__vendor', 'product'))
        if company:
            qs = qs.filter(bill__vendor__company_id=company)
        if frm:
            qs = qs.filter(bill__bill_date__gte=frm)
        if to:
            qs = qs.filter(bill__bill_date__lte=to)

        # Cache product -> normalized category so we resolve each product once.
        cat_cache = {}

        def _cat(pid):
            if pid not in cat_cache:
                cat_cache[pid] = (product_category(pid) or '').upper() if pid else ''
            return cat_cache[pid]

        months_seen = set()
        # vendor -> { 'vendor_id', 'by_month': {ym: value}, 'items': {item: {...}} }
        vendors = {}
        for ln in qs:
            bill = ln.bill
            if not (bill and bill.bill_date):
                continue
            pid = ln.product_id
            if want_cat is not None and _cat(pid) != want_cat:
                continue
            vend = (bill.vendor.vendor_name if bill.vendor_id else '—')
            vid = str(bill.vendor_id) if bill.vendor_id else None
            item = (ln.product.product_name if pid else (ln.description or '')).strip() or '—'
            ym = bill.bill_date.strftime('%Y-%m')
            months_seen.add(ym)
            qty = Decimal(str(ln.quantity or 0))
            val = Decimal(str(ln.amount or 0))

            v = vendors.get(vend)
            if v is None:
                v = vendors[vend] = {'vendor_id': vid, 'by_month': defaultdict(lambda: Z), 'items': {}}
            v['by_month'][ym] += val
            it = v['items'].get(item)
            if it is None:
                it = v['items'][item] = {'uom': ln.uom or '', 'by_month': defaultdict(lambda: [Z, Z])}
            cell = it['by_month'][ym]
            cell[0] += qty
            cell[1] += val
            if ln.uom and not it['uom']:
                it['uom'] = ln.uom

        months = sorted(months_seen)
        out = []
        for name, v in vendors.items():
            v_total = sum(v['by_month'].values())
            by_month = {ym: float(v['by_month'][ym]) for ym in months if v['by_month'].get(ym)}
            by_month['total'] = float(v_total)
            items = []
            for iname, it in v['items'].items():
                tq = sum(c[0] for c in it['by_month'].values())
                tv = sum(c[1] for c in it['by_month'].values())
                items.append({
                    'item': iname, 'uom': it['uom'],
                    'by_month': {ym: {'qty': float(it['by_month'][ym][0]), 'value': float(it['by_month'][ym][1])}
                                 for ym in months if it['by_month'].get(ym)},
                    'total_qty': float(tq), 'total_value': float(tv),
                })
            items.sort(key=lambda x: x['total_value'], reverse=True)
            out.append({
                'vendor': name, 'vendor_id': v['vendor_id'],
                'by_month': by_month, '_total': float(v_total), 'items': items,
            })
        out.sort(key=lambda x: x['_total'], reverse=True)
        for v in out:
            v.pop('_total', None)
        return Response({'months': months, 'vendors': out})

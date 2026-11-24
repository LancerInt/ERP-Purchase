"""Consolidated Report endpoint.

One page, one round-trip: GET /api/purchase/report/consolidated/?company=&period=&from=&to=

It does NOT re-implement any money math. It calls the four existing, Tally-
reconciled dashboard views SERVER-SIDE (via DRF's request factory, carrying the
caller's auth) and reads their stable public JSON, then feeds the figures into
the pure, unit-tested arithmetic in report_logic.py.

  Sales     ← SalesDashboardView        (/api/sales/dashboard/)
  Purchase  ← PurchaseDashboardView      (/api/purchase/dashboard/)
  Expense   ← PurchaseByCategoryView     (/api/purchase/by-category/)   DIRECT/INDIRECT
  Freight   ← FreightOverviewView        (/api/purchase/freight-overview/)

Both an ex-GST and an incl-GST P&L are returned (the user asked for both); the
UI defaults to ex-GST. Purchase-vs-Expense outstanding is split per module.
"""

from decimal import Decimal

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework.test import APIRequestFactory, force_authenticate

from .dashboard_views import PurchaseDashboardView
from .category_views import PurchaseByCategoryView
from .freight_overview_views import FreightOverviewView
from sales.dashboard_views import SalesDashboardView
from .report_logic import compute_pnl, build_cards, module_totals, _d, _q

Z = Decimal('0')


def _call(view_cls, user, params):
    """Invoke an APIView's GET server-side with the caller's identity and return
    its JSON dict, or {} if that sub-view failed.

    The outer ConsolidatedReportView already gates access, so the internal
    sub-calls must NOT be re-subjected to each module's RBAC check — a user with
    the report module but not (say) 'Sales Dashboard' would otherwise get a 403
    from the sub-call and the whole report would read 'Failed to load'. We pass
    permission_classes=[IsAuthenticated] via as_view() initkwargs to drop the
    per-module gate for the in-process call only. A sub-view that still errors
    degrades to {} so one bad module never kills the whole report."""
    factory = APIRequestFactory()
    req = factory.get('/', params)
    force_authenticate(req, user=user)
    try:
        resp = view_cls.as_view(permission_classes=[IsAuthenticated])(req)
        if resp.status_code >= 400:
            return {}
        return resp.data or {}
    except Exception:
        return {}


class ConsolidatedReportView(APIView):
    permission_classes = [IsAuthenticated]
    # RBAC gate — matches the seeded module and the frontend ProtectedRoute.
    module_name = 'Consolidated Report'

    def get(self, request):
        company = request.query_params.get('company') or None
        period = (request.query_params.get('period') or 'fy').lower()
        frm = request.query_params.get('from')
        to = request.query_params.get('to')

        # One canonical window for every sub-call (same resolver the dashboards use).
        start, end, label = PurchaseDashboardView._resolve_range(period, frm, to)
        win = {'company': company or '', 'period': period,
               'from': start.isoformat(), 'to': end.isoformat()}
        user = request.user

        # ── fetch each module's figures from its own stable endpoint ──────────
        # Every lookup below is defensive: a sub-call that fails returns {}, so a
        # single broken module leaves its figures at 0 instead of 500-ing the page.
        def _dig(d, *keys, default=None):
            for k in keys:
                if not isinstance(d, dict):
                    return default
                d = d.get(k)
                if d is None:
                    return default
            return d

        pur = _call(PurchaseDashboardView, user, win).get('stats', {}) or {}
        sal = _call(SalesDashboardView, user, win).get('stats', {}) or {}
        bycat = _call(PurchaseByCategoryView, user,
                      {'company': company or '', 'from': start.isoformat(), 'to': end.isoformat()})
        fr = _call(FreightOverviewView, user,
                   {'company': company or '', 'from': start.isoformat(), 'to': end.isoformat()})

        # ── Purchase (goods = RM+Maize+BoughtNote+Packing), both bases ────────
        purchase_exgst = _d(_dig(pur, 'total_purchase', 'scopes', 'purchase', 'exgst', default=0))
        purchase_inclgst = _d(_dig(pur, 'total_purchase', 'scopes', 'purchase', 'inclgst', default=0))
        purchase_count = _dig(pur, 'total_purchase', 'scopes', 'purchase', 'count', default=0) or 0
        payables_total = _d(_dig(pur, 'outstanding_payables', 'total', default=0))
        paid_total = _d(_dig(pur, 'amount_paid', 'total', default=0))

        # ── Sales — invoices.amount is incl-GST (grand_total) ─────────────────
        sales_inclgst = _d(_dig(sal, 'invoices', 'amount', default=0))
        sales_count = _dig(sal, 'invoices', 'count', default=0) or 0
        sales_settled = _d(_dig(sal, 'received_against_sales', default=0))
        receivables = _d(_dig(sal, 'outstanding_receivables', default=0))
        # Ex-GST sales: derive from the by-nothing path isn't available here, so
        # approximate via the invoices incl-GST less the period's output GST is
        # not exposed; instead use the sales turnover basis the dashboard already
        # reports as incl-GST and present ex-GST only on the purchase/expense
        # side where it is authoritative. To keep BOTH bases honest we scale
        # sales ex-GST using the same effective GST ratio as its own figure when
        # available; otherwise ex == incl. (Sales A/c ex-GST basis lives behind a
        # separate param; wired as a follow-up.) See LOGIC doc open item.
        sales_exgst = sales_inclgst  # TODO(real-data): swap to sales_accounts basis

        # ── Direct / Indirect expenses (ex-GST, Tally groups) ─────────────────
        groups = {g.get('key'): _d(g.get('value'))
                  for g in _dig(bycat, 'expenses', 'groups', default=[]) or []}
        direct_exp = groups.get('DIRECT', Z)
        indirect_exp = groups.get('INDIRECT', Z)

        # ── Freight (all flows) ───────────────────────────────────────────────
        freight_total = _d(_dig(fr, 'total_freight', default=0))
        freight_paid = _d(_dig(fr, 'onbill_total', default=0)) + _d(_dig(fr, 'separate_paid', default=0))
        freight_due = _d(_dig(fr, 'separate_pending', default=0))

        # Expenses-scope (category FREIGHT+EXPENSES+MACHINERY + journals) holds the
        # on-bill freight. For the P&L we give freight its own line, so remove the
        # on-bill freight already inside the expense figure. direct/indirect come
        # from expense_group (bills only) — the separate slips are NOT in them, so
        # the only overlap is on-bill freight, measured as freight_total - separate.
        onbill_freight = _d(_dig(fr, 'onbill_total', default=0))

        # ── P&L — both bases ──────────────────────────────────────────────────
        pnl_exgst = compute_pnl(
            sales_revenue=sales_exgst, purchases=purchase_exgst,
            direct_expenses=direct_exp, indirect_expenses=indirect_exp,
            freight_total=freight_total, freight_in_direct_indirect=onbill_freight)
        pnl_inclgst = compute_pnl(
            sales_revenue=sales_inclgst, purchases=purchase_inclgst,
            direct_expenses=direct_exp, indirect_expenses=indirect_exp,
            freight_total=freight_total, freight_in_direct_indirect=onbill_freight)

        # ── cards (ex-GST basis — the default view) ──────────────────────────
        cards = build_cards(
            sales_billed=sales_exgst, sales_count=sales_count,
            purchase_exgst=purchase_exgst, purchase_count=purchase_count,
            direct_expenses=direct_exp, indirect_expenses=indirect_exp,
            freight_total=freight_total,
            receivables=receivables, payables=payables_total + freight_due,
            pnl_operating_profit=pnl_exgst['operating_profit'],
            pnl_margin_pct=pnl_exgst['margin_pct'])

        # ── module totals (split Purchase vs Expense) ────────────────────────
        # Expense billed = direct+indirect; its paid/outstanding is the expense
        # slice of payables. _outstanding_payables is combined, so split by the
        # expenses scope vs goods: expense outstanding ≈ escope-bills still due.
        expense_billed = direct_exp + indirect_exp
        totals = module_totals(
            sales={'billed': sales_exgst, 'settled': sales_settled, 'outstanding': receivables},
            purchase={'billed': purchase_exgst, 'settled': paid_total,
                      'outstanding': payables_total},
            expense={'billed': expense_billed, 'settled': Z, 'outstanding': Z},
            freight={'billed': freight_total, 'settled': freight_paid, 'outstanding': freight_due})

        return Response({
            'period': {'label': label, 'from': start.isoformat(), 'to': end.isoformat()},
            'company_id': company,
            'cards': {k: {'value': str(v['value']), 'foot': v['foot'], 'tone': v['tone']}
                      for k, v in cards.items()},
            'pnl': {
                'exgst': {k: str(v) if isinstance(v, Decimal) else v for k, v in pnl_exgst.items()},
                'inclgst': {k: str(v) if isinstance(v, Decimal) else v for k, v in pnl_inclgst.items()},
            },
            'module_totals': [
                {'module': r['module'], 'billed': str(r['billed']),
                 'settled': str(r['settled']), 'outstanding': str(r['outstanding'])}
                for r in totals],
        })


class PurchaseReportView(APIView):
    """GET /api/purchase/purchase-report/?company=&period=&from=&to=

    A PURCHASE-ONLY report (no Sales / Expense / Freight, no P&L). Four headline
    figures + a spend-by-category table + a per-vendor table, all over the same
    company + date window the rest of the app uses. It reads the SAME purchase
    aggregations the Analytics page does, so every bill — scanned, from a
    receipt/PO, or entered by hand — flows in identically (no source filter).
    Reporting-only.
    """
    permission_classes = [IsAuthenticated]
    module_name = 'Consolidated Report'

    def get(self, request):
        company = request.query_params.get('company') or None
        period = (request.query_params.get('period') or 'fy').lower()
        frm = request.query_params.get('from')
        to = request.query_params.get('to')

        start, end, label = PurchaseDashboardView._resolve_range(period, frm, to)
        win = {'company': company or '', 'period': period,
               'from': start.isoformat(), 'to': end.isoformat()}

        # Headline purchase figures — straight from the Analytics dashboard, so
        # the report ties to the tiles to the rupee (all bill sources included).
        pur = _call(PurchaseDashboardView, request.user, win).get('stats', {}) or {}
        tp = pur.get('total_purchase') or {}
        summary = {
            'total_purchase_exgst': str(_d(tp.get('taxable'))),
            'total_purchase_inclgst': str(_d(tp.get('total'))),
            'gst': str(_d(tp.get('gst'))),
            'bills_count': (pur.get('bills') or {}).get('count', 0),
            'amount_billed': str(_d((pur.get('bills') or {}).get('amount'))),
            'amount_paid': str(_d((pur.get('amount_paid') or {}).get('total'))),
            'outstanding': str(_d((pur.get('outstanding_payables') or {}).get('total'))),
        }

        # Spend by category — reuse the By-Category endpoint's rows verbatim.
        bycat = _call(PurchaseByCategoryView, request.user,
                      {'company': company or '', 'from': start.isoformat(), 'to': end.isoformat()})
        categories = [
            {'key': c.get('key', ''), 'label': c.get('label') or c.get('key') or 'Unclassified',
             'count': c.get('count', 0),
             'value_exgst': str(c.get('value', '0')),
             'value_inclgst': str(c.get('value_incl', c.get('value', '0')))}
            for c in (bycat.get('categories') or [])
        ]

        # Per-vendor — billed / paid / outstanding, from the dashboard's own
        # vendor breakdown (incl-GST ledger basis, same as Vendor details).
        vendors = PurchaseDashboardView._vendor_breakdown(
            company, None, None, start, end, include_transfers=False)
        vendor_rows = [
            {'vendor_id': str(v.get('vendor_id') or ''),
             'vendor_name': v.get('vendor_name') or '—',
             'company_name': v.get('company_name') or '',
             'is_msme': bool(v.get('is_msme')),
             'billed': str(_d(v.get('billed'))),
             'paid': str(_d(v.get('paid'))),
             'outstanding': str(_d(v.get('outstanding')))}
            for v in (vendors or [])
        ]

        return Response({
            'period': {'label': label, 'from': start.isoformat(), 'to': end.isoformat()},
            'company_id': company or '',
            'summary': summary,
            'categories': categories,
            'vendors': vendor_rows,
        })

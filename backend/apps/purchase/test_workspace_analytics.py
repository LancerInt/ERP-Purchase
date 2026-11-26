"""Purchase workspace (Purchase Analytics) endpoints — derivation + edge tests.

Covers the endpoints the full-screen Purchase workspace is built on:
  - /api/purchase/monthly-breakdown/   (Purchase Trend)
  - /api/purchase/item-rate-trend/     (Item Analytics / Item Drill-down),
       default + mode=pivot (+include_single) + mode=vendor-comparison
  - /api/purchase/vendor-turnover/     (Vendor Turnover, + category filter)
  - /api/purchase/item-vendor-bills/   (Item Drill-down vendor row expand)
  - /api/purchase/branch-transfers/    (Branch Transfers)

Django TestCase + DRF APIClient, the project's test style. Two companies,
two products (one RM, one Packing/PM), two vendors supplying the same item
(so the multi-vendor pivot has something to compare), a single-vendor item,
a branch-transfer vendor, and a cancelled bill as noise — so every filter,
category, and edge has something to prove.
"""
import datetime
from decimal import Decimal

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from core.models import Company, Warehouse
from master.models import Vendor, Product
from purchase.models import VendorBill, VendorBillLine


TODAY = datetime.date.today()
FY_START = datetime.date(TODAY.year if TODAY.month >= 4 else TODAY.year - 1, 4, 1)
FY_END = datetime.date(FY_START.year + 1, 3, 31)
# Two distinct months inside the FY, so monthly pivots have >1 column.
M1 = FY_START + datetime.timedelta(days=5)    # ~April
M2 = FY_START + datetime.timedelta(days=70)   # ~June


def _bill(vendor, warehouse, *, taxable, gst, date, status='OPEN', category='RM',
          is_branch=False, cancelled=False, invoice_no=''):
    return VendorBill.objects.create(
        vendor=vendor, warehouse=warehouse, bill_date=date,
        vendor_invoice_no=invoice_no,
        subtotal=Decimal(str(taxable)), tax_amount=Decimal(str(gst)),
        total_amount=Decimal(str(taxable + gst)),
        status=('CANCELLED' if cancelled else status),
        purchase_category=('BRANCH' if is_branch else category),
    )


def _line(bill, product, *, qty, rate, uom='KG'):
    amount = Decimal(str(qty)) * Decimal(str(rate))
    return VendorBillLine.objects.create(
        bill=bill, product=product, quantity=Decimal(str(qty)),
        rate=Decimal(str(rate)), amount=amount, uom=uom,
    )


class WorkspaceAnalyticsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_superuser('wtester', 'w@example.com', 'pw12345')

        cls.ss = Company.objects.create(company_code='SSB-002', legal_name='SS Biochem', trade_name='SS Biochem', pan='AAAAA0000A')
        cls.uai = Company.objects.create(company_code='UAI-001', legal_name='United Agro', trade_name='United Agro')
        cls.wh_ss = Warehouse.objects.create(company=cls.ss, warehouse_code='WH-SS', name='SS WH')
        cls.wh_uai = Warehouse.objects.create(company=cls.uai, warehouse_code='WH-UAI', name='UAI WH')

        # Two normal SS vendors + a branch SS vendor + a UAI vendor.
        cls.v_a = Vendor.objects.create(vendor_code='V-A', vendor_name='Alpha Traders', company=cls.ss, vendor_type=['RM'])
        cls.v_b = Vendor.objects.create(vendor_code='V-B', vendor_name='Beta Supplies', company=cls.ss, vendor_type=['RM'])
        cls.v_branch = Vendor.objects.create(vendor_code='V-BR', vendor_name='SS Biochem - Blre', company=cls.ss, vendor_type=['RM'], is_branch=True)
        cls.v_uai = Vendor.objects.create(vendor_code='V-UAI', vendor_name='UAI Vendor', company=cls.uai, vendor_type=['RM'])

        # Products: Maize (RM, multi-vendor), Liner (Packing→PM, single-vendor).
        cls.p_maize = Product.objects.create(product_name='Maize', sku_code='SKU-MZ')
        cls.p_liner = Product.objects.create(product_name='Liner', sku_code='SKU-LN')

        # Maize bought from BOTH vendors, in two months, different rates —
        # so the vendor comparison + pivot + spread all have content.
        b1 = _bill(cls.v_a, cls.wh_ss, taxable=10000, gst=1800, date=M1, category='RM')
        _line(b1, cls.p_maize, qty=100, rate=100)          # Alpha, M1, ₹100
        b2 = _bill(cls.v_a, cls.wh_ss, taxable=12000, gst=2160, date=M2, category='RM')
        _line(b2, cls.p_maize, qty=100, rate=120)          # Alpha, M2, ₹120
        b3 = _bill(cls.v_b, cls.wh_ss, taxable=11000, gst=1980, date=M1, category='RM')
        _line(b3, cls.p_maize, qty=100, rate=110)          # Beta, M1, ₹110

        # Liner from ONE vendor only (single-vendor item), Packing category → PM.
        b4 = _bill(cls.v_a, cls.wh_ss, taxable=5000, gst=900, date=M1, category='PACKING')
        _line(b4, cls.p_liner, qty=50, rate=100, uom='PCS')

        # Branch-transfer bill (Maize via branch vendor) — excluded from purchases.
        cls.bbranch = _bill(cls.v_branch, cls.wh_ss, taxable=7000, gst=1260, date=M2, category='RM', invoice_no='BR-1')
        _line(cls.bbranch, cls.p_maize, qty=50, rate=140)

        # Cancelled Maize bill — noise, must be ignored everywhere.
        bc = _bill(cls.v_a, cls.wh_ss, taxable=99999, gst=0, date=M1, category='RM', cancelled=True)
        _line(bc, cls.p_maize, qty=999, rate=999)

        # UAI Maize bill (other company) — proves company scoping.
        bu = _bill(cls.v_uai, cls.wh_uai, taxable=8000, gst=1440, date=M1, category='RM')
        _line(bu, cls.p_maize, qty=80, rate=100)

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get(self, path, **params):
        params.setdefault('company', str(self.ss.id))
        params.setdefault('from', FY_START.isoformat())
        params.setdefault('to', FY_END.isoformat())
        r = self.client.get(path, params)
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.data

    def _item(self, items, name):
        return next((it for it in items if it['item'] == name), None)

    # ── auth ────────────────────────────────────────────────────────────────
    def test_endpoints_require_auth(self):
        anon = APIClient()
        for p in ('/api/purchase/monthly-breakdown/', '/api/purchase/vendor-turnover/',
                  '/api/purchase/item-vendor-bills/', '/api/purchase/branch-transfers/'):
            r = anon.get(p, {'company': str(self.ss.id)})
            self.assertIn(r.status_code, (401, 403), f'{p} should require auth, got {r.status_code}')

    # ── monthly-breakdown ─────────────────────────────────────────────────────
    def test_monthly_breakdown_net_and_scope(self):
        d = self._get('/api/purchase/monthly-breakdown/')
        rows = d['rows']
        # Purchases ex-GST = 10000+12000+11000 (Maize) + 5000 (Liner) = 38000.
        # Branch + cancelled EXCLUDED.
        self.assertEqual(Decimal(str(rows['purchases']['total'])), Decimal('38000'))
        # net = purchases + debit_notes - credit_notes (no notes here).
        self.assertEqual(Decimal(str(rows['net']['total'])),
                         Decimal(str(rows['purchases']['total'])))
        # branch transfers tracked separately (the one BR-1 bill, ₹7000 subtotal).
        self.assertEqual(Decimal(str(rows['branch_transfers']['total'])), Decimal('7000'))
        # every month key present + a 'total'; months list spans the FY.
        self.assertEqual(len(d['months']), 12)
        for key in ('purchases', 'debit_notes', 'credit_notes', 'net', 'branch_transfers', 'freight'):
            self.assertIn('total', rows[key])

    def test_monthly_breakdown_company_scoping(self):
        ss = self._get('/api/purchase/monthly-breakdown/', company=str(self.ss.id))
        uai = self._get('/api/purchase/monthly-breakdown/', company=str(self.uai.id))
        self.assertEqual(Decimal(str(ss['rows']['purchases']['total'])), Decimal('38000'))
        self.assertEqual(Decimal(str(uai['rows']['purchases']['total'])), Decimal('8000'))

    def test_monthly_breakdown_empty_window_is_clean_zero(self):
        # A window before any bill → zero totals, no crash.
        d = self._get('/api/purchase/monthly-breakdown/',
                      **{'from': '2000-04-01', 'to': '2000-04-30'})
        self.assertEqual(Decimal(str(d['rows']['purchases']['total'])), Decimal('0'))

    # ── item-rate-trend (default) ─────────────────────────────────────────────
    def test_rate_trend_excludes_branch_and_cancelled(self):
        d = self._get('/api/purchase/item-rate-trend/', side='purchase')
        maize = self._item(d['items'], 'Maize')
        self.assertIsNotNone(maize)
        # Maize qty = 100+100+100 = 300 (branch 50 + cancelled 999 excluded).
        self.assertEqual(Decimal(str(maize['total_qty'])), Decimal('300'))
        self.assertEqual(maize['category'], 'RM')
        liner = self._item(d['items'], 'Liner')
        self.assertEqual(liner['category'], 'PM')  # PACKING normalizes to PM

    # ── item-rate-trend (pivot) ───────────────────────────────────────────────
    def test_pivot_default_multi_vendor_only(self):
        d = self._get('/api/purchase/item-rate-trend/', side='purchase', mode='pivot')
        names = [it['item'] for it in d['items']]
        self.assertIn('Maize', names)       # 2 vendors → included
        self.assertNotIn('Liner', names)    # 1 vendor → excluded by default
        maize = self._item(d['items'], 'Maize')
        self.assertEqual(len(maize['vendors']), 2)
        # cheapest = lowest avg rate: Alpha avg (100,120)->110 vs Beta 110 — tie,
        # but both present; cheapest_vendor is set and is one of the two.
        self.assertIn(maize['cheapest_vendor'], ('Alpha Traders', 'Beta Supplies'))

    def test_pivot_include_single_adds_single_vendor_items(self):
        d = self._get('/api/purchase/item-rate-trend/', side='purchase', mode='pivot', include_single='1')
        names = [it['item'] for it in d['items']]
        self.assertIn('Liner', names)       # now included
        liner = self._item(d['items'], 'Liner')
        self.assertEqual(len(liner['vendors']), 1)

    def test_pivot_cells_rate_is_qty_weighted(self):
        d = self._get('/api/purchase/item-rate-trend/', side='purchase', mode='pivot')
        maize = self._item(d['items'], 'Maize')
        alpha = next(v for v in maize['vendors'] if v['vendor'] == 'Alpha Traders')
        # Alpha total value 10000+12000=22000 over 200 qty → avg 110.
        self.assertEqual(Decimal(str(alpha['avg_rate'])), Decimal('110'))

    # ── vendor-turnover ───────────────────────────────────────────────────────
    def test_vendor_turnover_totals_and_items(self):
        d = self._get('/api/purchase/vendor-turnover/')
        names = [v['vendor'] for v in d['vendors']]
        self.assertIn('Alpha Traders', names)
        self.assertIn('Beta Supplies', names)
        # branch vendor excluded? branch_transfer_q excludes is_branch, so no.
        self.assertNotIn('SS Biochem - Blre', names)
        alpha = next(v for v in d['vendors'] if v['vendor'] == 'Alpha Traders')
        # Alpha: Maize 22000 + Liner 5000 = 27000.
        self.assertEqual(Decimal(str(alpha['by_month']['total'])), Decimal('27000'))
        items = [i['item'] for i in alpha['items']]
        self.assertIn('Maize', items)
        self.assertIn('Liner', items)

    def test_vendor_turnover_category_filter(self):
        # RM keeps Maize; PM keeps Liner.
        d_rm = self._get('/api/purchase/vendor-turnover/', category='RM')
        alpha_rm = next(v for v in d_rm['vendors'] if v['vendor'] == 'Alpha Traders')
        self.assertEqual([i['item'] for i in alpha_rm['items']], ['Maize'])
        d_pm = self._get('/api/purchase/vendor-turnover/', category='PM')
        # Only Alpha has Liner (PM); Beta drops out entirely.
        alpha_pm = next((v for v in d_pm['vendors'] if v['vendor'] == 'Alpha Traders'), None)
        self.assertIsNotNone(alpha_pm)
        self.assertEqual([i['item'] for i in alpha_pm['items']], ['Liner'])
        self.assertNotIn('Beta Supplies', [v['vendor'] for v in d_pm['vendors']])

    # ── item-vendor-bills ─────────────────────────────────────────────────────
    def test_item_vendor_bills_filters_item_and_vendor(self):
        d = self._get('/api/purchase/item-vendor-bills/', item='Maize', vendor='Alpha Traders')
        self.assertEqual(len(d['rows']), 2)            # Alpha's two Maize bills
        self.assertEqual(Decimal(str(d['total_qty'])), Decimal('200'))
        self.assertEqual(Decimal(str(d['total_value'])), Decimal('22000'))
        # Beta's Maize bill not included.
        for row in d['rows']:
            self.assertNotEqual(row.get('bill_no'), None)

    def test_item_vendor_bills_unknown_pair_is_empty(self):
        d = self._get('/api/purchase/item-vendor-bills/', item='Maize', vendor='Nobody Ltd')
        self.assertEqual(d['rows'], [])
        self.assertEqual(Decimal(str(d['total_qty'])), Decimal('0'))

    # ── branch-transfers ──────────────────────────────────────────────────────
    def test_branch_transfers_scope_and_pan(self):
        d = self._get('/api/purchase/branch-transfers/')
        self.assertEqual(Decimal(str(d['total'])), Decimal('7000'))   # BR-1 subtotal
        self.assertEqual(d['branch_count'], 1)
        self.assertEqual(d['company_pan'], 'AAAAA0000A')
        self.assertEqual(len(d['bills']), 1)
        self.assertEqual(d['bills'][0]['branch'], 'SS Biochem - Blre')

    def test_branch_transfers_empty_when_no_branch_vendor(self):
        # UAI has no branch vendor → clean empty, no crash, blank-ish PAN.
        d = self._get('/api/purchase/branch-transfers/', company=str(self.uai.id))
        self.assertEqual(Decimal(str(d['total'])), Decimal('0'))
        self.assertEqual(d['branch_count'], 0)
        self.assertEqual(d['bills'], [])


class WorkspaceEdgeCaseTests(TestCase):
    """Edge cases a fresh fixture hides but real SSB/UAI data has: debit/credit
    notes netting, zero-qty lines, blank UOM, bills with no lines, and missing
    product names — none should crash or mis-count."""

    @classmethod
    def setUpTestData(cls):
        from sales.models import DebitNote
        cls.DebitNote = DebitNote
        cls.user = User.objects.create_superuser('etester', 'e@example.com', 'pw12345')
        cls.co = Company.objects.create(company_code='EDGE', legal_name='Edge Co', trade_name='Edge', pan='EEEEE1111E')
        cls.wh = Warehouse.objects.create(company=cls.co, warehouse_code='WH-E', name='Edge WH')
        cls.v = Vendor.objects.create(vendor_code='V-E', vendor_name='Edge Vendor', company=cls.co, vendor_type=['RM'])
        cls.p = Product.objects.create(product_name='EdgeItem', sku_code='SKU-E')

        # One normal purchase bill (₹10,000 taxable) with a line.
        b = _bill(cls.v, cls.wh, taxable=10000, gst=1800, date=M1, category='RM')
        _line(b, cls.p, qty=100, rate=100)

        # A DEBIT note (purchase return, booked on a purchase ledger) ₹1,000,
        # and a CREDIT note (vendor credit) ₹400, both in M1.
        DebitNote.objects.create(side='PURCHASE', note_type='DEBIT', amount=Decimal('1000'),
                                 note_date=M1, company=cls.co, vendor=cls.v, tally_group='Purchase Returns')
        DebitNote.objects.create(side='PURCHASE', note_type='CREDIT', amount=Decimal('400'),
                                 note_date=M1, company=cls.co, vendor=cls.v, tally_group='')
        # A DEBIT note on a NON-purchase ledger — a price adjustment, must NOT
        # count as a return (mirrors the dashboard rule).
        DebitNote.objects.create(side='PURCHASE', note_type='DEBIT', amount=Decimal('9999'),
                                 note_date=M1, company=cls.co, vendor=cls.v, tally_group='Indirect Incomes')

        # Zero-qty line (avg rate would divide by zero) on its own bill.
        bz = _bill(cls.v, cls.wh, taxable=0, gst=0, date=M2, category='RM')
        _line(bz, cls.p, qty=0, rate=0, uom='')
        # A bill with NO lines at all.
        _bill(cls.v, cls.wh, taxable=500, gst=90, date=M2, category='RM')

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get(self, path, **params):
        params.setdefault('company', str(self.co.id))
        params.setdefault('from', FY_START.isoformat())
        params.setdefault('to', FY_END.isoformat())
        r = self.client.get(path, params)
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.data

    def test_monthly_breakdown_nets_debit_and_credit_notes(self):
        d = self._get('/api/purchase/monthly-breakdown/')
        rows = d['rows']
        # purchases = 10000 (the zero line / empty-line bills add 0 / 500).
        self.assertEqual(Decimal(str(rows['purchases']['total'])), Decimal('10500'))
        # Debit notes = 1000 (the ₹9999 non-purchase-ledger note excluded).
        self.assertEqual(Decimal(str(rows['debit_notes']['total'])), Decimal('1000'))
        self.assertEqual(Decimal(str(rows['credit_notes']['total'])), Decimal('400'))
        # net = 10500 + 1000 - 400 = 11100.
        self.assertEqual(Decimal(str(rows['net']['total'])), Decimal('11100'))

    def test_zero_qty_line_does_not_crash_rate_trend(self):
        d = self._get('/api/purchase/item-rate-trend/', side='purchase')
        item = next((it for it in d['items'] if it['item'] == 'EdgeItem'), None)
        self.assertIsNotNone(item)
        # 100 (normal) + 0 (zero line) = 100; no ZeroDivision.
        self.assertEqual(Decimal(str(item['total_qty'])), Decimal('100'))
        # Any month whose qty is 0 reports a null rate, not a crash.
        for p in item['points']:
            if not p['qty']:
                self.assertIsNone(p['rate'])

    def test_pivot_include_single_handles_zero_qty(self):
        d = self._get('/api/purchase/item-rate-trend/', side='purchase', mode='pivot', include_single='1')
        item = next((it for it in d['items'] if it['item'] == 'EdgeItem'), None)
        self.assertIsNotNone(item)   # single vendor, present with include_single
        v = item['vendors'][0]
        # avg_rate from 10000/100 = 100 (zero-qty month contributes nothing).
        self.assertEqual(Decimal(str(v['avg_rate'])), Decimal('100'))

    def test_vendor_turnover_survives_blank_uom_and_zero(self):
        d = self._get('/api/purchase/vendor-turnover/')
        self.assertTrue(len(d['vendors']) >= 1)
        v = d['vendors'][0]
        # total value = 10000 (+0 from the zero line).
        self.assertEqual(Decimal(str(v['by_month']['total'])), Decimal('10000'))

    def test_item_vendor_bills_handles_zero_qty_line(self):
        d = self._get('/api/purchase/item-vendor-bills/', item='EdgeItem', vendor='Edge Vendor')
        # 2 lines for this item+vendor (the ₹100 one + the zero one).
        self.assertEqual(len(d['rows']), 2)
        self.assertEqual(Decimal(str(d['total_qty'])), Decimal('100'))

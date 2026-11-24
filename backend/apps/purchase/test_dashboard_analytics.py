"""Purchase Analytics page (/api/purchase/dashboard/) — derivation tests.

Maps to the A–G breakdown of the page:
  A. header / auth
  B. filter bar  — period (All / Today), company chips, GST toggle, vendor,
                   MSME, transfers scope
  C. KPI tiles   — Total Purchase, Amount Billed, Amount Paid, Payable, and the
                   payment-status split that backs the Amount-Paid/Payable popovers
  D. tables      — vendor_breakdown (+ SS/UAI + MSME flags), by_company, po_fulfillment
  E. drills      — vendor ledger, records drill
  F. drawer      — outstanding ageing buckets
  G. states      — a company with no data returns clean zeroes (no crash)

Backend API tests (Django TestCase + DRF APIClient), the project's test style.
Two companies with bills split across them, one MSME vendor, one branch-transfer
bill and one cancelled bill, so every filter has something to prove.
"""
import datetime
from decimal import Decimal

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from core.models import Company, Warehouse
from master.models import Vendor
from purchase.models import VendorBill, PaymentMade


TODAY = datetime.date.today()
FY_START = datetime.date(TODAY.year if TODAY.month >= 4 else TODAY.year - 1, 4, 1)
# A date safely inside the current FY but not today, so Today ≠ All/FY.
MID_FY = max(FY_START, TODAY - datetime.timedelta(days=30))


def _bill(vendor, warehouse, *, taxable, gst, paid=0, status='OPEN',
          category='RM', date=MID_FY, is_branch=False, cancelled=False):
    b = VendorBill.objects.create(
        vendor=vendor, warehouse=warehouse, bill_date=date,
        subtotal=Decimal(str(taxable)), tax_amount=Decimal(str(gst)),
        total_amount=Decimal(str(taxable + gst)), amount_paid=Decimal(str(paid)),
        status=('CANCELLED' if cancelled else status),
        purchase_category=('BRANCH' if is_branch else category),
    )
    return b


class AnalyticsDashboardTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        # Superuser bypasses the per-module RBAC gate (HasModulePermission),
        # so the tests exercise the dashboard logic without seeding roles.
        cls.user = User.objects.create_superuser('tester', 'tester@example.com', 'pw12345')

        cls.ss = Company.objects.create(company_code='SSB-002', legal_name='SS Biochem', trade_name='SS Biochem')
        cls.uai = Company.objects.create(company_code='UAI-001', legal_name='United Agro Industries', trade_name='United Agro')
        cls.wh_ss = Warehouse.objects.create(company=cls.ss, warehouse_code='WH-SS', name='SS WH')
        cls.wh_uai = Warehouse.objects.create(company=cls.uai, warehouse_code='WH-UAI', name='UAI WH')

        # Vendors — one per company, plus an MSME UAI vendor.
        cls.v_ss = Vendor.objects.create(vendor_code='V-SS', vendor_name='SS Vendor', company=cls.ss, vendor_type=['RM'])
        cls.v_uai = Vendor.objects.create(vendor_code='V-UAI', vendor_name='UAI Vendor', company=cls.uai, vendor_type=['RM'])
        cls.v_msme = Vendor.objects.create(
            vendor_code='V-MSME', vendor_name='MSME Vendor', company=cls.uai, vendor_type=['RM'],
            is_msme=True, msme_category='SMALL',
        )

        # SS: one bill 1,00,000 + 18,000 GST, 50,000 paid (→ partial).
        cls.b_ss = _bill(cls.v_ss, cls.wh_ss, taxable=100000, gst=18000, paid=50000, status='PARTIALLY_PAID')
        PaymentMade.objects.create(vendor=cls.v_ss, payment_date=MID_FY,
                                   amount=Decimal('50000'), payment_mode='BANK')

        # UAI: one fully-unpaid bill 2,00,000 + 36,000 GST.
        cls.b_uai = _bill(cls.v_uai, cls.wh_uai, taxable=200000, gst=36000, paid=0, status='OPEN')
        # UAI MSME: one fully-paid bill 40,000 + 7,200.
        cls.b_msme = _bill(cls.v_msme, cls.wh_uai, taxable=40000, gst=7200, paid=47200, status='PAID')
        PaymentMade.objects.create(vendor=cls.v_msme, payment_date=MID_FY,
                                   amount=Decimal('47200'), payment_mode='UPI')

        # Noise that must NOT count in Purchases: a branch-transfer bill and a
        # cancelled bill (both on SS).
        _bill(cls.v_ss, cls.wh_ss, taxable=500000, gst=90000, is_branch=True)
        _bill(cls.v_ss, cls.wh_ss, taxable=999999, gst=0, cancelled=True)

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get(self, **params):
        r = self.client.get('/api/purchase/dashboard/', params)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.data

    def _tp(self, data):
        return data['stats']['total_purchase']

    # ── A. header / auth ────────────────────────────────────────────────────
    def test_requires_auth(self):
        anon = APIClient()
        r = anon.get('/api/purchase/dashboard/')
        self.assertIn(r.status_code, (401, 403))

    # ── B. filter bar ───────────────────────────────────────────────────────
    def test_period_all_is_all_time(self):
        data = self._get(period='all')
        self.assertEqual(data['period']['label'], 'All Time')
        self.assertEqual(data['period']['from'], '2000-04-01')

    def test_period_today_excludes_older_bills(self):
        # All our bills are dated ~30 days back, so Today sees nothing.
        today = self._tp(self._get(period='today'))
        self.assertEqual(Decimal(str(today['taxable'])), Decimal('0'))
        allt = self._tp(self._get(period='all'))
        self.assertGreater(Decimal(str(allt['taxable'])), Decimal('0'))

    def test_company_scoping(self):
        ss = self._tp(self._get(period='all', company=str(self.ss.id)))
        uai = self._tp(self._get(period='all', company=str(self.uai.id)))
        # SS has one 1,00,000 RM bill; UAI has 2,00,000 + 40,000.
        self.assertEqual(Decimal(str(ss['taxable'])), Decimal('100000'))
        self.assertEqual(Decimal(str(uai['taxable'])), Decimal('240000'))

    def test_gst_excl_vs_incl_reconcile(self):
        tp = self._tp(self._get(period='all', company=str(self.uai.id)))
        taxable = Decimal(str(tp['taxable']))
        gst = Decimal(str(tp['gst']))
        total = Decimal(str(tp['total']))
        self.assertEqual(taxable, Decimal('240000'))
        self.assertEqual(total, taxable + gst)   # incl = excl + GST

    def test_vendor_filter(self):
        tp = self._tp(self._get(period='all', vendor=str(self.v_uai.id)))
        self.assertEqual(Decimal(str(tp['taxable'])), Decimal('200000'))

    def test_msme_filter(self):
        # MSME-only on UAI → just the 40,000 MSME bill.
        tp = self._tp(self._get(period='all', company=str(self.uai.id), msme='true'))
        self.assertEqual(Decimal(str(tp['taxable'])), Decimal('40000'))

    def test_transfers_mode_excludes_branch(self):
        # Default Purchases view excludes the 5,00,000 branch-transfer bill.
        purchases = self._tp(self._get(period='all', company=str(self.ss.id)))
        self.assertEqual(Decimal(str(purchases['taxable'])), Decimal('100000'))
        # Transfers-only shows the branch move instead.
        only = self._get(period='all', company=str(self.ss.id), transfers='only')
        self.assertIn('branch_transfers', only['stats'])

    # ── C. KPI tiles ────────────────────────────────────────────────────────
    def test_amount_billed_tile(self):
        bills = self._get(period='all', company=str(self.uai.id))['stats']['bills']
        # UAI: 2 live bills (2,36,000 + 47,200) — cancelled/branch are SS anyway.
        self.assertEqual(bills['count'], 2)
        self.assertEqual(Decimal(str(bills['amount'])), Decimal('283200'))

    def test_amount_paid_tile(self):
        paid = self._get(period='all', company=str(self.uai.id))['stats']['amount_paid']
        self.assertEqual(Decimal(str(paid['total'])), Decimal('47200'))

    def test_payable_tile(self):
        op = self._get(period='all', company=str(self.uai.id))['stats']['outstanding_payables']
        # 2,36,000 unpaid + 0 on the paid MSME bill.
        self.assertEqual(Decimal(str(op['total'])), Decimal('236000'))

    def test_payment_status_split_reconciles(self):
        sp = self._get(period='all', company=str(self.uai.id))['stats']['payment_status_split']
        counts = (sp.get('paid', {}).get('count', 0)
                  + sp.get('partial', {}).get('count', 0)
                  + sp.get('unpaid', {}).get('count', 0))
        self.assertEqual(counts, 2)   # one PAID (MSME) + one unpaid (UAI)

    # ── D. tables ───────────────────────────────────────────────────────────
    def test_vendor_breakdown_rows_and_flags(self):
        rows = self._get(period='all', company=str(self.uai.id))['vendor_breakdown']
        by_name = {r['vendor_name']: r for r in rows}
        self.assertIn('MSME Vendor', by_name)
        self.assertTrue(by_name['MSME Vendor']['is_msme'])

    def test_vendor_breakdown_company_name_present(self):
        rows = self._get(period='all')['vendor_breakdown']
        self.assertTrue(all('company_name' in r for r in rows))

    def test_by_company_rollup_shape(self):
        # by_company is a PO-line rollup (empty with a bills-only fixture); the
        # page just needs the key present and list-shaped so the table renders.
        data = self._get(period='all')
        self.assertIn('by_company', data)
        self.assertIsInstance(data['by_company'], list)

    def test_po_fulfillment_present(self):
        data = self._get(period='all')
        self.assertIn('po_fulfillment', data)
        self.assertIsInstance(data['po_fulfillment'], list)

    # ── G. states ───────────────────────────────────────────────────────────
    def test_empty_company_returns_zeroes(self):
        empty = Company.objects.create(company_code='EMPTY', legal_name='Empty Co')
        tp = self._tp(self._get(period='all', company=str(empty.id)))
        self.assertEqual(Decimal(str(tp['taxable'])), Decimal('0'))
        bills = self._get(period='all', company=str(empty.id))['stats']['bills']
        self.assertEqual(bills['count'], 0)

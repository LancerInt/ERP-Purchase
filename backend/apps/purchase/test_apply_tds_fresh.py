"""Regression tests for apply_tds after it was rewired onto the fresh TDS logic.

Proves the ERP GUARDS survived the rewire (per-company enable flag, branch-
transfer skip, agri/maize exemption) AND that the new section/rate math is what
the prototype specifies (194Q on the ₹50L-excess, 194C on freight). Bill-save is
exercised end-to-end via apply_tds(bill), so a regression here would mean wrong
TDS stamped on real bills.
"""
from datetime import date
from decimal import Decimal

from django.test import TestCase

from core.models import Company
from master.models import Vendor
from purchase.models import VendorBill
from purchase.tds_engine import apply_tds

D = Decimal


class ApplyTdsFreshTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        # Engine ON for this company (else apply_tds returns None by design).
        cls.company = Company.objects.create(
            company_code='TDF', legal_name='TDS Fresh Co', tds_engine_enabled=True)
        cls.vendor = Vendor.objects.create(
            vendor_name='Acme Pvt Ltd', company=cls.company,
            pan='AAACC7215H', deductee_category='COMPANY_FIRM_LLP')

    def _bill(self, *, subtotal, cat='RM', tax='0', vendor=None, date_=date(2026, 5, 10)):
        return VendorBill.objects.create(
            vendor=vendor or self.vendor, vendor_invoice_no='B',
            bill_date=date_, subtotal=D(subtotal), tax_amount=D(tax),
            total_amount=D(subtotal) + D(tax), purchase_category=cat, status='OPEN')

    # ── guards ────────────────────────────────────────────────────────────
    def test_engine_off_returns_none(self):
        co = Company.objects.create(company_code='OFF', legal_name='Off Co',
                                    tds_engine_enabled=False)
        v = Vendor.objects.create(vendor_name='V', company=co, pan='AAACC7215H')
        b = self._bill(subtotal='6000000', vendor=v)
        self.assertIsNone(apply_tds(b, save=False))

    def test_branch_transfer_no_tds(self):
        v = Vendor.objects.create(vendor_name='Sister Unit', company=self.company,
                                  pan='AAACC7215H', is_branch=True)
        b = self._bill(subtotal='6000000', vendor=v)
        res = apply_tds(b, save=False)
        self.assertEqual(res['tds_amount'], D('0'))
        self.assertEqual(b.tds_status, 'NONE_DUE')

    def test_agri_maize_exempt(self):
        b = self._bill(subtotal='6000000', cat='MAIZE')
        res = apply_tds(b, save=False)
        self.assertEqual(res['tds_amount'], D('0'))
        self.assertEqual(b.tds_status, 'NONE_DUE')

    # ── fresh section/rate math ─────────────────────────────────────────────
    def test_goods_below_50L_no_tds(self):
        b = self._bill(subtotal='4000000', cat='RM')          # ₹40L < ₹50L
        res = apply_tds(b, save=False)
        self.assertEqual(res['section'], '194Q')
        self.assertEqual(res['tds_amount'], D('0.00'))

    def test_goods_above_50L_taxes_excess(self):
        b = self._bill(subtotal='6000000', cat='RM')          # ₹60L, no prior YTD
        res = apply_tds(b, save=False)
        self.assertEqual(res['section'], '194Q')
        # 0.1% of (60L - 50L) = 0.1% of 10L = 1000
        self.assertEqual(res['tds_amount'], D('1000.00'))
        self.assertEqual(b.computed_tds_section, '194Q')

    def test_194q_uses_fy_aggregate_across_bills(self):
        # Prior ₹45L goods bill + this ₹10L bill → aggregate ₹55L, excess ₹5L.
        self._bill(subtotal='4500000', cat='RM', date_=date(2026, 4, 5))
        b = self._bill(subtotal='1000000', cat='RM', date_=date(2026, 6, 1))
        res = apply_tds(b, save=False)
        # excess over 50L = 5L → 0.1% = 500
        self.assertEqual(res['tds_amount'], D('500.00'))

    def test_freight_is_194c_2pct(self):
        v = Vendor.objects.create(vendor_name='KPN Transport Co', company=self.company,
                                  pan='AAFCK9921L', deductee_category='COMPANY_FIRM_LLP')
        b = self._bill(subtotal='50000', cat='FREIGHT', vendor=v)
        res = apply_tds(b, save=False)
        self.assertEqual(res['section'], '194C')
        self.assertEqual(res['tds_amount'], D('1000.00'))     # 2% of 50000

    def test_persists_on_save(self):
        b = self._bill(subtotal='6000000', cat='RM')
        apply_tds(b, save=True)
        b.refresh_from_db()
        self.assertEqual(b.computed_tds_amount, D('1000.00'))
        self.assertEqual(b.computed_tds_section, '194Q')

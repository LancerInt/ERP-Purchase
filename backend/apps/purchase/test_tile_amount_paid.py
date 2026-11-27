"""Data-chain test 2 of N — the AMOUNT PAID tile ties to its source.

Amount Paid (stats.amount_paid.total) is the SETTLED figure: how much of the
period's PURCHASE bills has been paid, read off VendorBill.amount_paid (NOT off
PaymentMade — Zoho-imported bills carry a settled amount with no payment voucher,
so a payment-record sum would under-count). It must:
  - sum amount_paid over the same bills Total Purchase counts (purchase-only)
  - EXCLUDE Bought-Note / is_cash bills (farmer cash, not paid from a bank a/c)
  - EXCLUDE expense-like bills, cancelled, openings
  - be company-scoped

This documents the deliberate design difference from the Ledger (which is
payment-based) so the two measures aren't wrongly expected to be equal.

Django TestCase + DRF APIClient.
"""
import datetime
from decimal import Decimal

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from core.models import Company, Warehouse
from master.models import Vendor
from purchase.models import VendorBill

TODAY = datetime.date.today()
FY_START = datetime.date(TODAY.year if TODAY.month >= 4 else TODAY.year - 1, 4, 1)
FY_END = datetime.date(FY_START.year + 1, 3, 31)
D1 = FY_START + datetime.timedelta(days=10)


def _bill(vendor, wh, *, total, paid, date=D1, category='RM', is_cash=False,
          is_expense=False, status='OPEN'):
    return VendorBill.objects.create(
        vendor=vendor, warehouse=wh, bill_date=date,
        subtotal=Decimal(str(total)), tax_amount=Decimal('0'),
        total_amount=Decimal(str(total)), amount_paid=Decimal(str(paid)),
        status=status, purchase_category=category, is_cash=is_cash, is_expense=is_expense,
    )


def _dec(x):
    return Decimal(str(x))


class AmountPaidTileTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_superuser('aptester', 'ap@example.com', 'pw12345')
        cls.ss = Company.objects.create(company_code='SSB-002', legal_name='SS Biochem', trade_name='SS Biochem', pan='AAAAA0000A')
        cls.uai = Company.objects.create(company_code='UAI-001', legal_name='United Agro', trade_name='United Agro')
        cls.wh = Warehouse.objects.create(company=cls.ss, warehouse_code='WH-SS', name='SS WH')
        cls.wh_u = Warehouse.objects.create(company=cls.uai, warehouse_code='WH-U', name='U WH')
        cls.v = Vendor.objects.create(vendor_code='V-A', vendor_name='Alpha Traders', company=cls.ss, vendor_type=['RM'])
        cls.v_u = Vendor.objects.create(vendor_code='V-U', vendor_name='Gamma Co', company=cls.uai, vendor_type=['RM'])

        # Real purchase bills — settled amounts count: 2,00,000 + 1,50,000 = 3,50,000
        _bill(cls.v, cls.wh, total='500000', paid='200000', category='RM')
        _bill(cls.v, cls.wh, total='300000', paid='150000', category='PM')
        # Noise that must NOT count toward Amount Paid
        _bill(cls.v, cls.wh, total='100000', paid='100000', category='BOUGHT_NOTE')   # farmer cash
        _bill(cls.v, cls.wh, total='120000', paid='120000', category='RM', is_cash=True)  # cash
        _bill(cls.v, cls.wh, total='200000', paid='200000', category='EXPENSES', is_expense=True)  # expense
        _bill(cls.v, cls.wh, total='400000', paid='400000', category='RM', status='CANCELLED')     # cancelled
        _bill(cls.v_u, cls.wh_u, total='500000', paid='250000', category='RM')          # other company

        cls.EXPECTED = _dec('350000')

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def _paid(self, company):
        r = self.client.get('/api/purchase/dashboard/', {
            'company': str(company.id), 'period': 'custom',
            'from': FY_START.isoformat(), 'to': FY_END.isoformat(),
        })
        self.assertEqual(r.status_code, 200, r.content[:400])
        return _dec(r.json().get('stats', {}).get('amount_paid', {}).get('total'))

    def test_amount_paid_equals_settled_purchase_bills(self):
        self.assertEqual(self._paid(self.ss), self.EXPECTED,
                         f"Amount Paid should be settled purchase bills {self.EXPECTED}")

    def test_bought_note_and_cash_excluded(self):
        # Neither the 1,00,000 bought-note nor the 1,20,000 cash paid may be in it
        self.assertLess(self._paid(self.ss), self.EXPECTED + _dec('1'), 'bought-note/cash leaked')

    def test_expense_and_cancelled_excluded(self):
        self.assertNotEqual(self._paid(self.ss), self.EXPECTED + _dec('200000'), 'expense bill leaked')
        self.assertNotEqual(self._paid(self.ss), self.EXPECTED + _dec('400000'), 'cancelled bill leaked')

    def test_company_scope(self):
        self.assertEqual(self._paid(self.uai), _dec('250000'))

    def test_paid_never_exceeds_billed(self):
        # Sanity: Amount Paid <= Amount Billed for the same scope.
        r = self.client.get('/api/purchase/dashboard/', {
            'company': str(self.ss.id), 'period': 'custom',
            'from': FY_START.isoformat(), 'to': FY_END.isoformat(),
        })
        st = r.json().get('stats', {})
        billed = _dec(st.get('bills', {}).get('amount'))
        paid = _dec(st.get('amount_paid', {}).get('total'))
        self.assertLessEqual(paid, billed, 'Amount Paid exceeds Amount Billed')

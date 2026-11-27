"""Data-chain test 3 of N — the PAYABLE (Outstanding) tile ties to its source.

Payable (stats.outstanding_payables.total) = the still-unpaid balance of
purchase bills: Σ(total_amount − amount_paid) over bills NOT fully settled,
excluding opening carriers, expense-like bills and duplicates. It is the figure
that sits beside Total Purchase / Amount Paid and must be consistent with them:

  - fully-paid bills contribute 0
  - a part-paid bill contributes its remaining balance
  - expense / cancelled / opening bills never count
  - Payable ≈ Billed − Paid for the same purchase set (sanity)
  - company-scoped

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


def _bill(vendor, wh, *, total, paid, date=D1, category='RM', is_expense=False,
          status='OPEN'):
    return VendorBill.objects.create(
        vendor=vendor, warehouse=wh, bill_date=date,
        subtotal=Decimal(str(total)), tax_amount=Decimal('0'),
        total_amount=Decimal(str(total)), amount_paid=Decimal(str(paid)),
        status=status, purchase_category=category, is_expense=is_expense,
    )


def _dec(x):
    return Decimal(str(x))


class PayableTileTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_superuser('pytester', 'py@example.com', 'pw12345')
        cls.ss = Company.objects.create(company_code='SSB-002', legal_name='SS Biochem', trade_name='SS Biochem', pan='AAAAA0000A')
        cls.uai = Company.objects.create(company_code='UAI-001', legal_name='United Agro', trade_name='United Agro')
        cls.wh = Warehouse.objects.create(company=cls.ss, warehouse_code='WH-SS', name='SS WH')
        cls.wh_u = Warehouse.objects.create(company=cls.uai, warehouse_code='WH-U', name='U WH')
        cls.v = Vendor.objects.create(vendor_code='V-A', vendor_name='Alpha Traders', company=cls.ss, vendor_type=['RM'])
        cls.v_u = Vendor.objects.create(vendor_code='V-U', vendor_name='Gamma Co', company=cls.uai, vendor_type=['RM'])

        # Unpaid balances that SHOULD count:
        #   bill1: 5,00,000 total, 2,00,000 paid → 3,00,000 open
        #   bill2: 3,00,000 total, 0 paid        → 3,00,000 open
        # fully-paid bill3 contributes 0.  Total expected = 6,00,000
        _bill(cls.v, cls.wh, total='500000', paid='200000', category='RM')
        _bill(cls.v, cls.wh, total='300000', paid='0', category='PM')
        _bill(cls.v, cls.wh, total='150000', paid='150000', category='RM', status='PAID')  # settled → 0

        # Noise that must NOT add to Payable
        _bill(cls.v, cls.wh, total='200000', paid='0', category='EXPENSES', is_expense=True)  # expense
        _bill(cls.v, cls.wh, total='400000', paid='0', category='RM', status='CANCELLED')      # cancelled
        _bill(cls.v_u, cls.wh_u, total='500000', paid='100000', category='RM')                 # other company → 4,00,000

        cls.EXPECTED = _dec('600000')

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def _stats(self, company):
        r = self.client.get('/api/purchase/dashboard/', {
            'company': str(company.id), 'period': 'custom',
            'from': FY_START.isoformat(), 'to': FY_END.isoformat(),
        })
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json().get('stats', {})

    def _payable(self, company):
        return _dec(self._stats(company).get('outstanding_payables', {}).get('total'))

    def test_payable_equals_unpaid_purchase_balances(self):
        self.assertEqual(self._payable(self.ss), self.EXPECTED,
                         f"Payable should be the unpaid purchase balances {self.EXPECTED}")

    def test_fully_paid_bill_contributes_zero(self):
        # If it counted the settled bill's total, it'd be 1,50,000 higher.
        self.assertNotEqual(self._payable(self.ss), self.EXPECTED + _dec('150000'), 'settled bill leaked')

    def test_expense_and_cancelled_excluded(self):
        self.assertLess(self._payable(self.ss), self.EXPECTED + _dec('1'), 'expense/cancelled leaked')

    def test_company_scope(self):
        self.assertEqual(self._payable(self.uai), _dec('400000'))

    def test_payable_is_billed_minus_paid(self):
        # Chain sanity: Payable == Billed − Paid for the SS purchase set.
        st = self._stats(self.ss)
        billed = _dec(st.get('bills', {}).get('amount'))
        paid = _dec(st.get('amount_paid', {}).get('total'))
        payable = _dec(st.get('outstanding_payables', {}).get('total'))
        self.assertEqual(payable, billed - paid,
                         f"Payable {payable} != Billed {billed} − Paid {paid}")

"""Data-chain test 4 of N — the OVERDUE tile ties to its source.

The Overdue figure (the workspace sums vendor_breakdown[].overdue) is the unpaid
balance of purchase bills whose due_date is in the PAST and are not settled:

  overdue = Σ(total_amount − amount_paid) WHERE due_date < today AND not PAID/CANCELLED

Checks:
  - a past-due unpaid bill counts its remaining balance
  - a future-due bill does NOT count (not yet overdue)
  - a settled bill does NOT count even if past due
  - overdue ≤ payable (every overdue amount is also outstanding)
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
PAST_DUE = TODAY - datetime.timedelta(days=30)      # already overdue
FUTURE_DUE = TODAY + datetime.timedelta(days=30)    # not yet due
BILL_DATE = max(FY_START, TODAY - datetime.timedelta(days=60))


def _bill(vendor, wh, *, total, paid, due, category='RM', status='OPEN'):
    return VendorBill.objects.create(
        vendor=vendor, warehouse=wh, bill_date=BILL_DATE, due_date=due,
        subtotal=Decimal(str(total)), tax_amount=Decimal('0'),
        total_amount=Decimal(str(total)), amount_paid=Decimal(str(paid)),
        status=status, purchase_category=category,
    )


def _dec(x):
    return Decimal(str(x))


class OverdueTileTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_superuser('ovtester', 'ov@example.com', 'pw12345')
        cls.ss = Company.objects.create(company_code='SSB-002', legal_name='SS Biochem', trade_name='SS Biochem', pan='AAAAA0000A')
        cls.uai = Company.objects.create(company_code='UAI-001', legal_name='United Agro', trade_name='United Agro')
        cls.wh = Warehouse.objects.create(company=cls.ss, warehouse_code='WH-SS', name='SS WH')
        cls.wh_u = Warehouse.objects.create(company=cls.uai, warehouse_code='WH-U', name='U WH')
        cls.v = Vendor.objects.create(vendor_code='V-A', vendor_name='Alpha Traders', company=cls.ss, vendor_type=['RM'])
        cls.v_u = Vendor.objects.create(vendor_code='V-U', vendor_name='Gamma Co', company=cls.uai, vendor_type=['RM'])

        # OVERDUE (past due, unpaid balance): 3,00,000 + 1,00,000 = 4,00,000
        _bill(cls.v, cls.wh, total='500000', paid='200000', due=PAST_DUE)   # 3,00,000 overdue
        _bill(cls.v, cls.wh, total='100000', paid='0', due=PAST_DUE)        # 1,00,000 overdue
        # NOT overdue:
        _bill(cls.v, cls.wh, total='400000', paid='0', due=FUTURE_DUE)      # future due → not overdue
        _bill(cls.v, cls.wh, total='250000', paid='250000', due=PAST_DUE, status='PAID')  # settled → not overdue
        # other company
        _bill(cls.v_u, cls.wh_u, total='600000', paid='100000', due=PAST_DUE)  # 5,00,000 overdue (UAI)

        cls.EXPECTED = _dec('400000')

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def _resp(self, company):
        r = self.client.get('/api/purchase/dashboard/', {
            'company': str(company.id), 'period': 'custom',
            'from': FY_START.isoformat(), 'to': FY_END.isoformat(),
        })
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()

    def _overdue(self, company):
        # vendor_breakdown is a TOP-LEVEL key (not under stats); the workspace
        # sums each vendor's `overdue` into the Overdue tile.
        vb = self._resp(company).get('vendor_breakdown', [])
        return sum((_dec(r.get('overdue')) for r in vb), _dec('0'))

    def test_overdue_equals_past_due_balances(self):
        self.assertEqual(self._overdue(self.ss), self.EXPECTED,
                         f"Overdue should be past-due unpaid balances {self.EXPECTED}")

    def test_future_due_not_counted(self):
        # If the future-due 4,00,000 counted, overdue would be higher.
        self.assertNotEqual(self._overdue(self.ss), self.EXPECTED + _dec('400000'), 'future-due leaked')

    def test_settled_not_counted(self):
        self.assertLess(self._overdue(self.ss), self.EXPECTED + _dec('1'), 'settled bill leaked into overdue')

    def test_company_scope(self):
        self.assertEqual(self._overdue(self.uai), _dec('500000'))

    def test_overdue_never_exceeds_payable(self):
        resp = self._resp(self.ss)
        payable = _dec(resp.get('stats', {}).get('outstanding_payables', {}).get('total'))
        overdue = sum((_dec(r.get('overdue')) for r in resp.get('vendor_breakdown', [])), _dec('0'))
        self.assertLessEqual(overdue, payable, 'Overdue exceeds Payable')

"""Cross-consistency test — the Ledger page agrees with the Payables table.

A vendor should not show two different "outstanding" numbers in two places.
For a period that covers all of a vendor's activity, the Ledger's per-vendor
CLOSING balance must equal that vendor's balance in vendor_breakdown (the
Payables / Top-Vendors table), since both use:

    opening + billed + credit_notes − payments − debit_notes

The Ledger is period-windowed and vendor_breakdown is as-of-cumulative, so they
agree when the window spans the vendor's whole history (the normal FY view).

Django TestCase + DRF APIClient.
"""
import datetime
from decimal import Decimal

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from core.models import Company, Warehouse
from master.models import Vendor
from purchase.models import VendorBill, PaymentMade, VendorOpeningBalance

try:
    from sales.models import DebitNote
    _HAS_DN = True
except Exception:                       # pragma: no cover
    _HAS_DN = False

TODAY = datetime.date.today()
FY_START = datetime.date(TODAY.year if TODAY.month >= 4 else TODAY.year - 1, 4, 1)
FY_END = datetime.date(FY_START.year + 1, 3, 31)
D1 = FY_START + datetime.timedelta(days=10)
D2 = FY_START + datetime.timedelta(days=40)


def _bill(vendor, wh, *, total, paid='0', date=D1, category='RM'):
    return VendorBill.objects.create(
        vendor=vendor, warehouse=wh, bill_date=date,
        subtotal=Decimal(str(total)), tax_amount=Decimal('0'),
        total_amount=Decimal(str(total)), amount_paid=Decimal(str(paid)),
        status='OPEN', purchase_category=category,
    )


def _pay(vendor, *, amount, date=D2):
    return PaymentMade.objects.create(
        vendor=vendor, payment_date=date, amount=Decimal(str(amount)), status='COMPLETED',
    )


def _dec(x):
    return Decimal(str(x))


class LedgerVsPayablesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_superuser('xtester', 'x@example.com', 'pw12345')
        cls.ss = Company.objects.create(company_code='SSB-002', legal_name='SS Biochem', trade_name='SS Biochem', pan='AAAAA0000A')
        cls.wh = Warehouse.objects.create(company=cls.ss, warehouse_code='WH-SS', name='SS WH')
        cls.v = Vendor.objects.create(vendor_code='V-A', vendor_name='Alpha Traders', company=cls.ss, vendor_type=['RM'])

        # opening 1,00,000 Cr; bill 5,00,000; payment 2,00,000 → closing 4,00,000 Cr
        VendorOpeningBalance.objects.create(company=cls.ss, vendor=cls.v, vendor_name='Alpha Traders',
                                            as_of_date=FY_START, amount=_dec('100000'))
        b = _bill(cls.v, cls.wh, total='500000', paid='200000')
        _pay(cls.v, amount='200000')

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def _ledger_closing(self):
        r = self.client.get('/api/purchase/ledger/', {
            'company': str(self.ss.id), 'from': FY_START.isoformat(), 'to': FY_END.isoformat(),
        })
        self.assertEqual(r.status_code, 200, r.content[:400])
        v = next(x for x in r.json()['vendors'] if x['vendor'] == 'Alpha Traders')
        return _dec(v['closing'])

    def _payables_balance(self):
        r = self.client.get('/api/purchase/dashboard/', {
            'company': str(self.ss.id), 'period': 'custom',
            'from': FY_START.isoformat(), 'to': FY_END.isoformat(),
        })
        self.assertEqual(r.status_code, 200, r.content[:400])
        vb = next(x for x in r.json().get('vendor_breakdown', []) if x['vendor_name'] == 'Alpha Traders')
        return _dec(vb['outstanding'])

    def test_ledger_closing_matches_payables_balance(self):
        ledger = self._ledger_closing()
        payables = self._payables_balance()
        self.assertEqual(ledger, payables,
                         f"Ledger closing {ledger} != Payables balance {payables} for the same vendor")

    def test_both_equal_the_expected_formula(self):
        # opening 1,00,000 + billed 5,00,000 − paid 2,00,000 = 4,00,000
        expected = _dec('400000')
        self.assertEqual(self._ledger_closing(), expected)
        self.assertEqual(self._payables_balance(), expected)

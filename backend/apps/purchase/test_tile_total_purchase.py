"""Data-chain test 1 of N — the TOTAL PURCHASE tile ties to its source bills.

The dashboard's Total Purchase figure (stats.total_purchase) must equal the sum
of the vendor bills it is built from, with the SAME exclusions the Bills page
uses, so the tile and the list always describe one set of documents:

  included : OPEN/received bills, incl GST (total_amount)
  excluded : CANCELLED, opening carriers, expense-like (is_expense /
             EXPENSE category), journals, and branch-transfer DCs.

If any excluded document leaks into the tile, the tile over-states purchases —
exactly the class of bug the ledger test caught (a cancelled bill leaking).

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


def _bill(vendor, wh, *, total, date=D1, category='RM', status='OPEN',
          is_expense=False, invoice_no='', voucher_type='', tally_guid=''):
    return VendorBill.objects.create(
        vendor=vendor, warehouse=wh, bill_date=date, vendor_invoice_no=invoice_no,
        subtotal=Decimal(str(total)), tax_amount=Decimal('0'),
        total_amount=Decimal(str(total)), status=status,
        purchase_category=category, is_expense=is_expense,
        tally_voucher_type=voucher_type, tally_guid=tally_guid,
    )


def _dec(x):
    return Decimal(str(x))


class TotalPurchaseTileTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_superuser('tptester', 't@example.com', 'pw12345')
        cls.ss = Company.objects.create(company_code='SSB-002', legal_name='SS Biochem', trade_name='SS Biochem', pan='AAAAA0000A')
        cls.wh = Warehouse.objects.create(company=cls.ss, warehouse_code='WH-SS', name='SS WH')
        cls.v = Vendor.objects.create(vendor_code='V-A', vendor_name='Alpha Traders', company=cls.ss, vendor_type=['RM'])
        cls.v_exp = Vendor.objects.create(vendor_code='V-E', vendor_name='Expense Co', company=cls.ss, vendor_type=['EXPENSE'])

        # ── Real purchases that SHOULD count: 5,00,000 + 2,00,000 = 7,00,000 ──
        _bill(cls.v, cls.wh, total='500000', category='RM', invoice_no='INV-1')
        _bill(cls.v, cls.wh, total='200000', category='PM', invoice_no='INV-2')

        # ── Noise that MUST NOT count ──
        _bill(cls.v, cls.wh, total='900000', status='CANCELLED', invoice_no='INV-CANCEL')
        _bill(cls.v, cls.wh, total='100000', tally_guid='OPENING-1', invoice_no='INV-OPEN')
        _bill(cls.v_exp, cls.wh, total='300000', is_expense=True, invoice_no='INV-EXP')
        _bill(cls.v, cls.wh, total='400000', voucher_type='Journal', invoice_no='INV-JRNL')

        cls.EXPECTED = _dec('700000')

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def _stats(self):
        r = self.client.get('/api/purchase/dashboard/', {
            'company': str(self.ss.id), 'period': 'custom',
            'from': FY_START.isoformat(), 'to': FY_END.isoformat(),
        })
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json().get('stats', {})

    def _total(self):
        # total_purchase.total = gross incl-GST figure (what the tile shows).
        return _dec(self._stats().get('total_purchase', {}).get('total'))

    def test_total_purchase_equals_real_bills_only(self):
        incl = self._total()
        self.assertEqual(incl, self.EXPECTED,
                         f"Total Purchase {incl} should be exactly real bills {self.EXPECTED}")

    def test_cancelled_bill_excluded(self):
        self.assertNotEqual(self._total(), self.EXPECTED + _dec('900000'), 'cancelled bill leaked')

    def test_expense_and_journal_excluded(self):
        # neither the 3,00,000 expense bill nor the 4,00,000 journal may be in it
        self.assertLess(self._total(), self.EXPECTED + _dec('1'), 'expense/journal leaked into Total Purchase')

    def test_bills_tile_matches_bill_count(self):
        # The Bills tile (bills.count/amount) describes the SAME document set.
        bills = self._stats().get('bills', {})
        self.assertEqual(_dec(bills.get('amount')), self.EXPECTED, 'Bills amount != real bills')
        self.assertEqual(bills.get('count'), 2, 'Bills count should be the 2 real bills only')

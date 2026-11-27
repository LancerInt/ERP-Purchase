"""Purchase Ledger (/api/purchase/ledger/) — reconciliation + edge tests.

The ledger is the end of the data chain: Sourcing → Bills (credits) and
Payments/Notes (debits) → running balance per vendor. These tests prove the
ledger TIES to its source data with no double-counting and no leakage:

  - closing = opening + Σ credits − Σ debits                (per vendor)
  - Σ ledger credits == Σ bill totals                        (ties to Bills)
  - Σ ledger debits  == Σ payments + Σ debit notes           (ties to Amount Paid)
  - grand closing    == Σ vendor closings == flat running end
  - branch-transfer bills, cancelled bills excluded
  - inter-account transfers (is_transfer) excluded from payments
  - credit notes add to what we owe (Cr); debit notes reduce it (Dr)
  - company + category filters scope correctly

Django TestCase + DRF APIClient, project test style.
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
D3 = FY_START + datetime.timedelta(days=80)


def _bill(vendor, wh, *, total, date, category='RM', cancelled=False, invoice_no=''):
    return VendorBill.objects.create(
        vendor=vendor, warehouse=wh, bill_date=date, vendor_invoice_no=invoice_no,
        subtotal=Decimal(str(total)), tax_amount=Decimal('0'),
        total_amount=Decimal(str(total)),
        status=('CANCELLED' if cancelled else 'OPEN'),
        purchase_category=('BRANCH' if category == 'BRANCH' else category),
    )


def _pay(vendor, *, amount, date, is_transfer=False):
    return PaymentMade.objects.create(
        vendor=vendor, payment_date=date, amount=Decimal(str(amount)),
        is_transfer=is_transfer,
    )


def _dn(company, vendor, *, amount, date, note_type='DEBIT'):
    return DebitNote.objects.create(
        company=company, vendor=vendor, side='PURCHASE', note_type=note_type,
        amount=Decimal(str(amount)), note_date=date, note_no=f'{note_type}-{amount}',
    )


def _dec(x):
    return Decimal(str(x))


class LedgerReconcileTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_superuser('ledgertester', 'l@example.com', 'pw12345')

        cls.ss = Company.objects.create(company_code='SSB-002', legal_name='SS Biochem', trade_name='SS Biochem', pan='AAAAA0000A')
        cls.uai = Company.objects.create(company_code='UAI-001', legal_name='United Agro', trade_name='United Agro')
        cls.wh_ss = Warehouse.objects.create(company=cls.ss, warehouse_code='WH-SS', name='SS WH')
        cls.wh_uai = Warehouse.objects.create(company=cls.uai, warehouse_code='WH-UAI', name='UAI WH')

        # SS vendors
        cls.v_a = Vendor.objects.create(vendor_code='V-A', vendor_name='Alpha Traders', company=cls.ss, vendor_type=['RM'])
        cls.v_b = Vendor.objects.create(vendor_code='V-B', vendor_name='Beta Supplies', company=cls.ss, vendor_type=['PM'], is_msme=True)
        cls.v_branch = Vendor.objects.create(vendor_code='V-BR', vendor_name='SS Biochem - Blre', company=cls.ss, vendor_type=['RM'], is_branch=True)
        cls.v_uai = Vendor.objects.create(vendor_code='V-U', vendor_name='Gamma Co', company=cls.uai, vendor_type=['RM'])

        # ── Alpha (RM): opening 1,00,000 Cr; bill 5,00,000; payment 2,00,000; debit note 50,000 ──
        VendorOpeningBalance.objects.create(company=cls.ss, vendor=cls.v_a, vendor_name='Alpha Traders',
                                            as_of_date=FY_START, amount=_dec('100000'))
        _bill(cls.v_a, cls.wh_ss, total='500000', date=D1, category='RM', invoice_no='INV-A1')
        _pay(cls.v_a, amount='200000', date=D2)
        if _HAS_DN:
            _dn(cls.ss, cls.v_a, amount='50000', date=D2, note_type='DEBIT')  # return → reduces

        # ── Beta (PM): bill 2,00,000; credit note 20,000 (increases); payment 1,00,000 ──
        _bill(cls.v_b, cls.wh_ss, total='200000', date=D1, category='PM', invoice_no='INV-B1')
        if _HAS_DN:
            _dn(cls.ss, cls.v_b, amount='20000', date=D2, note_type='CREDIT')  # increases owed
        _pay(cls.v_b, amount='100000', date=D3)

        # ── Noise that must NOT appear ──
        _bill(cls.v_a, cls.wh_ss, total='999999', date=D1, category='RM', cancelled=True, invoice_no='INV-CANCEL')  # cancelled
        _bill(cls.v_branch, cls.wh_ss, total='700000', date=D1, category='BRANCH', invoice_no='DC/1')              # branch transfer
        _pay(cls.v_a, amount='300000', date=D2, is_transfer=True)                                                 # inter-account contra
        _bill(cls.v_uai, cls.wh_uai, total='400000', date=D1, category='RM', invoice_no='INV-U1')                 # other company
        _bill(cls.v_a, cls.wh_ss, total='888888', date=D1, category='EXPENSES', invoice_no='INV-EXP')            # expense category — separate from purchases

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def _get(self, **params):
        params.setdefault('from', FY_START.isoformat())
        params.setdefault('to', FY_END.isoformat())
        r = self.client.get('/api/purchase/ledger/', params)
        self.assertEqual(r.status_code, 200, r.content[:400])
        return r.json()

    # ── 1. Per-vendor internal consistency: closing = opening + credits − debits ──
    def test_vendor_closing_equals_opening_plus_credits_minus_debits(self):
        d = self._get(company=str(self.ss.id))
        for v in d['vendors']:
            expected = _dec(v['opening']) + _dec(v['credit_total']) - _dec(v['debit_total'])
            self.assertEqual(_dec(v['closing']), expected,
                             f"{v['vendor']}: closing {v['closing']} != open+cr-dr {expected}")

    # ── 2. Alpha's numbers tie to source exactly ──
    def test_alpha_ledger_ties_to_source(self):
        d = self._get(company=str(self.ss.id))
        alpha = next(v for v in d['vendors'] if v['vendor'] == 'Alpha Traders')
        # credits = bill 5,00,000 ; debits = payment 2,00,000 + DN 50,000 (if DN available)
        self.assertEqual(_dec(alpha['opening']), _dec('100000'))
        self.assertEqual(_dec(alpha['credit_total']), _dec('500000'))
        exp_debit = _dec('200000') + (_dec('50000') if _HAS_DN else _dec('0'))
        self.assertEqual(_dec(alpha['debit_total']), exp_debit)
        # closing = 1,00,000 + 5,00,000 − (2,00,000 + 50,000) = 3,50,000 Cr
        exp_close = _dec('100000') + _dec('500000') - exp_debit
        self.assertEqual(_dec(alpha['closing']), exp_close)
        self.assertEqual(alpha['closing_type'], 'Cr')

    # ── 3. Σ ledger credits == Σ bill totals (ties to Bills page) ──
    def test_credits_tie_to_bills(self):
        d = self._get(company=str(self.ss.id))
        ledger_credits = sum(_dec(v['credit_total']) for v in d['vendors'])
        # Σ bills = Alpha 5,00,000 + Beta 2,00,000 + Beta credit-note 20,000 (a CN is a credit)
        bills = _dec('500000') + _dec('200000')
        cn = _dec('20000') if _HAS_DN else _dec('0')
        self.assertEqual(ledger_credits, bills + cn)

    # ── 4. Σ ledger debits == Σ payments + Σ debit notes (ties to Amount Paid) ──
    def test_debits_tie_to_payments_and_returns(self):
        d = self._get(company=str(self.ss.id))
        ledger_debits = sum(_dec(v['debit_total']) for v in d['vendors'])
        payments = _dec('200000') + _dec('100000')          # Alpha 2L + Beta 1L (transfer excluded)
        dn = _dec('50000') if _HAS_DN else _dec('0')        # Alpha debit note
        self.assertEqual(ledger_debits, payments + dn)

    # ── 5. Grand totals tie: flat end == Σ vendor closings == totals.closing ──
    def test_grand_totals_consistent(self):
        d = self._get(company=str(self.ss.id))
        sum_closings = sum(_dec(v['closing']) for v in d['vendors'])
        self.assertEqual(_dec(d['totals']['closing']), sum_closings)
        # flat list's last balance == grand closing
        self.assertTrue(d['flat'])
        self.assertEqual(_dec(d['flat'][-1]['balance']), sum_closings)

    # ── 6. Branch transfers, cancelled bills, transfers, other company excluded ──
    def test_noise_excluded(self):
        d = self._get(company=str(self.ss.id))
        names = {v['vendor'] for v in d['vendors']}
        self.assertNotIn('SS Biochem - Blre', names, 'branch-transfer vendor leaked')
        self.assertNotIn('Gamma Co', names, 'other-company vendor leaked')
        # no voucher references the cancelled / branch / transfer amounts
        all_amts = {r['credit'] for r in d['flat']} | {r['debit'] for r in d['flat']}
        all_amts = {_dec(a) for a in all_amts}
        self.assertNotIn(_dec('999999'), all_amts, 'cancelled bill leaked')
        self.assertNotIn(_dec('700000'), all_amts, 'branch transfer leaked')
        self.assertNotIn(_dec('300000'), all_amts, 'inter-account transfer leaked')
        self.assertNotIn(_dec('888888'), all_amts, 'expense-category bill leaked (expenses are separate)')

    # ── 7. Company filter: UAI sees only Gamma; SS never sees it ──
    def test_company_scope(self):
        d_uai = self._get(company=str(self.uai.id))
        names = {v['vendor'] for v in d_uai['vendors']}
        self.assertEqual(names, {'Gamma Co'})
        gamma = d_uai['vendors'][0]
        self.assertEqual(_dec(gamma['credit_total']), _dec('400000'))

    # ── 8. Category filter: RM shows Alpha (RM) not Beta (PM) ──
    def test_category_filter(self):
        d = self._get(company=str(self.ss.id), category='RM')
        names = {v['vendor'] for v in d['vendors']}
        self.assertIn('Alpha Traders', names)
        self.assertNotIn('Beta Supplies', names, 'PM vendor leaked into RM filter')

    # ── 9. Flat running balance is monotonic per step (no gaps/double count) ──
    def test_flat_running_balance_steps(self):
        d = self._get(company=str(self.ss.id))
        # recompute running balance from debit/credit and compare to reported balance
        opening = sum(_dec(v['opening']) for v in d['vendors'])
        bal = opening
        for r in d['flat']:
            bal = bal + _dec(r['credit']) - _dec(r['debit'])
            self.assertEqual(_dec(r['balance']), bal,
                             f"running balance drift at {r['vch_no']}")

    # ── 10. MSME flag carried through (Beta is MSME) ──
    def test_msme_flag(self):
        d = self._get(company=str(self.ss.id))
        beta = next(v for v in d['vendors'] if v['vendor'] == 'Beta Supplies')
        self.assertTrue(beta['is_msme'])

    # ── 11. Only the 4 purchase categories count; others excluded ──
    def test_only_four_purchase_categories(self):
        # a Maize bill and a Bought-Note bill SHOULD count; Lab/Machinery should not.
        maize_v = Vendor.objects.create(vendor_code='V-M', vendor_name='Maize Farmer', company=self.ss, vendor_type=['RM'])
        _bill(maize_v, self.wh_ss, total='300000', date=D1, category='MAIZE', invoice_no='INV-MAIZE')
        _bill(maize_v, self.wh_ss, total='111111', date=D1, category='MACHINERY', invoice_no='INV-MACH')  # excluded
        d = self._get(company=str(self.ss.id))
        mz = next((v for v in d['vendors'] if v['vendor'] == 'Maize Farmer'), None)
        self.assertIsNotNone(mz, 'Maize purchase missing')
        self.assertEqual(_dec(mz['credit_total']), _dec('300000'), 'Maize credit wrong / machinery leaked')
        self.assertEqual(mz['category'], 'MAIZE', 'Maize should be its own category, not RM')

    def test_bought_note_rolls_into_fruit(self):
        bn_v = Vendor.objects.create(vendor_code='V-BN', vendor_name='Grower Co', company=self.ss, vendor_type=['RM'])
        _bill(bn_v, self.wh_ss, total='60000', date=D1, category='BOUGHT_NOTE', invoice_no='INV-BN')
        d = self._get(company=str(self.ss.id))
        bn = next((v for v in d['vendors'] if v['vendor'] == 'Grower Co'), None)
        self.assertIsNotNone(bn, 'Bought-note purchase missing')
        self.assertEqual(bn['category'], 'FRUIT', 'Bought Note should display as Fruit')

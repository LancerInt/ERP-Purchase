"""sweep_blank_payees tags ONLY the on-account payees that show a blank
Category chip, and never a real RM / packing / freight vendor.

The chip is blank exactly when a payee is paid on-account (no bill) AND its
vendor_type is empty AND no bill gives it a category. This test proves the
command's candidate set matches that definition precisely — a typed vendor,
a bill-categorised vendor, and a bank-ledger stub are all left alone.
"""
from datetime import date
from decimal import Decimal
from io import StringIO

from django.core.management import call_command
from django.test import TestCase

from core.models import Company
from master.models import Vendor
from purchase.models import PaymentMade, VendorBill


class SweepBlankPayeesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.co = Company.objects.create(company_code='SWP', legal_name='Sweep Co')
        d = date(2026, 8, 10)

        def vendor(code, name, vtype=None):
            return Vendor.objects.create(vendor_code=code, vendor_name=name,
                                         company=cls.co, vendor_type=vtype or [])

        def onaccount(vendor, amount):
            return PaymentMade.objects.create(
                vendor=vendor, bill=None, amount=Decimal(str(amount)),
                payment_date=d, status='APPROVED')

        # (A) TRUE blank-chip payee: on-account, no vendor_type, no bills.
        cls.blank = vendor('V-BLANK', 'Khatija Khatoon Thadi LW')
        onaccount(cls.blank, 30000)

        # (B) Typed vendor paid on-account — vendor_type resolves the chip. SKIP.
        cls.typed = vendor('V-TYPED', 'Already Expense Co', ['EXPENSE'])
        onaccount(cls.typed, 25000)

        # (C) RM vendor with a categorised bill, also paid on-account — bill
        #     category resolves the chip. MUST NOT be tagged EXPENSE.
        cls.rm = vendor('V-RM', 'Real RM Supplier')
        VendorBill.objects.create(vendor=cls.rm, bill_date=d,
                                  total_amount=Decimal('99999'),
                                  purchase_category='RM', status='OPEN')
        onaccount(cls.rm, 50000)

        # (D) Bank-ledger stub imported as a vendor — never a real payee. SKIP.
        cls.bank = vendor('V-BANK', 'ICICI Bank-CA-123 Creditors')
        onaccount(cls.bank, 70000)

        # (E) Blank vendor with NO on-account payment (only bill-linked) — not a
        #     blank-chip row in the list. SKIP.
        cls.billonly = vendor('V-BILLONLY', 'Bill Only Co')
        b = VendorBill.objects.create(vendor=cls.billonly, bill_date=d,
                                      total_amount=Decimal('1000'),
                                      purchase_category='', status='OPEN')
        PaymentMade.objects.create(vendor=cls.billonly, bill=b,
                                   amount=Decimal('1000'), payment_date=d,
                                   status='APPROVED')

    def _run(self, apply=False):
        out = StringIO()
        call_command('sweep_blank_payees', '--company', 'SWP',
                     *(['--apply'] if apply else []), stdout=out)
        return out.getvalue()

    def test_dry_run_tags_only_the_blank_payee(self):
        out = self._run(apply=False)
        self.assertIn('V-BLANK', out)
        self.assertIn('Khatija Khatoon', out)
        for code in ('V-TYPED', 'V-RM', 'V-BANK', 'V-BILLONLY'):
            self.assertNotIn(code, out, f'{code} should not be in the sweep set')
        # Dry-run writes nothing.
        self.blank.refresh_from_db()
        self.assertEqual(self.blank.vendor_type, [])

    def test_apply_sets_only_the_blank_payee_to_expense(self):
        self._run(apply=True)
        self.blank.refresh_from_db()
        self.typed.refresh_from_db()
        self.rm.refresh_from_db()
        self.bank.refresh_from_db()
        self.assertEqual(self.blank.vendor_type, ['EXPENSE'])   # fixed
        self.assertEqual(self.typed.vendor_type, ['EXPENSE'])   # untouched (was already)
        self.assertEqual(self.rm.vendor_type, [])              # NOT mis-tagged
        self.assertEqual(self.bank.vendor_type, [])            # stub left alone

    def test_rm_vendor_never_becomes_expense(self):
        # The one that must never regress: a real RM vendor paid on-account.
        self._run(apply=True)
        self.rm.refresh_from_db()
        self.assertNotEqual(self.rm.vendor_type, ['EXPENSE'])

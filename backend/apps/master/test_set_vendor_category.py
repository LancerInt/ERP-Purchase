"""set_vendor_category command: match an Excel vendor list by normalised key
and replace vendor_type with exactly [CATEGORY].

Covers the real-data traps: punctuation/legal-suffix differences between the
list name and the master name must still match (vkey), an unrelated vendor
must be left alone, and the field must be REPLACED (not appended) so a vendor
lands in one clean bucket.
"""
import os
import tempfile

import openpyxl
from django.core.management import call_command
from django.test import TestCase

from core.models import Company
from master.models import Vendor


class SetVendorCategoryTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.ssb = Company.objects.create(
            company_code='SSB-002', legal_name='SS Biochem', trade_name='SSB',
            gstin='33BBBBB0000B1Z5', pan='BBBBB0000B',
        )
        cls.uai = Company.objects.create(
            company_code='UAI-001', legal_name='United Agro', trade_name='UAI',
            gstin='33AAAAA0000A1Z5', pan='AAAAA0000A',
        )
        # Master spelled differently from the list (legal suffix + spacing).
        cls.rm = Vendor.objects.create(
            vendor_code='SSB-VEN-041', vendor_name='Niramaya Products Private Limited - Mumbai',
            company=cls.ssb, vendor_type=['EXPENSE'],  # stale, should be replaced
        )
        # Same business in the other company — all companies in scope => both set.
        cls.rm_uai = Vendor.objects.create(
            vendor_code='UAI-VEN-010', vendor_name='Niramaya Products Pvt Ltd - Mumbai',
            company=cls.uai, vendor_type=[],
        )
        # An unrelated vendor that must NOT be touched.
        cls.other = Vendor.objects.create(
            vendor_code='SSB-VEN-099', vendor_name='Some Expense Guy - Salem',
            company=cls.ssb, vendor_type=['EXPENSE'],
        )

    def _xlsx(self, names, header='RM Vendor'):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append([header])
        for n in names:
            ws.append([n])
        fd, path = tempfile.mkstemp(suffix='.xlsx')
        os.close(fd)
        wb.save(path)
        wb.close()

        def _rm():
            try:
                os.remove(path)
            except OSError:
                pass
        self.addCleanup(_rm)
        return path

    def test_apply_sets_category_across_name_variants_and_companies(self):
        # List carries ONE spelling; it should hit both master spellings.
        path = self._xlsx(['Niramaya Products Pvt. Ltd. - Mumbai'])
        call_command('set_vendor_category', file=path, category='RAW_MATERIAL', apply=True)

        self.rm.refresh_from_db()
        self.rm_uai.refresh_from_db()
        self.other.refresh_from_db()
        self.assertEqual(self.rm.vendor_type, ['RAW_MATERIAL'])      # replaced, not appended
        self.assertEqual(self.rm_uai.vendor_type, ['RAW_MATERIAL'])  # matched across company
        self.assertEqual(self.other.vendor_type, ['EXPENSE'])        # untouched

    def test_dry_run_writes_nothing(self):
        path = self._xlsx(['Niramaya Products Pvt. Ltd. - Mumbai'])
        call_command('set_vendor_category', file=path, category='RAW_MATERIAL')  # no --apply
        self.rm.refresh_from_db()
        self.assertEqual(self.rm.vendor_type, ['EXPENSE'])  # unchanged

    def test_company_scope_limits_writes(self):
        path = self._xlsx(['Niramaya Products Pvt. Ltd. - Mumbai'])
        call_command('set_vendor_category', file=path, category='RAW_MATERIAL',
                     company='SSB-002', apply=True)
        self.rm.refresh_from_db()
        self.rm_uai.refresh_from_db()
        self.assertEqual(self.rm.vendor_type, ['RAW_MATERIAL'])  # in scope
        self.assertEqual(self.rm_uai.vendor_type, [])            # out of scope, untouched

    def test_names_file_text_input(self):
        # Plain-text, one name per line (the on-server path when no xlsx).
        fd, path = tempfile.mkstemp(suffix='.txt')
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write('RM Vendor\nNiramaya Products Pvt. Ltd. - Mumbai\n')

        def _rm():
            try:
                os.remove(path)
            except OSError:
                pass
        self.addCleanup(_rm)

        call_command('set_vendor_category', names_file=path, category='RAW_MATERIAL', apply=True)
        self.rm.refresh_from_db()
        self.assertEqual(self.rm.vendor_type, ['RAW_MATERIAL'])

    def test_must_pass_exactly_one_source(self):
        with self.assertRaises(Exception):  # neither --file nor --names-file
            call_command('set_vendor_category', category='EXPENSE')

    def test_suggest_finds_close_master_and_never_writes(self):
        # A name the vkey won't match (extra 'Mumbai' token dropped, '&' vs 'and'),
        # but clearly the same vendor — suggest should surface it, and NOT write.
        Vendor.objects.create(
            vendor_code='SSB-VEN-200', vendor_name='Acme Chemicals and Dyes - Salem',
            company=self.ssb, vendor_type=['RAW_MATERIAL'],
        )
        from io import StringIO
        out = StringIO()
        call_command('set_vendor_category', names_file=self._names(['Acme Chemical & Dye']),
                     category='EXPENSE', suggest=True, apply=True, stdout=out)
        text = out.getvalue()
        self.assertIn('SUGGESTIONS', text)
        self.assertIn('Acme Chemicals and Dyes - Salem', text)  # surfaced as candidate
        # suggest forces no-write even with --apply:
        self.assertEqual(
            Vendor.objects.get(vendor_code='SSB-VEN-200').vendor_type, ['RAW_MATERIAL'])

    def _names(self, names):
        fd, path = tempfile.mkstemp(suffix='.txt')
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(names) + '\n')

        def _rm():
            try:
                os.remove(path)
            except OSError:
                pass
        self.addCleanup(_rm)
        return path

    def test_bad_category_errors(self):
        path = self._xlsx(['Niramaya Products Pvt. Ltd. - Mumbai'])
        with self.assertRaises(Exception):
            call_command('set_vendor_category', file=path, category='NOT_A_TYPE', apply=True)

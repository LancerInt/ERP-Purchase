"""import_transporters: create Transporter masters from a names list, deduped by
vkey, optionally under both companies."""
import os
import tempfile

from django.core.management import call_command
from django.test import TestCase

from core.models import Company
from master.models import Transporter


class ImportTransportersTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.ssb = Company.objects.create(company_code='SSB-002', legal_name='SSB')
        cls.uai = Company.objects.create(company_code='UAI-001', legal_name='UAI')

    def _file(self, lines):
        fd, path = tempfile.mkstemp(suffix='.txt')
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(lines) + '\n')

        def _rm():
            try:
                os.remove(path)
            except OSError:
                pass
        self.addCleanup(_rm)
        return path

    def test_creates_under_both_companies(self):
        p = self._file(['Amutha Roadways', 'KAMAKSHI ROADWAYS'])
        call_command('import_transporters', names_file=p, company='ALL', apply=True)
        self.assertEqual(Transporter.objects.filter(name='Amutha Roadways').count(), 2)  # SSB + UAI
        self.assertEqual(Transporter.objects.filter(company=self.ssb).count(), 2)
        self.assertEqual(Transporter.objects.filter(company=self.uai).count(), 2)

    def test_dedupes_near_names_in_list(self):
        p = self._file(['New Bangalore Road Lines', 'New Bangalore Roadlines'])  # same vkey
        call_command('import_transporters', names_file=p, company='SSB-002', apply=True)
        self.assertEqual(Transporter.objects.filter(company=self.ssb).count(), 1)

    def test_skips_existing(self):
        Transporter.objects.create(transporter_code='TRP-X', company=self.ssb, name='Amutha Roadways')
        p = self._file(['Amutha Roadways'])
        call_command('import_transporters', names_file=p, company='SSB-002', apply=True)
        self.assertEqual(Transporter.objects.filter(company=self.ssb, name='Amutha Roadways').count(), 1)

    def test_dry_run_writes_nothing(self):
        p = self._file(['Amutha Roadways'])
        call_command('import_transporters', names_file=p, company='SSB-002')  # no --apply
        self.assertEqual(Transporter.objects.count(), 0)

    def test_skips_garbage(self):
        p = self._file(['�', '', 'Amutha Roadways'])
        call_command('import_transporters', names_file=p, company='SSB-002', apply=True)
        self.assertEqual(Transporter.objects.count(), 1)

    def test_bad_company_errors(self):
        p = self._file(['Amutha Roadways'])
        with self.assertRaises(Exception):
            call_command('import_transporters', names_file=p, company='NOPE', apply=True)

"""Model-level tests for the freight tax shell: Transporter MSME autoflag and
LocalFreight.compute_freight_taxes wiring to the tested rule engine.

These prove the DB fields + glue, not the rules themselves (which have their own
64 pure tests in test_freight_rules.py).
Run: python manage.py test purchase.test_freight_model
"""
from datetime import date
from decimal import Decimal

from django.test import TestCase

from core.models import Company
from master.models import Transporter
from purchase.models import LocalFreight


class TransporterMsmeAutoflagTests(TestCase):
    def test_udyam_number_sets_is_msme(self):
        t = Transporter.objects.create(
            transporter_code='TPT-A', name='Balamurugan',
            msme_udyam_no='UDYAM-TN-01-0001234')
        self.assertTrue(t.is_msme)

    def test_category_sets_is_msme(self):
        t = Transporter.objects.create(
            transporter_code='TPT-B', name='SLP', msme_category='SMALL')
        self.assertTrue(t.is_msme)

    def test_no_msme_stays_false(self):
        t = Transporter.objects.create(transporter_code='TPT-C', name='Plain')
        self.assertFalse(t.is_msme)

    def test_pan_uppercased(self):
        t = Transporter.objects.create(
            transporter_code='TPT-D', name='Pan Co', pan='abcde1234f')
        self.assertEqual(t.pan, 'ABCDE1234F')


class ComputeFreightTaxesTests(TestCase):
    def setUp(self):
        self.co = Company.objects.create(legal_name='SS Biochem', company_code='SS')

    def _advice(self, transporter, **kw):
        defaults = dict(
            freight_no=kw.pop('freight_no', 'LF-1'), date=date(2026, 4, 12),
            company=self.co, lorry_no='TN01AB1234', transporter=transporter,
            freight_amount=Decimal('22400'))
        defaults.update(kw)
        return LocalFreight.objects.create(**defaults)

    def test_gta_with_note_is_rcm_5pct(self):
        t = Transporter.objects.create(transporter_code='T1', name='GTA Co',
                                       is_gta=True, gst_registered=True)
        lf = self._advice(t, consignment_note_no='LR-900')
        lf.compute_freight_taxes(current_fy='2026-27')
        self.assertEqual(lf.charge_mechanism, 'RCM')
        self.assertEqual(lf.sac_code, '996511')
        self.assertEqual(lf.rcm_gst, Decimal('1120.00'))   # 5% of 22,400
        self.assertFalse(lf.needs_self_invoice)            # registered GTA

    def test_unregistered_gta_rcm_needs_self_invoice(self):
        t = Transporter.objects.create(transporter_code='T2', name='Unreg GTA',
                                       is_gta=True, gst_registered=False)
        lf = self._advice(t, freight_no='LF-2', consignment_note_no='LR-901')
        lf.compute_freight_taxes(current_fy='2026-27')
        self.assertTrue(lf.needs_self_invoice)

    def test_no_consignment_note_is_rental_none(self):
        t = Transporter.objects.create(transporter_code='T3', name='Fleet hire',
                                       is_gta=True)
        lf = self._advice(t, freight_no='LF-3')   # no note
        lf.compute_freight_taxes(current_fy='2026-27')
        self.assertEqual(lf.charge_mechanism, 'NONE')
        self.assertEqual(lf.sac_code, '996791')
        self.assertEqual(lf.rcm_gst, Decimal('0.00'))

    def test_annexure_v_makes_it_fcm(self):
        t = Transporter.objects.create(transporter_code='T4', name='FCM GTA',
                                       is_gta=True, annexure_v_opted_fy='2026-27',
                                       fcm_slab='12')
        lf = self._advice(t, freight_no='LF-4', consignment_note_no='LR-902')
        lf.compute_freight_taxes(current_fy='2026-27')
        self.assertEqual(lf.charge_mechanism, 'FCM')
        self.assertEqual(lf.gst_amount, Decimal('2688.00'))  # 12% of 22,400
        self.assertEqual(lf.rcm_gst, Decimal('0.00'))

    def test_composite_clubs_ancillaries(self):
        t = Transporter.objects.create(transporter_code='T5', name='GTA Co',
                                       is_gta=True)
        lf = self._advice(t, freight_no='LF-5', consignment_note_no='LR-903',
                          freight_amount=Decimal('20000'),
                          loading_charges=Decimal('2400'))
        lf.compute_freight_taxes(current_fy='2026-27')
        self.assertEqual(lf.taxable_value, Decimal('22400.00'))
        self.assertEqual(lf.rcm_gst, Decimal('1120.00'))    # 5% of combined

    def test_company_tds_2pct(self):
        t = Transporter.objects.create(transporter_code='T6', name='Co Ltd',
                                       is_gta=True, constitution='COMPANY',
                                       pan='ABCDE1234F')
        lf = self._advice(t, freight_no='LF-6', consignment_note_no='LR-904',
                          freight_amount=Decimal('612000'))
        lf.compute_freight_taxes(current_fy='2026-27',
                                 fy_aggregate=Decimal('612000'))
        self.assertEqual(lf.tds_amount, Decimal('12240.00'))  # 2%

    def test_small_carrier_declaration_no_tds(self):
        t = Transporter.objects.create(transporter_code='T7', name='Small op',
                                       is_gta=True, constitution='INDIVIDUAL',
                                       pan='ABCDE1234F',
                                       owns_10_or_fewer_carriages=True,
                                       has_194c_declaration=True)
        lf = self._advice(t, freight_no='LF-7', consignment_note_no='LR-905',
                          freight_amount=Decimal('500000'))
        lf.compute_freight_taxes(current_fy='2026-27')
        self.assertEqual(lf.tds_amount, Decimal('0.00'))

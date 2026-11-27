"""Tests for the freight MSME + TDS 194C rules (pure logic, no DB).

Proves the legal rules BEFORE the model/UI is built, per the test-first rule.
Run: python manage.py test purchase.test_freight_rules
"""
from datetime import date
from decimal import Decimal

from django.test import SimpleTestCase

from purchase import freight_rules as fr


class MsmeProtectionTests(SimpleTestCase):
    def test_micro_and_small_are_protected(self):
        self.assertTrue(fr.is_msme_protected('MICRO'))
        self.assertTrue(fr.is_msme_protected('small'))   # case-insensitive

    def test_medium_is_not_protected(self):
        self.assertFalse(fr.is_msme_protected('MEDIUM'))

    def test_blank_is_not_protected(self):
        self.assertFalse(fr.is_msme_protected(''))
        self.assertFalse(fr.is_msme_protected(None))


class MsmeWindowTests(SimpleTestCase):
    def test_45_days_with_written_agreement(self):
        self.assertEqual(fr.msme_limit_days(True), 45)

    def test_15_days_without_agreement(self):
        self.assertEqual(fr.msme_limit_days(False), 15)

    def test_due_date_adds_the_window(self):
        d = date(2026, 4, 1)
        self.assertEqual(fr.msme_due_date(d, True), date(2026, 5, 16))   # +45
        self.assertEqual(fr.msme_due_date(d, False), date(2026, 4, 16))  # +15

    def test_days_overdue_zero_before_due(self):
        d = date(2026, 4, 1)
        self.assertEqual(fr.msme_days_overdue(d, True, date(2026, 5, 1)), 0)

    def test_days_overdue_counts_past_due(self):
        d = date(2026, 4, 1)   # 45-day due = 16 May
        self.assertEqual(fr.msme_days_overdue(d, True, date(2026, 5, 26)), 10)


class MsmeBreachTests(SimpleTestCase):
    def test_unpaid_past_window_breaches(self):
        self.assertTrue(
            fr.msme_breaches(date(2026, 4, 1), False, date(2026, 5, 1), is_paid=False))

    def test_unpaid_within_window_does_not_breach(self):
        self.assertFalse(
            fr.msme_breaches(date(2026, 4, 1), True, date(2026, 5, 1), is_paid=False))

    def test_paid_never_breaches(self):
        self.assertFalse(
            fr.msme_breaches(date(2026, 4, 1), False, date(2026, 12, 1), is_paid=True))


class MsmeDisallowanceTests(SimpleTestCase):
    def test_disallowed_when_micro_unpaid_past_window(self):
        amt = fr.msme_disallowance(
            Decimal('22400'), 'MICRO', False, date(2026, 4, 1),
            date(2026, 5, 1), is_paid=False)
        self.assertEqual(amt, Decimal('22400.00'))

    def test_not_disallowed_for_medium(self):
        amt = fr.msme_disallowance(
            Decimal('22400'), 'MEDIUM', False, date(2026, 4, 1),
            date(2026, 5, 1), is_paid=False)
        self.assertEqual(amt, Decimal('0.00'))

    def test_not_disallowed_when_within_window(self):
        amt = fr.msme_disallowance(
            Decimal('22400'), 'SMALL', True, date(2026, 4, 1),
            date(2026, 5, 1), is_paid=False)
        self.assertEqual(amt, Decimal('0.00'))

    def test_not_disallowed_when_paid(self):
        amt = fr.msme_disallowance(
            Decimal('22400'), 'MICRO', False, date(2026, 4, 1),
            date(2026, 9, 1), is_paid=True)
        self.assertEqual(amt, Decimal('0.00'))


class Tds194cRateTests(SimpleTestCase):
    def test_individual_is_one_percent(self):
        self.assertEqual(fr.tds_rate_194c(is_individual=True, has_pan=True),
                         Decimal('0.01'))

    def test_company_is_two_percent(self):
        self.assertEqual(fr.tds_rate_194c(is_individual=False, has_pan=True),
                         Decimal('0.02'))

    def test_no_pan_is_twenty_percent(self):
        self.assertEqual(fr.tds_rate_194c(is_individual=True, has_pan=False),
                         Decimal('0.20'))


class Tds194cExemptionTests(SimpleTestCase):
    def test_small_carrier_declaration_exempts(self):
        self.assertTrue(fr.tds_194c_exempt_small_carrier(True, True, True))

    def test_small_carrier_without_pan_not_exempt(self):
        self.assertFalse(fr.tds_194c_exempt_small_carrier(True, False, True))

    def test_small_carrier_without_declaration_not_exempt(self):
        self.assertFalse(fr.tds_194c_exempt_small_carrier(True, True, False))

    def test_single_payment_below_threshold_exempt(self):
        self.assertTrue(fr.tds_below_threshold(Decimal('28000'), Decimal('80000')))

    def test_single_above_30k_not_exempt(self):
        self.assertFalse(fr.tds_below_threshold(Decimal('31000'), Decimal('40000')))

    def test_aggregate_above_1l_not_exempt(self):
        self.assertFalse(fr.tds_below_threshold(Decimal('25000'), Decimal('120000')))


class ComputeFreightTdsTests(SimpleTestCase):
    def test_company_freight_2pct(self):
        # 6,12,000 @ 2% = 12,240
        self.assertEqual(
            fr.compute_freight_tds(Decimal('612000'), is_individual=False,
                                   has_pan=True, fy_aggregate_including_this=Decimal('612000')),
            Decimal('12240.00'))

    def test_individual_freight_1pct(self):
        self.assertEqual(
            fr.compute_freight_tds(Decimal('200000'), is_individual=True,
                                   has_pan=True, fy_aggregate_including_this=Decimal('200000')),
            Decimal('2000.00'))

    def test_no_pan_20pct(self):
        self.assertEqual(
            fr.compute_freight_tds(Decimal('50000'), is_individual=True,
                                   has_pan=False, fy_aggregate_including_this=Decimal('200000')),
            Decimal('10000.00'))

    def test_small_carrier_declaration_zero(self):
        self.assertEqual(
            fr.compute_freight_tds(Decimal('500000'), is_individual=True, has_pan=True,
                                   owns_10_or_fewer_carriages=True, has_declaration=True),
            Decimal('0.00'))

    def test_below_threshold_zero(self):
        # one 28k payment, FY aggregate 80k -> no TDS
        self.assertEqual(
            fr.compute_freight_tds(Decimal('28000'), is_individual=False, has_pan=True,
                                   this_payment=Decimal('28000'),
                                   fy_aggregate_including_this=Decimal('80000')),
            Decimal('0.00'))

    def test_crossing_aggregate_taxes_full_amount(self):
        # a 28k payment that pushes the FY aggregate to 1.2L -> whole 28k taxed @2%
        self.assertEqual(
            fr.compute_freight_tds(Decimal('28000'), is_individual=False, has_pan=True,
                                   this_payment=Decimal('28000'),
                                   fy_aggregate_including_this=Decimal('120000')),
            Decimal('560.00'))

    def test_zero_amount_zero_tds(self):
        self.assertEqual(
            fr.compute_freight_tds(Decimal('0'), is_individual=False, has_pan=True),
            Decimal('0.00'))


class GtaExemptionTests(SimpleTestCase):
    def test_agricultural_is_exempt(self):
        self.assertTrue(fr.gta_is_exempt(Decimal('50000'), agricultural=True))

    def test_single_carriage_under_1500_exempt(self):
        self.assertTrue(fr.gta_is_exempt(Decimal('1400'), single_carriage=True))

    def test_single_carriage_over_1500_not_exempt(self):
        self.assertFalse(fr.gta_is_exempt(Decimal('1600'), single_carriage=True))

    def test_single_consignee_under_750_exempt(self):
        self.assertTrue(fr.gta_is_exempt(Decimal('700'), single_consignee=True))

    def test_ordinary_freight_not_exempt(self):
        self.assertFalse(fr.gta_is_exempt(Decimal('22400')))


class RcmAppliesTests(SimpleTestCase):
    def test_applies_to_plain_gta(self):
        self.assertTrue(fr.rcm_applies(is_gta=True, gta_opted_forward_charge=False,
                                       exempt=False))

    def test_not_for_forward_charge(self):
        self.assertFalse(fr.rcm_applies(is_gta=True, gta_opted_forward_charge=True,
                                        exempt=False))

    def test_not_for_non_gta(self):
        self.assertFalse(fr.rcm_applies(is_gta=False, gta_opted_forward_charge=False,
                                        exempt=False))

    def test_not_when_exempt(self):
        self.assertFalse(fr.rcm_applies(is_gta=True, gta_opted_forward_charge=False,
                                        exempt=True))


class ComputeRcmGstTests(SimpleTestCase):
    def test_intra_state_splits_cgst_sgst(self):
        r = fr.compute_rcm_gst(Decimal('22400'), inter_state=False)
        self.assertTrue(r['applies'])
        self.assertEqual(r['cgst'], Decimal('560.00'))   # 2.5%
        self.assertEqual(r['sgst'], Decimal('560.00'))   # 2.5%
        self.assertEqual(r['igst'], Decimal('0.00'))
        self.assertEqual(r['total'], Decimal('1120.00')) # 5%

    def test_inter_state_is_igst(self):
        r = fr.compute_rcm_gst(Decimal('22400'), inter_state=True)
        self.assertEqual(r['igst'], Decimal('1120.00'))  # 5%
        self.assertEqual(r['cgst'], Decimal('0.00'))
        self.assertEqual(r['total'], Decimal('1120.00'))

    def test_itc_mirrors_total(self):
        r = fr.compute_rcm_gst(Decimal('612000'))
        self.assertEqual(r['total'], Decimal('30600.00'))        # 5%
        self.assertEqual(r['itc_claimable'], r['total'])         # nets to zero

    def test_forward_charge_no_rcm(self):
        r = fr.compute_rcm_gst(Decimal('22400'), gta_opted_forward_charge=True)
        self.assertFalse(r['applies'])
        self.assertEqual(r['total'], Decimal('0.00'))

    def test_non_gta_no_rcm(self):
        r = fr.compute_rcm_gst(Decimal('22400'), is_gta=False)
        self.assertFalse(r['applies'])
        self.assertEqual(r['total'], Decimal('0.00'))

    def test_exempt_consignment_no_rcm(self):
        r = fr.compute_rcm_gst(Decimal('1400'), single_carriage=True)
        self.assertFalse(r['applies'])
        self.assertEqual(r['total'], Decimal('0.00'))

    def test_agricultural_no_rcm(self):
        r = fr.compute_rcm_gst(Decimal('80000'), agricultural=True)
        self.assertFalse(r['applies'])
        self.assertEqual(r['total'], Decimal('0.00'))


class TransporterPayableTests(SimpleTestCase):
    def test_payable_is_freight_only_not_including_rcm(self):
        # transporter gets the freight; RCM GST goes to govt, never to them
        self.assertEqual(
            fr.transporter_payable_excludes_rcm(Decimal('22400')),
            Decimal('22400.00'))


class RoadSacTests(SimpleTestCase):
    def test_consignment_note_is_gta_996511(self):
        sac, is_gta = fr.classify_road_service(True)
        self.assertEqual(sac, '996511')
        self.assertTrue(is_gta)

    def test_no_note_is_rental_996791_not_gta(self):
        sac, is_gta = fr.classify_road_service(False)
        self.assertEqual(sac, '996791')
        self.assertFalse(is_gta)


class CompositeSupplyTests(SimpleTestCase):
    def test_clubs_ancillaries_into_taxable_value(self):
        v = fr.composite_taxable_value(
            Decimal('20000'), loading=500, unloading=500,
            detention=1000, fuel_surcharge=400)
        self.assertEqual(v, Decimal('22400.00'))

    def test_freight_only_when_no_ancillaries(self):
        self.assertEqual(fr.composite_taxable_value(Decimal('22400')),
                         Decimal('22400.00'))

    def test_rcm_on_composite_value(self):
        # RCM must be computed on freight + ancillaries, not freight alone
        taxable = fr.composite_taxable_value(Decimal('20000'), loading=2400)
        r = fr.compute_rcm_gst(taxable)
        self.assertEqual(r['total'], Decimal('1120.00'))   # 5% of 22,400


class AnnexureVFcmTests(SimpleTestCase):
    def test_annexure_v_valid_only_for_its_fy(self):
        self.assertTrue(fr.annexure_v_valid('2026-27', '2026-27'))
        self.assertFalse(fr.annexure_v_valid('2025-26', '2026-27'))
        self.assertFalse(fr.annexure_v_valid('', '2026-27'))

    def test_fcm_5pct(self):
        self.assertEqual(fr.compute_fcm_gst(Decimal('22400')), Decimal('1120.00'))

    def test_fcm_12pct_slab(self):
        self.assertEqual(fr.compute_fcm_gst(Decimal('22400'), slab_12=True),
                         Decimal('2688.00'))

    def test_mechanism_rcm_when_no_annexure(self):
        self.assertEqual(
            fr.freight_charge_mechanism(is_gta=True, has_consignment_note=True,
                                        annexure_v_opted_fy='', current_fy='2026-27'),
            'RCM')

    def test_mechanism_fcm_when_annexure_valid(self):
        self.assertEqual(
            fr.freight_charge_mechanism(is_gta=True, has_consignment_note=True,
                                        annexure_v_opted_fy='2026-27', current_fy='2026-27'),
            'FCM')

    def test_mechanism_none_without_consignment_note(self):
        self.assertEqual(
            fr.freight_charge_mechanism(is_gta=True, has_consignment_note=False,
                                        annexure_v_opted_fy='', current_fy='2026-27'),
            'NONE')


class SelfInvoiceTests(SimpleTestCase):
    def test_rcm_unregistered_needs_self_invoice(self):
        self.assertTrue(fr.needs_self_invoice(mechanism='RCM',
                                              supplier_registered=False))

    def test_rcm_registered_no_self_invoice(self):
        self.assertFalse(fr.needs_self_invoice(mechanism='RCM',
                                               supplier_registered=True))

    def test_fcm_never_needs_self_invoice(self):
        self.assertFalse(fr.needs_self_invoice(mechanism='FCM',
                                               supplier_registered=False))


class RcmLedgerTests(SimpleTestCase):
    def test_cash_liability_and_itc_when_eligible(self):
        p = fr.rcm_ledger_postings(Decimal('1120'), itc_eligible=True)
        self.assertEqual(p['cash_ledger_liability'], Decimal('1120.00'))
        self.assertEqual(p['itc_receivable'], Decimal('1120.00'))
        self.assertEqual(p['net_cost'], Decimal('0.00'))   # nets to zero

    def test_ineligible_itc_is_real_cost(self):
        p = fr.rcm_ledger_postings(Decimal('1120'), itc_eligible=False)
        self.assertEqual(p['itc_receivable'], Decimal('0.00'))
        self.assertEqual(p['net_cost'], Decimal('1120.00'))

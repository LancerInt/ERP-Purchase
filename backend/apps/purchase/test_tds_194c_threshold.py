"""194C threshold gate in the fresh TDS calculator — ``tds_fresh.tds_profile``.

WHAT THIS PINS
--------------
194C (works / contract / freight / EXPENSE bills) must deduct TDS only once a
SINGLE bill is ≥ ₹30,000 OR the vendor's FY aggregate is ≥ ₹1,00,000 — sec
194C(5). A small expense bill (e.g. a ₹6,286 jeweller's expense) must NOT be
taxed from the first rupee.

The regression this guards: tds_fresh used `base=None` for 194C, which taxed the
full per-bill amount with no threshold, so a ₹6,450 bill wrongly showed ₹125.73
TDS and a net Balance Due of ₹6,324.27. These tests are the executable spec of
the gate. Pure (no DB).
"""
from decimal import Decimal

from django.test import SimpleTestCase

from purchase.tds_fresh import tds_profile, tds_due


def _profile(base, agg, *, category='EXPENSE', pan='ABCDE1234F', party='COMPANY'):
    return tds_profile({
        'pan': pan, 'category': category, 'party_type': party,
        'is_msme': False, 'transporter_decl': False,
        'this_bill_base': Decimal(str(base)), 'fy_aggregate': Decimal(str(agg)),
    })


class Tds194cThresholdTests(SimpleTestCase):
    def test_small_expense_bill_no_tds(self):
        # ₹6,286 single bill, FY aggregate equal to it → below both limits → NIL.
        p = _profile(6286.41, 6286.41)
        self.assertEqual(p['section'], '194C')
        self.assertEqual(p['rate'], Decimal('0'))
        self.assertEqual(tds_due(p, taxable_base=Decimal('6286.41')), Decimal('0.00'))

    def test_single_bill_at_30k_is_taxed(self):
        # A single bill ≥ ₹30,000 breaches the single-bill limit → 2% (company).
        p = _profile(30000, 30000)
        self.assertEqual(p['section'], '194C')
        self.assertEqual(p['rate'], Decimal('0.02'))
        self.assertEqual(tds_due(p, taxable_base=Decimal('30000')), Decimal('600.00'))

    def test_small_bill_but_annual_crossed_is_taxed(self):
        # This bill is tiny (₹6,286) but the vendor's FY aggregate already ≥ ₹1L
        # → annual limit breached → the bill is taxed.
        p = _profile(6286.41, 100000)
        self.assertEqual(p['rate'], Decimal('0.02'))
        self.assertEqual(tds_due(p, taxable_base=Decimal('6286.41')), Decimal('125.73'))

    def test_just_below_annual_small_bill_no_tds(self):
        # FY aggregate ₹99,999 (just under ₹1L) and single bill under ₹30k → NIL.
        p = _profile(5000, 99999)
        self.assertEqual(p['rate'], Decimal('0'))
        self.assertEqual(tds_due(p, taxable_base=Decimal('5000')), Decimal('0.00'))

    def test_individual_rate_when_taxed(self):
        p = _profile(30000, 30000, party='INDIVIDUAL')
        self.assertEqual(p['rate'], Decimal('0.01'))

    def test_goods_194q_unaffected(self):
        # The 194C gate must not touch the 194Q (goods) path.
        p = _profile(6286.41, 6286.41, category='GOODS')
        self.assertEqual(p['section'], '194Q')
        self.assertEqual(p['rate'], Decimal('0'))   # below ₹50L

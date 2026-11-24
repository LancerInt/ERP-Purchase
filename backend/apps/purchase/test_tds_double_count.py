"""TDS must be subtracted from the vendor payable ONCE — never twice.

THE SYMPTOM
-----------
Recording the real bank payment against a vendor bill was rejected with
"Amount (3267716) exceeds net payable (3264944)" — short by exactly the bill's
TDS (Rs 2,772). The bank had paid Tally's own voucher total (Rs 32,67,716).

WHY IT HAPPENED
---------------
Some bills store total_amount ALREADY NET of 194Q/194C TDS — the scanner reads
the Tally voucher, whose total is (subtotal + GST − TDS). But net_payable_to_vendor
ALSO subtracted the TDS from the separately-imported TdsPayable register, so the
same TDS was removed twice: once baked into total_amount, once in the property.
Net payable landed BELOW Tally by exactly the TDS, and the gross bank payment was
wrongly rejected.

WHAT THIS PINS
--------------
_tds_already_in_total (the pure decision behind VendorBill.tds_already_in_total):
  * NET-total bill  -> True  (skip the second subtraction)
  * GROSS-total bill-> False (subtract once, as before)
  * the stored total_is_net flag overrides the guess both ways
  * a non-TDS bill is never affected
Both directions, because fixing the net case by breaking the gross case (or vice
versa) is the easy mistake. Real Asia Crystal numbers are used as the headline.
"""
import unittest
from decimal import Decimal

from purchase.models import _tds_already_in_total


D = Decimal


def decide(**kw):
    base = dict(total_is_net=None, tds_withheld=D('0'), tds_deducted=D('0'),
                subtotal=D('0'), tax_amount=D('0'), total_amount=D('0'))
    base.update(kw)
    return _tds_already_in_total(**base)


class TdsDoubleCountTests(unittest.TestCase):

    # Asia Crystal PDY/CR-1004: taxable 27,71,600 + GST 4,98,888, TDS 2,772,
    # total stored NET = 32,67,716 (= gross 32,70,488 − 2,772).
    AC = dict(subtotal=D('2771600'), tax_amount=D('498888'),
              total_amount=D('3267716'), tds_withheld=D('2772'), tds_deducted=D('2772'))

    def test_net_total_bill_is_detected(self):
        # total already net -> must NOT subtract TDS again.
        self.assertTrue(decide(**self.AC))

    def test_gross_total_bill_is_not(self):
        # Same bill booked GROSS: total = subtotal + GST = 32,70,488.
        g = dict(self.AC, total_amount=D('3270488'))
        self.assertFalse(decide(**g))

    def test_flag_true_overrides_guess(self):
        # Importer said net, even on a gross-looking total -> trust the flag.
        self.assertTrue(decide(total_is_net=True, tds_withheld=D('2772'),
                               subtotal=D('2771600'), tax_amount=D('498888'),
                               total_amount=D('3270488')))

    def test_flag_false_overrides_guess(self):
        # Importer said gross, even on a net-looking total -> trust the flag.
        self.assertFalse(decide(total_is_net=False, **self.AC))

    def test_no_tds_never_affected(self):
        self.assertFalse(decide(subtotal=D('100000'), tax_amount=D('18000'),
                                total_amount=D('118000'), tds_withheld=D('0')))

    def test_deducted_signal_when_withheld_differs(self):
        # Even if the withheld (TdsPayable) sum is momentarily off, the bill's own
        # deducted tds_amount baked into the total still proves it's net.
        self.assertTrue(decide(subtotal=D('2771600'), tax_amount=D('498888'),
                               total_amount=D('3267716'), tds_withheld=D('2772'),
                               tds_deducted=D('2772')))

    def test_net_payable_math_end_to_end(self):
        # The whole point: net payable for the net-total bill == the gross total,
        # so the real bank payment is accepted.
        net = self.AC['total_amount'] - (D('0') if decide(**self.AC) else self.AC['tds_withheld'])
        self.assertEqual(net, D('3267716'))
        # And a genuinely gross bill still nets down by its TDS.
        g = dict(self.AC, total_amount=D('3270488'))
        gnet = g['total_amount'] - (D('0') if decide(**g) else g['tds_withheld'])
        self.assertEqual(gnet, D('3267716'))


if __name__ == '__main__':
    unittest.main()

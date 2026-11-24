"""PO receipt balance: physical-received accounting, carry-forward, over-receipt
block, product-fallback attribution, and short-close.

The rule under test: a PO closes against what PHYSICALLY arrived (net qty, else
invoice qty; a debit-note line settles its invoice qty). A short delivery keeps
the PO open for the shortfall, which the next receipt can fulfill, and you can
never receive more than what's still pending.
"""
import datetime
from decimal import Decimal

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework.exceptions import ValidationError

from core.models import Company, Warehouse
from master.models import Vendor, Product
from purchase.models import (
    PurchaseOrder, POLine, ReceiptAdvice, ReceiptLine,
    received_qty_of,
)
from purchase.serializers import ReceiptAdviceSerializer, POLineSerializer

TODAY = datetime.date.today()
D = Decimal


class POReceiptBalanceTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_superuser('t', 't@e.com', 'pw12345')
        cls.co = Company.objects.create(company_code='SSB', legal_name='SS Biochem', trade_name='SS')
        cls.wh = Warehouse.objects.create(company=cls.co, warehouse_code='WH', name='WH')
        cls.v = Vendor.objects.create(vendor_code='V1', vendor_name='Vendor One', company=cls.co, vendor_type=['RM'])
        cls.prod = Product.objects.create(product_name='Maize', sku_code='SKU-MZ')

    def _po(self, ordered='1000'):
        po = PurchaseOrder.objects.create(
            po_no=f'PO-{id(self)}-{ordered}', vendor=self.v, company=self.co,
            warehouse=self.wh, po_date=TODAY, status='CONFIRMED')
        pl = POLine.objects.create(
            po=po, line_no=1, product_service=self.prod, category='RM',
            quantity_ordered=D(ordered), uom='KG', unit_price=D('100'))
        return po, pl

    def _receipt(self, po, pl, received, net=None, debit=False):
        ra = ReceiptAdvice.objects.create(warehouse=self.wh, vendor=self.v)
        ra.linked_pos.add(po)
        ReceiptLine.objects.create(
            receipt=ra, po_line=pl, product=self.prod, line_no=1,
            quantity_received=D(received),
            net_quantity=(D(net) if net is not None else None),
            is_debit_note=debit)
        return ra

    # ── physical received basis ──────────────────────────────────────────────
    def test_received_counts_net_quantity_not_invoice(self):
        # Invoice 1000, physically 998 -> PO received 998, NOT fully received.
        po, pl = self._po('1000')
        self._receipt(po, pl, received='1000', net='998')
        self.assertEqual(po.get_total_received(), D('998.00'))
        self.assertFalse(po.is_fully_received())

    def test_received_falls_back_to_invoice_when_no_net(self):
        # No net captured -> counts invoice qty (legacy/simple rows).
        po, pl = self._po('1000')
        self._receipt(po, pl, received='1000')  # net None
        self.assertEqual(po.get_total_received(), D('1000.00'))
        self.assertTrue(po.is_fully_received())

    def test_debit_note_line_settles_invoice_qty(self):
        # A debit-note line counts its invoice qty (short debited back), so it
        # closes that slice even though net is lower.
        po, pl = self._po('1000')
        self._receipt(po, pl, received='1000', net='998', debit=True)
        self.assertEqual(po.get_total_received(), D('1000.00'))

    def test_serializer_and_model_agree(self):
        po, pl = self._po('1000')
        self._receipt(po, pl, received='1000', net='600')
        self.assertEqual(
            Decimal(str(POLineSerializer().get_received_quantity(pl))),
            po.get_total_received())

    def test_received_qty_of_python_twin(self):
        rl = ReceiptLine(quantity_received=D('1000'), net_quantity=D('998'), is_debit_note=False)
        self.assertEqual(received_qty_of(rl), D('998'))
        rl2 = ReceiptLine(quantity_received=D('1000'), net_quantity=D('998'), is_debit_note=True)
        self.assertEqual(received_qty_of(rl2), D('1000'))
        rl3 = ReceiptLine(quantity_received=D('1000'), net_quantity=None, is_debit_note=False)
        self.assertEqual(received_qty_of(rl3), D('1000'))

    # ── carry-forward balance ────────────────────────────────────────────────
    def test_balance_carries_forward_across_receipts(self):
        po, pl = self._po('1000')
        self._receipt(po, pl, received='998', net='998')  # 2 pending
        self.assertEqual(po.get_total_received(), D('998.00'))
        self._receipt(po, pl, received='2', net='2')       # the rest arrives
        self.assertEqual(po.get_total_received(), D('1000.00'))
        self.assertTrue(po.is_fully_received())

    # ── product fallback (no po_line FK) ─────────────────────────────────────
    def test_received_attributes_without_po_line_fk(self):
        # A receipt line linked to the PO (linked_pos) but WITHOUT a po_line FK
        # still counts, matched by product.
        po, pl = self._po('1000')
        ra = ReceiptAdvice.objects.create(warehouse=self.wh, vendor=self.v)
        ra.linked_pos.add(po)
        ReceiptLine.objects.create(
            receipt=ra, po_line=None, product=self.prod, line_no=1,
            quantity_received=D('600'), net_quantity=D('580'))
        self.assertEqual(po.get_total_received(), D('580'))

    # ── over-receipt hard block ──────────────────────────────────────────────
    def _validate_receive(self, po, pl, qty, net=None):
        ser = ReceiptAdviceSerializer()
        data = {
            'warehouse': self.wh, 'vendor': self.v,
            'receipt_lines': [{
                'po_line': pl, 'product': self.prod,
                'quantity_received': D(qty),
                'net_quantity': (D(net) if net is not None else None),
                'uom': 'KG', 'line_no': 1,
            }],
        }
        return ser.validate(data)

    def test_over_receipt_is_blocked(self):
        po, pl = self._po('1000')
        self._receipt(po, pl, received='998', net='998')  # 2 pending
        with self.assertRaises(ValidationError):
            self._validate_receive(po, pl, qty='3', net='3')  # only 2 left

    def test_receiving_exactly_pending_is_allowed(self):
        po, pl = self._po('1000')
        self._receipt(po, pl, received='998', net='998')
        # exactly 2 is fine — no raise
        self._validate_receive(po, pl, qty='2', net='2')

    def test_over_receipt_uses_physical_not_invoice(self):
        # Pending is 2. A line invoicing 3 but netting 2 is OK (physical fits).
        po, pl = self._po('1000')
        self._receipt(po, pl, received='998', net='998')
        self._validate_receive(po, pl, qty='3', net='2')  # physical 2 == pending

    # ── short-close ──────────────────────────────────────────────────────────
    def test_close_po_short(self):
        po, pl = self._po('1000')
        self._receipt(po, pl, received='998', net='998')
        c = APIClient(); c.force_authenticate(self.user)
        r = c.post(f'/api/purchase/orders/{po.id}/close/', {'reason': 'balance cancelled'})
        self.assertEqual(r.status_code, 200, r.content[:300])
        po.refresh_from_db()
        self.assertEqual(po.status, 'CLOSED')
        self.assertEqual(po.close_reason, 'balance cancelled')
        self.assertIsNotNone(po.closed_at)

    def test_close_requires_reason(self):
        po, pl = self._po('1000')
        self._receipt(po, pl, received='998', net='998')
        c = APIClient(); c.force_authenticate(self.user)
        r = c.post(f'/api/purchase/orders/{po.id}/close/', {'reason': ''})
        self.assertEqual(r.status_code, 400)

    def test_cannot_close_fully_received_po(self):
        po, pl = self._po('1000')
        self._receipt(po, pl, received='1000', net='1000')
        c = APIClient(); c.force_authenticate(self.user)
        r = c.post(f'/api/purchase/orders/{po.id}/close/', {'reason': 'x'})
        self.assertEqual(r.status_code, 400)

"""Stock picks up goods from ANY bill source, with no double count.

Wiring under test:
  * a SCAN / MANUAL bill (no linked receipt) adds its line qty to Stock;
  * a bill that IS linked to a receipt does NOT double-count — the receipt
    carries the goods, the bill's lines are skipped (receipt wins);
  * the product drill shows a 'Bill' movement row for the receipt-less bill.
"""
import datetime
from decimal import Decimal

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from core.models import Company, Warehouse
from master.models import Vendor, Product
from purchase.models import (
    VendorBill, VendorBillLine, ReceiptAdvice, ReceiptLine,
)

TODAY = datetime.date.today()


class StockBillInTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_superuser('t', 't@e.com', 'pw12345')
        cls.co = Company.objects.create(company_code='SSB-002', legal_name='SS Biochem', trade_name='SS Biochem')
        cls.wh = Warehouse.objects.create(company=cls.co, warehouse_code='WH', name='WH')
        cls.vendor = Vendor.objects.create(vendor_code='V1', vendor_name='V One', company=cls.co, vendor_type=['RM'])
        cls.prod_scan = Product.objects.create(product_name='Scan Maize', sku_code='SKU-SCAN')
        cls.prod_rcpt = Product.objects.create(product_name='Receipt Maize', sku_code='SKU-RCPT')

        # (1) SCAN / MANUAL bill — NO receipt. 500 units of prod_scan.
        b1 = VendorBill.objects.create(
            vendor=cls.vendor, warehouse=cls.wh, bill_date=TODAY,
            subtotal=Decimal('50000'), total_amount=Decimal('50000'),
            status='OPEN', purchase_category='RM',
        )
        VendorBillLine.objects.create(bill=b1, product=cls.prod_scan, quantity=Decimal('500'), uom='KG')

        # (2) Bill LINKED to a receipt — the receipt has 300 units of prod_rcpt,
        # and the bill also lists 300. Only the receipt should count.
        ra = ReceiptAdvice.objects.create(warehouse=cls.wh, vendor=cls.vendor)
        ReceiptLine.objects.create(receipt=ra, product=cls.prod_rcpt, line_no=1,
                                   quantity_received=Decimal('300'), uom='KG')
        b2 = VendorBill.objects.create(
            vendor=cls.vendor, warehouse=cls.wh, bill_date=TODAY, receipt_advice=ra,
            subtotal=Decimal('30000'), total_amount=Decimal('30000'),
            status='OPEN', purchase_category='RM',
        )
        VendorBillLine.objects.create(bill=b2, product=cls.prod_rcpt, quantity=Decimal('300'), uom='KG')

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _rows(self):
        r = self.client.get('/api/purchase/stock/', {'company': str(self.co.id)})
        self.assertEqual(r.status_code, 200, r.content[:300])
        return {x['product']: x for x in r.data['items']}

    def test_scanned_bill_adds_to_stock(self):
        rows = self._rows()
        self.assertIn('Scan Maize', rows)
        self.assertEqual(Decimal(rows['Scan Maize']['received']), Decimal('500'))
        self.assertEqual(Decimal(rows['Scan Maize']['on_hand']), Decimal('500'))

    def test_receipt_linked_bill_not_double_counted(self):
        rows = self._rows()
        # 300 from the receipt, NOT 600 (receipt + bill line).
        self.assertEqual(Decimal(rows['Receipt Maize']['received']), Decimal('300'))
        self.assertEqual(Decimal(rows['Receipt Maize']['on_hand']), Decimal('300'))

    def test_drill_shows_bill_row_for_receiptless(self):
        r = self.client.get(f'/api/purchase/stock/{self.prod_scan.id}/', {'company': str(self.co.id)})
        self.assertEqual(r.status_code, 200, r.content[:300])
        types = [m['type'] for m in r.data['moves']]
        self.assertIn('Bill', types)
        self.assertEqual(Decimal(r.data['on_hand']), Decimal('500'))

    def test_drill_receiptlinked_shows_receipt_not_bill(self):
        r = self.client.get(f'/api/purchase/stock/{self.prod_rcpt.id}/', {'company': str(self.co.id)})
        types = [m['type'] for m in r.data['moves']]
        self.assertIn('Receipt', types)
        self.assertNotIn('Bill', types)   # the linked bill must not appear as a 2nd in-row
        self.assertEqual(Decimal(r.data['on_hand']), Decimal('300'))

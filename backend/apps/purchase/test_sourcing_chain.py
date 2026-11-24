"""Sourcing workflow linkage — PR → RFQ → Quotes → Evaluation → PO → Bill → Receipt.

Proves every link in the chain connects (the FKs/M2Ms the UI walks to show the
flow), and that a bill on a PO is deduped against its receipt for Stock (receipt
wins) while still flagging its PO reach.
"""
import datetime
from decimal import Decimal

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from core.models import Company, Warehouse
from master.models import Vendor, Product
from purchase.models import (
    PurchaseRequest, PRLine, RFQHeader, QuoteResponse, QuoteLine,
    QuoteEvaluation, PurchaseOrder, POLine, VendorBill, VendorBillLine,
    ReceiptAdvice, ReceiptLine,
)

TODAY = datetime.date.today()
D = Decimal


class SourcingChainTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_superuser('t', 't@e.com', 'pw12345')
        cls.co = Company.objects.create(company_code='SSB', legal_name='SS Biochem', trade_name='SS')
        cls.wh = Warehouse.objects.create(company=cls.co, warehouse_code='WH', name='WH')
        cls.v1 = Vendor.objects.create(vendor_code='V1', vendor_name='Cheap Vendor', company=cls.co, vendor_type=['RM'])
        cls.v2 = Vendor.objects.create(vendor_code='V2', vendor_name='Dear Vendor', company=cls.co, vendor_type=['RM'])
        cls.prod = Product.objects.create(product_name='Maize', sku_code='SKU-MZ')

        # 1) PR (approved) + line
        cls.pr = PurchaseRequest.objects.create(
            pr_no='PR-T1', company=cls.co, warehouse=cls.wh,
            requirement_type='GOODS', approval_status='APPROVED', notes='chain')
        PRLine.objects.create(purchase_request=cls.pr, line_no=1, category='RM',
                              product_service=cls.prod, quantity_requested=D('1000'), uom='KG')

        # 2) RFQ links the PR
        cls.rfq = RFQHeader.objects.create(rfq_no='RFQ-T1', rfq_mode='STANDARD', rfq_status='CLOSED')
        cls.rfq.linked_prs.add(cls.pr)

        # 3) two quotes, v1 cheaper
        cls.q1 = QuoteResponse.objects.create(quote_id='Q-T1-1', rfq=cls.rfq, vendor=cls.v1,
                                              quote_date=TODAY, chosen_flag=True)
        QuoteLine.objects.create(quote=cls.q1, product_service=cls.prod,
                                 quantity_offered=D('1000'), uom='KG', unit_price=D('100'), is_awarded=True)
        cls.q2 = QuoteResponse.objects.create(quote_id='Q-T1-2', rfq=cls.rfq, vendor=cls.v2,
                                              quote_date=TODAY, chosen_flag=False)
        QuoteLine.objects.create(quote=cls.q2, product_service=cls.prod,
                                 quantity_offered=D('1000'), uom='KG', unit_price=D('120'))

        # 4) evaluation recommends v1
        cls.ev = QuoteEvaluation.objects.create(evaluation_id='EV-T1', rfq=cls.rfq,
                                                best_quote_flag=True, recommended_vendor=cls.v1,
                                                approval_status='APPROVED')

        # 5) PO to v1, links RFQ + PR
        cls.po = PurchaseOrder.objects.create(po_no='PO-T1', vendor=cls.v1, company=cls.co,
                                              warehouse=cls.wh, linked_rfq=cls.rfq,
                                              po_date=TODAY, status='CONFIRMED')
        cls.po.linked_prs.add(cls.pr)
        POLine.objects.create(po=cls.po, line_no=1, product_service=cls.prod,
                              category='RM', quantity_ordered=D('1000'), uom='KG', unit_price=D('100'))

        # 6) receipt against the PO (600 of 1000)
        cls.ra = ReceiptAdvice.objects.create(warehouse=cls.wh, vendor=cls.v1)
        cls.ra.linked_pos.add(cls.po)
        ReceiptLine.objects.create(receipt=cls.ra, product=cls.prod, line_no=1,
                                   quantity_received=D('600'), uom='KG')

        # 7) bill on the PO + receipt
        cls.bill = VendorBill.objects.create(vendor=cls.v1, warehouse=cls.wh,
                                             purchase_order=cls.po, receipt_advice=cls.ra,
                                             vendor_invoice_no='INV-T1', bill_date=TODAY,
                                             subtotal=D('100000'), tax_amount=D('18000'),
                                             total_amount=D('118000'), status='OPEN',
                                             purchase_category='RM')
        VendorBillLine.objects.create(bill=cls.bill, product=cls.prod,
                                      quantity=D('1000'), rate=D('100'), amount=D('100000'), uom='KG')

    # ── linkage ──────────────────────────────────────────────────────────────
    def test_rfq_links_the_pr(self):
        self.assertIn(self.pr, self.rfq.linked_prs.all())

    def test_quotes_belong_to_the_rfq_and_one_is_chosen(self):
        qs = QuoteResponse.objects.filter(rfq=self.rfq)
        self.assertEqual(qs.count(), 2)
        self.assertEqual(qs.filter(chosen_flag=True).count(), 1)
        self.assertEqual(qs.get(chosen_flag=True).vendor, self.v1)   # the cheaper one

    def test_evaluation_recommends_cheapest_vendor(self):
        self.assertEqual(self.ev.rfq, self.rfq)
        self.assertEqual(self.ev.recommended_vendor, self.v1)

    def test_po_links_rfq_and_pr_and_goes_to_recommended_vendor(self):
        self.assertEqual(self.po.linked_rfq, self.rfq)
        self.assertIn(self.pr, self.po.linked_prs.all())
        self.assertEqual(self.po.vendor, self.ev.recommended_vendor)

    def test_receipt_links_the_po(self):
        self.assertIn(self.po, self.ra.linked_pos.all())
        self.assertEqual(self.ra.receipt_lines.count(), 1)

    def test_bill_links_po_and_receipt(self):
        self.assertEqual(self.bill.purchase_order, self.po)
        self.assertEqual(self.bill.receipt_advice, self.ra)

    def test_full_chain_is_traversable_end_to_end(self):
        # PR -> RFQ -> chosen quote's vendor == PO vendor == bill vendor; and the
        # receipt + bill both hang off the same PO.
        rfq = RFQHeader.objects.filter(linked_prs=self.pr).first()
        chosen = QuoteResponse.objects.get(rfq=rfq, chosen_flag=True)
        po = PurchaseOrder.objects.get(linked_rfq=rfq)
        bill = VendorBill.objects.get(purchase_order=po)
        receipt = ReceiptAdvice.objects.filter(linked_pos=po).first()
        self.assertEqual(chosen.vendor, po.vendor)
        self.assertEqual(po.vendor, bill.vendor)
        self.assertEqual(bill.receipt_advice, receipt)

    # ── reach / stock dedup (the "Appears in" chips) ──────────────────────────
    def test_bill_reach_flags_po_and_stock(self):
        c = APIClient(); c.force_authenticate(self.user)
        r = c.get('/api/purchase/bills/', {'slim': 'list', 'q': 'INV-T1'})
        self.assertEqual(r.status_code, 200, r.content[:300])
        rows = r.data.get('results', r.data)
        row = next(b for b in rows if b['vendor_invoice_no'] == 'INV-T1')
        self.assertTrue(row['reach']['po'])      # has a purchase order
        self.assertTrue(row['reach']['stock'])   # has goods lines

    def test_receipt_linked_bill_not_double_counted_in_stock(self):
        # The bill is on a receipt, so Stock counts the RECEIPT (600), not the
        # bill's 1000 on top — receipt wins (no double count).
        c = APIClient(); c.force_authenticate(self.user)
        r = c.get('/api/purchase/stock/', {'company': str(self.co.id)})
        self.assertEqual(r.status_code, 200, r.content[:300])
        row = next(x for x in r.data['items'] if x['product'] == 'Maize')
        self.assertEqual(Decimal(row['received']), Decimal('600'))

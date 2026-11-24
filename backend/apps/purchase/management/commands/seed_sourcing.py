"""Seed one complete SOURCING chain per company so the flow is visible end-to-end:

    Purchase Request (approved)
      -> RFQ (links the PR)
        -> 2 Quotes from 2 vendors (with line prices)
          -> Quote Evaluation (recommends the cheaper vendor)
            -> Purchase Order (links RFQ + PR, with lines)
              -> Receipt Advice (goods received against the PO)

Idempotent: rows carry a 'SRC-DEMO' marker in a text field and are wiped + rebuilt
on each run. Safe to run repeatedly. Usage:  python manage.py seed_sourcing
"""
import datetime
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction


class Command(BaseCommand):
    help = 'Seed a demo PR -> RFQ -> Quotes -> Evaluation -> PO -> Receipt chain per company.'

    @transaction.atomic
    def handle(self, *args, **opts):
        from core.models import Company, Warehouse
        from master.models import Vendor, Product
        from purchase.models import (
            PurchaseRequest, PRLine, RFQHeader, QuoteResponse, QuoteLine,
            QuoteEvaluation, PurchaseOrder, POLine, ReceiptAdvice, ReceiptLine,
        )

        w = self.stdout.write
        today = datetime.date.today()

        # ── wipe previous demo chain (by marker) ─────────────────────────────
        QuoteEvaluation.objects.filter(justification_notes__startswith='SRC-DEMO').delete()
        QuoteLine.objects.filter(quote__remarks__startswith='SRC-DEMO').delete()
        QuoteResponse.objects.filter(remarks__startswith='SRC-DEMO').delete()
        RFQHeader.objects.filter(skip_rfq_justification__startswith='SRC-DEMO').delete()
        # POs / Receipts / PRs made by this command carry SRC-DEMO in their notes/terms.
        for ra in ReceiptAdvice.objects.filter(vehicle_number='SRC-DEMO'):
            ra.delete()
        PurchaseOrder.objects.filter(terms_and_conditions__startswith='SRC-DEMO').delete()
        PurchaseRequest.objects.filter(notes__startswith='SRC-DEMO').delete()

        companies = list(Company.objects.all())
        if not companies:
            w(self.style.ERROR('No companies — run seed_demo first.'))
            return

        n_chain = 0
        for co in companies:
            wh = Warehouse.objects.filter(company=co).first()
            vendors = list(Vendor.objects.filter(company=co)[:2])
            prods = list(Product.objects.all()[:2])
            if not (wh and len(vendors) >= 2 and prods):
                w(f'  {co.legal_name}: skipped (needs 1 warehouse, 2 vendors, a product)')
                continue
            v1, v2 = vendors[0], vendors[1]
            prod = prods[0]
            tag = co.company_code or co.legal_name[:6]

            # 1) PURCHASE REQUEST (approved) + a line
            pr = PurchaseRequest.objects.create(
                pr_no=f'PR-DEMO-{tag}', company=co, warehouse=wh,
                requirement_type='GOODS', priority='NORMAL',
                required_by_date=today + datetime.timedelta(days=20),
                justification='Demo requirement', approval_status='APPROVED',
                notes='SRC-DEMO sourcing chain',
            )
            PRLine.objects.create(
                purchase_request=pr, line_no=1, category='RM', product_service=prod,
                quantity_requested=Decimal('1000'), uom='KG',
                required_date=today + datetime.timedelta(days=20), status='APPROVED',
                approved_quantity=Decimal('1000'),
            )

            # 2) RFQ linking the PR
            rfq = RFQHeader.objects.create(
                rfq_no=f'RFQ-DEMO-{tag}', rfq_mode='STANDARD', rfq_status='CLOSED',
                quote_count_expected=2, skip_rfq_justification='SRC-DEMO',
            )
            rfq.linked_prs.add(pr)

            # 3) TWO QUOTES (v1 cheaper than v2) with a line each
            q1 = QuoteResponse.objects.create(
                quote_id=f'Q-DEMO-{tag}-1', rfq=rfq, vendor=v1,
                vendor_name_text=v1.vendor_name, quote_date=today,
                price_valid_till=today + datetime.timedelta(days=30),
                payment_terms='30 days', lead_time_days=7,
                remarks='SRC-DEMO', chosen_flag=True,
            )
            QuoteLine.objects.create(
                quote=q1, product_service=prod, quantity_offered=Decimal('1000'),
                uom='KG', unit_price=Decimal('100'), gst=Decimal('18'), is_awarded=True,
            )
            q2 = QuoteResponse.objects.create(
                quote_id=f'Q-DEMO-{tag}-2', rfq=rfq, vendor=v2,
                vendor_name_text=v2.vendor_name, quote_date=today,
                price_valid_till=today + datetime.timedelta(days=30),
                payment_terms='15 days', lead_time_days=10,
                remarks='SRC-DEMO', chosen_flag=False,
            )
            QuoteLine.objects.create(
                quote=q2, product_service=prod, quantity_offered=Decimal('1000'),
                uom='KG', unit_price=Decimal('112'), gst=Decimal('18'), is_awarded=False,
            )

            # 4) EVALUATION recommending the cheaper vendor (v1)
            QuoteEvaluation.objects.create(
                evaluation_id=f'EVAL-DEMO-{tag}', rfq=rfq, best_quote_flag=True,
                recommended_vendor=v1, approval_status='APPROVED',
                justification_notes='SRC-DEMO cheapest compliant quote',
            )

            # 5) PURCHASE ORDER to v1, linking RFQ + PR, with a line
            po = PurchaseOrder.objects.create(
                po_no=f'PO-DEMO-{tag}', vendor=v1, company=co, warehouse=wh,
                linked_rfq=rfq, po_date=today,
                expected_delivery_start=today + datetime.timedelta(days=5),
                expected_delivery_end=today + datetime.timedelta(days=15),
                payment_terms='30 days', status='CONFIRMED',
                terms_and_conditions='SRC-DEMO demo PO',
            )
            po.linked_prs.add(pr)
            POLine.objects.create(
                po=po, line_no=1, product_service=prod, category='RM',
                quantity_ordered=Decimal('1000'), uom='KG', unit_price=Decimal('100'),
                gst=Decimal('18'),
            )

            # 6) RECEIPT against the PO (partial: 600 of 1000 received)
            ra = ReceiptAdvice.objects.create(
                warehouse=wh, vendor=v1, vehicle_number='SRC-DEMO',
            )
            ra.linked_pos.add(po)
            ReceiptLine.objects.create(
                receipt=ra, product=prod, line_no=1,
                quantity_received=Decimal('600'), uom='KG',
            )

            n_chain += 1
            w(f'  {co.legal_name}: PR {pr.pr_no} -> RFQ {rfq.rfq_no} -> 2 quotes '
              f'-> eval -> PO {po.po_no} -> receipt (600/1000)')

        w(self.style.SUCCESS(f'Seeded {n_chain} sourcing chain(s).'))

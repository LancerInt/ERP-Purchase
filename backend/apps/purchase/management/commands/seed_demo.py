"""Seed realistic demo data across the standalone so every module shows
something. Idempotent-ish: safe to re-run (uses get_or_create on masters).

    python manage.py seed_demo
    python manage.py seed_demo --wipe    # clear demo transactions first
"""
import datetime
import random
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction


class Command(BaseCommand):
    help = 'Create demo vendors, products, bills, payments, staff, etc.'

    def add_arguments(self, p):
        p.add_argument('--wipe', action='store_true',
                       help='Delete demo transactions (bills/payments/etc.) first.')

    @transaction.atomic
    def handle(self, *args, **o):
        # Deterministic: same numbers every run so the demo is stable/"proper".
        random.seed(42)
        from core.models import Company, Warehouse, Godown
        from master.models import Vendor, Product, Transporter
        from purchase.models import (
            VendorBill, VendorBillLine, PaymentMade, VendorCredit,
            PurchaseRequest, PurchaseOrder,
            ReceiptAdvice, ReceiptLine, LocalFreight,
            FreightAdviceInbound, FreightPaymentInbound,
        )
        from bank.models import BankAccount
        from hr.models import Staff
        from sales.models import DebitNote as PurchaseDebitNote

        w = self.stdout.write
        company = Company.objects.first()
        warehouse = Warehouse.objects.first()
        if not company or not warehouse:
            w(self.style.ERROR('No Company/Warehouse — run setup_admin first.'))
            return

        # Name the first company SS Biochem (setup_admin creates "Main Company").
        if company.trade_name != 'SS Biochem':
            company.legal_name = 'SS Biochem'
            company.trade_name = 'SS Biochem'
            company.save(update_fields=['legal_name', 'trade_name'])
        # Second demo company so the global Company filter has something to switch.
        company2, _c2 = Company.objects.get_or_create(
            company_code='COMP02',
            defaults=dict(legal_name='United Agro Industries', trade_name='United Agro'))
        wh2, _w2 = Warehouse.objects.get_or_create(
            warehouse_code='WH02',
            defaults=dict(name='United Agro Warehouse', company=company2))
        companies = [company, company2]
        warehouses = {company.id: warehouse, company2.id: wh2}
        # Turn the TDS engine ON so 194Q computes on every bill (0.1% on the
        # vendor's FY aggregate above the ₹50L threshold), not just seeded rows.
        Company.objects.filter(id__in=[company.id, company2.id]).update(tds_engine_enabled=True)

        if o['wipe']:
            w('Wiping demo transactions…')
            VendorBillLine.objects.all().delete()
            VendorBill.objects.all().delete()
            PaymentMade.objects.all().delete()
            VendorCredit.objects.all().delete()
            PurchaseOrder.objects.all().delete()
            PurchaseRequest.objects.all().delete()
            PurchaseDebitNote.objects.all().delete()
            # Freight payments reference advices (CASCADE), but delete explicitly
            # so a --wipe without a full advice delete still clears them.
            FreightPaymentInbound.objects.all().delete()
            FreightAdviceInbound.objects.all().delete()
            ReceiptLine.objects.all().delete()
            ReceiptAdvice.objects.all().delete()
            LocalFreight.objects.all().delete()

        today = datetime.date.today()

        # ---- Bank accounts ----
        banks = []
        for code, nick, bank in [
            ('ICICI-001', 'ICICI Current A/c', 'ICICI Bank'),
            ('HDFC-001', 'HDFC Current A/c', 'HDFC Bank'),
            ('SBI-001', 'SBI OD A/c', 'State Bank of India'),
        ]:
            b, _ = BankAccount.objects.get_or_create(
                code=code, defaults=dict(nickname=nick, bank_name=bank,
                                         account_number=str(random.randint(10**10, 10**11)),
                                         company=company))
            banks.append(b)
        w(f'  bank accounts: {len(banks)}')

        # ---- Transporters ----
        for i, name in enumerate(['Sri Balaji Transports', 'VRL Logistics', 'TCI Freight'], start=1):
            Transporter.objects.get_or_create(
                name=name,
                defaults=dict(company=company, transporter_code=f'TPT-DEMO-{i:03d}'))
        w('  transporters: 3')

        # ---- Products (tagged RM vs PACKING so bill lines match the bill's
        # category — e.g. an RM bill gets Maize/Soya, a Packing bill gets Bags). ----
        prods_by_cat = {'RM': [], 'PACKING': []}
        product_defs = [
            ('Maize', 'RM'), ('Soya DOC', 'RM'), ('Rice Bran Oil', 'RM'),
            ('Oil Cake / DOC', 'RM'), ('HDPE Bags', 'PACKING'),
            ('Printing Ink', 'PACKING'), ('Bag / Liner', 'PACKING'),
        ]
        import re as _re
        for name, pcat in product_defs:
            slug = _re.sub(r'[^A-Z0-9]', '', name.upper())[:10]
            p, _ = Product.objects.get_or_create(
                product_name=name,
                defaults=dict(product_type='GOODS', sku_code=f'SKU-{slug}'))
            prods_by_cat[pcat].append(p)
        w(f'  products: {sum(len(v) for v in prods_by_cat.values())}')

        # ---- Vendors ----
        # (name, vendor_type, gstin, msme_category) — msme set => is_msme auto-True.
        # Purchase-focused standalone: all vendors are goods (RM / Packing)
        # suppliers, so Payment Entries shows only purchase payments (no Expense).
        # pan (4th item) given to the TDS vendor so the 194Q engine can act.
        vendor_defs = [
            ('Asia Crystal Commodity LLP', 'RM', '33AABCA1234A1Z5', ''),
            ('Kumaran Refractories', 'RM', '33AAACK5678B1Z2', 'SMALL'),      # MSME (UAI)
            ('Intellectual Technocrats', 'PACKING', '33AADCI9012C1Z8', 'MICRO'),  # MSME (SS)
            ('Radha Feeds', 'RM', '', 'SMALL'),                              # MSME (UAI)
            ('Green Packs India', 'PACKING', '33AABCG3456D1Z1', 'MEDIUM'),   # MSME (SS)
            ('Sri Vinayaga Traders', 'RM', '33AADCS7788E1Z4', ''),
        ]
        vendors = []
        for i, (name, vtype, gstin, msme) in enumerate(vendor_defs, start=1):
            # Alternate vendors between the two companies so each company has data.
            vco = companies[i % len(companies)]
            d = dict(company=vco, vendor_type=[vtype],
                     vendor_code=f'VEN-DEMO-{i:03d}',
                     gstin=gstin,
                     gst_treatment='REGULAR' if gstin else 'UNREGISTERED')
            v, _ = Vendor.objects.get_or_create(vendor_name=name, defaults=d)
            # Always (re)apply MSME flags so a re-seed keeps the demo consistent,
            # even for vendors that already existed.
            if msme and v.msme_category != msme:
                v.msme_category = msme
                v.msme_udyam_no = f'UDYAM-TN-00-{1000000 + i * 111111}'
                v.save()  # save() auto-sets is_msme
            vendors.append(v)
        w(f'  vendors: {len(vendors)}')

        # ---- Staff ----
        for i, (fn, ln, dept) in enumerate([
            ('Ramesh', 'Kumar', 'Purchase'), ('Priya', 'Sharma', 'Accounts'),
            ('Arun', 'Nair', 'Warehouse'), ('Divya', 'Menon', 'HR'),
        ], start=1):
            Staff.objects.get_or_create(
                staff_id=f'STF-DEMO-{i:03d}',
                defaults=dict(staff_type='EMPLOYEE', first_name=fn, last_name=ln,
                              department=dept, company=company,
                              primary_location=warehouse, employment_status='ACTIVE'))
        w('  staff: 4')

        # ---- Bills + lines ----
        # Map a vendor's type to the bill's purchase category so the
        # Total-Purchase-by-category view fills the right buckets (RM / Packing
        # / Expenses) instead of everything landing in "Unclassified".
        cat_of = {'RM': 'RM', 'PACKING': 'PACKING', 'EXPENSES': 'EXPENSES',
                  'FREIGHT': 'FREIGHT', 'MACHINERY': 'MACHINERY'}
        # One vendor has TDS deducted (194Q — 0.1% on goods purchases) so the
        # TDS column / TDS Summary page show real data. 194Q needs a PAN and
        # FY billing above ₹50L, so give this vendor both.
        tds_vendor = vendors[0]  # Asia Crystal Commodity LLP
        if not (tds_vendor.pan or '').strip():
            tds_vendor.pan = 'AABCA1234A'
            tds_vendor.save(update_fields=['pan'])
        bills = []
        n = 0
        for v in vendors:
            vtype = (v.vendor_type[0] if isinstance(v.vendor_type, list) and v.vendor_type else 'RM')
            category = cat_of.get(vtype, 'RM')
            # The TDS vendor gets more + bigger bills so FY billing crosses the
            # ₹50L 194Q threshold and the TDS Summary page shows a real figure.
            bill_count = 6 if v == tds_vendor else random.randint(2, 4)
            for k in range(bill_count):
                # Spread across the year, but make the FIRST bill of each vendor
                # land in the CURRENT month so the report's default (and the
                # Month view) always has data to show.
                if k == 0:
                    bdate = today - datetime.timedelta(days=random.randint(0, min(today.day - 1, 20)))
                else:
                    bdate = today - datetime.timedelta(days=random.randint(5, 240))
                if v == tds_vendor:
                    sub = Decimal(random.randint(900000, 1500000))   # ₹9–15L each
                else:
                    sub = Decimal(random.randint(20000, 500000))
                tax = (sub * Decimal('0.18')).quantize(Decimal('1.00'))
                total = sub + tax
                # 194Q TDS @ 0.1% of taxable, deducted for the TDS vendor only.
                tds_amt = (sub * Decimal('0.001')).quantize(Decimal('1.00')) if v == tds_vendor else Decimal('0')
                bill = VendorBill.objects.create(
                    vendor=v, warehouse=warehouses.get(v.company_id, warehouse),
                    vendor_invoice_no=f'INV-{random.randint(1000,9999)}',
                    bill_date=bdate, due_date=bdate + datetime.timedelta(days=30),
                    subtotal=sub, tax_amount=tax, total_amount=total,
                    tds_amount=tds_amt,
                    computed_tds_amount=tds_amt if tds_amt else None,
                    computed_tds_section='194Q' if tds_amt else '',
                    tds_status='OK' if tds_amt else '',
                    purchase_category=category,
                    status='APPROVED',
                )
                # Pick a product whose kind matches the bill's category, so an RM
                # bill shows RM items and a Packing bill shows packing items.
                pool = prods_by_cat.get(category) or prods_by_cat['RM']
                # UOM matched to the category: packing counted (PCS), RM weighed (KG).
                luom = 'PCS' if category in ('PACKING', 'PM') else 'KG'
                VendorBillLine.objects.create(
                    bill=bill, product=random.choice(pool),
                    quantity=Decimal(random.randint(10, 500)),
                    rate=Decimal(random.randint(50, 2000)),
                    amount=sub, uom=luom,
                )
                bills.append(bill)
                n += 1
        w(f'  bills: {n}')

        # ---- Payments (against ~60% of bills) ----
        pn = 0
        for bill in bills:
            r = random.random()
            if r < 0.5:
                pay_amt = bill.total_amount            # fully paid
            elif r < 0.75:
                pay_amt = (bill.total_amount * Decimal('0.5')).quantize(Decimal('1.00'))  # partial
            else:
                continue                               # unpaid
            bank = random.choice(banks)
            PaymentMade.objects.create(
                vendor=bill.vendor,
                payment_date=bill.bill_date + datetime.timedelta(days=random.randint(5, 40)),
                amount=pay_amt, payment_mode=random.choice(['BANK', 'NEFT', 'RTGS', 'UPI']),
                # No reference_no / tally_guid: these are ERP-entered payments, so
                # the Payment Entries page shows Source = ERP (not Tally). A
                # reference_no is what a bank/Tally import writes.
                bank_name=bank.nickname,
                bank_account=bank,
                bill=bill, status='CONFIRMED',
            )
            # Reflect the payment on the bill so the Amount-Paid tile (which sums
            # VendorBill.amount_paid) and Outstanding figures are correct.
            bill.amount_paid = pay_amt
            bill.save(update_fields=['amount_paid'])
            pn += 1
        w(f'  payments: {pn}')

        # ---- Vendor credits (notes + advances) ----
        cn = 0
        for v in random.sample(vendors, 3):
            VendorCredit.objects.create(
                vendor=v, credit_date=today - datetime.timedelta(days=random.randint(10, 60)),
                credit_type=random.choice(['CREDIT_NOTE', 'ADVANCE']),
                subtotal=Decimal(random.randint(5000, 50000)),
                total_amount=Decimal(random.randint(5000, 50000)),
                status='APPROVED',
            )
            cn += 1
        w(f'  vendor credits: {cn}')

        # ---- Purchase returns (debit notes) — these make Total Purchase sit
        # BELOW Amount Billed, so the dashboard's "difference" shows. ----
        dn = 0
        for i, v in enumerate(vendors[:3], start=1):
            amt = Decimal(random.randint(10000, 40000))
            PurchaseDebitNote.objects.create(
                vendor=v, company=company, side='PURCHASE', note_type='DEBIT',
                note_no=f'DN-{i:04d}',
                note_date=today - datetime.timedelta(days=random.randint(10, 90)),
                amount=amt, taxable=(amt / Decimal('1.18')).quantize(Decimal('1.00')),
            )
            dn += 1
        w(f'  purchase returns (debit notes): {dn}')

        # ---- Purchase Requests + Orders (sourcing) ----
        prn = 0
        admin_user = None
        try:
            from core.models import StakeholderUser
            admin_user = StakeholderUser.objects.first()
        except Exception:
            pass
        for k in range(4):
            try:
                PurchaseRequest.objects.create(
                    warehouse=warehouse,
                    requested_by=admin_user,
                    requestor_role='Purchase Coordinator',
                    requirement_type='MATERIAL',
                    priority=random.choice(['LOW', 'MEDIUM', 'HIGH']),
                    approval_status='DRAFT',
                )
                prn += 1
            except Exception as e:  # noqa: BLE001
                w(self.style.WARNING(f'    PR skipped: {e}'))
                break
        w(f'  purchase requests: {prn}')

        # ---- Receipts (build Stock) — one receipt per RM/Packing vendor with a
        # couple of product lines, so the Stock page shows on-hand quantities. ----
        rc = rl_n = 0
        receipts = []
        for v in vendors[:5]:
            vtype = (v.vendor_type[0] if isinstance(v.vendor_type, list) and v.vendor_type else 'RM')
            category = cat_of.get(vtype, 'RM')
            pool = prods_by_cat.get(category) or prods_by_cat['RM']
            rdate = today - datetime.timedelta(days=random.randint(5, 90))
            ra = ReceiptAdvice.objects.create(
                warehouse=warehouses.get(v.company_id, warehouse), vendor=v,
                vehicle_number=f'TN-{random.randint(10,99)}-{random.randint(1000,9999)}',
            )
            # receipt_date is auto_now_add (set to NOW on insert); override it to a
            # realistic past date via .update() so the Stock drill shows a timeline.
            ReceiptAdvice.objects.filter(pk=ra.pk).update(
                receipt_date=datetime.datetime.combine(rdate, datetime.time(9, 0)))
            ra.receipt_date = datetime.datetime.combine(rdate, datetime.time(9, 0))
            receipts.append(ra)
            rc += 1
            for ln_i, prod in enumerate(random.sample(pool, min(2, len(pool))), start=1):
                # ONE consistent UOM per product (never mix MT + KG on the same
                # item), matched to its category: packing items are counted
                # (PCS), raw materials are weighed (KG).
                puom = 'PCS' if category in ('PACKING', 'PM') else 'KG'
                ReceiptLine.objects.create(
                    receipt=ra, product=prod, line_no=ln_i,
                    quantity_received=Decimal(random.randint(50, 800)),
                    uom=puom,
                )
                rl_n += 1
        w(f'  receipts: {rc} ({rl_n} lines)')

        # ---- Local freight ----
        lf = 0
        for i in range(6):
            amt = Decimal(random.randint(3000, 25000))
            # Split across both companies so the global company filter has
            # something to show for SS Biochem AND United Agro.
            lco = companies[i % len(companies)]
            LocalFreight.objects.create(
                company=lco,
                freight_no=f'LF-DEMO-{i+1:04d}',
                date=today - datetime.timedelta(days=random.randint(5, 80)),
                lorry_no=f'TN-{random.randint(10,99)}-L-{random.randint(1000,9999)}',
                freight_amount=amt, amount_pay=amt,
            )
            lf += 1
        w(f'  local freight: {lf}')

        # ---- Inbound freight advices (separate transporter slips) + payments ----
        # These are the SEPARATE_SLIP freight bills the Freight Bills / Freight
        # Analytics / Freight Payments pages read from /api/purchase/freight/ and
        # /api/purchase/freight-payments/. Each slip is tied to one of the seeded
        # receipts (the shipment it carried) and one of the seeded transporters,
        # so the pages show real inbound freight with a mix of paid / partial /
        # unpaid status. Without this, those three pages are empty.
        transporters = list(Transporter.objects.filter(
            transporter_code__startswith='TPT-DEMO-').order_by('transporter_code'))
        fa_n = fp_n = 0
        if receipts and transporters:
            for i, ra in enumerate(receipts):
                tpt = transporters[i % len(transporters)]
                # Linehaul for inter-city (bigger), local drayage for short hops.
                ftype = 'LINEHAUL' if i % 2 == 0 else 'LOCAL_DRAYAGE'
                amt = Decimal(random.randint(8000, 60000))
                fdate = (ra.receipt_date.date()
                         if ra.receipt_date else today) + datetime.timedelta(days=1)
                adv = FreightAdviceInbound.objects.create(
                    freight_source='SEPARATE_SLIP',
                    source_type='PURCHASE_RECEIPT',
                    receipt_advice=ra,
                    transporter=tpt,
                    freight_type=ftype,
                    freight_terms='TO_PAY',
                    base_amount=amt,
                    payable_amount=amt,
                    freight_date=fdate,
                    lorry_no=f'TN-{random.randint(10, 99)}-{random.randint(1000, 9999)}',
                    driver_name=random.choice(['Murugan', 'Senthil', 'Ravi', 'Karthik']),
                    status='APPROVED',
                )
                fa_n += 1
                # Payment pattern: full / partial / none — same spread as bills so
                # the Freight Payments page and the Paid/Partial/Unpaid chips show
                # all three states.
                r = random.random()
                if r < 0.45:
                    pay_amt = amt                                   # fully paid
                elif r < 0.75:
                    pay_amt = (amt * Decimal('0.5')).quantize(Decimal('1.00'))  # partial
                else:
                    pay_amt = None                                  # unpaid
                if pay_amt:
                    FreightPaymentInbound.objects.create(
                        freight=adv,
                        payment_date=fdate + datetime.timedelta(days=random.randint(3, 30)),
                        amount_paid=pay_amt,
                        payment_mode=random.choice(['BANK', 'NEFT', 'UPI', 'CASH']),
                        paid_to=tpt.name,
                    )
                    fp_n += 1
                    # Reflect the payment on the advice status (PAID when settled).
                    adv.update_payment_status()
        w(f'  inbound freight advices: {fa_n} ({fp_n} payments)')

        w(self.style.SUCCESS('Demo data seeded.'))

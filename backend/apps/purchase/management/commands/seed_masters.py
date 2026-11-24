"""Seed the base masters the Sourcing forms need so a PR/RFQ/PO can be filled:

  - categorize each Product (goods_sub_type RAW_MATERIAL / PACKING_MATERIAL /
    FINISHED_GOOD) + give it a category-correct UOM, so the PR line
    "Category -> Product" filter actually finds products;
  - a Godown per Warehouse, so the Godown(s) picker has options;
  - Opening Stock per (product, warehouse), so "Available Stock" shows a number.

Category scheme mirrors production (master_product.product_type='GOODS' +
goods_sub_type). Idempotent — safe to run repeatedly. Usage:

    python manage.py seed_masters
"""
import datetime
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction

# product_name (lowercased, trimmed) -> (goods_sub_type, uom)
PRODUCT_MAP = {
    # raw materials — weighed in KG
    'maize': ('RAW_MATERIAL', 'KG'),
    'soya doc': ('RAW_MATERIAL', 'KG'),
    'oil cake / doc': ('RAW_MATERIAL', 'KG'),
    'oil cake / doc ': ('RAW_MATERIAL', 'KG'),
    'rice bran oil': ('RAW_MATERIAL', 'LTR'),
    # packing materials — counted in PCS
    'bag / liner': ('PACKING_MATERIAL', 'PCS'),
    'hdpe bags': ('PACKING_MATERIAL', 'PCS'),
    'printing ink': ('PACKING_MATERIAL', 'LTR'),
}
# keyword fallback so renamed/extra products still get sorted
RM_KW = ('maize', 'soya', 'doc', 'oil cake', 'bran', 'grain', 'wheat', 'cake')
PM_KW = ('bag', 'liner', 'hdpe', 'ink', 'carton', 'label', 'pouch', 'pack')


class Command(BaseCommand):
    help = 'Categorize products + seed godowns and opening stock for the Sourcing forms.'

    @transaction.atomic
    def handle(self, *args, **opts):
        from core.models import Company, Warehouse, Godown
        from master.models import Product
        from inventory.models import OpeningStock

        w = self.stdout.write
        today = datetime.date.today()

        # ── 1) categorize products ───────────────────────────────────────────
        n_cat = 0
        for p in Product.objects.all():
            name = (p.product_name or '').strip().lower()
            sub, uom = PRODUCT_MAP.get(name, (None, None))
            if not sub:
                if any(k in name for k in PM_KW):
                    sub, uom = 'PACKING_MATERIAL', 'PCS'
                elif any(k in name for k in RM_KW):
                    sub, uom = 'RAW_MATERIAL', 'KG'
                else:
                    sub, uom = 'RAW_MATERIAL', 'KG'  # safe default
            changed = False
            if p.product_type != 'GOODS':
                p.product_type = 'GOODS'; changed = True
            if p.goods_sub_type != sub:
                p.goods_sub_type = sub; changed = True
            if not (p.uom or '').strip():
                p.uom = uom; changed = True
            if changed:
                p.save(update_fields=['product_type', 'goods_sub_type', 'uom'])
                n_cat += 1
            w(f'  {p.product_name:<22} -> {p.goods_sub_type:<16} {p.uom}')
        w(self.style.SUCCESS(f'Categorized {n_cat} product(s).'))

        # ── 2) a godown per warehouse ────────────────────────────────────────
        n_god = 0
        for wh in Warehouse.objects.all():
            g, created = Godown.objects.get_or_create(
                warehouse=wh, godown_code=f'{(wh.warehouse_code or "WH")}-G1',
                defaults=dict(godown_name='Main Store', storage_condition='AMBIENT',
                              is_active=True, active_flag=True),
            )
            if created:
                n_god += 1
        w(self.style.SUCCESS(f'Ensured godown for {Warehouse.objects.count()} warehouse(s) '
                             f'({n_god} new).'))

        # ── 3) opening stock per (product, warehouse) ────────────────────────
        # Give each warehouse opening stock for every product so the PR form's
        # "Available Stock" column shows a real number. RM in thousands, PM in
        # hundreds — just enough to look live.
        n_os = 0
        for wh in Warehouse.objects.all():
            for p in Product.objects.all():
                qty = Decimal('5000') if p.goods_sub_type == 'RAW_MATERIAL' else Decimal('800')
                _, created = OpeningStock.objects.get_or_create(
                    product=p, warehouse=wh,
                    defaults=dict(as_of_date=today, quantity=qty,
                                  uom=p.uom or 'KG', is_active=True),
                )
                if created:
                    n_os += 1
        w(self.style.SUCCESS(f'Seeded {n_os} opening-stock row(s).'))

        # ── 4) backfill godown on receipt lines ──────────────────────────────
        # Seeding godowns flips on the "godown required per line" approval check
        # (purchase/views receipt approve). Existing receipt lines were created
        # before any godown existed, so stamp each line with its warehouse's
        # Main Store godown — otherwise every seeded receipt fails approval.
        from purchase.models import ReceiptLine
        godown_by_wh = {g.warehouse_id: g for g in Godown.objects.filter(is_active=True)}
        n_rl = 0
        for rl in ReceiptLine.objects.filter(
                godown_location__isnull=True, service_catalogue__isnull=True
        ).select_related('receipt'):
            wh_id = getattr(rl.receipt, 'warehouse_id', None)
            g = godown_by_wh.get(wh_id)
            if g:
                rl.godown_location = g
                rl.save(update_fields=['godown_location'])
                n_rl += 1
        w(self.style.SUCCESS(f'Backfilled godown on {n_rl} receipt line(s).'))

        # ── 5) link one bill-less receipt to a matching bill (reference) ──────
        # So a receipt with goods but no bill also shows the green "Bill Raised"
        # button + reach link. Idempotent: skips receipts that already have a
        # bill; the bill mirrors the receipt's own lines (received qty @ a demo
        # rate) so quantities line up, and shares its warehouse/vendor so Stock
        # dedup (receipt wins) still holds.
        from purchase.models import ReceiptAdvice, VendorBill, VendorBillLine
        n_bill = 0
        for ra in ReceiptAdvice.objects.all():
            if VendorBill.objects.filter(receipt_advice=ra).exists():
                continue
            lines = list(ra.receipt_lines.filter(product__isnull=False))
            if not lines:
                continue
            rate = Decimal('40')
            subtotal = sum((l.quantity_received or Decimal('0')) * rate for l in lines)
            if not subtotal:
                continue
            tax = (subtotal * Decimal('0.05')).quantize(Decimal('0.01'))
            inv = f'INV-{(ra.receipt_advice_no or str(ra.id)[:8]).replace("GRN-", "GRN").replace("-", "")}'
            bd = ra.receipt_date.date() if hasattr(ra.receipt_date, 'date') else (ra.receipt_date or today)
            b = VendorBill.objects.create(
                bill_no=inv, vendor_invoice_no=inv, vendor=ra.vendor,
                warehouse=ra.warehouse, receipt_advice=ra, bill_date=bd,
                subtotal=subtotal, tax_amount=tax, total_amount=subtotal + tax,
                status='OPEN', source='MANUAL', purchase_category='RM',
                # PO inherited from the receipt in VendorBill.save() when the
                # receipt has one — so a receipt off a PO lights the bill's "O".
            )
            for l in lines:
                q = l.quantity_received or Decimal('0')
                VendorBillLine.objects.create(
                    bill=b, product=l.product, quantity=q,
                    uom=l.uom or 'KG', rate=rate, amount=q * rate)
            n_bill += 1
        w(self.style.SUCCESS(f'Linked {n_bill} bill-less receipt(s) to a reference bill.'))

        w(self.style.SUCCESS('Masters ready — PR/RFQ/PO forms can now be filled.'))

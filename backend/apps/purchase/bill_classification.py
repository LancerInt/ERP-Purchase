"""Classify each vendor bill into a spend category — RM / Packing / Freight /
Expenses / Machinery — from Tally's own structure, never a hand-guess.

WHERE THE CATEGORY COMES FROM (in priority order)
-------------------------------------------------
1. The VENDOR's creditor group.  Tally files every supplier under a sub-group of
   Sundry Creditors — "RM", "Packing Material", "Transport", "Fruit", "Agent &
   Farmers", "Labour Wages", "R & D"… — and we already import that tree into
   CreditorBalance.parent_group. That group IS the category, and because every
   bill (scanned OR imported) has a vendor, this alone classifies the bulk. The
   vendor is resolved by FK first, then by ledger NAME, so a bill whose vendor
   the creditors import never FK-linked still finds its group.

2. The operator's `is_expense` flag (set at scan confirm) → Expenses. Used only
   when the creditor group is generic ("Other" / "MSME"), so a service/rent bill
   the operator already tagged still lands right.

3. The line items' product sub-type. Scanned bills carry products, and each
   product knows what it is (RAW_MATERIAL, PACKING_MATERIAL, CAPITAL_GOOD,
   MACHINE_SPARES, CONSUMABLES…). This is what catches vendors Tally left in the
   generic "Other" / "MSME" groups — including MACHINERY, which has no creditor
   group of its own.

4. The Tally voucher type ("Bought Note" → BOUGHT_NOTE / "Fruit" → FRUIT / "Maize" → MAIZE) for farmer /
   agri buying that carries no products and no creditor sub-group.

Anything still unresolved is left blank (Unclassified) for a one-click operator
pick. Reporting-only: a bill's amount, total or Tally comparison never changes.
A manual override (category_source='manual') is never overwritten by re-runs.
"""
import re
from decimal import Decimal

from django.db import transaction

from .branch_transfer import is_branch_transfer_bill

ZERO = Decimal('0')

# Creditor sub-group (under Sundry Creditors) → category. Keys are normalised by
# _norm_group (lower-case, "Sundry Creditors -" prefix stripped). Generic groups
# — Other / Others / MSME — are deliberately ABSENT so they fall through to the
# product / flag rules instead of being force-fitted.
CREDITOR_GROUP_TO_CATEGORY = {
    'rm': 'RM',
    'rm purchase': 'RM',
    'raw material': 'RM',
    'fruit': 'FRUIT',
    'agent & farmers': 'RM',
    'agent and farmers': 'RM',
    'farmer purchase': 'RM',
    'packing material': 'PACKING',
    'packing': 'PACKING',
    'transport': 'FREIGHT',
    'freight': 'FREIGHT',
    'freight inward': 'FREIGHT',
    'labour wages': 'EXPENSES',
    'labour': 'EXPENSES',
    'r & d': 'EXPENSES',
    'r and d': 'EXPENSES',
    'r&d': 'EXPENSES',
    'for service': 'EXPENSES',
    'service': 'EXPENSES',
    'expenses': 'EXPENSES',
}

# Product sub-type (master.Product.goods_sub_type) → category. This is what lets
# a scanned bill classify with no Tally match, and the only route to MACHINERY.
PRODUCT_SUBTYPE_TO_CATEGORY = {
    'RAW_MATERIAL': 'RM',
    'SEMI_FINISHED': 'RM',
    'PACKING_MATERIAL': 'PACKING',
    'CAPITAL_GOOD': 'MACHINERY',
    'MACHINE_SPARES': 'MACHINERY',
    'CONSUMABLES': 'EXPENSES',
    # TRADED_PRODUCTS / FINISHED_GOOD are ambiguous on the purchase side — leave
    # them to fall through rather than mislabel.
}


def _norm_group(name):
    s = (name or '').strip().lower()
    s = re.sub(r'^sundry\s*creditors\s*[-:\s]*', '', s)   # drop the root prefix
    return re.sub(r'\s+', ' ', s).strip()


def _norm_name(name):
    return re.sub(r'\s+', ' ', (name or '').strip().lower())


def category_from_creditor_group(group):
    return CREDITOR_GROUP_TO_CATEGORY.get(_norm_group(group), '')


def category_from_products(bill):
    """Dominant product sub-type on the bill's lines (weighted by line value)."""
    totals = {}
    for line in bill.bill_lines.filter(is_active=True).select_related('product'):
        p = line.product
        sub = getattr(p, 'goods_sub_type', '') if p else ''
        cat = PRODUCT_SUBTYPE_TO_CATEGORY.get(sub or '')
        if not cat:
            continue
        totals[cat] = totals.get(cat, ZERO) + abs(line.amount or ZERO)
    if not totals:
        return ''
    return max(totals.items(), key=lambda kv: kv[1])[0]


def _vendor_recent_class(vendor, limit=12):
    """The voucher type + category the vendor is USUALLY billed under — the most
    common values across their recent created bills. Learned from VendorBill so
    Scan and Email share one signal. ('', '') when the vendor has no history."""
    from collections import Counter
    from .models import VendorBill
    if vendor is None:
        return '', ''
    rows = (VendorBill.objects.filter(vendor=vendor, is_active=True)
            .order_by('-bill_date', '-created_at')
            .values_list('tally_voucher_type', 'purchase_category')[:limit])
    vt = Counter(v for v, _ in rows if (v or '').strip())
    cat = Counter(c for _, c in rows if (c or '').strip())
    return (vt.most_common(1)[0][0] if vt else '',
            cat.most_common(1)[0][0] if cat else '')


def category_from_product_ids(product_ids):
    """Dominant purchase category from a set of product ids, via their sub-type —
    the Option-2 fallback for a vendor with no billing history yet."""
    from collections import Counter
    from master.models import Product
    ids = [p for p in (product_ids or []) if p]
    if not ids:
        return ''
    cats = Counter(
        PRODUCT_SUBTYPE_TO_CATEGORY.get(s or '')
        for s in Product.objects.filter(id__in=ids).values_list('goods_sub_type', flat=True)
        if PRODUCT_SUBTYPE_TO_CATEGORY.get(s or '')
    )
    return cats.most_common(1)[0][0] if cats else ''


def suggest_bill_class(company, vendor, product_ids=None):
    """Auto-suggest (purchase type, category) for a bill under review:
    - purchase type (Tally voucher type): the vendor's most-common recent value.
    - category: the vendor's most-common recent value (Option 1), else derived
      from the products on the bill (Option 2), else '' (never guessed).
    Both are only suggestions — the reviewer can change either. `company` is
    accepted for call-site symmetry; the vendor already scopes the history.

    A bill carrying real GOODS products is a PURCHASE: its product signal OUT-ranks
    a vendor's historical EXPENSES skew, so a vendor whose recent bills (or a bulk
    expense-tag) lean expense can't drag its genuine goods bills into the Expense
    folder. Every other case keeps the vendor's usual category (its best hint)."""
    vt, cat = _vendor_recent_class(vendor)
    prod_cat = category_from_product_ids(product_ids)
    if cat in ('EXPENSES', 'LAB_EXPENSE') and prod_cat and prod_cat not in ('EXPENSES', 'LAB_EXPENSE'):
        cat = prod_cat          # real goods on the bill → it's a purchase, not an expense
    elif not cat:
        cat = prod_cat          # no vendor history → derive from the products
    return vt, cat


class CreditorGroups:
    """Resolves a vendor → its Tally creditor sub-group: by FK first, then by
    ledger NAME (so a bill whose vendor the creditors import never FK-linked still
    finds its group). Built once per company by build_group_by_vendor."""

    def __init__(self, by_vendor, by_name):
        self.by_vendor = by_vendor      # {vendor_id: group}
        self.by_name = by_name          # {normalised name: group}

    def group_for(self, vendor):
        if vendor is None:
            return ''
        g = self.by_vendor.get(vendor.id)
        if g:
            return g
        return self.by_name.get(_norm_name(getattr(vendor, 'vendor_name', '')), '')


def build_group_by_vendor(company):
    """CreditorGroups for one company, from CreditorBalance — indexed by vendor FK
    AND by ledger name. When duplicate masters put a name/vendor under two groups,
    the larger closing balance wins."""
    from .models import CreditorBalance
    best_v, best_n = {}, {}
    for cb in (CreditorBalance.objects.filter(company=company)
               .values('vendor_id', 'ledger_name', 'parent_group', 'closing')):
        grp = (cb['parent_group'] or '').strip()
        if not grp:
            continue
        score = abs(cb['closing'] or ZERO)
        vid = cb['vendor_id']
        if vid and (vid not in best_v or score > best_v[vid][0]):
            best_v[vid] = (score, grp)
        nm = _norm_name(cb['ledger_name'])
        if nm and (nm not in best_n or score > best_n[nm][0]):
            best_n[nm] = (score, grp)
    return CreditorGroups(
        {vid: g for vid, (s, g) in best_v.items()},
        {nm: g for nm, (s, g) in best_n.items()},
    )


def classify_bill(bill, groups):
    """→ (category, source). See module docstring for the priority order."""
    # 0) Branch / sister-entity transfer (SS Biochem-Blre etc.) — buying from our
    #    OWN branch, not a third-party purchase. Decide FIRST so it never lands in
    #    RM / Packing / Unclassified. Uses the shared rule: the vendor's is_branch
    #    flag — now auto-set for a SAME-GSTIN self-vendor (the company itself), see
    #    master.Vendor.save — OR a DC/-prefixed delivery-challan invoice. This is
    #    what keeps an internal stock / warehouse move out of purchase figures.
    if bill.vendor_id and is_branch_transfer_bill(bill):
        return 'BRANCH', 'branch'
    vt = (bill.tally_voucher_type or '').lower()
    inv = (bill.vendor_invoice_no or '').strip().upper()
    # 0) unambiguous Tally signals — decided BEFORE the vendor's creditor group,
    #    because the same vendor can span buckets. A "Purchase Bought Note" voucher
    #    (BNP-… number, farmer / cash / GST-exempt) and a Maize voucher classify to
    #    their own category. (Real Maize is usually a plain "GST Purchase" crediting
    #    the "Purchase Maize" ledger — that's caught by tally_align's goods-ledger
    #    rule; this only catches a maize-named voucher.)
    if 'bought note' in vt or inv.startswith('BNP'):
        return 'BOUGHT_NOTE', 'voucher_type'
    if 'maize' in vt:
        return 'MAIZE', 'voucher_type'
    # 1) the vendor's creditor group (covers scanned + imported alike)
    cat = category_from_creditor_group(groups.group_for(bill.vendor if bill.vendor_id else None))
    if cat:
        return cat, 'creditor_group'
    # 2) operator's expense flag (set at scan confirm)
    if bill.is_expense:
        return 'EXPENSES', 'expense_flag'
    # 3) the line items' product sub-type (the scanned-bill / MACHINERY route)
    cat = category_from_products(bill)
    if cat:
        return cat, 'product'
    # 4) Tally voucher-type hint for farmer / agri buying
    if 'fruit' in vt:
        return 'FRUIT', 'voucher_type'
    # 4.5) inherit the vendor's OWN established category — once any of a vendor's
    # bills has a category (a Tally group, a product, or a manual name-tag), new
    # bills from that vendor take the most common one. This is what lets imports
    # self-heal: after a vendor is tagged once (tag_vendor_category), every later
    # bill from it classifies itself, so the monthly re-run is no longer needed.
    if bill.vendor_id:
        from django.db.models import Count
        from .models import VendorBill
        prior = (VendorBill.objects
                 .filter(vendor_id=bill.vendor_id, is_active=True)
                 .exclude(purchase_category='')
                 .exclude(pk=bill.pk)
                 .values('purchase_category')
                 .annotate(n=Count('id')).order_by('-n', 'purchase_category').first())
        if prior:
            return prior['purchase_category'], 'vendor_history'
    # 5) unresolved — leave for a one-click operator pick
    return '', ''


def expense_subcat_from_vendor_history(bill):
    """(expense_group, expense_subcategory) for an expense bill, inherited from the
    vendor's MOST COMMON already-classified expense sub-category. The same self-heal
    idea as the purchase-category vendor_history rule, but for the Direct/Indirect
    head (Rent / Salary / Electricity ...): a vendor whose past bills tied to Tally
    as "Electricity" lends that to its new live-month scan/email bills, so they land
    in the right box before Tally is posted. ('', '') when the vendor has no history."""
    if not bill.vendor_id:
        return '', ''
    from django.db.models import Count, Sum
    from .models import VendorBill
    prior = (VendorBill.objects
             .filter(vendor_id=bill.vendor_id, is_active=True)
             .exclude(expense_subcategory='')
             .exclude(status='CANCELLED')
             .exclude(pk=bill.pk)
             .values('expense_group', 'expense_subcategory')
             .annotate(n=Count('id'), v=Sum('subtotal'))
             .order_by('-n', '-v').first())
    if prior:
        return prior['expense_group'] or '', prior['expense_subcategory']
    return '', ''


def classify_and_save_bill(bill, groups=None):
    """Classify one bill and persist if changed. Honours a manual override.
    Safe to call from the scan-confirm / import hooks (one bill at a time)."""
    if bill.category_source == 'manual':
        return bill.purchase_category
    if groups is None:
        company = bill.vendor.company if bill.vendor_id else None
        groups = build_group_by_vendor(company) if company else CreditorGroups({}, {})
    cat, src = classify_bill(bill, groups)
    fields = []
    if bill.purchase_category != cat or bill.category_source != src:
        bill.purchase_category = cat
        bill.category_source = src
        fields += ['purchase_category', 'category_source']
    # Expense SUB-category (Direct/Indirect head): inherit the vendor's established
    # one so a live-month scan/email expense bill lands in the right box BEFORE
    # Tally is posted. Only fills a blank; a manual pick or the month-end Tally
    # match still overrides it.
    if cat == 'EXPENSES' and not (bill.expense_subcategory or '').strip():
        g, s = expense_subcat_from_vendor_history(bill)
        if s:
            bill.expense_subcategory = s
            if g:
                bill.expense_group = g
            fields += ['expense_subcategory', 'expense_group']
    if fields:
        bill.save(update_fields=fields + ['updated_at'])
    return cat


def classify_company_bills(company, dry_run=True):
    """Backfill every (non-manually-set) bill for one company. Returns a summary:
    counts AND rupee value by category, plus which rule decided each."""
    from .models import VendorBill
    groups = build_group_by_vendor(company)
    # ALL active bills are counted for the report (so the totals are the true
    # picture), but a MANUAL bill keeps its category — it is never re-classified
    # or written. Only auto bills are (re)computed and updated.
    bills = (VendorBill.objects.filter(is_active=True, vendor__company=company)
             .select_related('vendor')
             .prefetch_related('bill_lines__product'))
    by_cat, by_cat_val, by_src, to_update, total = {}, {}, {}, [], 0
    unc = {}   # unclassified, grouped by vendor: {vendor_id: {name, group, value, count}}
    for b in bills:
        total += 1
        if b.category_source == 'manual':
            cat, src = b.purchase_category, 'manual'
        else:
            cat, src = classify_bill(b, groups)
            if b.purchase_category != cat or b.category_source != src:
                b.purchase_category = cat
                b.category_source = src
                to_update.append(b)
        key = cat or 'UNCLASSIFIED'
        by_cat[key] = by_cat.get(key, 0) + 1
        by_cat_val[key] = by_cat_val.get(key, ZERO) + abs(b.total_amount or ZERO)
        by_src[src or 'none'] = by_src.get(src or 'none', 0) + 1
        if not cat:
            v = b.vendor if b.vendor_id else None
            e = unc.setdefault(b.vendor_id, {
                'name': getattr(v, 'vendor_name', '') or '(no vendor)',
                'group': groups.group_for(v) or '',   # its creditor group, if any
                'value': ZERO, 'count': 0})
            e['value'] += abs(b.total_amount or ZERO)
            e['count'] += 1
    if not dry_run and to_update:
        with transaction.atomic():
            VendorBill.objects.bulk_update(
                to_update, ['purchase_category', 'category_source'], batch_size=500)
    return {
        'total': total,
        'changed': len(to_update),
        'by_category': dict(sorted(by_cat.items(), key=lambda kv: -kv[1])),
        'by_category_value': {k: v for k, v in sorted(
            by_cat_val.items(), key=lambda kv: -kv[1])},
        'by_source': dict(sorted(by_src.items(), key=lambda kv: -kv[1])),
        'unclassified_vendors': sorted(
            unc.values(), key=lambda e: -e['value'])[:20],
        'dry_run': dry_run,
    }

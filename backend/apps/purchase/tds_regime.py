"""TDS regime classification — Purchase / Expense / Freight.

The TDS the company deducts falls under three *regimes* that reconcile against
Tally very differently, even though two of them share a 194 section:

  * PURCHASE — goods (RM / Packing), section 194Q. Tally deducts at PAYMENT in
    lumps over the ₹50L/yr threshold, so per-bill it never ties — only the
    vendor TOTAL does.
  * EXPENSE  — services / contracts / machinery, section 194C. Deducted per bill
    once a single bill ≥ ₹30k (or the vendor FY aggregate ≥ ₹1L).
  * FREIGHT  — transporters, section 194C. Per bill, NIL with a transporter
    declaration on file.

Mixing them into one figure is what made the TDS Payable total meaningless (a
194Q goods bill "owing" TDS is normal — it's paid later — but next to expense /
freight it reads as a huge mismatch). This is the ONE place that decides which
regime a bill (and thus a linked TDS record) belongs to, so every page agrees.

Mirrors the PaymentMade.get_bill_category rule (serializers.py) so a bill lands
in the same bucket on the Payment Entries page and here.
"""

PURCHASE = 'PURCHASE'
EXPENSE = 'EXPENSE'
FREIGHT = 'FREIGHT'
UNCLASSIFIED = 'UNCLASSIFIED'

REGIMES = (PURCHASE, EXPENSE, FREIGHT)

# Spend categories that are expense bookings (194C), not goods purchases (194Q).
_EXPENSE_CATS = ('EXPENSES', 'MACHINERY', 'LAB_EXPENSE')


def regime_for_bill(bill):
    """PURCHASE / EXPENSE / FREIGHT for a VendorBill (or None → UNCLASSIFIED).

    FREIGHT wins first (its own category), then expense (is_expense flag OR an
    expense spend-category), else it's a goods purchase. Same order as
    PaymentMade.get_bill_category so the two never disagree.
    """
    if bill is None:
        return UNCLASSIFIED
    cat = (getattr(bill, 'purchase_category', '') or '').upper()
    if cat == 'FREIGHT':
        return FREIGHT
    if getattr(bill, 'is_expense', False) or cat in _EXPENSE_CATS:
        return EXPENSE
    return PURCHASE


# Ledger-name fallback for TDS records with no linked bill. Tally books 194C
# freight/contract TDS under sub-ledgers whose name carries the clue — a bare
# "…- Labour Contract" / "Freight" ledger tells us the regime even when the
# per-bill link is missing. Goods 194Q is the default (most TDS Payable volume).
_FREIGHT_HINTS = ('freight', 'transport', 'lorry', 'carriage', 'cartage')
_EXPENSE_HINTS = ('labour', 'contract', 'professional', 'rent', 'commission',
                  'legal', 'audit', 'security', 'service')


def regime_for_tds(record):
    """Regime of a TdsPayable record: its linked bill's regime, else a guess from
    the section + ledger name. 194Q is always PURCHASE (goods). 194C splits into
    FREIGHT / EXPENSE by the ledger-name hint, defaulting to EXPENSE (the broader
    194C bucket) when no hint matches."""
    bill = getattr(record, 'vendor_bill', None)
    if bill is not None:
        return regime_for_bill(bill)
    section = (getattr(record, 'section', '') or '').upper()
    if section == '194Q':
        return PURCHASE
    name = (getattr(record, 'ledger_name', '') or '').lower()
    if any(h in name for h in _FREIGHT_HINTS):
        return FREIGHT
    if any(h in name for h in _EXPENSE_HINTS):
        return EXPENSE
    # 194C with no hint → EXPENSE; a truly unknown section → UNCLASSIFIED.
    return EXPENSE if section.startswith('194C') else UNCLASSIFIED


def regime_of_values(section, ledger_name, bill_category, bill_is_expense, bill_id):
    """Same decision as regime_for_tds, but from raw column values instead of a
    model instance — so a `.values_list(...)` aggregation pass can classify
    thousands of TDS records without building objects (no N+1, no ORM overhead).

    When the TDS record is linked to a bill (bill_id set), the bill's category
    decides (mirrors regime_for_bill). Otherwise fall back to section + ledger
    name, exactly like regime_for_tds.
    """
    if bill_id:
        cat = (bill_category or '').upper()
        if cat == 'FREIGHT':
            return FREIGHT
        if bill_is_expense or cat in _EXPENSE_CATS:
            return EXPENSE
        return PURCHASE
    section = (section or '').upper()
    if section == '194Q':
        return PURCHASE
    name = (ledger_name or '').lower()
    if any(h in name for h in _FREIGHT_HINTS):
        return FREIGHT
    if any(h in name for h in _EXPENSE_HINTS):
        return EXPENSE
    return EXPENSE if section.startswith('194C') else UNCLASSIFIED

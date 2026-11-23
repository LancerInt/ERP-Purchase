"""Map a Tally bank / cash ledger to the payment-account bucket SS Biochem uses.

SSB pays from several ICICI accounts, each dedicated to a purpose, plus Cash. On
a Tally Payment voucher the account is the CREDIT (money-out) leg. This turns that
ledger name into ONE bucket so "Amount Paid" can be split by account, the way the
company reads it:

    ICICI Bank-CA-...-Creditor      -> creditor    (RM Purchase + Purchase)
    ICICI Bank-CA-...-Maize         -> maize        (separate from RM Purchase)
    ICICI Bank-CA-...-Freight       -> freight
    ICICI Bank-CA-...-Exp DLOD Ac   -> expenses     (DLOD = Dropline Overdraft)
    Cash                            -> cash
    any other ICICI Bank-...        -> other_bank

Reporting-only. The raw ledger name is stored on PaymentMade.bank_name; the bucket
is derived here at read time so the mapping lives in one place.
"""

# Order = display order. (key, label)
BUCKETS = [
    ("creditor",   "Creditor (RM Purchase + Purchase)"),
    ("maize",      "Maize"),
    ("freight",    "Freight"),
    ("expenses",   "Expenses (DLOD)"),
    ("cash",       "Cash"),
    ("other_bank", "CC A/c (Overdraft)"),
    ("untagged",   "Untagged"),
]
BUCKET_LABEL = dict(BUCKETS)
BUCKET_ORDER = [k for k, _ in BUCKETS]


def paid_bucket(ledger_name):
    """Bucket key for a bank / cash ledger name, or '' if it isn't one.

    Only ICICI bank accounts and Cash count — so a *vendor* whose name happens to
    contain 'freight'/'creditor' (e.g. "Sri Freight Carriers") is NEVER mistaken
    for a bank. The Creditor/Maize/Freight/DLOD suffix classifies the ICICI
    account; anything else ICICI is 'other_bank'."""
    n = (ledger_name or "").strip().lower()
    if not n:
        return ""
    if n == "cash":
        return "cash"
    if not n.startswith("icici"):
        return ""
    if "creditor" in n:
        return "creditor"
    if "maize" in n:
        return "maize"
    if "freight" in n:
        return "freight"
    # DLOD is SSB's expense-account suffix; UAI names the same account
    # "...Expenses". Both are the dedicated expenses bank account, so map either
    # to the expenses bucket (otherwise UAI's 'ICICI CA ...Expenses' fell through
    # to other_bank / CC A/c).
    if "dlod" in n or "expense" in n:
        return "expenses"
    return "other_bank"


# ─────────────────────────────────────────────────────────────────────────────
# Amount-Paid "by category" split (the PERMANENT by-account replacement).
#
# The old "by account" split grouped payments by the funding bank account
# (PaymentMade.bank_name). That field is only filled when a payment is imported
# from a Day Book that carries the money-out (bank) leg; payments that arrive
# through the live Purchase-Vouchers connector have NO bank leg, so bank_name is
# blank and every one of them fell into an "Untagged" bucket.
#
# What IS reliably known for every purchase payment is the CATEGORY of spend —
# RM / Maize / Bought Note / Packing / Fruit — because it comes from the bill the
# payment is linked to (or, for on-account money, the vendor's usual category).
# So we split by category instead. There is no "untagged" category bucket: a
# payment with no resolvable category lands in a labelled "Other purchases"
# bucket, never an empty one.
#
# Display order + labels. Keep in sync with
# VendorBill.PURCHASE_CATEGORY_CHOICES (purchase-only categories; freight /
# expense / machinery / branch are excluded from Amount Paid upstream).
CATEGORY_BUCKETS = [
    ("RM",          "RM Purchase"),
    ("MAIZE",       "Maize Purchase"),
    ("BOUGHT_NOTE", "Bought Note"),
    ("PACKING",     "Packing Material"),
    ("FRUIT",       "Fruit Purchase"),
    ("other",       "Other purchases"),
]
CATEGORY_BUCKET_LABEL = dict(CATEGORY_BUCKETS)
CATEGORY_BUCKET_ORDER = [k for k, _ in CATEGORY_BUCKETS]


# Synonyms from the vendor_type vocabulary (RAW_MATERIAL / PACKING_MATERIAL /
# MATERIAL / PURCHASE) → the short bill-category bucket. Without these, an
# on-account payment classified by vendor_type fell into 'other'.
_CATEGORY_SYNONYM = {
    "RAW_MATERIAL": "RM", "MATERIAL": "RM", "PURCHASE": "RM",
    "PACKING_MATERIAL": "PACKING",
}


def category_bucket(purchase_category):
    """Bucket key for a bill/vendor purchase_category.

    Accepts BOTH vocabularies — the short bill codes (RM/MAIZE/...) and the
    vendor_type codes (RAW_MATERIAL/PACKING_MATERIAL/MATERIAL). Any value we
    don't have a dedicated purchase bucket for (blank, or a freight/expense tag)
    maps to 'other' — a LABELLED bucket, so nothing is ever shown as
    "Untagged"."""
    c = (purchase_category or "").strip().upper()
    c = _CATEGORY_SYNONYM.get(c, c)
    if c in CATEGORY_BUCKET_LABEL and c != "other":
        return c
    return "other"


def bank_leg_name(legs):
    """Pick the funding account from a payment voucher's legs.

    `legs` = iterable of (ledger_name, amount). Returns the raw name of the
    bank/cash leg that maps to a bucket (largest by value if several — the main
    account, so a small TDS/round-off leg never wins), or '' if none.
    """
    best, best_amt = "", None
    for name, amt in legs:
        if paid_bucket(name):
            try:
                a = abs(amt)
            except TypeError:
                a = 0
            if best_amt is None or a > best_amt:
                best, best_amt = (name or "").strip(), a
    return best

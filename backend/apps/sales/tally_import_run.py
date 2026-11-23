"""Turn parsed Tally vouchers (from tally_import.parse_vouchers) into ERP records.

Creates, per voucher category:
  sales    -> SalesInvoiceCheck (+ SalesInvoiceLine) + ReceivableLedger
  purchase -> VendorBill (+ VendorBillLine)
  receipt  -> ReceivablePayment applied FIFO to the customer's open receivables
  payment  -> PaymentMade applied FIFO to the vendor's open bills

Everything is idempotent via `tally_guid` (the Tally voucher GUID, or a
vtype|number|date fallback), so re-running never duplicates. `dry_run=True`
matches + counts but writes nothing — that powers the preview.

Amounts are taken straight from the voucher's ledger entries so totals match
Tally exactly (party-ledger absolute = grand total; tax ledgers = GST; the rest
= taxable). Products come from the inventory entries; a stock item with no
matching Product is auto-created as a GOODS/FINISHED_GOOD.
"""
import re
from decimal import Decimal
from datetime import datetime

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from .tally_import import classify

UOM_MAP = {
    "nos": "PCS", "no": "PCS", "pcs": "PCS", "pc": "PCS", "unit": "PCS",
    "kg": "KG", "kgs": "KG", "gm": "KG", "g": "KG",
    "ltr": "LTR", "ltrs": "LTR", "lt": "LTR", "l": "LTR",
    "mtr": "MTR", "mt": "MTS", "mts": "MTS", "ton": "MTS", "tons": "MTS",
    "box": "BOX", "pack": "PACK", "bag": "PACK", "bags": "PACK",
}
TAX_KEYS = ("CGST", "SGST", "IGST", "GST TAX", "GST @", "TDS", "TCS", "CESS")

# Same list, but matched on WORD BOUNDARIES. Plain substring matching made
# "CESS" fire on any ledger containing it, and one of United Agro's customers is
# "The Kerala Cardamom PROCESSING and Marketing Co Ltd" — every receipt leg on
# that party was silently discarded as a tax ledger, Rs 19,65,600 in May alone.
# The party master, the Tally party map and the resolver were all correct and
# none of it mattered, because the leg never got that far.
#
# "GST TAX" / "GST @" keep their spaces and the @, so they are matched as plain
# substrings; the rest are whole words.
_TAX_WORD_RE = re.compile(r"\b(CGST|SGST|IGST|TDS|TCS|CESS)\b", re.I)
_TAX_SUBSTRINGS = ("GST TAX", "GST @")


def _is_tax_ledger(name):
    """True for a GST / TDS / TCS / cess ledger — never for a party who merely
    has one of those letter-sequences inside a longer word."""
    up = (name or "").upper()
    return bool(_TAX_WORD_RE.search(up)) or any(k in up for k in _TAX_SUBSTRINGS)


_FREIGHT_EXPENSE_RE = re.compile(r'freight\s*(?:\w+\s*)*(inward|outward)', re.I)


def _is_freight_outward_ledger(name):
    """True when this ledger is a Freight expense ledger (inward or outward)."""
    return bool(_FREIGHT_EXPENSE_RE.search(name or ""))


def _is_freight_ledger_by_group(name, ctx):
    """True when the ledger's Tally group is 'Freight Inward Charges' (or similar).
    Catches ledgers whose NAME doesn't contain 'Freight Inward' but whose group does."""
    if not ctx or not getattr(ctx, 'ledger_master', None):
        return False
    led = (ctx.ledger_master or {}).get((name or "").strip()) or {}
    grp = (led.get("parent") or "").strip().lower()
    primary = (led.get("primary_group") or "").strip().lower()
    return bool(_FREIGHT_EXPENSE_RE.search(grp) or _FREIGHT_EXPENSE_RE.search(primary))


def _is_expense_group_ledger(lg_name, ctx):
    """True when this ledger sits under Direct Expenses or Indirect Expenses
    in Tally's group tree. Returns 'DIRECT', 'INDIRECT', or ''."""
    grp = _ledger_group(ctx, lg_name).lower()
    if "direct expenses" in grp and "indirect" not in grp:
        return "DIRECT"
    if "indirect expenses" in grp:
        return "INDIRECT"
    return ""


_EXPENSE_LEDGER_EXCLUDE = ("income tax", "export refund")


def _is_bank_or_cash_ledger(lg_name, ctx):
    """True when a ledger is a Bank or Cash account (not a Sundry Creditor)."""
    grp = _ledger_group(ctx, lg_name).lower()
    return ("bank" in grp and "charge" not in grp) or "cash" in grp


# Non-sales charge ledgers that Tally bundles onto a sales voucher but books
# OUTSIDE the "Sales Accounts" group (freight, testing, round-off). They are
# part of what the customer pays (so they stay in grand_total) but must NOT
# count as sales revenue — otherwise the ERP sales figure overshoots Tally's
# Sales Accounts. NB: asset disposals ("Sale of Plant and Machinery") are a
# separate line item, not a bundled ledger, so they are not listed here.
# Round Off is NOT listed here any more. It now has its own signed bucket in
# _split_ledgers, so it never lands in `subtotal` and doesn't need `other_charges`
# to cancel it back out. Charges = the real non-sales income ledgers only, which
# is what the Ex-GST / GSTR-1 toggle acts on.
CHARGE_KEYS = ("FREIGHT", "TESTING")

# Tally groups a customer can never be in. Cash landing in one of these is
# borrowing, a bank transfer, capital introduced, a refund from a supplier or an
# expense — not a customer paying a bill.
#
# DEFAULTS ONLY. Every one of these is overridable per company on
# core.Company (tally_debtor_group / tally_creditor_group / tally_sales_group /
# tally_non_trading_groups), because a Tally group name belongs to the books,
# not to this source file. A company that calls its debtors "Trade Receivables"
# should be a setting, not a code change — and this blacklist in particular
# "had to be widened three times" (loans, then creditors and expenses, then
# suspense accounts) and would have needed widening again for the next group
# nobody thought of.
DEFAULT_DEBTOR_GROUP = "sundry debtor"
DEFAULT_CREDITOR_GROUP = "sundry creditor"
DEFAULT_SALES_GROUP = "sales account"
DEFAULT_NON_TRADING = ("loans", "loan", "bank", "capital", "reserves", "surplus",
                       "creditors", "creditor", "farmers", "formers",
                       "expenses", "expense", "incomes", "income",
                       "duties", "taxes", "suspense")


def _co_groups(company):
    """The four Tally group names this company uses, lower-cased.

    Falls back to the defaults above for anything left blank, so an existing
    company behaves exactly as before until someone sets a value.
    """
    def _v(attr, default):
        return ((getattr(company, attr, "") or "").strip().lower() or default)
    raw = (getattr(company, "tally_non_trading_groups", "") or "").strip()
    words = tuple(w.strip().lower() for w in raw.split(",") if w.strip()) or DEFAULT_NON_TRADING
    return {
        "debtor": _v("tally_debtor_group", DEFAULT_DEBTOR_GROUP),
        "creditor": _v("tally_creditor_group", DEFAULT_CREDITOR_GROUP),
        "sales": _v("tally_sales_group", DEFAULT_SALES_GROUP),
        "non_trading": words,
    }


def _non_trading_hit(parent, words):
    """True when a group name contains one of the non-trading words, whole-word."""
    low = (parent or "").lower()
    return any(re.search(r"\b%s\b" % re.escape(w), low) for w in words)


_NON_TRADING_GROUP_RE = re.compile(
    r"\b(loans?|bank|capital|reserves?|surplus"
    r"|creditors?|farmers?|formers?"
    r"|expenses?|incomes?|duties|taxes)\b", re.I)


def _charge_amount(v, ctx=None):
    """Sum of the non-sales income ledgers on a voucher — freight, testing,
    packing, insurance, anything billed on that is not turnover.

    Decided by TALLY'S OWN GROUP, not by words in the ledger name. It used to be
    `any(k in name.upper() for k in ("FREIGHT", "TESTING"))`, so a company that
    named a ledger "Transport Outward", "Loading", "Packing" or "Insurance" had
    it silently counted as SALES — moving turnover and the GSTR-1 split with no
    warning. The importer already fetches every ledger's primary group; a ledger
    that is not in the sales group is not sales, whatever it is called.

    Falls back to the keyword list only when the group is unknown (gateway did
    not answer, or an older Tally build that doesn't expose the field), so
    nothing regresses where the master is unavailable.

    Tax ledgers and Round Off are excluded here because `_split_ledgers` already
    gives each its own signed bucket — counting them again would double them.
    """
    pname = (v.get("party") or "").strip()
    g = _co_groups(getattr(ctx, "company", None)) if ctx is not None else None
    master = (getattr(ctx, "ledger_master", None) or {}) if ctx is not None else {}
    total = Decimal("0")
    for lg in v["ledgers"]:
        nm = lg["ledger"]
        if lg.get("is_party") or (pname and nm.strip() == pname):
            continue
        up = nm.upper()
        if _is_tax_ledger(nm) or "ROUND OFF" in up or "ROUNDOFF" in up:
            continue
        led = master.get(nm.strip()) or {}
        grp = (led.get("primary_group") or led.get("parent") or "").strip().lower()
        if g and grp:
            if g["sales"] not in grp:
                total += abs(lg["amount"])
            continue
        if any(k in up for k in CHARGE_KEYS):
            total += abs(lg["amount"])
    return total


def _freight_amount(v, ctx=None):
    """Sum of Freight ledgers on a voucher. Used on the PURCHASE side, where the
    user keeps Plant & Machinery / R&D / Insurance / Commission AS purchases and
    only 'Freight Inward Charges' is booked outside Purchase Accounts."""
    pname = (v.get("party") or "").strip()
    total = Decimal("0")
    for lg in v["ledgers"]:
        nm = lg["ledger"]
        if lg.get("is_party") or (pname and nm.strip() == pname):
            continue
        if "FREIGHT" in nm.upper() or _is_freight_ledger_by_group(nm, ctx):
            total += abs(lg["amount"])
    return total


def _map_uom(u):
    return UOM_MAP.get((u or "").strip().lower(), "PCS")


def _pdate(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _split_ledgers(v, with_round=False):
    """Return (party_amt, taxable, cgst, sgst, igst, tds) — or, with
    `with_round=True`, (..., tds, round_off). Signs: Tally stores debit negative
    / credit positive; we take absolutes for the tax/taxable buckets and keep
    the party amount signed so its magnitude = the invoice/bill NET total.
    **TDS/TCS is split out separately** — it's a deduction withheld by the buyer
    (or on us), NOT a GST component, so it must not inflate CGST or the taxable
    value.

    **Round Off is split out too, and kept SIGNED.** It used to fall through to
    `taxable += abs(amt)`, which ADDS a round-DOWN instead of subtracting it: SS
    invoice S-17/26-27 is goods 87,500 + GST 4,375 + Round Off −1.00 = 91,874,
    and the absolute turned that into taxable 87,501. The grand total still came
    out right because `round_off` was then plugged with the residual, but the
    invoice's own subtotal and round-off were both wrong — and `other_charges`
    had to carry |ROUND OFF| purely to cancel the error back out again.

    net receivable = taxable + gst - tds + round_off = abs(party)."""
    party = Decimal("0")
    taxable = cgst = sgst = igst = tds = round_off = Decimal("0")
    pname = (v.get("party") or "").strip()
    for lg in v["ledgers"]:
        nm = lg["ledger"]
        amt = lg["amount"]
        up = nm.upper()
        if lg.get("is_party") or (pname and nm.strip() == pname):
            party += amt
        elif "TDS" in up or "TCS" in up:
            tds += abs(amt)                     # withheld tax — reduces the balance
        elif "ROUND OFF" in up or "ROUNDOFF" in up:
            round_off += amt                    # SIGNED — never abs()
        elif _is_tax_ledger(nm):
            a = abs(amt)
            if "IGST" in up:
                igst += a
            elif "CGST" in up:
                cgst += a
            elif "SGST" in up:
                sgst += a
            else:
                cgst += a  # unlabelled GST -> lump into cgst bucket
        else:
            taxable += abs(amt)
    if with_round:
        return party, taxable, cgst, sgst, igst, tds, round_off
    return party, taxable, cgst, sgst, igst, tds


# ---------------------------------------------------------------- enrichment
_STATE_BY_CODE = {
    "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
    "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan",
    "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
    "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
    "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
    "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
    "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "29": "Karnataka",
    "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu",
    "34": "Puducherry", "35": "Andaman & Nicobar", "36": "Telangana",
    "37": "Andhra Pradesh", "38": "Ladakh",
}


_CODE_BY_STATE = {name.lower(): code for code, name in _STATE_BY_CODE.items()}
# Common Tally spellings that differ from our canonical names.
_CODE_BY_STATE.update({
    "jammu and kashmir": "01", "dadra & nagar haveli": "26",
    "daman & diu": "26", "andaman & nicobar islands": "35",
    "pondicherry": "34", "orissa": "21", "chattisgarh": "22",
})


def _state_of(gstin):
    """(state name, 2-digit state code) from a GSTIN, else ('', '')."""
    g = (gstin or "").strip()
    if len(g) >= 2 and g[:2].isdigit():
        return _STATE_BY_CODE.get(g[:2], ""), g[:2]
    return "", ""


def _state_from_name(name):
    """(canonical state name, 2-digit code) from a Tally state name, else ('','')."""
    n = (name or "").strip().lower()
    code = _CODE_BY_STATE.get(n)
    return (_STATE_BY_CODE.get(code, name.strip()), code) if code else (name.strip(), "")


def _party_details(ctx, tally_name, party):
    """Best GSTIN / state / state-code / address for a party, preferring the ERP
    master and falling back to the Tally ledger master pulled at import time.
    Returns (gstin, state, state_code, address)."""
    gstin = (getattr(party, "gstin", "") or "").strip()
    addr = _addr_text(getattr(party, "billing_address", ""))
    state, code = _state_of(gstin)
    led = (ctx.ledger_master or {}).get((tally_name or "").strip())
    if led:
        if not gstin and led.get("gstin"):
            gstin = led["gstin"].strip()
            state, code = _state_of(gstin)
        if not addr and led.get("address"):
            addr = led["address"].strip()
        if not code and led.get("state"):
            state, code = _state_from_name(led["state"])
    if not state and code:
        state = _STATE_BY_CODE.get(code, "")
    return gstin, state, code, addr


def _effective_gst_rate(taxable, total_tax):
    """Blended GST % for the voucher (total tax / taxable), rounded to the
    nearest whole percent — GST slabs are integers (5/12/18/28)."""
    taxable = Decimal(str(taxable or 0))
    if taxable <= 0:
        return Decimal("0")
    return Decimal(round(Decimal(str(total_tax or 0)) / taxable * 100))


def _line_gst(ctx, item_name, amount, inter, eff_rate):
    """(hsn, gst_rate, cgst_rate, sgst_rate, igst_rate, cgst_amt, sgst_amt, igst_amt)
    for one line. HSN comes from the Tally stock master; the TOTAL GST rate comes
    from the voucher's own tax (tax/taxable) — Tally's stock-item GSTRATE field is
    the per-component rate (2.5), not the total (5), so it isn't trustworthy here.
    Splits CGST/SGST vs IGST by the voucher's inter/intra-state flag."""
    sm = (ctx.stock_master or {}).get((item_name or "").strip()) or {}
    hsn = (sm.get("hsn") or "")[:20]
    rate = eff_rate
    amount = Decimal(str(amount or 0))
    if inter:
        ia = amount * rate / 100
        return hsn, rate, Decimal("0"), Decimal("0"), rate, Decimal("0"), Decimal("0"), ia
    half = rate / 2
    ca = amount * half / 100
    return hsn, rate, half, half, Decimal("0"), ca, ca, Decimal("0")


def _addr_text(addr):
    """Flatten an address (dict/JSON or string) into one readable line."""
    if not addr:
        return ""
    if isinstance(addr, str):
        return addr
    if isinstance(addr, dict):
        parts = [addr.get("line1") or addr.get("raw_address") or addr.get("address") or "",
                 addr.get("line2") or "", addr.get("city") or addr.get("district") or "",
                 addr.get("state") or "", str(addr.get("pincode") or addr.get("pin") or "")]
        return ", ".join(p for p in parts if str(p).strip())
    return str(addr)


_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
         "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
         "Seventeen", "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _two_words(n):
    return _ONES[n] if n < 20 else (_TENS[n // 10] + (" " + _ONES[n % 10] if n % 10 else "")).strip()


def _three_words(n):
    h, r = n // 100, n % 100
    s = (_ONES[h] + " Hundred") if h else ""
    return (s + (" " + _two_words(r) if r else "")).strip()


def _group_words(n):
    """Any non-negative integer -> words, by peeling off crore/lakh/thousand/
    hundred groups the Indian way. Used for the "crore" segment of
    _amount_words, which — unlike lakh/thousand (both taken mod 100) — is NOT
    bounded to two digits: an opening balance of Rs 100+ crore made `crore`
    itself 3+ digits, and _two_words(crore) indexed _TENS[crore // 10 >= 10],
    an IndexError ("list index out of range") that only surfaced on amounts
    this large — which is exactly the size an opening balance can be."""
    if n < 100:
        return _two_words(n)
    if n < 1000:
        return _three_words(n)
    crore, rem = divmod(n, 10000000)
    lakh, rem = divmod(rem, 100000)
    thou, hund = divmod(rem, 1000)
    segs = []
    if crore:
        segs.append(_group_words(crore) + " Crore")
    if lakh:
        segs.append(_two_words(lakh) + " Lakh")
    if thou:
        segs.append(_two_words(thou) + " Thousand")
    if hund:
        segs.append(_three_words(hund))
    return " ".join(segs)


def _amount_words(amount):
    """Indian-system rupees to words: '… Crore … Lakh … Thousand … Rupees and NN Paise Only'.

    A customer-advance opening balance is carried as a NEGATIVE receivable (see
    import_opening_balances), and _two_words()/_three_words() were never built
    for negative input: `rupees // 10000000` etc. floor-divide the wrong way on
    a negative rupees, and the paise remainder came out negative too, so
    _two_words(negative_paise) indexed _ONES with a negative index — silently
    wrong for -1..-19, an IndexError ("list index out of range") for anything
    more negative. Normalising to the absolute value up front and prefixing
    "Minus" avoids both: every digit-group calculation below only ever sees a
    non-negative number, and the sign is never silently dropped either.
    """
    amount = Decimal(str(amount or 0))
    negative = amount < 0
    amount = abs(amount)
    rupees = int(amount)
    paise = int((amount - rupees) * 100 + Decimal("0.5"))
    if rupees == 0:
        words = "Zero"
    else:
        crore, lakh = rupees // 10000000, (rupees // 100000) % 100
        thou, hund = (rupees // 1000) % 100, rupees % 1000
        segs = []
        if crore:
            segs.append(_group_words(crore) + " Crore")
        if lakh:
            segs.append(_two_words(lakh) + " Lakh")
        if thou:
            segs.append(_two_words(thou) + " Thousand")
        if hund:
            segs.append(_three_words(hund))
        words = " ".join(segs)
    out = f"{'Minus ' if negative else ''}Rupees {words}"
    if paise:
        out += f" and {_two_words(paise)} Paise"
    return (out + " Only")[:500]


def _company_warehouse(company):
    """A warehouse for the company (needed on DC / PO / GRN). First active one."""
    from core.models import Warehouse
    return (Warehouse.objects.filter(company=company, is_active=True).first()
            or Warehouse.objects.filter(company=company).first()
            or Warehouse.objects.first())


def _due_date(base_date, terms, custom_days):
    """Due date from a credit-terms code (NET_15/30/45/60/CUSTOM)."""
    from datetime import timedelta
    days = {"NET_15": 15, "NET_30": 30, "NET_45": 45, "NET_60": 60}.get(
        (terms or "").upper(), int(custom_days or 0) if terms == "CUSTOM" else 0)
    return base_date + timedelta(days=days) if days else base_date


import re as _re


def _credit_days(text):
    """'45 Days' / '45' -> 45 ; blank -> 0."""
    if not text:
        return 0
    m = _re.search(r"(\d+)", str(text))
    return int(m.group(1)) if m else 0


# Default credit period when neither Tally nor the ERP master specifies one —
# so an imported invoice's due date is never just its invoice date.
_DEFAULT_CREDIT_DAYS = 45


def _due_from_ledger(ctx, party_name, party_obj, date, kind="customer"):
    """Real due date for an imported doc: the party's Tally credit period
    ('30 Days' etc. from the ledger master) → invoice_date + N. Falls back to the
    ERP master's terms, then a 30-day default. Returns (due_date, terms_label)."""
    from datetime import timedelta
    led = (ctx.ledger_master or {}).get((party_name or "").strip()) or {}
    days = _credit_days(led.get("credit_period"))
    if not days:
        if kind == "customer":
            terms = (getattr(party_obj, "credit_terms", "") or "")
            custom = getattr(party_obj, "custom_credit_days", 0)
        else:
            terms = (getattr(party_obj, "payment_terms", "") or "")
            custom = getattr(party_obj, "custom_payment_days", 0)
        days = {"NET_15": 15, "NET_30": 30, "NET_45": 45, "NET_60": 60}.get(
            terms.upper(), int(custom or 0) if terms == "CUSTOM" else 0)
        # 'Cash' means due on presentation. That is an EXPLICIT term, not a
        # missing one, so it must NOT fall through to _DEFAULT_CREDIT_DAYS
        # below -- which would silently grant 45 days of credit the customer
        # does not have.
        #
        # Measured on SS Biochem, 29-Sep-2026: Tally holds no credit period for
        # 81 of its 97 customers -- T.Stanes, KSE, Sharda and Gujarat Ambuja
        # among them -- and `Customer.credit_terms` defaults to NET_30 for
        # every master the importer creates. Between that default and this one,
        # the ERP invented credit for 81 parties and parked 185 bills
        # (Rs 19,52,88,913) in "Not due" while Tally's own ageing showed every
        # one of them already overdue. The 30/60/90 buckets were meaningless.
        #
        # CUSTOMER SIDE ONLY. The vendor branch above is deliberately left
        # alone: this same helper sets due dates on purchase bills (see the
        # kind="vendor" caller in _import_purchase), and those must not move.
        if kind == "customer" and terms.upper() == "CASH":
            return date, "Due on invoice"
    if not days and kind == "customer":
        # Terms somebody actually dated beat the blanket default below. This
        # is the ONLY place the ERP master is allowed to decide a due date,
        # and credit_days_for returns None unless a human set an effective
        # date — which is what keeps the NET_30-on-every-row default from
        # inventing credit again (see the measurement above).
        from master.credit_terms import credit_days_for, terms_label
        agreed = credit_days_for(party_obj, date)
        if agreed is not None:
            return date + timedelta(days=agreed), terms_label(party_obj)[:20]
    if not days:
        days = _DEFAULT_CREDIT_DAYS
    return date + timedelta(days=days), f"{days} Days"


def _bill_due(v, date):
    """Tally's authoritative per-bill due date: invoice_date + the bill's own
    BILLCREDITPERIOD ('45 Days') taken from the party ledger's bill allocation
    on THIS voucher. This is what Tally's 'Due on' column shows — it overrides
    the ledger-master / ERP-terms guess. Returns (due_date, days) or (None, 0)."""
    from datetime import timedelta
    ledgers = v.get("ledgers", []) if isinstance(v, dict) else []
    # Prefer the party ledger's bill; fall back to any bill carrying a period.
    for party_only in (True, False):
        for led in ledgers:
            if party_only and not led.get("is_party"):
                continue
            for b in led.get("bills", []):
                days = _credit_days(b.get("credit_period"))
                if days:
                    return date + timedelta(days=days), days
    return None, 0


def _bill_ref(v):
    """The bill reference Tally raised for the party on THIS voucher.

    Tally's bill-wise detail names the bill; that name is what later receipts
    settle against — and it is NOT the voucher number. The operator types the
    party's own bill number, and on UAI it runs one behind: voucher
    UAI/241/26-27 carries the reference "UAI/240/26-27" (narration: "AGST REF
    B.NO. 240"). Matching receipts on the voucher number instead paid whichever
    stranger happened to own an invoice of that number and left the real bill
    open, so the invoice must remember the reference. Returns '' when Tally
    raised none (cash sales, on-account vouchers)."""
    for party_only in (True, False):
        for led in (v.get("ledgers", []) if isinstance(v, dict) else []):
            if party_only and not led.get("is_party"):
                continue
            for b in led.get("bills", []):
                name = (b.get("name") or "").strip()
                # 'New Ref' is the bill this sale opens — the one receipts will
                # quote. 'Agst Ref' on a sale settles a reference an advance
                # receipt opened earlier under the same name, so either is the
                # right link back to this invoice.
                if name and "on account" not in (b.get("type") or "").lower():
                    return name[:120]
    return ""


def _bill_due_map(bills):
    """{bill_name -> due_date} from Tally's Bills-Outstanding report. Each bill
    carries its bill date + BILLCREDITPERIOD ('45 Days') — or an explicit due
    date — which is the REAL due date Tally shows. The voucher XML doesn't carry
    it, so this report is the authoritative source for imported due dates."""
    import re as _re2
    from datetime import datetime as _dt, timedelta
    def _bd(s):
        try:
            return _dt.strptime(s, "%Y%m%d").date()
        except (TypeError, ValueError):
            return None
    out = {}
    for b in bills or []:
        name = (b.get("name") or "").strip()
        cp = (b.get("credit_period") or "").strip()
        if not name:
            continue
        bd = _bd(b.get("billdate"))
        # No per-bill credit period in Tally → fall back to a 45-day default
        # (business rule) so the due date isn't just the invoice date.
        if not cp:
            if bd:
                out[name] = bd + timedelta(days=_DEFAULT_CREDIT_DAYS)
            continue
        due = None
        m = _re2.match(r"^(\d+)\s*Days?$", cp, _re2.I)
        if m and bd:
            due = bd + timedelta(days=int(m.group(1)))
        elif _re2.match(r"^\d+$", cp) and bd:
            due = bd + timedelta(days=int(cp))
        else:
            for f in ("%d-%b-%y", "%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d"):
                try:
                    due = _dt.strptime(cp, f).date()
                    break
                except (TypeError, ValueError):
                    pass
        if due:
            out[name] = due
    return out


class _Ctx:
    """Per-run caches + summary."""
    def __init__(self, company, created_by, dry_run):
        self.company = company
        self.created_by = created_by
        self.dry_run = dry_run
        self.product_cache = {}
        self.ledger_master = {}   # Tally party ledgers: name -> {gstin,state,address}
        self.bill_due_map = {}    # bill/invoice no -> real Tally due date
        self.stock_master = {}    # Tally stock items:  name -> {hsn,gst_rate}
        self.summary = {
            "sales": 0, "purchase": 0, "receipts": 0, "payments": 0,
            "products_created": 0, "skipped_existing": 0,
            "unmatched_customers": set(), "unmatched_vendors": set(),
            # Map-to-existing suggestions for the confirm popup, keyed by the
            # Tally name — the party import already fills these; the VOUCHER
            # import now fills them too, so an unresolved note party gets the
            # same Map / Create / Skip choice instead of vanishing.
            "customer_options": {}, "vendor_options": {},
            "new_products": set(), "errors": [],
            # ── Mirror check: how the import differs from Tally ────────────
            # Everything here is INFORMATIONAL — the import never blocks on it.
            # The point is that a divergence is visible on the import screen the
            # day it happens, instead of surfacing weeks later as a monthly
            # variance nobody can trace.
            #   mirror_month  {YYYY-MM: {tally, erp, n}} — Tally voucher value vs
            #                 what was created; any month where they differ is a
            #                 real problem worth opening before you rely on it.
            #   unbalanced    vouchers where taxable + GST − TDS + round_off does
            #                 not equal the party total, i.e. mis-read.
            #   no_hsn        invoices whose lines carry no HSN/SAC. These import
            #                 fine but TALLY DROPS THEM FROM GSTR-1 — the exact
            #                 defect that hid Rs 4,60,575 of output GST on DN-006.
            #   notes_month   {YYYY-MM: {tally, erp}} — Debit/Credit Note vouchers
            #                 Tally sent vs notes actually written. The value
            #                 mirror only covers sales vouchers, so 13 of SS
            #                 Biochem's 60 notes went missing behind a mirror that
            #                 read green on every month. Counted separately now.
            "mirror_month": {}, "unbalanced": [], "no_hsn": [],
            "notes_month": {},
        }


# The handful of company-suffix spellings that vary constantly in Indian party
# names. Canonicalised as WHOLE WORDS before punctuation is stripped, so 'Ponalab
# Biogrowth Private Limited' and 'Ponalab Biogrowth Pvt Ltd' key the same. Safe
# against false merges: _unique_by_norm only binds when exactly one master keys
# equal, so any collision between two genuinely different parties defers to
# review instead of guessing.
_NAME_CANON = (
    (_re.compile(r"\bprivate\b"), "pvt"),
    (_re.compile(r"\blimited\b"), "ltd"),
    (_re.compile(r"\bcompany\b"), "co"),
    (_re.compile(r"\band\b"), "&"),   # then stripped, so 'and' == '&'
)


def _norm_name(s):
    """Spelling-agnostic key for a party name: lowercase, canonicalise the common
    company-suffix abbreviations (Private/Pvt, Limited/Ltd, Company/Co, and/&),
    then drop every non-alphanumeric character. 'Sharda Cropchem Ltd- Mumbai' and
    'Sharda Cropchem Ltd - Mumbai' both key to 'shardacropchemltdmumbai'; 'Ponalab
    ... Private Limited' and 'Ponalab ... Pvt Ltd' both key to '...pvtltd'; while a
    distinguishing suffix still survives ('...southng' vs '...south')."""
    t = (s or "").lower()
    for rx, repl in _NAME_CANON:
        t = rx.sub(repl, t)
    return _re.sub(r"[^a-z0-9]", "", t)


_GENERIC_TOKENS = {
    "india", "indian", "private", "pvt", "limited", "ltd", "company", "co",
    "and", "the", "corp", "corporation", "enterprises", "enterprise", "traders",
    "trading", "industries", "agencies", "agency", "sales", "chennai", "mumbai",
    "bangalore", "blre", "salem", "coimbatore", "kerala", "north", "south",
    "east", "west", "branch", "br", "unit", "group", "international", "llp",
}


def _names_agree(a, b):
    """Do two party names share a DISTINCTIVE word?

    Company suffixes and city names are not evidence of identity: "Tropical Agro
    System (India) Pvt.Ltd - Chennai" and "Terramera Biosciences (India) Pvt Ltd-
    Chennai" have "india", "pvt", "ltd" and "chennai" in common and are different
    companies. Only a word outside that generic set counts."""
    def toks(x):
        return {t for t in _re.split(r"[^a-z0-9]+", (x or "").lower())
                if len(t) >= 4 and t not in _GENERIC_TOKENS}
    ta, tb = toks(a), toks(b)
    if not ta or not tb:
        return True            # nothing to judge on — don't block the match
    return bool(ta & tb)


def _unique_by_norm(model, field, name, company):
    """Whitespace/punctuation-insensitive fallback match, scoped to one company.
    Returns the master whose normalized name equals the party's -- but ONLY when
    exactly one matches, so an ambiguous look-alike is never guessed (e.g. the
    six 'Greenstar ... South/North ...' masters stay deferred to review)."""
    key = _norm_name(name)
    if not key or not company:
        return None
    hits = [obj for obj in model.objects.filter(company=company, is_active=True)
            if _norm_name(getattr(obj, field)) == key]
    return hits[0] if len(hits) == 1 else None


def _ledger_master_required(ctx, s, what):
    """True (and records why) when the customer/non-customer split cannot be
    trusted because Tally's ledger master never arrived.

    `_is_customer_ledger` falls back to True for any ledger it cannot find, which
    is right for a single unknown name and catastrophic for ALL of them: with an
    empty master every credit leg looks like a customer credit. The master fetch
    is best-effort by design (a file import has no gateway), so a gateway that
    dies mid-run silently reinstates the very bug the primary-group rule fixed.
    Measured on United Agro August 2026, imported while the gateway was down:
        Sri Murugan Transport - A.P   10,72,610.00   transporter
        Kalamani Transport             4,28,294.00   transporter
        Tamil Nadu Electricty Board    5,02,803.00   expense
                                      ─────────────
                                       20,03,707.00  all booked as customer
    credits, turning a Rs 7,90,650 shortfall against Tally's Sundry-Debtors
    Credit column into a Rs 13,17,007 overshoot. So: refuse, and say so.
    """
    if ctx.ledger_master:
        return False
    s.setdefault("errors", []).append(
        f"{what}: REFUSED — Tally's ledger master could not be fetched, so a "
        f"customer ledger cannot be told from a transporter or an expense. "
        f"Re-run when the gateway answers.")
    return True


def _led(ctx, name):
    """Tally's master row for a ledger, matched forgivingly on the name.

    Every classification below asks this master one question: what GROUP is this
    party in. The lookup used to be an exact dictionary hit on Tally's spelling,
    and a MISS does not fail loudly — `_is_customer_ledger` falls back to True.
    So a single name the master did not answer for became, silently, a customer.

    SS Biochem April 2026 is the measured case. Tally's Group Vouchers ->
    Sundry Debtors -> Receipt totals Rs 13,88,70,103.47, while the bank ledgers
    come to Rs 13,88,92,304.47. Three vouchers sit in the difference, and two of
    them are Mr.R.P.Chandran (vch 17 Rs 2,363 and vch 34 Rs 1,838 = Rs 4,201).
    He is not in Sundry Debtors — Tally's own report omits him — yet the ERP
    counted his money as a customer collection, because his ledger name as
    written on the voucher did not hit the master key exactly.

    So: exact key first, and only on a miss a normalised index — case-folded
    with punctuation and spacing removed by `_norm_name`, the same normaliser
    the customer matcher already uses, so "Mr.R.P.Chandran" and "Mr. R.P.
    Chandran" reach the same row. Built once per import and cached on ctx.

    A normalised key that TWO different ledgers collapse to is dropped, not
    guessed: answering with the wrong party's group would be worse than
    answering with nothing, and nothing is what the callers already handle.
    """
    master = getattr(ctx, "ledger_master", None) or {}
    nm = (name or "").strip()
    if not nm or not master:
        return None
    hit = master.get(nm)
    if hit is not None:
        return hit
    idx = getattr(ctx, "_ledger_norm_index", None)
    if idx is None:
        idx = {}
        for k in master:
            n = _norm_name(k)
            if not n:
                continue
            idx[n] = None if n in idx else k      # ambiguous -> refuse to guess
        try:
            ctx._ledger_norm_index = idx
        except AttributeError:
            pass
    key = idx.get(_norm_name(nm))
    return master.get(key) if key else None


def _is_customer_ledger(ctx, name):
    """Is this Tally ledger a CUSTOMER? Decided by its PRIMARY group.

    Tally reports a primary group on 1906 of United Agro's 1907 ledgers, and it
    answers the question outright where the immediate parent never could:

        T.Stanes And Company Ltd., - Coimbatore   parent "Sundry Debtors - Corporate…"
        Greenstar Fertilisers Limited - South     parent "Greenstar Fertilizers Limi…"
        Kaliamman                                 parent "Sundry Debtors - Direct C…"
            -> all three primary group "Sundry Debtors"                    CUSTOMER
        ICICI Term Loan 603090078968              -> "Secured Loans"
        Sri Lakshmisaraswathi Oil Mill            -> "Sundry Creditors"
        Vehicle Maintenence  (parent "Vehicle Maintenance") -> "Indirect Expenses"
        ICICI Suspense A/c                        -> "Suspense A/c"        NOT

    This replaces a keyword blacklist that had to be widened three times — for
    loans, then creditors and expenses, then suspense accounts — and would have
    needed widening again for the next group nobody thought of. A positive test
    against one group name cannot rot the same way.

    Fallbacks, so nothing regresses where the primary group is unavailable:
      * ledger present but no primary group  -> the old blacklist on the parent
      * ledger not in the master at all (fetch failed) -> allow, as before
    """
    g = _co_groups(getattr(ctx, "company", None))
    led = _led(ctx, name)
    if not led:
        return True                                   # nothing known — behave as before
    pg = (led.get("primary_group") or "").strip()
    if pg:
        return g["debtor"] in pg.lower()
    parent = (led.get("parent") or "").strip()
    # A ledger whose parent IS "Primary" sits at the top of Tally's tree — the
    # books' own accounts, not a party. "Profit & Loss A/c" reports no primary
    # group at all and so slipped through the fallback below as a customer,
    # carrying Rs 3,80,81,887.49 of SS Biochem into the customer comparison. It
    # did no damage only because no ERP master shares its name.
    if parent.lower() == "primary":
        return False
    return not (parent and _non_trading_hit(parent, g["non_trading"]))


def _is_trading_creditor(ctx, name):
    """Is this ledger a party we TRADE with, that Tally happens to file under
    Sundry Creditors?

    `_is_customer_ledger` answers "Sundry Debtors, yes or no", which is right for
    deciding whose bills a receipt may settle. It is wrong for deciding whether
    money ARRIVED. A party we both buy from and sell to sits in Sundry Creditors
    — Tally nets the sale against the payable, so it never reaches the debtors
    credit column — and its receipts were being refused outright and dropped.
    The owner's rule is explicit: "even if they are creditors, if a receipt is
    there, bring them."

    So this splits the refusal in two. A trading creditor's receipt is IMPORTED,
    but as cash only: `is_receipt=True` puts it on the Receipts line,
    `counts_as_received=False` keeps it out of the Received total, which mirrors
    Tally's debtors credit column and would otherwise run over. It settles no
    bill and moves no balance.

    Loans, banks, capital, expenses, duties and suspense accounts stay refused,
    exactly as before — that block exists because Rs 14.90 CRORE of United Agro
    borrowing once imported as customer receipts, and nothing here weakens it.
    """
    g = _co_groups(getattr(ctx, "company", None))
    led = _led(ctx, name)
    if not led:
        return False                       # unknown ledger: refuse, as before
    pg = (led.get("primary_group") or "").strip().lower()
    if pg:
        return g["creditor"] in pg
    parent = (led.get("parent") or "").strip().lower()
    return g["creditor"] in parent


def _ledger_group(ctx, name):
    """The Tally group that decides what a ledger IS.

    PRIMARY group first, immediate parent only as a fallback. Tally shows the
    primary in brackets under "Under:", and it is the one that answers the
    question: "Vehicle Maintenence" reports its parent as a sub-group also called
    "Vehicle Maintenance" — which says nothing — while its primary group is
    "Indirect Expenses". Testing the parent alone let a Rs 34,138 expense ledger
    through as a customer advance. Blank on Tally builds that don't expose the
    field, in which case the parent is all there is.
    """
    led = _led(ctx, name) or {}
    return (led.get("primary_group") or led.get("parent") or "").strip()


def _note_no_party(ctx, v, kind):
    """Report a voucher dropped because it names no party.

    Every other skip path tells the operator: an unresolved name goes to
    `unmatched_customers` and the import screen asks them to map it. This one
    could not, because there is no name to put in the popup — so it returned in
    total silence and the voucher vanished with nothing on screen to say so.
    A number and a date are still enough to find it in Tally, which beats a
    blank space, so report those instead of nothing.
    """
    ctx.summary.setdefault("no_party_vouchers", []).append({
        "kind": kind,
        "vtype": v.get("vtype") or "",
        "number": v.get("number") or "",
        "date": str(v.get("date") or ""),
        "amount": str(abs(_split_ledgers(v)[0]) if v.get("ledgers") else ""),
    })


def _note_skipped(ctx, v, kind, party=None):
    """Record a voucher DROPPED because its party could not be resolved.

    The names alone were already reported, but nothing said how many vouchers
    went with them or what they were worth — so a command-line import could
    finish looking successful while silently leaving money out. United Agro May
    2026: receipts 54, 55, 59, 60, 65, 68, 72, 73, 74, 78, 79, 80, 81 never
    landed, and T.Stanes sat Rs 19,49,086 above Tally's ledger as a result. The
    import printed a warning and committed anyway.

    `import_tally` now refuses to --commit when this list is non-empty (see
    --allow-skips there), and the UI import already asks per party.
    """
    try:
        val = abs(_split_ledgers(v)[0])
    except Exception:  # noqa: BLE001 — a name is worth more than nothing
        val = Decimal("0")
    ctx.summary.setdefault("skipped_unmatched", []).append({
        "kind": kind,
        "number": (v.get("number") or "")[:50],
        "date": v.get("date") or "",
        "party": (party or v.get("party") or "")[:120],
        "value": str(val.quantize(Decimal("0.01"))),
    })


def _match_customer(name, company):
    from master.models import Customer
    from .models import TallyPartyMap
    nm = name.strip()
    # Operator-defined mapping wins (Tally name -> chosen ERP customer).
    if company:
        m = (TallyPartyMap.objects
             .filter(company=company, tally_name__iexact=nm, customer__isnull=False)
             .select_related("customer").first())
        if m and m.customer and m.customer.is_active:
            return m.customer
    qs = Customer.objects.filter(customer_name__iexact=nm, is_active=True)
    if company:
        # Same company only. This used to fall through to `qs.first()` — ANY
        # company — so an SS Biochem voucher bound to a United Agro master
        # whenever SS had no party of that name. Measured on a local SS import:
        # 7 of 47 debit notes pointed at UAI vendors, DN-0052 among them. A
        # party we do not have is an unmatched party (the import screen now asks
        # what to do with it), never another company's.
        c = qs.filter(company=company).first()
        if c:
            return c
        # Exact (case-only) match missed. Tally names drift on spacing and
        # punctuation -- 'Ltd- Mumbai' vs 'Ltd - Mumbai', 'Limited -  South'
        # with a double space -- which used to silently skip real invoices.
        # Retry on the spelling-agnostic key so an existing customer in this
        # company is never dropped as unmatched.
        return _unique_by_norm(Customer, "customer_name", nm, company)
    return qs.first()


def _match_vendor(name, company):
    from master.models import Vendor
    from .models import TallyPartyMap
    nm = name.strip()
    if company:
        m = (TallyPartyMap.objects
             .filter(company=company, tally_name__iexact=nm, vendor__isnull=False)
             .select_related("vendor").first())
        if m and m.vendor and m.vendor.is_active:
            return m.vendor
    qs = Vendor.objects.filter(vendor_name__iexact=nm, is_active=True)
    if company:
        v = qs.filter(company=company).first()       # never another company's — see _match_customer
        if v:
            return v
        return _unique_by_norm(Vendor, "vendor_name", nm, company)  # spacing/punctuation-safe fallback
    return qs.first()


def _match_by_gstin(model, field, gstin, company):
    """Match a party by GSTIN (Tally ledger master) — robust to name-spelling
    drift ('Pvt Ltd' vs 'Private Limited', 'Fertilisers' vs 'Fertilizers').
    Restricted to the SAME company: a GSTIN repeats across companies/branches
    (both our companies trade with the same parties), so falling back to any
    company would bind one company's voucher to the other's master — the same
    leak `_match_customer` describes."""
    g = (gstin or "").strip()
    if not g:
        return None
    qs = model.objects.filter(**{field: g, "is_active": True})
    return qs.filter(company=company).first() if company else qs.first()


def _stamp_tally_group(c, name, ctx):
    """Record which Tally GROUP this party's ledger sits in.

    Some parties are both customer and supplier, and Tally keeps ONE ledger
    each, filing it under Sundry Creditors. Its Sundry Debtors closing
    therefore excludes them while the ERP's sales module still holds the sale
    — Rs 93,48,590 of Outstanding across the two companies that no Tally
    screen has ever contained.

    The dashboard makes that same split from this field. Before it existed the
    only way to answer was to ask Tally live, which is what
    `settle_creditor_sales` did on every run; that command is retired because
    it sized each set-off to the whole sale instead of to what the party still
    owed. Storing the group means the tenth such party lands in the right place
    with nobody editing a list, and a party Tally regroups later follows on its
    own, because this is rewritten on every import.
    """
    if c is None or ctx.dry_run:
        return c
    grp = (_ledger_group(ctx, name) or "")[:120]
    if grp and (c.tally_group or "") != grp:
        c.tally_group = grp
        c.save(update_fields=["tally_group"])
    return c


def _resolve_customer(name, ctx):
    """Name/operator-map first, then GSTIN from the Tally ledger master.

    A GSTIN match is a match on the REGISTRATION, not on the name, so it happily
    binds one branch to another: Tally's "Green City Biotech- Rajapalayam" and
    the ERP's "Green City Biotech - Coimbatore" share 33FODPS4532F1Z0, as do
    "AmuthaLakshmi Agro Organic-Namakkal" and "Amuthalakshmi Agro Organic". The
    money is not lost — it lands on a real master of the same taxpayer — but the
    row then reads a town the voucher never mentioned, and nothing said why.

    So a GSTIN-only match is RECORDED, not silent: it is reported on the import
    summary, and a TallyPartyMap is written so the link is explicit, visible on
    the Mappings page, and editable — point it at the right branch once and the
    guess never happens again.
    """
    from master.models import Customer
    c = _match_customer(name, ctx.company)
    if c:
        return _stamp_tally_group(c, name, ctx)
    led = (ctx.ledger_master or {}).get((name or "").strip()) or {}
    gst = led.get("gstin")
    c = _match_by_gstin(Customer, "gstin__iexact", gst, ctx.company)
    nm = (name or "").strip()
    # A GSTIN match is only trustworthy when the NAME agrees too. A registration
    # number typed onto the wrong master binds two unrelated companies: SS
    # Biochem's "Terramera Biosciences" carries 33AAACT4250E1ZU, which belongs to
    # Tropical Agro — so Tropical Agro's ledger resolved to Terramera and its
    # Rs 49,94,668 opening was booked to a different customer entirely. Worse, the
    # block below then WROTE that as a permanent mapping, so the wrong answer
    # outlived the bad data. Require one distinctive word in common; without it,
    # report the party as unmatched and let the operator map it, which is what
    # the import screen is for.
    if c and not _names_agree(nm, c.customer_name):
        ctx.summary.setdefault("gstin_name_conflict", []).append(
            {"tally_name": nm, "erp_name": c.customer_name, "gstin": gst or ""})
        return None
    # A GSTIN is the TAXPAYER's, not the ledger's, so one number covers every
    # master of that party -- including the one we BUY from. Binding a sale to
    # the purchase master hides the invoice from debtors entirely, because
    # creditor parties are excluded from every outstanding figure
    # (SUPPLIERS_NOT_DEBTORS). SS Biochem's S-22/26-27 (6-May, Rs 19,688) landed
    # that way on "PM Agro Biotech Pvt Ltd - RM" while Tally holds it on
    # "Pm Agro Biotech Private Limited" with S-199 -- Rs 77,963 on one ledger in
    # Tally, split across two masters here, and the ERP read Rs 19,688 short
    # against Tally's Sundry Debtors for five months.
    #
    # Only refused when the NAME does not agree either: a party we genuinely
    # both buy from and sell to keeps working, because its own master matches by
    # name long before this fallback is reached. Reported, not silent -- the
    # import screen asks the operator to map or create, which is the one place
    # that can tell the two masters apart.
    if c and ctx.company and _norm_name(nm) != _norm_name(c.customer_name):
        if (getattr(c, 'tally_group', '') or '').strip().lower() ==                 _co_groups(ctx.company)['creditor']:
            ctx.summary.setdefault("gstin_matched_a_supplier", []).append(
                {"tally_name": nm, "erp_name": c.customer_name, "gstin": gst or "",
                 "group": c.tally_group})
            return None
    if c and ctx.company:
        if _norm_name(nm) != _norm_name(c.customer_name):
            ctx.summary.setdefault("matched_by_gstin", []).append(
                {"tally_name": nm, "erp_name": c.customer_name, "gstin": gst or ""})
            if not ctx.dry_run:
                from .models import TallyPartyMap
                TallyPartyMap.objects.get_or_create(
                    company=ctx.company, tally_name=nm[:255],
                    defaults={"customer": c})
    return _stamp_tally_group(c, name, ctx)


def _resolve_vendor(name, ctx):
    """Resolve a Tally ledger name to an ERP vendor, GSTIN-first.

    Order (cheapest/most-reliable first): operator alias (TallyPartyMap) →
    GSTIN exact → name / normalised. GSTIN beats the name because Tally and the
    ERP spell the same firm differently ('Pvt Ltd' vs 'Private Limited',
    'Fertilisers' vs 'Fertilizers'); the tax ID does not drift. Mirrors the
    scan resolver (_resolve_vendor_ordered) so both paths rank matches the same
    way."""
    from master.models import Vendor
    from .models import TallyPartyMap
    nm = (name or "").strip()
    led = (ctx.ledger_master or {}).get(nm) or {}

    # 1. Operator alias — highest trust (survives re-imports, travels between DBs).
    if ctx.company and nm:
        m = (TallyPartyMap.objects
             .filter(company=ctx.company, tally_name__iexact=nm, vendor__isnull=False)
             .select_related("vendor").first())
        if m and m.vendor and m.vendor.is_active:
            return m.vendor

    # 2. GSTIN exact — reliable tax ID, beats a drifted name.
    v = _match_by_gstin(Vendor, "gstin__iexact", led.get("gstin"), ctx.company)
    if v:
        return v

    # 3. Name / normalised fallback.
    return _match_vendor(nm, ctx.company)


def suggest_party_candidates(name, kind, company, limit=4, gstin=None):
    """Fuzzy-match an unmatched party name against existing masters of the SAME
    company, so the import / scan-review dialog can offer 'map to existing'
    options (e.g. Tally 'Greenstar Fertilisers Limited - South' -> ERP
    'Greenstar South'). Returns [{id, name, gstin, match_by}] ranked best-first.

    When a `gstin` is supplied (scan bills carry the seller's GSTIN), an EXACT
    tax-ID match in the same company is surfaced FIRST with match_by='gstin' —
    the authoritative match even when the printed/OCR'd name differs completely
    from the master spelling. Name-similarity candidates follow, de-duped."""
    import re
    import difflib
    from master.models import Customer, Vendor
    _STOP = {"pvt", "ltd", "limited", "private", "the", "and", "co", "company",
             "llp", "india", "enterprises", "traders", "industries"}

    def _toks(s):
        return {t for t in re.sub(r"[^a-z0-9 ]", " ", str(s or "").lower()).split()
                if t and t not in _STOP}

    def _nrm(s):
        return re.sub(r"[^a-z0-9]", "", str(s or "").lower())

    want, wn = _toks(name), _nrm(name)
    if not want:
        return []
    # For a PRODUCT the numbers are the identity, and they are a tiny fraction
    # of the string — so similarity alone proposes matches that are wrong in
    # the worst possible way. Measured on a real Zoho preview:
    #     'Neem Oil 1.2% 50 Ltr'  vs  'Neem Oil 1.2 % - 5 Ltr'      97%
    #     'Spic Scytoz 50 ML'     vs  'Spic Scytoz - 250 ML'        97%
    #     'Label Nimbecidine 5 %' vs  'Label Nimbecidine 1 %'       96%
    #     four distinct Edge Projecter sizes  ->  one 1000 MM master
    # Accepting any of those files a purchase line against the wrong pack size,
    # which then misprices stock. A candidate must agree on every number.
    from master.merge_utils import measures
    want_nums = measures(name) if kind == 'product' else None
    from master.models import Product
    if kind == "product":
        Model, field, code, scoped = Product, "product_name", "sku_code", False
    elif kind == "customer":
        Model, field, code, scoped = Customer, "customer_name", "gstin", True
    else:
        Model, field, code, scoped = Vendor, "vendor_name", "gstin", True
    qs = Model.objects.filter(is_active=True)
    if scoped and company:
        qs = qs.filter(company=company)

    out = []
    seen = set()
    # Tier 1 — GSTIN exact (authoritative; beats any name guess).
    g_in = (gstin or "").strip()
    if scoped and kind == "vendor" and len(g_in) == 15:
        gq = qs.filter(gstin__iexact=g_in).only("id", field, code).first()
        if gq:
            out.append({"id": str(gq.id), "name": getattr(gq, field) or "",
                        "gstin": getattr(gq, code) or "", "match_by": "gstin"})
            seen.add(str(gq.id))

    # Tier 2 — name similarity.
    scored = []
    for obj in qs.only("id", field, code):
        if str(obj.id) in seen:
            continue
        onm = getattr(obj, field) or ""
        if want_nums is not None and measures(onm) != want_nums:
            continue
        ot = _toks(onm)
        if not (want & ot):
            continue
        jac = len(want & ot) / len(want | ot)
        ratio = difflib.SequenceMatcher(None, wn, _nrm(onm)).ratio()
        score = max(jac, ratio)
        # Require a real overlap, not just one incidental shared word.
        if score >= 0.5 and (jac >= 0.34 or ratio >= 0.6):
            scored.append((score, str(obj.id), onm, getattr(obj, code) or ""))
    scored.sort(key=lambda x: -x[0])
    for _, i, n, g in scored[: max(0, limit - len(out))]:
        out.append({"id": i, "name": n, "gstin": g, "match_by": "name"})
    return out


def _get_or_create_product(name, uom, ctx):
    from master.models import Product
    from .models import TallyPartyMap
    nm = name.strip()
    key = nm.lower()
    if key in ctx.product_cache:
        return ctx.product_cache[key]
    # Operator decision (from the resolve-parties popup) wins: an explicit
    # map to an existing Product, or a SKIP that must NOT auto-create.
    if ctx.company:
        m = TallyPartyMap.objects.filter(company=ctx.company, tally_name__iexact=nm).first()
        if m and m.skip:
            ctx.product_cache[key] = None
            return None
        if m and m.product_id and m.product.is_active:
            ctx.product_cache[key] = m.product
            return m.product
    p = Product.objects.filter(product_name__iexact=nm).first()
    if not p:
        # Exact spelling missed. Tally and the ERP punctuate the same item
        # differently — "Neem Fruit Seed -SLP" against "Neem Fruit / Seed - SLP",
        # "Neem Oil - EC" against "Neem Oil EC" — and creating a second product
        # for the same thing splits its quantity and stock in two. United Agro's
        # local database ended up with FOUR spellings of Neem Oil EC that way,
        # two of them carrying the wrong unit (NOS where the original was LTR).
        # Retry ignoring spaces and punctuation, and accept it ONLY when exactly
        # one product matches — two candidates is an ambiguity to put in front of
        # the operator, never a guess to make here.
        p = _unique_product_by_norm(nm)
    if not p:
        ctx.summary["new_products"].add(nm)
        if not ctx.dry_run:
            # Fallback: auto-create when the operator didn't resolve it, so
            # item lines aren't silently dropped (they can map/skip in the UI).
            from master.sku_gen import next_sku
            sku = next_sku("GOODS", "FINISHED_GOOD") or f"FIN GO-TLY{Product.objects.count()+1:04d}"
            p = Product.objects.create(
                product_name=nm[:200], product_type="GOODS",
                goods_sub_type="FINISHED_GOOD", uom=_map_uom(uom), sku_code=sku,
                created_by=ctx.created_by,
            )
            ctx.summary["products_created"] += 1
    ctx.product_cache[key] = p
    return p


def _norm_item(s):
    """Spelling-agnostic key for a stock item: lowercase, drop everything that
    is not a letter or digit. Slashes, dashes and stray spaces are how the same
    item comes to be written two ways in two systems; they carry no meaning."""
    return _re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _unique_product_by_norm(nm):
    """The one Product whose name matches `nm` ignoring punctuation, or None.

    None when nothing matches AND when several do: an ambiguous item belongs on
    the import screen for the operator to map, not quietly bound to whichever
    row the database returned first."""
    from master.models import Product
    key = _norm_item(nm)
    if not key:
        return None
    hits = [p for p in Product.objects.filter(is_active=True).only("id", "product_name")
            if _norm_item(p.product_name) == key]
    return hits[0] if len(hits) == 1 else None


def _alter_id(v):
    """Tally's edit counter (ALTERID) for a voucher, or None. See voucher_changes."""
    try:
        return int(str(v.get("alterid") or "").strip()) or None
    except ValueError:
        return None


def _guid(v):
    return v.get("guid") or v.get("masterid") or f"{v['vtype']}|{v['number']}|{v['date']}"


def _unique_no(model, field, base, scope=None):
    """Return `base`, or base#2, base#3… so the unique code never collides.

    `scope` narrows the collision test to the rows the uniqueness rule actually
    covers — for an invoice number that is the company, because the number is
    the SELLER's own series. Without it, United Agro's G-545/26-27 blocked SS
    Biochem's G-545/26-27 and 438 SS invoices were stored with a "#2" that
    appears on no document. See SalesInvoiceCheck.invoice_no.
    """
    val = base
    i = 1
    while model.objects.filter(**{field: val}, **(scope or {})).exists():
        i += 1
        val = f"{base}#{i}"
    return val


def _sales_figures(v, ctx):
    """The money on a sales voucher, exactly as the importer books it.

    ONE copy, shared by a first import (_import_sales) and by an Update from
    the "Changed in Tally" tab (voucher_changes), so an updated invoice can
    never be computed differently from a freshly imported one."""
    party, taxable, cgst, sgst, igst, tds, roff = _split_ledgers(v, with_round=True)
    grand = abs(party) or (taxable + cgst + sgst + igst - tds + roff)
    # Recover the real taxable (sale) value when _split_ledgers can't get it from
    # the ledgers. Two cases both produced a wrong, tiny taxable that broke the
    # invoice (subtotal=0/near-0 -> a huge tax/taxable GST-rate -> DecimalField
    # overflow -> the whole invoice fails to post, and a later receipt fabricates
    # an OPENING placeholder — this is what silently dropped export + item sales):
    #   • ITEM invoices book the sale on the STOCK lines, not a "Sales" ledger, so
    #     _split_ledgers (which sums non-party, non-tax LEDGERS) catches only the
    #     round-off -> use the inventory total.
    #   • EXPORT / zero-rated invoices carry ONLY the party ledger (no tax) -> the
    #     party debit IS the sale value.
    inv_total = sum((it.get("amount") or Decimal("0")) for it in (v.get("inventory") or []))
    charges = _charge_amount(v, ctx)
    if inv_total > taxable:
        # The inventory total covers STOCK lines only — a freight/testing ledger
        # on the same voucher is not in it. Dropping those charges here left
        # subtotal short by exactly `charges`, and the round_off plug below then
        # swallowed them: SS Biochem June-2026 had three invoices (S-42, S-60,
        # S-61) whose round_off equalled other_charges to the paisa. Worse, the
        # dashboard computes Ex-GST as subtotal - other_charges, so it went on to
        # subtract charges that were never in subtotal. Keep subtotal the FULL
        # value, exactly as the ledger path already produces it.
        taxable = inv_total + charges
    elif taxable <= 0 and (cgst + sgst + igst) == 0 and grand > 0:
        taxable = grand
    elif taxable <= 0 and grand > 0:
        #   • ITEM invoices WITH GST whose stock lines didn't come through
        #     either (neither a Sales ledger nor a usable inventory total) fell
        #     through both branches above and kept taxable = 0. The whole sale
        #     value then landed in `round_off` via the expression below, because
        #     round_off is a PLUG: grand - (taxable + gst - tds). That is what
        #     put Rs 10.9 Cr of SS Biochem FY26-27 sales into "Round-off" across
        #     192 of 762 invoices and left the Ex-GST tile short by the same.
        #     Invert the identity instead — grand = taxable + gst - tds, so:
        taxable = grand - (cgst + sgst + igst) + tds
    return {"party": party, "taxable": taxable, "cgst": cgst, "sgst": sgst,
            "igst": igst, "tds": tds, "roff": roff, "charges": charges,
            "grand": grand}


def _write_sales_lines(inv, v, taxable, cgst, sgst, igst, ctx):
    """Write an invoice's item lines from its Tally voucher. Returns True when
    any line lacks an HSN. Shared by a first import and by an Update from the
    "Changed in Tally" tab, which deletes the old lines and calls this again."""
    from .models import SalesInvoiceLine
    lines = v["inventory"] or [{"item": "", "qty": Decimal("1"), "uom": "",
                                "rate": taxable, "amount": taxable}]
    inter = igst > 0                       # inter-state => IGST, else CGST+SGST
    eff_rate = _effective_gst_rate(taxable, cgst + sgst + igst)
    blank_hsn = False
    for i, it in enumerate(lines, 1):
        prod = _get_or_create_product(it["item"], it["uom"], ctx) if it["item"] else None
        amt = it["amount"] or taxable
        hsn, gr, cr, sr, ir, ca, sa, ia = _line_gst(ctx, it["item"], amt, inter, eff_rate)
        if not hsn:
            blank_hsn = True
        SalesInvoiceLine.objects.create(
            invoice=inv, sl_no=i, product=prod, hsn_sac=hsn,
            description=(it["item"] or v["narration"] or "Sales")[:500],
            quantity=it["qty"] or Decimal("1"), uom=it["uom"][:20],
            rate=it["rate"], amount=amt, gst_rate=gr,
            cgst_rate=cr, sgst_rate=sr, igst_rate=ir,
            cgst_amount=ca, sgst_amount=sa, igst_amount=ia,
        )
    return blank_hsn


# ---------------------------------------------------------------- sales
def _import_sales(v, ctx):
    from .models import SalesInvoiceCheck, SalesInvoiceLine, ReceivableLedger
    guid = _guid(v)
    _seen = SalesInvoiceCheck.objects.filter(tally_guid=guid)
    if _seen.exists():
        # Backfill Tally's voucher type onto invoices imported BEFORE that field
        # existed, so an ordinary re-import is all the backfill this ever needs
        # -- no separate command, no second read of Tally. Turnover cannot
        # exclude a rent voucher it has no way to recognise, and every invoice
        # already in the ERP carries a blank type. Only fills blanks, so a value
        # already stamped is never overwritten.
        _vt = (v.get("vtype") or "")[:100]
        if _vt and not ctx.dry_run:
            _seen.filter(tally_voucher_type="").update(tally_voucher_type=_vt)
        ctx.summary["skipped_existing"] += 1
        return
    if not v["party"]:
        _note_no_party(ctx, v, "sales")
        return
    cust = _resolve_customer(v["party"], ctx)
    if not cust:
        ctx.summary["unmatched_customers"].add(v["party"])
        _note_skipped(ctx, v, "sales")
        return
    _f = _sales_figures(v, ctx)
    party, taxable, cgst, sgst, igst, tds, roff, charges, grand = (
        _f["party"], _f["taxable"], _f["cgst"], _f["sgst"], _f["igst"],
        _f["tds"], _f["roff"], _f["charges"], _f["grand"])
    # Track non-sales charges (freight/testing/round-off) SEPARATELY in
    # other_charges. subtotal stays the FULL value (unchanged) so push-to-Tally,
    # invoice pages and reports are untouched; ONLY the dashboard nets it out.
    # (`charges` is resolved above, before the taxable recovery that needs it.)
    date = _pdate(v["date"]) or timezone.now().date()
    if ctx.dry_run:
        # still resolve products so preview lists new ones
        for it in v["inventory"]:
            if it["item"]:
                _get_or_create_product(it["item"], it["uom"], ctx)
        ctx.summary["sales"] += 1
        return
    # Reverse-direction de-dup (mirror of the purchase side): the same invoice may
    # already be in the ERP as a NON-Tally record — manually entered, or generated
    # via Sales Order -> Dispatch -> Invoice (tally_guid == ""). Don't create a
    # Tally duplicate; instead stamp this voucher's guid onto the existing invoice
    # so re-imports skip it and receipts settle against it. Guarded by customer +
    # amount (+-1%) so a reused number on a genuinely different invoice can't merge.
    from django.db.models import Q
    tno = (v["number"] or "").strip()
    if tno:
        tol = max(Decimal("1"), (grand.copy_abs() * Decimal("0.01")))
        dup = (SalesInvoiceCheck.objects.filter(
                   customer=cust, company=ctx.company, tally_guid="",
                   grand_total__gte=grand - tol, grand_total__lte=grand + tol)
               .filter(Q(invoice_no__iexact=tno) | Q(tally_invoice_no__iexact=tno))
               .first())
        if dup:
            dup.tally_guid = guid
            dup.tally_invoice_no = tno[:50]
            dup.save(update_fields=["tally_guid", "tally_invoice_no"])
            ctx.summary["skipped_existing"] += 1
            return
    inv_no = _unique_no(SalesInvoiceCheck, "invoice_no", (v["number"] or f"TLY-{guid}")[:50],
                        scope={"company": ctx.company})
    # ── enrich: company / buyer / consignee / terms / due date / words ──
    comp = ctx.company
    c_state, c_code = _state_of(getattr(comp, "gstin", "") if comp else "")
    # Buyer GST/state/address: prefer the ERP master, fall back to the Tally
    # ledger master (so it fills even when the local customer has no GSTIN).
    b_gstin, b_state, b_code, buyer_addr = _party_details(ctx, v["party"], cust)
    # Real due date — the voucher's own bill line first, exactly as Tally ages it:
    #   * a credit period on the bill ("45 Days")  -> invoice date + that;
    #   * a bill reference but NO credit period    -> due ON the invoice date.
    #     Tally's age-wise report counts such a bill from its own date (T.Stanes
    #     T-047/26-27, 20-May, "Due on 20-May"); the old fall-through to the
    #     ledger master / 45-day default gave 386 UAI and 7 SS invoices credit
    #     Tally never gave, and put them in the wrong age bands.
    # Only a voucher with no bill line at all (a cash sale) still falls back to
    # the Bills-Outstanding report, then the ledger master / terms.
    # Did the ERP's own credit terms decide this due date? If so it must be
    # re-derivable later; a Tally-given date must not. Only the dated-terms
    # branch below sets it.
    _due_from_terms = False
    bd, bdays = _bill_due(v, date)
    if bd:
        due, terms = bd, f"{bdays} Days"
    elif _bill_ref(v):
        # A bill REFERENCE but no credit period on it is Tally defaulting the
        # due date to the invoice date — not a date anyone set. Prefer the
        # customer's own dated credit terms (the business does not want this
        # wrong default copied); fall back to Tally's on-invoice default when
        # the terms are undated or CASH, so nothing changes until a customer
        # is actually configured.
        from datetime import timedelta
        from master.credit_terms import credit_days_for, terms_label
        _agreed = credit_days_for(cust, date)
        if _agreed:
            due, terms = date + timedelta(days=_agreed), terms_label(cust)[:20]
            _due_from_terms = True
        else:
            due, terms = date, "Due on invoice"
    else:
        due = (ctx.bill_due_map or {}).get((v["number"] or "").strip())
        if due:
            terms = "Tally"
        else:
            due, terms = _due_from_ledger(ctx, v["party"], cust, date, kind="customer")
    terms = terms[:20]
    inv = SalesInvoiceCheck.objects.create(
        invoice_no=inv_no, tally_guid=guid, tally_invoice_no=v["number"][:50],
        tally_bill_ref=_bill_ref(v),
        # Tally's own voucher type, kept so the dashboard can tell a rent
        # voucher from a sale without re-reading Tally. See
        # is_non_sales_income_vtype().
        tally_voucher_type=(v.get("vtype") or "")[:100],
        tally_alter_id=_alter_id(v),
        invoice_date=date, customer=cust, company=comp, status="CONFIRMED",
        due_from_credit_terms=_due_from_terms,
        company_gstin=(getattr(comp, "gstin", "") or "")[:20],
        company_pan=(getattr(comp, "pan", "") or "")[:20],
        company_state=c_state[:100], company_state_code=c_code,
        buyer_name=(cust.customer_name or "")[:255], buyer_address=buyer_addr,
        buyer_gstin=b_gstin[:20], buyer_state=b_state[:100], buyer_state_code=b_code,
        consignee_name=(cust.customer_name or "")[:255], consignee_address=buyer_addr,
        consignee_gstin=b_gstin[:500], consignee_state=b_state[:100],
        consignee_state_code=b_code, payment_terms=terms, due_date=due,
        subtotal=taxable, cgst_total=cgst, sgst_total=sgst, igst_total=igst,
        tds_total=tds, other_charges=charges, grand_total=grand,
        # Tally's OWN Round Off, signed — not a residual plug. If the voucher
        # doesn't balance the difference is reported (see `unbalanced` below)
        # instead of being silently absorbed here, which is what let a wrong
        # subtotal look correct on the invoice.
        round_off=roff,
        amount_in_words=_amount_words(grand),
        remarks=(v["narration"] or "")[:1000], created_by=ctx.created_by,
    )
    blank_hsn = _write_sales_lines(inv, v, taxable, cgst, sgst, igst, ctx)
    ReceivableLedger.objects.create(
        customer=cust, invoice_reference=inv, invoice_date=date, due_date=due,
        amount=grand, amount_paid=0, balance=grand, payment_status="NOT_DUE",
        created_by=ctx.created_by,
    )
    # ── No Sales Order / Dispatch Challan is reconstructed ────────────────
    # The import used to invent an SO + DC per invoice so those pages would
    # populate. They are fabrications: Tally has no such documents behind a
    # sales voucher, and inventing them caused more harm than the empty pages
    # they filled.
    #   * 762 challans were written per import, all stamped with the import
    #     timestamp (DispatchChallan.dispatch_date is auto_now_add, which throws
    #     away the date passed to it), so the DC page showed a whole year of
    #     dispatches happening this morning.
    #   * `revert_tally` filters DCs on dispatch_date within the period, so it
    #     could not find them, the chain survived every revert, and the orphaned
    #     DCLines then PROTECTed the SOLines — 50 sales orders were undeletable.
    # A DC is a real warehouse document. It should be raised when goods actually
    # move, not manufactured from an invoice after the fact.
    ctx.summary["sales"] += 1
    # ── Mirror check (reports only, never blocks) ─────────────────────────
    tally_val = abs(party)
    m = ctx.summary["mirror_month"].setdefault(
        date.strftime("%Y-%m"), {"tally": Decimal("0"), "erp": Decimal("0"), "n": 0})
    m["tally"] += tally_val
    m["erp"] += grand
    m["n"] += 1
    # Does the voucher balance on Tally's own terms? Any residual means a ledger
    # was read into the wrong bucket — the invoice still imports, but it is named
    # so it can be checked rather than quietly carrying a wrong subtotal.
    resid = tally_val - (taxable + cgst + sgst + igst - tds + roff)
    if abs(resid) > Decimal("0.005"):
        ctx.summary["unbalanced"].append(
            {"voucher": v["number"], "date": str(date), "party": v["party"],
             "tally": str(tally_val), "computed": str(tally_val - resid),
             "diff": str(resid)})
    if blank_hsn:
        ctx.summary["no_hsn"].append(
            {"voucher": v["number"], "date": str(date), "party": v["party"],
             "value": str(grand)})


# ---------------------------------------------------------------- purchase
def _adoptable_scanned_bill(vend, sup_no, grand):
    """A bill already in the ERP from a SCAN/email that is the SAME supplier
    invoice as this Tally voucher -> Tally ADOPTS it (stamps its guid) instead of
    creating a duplicate.

    Mirrors the shared duplicate detector's identity rules (purchase.zoho_mismatch):
      * _full_key ignores the financial-year tail  -> "266" == "266/26-27"
      * _same_firm matches by firm, not row         -> a differently-spelled /
        GSTIN-linked sibling master still counts
    Kept tight so a reused invoice number on a genuinely different bill can't be
    hijacked: only an un-stamped (tally_guid==""), active, non-cancelled bill whose
    amount is within 1% of this voucher is adopted.
    """
    from purchase.models import VendorBill
    from purchase.zoho_mismatch import _full_key, _same_firm
    inv_key = _full_key(sup_no)
    if not inv_key:
        return None
    tol = max(Decimal("1"), grand.copy_abs() * Decimal("0.01"))
    cand = (VendorBill.objects
            .filter(vendor__company=vend.company, tally_guid="", is_active=True,
                    total_amount__gte=grand - tol, total_amount__lte=grand + tol)
            .exclude(status="CANCELLED")
            .select_related("vendor"))
    return next((b for b in cand
                 if _same_firm(b.vendor, vend)
                 and (_full_key(b.vendor_invoice_no) == inv_key
                      or _full_key(b.bill_no) == inv_key)), None)


def _sync_existing_bill(bill, v, ctx=None):
    """Update an already-imported bill's financial fields from Tally so values
    stay current after Tally edits (TDS, totals, freight, voucher type)."""
    party, taxable, cgst, sgst, igst, tds = _split_ledgers(v)
    grand = abs(party) or (taxable + cgst + sgst + igst - tds)
    freight = _freight_amount(v, ctx)
    vno = (v.get("number") or "").strip()
    fields = []
    for attr, val in [("subtotal", taxable), ("tax_amount", cgst + sgst + igst),
                      ("tds_amount", tds), ("total_amount", grand),
                      ("other_charges", freight),
                      ("computed_tds_amount", tds)]:
        if getattr(bill, attr) != val:
            setattr(bill, attr, val)
            fields.append(attr)
    if not bill.tally_voucher_no and vno:
        bill.tally_voucher_no = vno[:100]
        fields.append("tally_voucher_no")
    vtype = (v.get("vtype") or "")[:100]
    if vtype and bill.tally_voucher_type != vtype:
        bill.tally_voucher_type = vtype
        fields.append("tally_voucher_type")
    if fields:
        bill.save(update_fields=fields)
    if "total_amount" in fields and bill.amount_paid > bill.total_amount > 0:
        bill.amount_paid = bill.total_amount
        bill.status = "PAID"
        bill.save(update_fields=["amount_paid", "status"])


def _create_inbill_freight_advice(bill, tally_guid, freight_amount):
    """Create a FreightAdviceInbound for freight charges inside a purchase bill.
    These use freight_source=INVOICE_INCLUDED — paid/pending follows the bill."""
    from purchase.models import FreightAdviceInbound
    fa_guid = f"FRT|{tally_guid}"[:64] if tally_guid else ""
    if fa_guid and FreightAdviceInbound.objects.filter(tally_guid=fa_guid).exists():
        return
    fa = FreightAdviceInbound(
        vendor_bill=bill,
        source_type='VENDOR_BILL',
        freight_source='INVOICE_INCLUDED',
        freight_type='LINEHAUL',
        transporter=None,
        base_amount=freight_amount,
        payable_amount=freight_amount,
        balance=freight_amount if bill.amount_paid < bill.total_amount else Decimal("0"),
        total_paid=Decimal("0"),
        freight_date=bill.bill_date,
        tally_guid=fa_guid,
        remarks=f"In-bill freight on {bill.bill_no or bill.vendor_invoice_no}",
        status='COMPLETED' if bill.amount_paid >= bill.total_amount else 'APPROVED',
    )
    fa.save()


def _backfill_inbill_freight_fas(company, ctx):
    """Create INVOICE_INCLUDED FAs for purchase bills that have freight charges
    but no corresponding FA yet.  Normally created during purchase scope import
    (_import_purchase), but a freight-only import after a freight revert needs
    to recreate them from the stored other_charges on existing bills."""
    from purchase.models import VendorBill, FreightAdviceInbound
    bills = (VendorBill.objects
             .filter(vendor__company=company, is_active=True, other_charges__gt=0)
             .exclude(purchase_category="FREIGHT"))
    created = 0
    for bill in bills:
        guid = bill.tally_guid
        if not guid:
            continue
        fa_guid = f"FRT|{guid}"[:64]
        if FreightAdviceInbound.objects.filter(tally_guid=fa_guid).exists():
            continue
        try:
            _create_inbill_freight_advice(bill, guid, bill.other_charges)
            created += 1
        except Exception:  # noqa: BLE001
            pass
    ctx.summary["inbill_freight_backfilled"] = created


def _sync_freight_fa_from_bills(company, ctx):
    """After payments settle FREIGHT VendorBills, sync FA paid status.

    The Tally payment import creates PaymentMade records on the VendorBill,
    not FreightPaymentInbound records on the FA.  So the FA's stored
    total_paid / balance / status stay at their creation-time values (0 / full
    / APPROVED) even after the bill is fully paid.  This step corrects them.

    Bill status is authoritative: a PAID bill means the transporter is fully
    settled.  The bill's net (after TDS) differs from the FA's gross
    base_amount, so comparing amounts would leave TDS-bearing freight stuck
    on 'partially paid'."""
    from purchase.models import FreightAdviceInbound
    fas = (FreightAdviceInbound.objects
           .filter(freight_source='SEPARATE_SLIP',
                   vendor_bill__isnull=False,
                   vendor_bill__purchase_category='FREIGHT')
           .select_related('vendor_bill'))
    if company:
        fas = fas.filter(vendor_bill__vendor__company=company)
    synced = 0
    for fa in fas:
        bill = fa.vendor_bill
        payable = fa.get_total_payable()
        if bill.status == 'PAID':
            new_status = 'COMPLETED'
            paid = payable
            new_balance = Decimal('0')
        elif bill.status == 'PARTIALLY_PAID' or (bill.amount_paid or 0) > 0:
            new_status = 'APPROVED'
            paid = bill.amount_paid or Decimal('0')
            new_balance = max(Decimal('0'), payable - paid)
        else:
            continue
        if fa.total_paid != paid or fa.balance != new_balance or fa.status != new_status:
            fa.total_paid = paid
            fa.balance = new_balance
            fa.status = new_status
            fa.save(update_fields=['total_paid', 'balance', 'status'])
            synced += 1
    ctx.summary["freight_fa_payment_synced"] = synced


def _auto_create_freight_vendor(party_name, ctx):
    """Auto-create a Vendor for a freight transporter when _resolve_vendor
    finds no match.  Uses the Tally ledger master for GSTIN/state."""
    from master.models import Vendor
    if not ctx.company or not party_name:
        return None
    led = (ctx.ledger_master or {}).get(party_name) or {}
    gst = (led.get("gstin") or "").strip()
    if gst and not _valid_gstin(gst):
        gst = ""
    if gst:
        existing = Vendor.objects.filter(
            company=ctx.company, gstin__iexact=gst, is_active=True).first()
        if existing:
            return existing
    vd = Vendor(
        vendor_name=party_name[:200],
        company=ctx.company,
        gstin=(gst[:15] or None),
        vendor_type=["TRANSPORT"],
        payment_terms="NET_30",
        state=(led.get("state") or "")[:100],
        created_by=ctx.created_by,
    )
    vd.vendor_code = vd._generate_vendor_code()
    vd.save()
    ctx.summary["auto_created_vendors"] = ctx.summary.get("auto_created_vendors", 0) + 1
    return vd


def _import_purchase(v, ctx):
    from purchase.models import VendorBill, VendorBillLine
    guid = _guid(v)
    existing_by_guid = VendorBill.objects.filter(tally_guid=guid).first()
    if existing_by_guid:
        _sync_existing_bill(existing_by_guid, v, ctx)
        # Backfill: bill was imported before in-bill freight FA existed.
        freight = _freight_amount(v, ctx)
        if freight and freight > 0:
            _create_inbill_freight_advice(existing_by_guid, guid, freight)
        ctx.summary["skipped_existing"] += 1
        return
    if not v["party"]:
        _note_no_party(ctx, v, "purchase")
        return
    vend = _resolve_vendor(v["party"], ctx)
    if not vend:
        ctx.summary["unmatched_vendors"].add(v["party"])
        return
    party, taxable, cgst, sgst, igst, tds = _split_ledgers(v)
    grand = abs(party) or (taxable + cgst + sgst + igst - tds)
    # Track Freight Inward SEPARATELY in other_charges; subtotal stays FULL so
    # nothing outside the purchase dashboard is affected.
    freight = _freight_amount(v, ctx)
    date = _pdate(v["date"]) or timezone.now().date()
    if ctx.dry_run:
        for it in v["inventory"]:
            if it["item"]:
                _get_or_create_product(it["item"], it["uom"], ctx)
        ctx.summary["purchase"] += 1
        return
    due = (ctx.bill_due_map or {}).get((v["number"] or "").strip())
    if not due:
        bd, _bdays = _bill_due(v, date)
        due = bd or _due_from_ledger(ctx, v["party"], vend, date, kind="vendor")[0]
    # vendor_invoice_no = the SUPPLIER's bill number (so a scanned copy of the
    # same invoice matches it) — NOT Tally's voucher number. Keep the voucher
    # number in notes for traceability.
    sup_no = _supplier_invoice_no(v)
    vno = (v["number"] or "").strip()
    note = (v["narration"] or "").strip()
    if vno and vno != sup_no:
        note = (note + f"\nTally voucher: {vno}").strip()
    # Reverse-direction de-dup: the same supplier invoice may already be in the
    # ERP from a SCAN (scanned first, imported from Tally second). Don't create a
    # Tally duplicate — stamp this voucher's guid onto the existing bill so
    # re-imports skip it and the payment import settles against it. Guarded by an
    # amount check so a reused invoice number on a different bill can't collide.
    if sup_no:
        existing = _adoptable_scanned_bill(vend, sup_no, grand)
        if existing:
            existing.tally_guid = guid
            existing.bill_date = date
            existing.save(update_fields=["tally_guid", "bill_date"])
            _sync_existing_bill(existing, v, ctx)
            ctx.summary["skipped_existing"] += 1
            return
    bill = VendorBill(
        vendor=vend, vendor_invoice_no=(sup_no or "")[:100], tally_guid=guid,
        tally_voucher_no=(vno or "")[:100],
        tally_voucher_type=(v.get("vtype") or "")[:100],
        bill_date=date, due_date=due,
        status="OPEN", subtotal=taxable, other_charges=freight,
        # TDS withheld on this purchase (194Q, "TDS on Purchase - 0.1%").
        # RECORDED ONLY — deliberately not applied to total_amount: Tally's
        # party amount is already net of it (verified on real vouchers:
        # party = taxable + GST - TDS + round-off), so `grand` carries the
        # deduction. Subtracting it again here would understate every bill
        # that had TDS by exactly the TDS.
        tds_amount=tds,
        tax_amount=cgst + sgst + igst, total_amount=grand, amount_paid=0,
        notes=note[:1000], created_by=ctx.created_by,
    )
    bill.save()
    lines = v["inventory"] or [{"item": "", "qty": Decimal("1"), "uom": "",
                                "rate": taxable, "amount": taxable}]
    inter = igst > 0
    eff_rate = _effective_gst_rate(taxable, cgst + sgst + igst)
    for it in lines:
        prod = _get_or_create_product(it["item"], it["uom"], ctx) if it["item"] else None
        amt = it["amount"] or taxable
        _hsn, gr, *_ = _line_gst(ctx, it["item"], amt, inter, eff_rate)
        VendorBillLine.objects.create(
            bill=bill, product=prod,
            description=(it.get("user_desc") or it["item"] or v["narration"] or "Purchase")[:2000],
            quantity=it["qty"] or Decimal("1"), uom=it["uom"][:10],
            rate=it["rate"], amount=amt, tax_percent=gr,
        )
    # Full document chain (Purchase Order + GRN) linked to this bill.
    _build_purchase_chain(v, bill, vend, lines, ctx)
    # In-bill freight: if the purchase has a Freight Inward Charges ledger line,
    # create a FreightAdviceInbound so it shows on the Inward Freight page too.
    if freight and freight > 0:
        _create_inbill_freight_advice(bill, guid, freight)
    ctx.summary["purchase"] += 1


# ----------------------------- bill-reference helpers (Tally bill-wise detail)
def _party_bills(v):
    """Bill allocations on the party ledger — Tally's reference / against-ref /
    on-account list saying which bill each part of the amount settles."""
    pname = (v.get("party") or "").strip()
    for lg in v["ledgers"]:
        if lg.get("is_party") or (pname and lg["ledger"].strip() == pname):
            return lg.get("bills", [])
    return []


def _receipt_bill_lines(v, ctx):
    """{customer_id: [bill lines]} for the party legs of a receipt that DEBIT
    the party against a reference as well as crediting it -- see
    ReceivablePayment.tally_bills. Empty for an ordinary receipt."""
    out = {}
    for lg in v.get("ledgers", []):
        bills = lg.get("bills") or []
        if not any((b.get("amount") or 0) < 0 and (b.get("name") or "").strip()
                   for b in bills):
            continue
        cust = _resolve_customer(lg.get("ledger") or "", ctx)
        if not cust:
            continue
        lines = _bills_json(bills)
        for line, b in zip(lines, [b for b in bills if (b.get("name") or "").strip()
                                    or (b.get("type") or "").strip()]):
            line["dr"] = (b.get("amount") or 0) < 0
        out[cust.id] = lines
    return out


def _store_receipt_lines(v, ctx, guid):
    """Write _receipt_bill_lines onto the receipt's payment rows that have
    none yet. Moves no money."""
    from .models import ReceivablePayment
    if ctx.dry_run:
        return
    for cid, lines in _receipt_bill_lines(v, ctx).items():
        ReceivablePayment.objects.filter(
            tally_guid=guid, receivable__customer_id=cid, tally_bills=[]
        ).update(tally_bills=lines)


def _stamp_receipt(v, ctx, guid):
    """Record the receipt's ALTERID on the rows it produced (payments and the
    parked / on-account row) -- the baseline "Changed in Tally" compares with."""
    from .models import ReceivableAdjustment, ReceivablePayment
    alter = _alter_id(v)
    if ctx.dry_run or not alter:
        return
    ReceivablePayment.objects.filter(
        tally_guid=guid, receivable__invoice_reference__company=ctx.company,
        tally_alter_id__isnull=True).update(tally_alter_id=alter)
    ReceivableAdjustment.objects.filter(
        company=ctx.company, tally_guid__in=[guid[:64], f"PRIOR|{guid}"[:64]],
        tally_alter_id__isnull=True).update(tally_alter_id=alter)


def _receipt_lines_json(bills):
    """_bills_json for a RECEIPT's lines, keeping each line's side: a negative
    amount on the party leg is a DEBIT (Bliss receipt 244 debits ref "88" to
    cancel receipt 88's advance). The age bands read "dr" when switched on."""
    kept = [b for b in bills or []
            if (b.get("name") or "").strip() or (b.get("type") or "").strip()]
    lines = _bills_json(kept)
    for line, b in zip(lines, kept):
        line["dr"] = Decimal(str(b.get("amount") or 0)) < 0
    return lines


def _bills_json(bills):
    """Tally bill allocations as stored on DebitNote / ReceivableAdjustment
    `tally_bills`: plain strings, amount unsigned (the document's own direction
    says which way it moves)."""
    out = []
    for b in bills or []:
        name, typ = (b.get("name") or "").strip(), (b.get("type") or "").strip()
        if not name and not typ:
            continue
        out.append({"name": name[:100], "type": typ[:30],
                    "amount": str(abs(Decimal(str(b.get("amount") or 0)))),
                    "credit_period": (b.get("credit_period") or "")[:30]})
    return out


def _supplier_invoice_no(v):
    """The SUPPLIER's invoice number on a Tally purchase voucher — the number
    printed on the physical bill, which the scan reads too. This is the key a
    scanned bill is matched on, so we must NOT use Tally's own voucher number.

    Prefer the voucher 'Ref' field, then the bill-wise 'New Ref' name (Tally's
    bill-wise tracking is keyed on the supplier's bill no), and only fall back
    to the Tally voucher number when neither is present.
    """
    ref = (v.get("reference") or "").strip()
    if ref:
        return ref
    bills = _party_bills(v)
    for b in bills:                       # a 'New Ref' = the bill this voucher creates
        if "new" in (b.get("type") or "").lower() and (b.get("name") or "").strip():
            return b["name"].strip()
    for b in bills:                       # any bill-wise name, else the voucher number
        if (b.get("name") or "").strip():
            return b["name"].strip()
    return (v.get("number") or "").strip()


def _against_refs(v):
    """[(bill_ref, amount)] this voucher settles via 'Against Reference'."""
    out = []
    for b in _party_bills(v):
        t = (b.get("type") or "").lower()
        if "agst" in t or "against" in t:
            out.append((b.get("name") or "", abs(b.get("amount") or Decimal("0"))))
    return out


def resync_receivable(rl):
    """Restate a bill's paid / balance / status FROM its own payment rows.

    Adjusting `amount_paid` by arithmetic ("paid minus this payment") looks
    equivalent and is not: it carries forward whatever drift is already there.
    Ranghas Agro's UAI/239 read Rs 59,693 paid while holding only Rs 36,068 of
    payments — Rs 23,625 with no row behind it — so a receipt re-applied against
    it could only fit part of itself into what looked like the remaining balance.
    Reading the rows is self-healing: whatever the field said before, it now says
    what the payments actually add up to. Every path that adds or removes a
    payment must finish here."""
    from django.db.models import Sum
    from .models import ReceivablePayment
    paid = (ReceivablePayment.objects.filter(receivable=rl, is_active=True)
            .aggregate(t=Sum("amount"))["t"] or Decimal("0"))
    rl.amount_paid = paid
    rl.balance = Decimal(str(rl.amount or 0)) - paid
    rl.payment_status = ("PAID" if rl.balance <= 0
                         else ("PARTIALLY_PAID" if paid > 0 else "NOT_DUE"))
    rl.save(update_fields=["amount_paid", "balance", "payment_status"])


def find_receivables_by_ref(cust, ref, on_or_before=None):
    """EVERY open bill of this customer answering to `ref`, oldest first.

    Usually one. But the same bill reference can be typed onto two vouchers, and
    then TALLY TREATS THEM AS ONE BILL: Bliss Corp's invoices UAI/131 and UAI/136
    both carry the reference "UAI/131/26-27", and Tally's receipt 87 settles it as
    a single Rs 27,20,582 — exactly the two added together. Answering with one
    invoice left the other open and pushed the same money out to credit, so a
    customer who had paid in full showed unapplied cash. Two such collisions exist
    in United Agro; both are Tally-side, and spreading is what Tally itself does."""
    from .models import ReceivableLedger
    out, seen = [], set()
    rl0 = _find_receivable_by_ref(cust, ref, on_or_before=on_or_before)
    if rl0:
        out.append(rl0)
        seen.add(rl0.id)
    if cust and ref:
        for rl in (ReceivableLedger.objects
                   .filter(is_active=True, customer=cust,
                           invoice_reference__tally_bill_ref__iexact=ref)
                   .exclude(payment_status="PAID")
                   .order_by("invoice_reference__invoice_date")):
            if rl.id not in seen:
                out.append(rl)
                seen.add(rl.id)
    return out


# The two narrations `unapplied_reason` writes that NAME a bill. Rows parked
# before `pending_refs` existed carry their references only in this prose, so
# these patterns are the only way to recover them — without the backfill the
# re-application pass would help future imports and leave every already-parked
# receipt stranded for ever, which is most of the problem.
_RE_PARKED_NEW = re.compile(
    r"opened a new bill reference on this receipt \(([^)]*)\)", re.I)
_RE_PARKED_AGST = re.compile(
    r"settles bill (.+?), which the ERP does not hold", re.I | re.S)


def _refs_from_narration(text):
    """Bill references named in a parked receipt's narration, or []."""
    m = _RE_PARKED_NEW.search(text or "") or _RE_PARKED_AGST.search(text or "")
    if not m:
        return []
    return [x.strip() for x in m.group(1).split(",") if x.strip()]


def backfill_pending_refs(company, dry_run=False):
    """Recover `pending_refs` for receipts parked before the field existed.

    Only fills rows that have none; never overwrites a value the importer wrote.
    A narration that names no bill (a true on-account advance, or an overpayment
    beyond the bills it named) is left empty — correctly, since there is nothing
    for it to wait for.
    """
    from .models import ReceivableAdjustment
    out = {"scanned": 0, "filled": 0, "refs": 0}
    qs = (ReceivableAdjustment.objects
          .filter(company=company, is_active=True, direction="CREDIT",
                  is_receipt=True, pending_refs="")
          .select_related("customer"))
    for adj in qs:
        out["scanned"] += 1
        refs = _refs_from_narration(adj.narration)
        if not refs:
            continue
        out["filled"] += 1
        out["refs"] += len(refs)
        if not dry_run:
            adj.pending_refs = "\n".join(refs)
            adj.save(update_fields=["pending_refs", "updated_at"])
    return out


def reapply_parked_receipts(company, created_by=None, dry_run=False):
    """Turn parked advance receipts into real payments once their bills exist.

    THE BUG THIS EXISTS FOR. The receipt handler settles the bills a leg NAMES.
    A customer who pays before the invoice is raised names bills that are not in
    the ERP yet, so the leg falls through to a credit adjustment carrying the
    references it could not resolve. Within one import run that is fine —
    invoices are imported in the pass before receipts — but ACROSS runs nothing
    ever went back. Bliss Corp paid Rs 1,10,00,000 on 21-May and Rs 1,90,00,000
    on 26-May against invoices first raised on 8-Jun: the June import created
    UAI/130 and friends and never returned for May's money, leaving 23 invoices
    reading unpaid while Rs 3,42,96,174 of their own cash sat in adjustments.
    Outstanding then had to be corrected by hand, which produced a right total
    over 23 invoices marked PAID with amount_paid = 0.00.

    This closes the loop. It runs after every import and re-resolves every
    pending reference; whatever now exists is settled properly, as a
    ReceivablePayment against the bill, with the Tally voucher number and guid
    intact. Money that still has nowhere to go stays parked with its remaining
    references, ready for the next run.

    Nothing moves in total: the adjustment is reduced by exactly what became a
    payment, so Receipts and Received are unchanged (both lines already counted
    it as cash). Only Outstanding moves, and only towards the truth — the bill
    it was always meant to pay finally shows as paid.
    """
    from .models import ReceivableAdjustment, ReceivablePayment
    out = {"scanned": 0, "touched": 0, "cleared": 0,
           "amount": Decimal("0"), "rows": [], "still_waiting": 0}
    qs = (ReceivableAdjustment.objects
          .filter(company=company, is_active=True, direction="CREDIT",
                  is_receipt=True)
          .exclude(pending_refs="")
          .select_related("customer")
          .order_by("date", "created_at"))
    for adj in qs:
        out["scanned"] += 1
        refs = [r.strip() for r in (adj.pending_refs or "").splitlines() if r.strip()]
        m = re.search(r"Tally receipt (\S+)", adj.narration or "")
        vno = m.group(1) if m else ""
        guid = (adj.tally_guid or "").split("|")[-1]
        left, applied_here, still = adj.amount, Decimal("0"), []
        for ref in refs:
            hits = find_receivables_by_ref(adj.customer, ref, on_or_before=adj.date)
            if not hits:
                # The invoice still is not here. Keep waiting — do NOT fall back
                # to paying the oldest open bill instead: FIFO-ing a named
                # reference onto a bill Tally never touched is what made
                # T.Stanes swing 61L one month and 1.65Cr the next.
                still.append(ref)
                continue
            for rl in hits:
                if left <= 0:
                    break
                cap = rl.balance if (rl.balance and rl.balance > 0) else Decimal("0")
                pay = min(left, cap)
                if pay <= 0:
                    continue
                if not dry_run:
                    ReceivablePayment.objects.create(
                        receivable=rl, amount=pay, payment_date=adj.date,
                        tally_guid=guid[:64],
                        notes=("Tally receipt %s" % vno).strip(),
                        created_by=created_by)
                    # Restate from the rows, never by arithmetic — see
                    # resync_receivable.
                    resync_receivable(rl)
                left -= pay
                applied_here += pay
        if applied_here > 0:
            out["touched"] += 1
            out["amount"] += applied_here
            out["rows"].append({
                "customer": adj.customer.customer_name,
                "receipt": vno, "date": str(adj.date),
                "applied": str(applied_here), "left": str(left),
                "refs": refs, "still": still})
        if still:
            out["still_waiting"] += 1
        if dry_run:
            continue
        if left <= 0:
            # Fully converted into payments — the parked row has no job left.
            adj.delete()
            out["cleared"] += 1
        elif applied_here > 0 or still != refs:
            adj.amount = left
            adj.pending_refs = "\n".join(still)
            adj.save(update_fields=["amount", "pending_refs", "updated_at"])
    return out


def unapplied_reason(receipt_no, settled_prior, unmatched, kinds, named_any):
    """The sentence shown against receipt money that reached no invoice.

    It used to read "not allocated to any bill in Tally" for every leftover, and
    that was usually false AND alarming: Tally HAD named the bill, the ERP simply
    held no invoice under that reference, so the page blamed Tally for its own
    gap and the reader saw money apparently lost. Each case is different and each
    one names the bill, because the number is what the reader needs."""
    if settled_prior:
        return (f"Tally receipt {receipt_no} — paid against old bill "
                f"{', '.join(settled_prior)} — more than the opening balance recorded "
                f"for this customer, so the difference is kept as their credit; "
                f"held as credit on account.")
    if unmatched and all(kinds.get(b) == "new" for b in unmatched):
        return (f"Tally receipt {receipt_no} — Tally opened a new bill reference on "
                f"this receipt ({', '.join(unmatched)}) — money received before the "
                f"invoice was raised; held as credit on account.")
    if unmatched:
        return (f"Tally receipt {receipt_no} — settles bill {', '.join(unmatched)}, "
                f"which the ERP does not hold as an invoice for this customer — kept "
                f"as their credit; held as credit on account.")
    if named_any:
        return (f"Tally receipt {receipt_no} — more than the bills it names still owe "
                f"— the rest is an overpayment; held as credit on account.")
    return (f"Tally receipt {receipt_no} — not allocated to any bill in Tally; "
            f"held as credit on account.")


def _find_receivable_by_ref(cust, ref, on_or_before=None):
    """Find the open receivable for an invoice ref. Matched by ref within the
    party's COMPANY, NOT the exact customer master: invoice_no is unique per
    company, and a receipt naming a bill settles THAT bill regardless of which
    spelling of the party the receipt was booked to. This is what lets a receipt
    on 'T.Stanes And Company Ltd - Co' settle the invoice sitting on the
    duplicate master 'T.Stanes And Company Ltd., - Coimbatore' — without it the
    named bill isn't found, the money mis-applies, and the customer's balance
    drifts from Tally's Bills Receivable. `cust=None` matches across any company
    (bank/cash-party receipts whose voucher party is a bank, not the customer)."""
    from .models import SalesInvoiceCheck, ReceivableLedger
    from django.db.models import Q
    if not ref:
        return None
    # Tally's OWN bill reference for this customer is the only exact link, and
    # it beats every other match. The reference is not the voucher number: the
    # operator types the party's bill number, and on UAI it runs one behind, so
    # receipt 244's "UAI/240/26-27" is really invoice UAI/241/26-27. Matching on
    # the number alone sent that money to Green City, who genuinely owns an
    # invoice numbered UAI/240 — while Ranghas's own bill stayed unpaid.
    inv = None
    if cust:
        inv = SalesInvoiceCheck.objects.filter(
            company=cust.company, customer=cust, tally_bill_ref__iexact=ref).first()
    invq = SalesInvoiceCheck.objects.filter(
        Q(tally_bill_ref__iexact=ref) | Q(tally_invoice_no__iexact=ref)
        | Q(invoice_no__iexact=ref))
    if cust:
        invq = invq.filter(company=cust.company)
    # THIS customer's own bill first. Falling straight to a company-wide match
    # let one party's receipt settle ANOTHER party's invoice: Ranghas Agro's
    # receipt 244 (Rs 53,288, all Ranghas in Tally) paid Rs 9,713 of Kerala
    # Cardamom's UAI/242 and Rs 13,230 of Green City's UAI/240, and receipt 230
    # paid Rs 2,756 of Nutrimax's UAI/238. Three customers wrong from two
    # vouchers, and Ranghas left short by the same money.
    if inv is None:
        inv = invq.filter(customer=cust).first() if cust else None
    if inv is None:
        other = invq.first()
        # A different master may still be the SAME party — duplicate masters are
        # why this lookup is company-wide at all (a receipt on 'T.Stanes And
        # Company Ltd - Co' settling the invoice on 'T.Stanes And Company Ltd.,
        # - Coimbatore'). Accept that only on proof: the same GSTIN, or an
        # operator mapping tying the two together. Otherwise it is someone
        # else's bill and must not be touched.
        if other is not None and cust is not None:
            same_party = False
            og = (getattr(other.customer, "gstin", "") or "").strip().upper()
            cg = (getattr(cust, "gstin", "") or "").strip().upper()
            if og and cg and og == cg:
                same_party = True
            elif other.customer_id == cust.id:
                same_party = True
            other = other if same_party else None
        inv = other
    if not inv and cust:
        # Fiscal-year drift: Tally names the bill 'S-36/25-26' on the receipt but
        # the sales voucher (and so the ERP invoice) is 'S-36/26-27' — the SAME
        # bill, the bill-wise ref just carries a stale FY tag. Retry on the base
        # number before the '/', within the company, but ONLY when exactly one
        # invoice carries it (never guess between two years). Without this, such a
        # receipt reconstructs a bogus opening and leaves the real current invoice
        # unpaid — e.g. Kriya Biosys read Rs 9.75Cr vs Tally's Rs 2.71Cr.
        #
        # GUARDED, because invoice numbers restart every year: S-1 to S-200
        # exist in 25-26 AND 26-27, usually for DIFFERENT customers. Unguarded,
        # this retry took "the only S-164 in the company" and settled it --
        # SS Biochem: Multiplex's receipt of 02-Apr-2026 (Rs 6,195), paying its
        # own prior-year bill S-164/25-26 out of the opening balance, landed on
        # Shefa's S-164/26-27 -- an invoice not raised until 19-Sep. Shefa read
        # Rs 6,195 paid that she never paid; Multiplex's opening never cleared.
        # A stale year tag only ever describes the SAME party's SAME bill, so
        # the retry now demands both:
        #   * the same customer -- or a GSTIN-proven duplicate master of it,
        #     the one exception the company-wide lookup above also allows;
        #   * an invoice dated on or before the receipt. Money cannot settle a
        #     bill that did not yet exist.
        # Anything else falls through to the prior-period branch, which draws
        # the customer's OWN opening balance down -- the right answer here.
        base = (ref.split("/")[0] or "").strip()
        if base and base != ref:
            cg = (getattr(cust, "gstin", "") or "").strip().upper()
            same = Q(customer=cust)
            if cg:
                same |= Q(customer__gstin__iexact=cg)
            cand = SalesInvoiceCheck.objects.filter(
                Q(tally_bill_ref__istartswith=base + "/")
                | Q(tally_invoice_no__istartswith=base + "/")
                | Q(invoice_no__istartswith=base + "/"),
                same, company=cust.company)
            if on_or_before:
                cand = cand.filter(invoice_date__lte=on_or_before)
            hits = list(cand[:2])
            if len(hits) == 1:
                inv = hits[0]
    if not inv:
        return None
    return (ReceivableLedger.objects.filter(invoice_reference=inv, is_active=True)
            .exclude(payment_status="PAID").first())


def _find_bill_by_ref(vend, ref):
    from purchase.models import VendorBill
    from django.db.models import Q
    if not ref:
        return None
    bill = (VendorBill.objects.filter(
        Q(vendor_invoice_no__iexact=ref) | Q(bill_no__iexact=ref) | Q(tally_voucher_no__iexact=ref),
        vendor=vend, is_active=True)
        .exclude(status__in=["PAID", "CANCELLED"]).first())
    # Freight GST-split refs: Tally creates "GST548" for the GST portion of the
    # same freight bill as "548". Strip the prefix and try the base number so a
    # payment carrying Agst Ref "GST548" settles the bill created for ref "548".
    if bill is None and ref.upper().startswith("GST") and ref[3:].isdigit():
        base = ref[3:]
        bill = (VendorBill.objects.filter(
            Q(vendor_invoice_no__iexact=base) | Q(bill_no__iexact=base) | Q(tally_voucher_no__iexact=base),
            vendor=vend, is_active=True)
            .exclude(status__in=["PAID", "CANCELLED"]).first())
    return bill


# ---------------------------------------------------------------- receipt (AR)
def _import_receipt(v, ctx):
    """A receipt credits one or more CUSTOMER ledgers — the party (party-first
    entry) OR several customer legs when Tally posts it bank-first (Dr Bank, Cr
    CustA, Cr CustB). We settle EACH customer credit leg so the money received
    reconciles to Tally's debtor Credit column, not just the party amount."""
    from .models import ReceivableLedger, ReceivablePayment, ReceivableAdjustment
    guid = _guid(v)
    # Already imported? A receipt that SETTLED a bill left a ReceivablePayment
    # keyed on the voucher guid. But a receipt that matched no bill — an
    # overpayment / on-account advance, a prior-year settlement, or a credited
    # leg — leaves NO payment: it's stored as a ReceivableAdjustment under
    # `guid`, `PRIOR|guid` or `CRED|guid` (see the branches below). The guard
    # used to check only ReceivablePayment, so those receipts were re-counted as
    # "new" on every Preview/Import — the figure never settled and the import
    # kept re-doing work (it never duplicated: the adjustments update_or_create
    # by guid). Recognising the adjustment forms too makes a re-run correctly
    # report them as already imported. `is_active` so a reverted receipt (its
    # adjustment removed) can still be re-imported.
    _adj_keys = [guid[:64], f"PRIOR|{guid}"[:64], f"CRED|{guid}"[:64]]
    if (ReceivablePayment.objects.filter(tally_guid=guid).exists()
            or ReceivableAdjustment.objects.filter(tally_guid__in=_adj_keys, is_active=True).exists()):
        _store_receipt_lines(v, ctx, guid)       # backfill; see the field
        ctx.summary["skipped_existing"] += 1
        return
    date = _pdate(v["date"]) or timezone.now().date()

    def _settle(rl, amt, refs=None):
        """Reduce a receivable's balance and log the payment. Returns applied.

        `refs` are bill numbers this money settled that the ERP does not hold as
        its own invoice — prior-year bills living inside an opening balance. They
        are stored on the payment, one per line, so the receipt page can show the
        real numbers instead of a fabricated document. See
        ReceivablePayment.prior_refs.
        """
        # ── Retire a hand-entered stand-in for this same receipt ─────────
        # With the Tally connector down, four receipts were recorded by hand:
        # Ayyappa's cash 181 and 182 (20-Aug), PM Agro's 81 (2-Jun) and Sri
        # Lakshmisaraswathi's 10 (11-Apr). Their real voucher GUIDs were not
        # reachable, so they carry a MANUAL|RCPT| key instead.
        #
        # Those four parties sit in Sundry Creditors, which is why the importer
        # had never brought their receipts in. Now that `tally_group` is stored
        # it will, and the bill is already settled — so the real receipt would
        # find a zero balance, apply nothing, and get parked as an unmatched
        # adjustment, which counts the same money a second time by another
        # route. Drop the stand-in first and let the real voucher land.
        #
        # Matched on the bill, the amount and the date. Never on the party
        # name, and never on the key alone.
        if not ctx.dry_run:
            _stand_in = ReceivablePayment.objects.filter(
                receivable=rl, payment_date=date, amount=amt,
                tally_guid__startswith="MANUAL|RCPT|")
            if _stand_in.exists():
                _stand_in.delete()
                resync_receivable(rl)
                rl.refresh_from_db()
        cap = rl.balance if (rl.balance and rl.balance > 0) else Decimal("0")
        pay = min(amt, cap)
        if pay <= 0:
            return Decimal("0")
        ReceivablePayment.objects.create(
            receivable=rl, amount=pay, payment_date=date, tally_guid=guid,
            notes=f"Tally receipt {v['number']}",
            prior_refs="\n".join(refs or []), created_by=ctx.created_by)
        # Restate from the rows rather than adding to the stored figure, so any
        # drift already on this bill is cured instead of inherited.
        resync_receivable(rl)
        return pay

    applied = False
    refused = False          # a leg was rejected as non-customer money
    unmatched = None
    _credited = {}           # customers this receipt credited, for receipt-TDS
    for lg in v["ledgers"]:
        amt = lg["amount"]
        if not amt or amt <= 0:                      # credits only (money in)
            continue
        nm = lg["ledger"]
        if _is_tax_ledger(nm):
            continue
        # Money into a LIABILITY / BANK group is not a customer paying a bill.
        # These ledgers exist as ERP customer masters (from older imports or
        # hand entry), and this loop matched them BY NAME with no regard for
        # what Tally says they are. United Agro, April 2026:
        #     ICICI Term Loan 603090078968   Rs 10,00,00,000
        #     R.Ramkumar Loan Account         Rs 2,15,00,000   Under: Unsecured Loans
        #     Sathish Karmegam                Rs 2,00,00,000
        #     Biogreen Technology Pvt Ltd-HL    Rs 75,00,000
        # Rs 14.90 CRORE of borrowing counted as customer receipts, against a
        # Sundry Debtors Credit column of Rs 5,90,91,076.00 for the whole month.
        # It also settled invoices that were never paid and left OPENING carriers
        # behind it.
        #
        # Excluded by GROUP, never by requiring one: a real customer can sit in a
        # sub-group whose name says nothing ("T.Stanes And Company Ltd - Co"), and
        # demanding "Sundry Debtors" would drop those — the same blind spot that
        # lost Rs 10.44 crore of opening balances. So only clearly non-trading
        # groups are refused, and every refusal is reported, never silent.
        _parent = _ledger_group(ctx, nm)
        # The master answered for every other party but not this one. That is
        # not a harmless gap: `_is_customer_ledger` treats an unanswerable name
        # as a customer, so this leg is about to be counted as a collection on
        # nothing more than the absence of evidence. Report it, so the import
        # screen can show which party needs its Tally ledger looked at, instead
        # of the money quietly landing on the Receipts line and turning up
        # months later as a few thousand rupees that will not reconcile.
        if ctx.ledger_master and _led(ctx, nm) is None:
            _row = ctx.summary.setdefault("receipt_party_unknown_group", {}).setdefault(
                nm.strip(), {"amount": Decimal("0"), "n": 0})
            _row["amount"] += abs(amt)
            _row["n"] += 1
        if not _is_customer_ledger(ctx, nm):
            # A trading party Tally files under Sundry Creditors still SENT us
            # money — see _is_trading_creditor. Bring it in as cash only.
            if _is_trading_creditor(ctx, nm):
                _c = _resolve_customer(nm, ctx)
                if _c is None:
                    ctx.summary.setdefault("creditor_receipts_unmatched", {}).setdefault(
                        nm.strip(), {"amount": Decimal("0"), "n": 0})
                    _u = ctx.summary["creditor_receipts_unmatched"][nm.strip()]
                    _u["amount"] += abs(amt)
                    _u["n"] += 1
                else:
                    # ── Already applied to a bill? Then leave it alone ────────
                    # This row is cash with no invoice attached, which is right
                    # while the receipt has nothing to settle. But a creditor
                    # party CAN have an open sales bill, and once the receipt is
                    # applied to it the money is on the payment — recording the
                    # cash row as well puts the same receipt on the Non-Debtors
                    # line twice.
                    #
                    # That is not hypothetical: all four receipts reconciled on
                    # 10-Sep-2026 (Ayyappa's cash 181 and 182, PM Agro's 81, Sri
                    # Lakshmisaraswathi's 10) already had a CRED| row here, so
                    # United Agro's April Non-Debtors read 2,11,104.00 for a
                    # single 1,05,552.00 receipt — exactly double.
                    #
                    # Matched on party, date and amount rather than on the guid,
                    # because the payment carries the receipt's own key and this
                    # row carries a CRED|-prefixed one. Outstanding, Receipts and
                    # Received are unaffected either way; only which line the
                    # money is drawn on changes.
                    _dup = ReceivablePayment.objects.filter(
                        receivable__customer=_c, payment_date=date,
                        amount=abs(amt), is_active=True).exists()
                    if _dup:
                        ctx.summary.setdefault("creditor_receipt_already_applied", []).append(
                            {"party": nm.strip(), "date": str(date),
                             "amount": str(abs(amt))})
                    if not ctx.dry_run and not _dup:
                        from .models import ReceivableAdjustment
                        ReceivableAdjustment.objects.update_or_create(
                            tally_guid=f"CRED|{guid}"[:64], customer=_c,
                            company=ctx.company,
                            defaults=dict(
                                adjustment_type="OTHER", direction="CREDIT",
                                date=date, amount=abs(amt), ledger_name=nm[:255],
                                counts_as_received=False, is_receipt=True,
                                # Cash, but NOT a debtor movement. Tally does not
                                # carry this party in Sundry Debtors at all, and
                                # `settle_creditor_sales` already clears whatever
                                # the ERP shows them owing. Counting it here as
                                # well subtracts the same money twice: SS Biochem
                                # sat Rs 16,33,563 BELOW Tally on exactly the
                                # CRED| net until this was set.
                                counts_in_outstanding=False,
                                narration=(
                                    f"Tally receipt {v.get('number') or ''} — "
                                    f"{nm.strip()} is filed under {_parent or 'Sundry Creditors'}, "
                                    "so Tally nets this against what we owe them and it "
                                    "never reaches the debtors credit column. Shown on "
                                    "Receipts as cash; deliberately outside the Received "
                                    "total and outside Outstanding."),
                                created_by=ctx.created_by))
                    applied = True
                _row = ctx.summary.setdefault("creditor_receipts", {}).setdefault(
                    nm.strip(), {"group": _parent, "amount": Decimal("0"), "n": 0})
                _row["amount"] += abs(amt)
                _row["n"] += 1
                continue
            _row = ctx.summary.setdefault("non_customer_receipts", {}).setdefault(
                nm.strip(), {"group": _parent, "amount": Decimal("0"), "n": 0})
            _row["amount"] += abs(amt)
            _row["n"] += 1
            refused = True
            continue
        cust = _resolve_customer(nm, ctx)
        if not cust:
            unmatched = unmatched or nm
            continue
        _credited[cust.id] = cust
        leg = abs(amt)
        if ctx.dry_run:
            applied = True
            continue
        remaining = leg
        has_against = False
        # Bill numbers Tally names that the ERP has no invoice for — prior-year
        # ones. Carried onto the payment so the number survives (prior_refs).
        _unmatched_refs = []
        # 'agst' / 'new' per bill name, so step (3) can tell a prior-period bill
        # from an advance, and the page can say which it is.
        _bill_kind = {}
        # 1) settle the bills this leg NAMES — whatever Tally calls the reference
        #
        # "Agst Ref" settles a bill that already exists; "New Ref" opens one. On a
        # RECEIPT a New Ref is money arriving before the invoice, and Tally names
        # it with the invoice number it will carry — so both kinds identify a real
        # bill and both must settle it. Matching only "Agst Ref" ignored 13 of the
        # 14 allocations on Bliss Corp's receipt 87 (26-May, Rs 1,90,00,000), left
        # Rs 97,09,042 sitting as an unexplained advance while the very invoices it
        # names went on showing as unpaid.
        #
        # Invoices are imported in the pass BEFORE receipts, so a New Ref naming a
        # later invoice resolves by the time we get here. One that still does not
        # resolve is a genuine advance and falls through to the advance branch.
        for b in lg.get("bills", []):
            if remaining <= 0:
                break
            t = (b.get("type") or "").lower()
            name = (b.get("name") or "").strip()
            # "On Account" is Tally's word for money deliberately left against no
            # bill. It carries no name and must never settle anything.
            if not name or "on account" in t:
                continue
            has_against = True
            # 'Agst Ref' settles a bill that ALREADY EXISTS — if the ERP cannot
            # find it, it is a prior-period bill inside the opening balance.
            # 'New Ref' opens a bill that does not exist yet, which is money
            # ahead of the invoice. Treating them alike folded genuine advances
            # into openings, so keep the distinction for step (3) and for the
            # sentence the page prints.
            _bill_kind[name] = "agst" if "agst" in t else "new"
            owed = min(abs(b.get("amount") or Decimal("0")), remaining)
            used = Decimal("0")
            # One reference can name more than one ERP invoice — Tally merges
            # them into a single bill, so the money spreads across them all.
            for rl in find_receivables_by_ref(cust, name, on_or_before=date):
                if owed <= 0:
                    break
                got = _settle(rl, owed)
                owed -= got
                used += got
            remaining -= used
            if used <= 0:
                _unmatched_refs.append(name)
        # 2) leftover -> FIFO oldest open receivable, but ONLY for an ON-ACCOUNT
        #    leg that names NO bill. A leg that names bills must settle exactly
        #    those; any named bill not found in the ERP is a payment against a
        #    prior-period bill (a 25-26 invoice that lives only in the opening
        #    balance) -> reconstruct it in (3). FIFO-ing that leftover onto the
        #    oldest CURRENT invoice pays a bill Tally never touched and silently
        #    mis-states every current customer balance against Tally's Bills
        #    Receivable — the exact drift that made T.Stanes swing +61L over one
        #    month to 1.65Cr under the next.
        #
        #    Only bills that already EXIST on the receipt date. Money paid on
        #    account cannot settle a bill raised afterwards -- Tally keeps it On
        #    Account until the accountant links it. SS Biochem: Nisargah's
        #    receipt 225 (22-Sep, on account 33,450) was FIFO-ed onto S-173,
        #    raised 24-Sep, so the ERP showed S-173 paid while Tally shows it
        #    owing 10,500 with 33,450 on account. What finds no such bill falls
        #    through to the on-account credit in (4).
        if remaining > 0 and not has_against:
            # REPORTED, not silent. FIFO is a guess: it is only reached when the
            # leg named no bill, and it then decides for itself which invoices
            # the money paid. When that guess is wrong the party total still
            # looks right and only the per-bill picture is wrong, which is
            # exactly the kind of error no total-level check can see.
            #
            # SS Biochem, 29-Oct-2026: Tally receipt 264 (27-Oct, Rs 24,62,460)
            # is "Agst Ref TS-130/26-27" on T.Stanes Coimbatore, but reached the
            # importer with NO bill allocation at all. It was FIFO-ed across two
            # bills of the Coimbatore - Exp master instead -- TS-172 Rs 7,41,426
            # and TS-166 Rs 17,21,034 -- so Coimbatore read Rs 24,62,460 too
            # high and Exp the same amount too low, while T.Stanes' combined
            # total matched Tally to the rupee and hid it. Why the allocation
            # was missing is still unexplained (see the notes on connector XML
            # differing from Tally), so this cannot yet be prevented -- but it
            # is now on the import summary the moment it happens.
            _fifo = []
            for rl in (ReceivableLedger.objects.filter(customer=cust, is_active=True,
                                                       invoice_date__lte=date)
                       .exclude(payment_status="PAID").order_by("invoice_date", "created_at")):
                if remaining <= 0:
                    break
                _got = _settle(rl, remaining)
                if _got:
                    _inv = rl.invoice_reference
                    _fifo.append({"bill": (_inv.invoice_no if _inv else "") or str(rl.id),
                                  "amount": str(_got)})
                remaining -= _got
            if _fifo:
                ctx.summary.setdefault("receipts_allocated_without_bill_ref", []).append(
                    {"party": (cust.customer_name or "")[:120], "date": str(date),
                     "voucher": (v.get("number") or "")[:40],
                     "applied_to": _fifo})
        # 3) still leftover on a leg that NAMED a bill -> a collection against a
        #    PRIOR-PERIOD bill (a 25-26 invoice that lives only in the opening
        #    balance, never an ERP voucher). First draw down the customer's LOADED
        #    opening balance (import_opening_balances) if one exists; only if there
        #    is none do we reconstruct a carrier so the cash is still counted.
        #
        #    Leftover on an ON-ACCOUNT leg (`not has_against`) is deliberately NOT
        #    reconstructed: a leg that names no bill and can't FIFO-settle is either
        #    a customer advance OR — the real culprit — a NON-DEBTOR leg the voucher
        #    happens to credit (a loan repayment, an inter-company transfer, a duty
        #    account). Reconstructing those invented phantom receivables and blew
        #    Tally's Credit column up by crores (e.g. "Director's Loan" Rs 1.5Cr,
        #    "United Agro Industries" Rs 1Cr, "Export Duty Drawback"). Never invent a
        #    receivable for money that was never against a bill.
        _settled_prior = []
        # Only an 'Agst Ref' the ERP could not find is a prior-period bill. A
        # 'New Ref' is an invoice not yet raised, and folding that into the
        # opening balance would spend an opening on a bill that does not exist.
        _prior = [b for b in _unmatched_refs if _bill_kind.get(b) == "agst"]
        if remaining > 0 and _prior:
            opl = (ReceivableLedger.objects.filter(
                        customer=cust, is_active=True, balance__gt=0,
                        invoice_reference__tally_invoice_no="OPENING")
                   .order_by("invoice_date", "created_at").first())
            if opl:
                used = _settle(opl, remaining, refs=_prior)
                if used > 0:
                    _settled_prior = list(_prior)
                    _unmatched_refs = [b for b in _unmatched_refs if b not in _prior]
                remaining -= used
        # Whatever is still left on a leg that NAMED a bill is held as credit —
        # whichever kind of reference it was. Only the opening-balance step above
        # is restricted to 'Agst Ref'; gating this one the same way DROPPED the
        # money entirely, because step (4) below only takes on-account legs.
        # Bliss Corp's receipt 88 names a 'New Ref' called "88": Rs 15,91,340
        # vanished from Amount Received, and the company came up short by exactly
        # that. Cash Tally received must always land somewhere.
        # Whatever a PREVIOUS run parked for this voucher+customer is about to be
        # recomputed, so clear it first. Without this the two branches below used
        # get_or_create, which writes once and never revisits: a first import
        # that found no invoices held the whole receipt as a credit, and when a
        # later run DID settle it against invoices the stale credit stayed put
        # and the cash counted twice. United Agro's receipt 5 was exactly that —
        # Rs 4,70,73,869 as a payment AND as PRIOR| adjustments, which was the
        # entire gap between the ERP's Amount Received and Tally's.
        # Only this voucher's own rows go: `PRIOR|<guid>` and the bare `<guid>`
        # are the two the receipt importer writes. Reconciliation adjustments
        # (SSGAP|, SSPADJ|, SSCONTRA|…) and journal-voucher rows (ADJ|) are
        # someone else's and are left alone.
        from .models import ReceivableAdjustment
        ReceivableAdjustment.objects.filter(
            customer=cust, company=ctx.company,
            tally_guid__in=[f"PRIOR|{guid}"[:64], guid[:64]]).delete()
        # ── One voucher, one row, whichever path reached it ────────────────
        #
        # The creditor path may already have written a `CRED|<guid>` row for
        # this very voucher. The cleanup above clears `PRIOR|<guid>` and the
        # bare `<guid>` but not `CRED|<guid>` — a different prefix, so dedup on
        # tally_guid never saw them as one voucher, and the money landed TWICE.
        #
        # Agripro International's receipt 24 (25-Apr-2026, Rs 18,000) was
        # exactly that: a CRED| row from one run and a PRIOR| row from another,
        # both carrying voucher ...-00015f20, both counted as cash. Half of the
        # Rs 28,382 by which SS Biochem's Receipts exceeded Tally.
        #
        # The CRED| row wins: it knows the party sits outside Sundry Debtors and
        # that Tally nets the money against what we owe them, which is why it
        # carries counts_in_outstanding=False. The PRIOR| row would call the
        # same money a plain advance on account.
        #
        # A flag rather than `continue`: this runs inside the per-ledger loop of
        # _import_receipt, and skipping the iteration would drop work further
        # down that has nothing to do with parking.
        _cred_has_it = ReceivableAdjustment.objects.filter(
            customer=cust, company=ctx.company,
            tally_guid=f"CRED|{guid}"[:64], is_active=True).exists()
        if remaining > 0 and has_against and not _cred_has_it:
            # NO invented invoice. The bills this leg names are real, but they
            # are PRIOR-YEAR ones the ERP holds only inside an opening balance
            # — and that balance is already spent. Fabricating a receivable per
            # receipt ("OPEN-RCPT-<customer>", created and instantly marked
            # paid) put 44 documents worth Rs 12,32,19,373.45 into United Agro
            # that nobody ever raised.
            #
            # The money is real, so it is held as a credit on the customer with
            # the bill numbers recorded — the number is what the reader needs;
            # the document is not ours to invent.
            ReceivableAdjustment.objects.update_or_create(
                tally_guid=f"PRIOR|{guid}"[:64], customer=cust, company=ctx.company,
                defaults=dict(
                    adjustment_type="OTHER", direction="CREDIT", date=date,
                    amount=remaining, ledger_name="Advance / overpayment",
                    # This IS cash — say so, or it reads as a journal.
                    #
                    # `is_receipt` decides which LINE of Amount Received the money
                    # appears on, and the parking branches never set it. So a
                    # receipt that settled a prior-year bill, or exceeded every
                    # bill the customer has, showed up under "Journal / Contra".
                    # SS Biochem April 2026: Tally's Sundry-Debtors receipts came
                    # to Rs 13,88,74,304.47 while the Receipts line read
                    # Rs 13,28,89,822.47 — short by exactly the Rs 60,02,482 in
                    # three parked vouchers (27 at 30,00,000, 26 at 29,86,471,
                    # 5 at 16,011). The TOTAL was right the whole time; only the
                    # split between the two lines was wrong.
                    is_receipt=True,
                    # What this money was waiting for. Re-tried after every
                    # import by reapply_parked_receipts() — see the field.
                    pending_refs="\n".join(_unmatched_refs),
                    # The bills this money was meant for (the ones no ERP invoice
                    # took), so the age bands place it where Tally did.
                    tally_bills=_receipt_lines_json(
                        [b for b in lg.get("bills", [])
                         if (b.get("name") or "").strip()
                         in set(_settled_prior) | set(_unmatched_refs)]),
                    narration=unapplied_reason(
                        v["number"], _settled_prior, _unmatched_refs,
                        _bill_kind, has_against),
                    created_by=ctx.created_by),
            )
            ctx.summary["prior_year_refs"] = ctx.summary.get("prior_year_refs", 0) + 1
            remaining = Decimal("0")
        # 4) Leftover on an ON-ACCOUNT leg is an ADVANCE — the customer has paid
        #    more than they owe. Tally carries exactly that as a credit balance
        #    in Sundry Debtors, and the ERP had nowhere to put it, so the money
        #    was silently dropped: United Agro April 2026, Kaliamman received
        #    Rs 1,17,200 against no invoice at all and Tally closes them at
        #    1,17,200 Cr, while the ERP showed nothing. That single customer was
        #    the whole of April's gap against the Sundry-Debtors Credit column
        #    (5,89,73,876.00 against 5,90,91,076.00). Tinkas (6,35,044.25 Cr) and
        #    Bliss Corp (3,25,00,000 Cr) are the same thing.
        #
        #    Booked as a ReceivableAdjustment, NOT as a reconstructed invoice:
        #    inventing a receivable for money that was never against a bill is
        #    what the branch above exists to avoid. tally_guid so a re-import is
        #    idempotent and `revert_tally_vouchers` can remove it (it only
        #    deletes adjustments that have one).
        if remaining > 0 and not has_against and not _cred_has_it:
            ReceivableAdjustment.objects.update_or_create(
                tally_guid=guid, customer=cust, company=ctx.company,
                defaults=dict(
                    adjustment_type="OTHER", direction="CREDIT", date=date,
                    amount=remaining, ledger_name="Advance / overpayment",
                    # This IS cash — say so, or it reads as a journal.
                    #
                    # `is_receipt` decides which LINE of Amount Received the money
                    # appears on, and the parking branches never set it. So a
                    # receipt that settled a prior-year bill, or exceeded every
                    # bill the customer has, showed up under "Journal / Contra".
                    # SS Biochem April 2026: Tally's Sundry-Debtors receipts came
                    # to Rs 13,88,74,304.47 while the Receipts line read
                    # Rs 13,28,89,822.47 — short by exactly the Rs 60,02,482 in
                    # three parked vouchers (27 at 30,00,000, 26 at 29,86,471,
                    # 5 at 16,011). The TOTAL was right the whole time; only the
                    # split between the two lines was wrong.
                    is_receipt=True,
                    # Lead with the voucher number: this narration is the only
                    # place a receipt that matched NO invoice can carry its
                    # Tally identity, and the ledger needs it to label the row.
                    narration=(f"Tally receipt {v.get('number') or ''} — receipt "
                               "exceeds everything this customer owes; held as a "
                               "credit on account, mirroring Tally's credit "
                               "balance in Sundry Debtors."),
                    # Tally holds it On Account, so the age bands must not
                    # spend it on a bill (see ReceivableAdjustment.tally_bills).
                    tally_bills=[{"name": "", "type": "On Account",
                                  "amount": str(remaining), "credit_period": ""}],
                    created_by=ctx.created_by),
            )
            ctx.summary["advances"] = ctx.summary.get("advances", 0) + 1
            remaining = Decimal("0")
        applied = True

    # ── 194Q TDS withheld INSIDE this receipt ─────────────────────────────
    #
    # When a customer pays and withholds 194Q, the accountant may book the tax
    # ON THE RECEIPT voucher (Dr Bank for the cash, Dr TDS Receivable for the
    # withholding, Cr Party for the full bill) instead of as a separate Journal.
    # The importer reads TDS only out of Journals, so a receipt-booked
    # withholding was lost and the TDS tile read short.
    #
    # SS Biochem, Sharda Cropchem, 16-Oct-2026 is the case: Receipt 256 held
    # Rs 21,000 to TDS Receivable 194Q and the ERP's TDS was exactly that much
    # under Tally for October, every other month exact.
    #
    # The receipt's own amount already credits the party the FULL bill (cash +
    # TDS), so the withholding is recorded for the TDS tile ONLY -- amount=0 --
    # or it double-counts the money that already arrived as the receipt. Same
    # shape a Journal's TDS takes (a CREDIT adjustment carrying `tds`), keyed off
    # the receipt guid so a re-import is idempotent. Only a single-customer
    # receipt can attribute the tax; a TDS leg on a multi-party receipt is
    # reported for a human rather than guessed.
    _rtds = sum((abs(lg["amount"]) for lg in v["ledgers"]
                 if "194Q" in (lg["ledger"] or "").upper()
                 and "RECEIVABLE" in (lg["ledger"] or "").upper()), Decimal("0"))
    if _rtds and applied and not ctx.dry_run:
        from .models import ReceivableAdjustment
        if len(_credited) == 1:
            _tc = next(iter(_credited.values()))
            ReceivableAdjustment.objects.update_or_create(
                tally_guid=f"RCPTTDS|{guid}"[:64],
                defaults=dict(
                    company=ctx.company, customer=_tc, direction="CREDIT",
                    adjustment_type="JOURNAL", date=date, amount=Decimal("0"),
                    tds=_rtds, ledger_name=(_tc.customer_name or "")[:255],
                    counts_as_received=False, counts_in_outstanding=False,
                    narration=f"194Q withheld on receipt {v.get('number')}"[:2000],
                    created_by=ctx.created_by))
        else:
            ctx.summary.setdefault("receipt_tds_unattributed", []).append(
                {"receipt": v.get("number"), "tds": str(_rtds),
                 "parties": len(_credited)})

    _store_receipt_lines(v, ctx, guid)
    _stamp_receipt(v, ctx, guid)
    if applied:
        ctx.summary["receipts"] += 1
    elif refused:
        # Every leg was refused as non-customer money (a loan drawn, a bank
        # transfer, a supplier refund). Nothing applied — but this is the
        # CORRECT outcome, not an unresolved party. Reporting it below would put
        # "ICICI CC AC No.611951001004" in the Map/Create/Skip list and invite
        # the operator to create the very ledger the rule just rejected, which
        # is how these became customer masters in the first place.
        pass
    elif unmatched or v["party"]:
        ctx.summary["unmatched_customers"].add(unmatched or v["party"])
        _note_skipped(ctx, v, "receipt", party=unmatched or v["party"])


# --------------------------------------------------------- freight journal (AP)
def _new_refs_from_party_leg(v):
    """New Ref bill allocations on the transporter (party) credit leg.

    Tally splits the freight payable into a base ref (e.g. "548") for the net
    freight amount and a GST-prefixed ref (e.g. "GST548") for the tax portion.
    Both are returned so the caller can pick the base ref as the ERP bill's
    vendor_invoice_no. Payments use Agst Ref matching which falls back through
    the GST-prefix strip, so only the base ref needs to live on the bill."""
    pname = (v.get("party") or "").strip()
    for lg in v.get("ledgers", []):
        if lg.get("is_party") or (pname and lg["ledger"].strip() == pname):
            return [
                b.get("name") or ""
                for b in lg.get("bills", [])
                if ("new" in (b.get("type") or "").lower()) and (b.get("name") or "")
            ]
    return []


def _create_freight_advice_inbound(bill, tally_guid, narration="", direction="inward",
                                   freight_amount=None):
    """Create a FreightAdviceInbound record from a Tally-imported freight VendorBill.
    Only creates for inward freight; outward freight stays on Bills only.
    `freight_amount`, when given, is the net of Freight Inward Charges legs only
    (excludes non-freight expense legs and second-party credits that _split_ledgers
    lumps into taxable)."""
    if direction != "inward":
        return
    from purchase.models import FreightAdviceInbound
    if tally_guid and FreightAdviceInbound.objects.filter(tally_guid=tally_guid).exists():
        return
    lorry = ""
    if narration:
        import re
        m = re.search(r'\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{4})\b', narration)
        if m:
            lorry = m.group(1)
    from master.models import Transporter
    import uuid as _uuid
    transporter = None
    if bill.vendor_id:
        vname = (bill.vendor.vendor_name or "").strip()
        if vname:
            transporter = (Transporter.objects.filter(name__iexact=vname).first()
                           or Transporter.objects.filter(name__icontains=vname).first())
            if not transporter:
                transporter = Transporter.objects.create(
                    transporter_code=f'TRP-{_uuid.uuid4().hex[:8].upper()}',
                    name=vname[:255],
                    company=bill.vendor.company,
                )
    fa = FreightAdviceInbound(
        vendor_bill=bill,
        source_type='VENDOR_BILL',
        freight_source='SEPARATE_SLIP',
        freight_type='LINEHAUL',
        transporter=transporter,
        base_amount=freight_amount if freight_amount is not None else bill.subtotal,
        payable_amount=bill.total_amount,
        balance=bill.total_amount - bill.amount_paid,
        total_paid=bill.amount_paid,
        freight_date=bill.bill_date,
        tally_guid=tally_guid,
        lorry_no=lorry,
        remarks=bill.notes,
        status='COMPLETED' if bill.amount_paid >= bill.total_amount else 'APPROVED',
    )
    fa.save()


def _import_freight_journal(v, ctx):
    """Import a Journal / GST-Journal voucher that creates a freight payable.

    Pattern (confirmed from SS Biochem Tally):
      Debit  Freight Outward Charges @ 18%  (or @ 5%, or - RCM)
      Debit  CGST / SGST legs               (GST-registered transporter only)
      Credit Transporter party              (New Ref = the bill reference)
      Credit TDS Payable - Freight          (194C, optional)

    The Credit to the transporter is `abs(party)` from _split_ledgers — this is
    what we actually owe them (gross minus TDS, which goes to the government).
    We store the Tally New Ref in vendor_invoice_no so _find_bill_by_ref can
    link the payment when it arrives with the matching Agst Ref."""
    from purchase.models import VendorBill
    guid = _guid(v)
    if VendorBill.objects.filter(tally_guid=guid).exists():
        ctx.summary["skipped_existing"] += 1
        return
    # Secondary dedup: same voucher number + same amount on ANY vendor
    # catches freight already imported on the goods vendor from a different
    # path (manual entry, email import, etc.) — different GUID, same bill.
    vno_raw = (v.get("number") or "").strip()
    if vno_raw:
        from django.db.models import Q
        date = _pdate(v["date"]) or timezone.now().date()
        _party_amt = Decimal("0")
        for lg in v.get("ledgers", []):
            a = lg.get("amount") or Decimal("0")
            if a > 0 and not _is_tax_ledger((lg.get("ledger") or "").strip()):
                _party_amt += a
        if _party_amt > 0:
            _existing = VendorBill.objects.filter(
                vendor__company=ctx.company,
                total_amount=_party_amt,
                bill_date=date,
            ).filter(
                Q(vendor_invoice_no__icontains=vno_raw)
                | Q(bill_no__icontains=vno_raw)
            )
            if _existing.exists():
                ctx.summary["skipped_existing"] += 1
                return
    # PARTYLEDGERNAME is often blank in Journal vouchers; derive party from ledgers.
    party_name = (v.get("party") or "").strip()
    if not party_name:
        _master = ctx.ledger_master or {}
        for lg in v.get("ledgers", []):
            nm = (lg.get("ledger") or "").strip()
            amt = lg.get("amount") or Decimal("0")
            if lg.get("is_party"):
                party_name = nm
                break
            # Credit leg (positive amount) that is not a tax or freight-expense
            # ledger is the transporter party.
            if amt > 0 and nm and not _is_tax_ledger(nm) and not _is_freight_outward_ledger(nm):
                # Skip bank/cash/liability accounts — only Sundry Creditor legs
                # are valid transporter parties.
                led = _master.get(nm) or {}
                grp = (led.get("parent") or led.get("primary_group") or "").strip().lower()
                _non_vendor = ("bank", "cash", "liabilit", "provision",
                               "fixed asset", "expense", "income", "purchase")
                if grp and any(k in grp for k in _non_vendor):
                    continue
                party_name = nm
                break
    if not party_name:
        _note_no_party(ctx, v, "freight_journal")
        return
    vend = _resolve_vendor(party_name, ctx)
    if not vend:
        vend = _auto_create_freight_vendor(party_name, ctx)
    if not vend:
        ctx.summary["unmatched_vendors"].add(party_name)
        return
    # If we derived party_name from ledgers, inject it so _split_ledgers can
    # identify the party leg by name comparison.
    v_eff = {**v, "party": party_name} if not v.get("party") else v
    party, taxable, cgst, sgst, igst, tds = _split_ledgers(v_eff)
    grand = abs(party)      # net payable to transporter (after TDS withheld)
    if grand <= 0:
        return
    date = _pdate(v["date"]) or timezone.now().date()
    if ctx.dry_run:
        ctx.summary["transport_bills"] = ctx.summary.get("transport_bills", 0) + 1
        return
    new_refs = _new_refs_from_party_leg(v_eff)
    # Keep the base (non-GST-prefixed) New Ref as vendor_invoice_no so a
    # payment arriving with Agst Ref "548" matches Q(vendor_invoice_no="548").
    # Fall back to the Tally journal number when no bill allocation was recorded
    # (some connectors omit BILLALLOCATIONS for journal vouchers).
    vno = (v.get("number") or "").strip()
    main_ref = next((r for r in new_refs if not r.upper().startswith("GST")),
                    new_refs[0] if new_refs else vno)
    narration = (v.get("narration") or "").strip()
    note = (f"Tally: {vno} | {narration}" if vno else narration)[:1000]
    bill = VendorBill(
        vendor=vend,
        vendor_invoice_no=main_ref[:100],
        tally_guid=guid,
        tally_voucher_type=(v.get("vtype") or "")[:100],
        bill_date=date,
        status="OPEN",
        subtotal=taxable,
        tax_amount=cgst + sgst + igst,
        cgst_amount=cgst,
        sgst_amount=sgst,
        igst_amount=igst,
        tds_amount=tds,
        total_amount=grand,
        amount_paid=Decimal("0"),
        purchase_category="FREIGHT",
        category_source="voucher_type",
        notes=note,
        created_by=ctx.created_by,
    )
    # Freight bills share Tally bill refs with purchase invoices (the goods
    # bill and the freight journal use the same New Ref so payments can link
    # both). Storing the raw ref as bill_no would clash with the purchase
    # bill's bill_no. Use a "FRT-" prefix so they stay unique.
    # Different transporters can share the same Tally ref number, so append
    # a numeric suffix (-2, -3, …) when the base FRT-xxx already exists.
    base_no = f"FRT-{main_ref[:46]}" if main_ref else f"FRT-{vno[:46]}"
    candidate = base_no
    seq = 1
    while VendorBill.objects.filter(bill_no=candidate).exists():
        seq += 1
        candidate = f"{base_no}-{seq}"
    bill.bill_no = candidate
    bill.save()
    direction = "inward"
    freight_inward_amt = Decimal("0")
    dir_set = False
    for lg in v.get("ledgers", []):
        lname = lg.get("ledger") or ""
        m = _FREIGHT_EXPENSE_RE.search(lname)
        if m:
            d = m.group(1).lower()
            if not dir_set:
                direction = d
                dir_set = True
            if d == "inward":
                freight_inward_amt += -lg["amount"]
        elif _is_freight_ledger_by_group(lname, ctx):
            freight_inward_amt += -lg["amount"]
    _create_freight_advice_inbound(
        bill, guid, narration, direction=direction,
        freight_amount=freight_inward_amt if freight_inward_amt > 0 else None,
    )
    ctx.summary["transport_bills"] = ctx.summary.get("transport_bills", 0) + 1


# --------------------------------------------------------- expense journal (AP)
def _import_expense_journal(v, ctx):
    """Import a Journal / GST-Journal / Cash / Cash-Payment voucher that books
    a Direct or Indirect Expense (rent, salary, electricity, security, etc.).

    When the credit side is a Bank/Cash ledger the expense is already paid
    inside the voucher — the bill is created as PAID. When it credits a
    Sundry Creditor, the bill is OPEN and a separate Payment settles it."""
    from purchase.models import VendorBill
    from purchase.tally_align import _expense_subcategory
    guid = _guid(v)
    if VendorBill.objects.filter(tally_guid=guid).exists():
        ctx.summary["skipped_existing"] += 1
        return

    expense_legs = []
    for lg in v.get("ledgers", []):
        nm = (lg.get("ledger") or "").strip()
        if not nm:
            continue
        grp = _is_expense_group_ledger(nm, ctx)
        if grp:
            expense_legs.append((nm, lg.get("amount", Decimal("0")), grp))
    if not expense_legs:
        return

    expense_legs.sort(key=lambda x: x[1])
    primary_ledger, _, primary_group = expense_legs[0]

    _pl = primary_ledger.lower()
    if any(k in _pl for k in _EXPENSE_LEDGER_EXCLUDE):
        return
    if "freight" in _pl or _is_freight_ledger_by_group(primary_ledger, ctx):
        return

    party_name = (v.get("party") or "").strip()
    paid_via_bank = False
    if not party_name:
        _master = ctx.ledger_master or {}
        for lg in v.get("ledgers", []):
            nm = (lg.get("ledger") or "").strip()
            amt = lg.get("amount") or Decimal("0")
            if lg.get("is_party"):
                party_name = nm
                break
            if amt > 0 and nm and not _is_tax_ledger(nm):
                led_info = _master.get(nm) or {}
                pg = (led_info.get("primary_group") or led_info.get("parent") or "").strip().lower()
                if "direct expenses" in pg or "indirect expenses" in pg:
                    continue
                if _is_bank_or_cash_ledger(nm, ctx):
                    paid_via_bank = True
                    continue
                party_name = nm
                break

    if not party_name:
        _note_no_party(ctx, v, "expense_journal")
        return
    vend = _resolve_vendor(party_name, ctx)
    if not vend:
        ctx.summary["unmatched_vendors"].add(party_name)
        return

    if not paid_via_bank:
        for lg in v.get("ledgers", []):
            nm = (lg.get("ledger") or "").strip()
            amt = lg.get("amount") or Decimal("0")
            if amt > 0 and nm and _is_bank_or_cash_ledger(nm, ctx):
                paid_via_bank = True
                break

    v_eff = {**v, "party": party_name} if party_name and not v.get("party") else v
    party_amt, taxable, cgst, sgst, igst, tds = _split_ledgers(v_eff)
    grand = abs(party_amt) if party_amt else (taxable + cgst + sgst + igst)
    if grand <= 0:
        return

    date = _pdate(v["date"]) or timezone.now().date()
    _subgrp, _subcat = _expense_subcategory(primary_ledger)
    exp_group = primary_group or _subgrp or ""
    exp_subcat = _subcat or ""

    if ctx.dry_run:
        ctx.summary["expense_bills"] = ctx.summary.get("expense_bills", 0) + 1
        return

    new_refs = _new_refs_from_party_leg(v_eff) if party_name else []
    vno = (v.get("number") or "").strip()
    main_ref = next((r for r in new_refs if not r.upper().startswith("GST")),
                    new_refs[0] if new_refs else vno)
    narration = (v.get("narration") or "").strip()
    note = (f"Tally: {vno} | {narration}" if vno else narration)[:1000]

    # ADOPT instead of DUPLICATE: this expense may already be in the ERP as a
    # SCANNED bill under a different number (e.g. Tally books the journal ref
    # 'JN697/26-27' while the scan kept the printed '25'). The guid check above
    # only catches a re-run of THIS importer; it cannot see a scanned twin that
    # has no guid yet. Without this, every scanned expense that Tally also books
    # as a journal becomes a second 'EXP-...' bill that double-counts Outstanding
    # (86 such pairs found on SSB in Nov 2026). Mirror apply_voucher's adopt: if a
    # same-firm, same-amount(+TDS)/date ERP bill with NO guid already covers it,
    # stamp the guid onto it and stop — one synced bill, not two.
    from purchase.zoho_mismatch import find_existing_bill
    twin = find_existing_bill(vendor=vend, invoice_no=main_ref or vno,
                              amount=grand, bill_date=date, tds=tds)
    if twin is not None and not (twin.tally_guid or "").strip():
        twin.tally_guid = guid
        twin.tally_voucher_type = (v.get("vtype") or "")[:100]
        twin.save(update_fields=["tally_guid", "tally_voucher_type"])
        ctx.summary["expense_adopted"] = ctx.summary.get("expense_adopted", 0) + 1
        return

    bill = VendorBill(
        vendor=vend,
        vendor_invoice_no=main_ref[:100] if main_ref else "",
        tally_guid=guid,
        tally_voucher_type=(v.get("vtype") or "")[:100],
        bill_date=date,
        status="PAID" if paid_via_bank else "OPEN",
        subtotal=taxable,
        tax_amount=cgst + sgst + igst,
        cgst_amount=cgst,
        sgst_amount=sgst,
        igst_amount=igst,
        tds_amount=tds,
        total_amount=grand,
        amount_paid=grand if paid_via_bank else Decimal("0"),
        is_expense=True,
        purchase_category="EXPENSES",
        category_source="voucher_type",
        expense_group=exp_group,
        expense_subcategory=exp_subcat,
        source="TALLY",
        notes=note,
        created_by=ctx.created_by,
    )
    base_no = f"EXP-{main_ref[:46]}" if main_ref else f"EXP-{vno[:46]}"
    candidate = base_no
    seq = 1
    while VendorBill.objects.filter(bill_no=candidate).exists():
        seq += 1
        candidate = f"{base_no}-{seq}"
    bill.bill_no = candidate
    bill.save()
    ctx.summary["expense_bills"] = ctx.summary.get("expense_bills", 0) + 1


# ---- re-settle payments against expense bills ----------------------------
#
# When the purchase import runs BEFORE the expense import, Payment vouchers
# for expense vendors are either (a) saved on-account (bill=NULL) because the
# expense bills don't exist yet, or (b) linked to the wrong non-expense bill
# via FIFO. Both cases leave the real expense bill stuck at "Unpaid".
#
# Two passes fix this:
#   1. _resettle_expense_payments — uses the current Day Book batch so it can
#      match by Agst Ref first, FIFO second.
#   2. _resettle_remaining_on_account — broader sweep for payments outside
#      the current batch (FIFO only).

def _unlink_from_old_bill(pmt):
    """Remove a payment from its current (non-expense) bill and fix that
    bill's amount_paid / status so it doesn't stay artificially overpaid."""
    old = pmt.bill
    if old is None:
        return
    old.amount_paid = max(old.amount_paid - pmt.amount, Decimal("0"))
    if old.amount_paid >= old.total_amount:
        old.status = "PAID"
    elif old.amount_paid > 0:
        old.status = "PARTIALLY_PAID"
    else:
        old.status = "OPEN"
    old.save(update_fields=["amount_paid", "status"])


def _settle_expense_bills(pmt, open_qs, remaining, settled_bills,
                          refs=None):
    """Settle `remaining` against open expense bills: Agst-Ref first (when
    `refs` is given), then FIFO.  Appends (bill, pay) to `settled_bills`."""
    if refs:
        for ref, amt in refs:
            if remaining <= 0:
                break
            bill = _find_bill_by_ref(pmt.vendor, ref)
            if bill and bill.is_expense:
                due = bill.total_amount - bill.amount_paid
                pay = min(remaining, due, amt)
                if pay > 0:
                    bill.amount_paid += pay
                    bill.status = ("PAID" if bill.amount_paid >= bill.total_amount
                                   else "PARTIALLY_PAID")
                    bill.save(update_fields=["amount_paid", "status"])
                    settled_bills.append((bill, pay))
                    remaining -= pay
    if remaining > 0:
        for bill in open_qs:
            if remaining <= 0:
                break
            due = bill.total_amount - bill.amount_paid
            if due <= 0:
                continue
            pay = min(remaining, due)
            bill.amount_paid += pay
            bill.status = ("PAID" if bill.amount_paid >= bill.total_amount
                           else "PARTIALLY_PAID")
            bill.save(update_fields=["amount_paid", "status"])
            settled_bills.append((bill, pay))
            remaining -= pay
    return remaining


def _apply_settled(pmt, settled_bills, remaining, ctx):
    """Rewrite the PaymentMade row(s): first bill reuses `pmt`, extras get
    new rows, leftover stays on-account."""
    if not settled_bills:
        return
    first_bill, first_pay = settled_bills[0]
    pmt.bill = first_bill
    pmt.amount = first_pay
    pmt.notes = (pmt.notes or "").replace("(on account)", "(resettled)")
    pmt.save(update_fields=["bill", "amount", "notes"])

    for bill, pay in settled_bills[1:]:
        PaymentMade.objects.create(
            vendor=pmt.vendor, payment_date=pmt.payment_date,
            payment_mode=pmt.payment_mode, amount=pay,
            reference_no=pmt.reference_no, bill=bill,
            status="APPROVED", tally_guid=pmt.tally_guid,
            notes=f"Tally payment {pmt.reference_no} (resettled)",
            created_by=ctx.created_by)

    if remaining > 0:
        PaymentMade.objects.create(
            vendor=pmt.vendor, payment_date=pmt.payment_date,
            payment_mode=pmt.payment_mode, amount=remaining,
            reference_no=pmt.reference_no,
            status="APPROVED", tally_guid=pmt.tally_guid,
            notes=f"Tally payment {pmt.reference_no} (on account, partial)",
            created_by=ctx.created_by)


def _resettle_expense_payments(money_vouchers, ctx):
    """Re-link payments to expense bills using Agst-Ref + FIFO.

    Finds payments that are on-account OR linked to a non-expense bill for
    vendors who have open expense bills.  Uses the voucher data from the
    current Day Book batch for Agst-Ref matching."""
    from purchase.models import VendorBill, PaymentMade
    from django.db.models import Q
    guid_to_voucher = {_guid(v): v for v in money_vouchers}

    candidates = list(
        PaymentMade.objects.filter(tally_guid__in=guid_to_voucher.keys())
        .filter(Q(bill__isnull=True) | Q(bill__is_expense=False))
        .select_related("vendor", "bill")
    )
    if not candidates:
        return

    resettled = 0
    for pmt in candidates:
        v = guid_to_voucher.get(pmt.tally_guid)
        if not v:
            continue
        vend = pmt.vendor
        open_qs = (VendorBill.objects.filter(
            vendor=vend, is_expense=True, is_active=True)
            .exclude(status__in=["PAID", "CANCELLED"])
            .order_by("bill_date", "created_at"))
        if not open_qs.exists():
            continue

        _unlink_from_old_bill(pmt)
        remaining = pmt.amount
        settled_bills = []
        remaining = _settle_expense_bills(
            pmt, open_qs, remaining, settled_bills,
            refs=_against_refs(v))
        if settled_bills:
            _apply_settled(pmt, settled_bills, remaining, ctx)
            resettled += 1

    ctx.summary["expense_payments_resettled"] = resettled


def _resettle_remaining_on_account(company, ctx):
    """Broader sweep: find payments (on-account OR linked to non-expense bills)
    for vendors that have open expense bills.  Catches payments from outside
    the current Day Book batch.  FIFO only (no voucher data)."""
    from purchase.models import VendorBill, PaymentMade
    from django.db.models import Q
    open_vendor_ids = set(
        VendorBill.objects.filter(
            vendor__company=company, is_expense=True, is_active=True, status="OPEN")
        .values_list("vendor_id", flat=True).distinct())
    if not open_vendor_ids:
        return

    candidates = list(
        PaymentMade.objects.filter(vendor_id__in=open_vendor_ids)
        .filter(Q(bill__isnull=True) | Q(bill__is_expense=False))
        .order_by("payment_date", "created_at")
    )
    if not candidates:
        return

    resettled = 0
    for pmt in candidates:
        open_qs = (VendorBill.objects.filter(
            vendor_id=pmt.vendor_id, is_expense=True, is_active=True)
            .exclude(status__in=["PAID", "CANCELLED"])
            .order_by("bill_date", "created_at"))

        _unlink_from_old_bill(pmt)
        remaining = pmt.amount
        settled_bills = []
        remaining = _settle_expense_bills(pmt, open_qs, remaining, settled_bills)
        if settled_bills:
            _apply_settled(pmt, settled_bills, remaining, ctx)
            resettled += 1
        elif pmt.bill is None:
            pass
        else:
            pmt.bill = None
            pmt.save(update_fields=["bill"])

    ctx.summary["expense_on_account_resettled"] = resettled


# ---------------------------------------------------------------- payment (AP)
def _import_payment(v, ctx):
    from purchase.models import VendorBill, PaymentMade
    guid = _guid(v)
    if PaymentMade.objects.filter(tally_guid=guid).exists():
        ctx.summary["skipped_existing"] += 1
        return
    vend = _resolve_vendor(v["party"], ctx) if v["party"] else None
    if not vend:
        if v["party"]:
            ctx.summary["unmatched_vendors"].add(v["party"])
        else:
            _note_no_party(ctx, v, "payment")
        return
    party, *_ = _split_ledgers(v)
    amount = abs(party)
    if amount <= 0:
        return
    if ctx.dry_run:
        ctx.summary["payments"] += 1
        return
    date = _pdate(v["date"]) or timezone.now().date()

    def _settle(bill, amt):
        due = bill.total_amount - bill.amount_paid
        pay = min(amt, due)
        if pay <= 0:
            return Decimal("0")
        bill.amount_paid += pay
        bill.status = "PAID" if bill.amount_paid >= bill.total_amount else "PARTIALLY_PAID"
        bill.save(update_fields=["amount_paid", "status"])
        PaymentMade.objects.create(
            vendor=vend, payment_date=date, payment_mode="BANK_TRANSFER", amount=pay,
            reference_no=(v["number"] or "")[:100], bill=bill, status="APPROVED",
            tally_guid=guid, notes=f"Tally payment {v['number']}", created_by=ctx.created_by)
        return pay

    remaining = amount
    applied = False
    # 1) settle the exact bills named in "Against Reference"
    for ref, amt in _against_refs(v):
        if remaining <= 0:
            break
        bill = _find_bill_by_ref(vend, ref)
        if bill:
            used = _settle(bill, min(amt, remaining))
            remaining -= used
            applied = applied or used > 0
    # Does this party settle bill-by-bill? Tally says so per ledger, via
    # ISBILLWISEON, mirrored onto the vendor by purchase/tally_party_link.py.
    #   True  -> payments name the invoice they settle
    #   False -> the party runs ON ACCOUNT (farmers paid in cash, agents): a
    #            payment reduces a running balance, it does not pay document #7
    #   None  -> never matched to a Tally ledger; unknown, so behave as before
    bill_wise = getattr(vend, "tally_bill_wise", None)

    # 2) leftover -> FIFO oldest open bill.
    #
    # ONLY for a party kept bill-by-bill. For an on-account party Tally records
    # no reference because there is nothing to reference, and spreading the
    # money over the oldest open bills invents an allocation the books never
    # made: the bills come out marked paid, each against a document the
    # supplier never issued a receipt for. Measured on SS Biochem, 652 of 1,528
    # ledgers are on-account, and every creditor group holds a mix of both --
    # "Farmer Purchase" is 1 bill-wise against 95 not -- so this cannot be
    # decided by which group a party sits in.
    #
    # `None` keeps the old FIFO behaviour, so nothing changes for a company
    # whose vendors have not been linked to Tally ledgers yet.
    if remaining > 0 and bill_wise is not False:
        for bill in (VendorBill.objects.filter(vendor=vend, is_active=True)
                     .exclude(status__in=["PAID", "CANCELLED"]).order_by("bill_date", "created_at")):
            if remaining <= 0:
                break
            used = _settle(bill, remaining)
            remaining -= used
            applied = applied or used > 0
    # 2b) Any money left after settling named bills + FIFO is recorded as an
    # on-account payment so nothing is silently dropped.
    if remaining > 0 and applied:
        PaymentMade.objects.create(
            vendor=vend, payment_date=date, payment_mode="BANK_TRANSFER",
            amount=remaining, reference_no=(v["number"] or "")[:100],
            status="APPROVED", tally_guid=guid,
            notes=f"Tally payment {v['number']} (on account)",
            created_by=ctx.created_by)
        remaining = Decimal("0")
    # 3) nothing to settle -> still record the payment against the vendor (on account)
    if not applied:
        PaymentMade.objects.create(
            vendor=vend, payment_date=date, payment_mode="BANK_TRANSFER", amount=amount,
            reference_no=(v["number"] or "")[:100], status="APPROVED", tally_guid=guid,
            notes=f"Tally payment {v['number']} (on account)", created_by=ctx.created_by)
    ctx.summary["payments"] += 1


# ---------------------------------------------------------------- party masters
def _classify_ledger(parent):
    p = (parent or "").lower()
    if "debtor" in p:
        return "customer"
    if "creditor" in p or "farmer" in p or "former" in p:
        return "vendor"
    return None


def _opening_side(lg):
    """Which side an OPENING balance belongs to, decided by Tally's own group.

    `_classify_ledger` reads `parent`, which is only the IMMEDIATE parent and is
    routinely a custom sub-group — "Greenstar Fertilizers Limi…", "Sundry
    Debtors - Kerala Cu…" — so it returns None even for a plain debtor, and the
    caller then guesses the side from whether a master happens to share the
    name. That guess put United Agro's "Datuk Subbrayan Sellappan" into
    Outstanding as a Rs 2,50,00,000 customer receivable: its primary group is
    UNSECURED LOANS. Money we BORROWED, reported as money owed to us.

    `primary_group` is what Tally shows under "Under:" and is returned for
    essentially every ledger, so it decides here.

    Returns 'customer', 'vendor', 'other' (Tally says it is neither a debtor nor
    a creditor — a loan, bank, tax or asset, never to be guessed into a party),
    or None (no group came back at all; the caller may fall back).
    """
    grp = (lg.get("primary_group") or "").strip().lower()
    if not grp:
        return None
    if "debtor" in grp:
        return "customer"
    if "creditor" in grp or "farmer" in grp or "former" in grp:
        return "vendor"
    return "other"


# Greenstar & T.Stanes are curated in production (Greenstar North/South,
# T.Stanes Coimbatore) — the Tally import must NOT create the extra regional
# variants (Greenstar AP/MP/Telangana/KL…, T.Stanes AP/Blre/Pune/TEL…). We match
# existing ones but never add new ones for these, keeping them as production has.
_PROTECTED_CUSTOMER_KEYWORDS = ("greenstar", "green star", "stanes")

import re
_GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$")


def _valid_gstin(s):
    """A proper 15-char GSTIN. Import blanks anything that fails so a malformed
    GSTIN from Tally is never stored (the models validate format, but our direct
    create bypasses that — so we check here)."""
    return bool(_GSTIN_RE.match(re.sub(r"\s+", "", (s or "").upper())))


def _gst_treatment(reg_type, has_gstin):
    """Map Tally's GST Registration Type -> our gst_treatment choice."""
    t = (reg_type or "").lower()
    if "composit" in t:
        return "REGISTERED_COMPOSITION"
    if "regular" in t:
        return "REGISTERED_REGULAR"
    if "unregist" in t or "unknown" in t:
        return "UNREGISTERED"
    if "consumer" in t:
        return "CONSUMER"
    if "oversea" in t or "export" in t:
        return "OVERSEAS"
    if "sez" in t:
        return "SEZ"
    # no explicit type from Tally — infer from whether a valid GSTIN exists
    return "REGISTERED_REGULAR" if has_gstin else "UNREGISTERED"


def _apply_ledger_to_customer(c, l, gst):
    """Update an existing Customer's fields from a Tally ledger, 'Tally wins but
    never blank': a non-empty Tally value replaces the ERP value; an empty Tally
    value leaves the ERP value untouched. Returns the sorted list of changed
    field names (empty = nothing to update)."""
    changed = set()
    # GSTIN — and blank PAN so Customer.save() re-derives it from the new GSTIN.
    if gst and (c.gstin or "") != gst[:15]:
        c.gstin = gst[:15]
        c.pan = ""
        changed.update({"gstin", "pan"})
    # GST treatment — only when Tally actually carries GST info (type or GSTIN).
    if l.get("gst_type") or gst:
        t = _gst_treatment(l.get("gst_type"), bool(gst))
        if t and c.gst_treatment != t:
            c.gst_treatment = t
            changed.add("gst_treatment")
    # Contact
    email = (l.get("email") or "").strip()
    if email and (c.contact_email or "") != email[:254]:
        c.contact_email = email[:254]
        changed.add("contact_email")
    phone = (l.get("phone") or "").strip()
    if phone and (c.contact_phone or "") != phone[:20]:
        c.contact_phone = phone[:20]
        changed.add("contact_phone")
    # Billing address (JSON) — merge sub-fields, never blanking an existing one.
    ba = dict(c.billing_address or {})
    for key, val in (("address", l.get("address")), ("state", l.get("state")),
                     ("pincode", l.get("pincode")), ("country", l.get("country"))):
        v = (val or "").strip()
        if v and ba.get(key) != v:
            ba[key] = v
            changed.add("billing_address")
    if "billing_address" in changed:
        c.billing_address = ba
    # Credit terms from Tally's credit period ('30 Days' -> NET_30, else CUSTOM).
    days = _credit_days(l.get("credit_period"))
    if days > 0:
        if days in (15, 30, 45, 60):
            term = f"NET_{days}"
            if c.credit_terms != term:
                c.credit_terms = term
                changed.add("credit_terms")
        elif c.credit_terms != "CUSTOM" or (c.custom_credit_days or 0) != days:
            c.credit_terms = "CUSTOM"
            c.custom_credit_days = days
            changed.update({"credit_terms", "custom_credit_days"})
    return sorted(changed)


def import_tally_ledgers(ledgers, company, created_by=None, dry_run=True, only_kind=None):
    """Create Customers (Sundry Debtors) and Vendors (Sundry Creditors) from
    Tally ledger masters. Idempotent: skips ledgers already in the company (by
    GSTIN, else name). Each ledger runs in its OWN transaction/savepoint — one
    bad ledger is logged and skipped, never crashing or rolling back the rest.

    only_kind: 'customer' or 'vendor' restricts the import to that side (so the
    Customers page imports only customers and the Vendors page only vendors);
    None imports both."""
    from master.models import Customer, Vendor
    from .models import TallyPartyMap
    s = {"customers": 0, "vendors": 0, "updated_customers": 0, "skipped_existing": 0,
         "skipped_protected": 0, "skipped_other": 0, "errors": [],
         # "Possible duplicate" rows — a similar name or a shared GSTIN — that we
         # DON'T create blind. Surfaced to the same confirm popup the voucher
         # import uses (Map to existing / Create new / Skip).
         "unmatched_customers": set(), "unmatched_vendors": set(),
         "customer_options": {}, "vendor_options": {}}

    def _gst_dupes(Model, field, gst, name):
        """Existing masters sharing this GSTIN but under a DIFFERENT name — a
        strong 'same party' signal worth confirming."""
        if not gst:
            return []
        q = (Model.objects.filter(company=company, is_active=True, gstin__iexact=gst)
             .exclude(**{f"{field}__iexact": name}))
        return [{"id": str(o.id), "name": getattr(o, field), "gstin": o.gstin or ""}
                for o in q[:4]]

    def _resolved(m, fk):
        """A prior confirm already settled this Tally name (mapped or skipped)."""
        return bool(m and (m.skip or (getattr(m, f"{fk}_id", None)
                                      and getattr(m, fk) and getattr(m, fk).is_active)))

    def _cust(l):
        name = l["name"]
        gst = (l["gstin"] or "") if _valid_gstin(l["gstin"]) else ""   # blank invalid GSTINs
        m = TallyPartyMap.objects.filter(company=company, tally_name__iexact=name).first()
        # Operator explicitly said "skip this Tally name" in a prior confirm.
        if m and m.skip:
            s["skipped_existing"] += 1
            return
        q = Customer.objects.filter(company=company, is_active=True)
        # SURE MATCH -> update its fields from Tally (never create a duplicate):
        #   1) a prior confirm mapped this Tally name to a customer,
        #   2) an exact name match, or
        #   3) exactly one active customer sharing this (valid) GSTIN.
        target = None
        if m and getattr(m, "customer_id", None) and m.customer and m.customer.is_active:
            target = m.customer
        if target is None:
            target = q.filter(customer_name__iexact=name).first()
        if target is None and gst:
            gmatch = list(q.filter(gstin__iexact=gst)[:2])
            if len(gmatch) == 1:
                target = gmatch[0]
        if target is not None:
            changed = _apply_ledger_to_customer(target, l, gst)
            if changed:
                if not dry_run:
                    target.save(update_fields=changed + ["updated_at"])
                s["updated_customers"] += 1
            else:
                s["skipped_existing"] += 1
            return
        # Greenstar / T.Stanes: keep exactly as production — never add variants.
        if any(k in name.lower() for k in _PROTECTED_CUSTOMER_KEYWORDS):
            s["skipped_protected"] += 1
            return
        # Any doubt (similar name OR same GSTIN under another name) -> don't
        # create; ask the operator to confirm map-vs-create.
        cands = suggest_party_candidates(name, "customer", company)
        if gst:
            seen = {c["id"] for c in cands}
            cands = cands + [c for c in _gst_dupes(Customer, "customer_name", gst, name)
                             if c["id"] not in seen]
        if cands:
            s["unmatched_customers"].add(name)
            s["customer_options"][name] = cands
            return
        if dry_run:
            s["customers"] += 1
            return
        c = Customer(
            customer_name=name[:200], company=company, gstin=(gst[:15] or None),
            gst_treatment=_gst_treatment(l.get("gst_type"), bool(gst)),
            credit_terms="NET_30", contact_email=(l["email"] or "")[:254],
            contact_phone=(l["phone"] or "")[:20],
            billing_address={"state": l["state"], "address": l["address"],
                             "pincode": l["pincode"], "country": l["country"] or "India"},
            created_by=created_by,
        )
        c.customer_code = c._generate_customer_code()
        c.save()
        s["customers"] += 1

    def _vend(l):
        name = l["name"]
        gst = (l["gstin"] or "") if _valid_gstin(l["gstin"]) else ""   # blank invalid GSTINs
        # Already resolved by a prior confirm? -> nothing to do.
        m = TallyPartyMap.objects.filter(company=company, tally_name__iexact=name).first()
        if _resolved(m, "vendor"):
            s["skipped_existing"] += 1
            return
        q = Vendor.objects.filter(company=company, is_active=True)
        # Exact name match -> definitely the same party.
        if q.filter(vendor_name__iexact=name).exists():
            s["skipped_existing"] += 1
            return
        # Any doubt (similar name OR same GSTIN under another name) -> don't
        # create; ask the operator to confirm map-vs-create.
        cands = suggest_party_candidates(name, "vendor", company)
        if gst:
            seen = {c["id"] for c in cands}
            cands = cands + [c for c in _gst_dupes(Vendor, "vendor_name", gst, name)
                             if c["id"] not in seen]
        if cands:
            s["unmatched_vendors"].add(name)
            s["vendor_options"][name] = cands
            return
        if dry_run:
            s["vendors"] += 1
            return
        vd = Vendor(
            vendor_name=name[:200], company=company, gstin=(gst[:15] or None),
            gst_treatment=_gst_treatment(l.get("gst_type"), bool(gst)),
            vendor_type=["MATERIAL"], payment_terms="NET_30",
            state=(l["state"] or "")[:100],
            contact_email=(l["email"] or "")[:254], contact_phone=(l["phone"] or "")[:20],
            created_by=created_by,
        )
        vd.vendor_code = vd._generate_vendor_code()
        vd.save()
        s["vendors"] += 1

    for l in ledgers:
        kind = _classify_ledger(l.get("parent"))
        if kind is None:
            s["skipped_other"] += 1
            continue
        if only_kind and kind != only_kind:
            # Restricted to one side (Customers page / Vendors page) — count the
            # other side as "not imported here" so the preview totals stay honest.
            s["skipped_other"] += 1
            continue
        try:
            with transaction.atomic():   # own savepoint per ledger
                (_cust if kind == "customer" else _vend)(l)
        except Exception as e:  # noqa: BLE001
            s["errors"].append(f"{l['name']}: {e}")

    s["errors"] = s["errors"][:50]
    # Sets -> sorted lists so the response is JSON-serialisable (mirrors the
    # voucher-import summary), keeping the confirm-popup keys identical.
    s["unmatched_customers"] = sorted(s["unmatched_customers"])
    s["unmatched_vendors"] = sorted(s["unmatched_vendors"])
    return s


# Counter-ledger words that say which BOOK a note belongs to, regardless of
# which master happens to exist. A note's party can be both a customer and a
# vendor (we buy fruit from Hanuman Agro and sell to T.Stanes who also supplies
# us), so "whichever master resolves first" is not evidence of anything.
_SALES_LEDGER_KEYS = ("SALES", "FREIGHT OUTWARD", "OUTWARD", "INCOME",
                      "DISCOUNT ALLOWED", "OUTPUT")
_PURCHASE_LEDGER_KEYS = ("PURCHASE", "FREIGHT INWARD", "INWARD", "EXPENSE",
                         "DISCOUNT RECEIVED", "INPUT")


def _note_side_from_ledgers(v, party):
    """'SALES' / 'PURCHASE' / None, read off the note's own counter ledgers.

    A debit note that credits "GST Local Sales @ 5%" is a sales document whoever
    it is against; one that credits "Purchase - Fruits" is a purchase return.
    Returns None when the counter ledger says neither (e.g. "Rate Difference"),
    and the caller falls back to the party's Tally group."""
    sales = purchase = 0
    for lg in v["ledgers"]:
        nm = (lg["ledger"] or "")
        if lg.get("is_party") or (party and nm.strip() == party):
            continue
        up = nm.upper()
        if _is_tax_ledger(nm):
            continue
        if any(k in up for k in _SALES_LEDGER_KEYS):
            sales += 1
        elif any(k in up for k in _PURCHASE_LEDGER_KEYS):
            purchase += 1
    if sales and not purchase:
        return "SALES"
    if purchase and not sales:
        return "PURCHASE"
    return None


def _flag_note_party(party, side, ctx):
    """An unresolved note party goes to the SAME confirm popup as an unresolved
    invoice party (Map to existing / Create new / Skip).

    It used to be dropped in silence into `unmatched_note_parties`, which the
    import screen never showed. Measured on SS Biochem 1-Apr..21-Aug: Tally's
    Debit Note Register holds 60 live notes, the ERP wrote 47 — 13 gone, nine of
    them in August alone, against four fruit suppliers whose ERP master is
    spelled differently ("Sri Lakshmi Trading Company - Manapparai - Fruit" vs
    "Sri Lakshmi Trading Company-Manapparai") or absent altogether ("Kumaran
    Traders - Tiruppuvanam - Fruit", "Nataraj Trader - Pudukkottai - Fruit").
    Nothing on the import screen said so, and the value mirror stayed green
    because it only measures sales vouchers."""
    kind = "vendor" if side == "PURCHASE" else "customer"
    ctx.summary[f"unmatched_{kind}s"].add(party)
    # The preview view attaches the map-to-existing candidates for every name in
    # these two lists, so being in the list is all that is needed here.
    ctx.summary.setdefault("unmatched_note_parties", set()).add(party)


def _note_figures(v, ctx, side):
    """The money on a debit/credit note, exactly as the importer books it.
    Shared by a first import (_import_note) and an Update from the "Changed
    in Tally" tab, so the two can never compute a note differently."""
    p_amt, taxable, cg, sg, ig, n_tds, n_roff = _split_ledgers(v, with_round=True)
    # Normalise the round-off against the PARTY leg. _split_ledgers returns
    # taxable/GST/TDS as absolutes but keeps Round Off exactly as Tally signs it,
    # and Tally reverses every leg on a credit note: the party is CREDITED
    # (p_amt > 0) and the round-off that ADDS to the gross is therefore a debit,
    # i.e. negative. Stored raw it inverts the note's identity
    #     gross = taxable + GST - TDS + round_off
    # United Agro July 2026: Greenstar's CN/4 and CN/5 are 2,84,250 + 14,212.50
    # GST - 285.00 TDS + 0.50 round off = 2,98,178, and the raw sign booked them
    # as round off -0.50 / TDS 284.00 — an even split of the same 1.00 error, so
    # the GST came out right and only Tally's TDS ledger showed it (July credit
    # 570.00 = 2 x 285.00, not 568.00). Every DEBIT note, sales and purchase, has
    # the party debited and is unaffected.
    if p_amt > 0:
        n_roff = -n_roff
    amount = abs(p_amt) or (taxable + cg + sg + ig - n_tds + n_roff)
    # Exempt-goods notes (maize weight-difference, etc.) post their WHOLE value
    # to stock with no sales/GST ledger, so _split_ledgers yields taxable=0 even
    # though the note carries a real, GST-free taxable value. Recover it from the
    # goods value so the note nets out of Ex-GST turnover, not only the Incl-GST
    # total (which already uses `amount`). Guarded to GST-free notes that move
    # real stock, so a genuine journal/round-off adjustment stays taxable=0.
    if taxable == 0 and not (cg or sg or ig) and v.get("inventory"):
        _goods = abs(sum((i.get("amount") or Decimal("0") for i in v["inventory"]),
                         Decimal("0")))
        if _goods:
            # Set BOTH taxable and amount to the goods value so the note stays
            # self-consistent: taxable == amount means zero embedded GST (correct
            # for an exempt supply) AND the Ex-GST subtraction uses the exact
            # value GSTR-1 reports. Leaving amount at the rounded party-ledger
            # figure let a paise gap between it and the stock value leak into the
            # GST total (Ex-GST matched GSTR-1, but GST ran 25 paise over).
            taxable = amount = _goods
    _trade, n_charges = _note_charge_split(v, ctx, side)
    return {"p_amt": p_amt, "taxable": taxable, "cgst": cg, "sgst": sg,
            "igst": ig, "tds": n_tds, "roff": n_roff, "amount": amount,
            "trade": _trade, "charges": n_charges}


def _import_note(v, ctx, note_type):
    """Import a Tally Debit/Credit Note voucher into the DebitNote page.

    Side (sales vs purchase) comes from the note's own counter ledgers first and
    the party's Tally group second — never from "whichever master resolved",
    which filed SS Biochem's DN-0052 (Hanuman Agro Industries - Fruit) as a
    purchase note purely because a vendor of that name existed and a customer
    did not. Balances themselves stay in sync via the Bills-Outstanding
    reconciliation (Tally's outstanding already nets these notes), so we only
    record the note document here. Idempotent via tally_guid."""
    from .models import DebitNote
    guid = _guid(v)
    # Count what Tally sent BEFORE any early return, so the notes mirror can
    # show "Tally 15 / ERP 6" for a month instead of reporting only successes.
    ndate = _pdate(v["date"])
    if ndate:
        nm_ = ctx.summary["notes_month"].setdefault(
            ndate.strftime("%Y-%m"), {"tally": 0, "erp": 0})
        nm_["tally"] += 1
    _seen = DebitNote.objects.filter(tally_guid=guid)
    if _seen.exists():
        # Backfill Tally's GROUP onto notes imported before that field existed.
        # Same one-line pattern the sales-invoice skip path uses for
        # tally_voucher_type: an ordinary re-import becomes the whole backfill.
        #
        # Needed because the group is the ONLY reliable signal for what a note
        # really is. United Agro has TWO rate-difference ledgers that read alike
        # and mean opposite things:
        #     "Neem Cake - Rate Difference - 5%"  Sales Accounts    -> turnover
        #     "Debit Note - Rate Difference"      Indirect Incomes  -> NOT
        # so the reason-text fallback counts both as sales. UAI's 15 notes all
        # carry a blank group, which is why the text rules decide there at all.
        #
        # Fills blanks ONLY -- a group already stamped is never overwritten, and
        # a blank stays blank when the ledger master is unavailable (the text
        # rules then keep deciding, exactly as before). No figure moves from
        # this on its own: for every note seen, group and text agree on whether
        # it counts. It replaces a guess with a fact so the turnover rule can
        # later be made group-based.
        _g = (_note_ledger_group(v, ctx) or "")[:120]
        if _g and not ctx.dry_run:
            _seen.filter(tally_group="").update(tally_group=_g)
        # Same backfill for the bill-wise detail (see DebitNote.tally_bills).
        _tb = _bills_json(_party_bills(v))
        if _tb and not ctx.dry_run:
            for _n in _seen:
                if not _n.tally_bills:
                    DebitNote.objects.filter(pk=_n.pk).update(tally_bills=_tb)
        ctx.summary["skipped_existing"] += 1
        if ndate:
            nm_["erp"] += 1          # already present = not missing
        return
    party = (v.get("party") or "").strip()
    if not party:
        ctx.summary.setdefault("notes_no_party", []).append(
            {"number": v["number"], "date": v["date"], "type": note_type})
        return
    led = (ctx.ledger_master or {}).get(party) or {}
    grp = _classify_ledger(led.get("parent"))
    side = (_note_side_from_ledgers(v, party)
            or {"vendor": "PURCHASE", "customer": "SALES"}.get(grp))
    cust = vend = None
    if side == "PURCHASE":
        vend = _resolve_vendor(party, ctx) or _resolve_customer(party, ctx)
        if vend is not None and not hasattr(vend, "vendor_name"):
            cust, vend = vend, None      # only a customer master exists
    elif side == "SALES":
        cust = _resolve_customer(party, ctx) or _resolve_vendor(party, ctx)
        if cust is not None and not hasattr(cust, "customer_name"):
            vend, cust = cust, None      # only a vendor master exists
    else:  # the voucher says neither -> try both, customer first
        cust = _resolve_customer(party, ctx)
        if not cust:
            vend = _resolve_vendor(party, ctx)
    if not cust and not vend:
        _flag_note_party(party, side or "PURCHASE", ctx)
        return
    side = "PURCHASE" if vend else "SALES"
    # with_round: keep Tally's own Round Off OUT of `taxable` and store both. The
    # gross alone cannot be split back reliably — see DebitNote.taxable.
    # n_tds: a note can withhold 194Q TDS just as an invoice does. It was parsed
    # and dropped here, which left the dashboard recovering a note's GST as
    # `gross - taxable - round_off` — an expression the TDS silently eats into.
    # See DebitNote.tds for the July Greenstar notes this cost 568.00 on.
    _nf = _note_figures(v, ctx, side)
    p_amt, taxable, cg, sg, ig, n_tds, n_roff, amount = (
        _nf["p_amt"], _nf["taxable"], _nf["cgst"], _nf["sgst"], _nf["igst"],
        _nf["tds"], _nf["roff"], _nf["amount"])
    # Reason = first non-party, non-tax ledger line (e.g. "Freight Outward @ 5%").
    reason = ""
    for lg in v["ledgers"]:
        nm = lg["ledger"]
        if nm.strip() == party or _is_tax_ledger(nm):
            continue
        reason = nm
        break
    # Read the NARRATION when the ledger reason hides the note's real nature.
    # A maize weight-difference credit note books its whole value to STOCK
    # (negative inventory) with only a paise "Round Off" ledger, so the
    # ledger-derived reason comes out "Round Off"/blank and the note is misfiled
    # as an ignored adjustment instead of a sales return that nets out of
    # turnover. When the reason is empty or a trivial round-off BUT the voucher
    # moves real goods (inventory lines) AND the narration reads like a trade
    # document (sales / return / rate-diff / shortage / ...), adopt the
    # narration as the reason so the note classifies as trade. Every such
    # correction is recorded in the summary so the import can SURFACE it --
    # never a silent reclassification.
    from .note_kinds import TRADE_RE
    _narr = (v.get("narration") or "").strip()
    if (((not reason) or _norm_name(reason) == "roundoff")
            and v.get("inventory") and _narr and TRADE_RE.search(_narr)):
        ctx.summary.setdefault("notes_reclassified", []).append({
            "number": v["number"], "party": party,
            "was_reason": reason or "(blank)",
            "now": "trade (read from narration)", "narration": _narr[:120]})
        reason = _narr
    # A note can mix a sale with a charge on one voucher. `_split_ledgers`
    # sweeps every non-party, non-tax leg into `taxable`, so the charge leg
    # inflates the value that comes off turnover. Split it back out; `taxable`
    # keeps Tally's full pre-GST figure and `charges` records the part that is
    # not a sale, so the note's own identity still closes:
    #     amount = taxable + GST - TDS + round_off
    # and the dashboard subtracts `charges` from turnover and from the GST it
    # derives. Zero for every note that is not mixed, so nothing else moves.
    _trade, n_charges = _nf["trade"], _nf["charges"]
    if n_charges:
        ctx.summary.setdefault("notes_mixed_charge", []).append({
            "number": v["number"], "party": party,
            "trade": str(_trade), "charge": str(n_charges)})

    refs = _against_refs(v)
    ctx.summary[f"{note_type.lower()}_notes"] = ctx.summary.get(f"{note_type.lower()}_notes", 0) + 1
    if ndate:
        nm_["erp"] += 1
    if ctx.dry_run:
        return
    _gq, _gu = _note_goods(v, ctx)
    DebitNote.objects.create(
        company=ctx.company, note_no=(v["number"] or f"TLY-{guid}")[:50],
        note_type=note_type, side=side, customer=cust, vendor=vend,
        note_date=_pdate(v["date"]) or timezone.now().date(), amount=amount,
        taxable=taxable, charges=n_charges, round_off=n_roff, tds=n_tds,
        goods_qty=_gq, goods_uom=_gu,
        reason=(reason or "")[:255], reference=(refs[0][0] if refs else "")[:100],
        tally_group=_note_ledger_group(v, ctx)[:120],
        narration=(v["narration"] or "")[:2000], tally_guid=guid,
        tally_alter_id=_alter_id(v),
        tally_bills=_bills_json(_party_bills(v)),
        created_by=ctx.created_by,
    )


def _note_goods(v, ctx):
    """Quantity and unit of the stock a debit/credit note moved.

    A sales credit note is goods coming back, and Tally books it as NEGATIVE
    outward on the item -- so its Stock Summary Outward is net of returns while
    the ERP's Quantity Invoiced was gross. United Agro July 2026: Greenstar's
    CN/4 and CN/5 each returned 15.000 MTS of Mixed Oil Cake, Tally read
    1,613.770 MTS for the month and the ERP read 1,643.770.

    Returns (qty, uom), both zero/blank when the voucher moves no stock -- a
    freight, discount or rate-difference note, which must NOT be netted off a
    quantity it never carried.

    Unsigned. Tally reverses every leg on a credit note, so the inventory lines
    come through negative; the sign belongs to the note TYPE, not to the number.

    One unit per note. Tally's notes carry a single item in practice; a genuinely
    mixed-unit note keeps the largest unit and is REPORTED, never quietly
    collapsed into a total that means nothing.
    """
    from collections import defaultdict
    by = defaultdict(Decimal)
    for it in (v.get("inventory") or []):
        u = (it.get("uom") or "").strip()
        q = it.get("qty") or Decimal("0")
        if u and q:
            by[u] += abs(Decimal(str(q)))
    if not by:
        return Decimal("0"), ""
    if len(by) > 1:
        ctx.summary.setdefault("note_qty_mixed_uom", []).append(
            {"number": v.get("number"), "party": (v.get("party") or "").strip(),
             "units": {u: str(q) for u, q in by.items()}})
    uom = max(by, key=lambda u: by[u])
    return by[uom], uom[:20]


def _note_charge_split(v, ctx, side):
    """(trade_value, charges) for a note's non-party, non-tax ledger legs.

    A note can carry more than one leg, and only the ones inside the company's
    SALES group (or PURCHASE group, on a purchase note) are trade value. The
    rest — labour, freight billed on, a discount — are charges: real money on
    the voucher, but not turnover.

    SS Biochem CN-0012/26-27 is the case this exists for. It credits KSE
    8,02,630 across two legs: Yellow Maize 7,82,000 to `Sales Maize`, and
    20,630 to `Labour Cooli & Wages A/c - TVP`. Tally reduced Sales Accounts by
    7,82,000; the ERP reduced it by the whole 8,02,630, which is exactly how far
    August's Ex-GST sat below Tally.

    Returns (0, 0) — meaning "decide as before" — when we cannot tell:

      * no ledger master, so no group is known for any leg. Guessing from the
        ledger's NAME is what the group settings exist to avoid.
      * EVERY leg is a charge. Such a note is wholly a freight/rate-difference
        note, and the dashboard already removes it as a whole via `tally_group`.
        Reporting charges as well would take it out twice.

    So a value comes back only for a genuinely MIXED note, which is the one
    case nothing else handles.
    """
    pname = (v.get("party") or "").strip()
    master = getattr(ctx, "ledger_master", None) or {}
    if not master:
        return Decimal("0"), Decimal("0")
    groups = _co_groups(ctx.company)
    want = groups["sales"] if side == "SALES" else "purchase"

    trade = charges = Decimal("0")
    known = False
    for lg in v.get("ledgers") or []:
        nm = (lg.get("ledger") or "").strip()
        if not nm or lg.get("is_party") or (pname and nm == pname):
            continue
        up = nm.upper()
        if "TDS" in up or "TCS" in up or "ROUND OFF" in up or "ROUNDOFF" in up:
            continue
        if _is_tax_ledger(nm):
            continue
        amt = abs(lg.get("amount") or Decimal("0"))
        if not amt:
            continue
        led = master.get(nm) or {}
        grp = (led.get("primary_group") or led.get("parent") or "").strip().lower()
        if not grp:
            # This leg's group is unknown. Treating it as a charge on a guess
            # could wipe real turnover, so it counts as trade — the behaviour
            # before this existed.
            trade += amt
            continue
        known = True
        if want in grp:
            trade += amt
        else:
            charges += amt
    if not known or not charges or not trade:
        return Decimal("0"), Decimal("0")
    return trade, charges


def _note_ledger_group(v, ctx):
    """Tally's group for the charge ledger a debit/credit note was raised on.

    The party leg says who; the OTHER leg says what. Freight billed on sits in
    an income group, a TDS or bank-charge journal does not — and Tally knows
    which without anyone reading the note's reason text. Returns '' when the
    ledger master is unavailable, in which case the text rules still decide.
    """
    pname = (v.get("party") or "").strip()
    master = getattr(ctx, "ledger_master", None) or {}
    for lg in v.get("ledgers") or []:
        nm = (lg.get("ledger") or "").strip()
        if not nm or lg.get("is_party") or (pname and nm == pname):
            continue
        if _is_tax_ledger(nm):
            continue
        led = master.get(nm) or {}
        grp = (led.get("primary_group") or led.get("parent") or "").strip()
        if grp:
            return grp
    return ""


HANDLERS = {
    "sales": _import_sales, "purchase": _import_purchase,
    "receipt": _import_receipt, "payment": _import_payment,
    "debit_note": lambda v, ctx: _import_note(v, ctx, "DEBIT"),
    "credit_note": lambda v, ctx: _import_note(v, ctx, "CREDIT"),
}


# ---------------------------------------------------------------- revert / undo
def _strip_tally_notes(notes):
    """Remove Tally-stamp / reconciliation lines from a bill's notes, so a detached
    Scan + Tally bill no longer carries a Tally reference. Keeps the scan lines
    ("Created from scanned invoice", "Lines restored from scan")."""
    import re
    if not notes:
        return notes or ""
    pat = r"stamped Tally|Tally ID|RECON-SYNC|tally_pending"
    # Drop bracketed stamps even when inline, then any whole line still matching.
    txt = re.sub(r"\[[^\]]*(?:" + pat + r")[^\]]*\]", "", notes, flags=re.IGNORECASE)
    kept = [ln for ln in txt.splitlines() if not re.search(pat, ln, re.IGNORECASE)]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()


def revert_tally_vouchers(company, frm, to, scope="all", dry_run=True, category=None,
                          payments_only=False):
    """Undo a Tally transaction import: delete the invoices / bills / receipts /
    payments tagged with a `tally_guid` in this company + date range + scope,
    reversing any settlements they made, PLUS every OPENING carrier in range
    (those carry a blank guid and used to survive, leaving Outstanding non-zero
    while the sales tiles read zero), PLUS bank receipts/payments marked
    source='TALLY' (they have no guid — see the bank block below for why).
    Auto-created products are NOT deleted (they may be referenced elsewhere).
    Each delete runs in its own savepoint — a protected/referenced record is
    reported and skipped, never crashes.

    ERP-side only. Nothing here talks to Tally; the books are untouched."""
    from .models import (SalesInvoiceCheck, ReceivableLedger, ReceivablePayment,
                         DebitNote, ReceivableAdjustment, SalesOrder, DispatchChallan,
                         FreightDetailDCLink, FreightDCLink)
    from django.db.models import Q
    from purchase.models import (VendorBill, PaymentMade, PurchaseOrder, ReceiptAdvice,
                                 FreightAdviceInbound, FreightInward)
    from bank.models import BankAccount, BankPayment, BankReceipt
    s = {"sales": 0, "purchase": 0, "receipts": 0, "payments": 0, "notes": 0,
         "sales_orders": 0, "dispatch_challans": 0, "purchase_orders": 0, "grns": 0,
         "adjustments": 0, "opening_carriers": 0, "skipped_existing": 0,
         "bank_receipts": 0, "bank_payments": 0, "freight": 0, "freight_snapshots": 0,
         "detached": 0, "tds": 0, "errors": []}

    def _recompute_rl(rl):
        rl.balance = (rl.amount or Decimal("0")) - (rl.amount_paid or Decimal("0"))
        if (rl.amount or 0) > 0 and rl.balance <= 0:
            rl.payment_status = "PAID"
        elif (rl.amount_paid or 0) > 0:
            rl.payment_status = "PARTIALLY_PAID"
        else:
            rl.payment_status = "NOT_DUE"

    with transaction.atomic():
        if scope in ("all", "sales"):
            for rp in (ReceivablePayment.objects.exclude(tally_guid="")
                       .filter(payment_date__gte=frm, payment_date__lte=to,
                               receivable__customer__company=company)
                       .select_related("receivable")):
                try:
                    with transaction.atomic():
                        rl = rp.receivable
                        rl.amount_paid = max(Decimal("0"), (rl.amount_paid or Decimal("0")) - rp.amount)
                        _recompute_rl(rl)
                        rl.save(update_fields=["amount_paid", "balance", "payment_status"])
                        rp.delete()
                    s["receipts"] += 1
                except Exception as e:  # noqa: BLE001
                    s["errors"].append(f"receipt {rp.id}: {e}")
            for inv in (SalesInvoiceCheck.objects.exclude(tally_guid="")
                        .filter(invoice_date__gte=frm, invoice_date__lte=to, company=company)):
                try:
                    with transaction.atomic():
                        ReceivableLedger.objects.filter(invoice_reference=inv).delete()
                        inv.delete()
                    s["sales"] += 1
                except Exception as e:  # noqa: BLE001
                    s["errors"].append(f"invoice {inv.invoice_no}: {e}")
            # ── Orphan OPENING carriers ───────────────────────────────────
            # The loop above only takes rows carrying a `tally_guid`. Opening
            # carriers built by `import_opening_balances` do carry one
            # ("OPENING|<ledger>") and are already gone — but the ones the old
            # July import's leftover logic invented, and any hand-made during a
            # reconciliation, have a BLANK guid and survived. They are excluded
            # from Total Sales (tally_invoice_no='OPENING') yet COUNTED in
            # Outstanding, so a revert left the sales tiles at zero above a
            # non-zero — usually negative — Outstanding tile. SS Biochem had 8
            # of them worth Rs 5.45 Cr, including a Rs 5 Cr "ICICI Term Loan"
            # that is a bank ledger, not a customer at all. Sweep every OPENING
            # carrier in range so "revert" actually empties the module.
            for inv in SalesInvoiceCheck.objects.filter(
                    tally_invoice_no="OPENING", tally_guid="",
                    invoice_date__gte=frm, invoice_date__lte=to, company=company):
                try:
                    with transaction.atomic():
                        ReceivableLedger.objects.filter(invoice_reference=inv).delete()
                        inv.delete()
                    s["opening_carriers"] += 1
                except Exception as e:  # noqa: BLE001
                    s["errors"].append(f"opening carrier {inv.invoice_no}: {e}")
            # Reconstructed chain — sweep ALL import-built DCs then SOs in range
            # (catches orphans whose invoice link is already gone). DC before SO
            # (DCLine references SOLine). Import DCs always carry a tally_invoice_no;
            # import SOs carry the "Reconstructed from Tally import" remark — a
            # manually-created DC/SO has neither, so it is never touched.
            for dc in DispatchChallan.objects.exclude(tally_invoice_no="").filter(
                    dispatch_date__gte=frm, dispatch_date__lte=to, warehouse__company=company):
                try:
                    with transaction.atomic():
                        # Freight links PROTECT the DC — unlink them first (the
                        # freight detail/advice records themselves are kept).
                        FreightDetailDCLink.objects.filter(dc=dc).delete()
                        FreightDCLink.objects.filter(dc=dc).delete()
                        dc.delete()
                    s["dispatch_challans"] += 1
                except Exception as e:  # noqa: BLE001
                    s["errors"].append(f"DC {dc.dc_no}: {e}")
            for so in SalesOrder.objects.filter(
                    company=company, so_date__gte=frm, so_date__lte=to,
                    remarks__icontains="Reconstructed from Tally"):
                try:
                    with transaction.atomic():
                        so.delete()
                    s["sales_orders"] += 1
                except Exception as e:  # noqa: BLE001
                    s["errors"].append(f"SO {so.so_no}: {e}")
            # Opening-balance / journal adjustments on customer accounts.
            for adj in (ReceivableAdjustment.objects.exclude(tally_guid="")
                        .filter(date__gte=frm, date__lte=to, company=company)):
                try:
                    with transaction.atomic():
                        adj.delete()
                    s["adjustments"] += 1
                except Exception as e:  # noqa: BLE001
                    s["errors"].append(f"adjustment {adj.id}: {e}")
        if scope in ("all", "purchase"):
            # Optional category narrowing. When set, only that purchase_category's
            # bills go — and only payments LINKED to such a bill are reversed
            # (on-account / other-category payments are left alone), and freight is
            # touched only for FREIGHT (or no category). Blank = everything.
            cat = (category or "").strip().upper() or None
            # Two kinds of bill in range:
            #   DELETE  — pure Tally bills (source TALLY / TALLY_OPENING). No scan
            #             behind them, so they go entirely.
            #   DETACH  — "Scan + Tally": a SCANNED bill (source MANUAL) that was
            #             stamped with a Tally guid. The scan is real data we keep;
            #             we only strip the Tally link + narration so it reads as a
            #             plain Scan again. Pure scans (no guid) are never touched.
            # "Scanned" exactly as the Bills list decides it (so detach/delete match
            # the on-screen Scan / Scan+Tally / Tally badges): a CONFIRMED scan
            # record, a scan-* attachment, or the "Created from scanned/emailed"
            # note. Classifying by this — NOT by `source` — is what stops a scanned
            # bill whose source was flipped to TALLY from being wrongly DELETED.
            from django.db.models import Exists, OuterRef
            from ai_parser.scan_models import InvoiceScanBill
            from purchase.models import PurchaseAttachment
            scan_rec = InvoiceScanBill.objects.filter(
                Q(matched_bill=OuterRef('pk')) | Q(created_bill=OuterRef('pk')),
                status='CONFIRMED')
            scan_att = PurchaseAttachment.objects.filter(
                module='BILL', record_id=OuterRef('pk'), file_name__istartswith='scan')
            # ANY attachment at all — a bill that carries an invoice/document copy
            # (e.g. "Blow.pdf" uploaded by hand, which the scan-* test misses) must
            # NEVER be deleted, or that copy is lost. Having a document is a KEEP
            # signal in its own right, on top of the scan signals above.
            any_att = PurchaseAttachment.objects.filter(
                module='BILL', record_id=OuterRef('pk'))
            keep_q = (Q(_scan_rec=True) | Q(_scan_att=True) | Q(_has_att=True)
                      | Q(notes__icontains='scanned invoice')
                      | Q(notes__icontains='from scanned')
                      | Q(notes__icontains='emailed bill')
                      | Q(notes__icontains='email bill inbox'))

            base = (VendorBill.objects
                    .filter(bill_date__gte=frm, bill_date__lte=to, vendor__company=company)
                    .annotate(_scan_rec=Exists(scan_rec), _scan_att=Exists(scan_att),
                              _has_att=Exists(any_att)))
            if cat:
                base = base.filter(purchase_category=cat)
            # KEEP ONLY what we scanned (or that carries a document copy). DELETE
            # every OTHER bill in the period — Tally, Zoho, OPENING carriers, or a
            # hand-keyed bill with no scan/copy. A kept bill that ALSO carries a
            # Tally guid is DETACHED (Tally link + narration stripped) rather than
            # left as "Scan + Tally".
            delete_qs = base.exclude(keep_q)
            detach_qs = (base.filter(keep_q)
                         .exclude(tally_guid="")
                         .exclude(tally_guid__startswith="OPENING"))
            delete_ids = list(delete_qs.values_list("id", flat=True))
            detach_ids = list(detach_qs.values_list("id", flat=True))
            # Payments-only mode: wipe the period's payments and reset paid status,
            # but touch NO bills (no detach, no delete, no freight).
            if payments_only:
                delete_ids, detach_ids = [], []
            affected_ids = set(delete_ids) | set(detach_ids)

            # Payments FIRST — the WHOLE payment set for this company in the period
            # (every PaymentMade with payment_date in range, whatever bill it names
            # or none at all: Tally, bank, on-account), PLUS any payment on an
            # affected bill even if dated outside the window. Deleting wholesale is
            # deliberate: the period is being rebuilt, so nothing on it is kept.
            # Every bill that loses a payment is remembered so its paid figure is
            # recomputed afterwards — including pure-scan bills we otherwise leave
            # alone (those stay, but go back to OPEN).
            touched_bill_ids = set()
            try:
                with transaction.atomic():
                    if cat:
                        pay_qs = PaymentMade.objects.filter(
                            bill_id__in=affected_ids)
                    else:
                        pay_qs = PaymentMade.objects.filter(
                            Q(vendor__company=company, payment_date__gte=frm, payment_date__lte=to)
                            | Q(bill_id__in=affected_ids))
                    touched_bill_ids = set(
                        pay_qs.exclude(bill__isnull=True).values_list("bill_id", flat=True))
                    s["payments"] += pay_qs.count()
                    pay_qs.delete()
            except Exception as e:  # noqa: BLE001
                s["errors"].append(f"payments: {e}")

            # DETACH the scan + Tally bills — keep them, strip the Tally identity +
            # narration, reset paid (all their payments are gone now).
            for bill in VendorBill.objects.filter(id__in=detach_ids):
                try:
                    with transaction.atomic():
                        bill.tally_guid = ""
                        bill.tally_voucher_type = ""
                        bill.tally_hash = ""
                        bill.source = "MANUAL"   # it is a pure scan now, not Tally
                        bill.notes = _strip_tally_notes(bill.notes)
                        paid = (PaymentMade.objects.filter(bill_id=bill.id)
                                .exclude(status="CANCELLED")
                                .aggregate(t=Sum("amount"))["t"]) or Decimal("0")
                        bill.amount_paid = paid
                        bill.status = ("PAID" if paid >= bill.total_amount and bill.total_amount > 0
                                       else "PARTIALLY_PAID" if paid > 0 else "OPEN")
                        bill.save(update_fields=["tally_guid", "tally_voucher_type",
                                                 "tally_hash", "source", "notes",
                                                 "amount_paid", "status", "updated_at"])
                    s["detached"] = s.get("detached", 0) + 1
                except Exception as e:  # noqa: BLE001
                    s["errors"].append(f"detach {bill.bill_no}: {e}")

            # DELETE the pure-Tally bills — one bulk query (lines cascade), so a
            # 200+ bill revert is one round-trip, not one per bill. Fall back to
            # per-row only if the bulk delete errors, so one bad row can't block
            # the rest.
            if delete_ids:
                try:
                    with transaction.atomic():
                        VendorBill.objects.filter(id__in=delete_ids).delete()
                    s["purchase"] += len(delete_ids)
                except Exception:  # noqa: BLE001
                    for bill in VendorBill.objects.filter(id__in=delete_ids):
                        try:
                            with transaction.atomic():
                                bill.delete()
                            s["purchase"] += 1
                        except Exception as e:  # noqa: BLE001
                            s["errors"].append(f"bill {bill.bill_no}: {e}")

            # Rebuild paid/status on bills that lost a payment but were NOT detached
            # (already done) or deleted (gone) — e.g. a pure-scan bill whose period
            # payment was in the wipe. Without this they would read PAID with no
            # payment behind them.
            for bill in VendorBill.objects.filter(
                    id__in=(touched_bill_ids - set(detach_ids) - set(delete_ids))):
                try:
                    with transaction.atomic():
                        paid = (PaymentMade.objects.filter(bill_id=bill.id)
                                .exclude(status="CANCELLED")
                                .aggregate(t=Sum("amount"))["t"]) or Decimal("0")
                        new_status = ("PAID" if paid >= bill.total_amount and bill.total_amount > 0
                                      else "PARTIALLY_PAID" if paid > 0 else "OPEN")
                        if bill.amount_paid != paid or bill.status != new_status:
                            bill.amount_paid = paid
                            bill.status = new_status
                            bill.save(update_fields=["amount_paid", "status", "updated_at"])
                except Exception as e:  # noqa: BLE001
                    s["errors"].append(f"repaid {bill.bill_no}: {e}")
            # Tally freight: the snapshot (FreightInward, has company + date) and
            # separate-slip advices created by the Tally freight reconcile (carry a
            # tally_guid; company reached via receipt / bill / transporter). Invoice-
            # included freight is NOT handled here — it CASCADES when its bill is
            # deleted above. Scanned/operational freight (blank guid) is never touched.
            # Skipped entirely when a non-freight category is selected, or in
            # payments-only mode (which touches no bills/freight).
            if not payments_only and cat in (None, "FREIGHT"):
                from purchase.models import LocalFreight
                from sales.models import FreightAdviceOutbound
                # 1) Inward snapshot (FreightInward — Tally Freight-Inward ledger).
                try:
                    with transaction.atomic():
                        fin = FreightInward.objects.filter(
                            company=company, voucher_date__gte=frm, voucher_date__lte=to)
                        s["freight_snapshots"] = fin.count()
                        fin.delete()
                except Exception as e:  # noqa: BLE001
                    s["errors"].append(f"freight snapshot: {e}")
                in_window = (Q(freight_date__gte=frm, freight_date__lte=to)
                             | Q(freight_date__isnull=True,
                                 created_at__date__gte=frm, created_at__date__lte=to))

                def _wipe(qs, label):
                    """Delete each freight row, payments cascade; per-row so a
                    PROTECT (e.g. a DC link) is reported, not a crash."""
                    for row in qs:
                        try:
                            with transaction.atomic():
                                row.delete()
                            s["freight"] = s.get("freight", 0) + 1
                        except Exception as e:  # noqa: BLE001
                            s["errors"].append(f"{label} {row.pk}: {e}")

                # 2) ALL inward advices for the company (Tally AND operational).
                _wipe(FreightAdviceInbound.objects.filter(in_window).filter(
                    Q(receipt_advice__warehouse__company=company)
                    | Q(vendor_bill__vendor__company=company)
                    | Q(transporter__company=company)), "freight-in")
                # 3) ALL outward advices (Excel/bank register — no Tally link).
                _wipe(FreightAdviceOutbound.objects.filter(in_window).filter(
                    Q(company=company) | Q(warehouse__company=company)), "freight-out")
                # 4) Standalone local freight (in/out/stock-transfer charges).
                _wipe(LocalFreight.objects.filter(
                    company=company, date__gte=frm, date__lte=to), "local-freight")
            # TDS Payable register (Tally snapshot). Not category-specific, so only
            # on a full (no-category) wash-out. Skipped in payments-only mode.
            if not payments_only and cat is None:
                from purchase.models import TdsPayable
                try:
                    with transaction.atomic():
                        tds = TdsPayable.objects.filter(
                            company=company, voucher_date__gte=frm, voucher_date__lte=to)
                        s["tds"] = tds.count()
                        tds.delete()
                except Exception as e:  # noqa: BLE001
                    s["errors"].append(f"tds: {e}")
            # Reconstructed chain — sweep ALL import-built GRNs then POs in range
            # (incl orphans). Both carry the "Reconstructed from Tally import"
            # marker; manual PO/GRN do not, so they are never touched. Skipped when
            # a category is selected: a category-scoped revert stays to bills, their
            # payments and (for FREIGHT) freight — it must not sweep the whole chain.
            if cat is None:
                for grn in ReceiptAdvice.objects.filter(
                        warehouse__company=company, receipt_date__gte=frm, receipt_date__lte=to,
                        remarks__icontains="Reconstructed from Tally"):
                    try:
                        with transaction.atomic():
                            grn.delete()
                        s["grns"] += 1
                    except Exception as e:  # noqa: BLE001
                        s["errors"].append(f"GRN {grn.id}: {e}")
                for po in PurchaseOrder.objects.filter(
                        company=company, po_date__gte=frm, po_date__lte=to,
                        terms_and_conditions__icontains="Reconstructed from Tally"):
                    try:
                        with transaction.atomic():
                            po.delete()
                        s["purchase_orders"] += 1
                    except Exception as e:  # noqa: BLE001
                        s["errors"].append(f"PO {po.id}: {e}")
        # Debit/Credit notes + bank vouchers are not category-tagged, so a
        # category-scoped revert leaves them alone (only a full, no-category revert
        # sweeps them).
        cat_all = (category or "").strip().upper() or None
        # Debit/Credit notes tagged from Tally, in-range, for this company.
        if cat_all is None:
            side_filter = {"all": None, "sales": "SALES", "purchase": "PURCHASE"}.get(scope)
            note_qs = (DebitNote.objects.exclude(tally_guid="")
                       .filter(note_date__gte=frm, note_date__lte=to, company=company))
            if side_filter:
                note_qs = note_qs.filter(side=side_filter)
            for dn in note_qs:
                try:
                    with transaction.atomic():
                        dn.delete()
                    s["notes"] += 1
                except Exception as e:  # noqa: BLE001
                    s["errors"].append(f"note {dn.note_no}: {e}")

        # Bank vouchers. These arrive by a different door — bank.tally_import
        # reads a Tally bank-book EXCEL export, not the XML gateway — so they
        # carry no tally_guid and used to survive a revert entirely. Left
        # behind, they drift further from the books with every
        # revert/re-import cycle, and they silently weaken the duplicate guard
        # in fix_misfiled_notes, which decides whether a note is a second copy
        # of a bank voucher by looking these rows up.
        #
        # BANK PAYMENTS are wiped WHOLESALE for the period (any source — Tally,
        # imported, or hand-keyed), matching the vendor-payment wipe above: the
        # period is being rebuilt. Bank RECEIPTS stay conservative (Tally-sourced
        # only) — they are the sales side, not part of this purchase wash-out.
        # `all_rows` selects which.
        for model, date_field, key, want_scope, all_rows in (
                (BankReceipt, "receipt_date", "bank_receipts", "sales", False),
                (BankPayment, "payment_date", "bank_payments", "purchase", True)):
            if scope not in ("all", want_scope) or cat_all is not None:
                continue
            qs = model.objects.filter(
                company=company,
                **{f"{date_field}__gte": frm, f"{date_field}__lte": to})
            if not all_rows:
                qs = qs.filter(source="TALLY")
            for row in qs:
                try:
                    with transaction.atomic():
                        row.delete()
                    s[key] += 1
                except Exception as e:  # noqa: BLE001
                    s["errors"].append(f"bank {row.voucher_no}: {e}")

        # Rebuild every touched account's running balance. The importer keeps
        # current_balance = opening + receipts - payments; deleting rows under
        # it without recomputing would leave the Bank dashboard reporting a
        # balance for money that is no longer in the table.
        if s["bank_receipts"] or s["bank_payments"]:
            for acct in BankAccount.objects.filter(company=company):
                rec = (BankReceipt.objects.filter(bank_account=acct)
                       .aggregate(t=Sum("amount"))["t"] or Decimal("0"))
                pay = (BankPayment.objects.filter(bank_account=acct)
                       .aggregate(t=Sum("amount"))["t"] or Decimal("0"))
                acct.current_balance = (acct.opening_balance or Decimal("0")) + rec - pay
                acct.save(update_fields=["current_balance", "updated_at"])

        if dry_run:
            transaction.set_rollback(True)
    s["errors"] = s["errors"][:50]
    return s


def _make_cancel_checker(job_id):
    """A cheap callable: has this TallyImportJob been cancelled?

    No `job_id` (a caller that doesn't support cancelling, e.g. the CLI) ->
    a checker that always says False without touching the database at all.
    """
    if not job_id:
        return lambda: False
    from .models import TallyImportJob

    def _check():
        return TallyImportJob.objects.filter(id=job_id, cancelled=True).exists()
    return _check


def import_tally_vouchers(vouchers, company, created_by=None, dry_run=True, scope="all",
                          outstanding=None, tally_company="", enrich=True, ledgers=None,
                          job_id=None, vtype_masters=None):
    """Two passes: create invoices/bills first, then apply receipts/payments so
    they can settle the docs just created. Returns a JSON-able summary.

    `scope` limits which sides are imported:
      "sales"    -> only Sales invoices + Receipts (receivables)
      "purchase" -> only Purchase bills + Payments made
      "all"      -> everything (default; used by the CLI).

    `job_id` is an optional TallyImportJob id (see sales.models) the caller
    created for this run. Checked between every voucher so the Cancel button
    can stop an in-progress import: whatever already committed (each voucher
    has its own savepoint below) stays, nothing further is processed."""
    ctx = _Ctx(company, created_by, dry_run)
    cancel_checker = _make_cancel_checker(job_id)
    # Pull Tally masters once so every voucher can enrich party GST/state/address
    # and line HSN/GST-rate that the vouchers themselves don't carry.
    tco = tally_company or (getattr(company, "legal_name", "") if company else "")
    # enrich=False (file/offline import) skips ALL gateway master lookups so the
    # import never touches Tally — the uploaded Day Book already carries the party
    # + tax + line amounts we reconcile on. (Gateway master fetches are small and
    # safe, but pointless — and slow when the gateway is down — for a file import.)
    ctx.ledger_master, ctx.stock_master, ctx.bill_due_map = {}, {}, {}
    # Ledger master passed in (e.g. a Master.xml export → [{name, parent, ...}]) —
    # gives each ledger's PARENT group so receipt legs into loan/bank/branch groups
    # are excluded from customer collections even on an offline file import
    # (enrich=False), where the gateway fetch never runs.
    if ledgers:
        ctx.ledger_master = {l["name"].strip(): l for l in ledgers if l.get("name")}
    if enrich:
        from .tally_import import fetch_ledgers, fetch_stock_items
        # Every enrichment read below must survive TallyPending.
        #
        # In connector mode a read does not block: it is parked for the on-prem
        # agent and TallyPending is raised at once. TallyPending subclasses
        # BaseException DELIBERATELY, so `except Exception` cannot see it — and
        # these handlers were written with `except Exception`, which made a
        # perfectly normal parked read tear the whole import down. Measured
        # 2026-09-08: an August re-import fetched its 1,743 vouchers fine and
        # then died inside fetch_stock_items, whose own comment says it is
        # "best-effort, returns {} on error".
        #
        # Enrichment is exactly that — nice to have. It must never stop an
        # import that already has its vouchers.
        try:
            if not ctx.ledger_master:            # don't overwrite a passed-in master
                _lg, _ = fetch_ledgers(tco)
                ctx.ledger_master = {l["name"].strip(): l for l in _lg if l.get("name")}
        except BaseException:  # noqa: BLE001 — enrichment is best-effort, never blocks import
            # Keep a master the CALLER supplied (ledgers=) — the gateway failing
            # says nothing about a file import that brought its own.
            ctx.ledger_master = ctx.ledger_master or {}
            # Only when we still have nothing is the customer/non-customer split
            # unsafe. That is not enrichment, so flag it and let the money side
            # refuse rather than guess — see _ledger_master_required.
            if not ctx.ledger_master:
                ctx.ledger_master_failed = True
        try:
            ctx.stock_master = fetch_stock_items(tco)
        except BaseException:  # noqa: BLE001 — see the note above; TallyPending included
            ctx.stock_master = {}
        # Real per-bill due dates (bill date + BILLCREDITPERIOD) — the voucher XML
        # doesn't carry them, so pull Tally's Bills-Outstanding report once.
        try:  # noqa: BLE001 below — TallyPending must not stop the import either
            from .tally_import import fetch_bill_outstanding
            _bills, _ = fetch_bill_outstanding(tco, timeout=180)
            ctx.bill_due_map = _bill_due_map(_bills)
        except BaseException:  # noqa: BLE001 — TallyPending included; see the note above
            ctx.bill_due_map = {}
    # Sales-side voucher types go through the gate: a type nobody has approved
    # yet is HELD and listed for a decision instead of being guessed at from its
    # name. `vtype_masters` is Tally's own {type: base type}; see
    # voucher_type_gate. Purchase-side types pass through exactly as before.
    from .voucher_type_gate import VoucherTypeGate, HELD, SKIPPED
    gate = VoucherTypeGate(company, vtype_masters, vouchers, created_by)
    if scope == "sales":
        doc_cats, money_cats = ("sales",), ("receipt",)
    elif scope == "purchase":
        doc_cats, money_cats = ("purchase",), ("payment",)
    elif scope == "expense":
        doc_cats, money_cats = (), ("payment",)
    else:
        doc_cats, money_cats = ("sales", "purchase"), ("receipt", "payment")
    docs = [v for v in vouchers if gate.kind(v["vtype"]) in doc_cats]
    money = [v for v in vouchers if gate.kind(v["vtype"]) in money_cats]
    # Freight scope: also collect Journal / GST-Journal vouchers that create a
    # freight liability (Freight Outward Charges debit + transporter credit).
    # These are classified as "other" by the gate (Journal is not recognised as
    # a purchase type), so they never reach `docs`. We collect them separately
    # and import them as VendorBill(FREIGHT) before the payment pass, so the
    # Agst Ref on each payment can resolve to the bill just created.
    freight_journals = []
    if scope == "freight":
        for v in vouchers:
            vkind = gate.kind(v["vtype"])
            if vkind in doc_cats or vkind in money_cats or vkind in ("debit_note", "credit_note", "held", "skipped"):
                continue
            if any(_is_freight_outward_ledger(lg.get("ledger", ""))
                   or _is_freight_ledger_by_group(lg.get("ledger", ""), ctx)
                   for lg in v.get("ledgers", [])):
                freight_journals.append(v)
        ctx.summary["freight_journals_found"] = len(freight_journals)
        fj_vtypes = {}
        for v in freight_journals:
            vt = v.get("vtype") or "(blank)"
            fj_vtypes[vt] = fj_vtypes.get(vt, 0) + 1
        ctx.summary["freight_journal_vtypes"] = fj_vtypes
    expense_journals = []
    if scope == "expense":
        _expense_vtypes = ("journal", "gst journal", "cash", "cash payment")
        for v in vouchers:
            if (v.get("vtype") or "").strip().lower() not in _expense_vtypes:
                continue
            if any("freight" in (lg.get("ledger") or "").lower()
                   or _is_freight_ledger_by_group(lg.get("ledger", ""), ctx)
                   for lg in v.get("ledgers", [])):
                continue
            if any(_is_expense_group_ledger((lg.get("ledger") or "").strip(), ctx)
                   for lg in v.get("ledgers", [])
                   if (lg.get("amount") or Decimal("0")) < 0):
                expense_journals.append(v)
        ctx.summary["expense_journals_found"] = len(expense_journals)
    # A receipt's legs are split into customer / not-customer by the same rule the
    # adjustments importer uses, so the same refusal applies: if the gateway was
    # asked for the ledger master and did not answer, every leg would read as a
    # customer credit. Documents (invoices/bills) are unaffected — they resolve a
    # named party, not a group — so only the money side is held back.
    if money and getattr(ctx, "ledger_master_failed", False):
        ctx.summary["errors"].append(
            f"receipts/payments: REFUSED {len(money)} voucher(s) — Tally's ledger "
            f"master could not be fetched, so a customer ledger cannot be told "
            f"from a transporter or an expense. Re-run when the gateway answers.")
        money = []
    # Debit/Credit notes import in every scope — their side (sales/purchase) is
    # decided per-voucher from the party group, and re-import is deduped.
    notes = [v for v in vouchers if gate.kind(v["vtype"]) in ("debit_note", "credit_note")]
    # ── Everything we are NOT importing, named ────────────────────────────
    # `classify` reads Tally's VOUCHERTYPENAME, and voucher types are whatever
    # the user called them. Anything it doesn't recognise becomes "other" and is
    # dropped in silence — which is how United Agro's "GST Rent" (01/26-27,
    # Radha Feeds, Rs 11,800) went missing: Tally counts it in the Sales
    # Register and files it in GSTR-1 B2B, the ERP never saw it, and April sat
    # Rs 11,800 short with nothing on screen to say why.
    #
    # Most 'other' types are genuinely not sales (Contra, Stock Journal, Payroll)
    # and their vouchers are not in the doc/money/notes buckets either, so this
    # counts what was left behind and lets the operator judge. Value is the
    # party-side total, which is what a Sales Register row shows.
    _handled = set(doc_cats) | set(money_cats) | {"debit_note", "credit_note"}
    _skipped = {}
    for v in vouchers:
        _k = gate.kind(v["vtype"])
        if _k in _handled:
            continue
        if _k in (HELD, SKIPPED):
            # Reported on the Voucher types tab, not in the generic list below.
            try:
                _val = abs(_split_ledgers(v)[0])
            except Exception:  # noqa: BLE001
                _val = Decimal("0")
            gate.note(v, _k, _val)
            continue
        row = _skipped.setdefault(v["vtype"] or "(unnamed)", {"n": 0, "value": Decimal("0")})
        row["n"] += 1
        try:
            row["value"] += abs(_split_ledgers(v)[0])
        except Exception:  # noqa: BLE001 — a count still beats no report
            pass
    ctx.summary["skipped_types"] = [
        {"vtype": k, "count": v["n"], "value": str(v["value"].quantize(Decimal("0.01")))}
        for k, v in sorted(_skipped.items(), key=lambda kv: -kv[1]["value"])
    ][:25]
    ctx.summary["new_voucher_types"], ctx.summary["skipped_voucher_types"] = gate.summary()

    def _one(v):
        # Each voucher gets its OWN savepoint: if it fails, only that voucher
        # rolls back (records it created are undone) — the rest of the batch is
        # unaffected and its error is reported. One bad voucher never poisons
        # the transaction or discards the good imports.
        try:
            with transaction.atomic():
                HANDLERS[gate.kind(v["vtype"])](v, ctx)
        except Exception as e:  # noqa: BLE001
            ctx.summary["errors"].append(f"{v['vtype']} {v['number']}: {e}")

    _vc_plan = {"plan": None}

    def _run():
        # Checked before EVERY voucher (not just periodically) — a single
        # indexed lookup by primary key is cheap next to the several DB writes
        # each voucher itself makes, and responsiveness is the point of a
        # Cancel button. `remaining` counts what Cancel stopped short of, so
        # the summary can say so instead of looking like a quiet undercount.
        remaining = 0
        # Vouchers already imported but changed / deleted in Tally since: see
        # voucher_changes. Found here, saved after the transaction (commit).
        # Changed-in-Tally detection is sales-side only; skip for purchase/freight.
        if scope not in ("freight", "purchase", "expense"):
            try:
                from .voucher_changes import detect
                with transaction.atomic():     # own savepoint: a failure stays contained
                    _vc_plan["plan"] = detect(vouchers, company, ctx, gate)
            except Exception as e:  # noqa: BLE001 -- a check must never stop an import
                ctx.summary["errors"].append(f"changed-in-Tally check: {e}")
        # Freight scope only processes freight journals + payments — invoices
        # and credit/debit notes are not part of this import, and re-running
        # the purchase invoice path causes UNIQUE constraint errors when bills
        # already exist in the DB with a different or missing tally_guid.
        if scope not in ("freight", "expense"):
            for i, v in enumerate(docs):
                if cancel_checker():
                    remaining += len(docs) - i + len(notes) + len(money)
                    ctx.summary["cancelled"] = True
                    ctx.summary["cancelled_remaining"] = remaining
                    return
                _one(v)
            for i, v in enumerate(notes):  # after invoices/bills so 'against ref' can resolve
                if cancel_checker():
                    remaining += len(notes) - i + len(money)
                    ctx.summary["cancelled"] = True
                    ctx.summary["cancelled_remaining"] = remaining
                    return
                _one(v)
        # Freight journals: bills before payments so Agst Ref can resolve
        for i, v in enumerate(freight_journals):
            if cancel_checker():
                remaining += len(freight_journals) - i + len(money)
                ctx.summary["cancelled"] = True
                ctx.summary["cancelled_remaining"] = remaining
                return
            try:
                with transaction.atomic():
                    _import_freight_journal(v, ctx)
            except Exception as e:  # noqa: BLE001
                ctx.summary["errors"].append(f"{v.get('vtype')} {v.get('number')}: {e}")
        # Freight scope: backfill INVOICE_INCLUDED FAs for existing purchase
        # bills that have Freight Inward Charges but lost their FA after a
        # freight revert.  Runs BEFORE payments so the FA exists when we sync.
        if scope == "freight" and company and not ctx.dry_run:
            try:
                _backfill_inbill_freight_fas(company, ctx)
            except Exception as e:  # noqa: BLE001
                ctx.summary["errors"].append(f"inbill FA backfill: {e}")
        for i, v in enumerate(expense_journals):
            if cancel_checker():
                remaining += len(expense_journals) - i + len(money)
                ctx.summary["cancelled"] = True
                ctx.summary["cancelled_remaining"] = remaining
                return
            try:
                with transaction.atomic():
                    _import_expense_journal(v, ctx)
            except Exception as e:  # noqa: BLE001
                ctx.summary["errors"].append(f"{v.get('vtype')} {v.get('number')}: {e}")
        if scope == "expense" and not ctx.dry_run:
            try:
                _resettle_expense_payments(money, ctx)
            except Exception as e:  # noqa: BLE001
                ctx.summary["errors"].append(f"expense payment resettle: {e}")
            try:
                _resettle_remaining_on_account(company, ctx)
            except Exception as e:  # noqa: BLE001
                ctx.summary["errors"].append(f"expense on-account sweep: {e}")
        for i, v in enumerate(money):
            if cancel_checker():
                remaining += len(money) - i
                ctx.summary["cancelled"] = True
                ctx.summary["cancelled_remaining"] = remaining
                return
            _one(v)
        # After payments settle freight bills, sync FA paid/balance/status
        # so the Inward Freight page reflects Tally's actual payment state.
        if scope == "freight" and company and not ctx.dry_run:
            try:
                _sync_freight_fa_from_bills(company, ctx)
            except Exception as e:  # noqa: BLE001
                ctx.summary["errors"].append(f"freight FA payment sync: {e}")

    if dry_run:
        with transaction.atomic():
            _run()
            transaction.set_rollback(True)
    else:
        with transaction.atomic():
            _run()
            # Compare against Tally's Bills Outstanding and REPORT what
            # disagrees. This used to overwrite amount_paid across the whole
            # year on every import, which is what kept undoing corrections and
            # left balances with no document behind them — see
            # reconcile_outstanding. It writes nothing now.
            if outstanding is not None:
                ctx.summary["outstanding_check"] = reconcile_outstanding(
                    company, outstanding)
            # Cash parked by an EARLIER run because the invoice it named did not
            # exist yet. This run may have just created it — so re-resolve every
            # pending reference and settle what can now be settled. Without this
            # the parking is permanent and the bill reads unpaid for ever (see
            # reapply_parked_receipts).
            if "receipt" in money_cats:
                ctx.summary["reapplied"] = reapply_parked_receipts(
                    company, created_by=created_by)

    # ── Journal / Contra credits on customer accounts ─────────────────────
    # `import_receivable_adjustments` was written, and the dashboard already has
    # a `journal_contra` line waiting for it in the Amount Received breakdown —
    # but nothing ever CALLED it. So that line read 0.00 every month and every
    # journal or contra crediting a debtor was simply absent. United Agro May
    # 2026: Received came to Rs 7,53,09,648.25 against Tally's Sundry Debtors
    # Credit column of Rs 11,21,00,159.75, and the whole Rs 3,67,90,511.50 gap
    # was this. April looked fine only because April had none.
    #
    # Runs in every scope that imports receipts (sales side), after the vouchers
    # so a journal against an invoice has something to sit beside. Best-effort:
    # an adjustment that fails must not take the voucher import down with it.
    if "receipt" in money_cats and enrich:
        try:
            ctx.summary["adjustments"] = import_receivable_adjustments(
                vouchers, company, created_by=created_by, dry_run=dry_run,
                tally_company=tally_company or "",
                ledger_master=ctx.ledger_master or None)
        except BaseException as e:  # noqa: BLE001 — TallyPending is BaseException
            ctx.summary["errors"].append(f"receivable adjustments: {e}")

    # ── Journal / Contra debits on vendor accounts ───────────────────────
    # Mirrors the receivable adjustments above but for Sundry CREDITORS.
    # A journal that DEBITS a creditor reduces the payable — discounts,
    # loading deductions, inter-vendor transfers. The regular payment
    # importer only handles Payment vouchers, so these are invisible.
    if "payment" in money_cats and enrich:
        try:
            ctx.summary["payable_adjustments"] = import_payable_adjustments(
                vouchers, company, created_by=created_by, dry_run=dry_run,
                tally_company=tally_company or "",
                ledger_master=ctx.ledger_master)
        except BaseException as e:  # noqa: BLE001 — TallyPending is BaseException
            ctx.summary["errors"].append(f"payable adjustments: {e}")

    s = ctx.summary
    s["changed_vouchers"], s["deleted_vouchers"], s["voucher_change_warnings"] = [], [], []
    if _vc_plan["plan"] is not None:
        try:
            from .voucher_changes import commit
            (s["changed_vouchers"], s["deleted_vouchers"],
             s["voucher_change_warnings"]) = commit(
                _vc_plan["plan"], company, created_by, stamp=not dry_run)
        except Exception as e:  # noqa: BLE001
            s["errors"].append(f"changed-in-Tally check: {e}")
    s["unmatched_customers"] = sorted(s["unmatched_customers"])
    s["unmatched_vendors"] = sorted(s["unmatched_vendors"])
    s["new_products"] = sorted(s["new_products"])
    if "unmatched_note_parties" in s:
        s["unmatched_note_parties"] = sorted(s["unmatched_note_parties"])
    # Receipt legs refused as non-customer money, biggest first, with the Tally
    # group that decided it. Reported rather than dropped quietly: if a genuine
    # customer ever lands here, this is where it shows up.
    if "non_customer_receipts" in s:
        s["non_customer_receipts"] = [
            {"ledger": k, "group": v["group"], "count": v["n"],
             "amount": str(v["amount"].quantize(Decimal("0.01")))}
            for k, v in sorted(s["non_customer_receipts"].items(),
                               key=lambda kv: -kv[1]["amount"])
        ][:25]
    # ── Mirror summary: month by month, Tally vs what we created ──────────
    # Flattened to a sorted, JSON-able list so the import screen can show it as
    # a table. `ok` is the whole point — every month must read True, and if one
    # doesn't you can see the exact rupee gap before trusting any tile.
    s["mirror"] = [
        {"month": k,
         "vouchers": v["n"],
         "tally": str(v["tally"].quantize(Decimal("0.01"))),
         "erp": str(v["erp"].quantize(Decimal("0.01"))),
         "diff": str((v["erp"] - v["tally"]).quantize(Decimal("0.01"))),
         "ok": abs(v["erp"] - v["tally"]) <= Decimal("0.005")}
        for k, v in sorted(s.pop("mirror_month", {}).items())
    ]
    s["mirror_ok"] = all(r["ok"] for r in s["mirror"])
    # ── Notes mirror: Tally's Debit/Credit Note Register vs what we wrote ──
    # Separate from the value mirror above, which only measures sales vouchers
    # and therefore read green through all five months while 13 notes were being
    # dropped. A count is enough here: a note that fails to import fails whole.
    s["notes_mirror"] = [
        {"month": k, "tally": v["tally"], "erp": v["erp"],
         "missing": v["tally"] - v["erp"], "ok": v["tally"] == v["erp"]}
        for k, v in sorted(s.pop("notes_month", {}).items())
    ]
    s["notes_mirror_ok"] = all(r["ok"] for r in s["notes_mirror"])
    return s


# ---------------------------------------------------------------- reconciliation
def reconcile_outstanding(company, bills):
    """COMPARE each imported invoice / bill against Tally's Bills Outstanding
    and REPORT the differences. Writes nothing.

    It used to overwrite `amount_paid` and `balance` on every document the
    report mentioned, and that is what kept dragging the ERP away from Tally:

      * It reached across the WHOLE YEAR. Import September, and April's bills
        were rewritten too — silently. Every correction made before it died the
        next time anyone imported anything.
      * It trusted an incomplete report. Bills Outstanding "omits credit
        balances entirely and mixes in supplier advances" (see `_out`). So
        credit balances were lost — KSE Rs 1,096 Cr became Rs 2,09,449 Dr, SPAC
        Rs 1,50,933.50 Cr became Rs 90,605.11 Dr, I Botanic's Rs 2,00,000 Cr
        vanished — and six customer-and-supplier parties Tally nets into
        creditors came back as debtors, Rs 64,63,211 of them.
      * A bill Tally settled by JOURNAL rather than against the bill still
        reads open in that report, so Biogreen's Rs 86,99,842 and T.Stanes'
        DN-006 Rs 96,72,075 were re-opened.
      * Worst of all it left a balance with NO DOCUMENT behind it. A bill would
        say "owed" while its own invoice, receipts and notes added up to
        something else, and nobody could explain the number to a customer.
        That is exactly the state Bliss Corp had to be rebuilt out of: 23
        invoices marked PAID carrying amount_paid = 0.00.

    Measured on SS Biochem 2026-09-07: this function alone accounted for the
    entire Rs 2,78,16,050.61 gap against Tally's Sundry Debtors closing.

    A balance now comes only from documents — invoice, receipts, notes,
    adjustments — via `resync_receivable`, which is self-healing and auditable.
    The report is still worth reading, so it is kept as a WARNING: every bill
    where the ERP and Tally disagree is listed on the import screen, with both
    figures, for a human to judge.

    Returns a stats dict plus `diffs`, the bills that disagree.
    """
    import re
    from .models import SalesInvoiceCheck, ReceivableLedger
    from purchase.models import VendorBill

    def _n(s):
        return re.sub(r"[^a-z0-9]", "", str(s or "").lower())

    omap, omap_ref = {}, {}
    for b in bills:
        amt = abs(b.get("closing") or Decimal("0"))
        p, r = _n(b.get("parent")), _n(b.get("name"))
        omap[(p, r)] = amt
        # Ref alone (bill/invoice numbers are ~unique per company) — used as a
        # fallback when the ERP party name differs from Tally's (mapped party).
        omap_ref[r] = amt

    def _out(party, ref, total):
        """Tally's outstanding for this bill, or None if Tally never mentions it.

        `None` is NOT zero. Returning 0 for an unlisted bill is what made this
        function manufacture phantom payments: Bills Outstanding is not a
        complete receivables list — it omits credit balances entirely and mixes
        in supplier advances — so a genuinely open invoice can simply be absent.
        Treating that as "fully settled" then overwrote a correct, receipt-
        derived balance with zero.

        Measured on a clean SS Biochem import (2026-08-29): Kriya Biosys came
        out with amount_paid Rs 14,38,01,151 against only Rs 11,67,00,000 of
        actual ReceivablePayment rows — Rs 2,71,01,151 of payments that never
        existed — and its Outstanding read 0 where Tally says Rs 2,71,01,151.
        T.Stanes went the other way, amount_paid Rs 6,19,99,647 against
        Rs 8,06,08,462 of real payments. Together they are most of a Rs 95 lakh
        gap against Tally's Sundry Debtors.
        """
        amt = omap.get((_n(party), _n(ref)))
        if amt is None:
            amt = omap_ref.get(_n(ref))
        if amt is None:
            return None                            # not in the report — leave alone
        amt = amt if amt >= 1 else Decimal("0")     # ignore rounding dust
        return min(amt, total)

    st = {"invoices_agree": 0, "bills_agree": 0,
          # Documents Tally's Bills Outstanding never mentions. Not an error —
          # the report is a narrow view of what is owed.
          "invoices_not_in_report": 0, "bills_not_in_report": 0,
          # Where the ERP's document-derived balance and Tally's report differ.
          # Reported, never applied.
          "diffs": [], "diff_total": "0"}
    _diff_sum = Decimal("0")
    DUST = Decimal("1")

    # ---- sales receivables ----
    for inv in (SalesInvoiceCheck.objects.filter(company=company)
                .exclude(tally_guid="").select_related("customer")):
        rl = ReceivableLedger.objects.filter(invoice_reference=inv).first()
        if not rl:
            continue
        total = rl.amount or inv.grand_total or Decimal("0")
        party = inv.customer.customer_name if inv.customer else ""
        out = _out(party, inv.tally_invoice_no or inv.invoice_no, total)
        if out is None:
            # Tally doesn't list this bill. Keep whatever the receipts actually
            # settled — that is real evidence; the report's silence is not.
            st["invoices_not_in_report"] += 1
            continue
        erp = rl.balance or Decimal("0")
        gap = erp - out
        if abs(gap) < DUST:
            st["invoices_agree"] += 1
            continue
        _diff_sum += gap
        st["diffs"].append({
            "kind": "sales", "party": party,
            "doc": inv.tally_invoice_no or inv.invoice_no,
            "erp": str(erp), "tally": str(out), "diff": str(gap)})

    # ---- vendor bills ----
    for bill in (VendorBill.objects.filter(vendor__company=company, is_active=True)
                 .exclude(tally_guid="").select_related("vendor")):
        total = bill.total_amount or Decimal("0")
        party = bill.vendor.vendor_name if bill.vendor else ""
        out = _out(party, bill.vendor_invoice_no or bill.bill_no, total)
        if out is None:                 # not in the report — leave the payments alone
            st["bills_not_in_report"] += 1
            continue
        erp = total - (bill.amount_paid or Decimal("0"))
        gap = erp - out
        if abs(gap) < DUST:
            st["bills_agree"] += 1
            continue
        _diff_sum += gap
        st["diffs"].append({
            "kind": "purchase", "party": party,
            "doc": bill.vendor_invoice_no or bill.bill_no,
            "erp": str(erp), "tally": str(out), "diff": str(gap)})
    # Biggest disagreements first — that is the order a human wants to read.
    st["diffs"].sort(key=lambda d: -abs(Decimal(d["diff"])))
    st["diff_total"] = str(_diff_sum)
    st["diffs"] = st["diffs"][:200]
    return st


# ---------------------------------------------------------------- document chain
def _build_sales_chain(v, inv, cust, lines, ctx):
    """NO LONGER CALLED — see the note in `_import_sales`.

    Reconstructed the upstream Sales Order + Dispatch Challan for a Tally sales
    invoice and linked them (inv.so_reference / dc_reference) so those pages
    would populate. Kept for reference only: the documents are fabrications
    (Tally has no SO or DC behind a sales voucher), every DC came out stamped
    with the import timestamp, and the resulting DCLines PROTECTed their SOLines
    so `revert_tally` could not clean them up. Do not re-enable without deciding
    what a reconstructed DC is actually FOR."""
    from .models import SalesOrder, SOLine, DispatchChallan, DCLine
    try:
        # Own savepoint: a chain hiccup rolls back only the chain, never the
        # invoice already committed in the outer voucher transaction.
        with transaction.atomic():
            date = inv.invoice_date
            wh = _company_warehouse(ctx.company)
            so = SalesOrder.objects.create(
                so_no=_unique_no(SalesOrder, "so_no", f"SO-{inv.invoice_no}"[:50]),
                customer=cust, company=ctx.company, warehouse=wh, so_date=date,
                payment_terms=(inv.payment_terms or "")[:20], credit_terms=(inv.payment_terms or "")[:20],
                consignee_name=inv.consignee_name, consignee_address=inv.consignee_address,
                consignee_gstin=(inv.consignee_gstin or "")[:20], billing_address=inv.buyer_address,
                billing_gstin=(inv.buyer_gstin or "")[:20], remarks="Reconstructed from Tally import",
                created_by=ctx.created_by,
            )
            # Pair each resolved line with its SO line so the DC's through-rows
            # (DCLine) can back-reference the SO line they fulfil.
            paired = []  # (item, product, SOLine)
            for i, it in enumerate(lines, 1):
                if not it.get("item"):
                    continue
                prod = _get_or_create_product(it["item"], it["uom"], ctx)
                if not prod:
                    continue
                sol = SOLine.objects.create(
                    so=so, line_no=i, product=prod,
                    quantity_ordered=it["qty"] or Decimal("1"), uom=_map_uom(it["uom"]),
                    unit_price=it["rate"] or Decimal("0"), gst=Decimal("0"),
                )
                paired.append((it, prod, sol))
            inv.so_reference = so
            if wh:
                dc = DispatchChallan.objects.create(
                    dc_no=_unique_no(DispatchChallan, "dc_no", f"DC-{inv.invoice_no}"[:50]),
                    warehouse=wh, tally_invoice_no=(inv.tally_invoice_no or "")[:50], dispatch_date=date,
                    created_by=ctx.created_by,
                )
                # `DispatchChallan.dispatch_date` is DateTimeField(auto_now_add=True),
                # which SILENTLY DISCARDS the value passed above and stamps now().
                # Every imported DC therefore carried the import timestamp instead
                # of the invoice date: a 1-Apr→21-Aug import wrote 762 challans all
                # dated the morning it ran. Two consequences — the Dispatch Challan
                # page showed the whole year as dispatched today, and `revert_tally`
                # (which filters DCs on dispatch_date within the period) could not
                # find a single one, so the SO/DC chain survived every revert and
                # its DCLines then PROTECTed the SOLines. A queryset .update()
                # bypasses auto_now_add, so the real date lands without a migration
                # on a model the manual DC screen also uses.
                DispatchChallan.objects.filter(pk=dc.pk).update(dispatch_date=date)
                # DCLine IS the through model for linked_so_lines — create the
                # rows directly (never .set(), which inserts NULL quantities).
                for it, prod, sol in paired:
                    DCLine.objects.create(
                        dc=dc, product=prod, warehouse=wh, linked_so_line=sol,
                        quantity_dispatched=it["qty"] or Decimal("1"), uom=_map_uom(it["uom"]),
                    )
                inv.dc_reference = dc
            inv.save(update_fields=["so_reference", "dc_reference"])
    except Exception as e:  # noqa: BLE001
        ctx.summary["errors"].append(f"sales chain {inv.invoice_no}: {e}")


def _build_purchase_chain(v, bill, vend, lines, ctx, warehouse=None, godown=None):
    """Reconstruct the upstream Purchase Order + GRN for a Tally vendor bill and
    link them (bill.purchase_order / receipt_advice). Best-effort.

    `warehouse`/`godown` override the company-default location — used by the scan
    inbox so the goods-received receipt (and the stock it posts) lands in the
    operator-chosen warehouse + godown instead of the fallback warehouse.
    """
    from purchase.models import PurchaseOrder, POLine, ReceiptAdvice, ReceiptLine
    try:
        # Own savepoint: a chain hiccup rolls back only the chain, never the
        # bill already committed in the outer voucher transaction.
        with transaction.atomic():
            date = bill.bill_date
            wh = warehouse or _company_warehouse(ctx.company)
            if not wh:
                return
            po = PurchaseOrder.objects.create(
                company=ctx.company, warehouse=wh, vendor=vend, po_date=date,
                terms_and_conditions="Reconstructed from Tally import", created_by=ctx.created_by,
            )
            for i, it in enumerate(lines, 1):
                prod = _get_or_create_product(it["item"], it["uom"], ctx) if it.get("item") else None
                POLine.objects.create(
                    po=po, line_no=i, product_service=prod,
                    description=(it.get("item") or "Purchase")[:500],
                    quantity_ordered=it["qty"] or Decimal("1"), uom=_map_uom(it["uom"]),
                    unit_price=it["rate"] or Decimal("0"),
                )
            grn = ReceiptAdvice.objects.create(
                warehouse=wh, vendor=vend, receipt_date=date,
                invoice_no=(bill.vendor_invoice_no or "")[:100], invoice_date=date,
                invoice_amount=bill.total_amount, remarks="Reconstructed from Tally import",
                created_by=ctx.created_by,
            )
            grn.linked_pos.set([po])
            for i, it in enumerate(lines, 1):
                prod = _get_or_create_product(it["item"], it["uom"], ctx) if it.get("item") else None
                ReceiptLine.objects.create(
                    receipt=grn, line_no=i, product=prod,
                    quantity_received=it["qty"] or Decimal("1"), uom=_map_uom(it["uom"]),
                    godown_location=godown,
                )
            bill.purchase_order = po
            bill.receipt_advice = grn
            bill.save(update_fields=["purchase_order", "receipt_advice"])
    except Exception as e:  # noqa: BLE001
        ctx.summary["errors"].append(f"purchase chain {bill.bill_no}: {e}")


# ---------------------------------------------------------------- opening balances
def import_receivable_adjustments(vouchers, company, created_by=None, dry_run=True,
                                  tally_company="", ledger_master=None):
    """Import the CREDIT legs of Tally Journal/Contra vouchers that hit a customer
    (debtor) — round-offs, discounts, inter-account transfers, write-offs — into
    ReceivableAdjustment. These are the non-receipt, non-credit-note movements that
    make up the rest of Tally's Sundry-Debtors Credit column, so the dashboard's
    'Amount Received' can reconcile. Idempotent via tally_guid. A ledger leg is
    treated as a customer only if it resolves to an ERP customer (banks / expense /
    GST ledgers naturally fall out)."""
    from .models import ReceivableAdjustment, ReceivablePayment, SalesInvoiceCheck
    ctx = _Ctx(company, created_by, dry_run)
    tco = tally_company or (getattr(company, "legal_name", "") if company else "")
    if ledger_master:
        ctx.ledger_master = ledger_master
    else:
        try:
            from .tally_import import fetch_ledgers
            ledgers, _ = fetch_ledgers(tco)
            ctx.ledger_master = {l["name"].strip(): l for l in ledgers if l.get("name")}
        except Exception:  # noqa: BLE001
            ctx.ledger_master = {}
    s = {"journal_contra": 0, "amount": Decimal("0"), "skipped_existing": 0, "errors": []}
    # Every credit leg here is judged by _is_customer_ledger. Without the master
    # that judgement is a coin toss that always says "customer" — see
    # _ledger_master_required. Import nothing rather than import rubbish.
    if _ledger_master_required(ctx, s, "receivable adjustments"):
        s["amount"] = str(s["amount"].quantize(Decimal("0.01")))
        return s
    for v in vouchers:
        vt = (v.get("vtype") or "").lower()
        atype = "JOURNAL" if "journal" in vt else ("CONTRA" if "contra" in vt else None)
        # A PURCHASE from a party who is ALSO a Sundry Debtor credits that debtor,
        # and Tally's Sundry-Debtors Credit column counts it. United Agro August
        # 2026: UAI-0507 (3-Aug) credits "Malabar Chemicals & Fertilizers"
        # Rs 7,90,650, the same party UAI/217 invoiced Rs 7,90,650 the next day —
        # one ledger, sale one way and purchase the other, a set-off Tally nets in
        # place. It was the whole of August's shortfall against that column.
        #
        # Safe only because `_is_customer_ledger` reads Tally's own primary group,
        # which the ledger master now provably carries:
        #     Malabar Chemicals & Fertilizers   Sundry Debtors     -> credited
        #     Andavar Trading Co, - RM          Sundry Creditors   -> ignored
        #     Ansh Enterprise - Sangli          Sundry Creditors   -> ignored
        #     Kalamani Transport                Sundry Creditors   -> ignored
        #     Sri Murugan Transport - A.P       Sundry Creditors   -> ignored
        # Run once with an EMPTY master (gateway down) those four suppliers were
        # credited too, Rs 20,03,707 of them — which is why this whole importer
        # now refuses without the master rather than guessing. Receipts and credit
        # notes have their own import paths, so this cannot double-count.
        if not atype and classify(v.get("vtype") or "") == "purchase":
            atype = "OTHER"
        # A PAYMENT that debits a Sundry Debtor is money going back OUT to a
        # customer — a refund, or an LC/loan settlement — and Tally counts it in
        # the Sundry-Debtors Debit column. Receipts have their own import path
        # and only ever credit, so a payment leg cannot double-count with them.
        # United Agro's Tinkas Industries is the case in point: Tally shows the
        # party square only because a Rs 30,00,000 payment (BK-24239, 30-Jun)
        # sits against an opening advance and a receipt, and without it the ERP
        # read Rs 17,29,911.50 of credit that Tally does not have.
        #
        # Restricted to the DEBIT side on purpose: a payment CREDITING a debtor
        # would be a supplier payment on a party who is also a customer, and
        # that belongs to the payables module, not here.
        if not atype and classify(v.get("vtype") or "") == "payment":
            atype = "OTHER"
            _payment_debits_only = True
        else:
            _payment_debits_only = False
        if not atype:
            continue
        date = _pdate(v["date"]) or timezone.now().date()
        pname = (v.get("party") or "").strip()
        # The 194Q TDS this voucher withholds, if any — see ReceivableAdjustment.tds.
        _vtds = sum((abs(x["amount"]) for x in v["ledgers"]
                     if "194Q" in (x["ledger"] or "").upper()
                     and "RECEIVABLE" in (x["ledger"] or "").upper()), Decimal("0"))
        # 194Q TDS this voucher REVERSES: the TDS ledger CREDITED (positive,
        # Tally's credit sign) against a debit to the customer. SS Biochem
        # JN440/26-27 (1-Jul, KSE Limited, Rs 1,096) is the case: Tally's TDS
        # Receivable 194Q shows it in the Credit column, but the debit leg was
        # stored with tds=0, so the TDS tile never took it off. Stored on the
        # voucher's FIRST customer debit only, so it is counted once.
        _vtds_back = sum((x["amount"] for x in v["ledgers"]
                          if "194Q" in (x["ledger"] or "").upper()
                          and "RECEIVABLE" in (x["ledger"] or "").upper()
                          and (x["amount"] or 0) > 0), Decimal("0"))
        for lg in v["ledgers"]:
            amt = lg["amount"]
            # BOTH sides. A journal that DEBITS a customer raises what they owe
            # and Tally counts it in the Sundry-Debtors Debit column, but only
            # credits were read here, so those debits never arrived. SS Biochem's
            # export customers are the clearest case: Tally's journal JN537/26-27
            # "Exchange Rate Difference" debits Sumitomo Biorational Rs 40,92,305.56
            # — the rupee value of a USD invoice moving between raising it and
            # being paid. The receipt for the larger rupee amount imported fine,
            # so the money arrived with no bill to sit against and the customer
            # read Rs 40,92,305.56 in credit while Tally shows them square.
            if amt is None or amt == 0:
                continue
            side = "CREDIT" if amt > 0 else "DEBIT"    # Tally: credit positive
            if _payment_debits_only and side != "DEBIT":
                continue
            nm = lg["ledger"]
            if _is_tax_ledger(nm):   # skip tax ledgers
                continue
            # Same rule as the receipt importer: what Tally says the ledger IS
            # decides, not whether an ERP customer master happens to share the
            # name. "resolves to a customer" is not enough — plenty of ledgers
            # that are nothing of the kind have a customer master from older
            # imports, and a journal credit on one of them is not a customer
            # credit. Measured on United Agro after wiring this importer in:
            #     April   Sri Murugan Transport - A.P   24,74,862.00  transporter
            #             Tamil Nadu Electricity Board   5,68,558.00  expense
            #             M.G Copier - Slm                     708.00  expense
            #                                          ─────────────
            #                                           30,44,128.00  = the whole
            #     of April's overshoot against Tally's Sundry-Debtors Credit
            #     column, and May added ICICI Term Loan and Vehicle Maintenence
            #     to the same list.
            _parent = _ledger_group(ctx, nm)
            if not _is_customer_ledger(ctx, nm):
                s.setdefault("non_customer_legs", {}).setdefault(
                    nm.strip(), {"group": _parent, "amount": Decimal("0")}
                )["amount"] += abs(amt)
                continue
            cust = _resolve_customer(nm, ctx)
            if not cust:
                # Tally says this IS a debtor (it passed _is_customer_ledger),
                # but no ERP customer master answers to the name. That is a
                # SPELLING problem, not an accounting one — and dropping it
                # silently is how a real credit disappears from both Amount
                # Received and Outstanding with nothing on screen.
                #
                # JN87/26-27 (30-Apr, Rs 10,625) is the worked example:
                #     Tally ledger  "T.Stanes And Company Ltd - Coimbatore"
                #     ERP customer  "T.Stanes And Company Ltd., - Coimbatore"
                # one comma apart. It never reached non_customer_legs either,
                # because the GROUP was right — so the existing diagnostic could
                # not show it, and four months each lost a journal this way:
                # Rs 93,195 off Received and Rs 85,777 too much Outstanding.
                #
                # Recorded separately from non_customer_legs precisely because
                # the remedy is different: those are correctly refused, these
                # need a party MAPPING (or the master renamed to match Tally).
                s.setdefault("unresolved_customer_legs", {}).setdefault(
                    nm.strip(), {"group": _parent, "amount": Decimal("0")}
                )["amount"] += abs(amt)
                continue
            _vg = _guid(v)
            guid = f"ADJ|{_vg}|{nm}"[:64]
            # The guid carries the ledger NAME as Tally spelled it, so ONE
            # capital letter used to defeat the duplicate check entirely:
            #     ADJ|<voucher>|T.Stanes and Company Ltd
            #     ADJ|<voucher>|T.Stanes And Company Ltd
            # are different strings, so the same TDS journal imported TWICE.
            # United Agro carried five of them -- one per month-end, Apr to Aug
            # -- worth Rs 29,660, which was the whole of its Amount Received
            # overshoot against Tally's Sundry-Debtors credit column.
            #
            # So match on what the row MEANS as well: same voucher, same party,
            # same date, same amount, same side is the same movement however the
            # name was typed. Deliberately NOT done by normalising the name INTO
            # the guid -- that would change the fingerprint of every adjustment
            # already stored, and the next import would match none of them and
            # re-create the lot.
            _same = ReceivableAdjustment.objects.filter(
                company=company, customer=cust, direction=side,
                date=date, amount=abs(amt),
                tally_guid__startswith=f"ADJ|{_vg}|")
            # Scoped to THIS party. `guid` is cut to the column's 64 chars, and
            # "ADJ|" + a Tally GUID + "|" already spends 50 of them, so only the
            # first FOURTEEN characters of the ledger name survive. Two parties
            # on one voucher whose names agree that far therefore produce the
            # SAME guid, and the second leg was skipped as already imported.
            #
            # SS Biochem's JN764/26-27 (30-Sep, "Being opening balance adjusted
            # agaisnt sales value") is the worked example: it debits
            #     Tropical Agro System (India) Pvt.Ltd - Chennai   4,28,400
            # and credits
            #     Tropical Agro System (India) Pvt Ltd - Kerala    4,28,400
            # Both truncate to "ADJ|<voucher>|Tropical Agro ". Only the debit
            # arrived, so Kerala still read 4,28,400 owing while Tally shows it
            # square -- the whole of SS's gap against Tally's Sundry Debtors
            # bar two smaller items. Any branch pair does it: the six Greenstar
            # ledgers all share "Greenstar Fert".
            #
            # Fixed HERE rather than by putting a hash of the name in the guid:
            # that would change the fingerprint of every adjustment already
            # stored, the next import would match none of them, and the lot
            # would be re-created. `_same` is already party-scoped; this makes
            # the exact-guid test agree with it.
            _exact = ReceivableAdjustment.objects.filter(tally_guid=guid, customer=cust)
            if _exact.exists() or _same.exists():
                s["skipped_existing"] += 1
                # A reversal journal imported before the reversal was read
                # carries tds=0. Fill it on re-import; nothing else changes.
                if side == "DEBIT" and _vtds_back and not dry_run:
                    (_exact | _same).filter(tds=0).update(tds=_vtds_back)
                    _vtds_back = Decimal("0")
                # And the leg's bill-wise detail (ReceivableAdjustment.tally_bills).
                _tb = _bills_json(lg.get("bills"))
                if _tb and not dry_run:
                    for _a in (_exact | _same):
                        if not _a.tally_bills:
                            ReceivableAdjustment.objects.filter(pk=_a.pk).update(tally_bills=_tb)
                # Backfill per-invoice settlements for CREDIT legs with bill
                # allocations — journals imported before this fix have the
                # full-amount adjustment but no per-invoice ReceivablePayments.
                # Create payments and REDUCE the adjustment to avoid double-counting.
                if side == "CREDIT" and not dry_run:
                    _backfill_settled = Decimal("0")
                    for bill in (lg.get("bills") or []):
                        bname = (bill.get("name") or "").strip()
                        btype = (bill.get("type") or "").strip().lower()
                        bamt = abs(Decimal(str(bill.get("amount") or 0)))
                        if not bname or bamt <= 0:
                            continue
                        if btype not in ("agst", "agst ref"):
                            continue
                        _jguid = f"JADJ|{_guid(v)}|{bname}"[:64]
                        if ReceivablePayment.objects.filter(tally_guid=_jguid).exists():
                            continue
                        for rl in find_receivables_by_ref(cust, bname, on_or_before=date):
                            _open = Decimal(str(rl.amount or 0)) - Decimal(str(rl.amount_paid or 0))
                            if _open <= 0:
                                continue
                            _pay = min(bamt, _open)
                            if _pay <= 0:
                                continue
                            ReceivablePayment.objects.update_or_create(
                                tally_guid=_jguid,
                                defaults=dict(
                                    receivable=rl, amount=_pay,
                                    payment_date=date, is_active=True,
                                    notes=f"Journal {v.get('number') or ''} settlement",
                                    created_by=created_by,
                                ),
                            )
                            resync_receivable(rl)
                            if _vtds and rl.invoice_reference_id:
                                _inv_ref = rl.invoice_reference
                                if _inv_ref:
                                    _old_tap = Decimal(str(_inv_ref.tds_at_payment or 0))
                                    SalesInvoiceCheck.objects.filter(
                                        pk=_inv_ref.pk
                                    ).update(tds_at_payment=_old_tap + _pay)
                            _backfill_settled += _pay
                            bamt -= _pay
                            if bamt <= 0:
                                break
                    if _backfill_settled > 0:
                        _adj = (_exact | _same).filter(direction="CREDIT").first()
                        if _adj:
                            _new_amt = _adj.amount - _backfill_settled
                            if _new_amt <= Decimal("0.01"):
                                _adj.delete()
                            else:
                                ReceivableAdjustment.objects.filter(pk=_adj.pk).update(amount=_new_amt)
                continue
            s["journal_contra"] += 1
            if side == "CREDIT":
                s["amount"] += abs(amt)
            else:
                s["debit_amount"] = s.get("debit_amount", Decimal("0")) + abs(amt)
            if dry_run:
                continue
            try:
                # ── Journal CREDIT with bill allocations: per-invoice settlement ──
                # When a CREDIT leg names specific invoices via Agst Ref, settle
                # them as ReceivablePayments so each invoice's payment_status
                # updates to PAID. Only the unsettled remainder becomes a
                # ReceivableAdjustment — avoids double-counting.
                _settled_via_bills = Decimal("0")
                if side == "CREDIT":
                    for bill in (lg.get("bills") or []):
                        bname = (bill.get("name") or "").strip()
                        btype = (bill.get("type") or "").strip().lower()
                        bamt = abs(Decimal(str(bill.get("amount") or 0)))
                        if not bname or bamt <= 0:
                            continue
                        if btype not in ("agst", "agst ref"):
                            continue
                        for rl in find_receivables_by_ref(cust, bname, on_or_before=date):
                            _open = Decimal(str(rl.amount or 0)) - Decimal(str(rl.amount_paid or 0))
                            if _open <= 0:
                                continue
                            _pay = min(bamt, _open)
                            if _pay <= 0:
                                continue
                            ReceivablePayment.objects.update_or_create(
                                tally_guid=f"JADJ|{_guid(v)}|{bname}"[:64],
                                defaults=dict(
                                    receivable=rl, amount=_pay,
                                    payment_date=date, is_active=True,
                                    notes=f"Journal {v.get('number') or ''} settlement",
                                    created_by=created_by,
                                ),
                            )
                            resync_receivable(rl)
                            # Back-fill tds_at_payment on the invoice when
                            # this journal IS a 194Q TDS withholding.
                            if _vtds and rl.invoice_reference_id:
                                _inv_ref = rl.invoice_reference
                                if _inv_ref:
                                    _old_tap = Decimal(str(_inv_ref.tds_at_payment or 0))
                                    _new_tap = _old_tap + _pay
                                    SalesInvoiceCheck.objects.filter(
                                        pk=_inv_ref.pk
                                    ).update(tds_at_payment=_new_tap)
                            _settled_via_bills += _pay
                            bamt -= _pay
                            if bamt <= 0:
                                break
                _adj_amount = abs(amt) - _settled_via_bills
                if _adj_amount > Decimal("0.01") or side == "DEBIT":
                    ReceivableAdjustment.objects.create(
                        company=company, customer=cust, adjustment_type=atype, direction=side,
                        date=date,
                        amount=abs(amt) if side == "DEBIT" else _adj_amount,
                        ledger_name=nm[:255],
                        tds=(_vtds if side == "CREDIT" else _vtds_back),
                        tally_bills=_bills_json(lg.get("bills")),
                        narration=(v.get("narration") or "")[:2000], tally_guid=guid,
                        created_by=created_by,
                    )
                if side == "DEBIT":
                    _vtds_back = Decimal("0")
            except Exception as e:  # noqa: BLE001
                s["errors"].append(f"adj {v.get('number')}/{nm[:20]}: {e}")
    s["amount"] = str(s["amount"].quantize(Decimal("0.01")))
    if "debit_amount" in s:
        s["debit_amount"] = str(s["debit_amount"].quantize(Decimal("0.01")))
    return s


def import_payable_adjustments(vouchers, company, created_by=None, dry_run=True,
                               tally_company="", ledger_master=None):
    """Import journal/contra voucher legs that DEBIT a vendor (Sundry Creditor)
    as PaymentMade records. These are discount deductions, loading charge
    deductions, inter-vendor transfers, and clearing-account settlements that
    the regular payment importer never sees (it only handles Payment voucher
    types). Mirrors import_receivable_adjustments on the sales side.

    A Tally journal debiting a creditor leg means the vendor's balance DECREASES
    — exactly like a payment. Created as PaymentMade with payment_mode=JOURNAL
    so they can be distinguished from bank payments. Idempotent via tally_guid
    (JADJ|<voucher guid>|<vendor name>)."""
    from purchase.models import VendorBill, PaymentMade
    ctx = _Ctx(company, created_by, dry_run)
    if ledger_master:
        ctx.ledger_master = ledger_master
    else:
        tco = tally_company or (getattr(company, "legal_name", "") if company else "")
        try:
            from .tally_import import fetch_ledgers
            ledgers, _ = fetch_ledgers(tco)
            ctx.ledger_master = {l["name"].strip(): l for l in ledgers if l.get("name")}
        except Exception:  # noqa: BLE001
            ctx.ledger_master = {}
    s = {"journal_contra": 0, "amount": Decimal("0"), "skipped_existing": 0,
         "errors": [], "non_vendor_legs": {}}
    if _ledger_master_required(ctx, s, "payable adjustments"):
        s["amount"] = str(s["amount"].quantize(Decimal("0.01")))
        return s
    g = _co_groups(company)
    for v in vouchers:
        vt = (v.get("vtype") or "").lower()
        atype = None
        if "journal" in vt:
            atype = "JOURNAL"
        elif "contra" in vt:
            atype = "CONTRA"
        if not atype:
            continue
        date = _pdate(v["date"]) or timezone.now().date()
        vguid = _guid(v)
        for lg in v["ledgers"]:
            amt = lg["amount"]
            if amt is None or amt == 0:
                continue
            # In Tally's export: credit = positive, debit = negative.
            # A DEBIT on a creditor = balance goes DOWN = like a payment.
            # We only want the DEBIT side (negative amounts on vendor legs).
            if amt >= 0:
                continue
            nm = (lg.get("ledger") or "").strip()
            if not nm:
                continue
            if _is_tax_ledger(nm):
                continue
            led = _led(ctx, nm)
            if not led:
                continue
            pg = (led.get("primary_group") or "").strip().lower()
            if not pg or g["creditor"] not in pg:
                parent = (led.get("parent") or "").strip().lower()
                if not parent or g["creditor"] not in parent:
                    continue
            vend = _resolve_vendor(nm, ctx)
            if not vend:
                s["non_vendor_legs"].setdefault(nm, {
                    "group": (led.get("primary_group") or led.get("parent") or ""),
                    "amount": Decimal("0"),
                })["amount"] += abs(amt)
                continue
            guid = f"JADJ|{vguid}|{nm}"[:64]
            if PaymentMade.objects.filter(tally_guid=guid).exists():
                s["skipped_existing"] += 1
                continue
            # Also check same voucher + same vendor + same date + same amount
            _same = PaymentMade.objects.filter(
                vendor=vend, payment_date=date, amount=abs(amt),
                tally_guid__startswith=f"JADJ|{vguid}|")
            if _same.exists():
                s["skipped_existing"] += 1
                continue
            s["journal_contra"] += 1
            s["amount"] += abs(amt)
            if dry_run:
                continue
            try:
                vno = (v.get("number") or "").strip()
                narr = (v.get("narration") or "").strip()[:500]
                pay_amt = abs(amt)
                # Try to settle against the vendor's open bills via Against Ref
                bills_settled = []
                for ref_info in lg.get("bills", []):
                    ref_name = (ref_info.get("name") or "").strip()
                    ref_amt = abs(ref_info.get("amount") or 0)
                    if not ref_name or ref_amt <= 0:
                        continue
                    bill = _find_bill_by_ref(vend, ref_name)
                    if bill:
                        due = bill.total_amount - bill.amount_paid
                        settle = min(ref_amt, due, pay_amt)
                        if settle > 0:
                            bill.amount_paid += settle
                            bill.status = ("PAID" if bill.amount_paid >= bill.total_amount
                                           else "PARTIALLY_PAID")
                            bill.save(update_fields=["amount_paid", "status"])
                            PaymentMade.objects.create(
                                vendor=vend, payment_date=date,
                                payment_mode="JOURNAL", amount=settle,
                                reference_no=vno[:100], bill=bill,
                                status="APPROVED", tally_guid=guid,
                                notes=f"Journal {vno} — {narr}"[:1000],
                                created_by=created_by,
                            )
                            pay_amt -= settle
                            bills_settled.append(bill)
                            guid = f"JADJ|{vguid}|{nm}|{ref_name}"[:64]
                # Remaining amount as on-account
                if pay_amt > 0:
                    PaymentMade.objects.create(
                        vendor=vend, payment_date=date,
                        payment_mode="JOURNAL", amount=pay_amt,
                        reference_no=vno[:100],
                        status="APPROVED", tally_guid=guid,
                        notes=f"Journal {vno} — {narr}"[:1000],
                        created_by=created_by,
                    )
            except Exception as e:  # noqa: BLE001
                s["errors"].append(f"padj {v.get('number')}/{nm[:20]}: {e}")
    s["amount"] = str(s["amount"].quantize(Decimal("0.01")))
    if s["non_vendor_legs"]:
        s["non_vendor_legs"] = [
            {"ledger": k, "group": v["group"],
             "amount": str(v["amount"].quantize(Decimal("0.01")))}
            for k, v in sorted(s["non_vendor_legs"].items(),
                               key=lambda kv: -kv[1]["amount"])
        ][:25]
    else:
        s["non_vendor_legs"] = []
    return s


def import_opening_balances(ledgers, company, created_by=None, dry_run=True,
                            as_of=None, tally_company="", job_id=None):
    """Carry Tally ledger opening balances into ERP so the Receivables/Payments
    outstanding matches Tally. Each debtor with an opening becomes an 'opening'
    SalesInvoiceCheck + ReceivableLedger; each creditor an 'opening' VendorBill.
    Idempotent via `tally_guid='OPENING|<ledger>'`. Parties are matched by name
    then GSTIN — unmatched openings are listed, never guessed.

    `job_id` — see import_tally_vouchers' docstring; checked between every
    ledger so Cancel can stop this early too."""
    from .models import SalesInvoiceCheck, ReceivableLedger
    from purchase.models import VendorBill
    from master.models import Customer, Vendor

    cancel_checker = _make_cancel_checker(job_id)
    if as_of is None:
        as_of = timezone.now().date().replace(month=4, day=1)  # FY start
    ctx = _Ctx(company, created_by, dry_run)
    ctx.ledger_master = {l["name"].strip(): l for l in (ledgers or []) if l.get("name")}
    s = {"opening_receivables": 0, "opening_payables": 0, "skipped_existing": 0,
         # Parties whose Tally group didn't say which side they were, resolved by
         # the sign of the opening instead (see the loop below).
         "side_from_sign": 0,
         "unmatched": [], "errors": []}

    def _okey(g):
        return _re.sub(r"\s+", " ", (g or "").strip()).lower()

    # Every opening this company already holds, keyed ignoring capitals and
    # spacing. An active one wins over a switched-off one with the same key.
    _open_idx = {}
    for _iid, _g, _act in (SalesInvoiceCheck.objects
                           .filter(company=company, tally_invoice_no="OPENING")
                           .values_list("id", "tally_guid", "is_active")):
        _k = _okey(_g)
        if _k not in _open_idx or (_act and not _open_idx[_k][1]):
            _open_idx[_k] = (_iid, _act)

    def _mk_receivable(cust, amt):
        # The guid is built from the LEDGER NAME, which both companies share:
        # "Greenstar Fertilisers Limited -  North" is a customer of United Agro
        # AND of SS Biochem. Checking it without the company meant whichever
        # company imported first claimed the name, and the second was told
        # "already present" and silently skipped. Five SS openings worth
        # Rs 4,74,97,562.60 never arrived that way — Greenstar South alone was
        # Rs 3,13,39,501 — and every balance built on them read short.
        guid = f"OPENING|{name}"[:64]
        # Matched ignoring capitals and spacing. Tally reported the same ledger
        # once as "T.Stanes and Company Ltd - Coimbatore" and later as "T.Stanes
        # And Company Ltd - Coimbatore"; an exact match missed the first opening
        # and United Agro got a second Rs 24,17,164 (8-Oct-2026).
        hit = _open_idx.get(_okey(guid))
        if hit:
            s["skipped_existing"] += 1
            # Already brought in: never overwritten here. If Tally's figure has
            # moved since, it is listed under "Changed in Tally" for a person to
            # Update or Keep -- several openings were corrected by hand to the
            # Tally ledger and must not be undone by a re-run. A switched-off
            # opening was switched off on purpose and is left alone.
            if hit[1]:
                try:
                    from .voucher_changes import record_opening_change
                    r = record_opening_change(company, hit[0], amt, name, created_by)
                    if r:
                        s.setdefault("opening_changed", []).append(r)
                except Exception as e:  # noqa: BLE001 -- a check must never stop an import
                    s["errors"].append(f"opening {name}: changed-in-Tally check: {e}")
            return
        if dry_run:
            s["opening_receivables"] += 1
            return
        with transaction.atomic():
            inv = SalesInvoiceCheck.objects.create(
                invoice_no=_unique_no(SalesInvoiceCheck, "invoice_no", f"OPEN-{name}"[:50],
                                      scope={"company": company}),
                tally_guid=guid, tally_invoice_no="OPENING",
                invoice_date=as_of, customer=cust, company=company, status="CONFIRMED",
                buyer_name=(cust.customer_name or "")[:255], buyer_gstin=(cust.gstin or "")[:20],
                subtotal=amt, grand_total=amt, amount_in_words=_amount_words(amt),
                remarks="Opening balance carried from Tally", created_by=created_by,
            )
            ReceivableLedger.objects.create(
                customer=cust, invoice_reference=inv, invoice_date=as_of, due_date=as_of,
                amount=amt, amount_paid=0, balance=amt, payment_status="NOT_DUE",
                notes="Opening balance (Tally)", created_by=created_by,
            )
        _open_idx[_okey(guid)] = (inv.pk, True)
        s["opening_receivables"] += 1

    def _mk_payable(vend, amt):
        # Same trap as _mk_receivable: one supplier name, two companies.
        guid = f"OPENING|{name}"[:64]
        if VendorBill.objects.filter(tally_guid__iexact=guid, vendor__company=company).exists():
            s["skipped_existing"] += 1
            return
        if dry_run:
            s["opening_payables"] += 1
            return
        with transaction.atomic():
            VendorBill.objects.create(
                vendor=vend, vendor_invoice_no="OPENING", tally_guid=guid,
                bill_no=_unique_no(VendorBill, "bill_no", f"OPEN-{name}"[:50]),
                bill_date=as_of, due_date=as_of, status="OPEN",
                subtotal=amt, tax_amount=0, total_amount=amt, amount_paid=0,
                notes="Opening balance carried from Tally", created_by=created_by,
            )
        s["opening_payables"] += 1

    all_ledgers = ledgers or []
    for idx, lg in enumerate(all_ledgers):
        if cancel_checker():
            s["cancelled"] = True
            s["cancelled_remaining"] = len(all_ledgers) - idx
            break
        name = (lg.get("name") or "").strip()
        opening = Decimal(str(lg.get("opening") or 0))
        if not name or abs(opening) < 1:
            continue
        # Tally's own primary group decides. Only when it gives us nothing at
        # all do we fall back to the parent-name test. See _opening_side.
        side = _opening_side(lg) or _classify_ledger(lg.get("parent"))
        amt = abs(opening)
        if side == "other":
            # Tally says this is neither a debtor nor a creditor — a loan, a
            # bank, a tax ledger. It is NOT a party, whatever masters happen to
            # share its name, so it must not become a receivable or a payable.
            s.setdefault("skipped_non_party", []).append(
                {"name": name, "group": lg.get("primary_group") or "",
                 "amount": str(amt)})
            continue
        # SIGN decides direction. Tally writes a debit opening negative and a
        # credit opening positive. A debtor with a CREDIT opening has paid us in
        # advance — booking that as a receivable states the debt backwards, and
        # by twice the money. United Agro's Tinkas Industries opened Rs
        # 6,35,044.25 in ADVANCE and was carried as Rs 6,35,044.25 OWING.
        if side == "customer" and opening > 0:
            # Carried as a NEGATIVE opening, not skipped. Booking it positive
            # states the debt backwards and by twice the money — United Agro's
            # Tinkas Industries opened Rs 6,35,044.25 in ADVANCE and was carried
            # as Rs 6,35,044.25 OWING. But dropping it entirely leaves the credit
            # nowhere at all, and then Outstanding still cannot equal Tally: the
            # party's closing is short by exactly the advance. Tally holds it as
            # a credit balance under Sundry Debtors, so the ERP holds it as a
            # receivable of negative amount, which is the same statement.
            s.setdefault("customer_advances", []).append(
                {"name": name, "amount": str(amt)})
            cust = _resolve_customer(name, ctx)
            (_mk_receivable(cust, -amt) if cust else s["unmatched"].append(name))
            continue
        if side == "vendor" and opening < 0:
            s.setdefault("vendor_advances", []).append(
                {"name": name, "amount": str(amt)})
            continue
        try:
            if side == "customer":
                cust = _resolve_customer(name, ctx)
                (_mk_receivable(cust, amt) if cust else s["unmatched"].append(name))
            elif side == "vendor":
                vend = _resolve_vendor(name, ctx)
                (_mk_payable(vend, amt) if vend else s["unmatched"].append(name))
            else:
                # ── Group didn't say (Cash / Tax / Assets, or a CUSTOM SUB-GROUP)
                # `_classify_ledger` only looks for "debtor"/"creditor" in the
                # parent name, but Tally lets you file a party under a sub-group
                # of its own. `T.Stanes And Company Ltd., - Coimbatore` reports
                # parent 'T.Stanes And Company Ltd - Co' — a sub-group under
                # Sundry Debtors — so it lands here despite being a plain debtor.
                #
                # This branch used to act ONLY when exactly one master matched,
                # and dropped the ledger in silence otherwise — not an error, not
                # in `unmatched`, invisible on the preview. T.Stanes exists as a
                # customer AND a vendor (it both buys from us and sells to us), so
                # its Rs 74,52,434 opening vanished every run, leaving Outstanding
                # short by exactly that. Its `- Exp` sibling has no vendor master,
                # matched the old condition, and did import — which is why one
                # T.Stanes opening appeared and the other never did.
                #
                # THE SIGN DECIDES. Tally exports a debit opening as negative, and
                # a debit balance on a party is money owed TO us (a receivable);
                # a credit is money we owe (a payable). That is an accounting fact,
                # not a guess, so an ambiguous party no longer needs to be skipped.
                cust, vend = _resolve_customer(name, ctx), _resolve_vendor(name, ctx)
                if cust and vend:
                    (_mk_receivable(cust, amt) if opening < 0 else _mk_payable(vend, amt))
                    s["side_from_sign"] += 1
                elif cust:
                    _mk_receivable(cust, amt)
                elif vend:
                    _mk_payable(vend, amt)
                # Neither master: a genuine non-party ledger (bank, tax, loan,
                # duty). Still skipped quietly — 1,507 ledgers come back and most
                # are not parties, so reporting them would bury the real misses.
        except Exception as e:  # noqa: BLE001
            s["errors"].append(f"opening {name}: {e}")
    s["unmatched"] = sorted(set(s["unmatched"]))
    s["changed_vouchers"], s["deleted_vouchers"], s["voucher_change_warnings"] = [], [], []
    return s

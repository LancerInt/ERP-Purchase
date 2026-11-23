"""Shared TDS Payable import logic — used by BOTH the `import_tds_payable`
management command (file or --live) AND the /api/tally/import/ what=tds_payable
endpoint (browser → Tally Connector).

Given a company, the TDS-Payable ledgers with their opening balances, and a list
of Tally vouchers, it writes TdsPayable rows so each ledger's rows sum to Tally's
Group-Summary closing balance:

    closing = opening (carried as a synthetic FY-start row) + movements
              (credit / deduction = +, debit / payment-to-govt = -)

Reporting-only + idempotent: RESETS the company's TdsPayable rows, then re-inserts.
Each movement is linked to a VendorBill by the voucher's bill reference (Agst Ref)
matched **within the same vendor** (ref + vendor), with the journal/voucher no as a
tiebreaker; a company-wide ref is only used as a last resort when it is unique
(so refs that repeat across vendors — e.g. "030" — never cross-link).
"""
import re
from collections import defaultdict
from datetime import date as _date
from decimal import Decimal

from django.db import transaction

TDS_GROUP = "TDS Payable"


def _section(ledger):
    """Map a TDS-Payable ledger name to its 194 section code."""
    l = (ledger or "").lower()
    if "194q" in l or "on purchase" in l:
        return "194Q"
    if "194c" in l or "contract" in l or "freight" in l:
        return "194C"
    if "194j" in l or "professional" in l:
        return "194J"
    if "194i" in l or "rent" in l or "1009" in l:
        return "194I"
    return "OTHER"


def _to_date(s):
    """parse_daybook / fetch return dates as ISO strings — coerce to a date."""
    if not s:
        return None
    if isinstance(s, _date):
        return s
    try:
        return _date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def _ref_keys(*vals):
    """Candidate keys for a reference, so a TDS row and its bill match even when
    the two sources wrote the number slightly differently:
      * the trimmed value itself
      * the NUMERIC base before a '/'  — Tally writes "030/24-25" for bill "030"
      * the LEADING NUMBER             — the ERP appends a disambiguator ("-2"/"-3")
        when the same invoice number recurs, so its bill is "762-2" while Tally's
        TDS Agst Ref is the plain "762"; without this the suffixed bills never
        linked and showed a blank TDS column.
    Each numeric key is also offered without leading zeros, so "030" and "30" meet.

    IMPORTANT: a '/'-prefix is emitted as its own key ONLY when it is NUMERIC. A
    short ALPHABETIC prefix ("PRT", "AGE", "OM") is a transporter/series CODE shared
    across many bills, not an invoice number — emitting it collided "PRT/IN/27/4"
    with a different "PRT/IN/26/18" bill (an over-link). Dropping the bare-alpha
    prefix keeps the full "PRT/IN/27/4" as the only alpha key, so different PRT docs
    no longer match. Order preserved; duplicates dropped."""
    keys = []

    def _add(k):
        k = (k or '').strip()
        if k and k not in keys:
            keys.append(k)
            # a purely-numeric key also matches its zero-stripped form (030 == 30)
            if k.isdigit():
                z = k.lstrip('0') or '0'
                if z not in keys:
                    keys.append(z)

    for val in vals:
        if not val:
            continue
        k = str(val).strip()
        if not k:
            continue
        _add(k)
        base = k.split('/')[0].strip()             # before a '/' (FY suffix etc.)
        if base.isdigit():                         # ONLY a numeric base — not an alpha series code
            _add(base)
        m = re.match(r'\s*(\d+)', k)               # leading number: "762-2" -> "762"
        if m:
            _add(m.group(1))
    return keys


def tds_openings_from_ledgers(ledgers, tds_groups=None):
    """{ledger_name: opening_balance} for ledgers under the TDS Payable group,
    from a parsed/fetched ledger list [{name, parent, opening}]. Default matches
    direct children of "TDS Payable" (what the live connector fetch returns; the
    file path can pass an expanded set that includes sub-groups)."""
    groups = tds_groups or {TDS_GROUP}
    out = {}
    for l in (ledgers or []):
        nm = (l.get("name") or "").strip()
        parent = (l.get("parent") or "").strip()
        if nm and parent in groups:
            out[nm] = l.get("opening") or Decimal("0")
    return out


def build_and_store_tds_payable(company, tds_openings, vouchers, dry_run=False):
    """Core import. `tds_openings` = {ledger_name: opening}; `vouchers` = parsed
    Tally voucher dicts. Returns a summary dict (also the API/CLI response)."""
    from .models import TdsPayable, VendorBill
    from master.models import Vendor

    tds_ledgers = {(k or "").strip() for k in (tds_openings or {})}

    def is_tds(name):
        return (name or "").strip() in tds_ledgers

    # Vendor + bill lookup for linking (scoped to the company).
    vend_by_name = {}
    for v in Vendor.objects.filter(company=company, is_active=True):
        vend_by_name.setdefault((v.vendor_name or "").strip().lower(), v)

    # Bill index keyed by (vendor_id, ref) so a ref that repeats across vendors
    # (e.g. "030") never cross-links. `ref_to_bills` tracks which bills a ref maps
    # to company-wide, so the fallback only fires when the ref is unambiguous.
    bill_by_vendor_ref = {}          # (vendor_id, ref) -> bill_id
    ref_to_bills = defaultdict(set)  # ref -> {bill_id}
    for b in VendorBill.objects.filter(vendor__company=company, is_active=True).values(
            "id", "vendor_id", "vendor_invoice_no", "bill_no"):
        for k in _ref_keys(b["vendor_invoice_no"], b["bill_no"]):
            bill_by_vendor_ref.setdefault((b["vendor_id"], k), b["id"])
            ref_to_bills[k].add(b["id"])

    def match_bill(ref, vend=None, voucher_no=None):
        """Link a TDS movement to a VendorBill.
        - Known vendor: link ONLY to that same vendor's own bill — by bill ref
          first, then by journal/voucher no as a tiebreaker. Never borrow another
          vendor's bill (this is what fixes the cross-vendor "030" collision).
        - Unknown vendor (party didn't resolve to a Vendor master): fall back to a
          company-wide ref/voucher-no match, but ONLY when it maps to exactly one
          bill (unambiguous)."""
        ref_keys = _ref_keys(ref)
        jn_keys = _ref_keys(voucher_no)
        vid = getattr(vend, "id", None)
        if vid is not None:
            for k in ref_keys + jn_keys:
                hit = bill_by_vendor_ref.get((vid, k))
                if hit:
                    return hit
            return None  # known vendor, no own-bill match → do NOT cross-link
        for k in ref_keys + jn_keys:
            bills = ref_to_bills.get(k)
            if bills and len(bills) == 1:
                return next(iter(bills))
        return None

    # Manual links the operator set on the TDS page must survive this rebuild
    # (import RESETS the rows). Keyed by the stable tally_guid; they WIN over the
    # automatic vendor+ref match below.
    overrides = dict(
        TdsPayable.objects
        .filter(company=company, manual_link=True, vendor_bill__isnull=False)
        .values_list("tally_guid", "vendor_bill_id"))

    # Collect the TDS legs + the voucher's bill reference.
    raw = []
    for v in (vouchers or []):
        legs = [le for le in v.get("ledgers", []) if is_tds(le.get("ledger"))]
        if not legs:
            continue
        party = (v.get("party") or "").strip()
        if not party:
            others = [le for le in v.get("ledgers", []) if not is_tds(le.get("ledger"))]
            if others:
                party = (max(others, key=lambda x: abs(x.get("amount") or Decimal("0"))).get("ledger") or "").strip()
        vend = vend_by_name.get(party.lower())
        bill_ref = ""
        for le2 in v.get("ledgers", []):
            for b in le2.get("bills", []):
                nm = (b.get("name") or "").strip()
                if nm:
                    bill_ref = nm
                    break
            if bill_ref:
                break
        for le in legs:
            raw.append((v, le, party, vend, bill_ref))

    # FY start (1-Apr of the earliest voucher's financial year) for opening rows.
    dates = [d for d in (_to_date(v.get("date")) for v, _, _, _, _ in raw) if d]
    d0 = min(dates) if dates else None
    fy_start = _date(d0.year if d0.month >= 4 else d0.year - 1, 4, 1) if d0 else None

    rows, per_ledger, n_open = [], defaultdict(Decimal), 0
    for ledger, ob in (tds_openings or {}).items():
        if ob and abs(ob) >= Decimal("0.01"):
            amt = ob.quantize(Decimal("0.01"))
            per_ledger[ledger] += amt
            n_open += 1
            rows.append(dict(
                company=company, tally_guid=f"OPENING|{ledger}"[:120],
                voucher_no="", voucher_type="Opening Balance", voucher_date=fy_start,
                ledger_name=ledger[:200], section=_section(ledger),
                party_name="(opening balance)", vendor=None,
                bill_ref="", vendor_bill_id=None, manual_link=False,
                amount=amt, narration="",
            ))

    n_linked, n_manual = 0, 0
    for v, le, party, vend, bill_ref in raw:
        amt = (le.get("amount") or Decimal("0")).quantize(Decimal("0.01"))
        ledger = (le.get("ledger") or "").strip()
        per_ledger[ledger] += amt
        tguid = f"{v.get('guid') or v.get('masterid') or ''}|{ledger}"[:120]
        man = tguid in overrides
        vb = overrides[tguid] if man else match_bill(bill_ref, vend, v.get("number"))
        if vb:
            n_linked += 1
        if man:
            n_manual += 1
        rows.append(dict(
            company=company,
            tally_guid=tguid,
            voucher_no=(v.get("number") or "")[:100],
            voucher_type=(v.get("vtype") or "")[:100],
            voucher_date=_to_date(v.get("date")),
            ledger_name=ledger[:200], section=_section(ledger),
            party_name=party[:255], vendor=vend,
            bill_ref=bill_ref[:100], vendor_bill_id=vb, manual_link=man,
            amount=amt, narration=(v.get("narration") or "")[:2000],
        ))

    grand = sum(per_ledger.values(), Decimal("0"))
    deducted = sum((r["amount"] for r in rows
                    if r["amount"] > 0 and r["voucher_type"] != "Opening Balance"), Decimal("0"))

    if not dry_run:
        with transaction.atomic():
            TdsPayable.objects.filter(company=company).delete()
            TdsPayable.objects.bulk_create(
                [TdsPayable(**r) for r in rows], batch_size=500)

    ledgers_summary = [{
        "ledger": lg, "section": _section(lg),
        "closing": str(per_ledger[lg].quantize(Decimal("0.01"))),
    } for lg in sorted(per_ledger)]

    return {
        "grand_total": str(grand.quantize(Decimal("0.01"))),
        "deducted_total": str(deducted.quantize(Decimal("0.01"))),
        "legs": len(raw), "opening_rows": n_open,
        "with_ref": sum(1 for _, _, _, _, br in raw if br),
        "linked": n_linked, "manual": n_manual,
        "ledgers": ledgers_summary,
        "rows_written": 0 if dry_run else len(rows),
        "dry_run": dry_run,
    }


def link_bill_to_tds(bill):
    """Link already-imported TdsPayable rows to a bill the moment it is created /
    confirmed — so a newly scanned bill picks up its TDS WITHOUT re-importing.

    The mirror of `match_bill`: same vendor + same bill ref (or the base number
    before '/'). Vendor-scoped so a ref that repeats across vendors ("030") never
    cross-links. Idempotent — only claims rows not already linked to some bill.
    Returns the number of TdsPayable rows linked.
    """
    from .models import TdsPayable

    vendor = getattr(bill, "vendor", None)
    company = getattr(vendor, "company", None)
    if vendor is None or company is None:
        return 0
    refs = set(_ref_keys(getattr(bill, "vendor_invoice_no", ""),
                         getattr(bill, "bill_no", "")))
    if not refs:
        return 0
    matched = []
    for row in (TdsPayable.objects
                .filter(company=company, vendor=vendor, vendor_bill__isnull=True)
                .exclude(bill_ref="")
                .values("id", "bill_ref")):
        if set(_ref_keys(row["bill_ref"])) & refs:
            matched.append(row["id"])
    if matched:
        TdsPayable.objects.filter(id__in=matched).update(vendor_bill=bill)
    return len(matched)

"""Shared core for applying Tally vendor PAYMENTS to bills — used by BOTH the
`import_vendor_payments` CLI command and the browser upload endpoints, so they
can never disagree.

Three concerns:
  * parse   — stream Payment vouchers out of a Day Book XML (iterparse, so a
              90 MB file never loads whole into memory), building "intents".
  * settle  — walk each intent: Against-Reference -> that bill; leftover ->
              on-account (default) or oldest bills (fifo). Preview vs write is
              one flag, so the numbers are identical.
  * report  — JSON-able summary for the API + a value for the CLI to print.

WHY the amount comes from the NAMED party leg, not `_split_ledgers`: SS Biochem
books each payment `Dr Creditor / Cr ICICI Bank` with BOTH legs ISPARTYLEDGER=Yes,
so summing the party legs nets to zero and the voucher is skipped. Measured on a
real April file: all 367 creditor payments (Rs 20.09 cr) would net to zero.
"""
from decimal import Decimal

_ZERO = Decimal("0")
_CENT = Decimal("0.01")   # paisa tolerance, so an exact net settlement isn't rejected/under-flipped
_SETTLED = ("PAID", "CANCELLED")


def _resync_bill_freight(bill):
    """Keep a bill's invoice-included freight paid/pending in step after its
    payment changes (goods first, freight last). Best-effort."""
    if bill is None:
        return
    try:
        from .invoice_freight import resync_bill_freight_payment
        resync_bill_freight_payment(bill)
    except Exception:  # noqa: BLE001
        pass


def apply_payment_to_bill(bill, amount, *, payment_date, payment_mode='BANK_TRANSFER',
                          reference_no='', bank_name='', bank_account=None,
                          notes='', status='APPROVED', user=None):
    """Record ONE payment against ONE bill and keep the bill in step.

    The single place that knows a vendor payment is two writes, not one: the
    PaymentMade row AND the bill's amount_paid / status. Creating the row on
    its own leaves the bill reading unpaid with a wrong balance_due, and its
    payment_history listing a payment beside a status of OPEN.

    Extracted from VendorBillViewSet.record_payment so the bank-statement
    reconciliation screen books a payment through exactly the same path. The
    third copy is deliberately not written — `settle()` below already carries
    its own version for the Tally import, and two that drift is already one
    too many.

    Raises ValueError on a non-positive amount or one over the balance; the
    caller turns that into a 400.
    """
    from django.db import transaction as _txn

    from .models import PaymentMade

    amount = Decimal(str(amount))
    if amount <= _ZERO:
        raise ValueError('Amount must be > 0.')
    # Room the bill has for a payment = total - TDS - already_paid, because a
    # 194Q/194C bill credits the vendor NET of TDS. But subtract the TDS ONCE,
    # never twice: when total_amount is ALREADY net (Zoho/scanner booked it that
    # way — tds_already_in_total), the TDS is baked in, so removing it again here
    # under-states the room by the TDS and wrongly rejects the real gross bank
    # payment. net_payable_to_vendor already encodes exactly this rule, so reuse
    # it rather than re-deriving (one source of truth). Non-TDS bills: tds=0, so
    # this stays identical to the old behaviour. (_CENT avoids a paisa reject.)
    net_room = (bill.net_payable_to_vendor or _ZERO)
    if amount > net_room + _CENT:
        raise ValueError(f'Amount ({amount}) exceeds net payable ({net_room}).')

    with _txn.atomic():
        payment = PaymentMade.objects.create(
            vendor=bill.vendor,
            payment_date=payment_date,
            payment_mode=payment_mode,
            amount=amount,
            reference_no=reference_no,
            bank_name=bank_name,
            bank_account=bank_account,
            bill=bill,
            status=status,
            notes=notes,
        )
        bill.amount_paid = (bill.amount_paid or _ZERO) + amount
        # Settled when payments + TDS withheld cover the gross total (vendor paid net).
        if bill.amount_paid + tds >= (bill.total_amount or _ZERO) - _CENT:
            bill.status = 'PAID'
        elif bill.amount_paid > _ZERO:
            bill.status = 'PARTIALLY_PAID'
        bill.save(update_fields=['amount_paid', 'status'])
        _resync_bill_freight(bill)
    return payment


def reverse_payment(payment):
    """Undo apply_payment_to_bill: delete the row and put the bill back.

    Reversal exists from the start because an operator reconciling a bank
    statement WILL occasionally book a line against the wrong bill, and
    deleting the PaymentMade alone would strand amount_paid — the bill would
    read part-paid for money that no longer exists anywhere.

    The status is recomputed from the resulting amount_paid rather than
    assumed: a reversal can take a bill from PAID back to PARTIALLY_PAID or
    all the way to OPEN, and only the arithmetic knows which.
    """
    from django.db import transaction as _txn

    bill = payment.bill
    amount = Decimal(str(payment.amount or 0))
    with _txn.atomic():
        payment.delete()
        if bill is not None:
            bill.amount_paid = max(_ZERO, (bill.amount_paid or _ZERO) - amount)
            tds = bill.tds_withheld or _ZERO
            if bill.amount_paid <= _ZERO:
                bill.status = 'OPEN'
            elif bill.amount_paid + tds >= (bill.total_amount or _ZERO) - _CENT:
                bill.status = 'PAID'
            else:
                bill.status = 'PARTIALLY_PAID'
            bill.save(update_fields=['amount_paid', 'status'])
            _resync_bill_freight(bill)
    return bill


def _D(s):
    try:
        return Decimal((s or "0").strip() or "0")
    except Exception:  # noqa: BLE001
        return _ZERO


def _norm_date(s):
    """Tally Day Book DATE is 'YYYYMMDD' -> 'YYYY-MM-DD'. Returns '' if unusable."""
    s = (s or "").strip()
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return s[:10]


def _agst(le):
    """[(ref, amount)] for the 'Against Reference' bill allocations on a ledger."""
    out = []
    for ba in le.iter("BILLALLOCATIONS.LIST"):
        t = (ba.findtext("BILLTYPE") or "").lower()
        if "agst" in t or "against" in t:
            nm = (ba.findtext("NAME") or "").strip()
            if nm:
                out.append((nm, abs(_D(ba.findtext("AMOUNT")))))
    return out


def _intent_from_voucher(v, ctx):
    """One <VOUCHER> lxml element -> a payment intent, or None if it isn't a
    settleable amount. Vendor is resolved here (needs the DB)."""
    from sales.tally_import_run import _resolve_vendor
    pname = (v.findtext("PARTYLEDGERNAME") or v.findtext("PARTYNAME") or "").strip()
    entries = list(v.iter("ALLLEDGERENTRIES.LIST")) or list(v.iter("LEDGERENTRIES.LIST"))
    named = [le for le in entries if (le.findtext("LEDGERNAME") or "").strip() == pname]
    if not named:                              # pname blank / not a ledger — fall back
        named = [le for le in entries if (le.findtext("ISPARTYLEDGER") or "").strip().lower() == "yes"]
    amount = abs(sum((_D(le.findtext("AMOUNT")) for le in named), _ZERO))
    refs = [r for le in named for r in _agst(le)]
    vend = _resolve_vendor(pname, ctx) if pname else None
    guid = (v.findtext("GUID") or v.findtext("MASTERID")
            or f"{v.findtext('VOUCHERTYPENAME')}|{v.findtext('VOUCHERNUMBER')}|{v.findtext('DATE')}")
    # Which bank / cash account funded this payment (the money-out leg) — so
    # Amount Paid can be split by account. Scan every leg except the party's own;
    # bank_leg_name picks the account and ignores TDS / round-off legs.
    from purchase.payment_buckets import bank_leg_name
    paid_from = bank_leg_name(
        ((le.findtext("LEDGERNAME") or "").strip(), _D(le.findtext("AMOUNT")))
        for le in entries)
    return {
        "vendor": vend, "party_name": pname or "(no party)", "amount": amount,
        "refs": refs, "guid": guid, "ref_no": (v.findtext("VOUCHERNUMBER") or ""),
        "date": _norm_date(v.findtext("DATE")),
        "bill_wise": getattr(vend, "tally_bill_wise", None),
        "paid_from": paid_from,
        # The voucher's NARRATION (e.g. "Fuel Expenses for Vehicles") — kept so
        # the payment shows what it was for, and usable as a classification hint.
        "narration": (v.findtext("NARRATION") or "").strip(),
    }


def stream_payment_intents(source, company, frm, to, ledger_master=None):
    """Stream Payment vouchers out of a Day Book XML (path, bytes, or file object)
    and build intents for the window. Memory-safe for very large exports.

    `frm`/`to` are date objects. Raises ValueError if the file yields no VOUCHER
    elements at all (i.e. a Bank-Book / columnar export, not a Day Book)."""
    from lxml import etree
    from sales.tally_import import classify
    from sales.tally_import_run import _Ctx

    ctx = _Ctx(company, None, dry_run=True)
    ctx.ledger_master = ledger_master or {}
    lo, hi = f"{frm:%Y-%m-%d}", f"{to:%Y-%m-%d}"

    intents, seen, any_voucher = [], set(), False
    it = etree.iterparse(source, events=("end",), tag="VOUCHER",
                         recover=True, huge_tree=True)
    for _, v in it:
        any_voucher = True
        if classify(v.findtext("VOUCHERTYPENAME") or "") == "payment":
            d = _norm_date(v.findtext("DATE"))
            if d and lo <= d <= hi:
                g = (v.findtext("GUID") or v.findtext("MASTERID")
                     or f"{v.findtext('VOUCHERNUMBER')}|{d}")
                if g not in seen:
                    seen.add(g)
                    intents.append(_intent_from_voucher(v, ctx))
        v.clear()
        p = v.getparent()
        if p is not None:
            while v.getprevious() is not None:
                del p[0]
    if not any_voucher:
        raise ValueError(
            "No <VOUCHER> elements — this looks like a Bank-Book / columnar "
            "export (<DSPVCHLEDACCOUNT> rows). Re-export the Day Book as "
            "'XML (Data Interchange)'.")
    return intents


def bank_payment_intents(company, frm, to):
    """Intents from payments already in bank.BankPayment (no file)."""
    from bank.models import BankPayment
    qs = (BankPayment.objects.filter(company=company, is_active=True,
                                     payment_date__gte=frm, payment_date__lte=to)
          .exclude(approval_status="CANCELLED").select_related("vendor"))
    out = []
    for bp in qs:
        amt = abs(bp.amount or _ZERO)
        ref = (bp.against_bill or "").strip()
        out.append({
            "vendor": bp.vendor,
            "party_name": bp.vendor.vendor_name if bp.vendor else "(no vendor)",
            "amount": amt, "refs": [(ref, amt)] if ref else [],
            "guid": f"BANKPAY|{bp.id}", "ref_no": bp.voucher_no,
            "date": bp.payment_date, "bill_wise": getattr(bp.vendor, "tally_bill_wise", None),
            "paid_from": "",
            "narration": (getattr(bp, "narration", "") or "").strip(),
        })
    return out


def settle(intents, use_fifo=False, write=False, user=None):
    """Walk each intent. Returns aggregates + per-vendor. In write mode also
    mutates VendorBill.amount_paid/status and creates PaymentMade rows.

    Idempotent: an intent whose tally_guid already has a PaymentMade is skipped.
    Wrap the write call in a transaction at the caller."""
    from sales.tally_import_run import _find_bill_by_ref
    from purchase.models import VendorBill, PaymentMade

    due = {}

    def rem_due(bill):
        if bill.id not in due:
            due[bill.id] = (bill.total_amount or _ZERO) - (bill.amount_paid or _ZERO)
        return due[bill.id]

    def pay_note(it, suffix):
        """Payment notes: lead with the Tally NARRATION (what the payment was
        for, e.g. 'Fuel Expenses for Vehicles') when present, then the voucher
        ref + how it was applied. Falls back to the old 'Tally payment <ref>'
        when there's no narration, so nothing regresses."""
        nar = (it.get("narration") or "").strip()
        tail = f"Tally payment {it['ref_no']} ({suffix})"
        return f"{nar}\n{tail}".strip() if nar else tail

    def do_settle(bill, amt, it, note):
        bill.amount_paid = (bill.amount_paid or _ZERO) + amt
        bill.status = "PAID" if bill.amount_paid >= bill.total_amount else "PARTIALLY_PAID"
        bill.save(update_fields=["amount_paid", "status"])
        PaymentMade.objects.create(
            vendor=it["vendor"], payment_date=it["date"], payment_mode="BANK_TRANSFER",
            amount=amt, reference_no=(it["ref_no"] or "")[:100], bill=bill,
            bank_name=(it.get("paid_from") or "")[:200],
            status="APPROVED", tally_guid=it["guid"], notes=note, created_by=user)

    r = {"tot": _ZERO, "against": _ZERO, "fifo": _ZERO, "onacct": _ZERO, "applied": _ZERO,
         "res": 0, "unm": 0, "already": 0, "noref": 0, "tagged": 0,
         "unmatched": {}, "vendors": {}}
    for it in intents:
        if PaymentMade.objects.filter(tally_guid=it["guid"]).exists():
            r["already"] += 1
            # Backfill the funding account onto payments imported before we
            # captured it (older imports dropped the bank leg). Label only — it
            # never touches an amount, a bill, or the paid status.
            pf = (it.get("paid_from") or "")[:200]
            if write and pf:
                r["tagged"] += PaymentMade.objects.filter(
                    tally_guid=it["guid"]).exclude(bank_name=pf).update(bank_name=pf)
            continue
        amt = it["amount"]
        r["tot"] += amt
        if amt <= 0:
            continue
        vend = it["vendor"]
        if not vend:
            r["unm"] += 1
            row = r["unmatched"].setdefault(it["party_name"], [0, _ZERO])
            row[0] += 1
            row[1] += amt
            continue
        r["res"] += 1
        pv = r["vendors"].setdefault(str(vend.id), {
            "name": vend.vendor_name, "paid": _ZERO, "applied": _ZERO,
            "onacct": _ZERO, "bwise": it["bill_wise"]})
        pv["paid"] += amt
        remaining = amt
        if not it["refs"]:
            r["noref"] += 1
        for ref, ramt in it["refs"]:                    # 1) Against Reference
            if remaining <= 0:
                break
            bill = _find_bill_by_ref(vend, ref)
            if bill and rem_due(bill) > 0:
                use = min(ramt, remaining, rem_due(bill))
                if use > 0:
                    due[bill.id] -= use
                    remaining -= use
                    r["against"] += use
                    r["applied"] += use
                    pv["applied"] += use
                    if write:
                        do_settle(bill, use, it, pay_note(it, f"agst {ref}"))
        if use_fifo and remaining > 0 and it["bill_wise"] is not False:   # 2) FIFO
            for bill in (VendorBill.objects.filter(vendor=vend, is_active=True)
                         .exclude(status__in=_SETTLED).order_by("bill_date", "created_at")):
                if remaining <= 0:
                    break
                d = rem_due(bill)
                if d <= 0:
                    continue
                use = min(remaining, d)
                due[bill.id] -= use
                remaining -= use
                r["fifo"] += use
                r["applied"] += use
                pv["applied"] += use
                if write:
                    do_settle(bill, use, it, pay_note(it, "FIFO"))
        r["onacct"] += remaining                        # 3) on-account
        pv["onacct"] += remaining
        if write and remaining > 0:
            PaymentMade.objects.create(
                vendor=vend, payment_date=it["date"], payment_mode="BANK_TRANSFER",
                amount=remaining, reference_no=(it["ref_no"] or "")[:100],
                bank_name=(it.get("paid_from") or "")[:200],
                status="APPROVED", tally_guid=it["guid"],
                notes=pay_note(it, "on account"), created_by=user)
    return r


def current_outstanding(company):
    """All-time Outstanding exactly as the dashboard tile computes it."""
    from purchase.dashboard_views import PurchaseDashboardView
    return Decimal(str(PurchaseDashboardView._outstanding_payables(company.id, None)["total"]))


def report_json(r, cur_out):
    """Turn a settle() result into an API-friendly dict (Decimals -> strings)."""
    def m(x):
        return str((x or _ZERO).quantize(Decimal("0.01")))
    movers = sorted(r["vendors"].values(), key=lambda x: -(x["applied"] + x["onacct"]))
    return {
        "total": m(r["tot"]),
        "resolved": r["res"], "unmatched": r["unm"], "already": r["already"],
        "no_ref": r["noref"], "tagged_account": r.get("tagged", 0),
        "against_ref": m(r["against"]), "fifo": m(r["fifo"]), "on_account": m(r["onacct"]),
        "applied_to_bills": m(r["applied"]),
        "outstanding_now": m(cur_out),
        "outstanding_safe": m(cur_out - r["against"]),
        "outstanding_fifo": m(cur_out - r["against"] - r["fifo"]),
        "unmatched_list": [
            {"party": k, "count": c, "amount": m(val)}
            for k, (c, val) in sorted(r["unmatched"].items(), key=lambda kv: -kv[1][1])[:30]],
        "vendors": [
            {"name": x["name"], "paid": m(x["paid"]), "applied": m(x["applied"]),
             "on_account": m(x["onacct"]),
             "bill_wise": {True: "yes", False: "no", None: "?"}[x["bwise"]]}
            for x in movers[:40]],
    }

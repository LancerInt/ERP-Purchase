"""Shared Freight-Inward import logic — used by BOTH the `import_freight_inward`
management command (files or --live) AND the browser import endpoint.

Given a company and a list of parsed Tally vouchers, it writes FreightInward rows
so each Freight-Inward ledger's rows sum to Tally's Group-Summary closing (its
Debit). Freight is a Direct Expense with no opening balance, so — unlike TDS —
there are no synthetic opening rows: closing = the period's movements.

A freight-inward ledger is identified by NAME ("Freight Inward Charges @ 18%",
"… @ 18% - TVP", "… @ 5%", "… - RCM"), so the offline path needs no master /
group tree. Reporting-only + idempotent: RESETS the company's rows, then
re-inserts. Never touches bills, payables, or the operational freight records.
"""
import re
from datetime import date as _date
from decimal import Decimal

from django.db import transaction

FREIGHT_RE = re.compile(r'freight\s*inward', re.I)


def is_freight_inward(name):
    return bool(FREIGHT_RE.search(name or ''))


def freight_kind(ledger):
    """Coarse kind from the ledger name, for at-a-glance grouping on top of the
    exact per-ledger lines: RCM (reverse charge) / TVP (branch) / a GST rate."""
    l = (ledger or '').lower()
    if 'rcm' in l:
        return 'RCM'
    if 'tvp' in l:
        return 'TVP'
    m = re.search(r'(\d+(?:\.\d+)?)\s*%', l)
    if m:
        return f'{m.group(1)}%'
    return 'Other'


def _to_date(s):
    if not s:
        return None
    if isinstance(s, _date):
        return s
    try:
        return _date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def build_and_store_freight_inward(company, vouchers, dry_run=False):
    """Core import. `vouchers` = parsed Tally voucher dicts (parse_daybook shape).
    Returns a summary dict (also the API/CLI response). Reporting-only, idempotent."""
    from collections import defaultdict
    from .models import FreightInward

    rows, per_ledger, per_kind = [], defaultdict(Decimal), defaultdict(Decimal)
    for v in (vouchers or []):
        legs = [le for le in v.get('ledgers', []) if is_freight_inward(le.get('ledger'))]
        if not legs:
            continue
        party = (v.get('party') or '').strip()
        vdate = _to_date(v.get('date'))
        for le in legs:
            ledger = (le.get('ledger') or '').strip()
            kind = freight_kind(ledger)
            # Skip RCM. "Freight Inward Charges - RCM" is a GST reverse-charge
            # self-invoice mechanism, not a freight COST, and in practice the
            # ledger is polluted with purchase-side RCM (goods value booked against
            # goods suppliers), which inflates Freight Inward wildly (e.g. SS June
            # 2026: Rs 1.70 Cr of goods-RCM vs ~Rs 4 L of real freight). Exclude it
            # so Freight Inward reflects actual transporter charges only.
            if kind == 'RCM':
                continue
            # Stored DEBIT-positive: the export writes an expense debit as a
            # NEGATIVE amount, so negate → the freight cost is a positive number
            # and a ledger's rows sum to its Tally Debit / closing balance.
            amt = (-(le.get('amount') or Decimal('0'))).quantize(Decimal('0.01'))
            per_ledger[ledger] += amt
            per_kind[kind] += amt
            rows.append(dict(
                company=company,
                tally_guid=f"{v.get('guid') or v.get('masterid') or ''}|{ledger}"[:120],
                voucher_no=(v.get('number') or '')[:100],
                voucher_type=(v.get('vtype') or '')[:100],
                voucher_date=vdate,
                ledger_name=ledger[:200], kind=kind,
                party_name=party[:255],
                narration=(v.get('narration') or '')[:2000],
                amount=amt,
            ))

    grand = sum(per_ledger.values(), Decimal('0'))

    if not dry_run:
        with transaction.atomic():
            FreightInward.objects.filter(company=company).delete()
            FreightInward.objects.bulk_create(
                [FreightInward(**r) for r in rows], batch_size=500)

    return {
        'grand_total': str(grand.quantize(Decimal('0.01'))),
        'legs': len(rows),
        'ledgers': [{'ledger': lg, 'kind': freight_kind(lg),
                     'closing': str(per_ledger[lg].quantize(Decimal('0.01')))}
                    for lg in sorted(per_ledger)],
        'kinds': [{'kind': k, 'closing': str(per_kind[k].quantize(Decimal('0.01')))}
                  for k in sorted(per_kind)],
        'rows_written': 0 if dry_run else len(rows),
        'dry_run': dry_run,
    }

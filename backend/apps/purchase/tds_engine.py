"""Automated TDS (Tax Deducted at Source) calculation engine — Indian Income Tax.

VALIDATE-FIRST: ``compute_tds`` returns the EXPECTED TDS for a bill; ``apply_tds``
writes it to ``VendorBill.computed_tds_*`` and sets ``tds_status`` by comparing to
the deduction Tally already recorded (``bill.tds_amount``). It NEVER changes the
bill's total / payable. See "TDS Engine Rules & Technical Specification" v2.4.

Phase 1 covers **194Q** (purchase of goods) and **194C** (freight / contract):
GST exclusion, single-bill + cumulative-annual thresholds, the 194Q
excess-over-limit rule, and the 206AA no-PAN override. Phase 2 adds
194J/I/H/T, Section-197 certificates, 206AB and credit-vs-payment timing.
"""
import datetime
import re
from decimal import Decimal, ROUND_HALF_UP

ZERO = Decimal('0')

# Lightweight stand-in so _ytd_base's "194Q counts goods bills only" branch fires
# without a TdsSection DB lookup — the fresh logic no longer uses TdsSection rows.
from types import SimpleNamespace as _NS
_NS_194Q = _NS(code='194Q')

_PAN_RE = re.compile(r'^[A-Z]{5}[0-9]{4}[A-Z]$')
# Name signals that a vendor is a Company / Firm / LLP (vs a plain individual).
_COMPANY_RE = re.compile(
    r'\b(pvt|private|ltd|limited|llp|llc|inc|corp|corporation|industries|'
    r'enterprises?|traders?|agenc(?:y|ies)|company|co\b|mills|packs?|plastics?|'
    r'containers?|prints?|technolog|solutions?|associates|sons|bros|'
    r'brothers|refractories|poly|graphics|printers|packaging)\b', re.I)


def _fy_bounds(d):
    """Indian financial year (1 Apr – 31 Mar) containing date `d` → (start, end)."""
    d = d or datetime.date.today()
    y = d.year if d.month >= 4 else d.year - 1
    return datetime.date(y, 4, 1), datetime.date(y + 1, 3, 31)


def derive_pan_status(vendor):
    """Explicit pan_status wins. Otherwise: a present PAN of valid format → VALID;
    a present-but-malformed PAN → INVALID; a BLANK PAN → VALID (assumed).

    Why blank → VALID and not MISSING: the ERP vendor master often hasn't captured
    the PAN even though Tally has it (Tally deducted at the normal rate). Treating
    "not captured here" as "no PAN" would wrongly apply the 20% / 5% penalty to
    almost every bill. The statutory penalty only fires when PAN is *explicitly*
    flagged MISSING / INVALID — a deliberate determination, set per vendor."""
    if getattr(vendor, 'pan_status', ''):
        return vendor.pan_status
    pan = (getattr(vendor, 'pan', '') or '').strip().upper()
    if not pan:
        return 'VALID'
    return 'VALID' if _PAN_RE.match(pan) else 'INVALID'


# PAN's 4th character is the holder type — authoritative, unlike a name guess.
#   P = Individual, H = HUF                       → INDIVIDUAL_HUF
#   C = Company, F = Firm/LLP, A/T/B/L/J/G = other→ COMPANY_FIRM_LLP (the
#   "others" TDS rate column; the two-column statutory model has no separate
#   bucket for AOP/BOI/Trust/Govt, which all deduct at the non-individual rate).
_PAN_HOLDER_INDIVIDUAL = {'P', 'H'}
_PAN_HOLDER_ENTITY = {'C', 'F', 'A', 'T', 'B', 'L', 'J', 'G'}


def deductee_category_from_pan(pan):
    """INDIVIDUAL_HUF / COMPANY_FIRM_LLP from a valid PAN's 4th char, else None
    (blank or malformed PAN — caller falls back to the name heuristic)."""
    p = (pan or '').strip().upper()
    if not _PAN_RE.match(p):
        return None
    holder = p[3]
    if holder in _PAN_HOLDER_INDIVIDUAL:
        return 'INDIVIDUAL_HUF'
    if holder in _PAN_HOLDER_ENTITY:
        return 'COMPANY_FIRM_LLP'
    return None


def derive_deductee_category(vendor):
    """Explicit category wins; then the PAN's 4th char (authoritative); then a
    name guess (Company/Firm/LLP when the name looks like a registered entity,
    else Individual/HUF)."""
    if getattr(vendor, 'deductee_category', ''):
        return vendor.deductee_category
    from_pan = deductee_category_from_pan(getattr(vendor, 'pan', ''))
    if from_pan:
        return from_pan
    name = getattr(vendor, 'vendor_name', '') or ''
    return 'COMPANY_FIRM_LLP' if _COMPANY_RE.search(name) else 'INDIVIDUAL_HUF'


# Default statutory TDS section per vendor role. Goods suppliers (raw / packing
# material) fall under 194Q (purchase of goods); labour contractors and generic
# expenses default to 194C. All are editable per vendor — this only seeds the
# form so the operator isn't typing the section/rate from scratch.
VENDOR_TYPE_SECTION_DEFAULT = {
    'RAW_MATERIAL': '194Q',
    'PACKING_MATERIAL': '194Q',
    'CONTRACTOR': '194C',
    'EXPENSE': '194C',
}


def suggest_tds(vendor_type, pan, *, deductee_category=None, section_code=None):
    """Suggested TDS for the vendor master form (A2), now via the fresh logic.

    Returns {deductee_category, section_code, rate} — the rate the operator sees
    pre-filled from vendor_type + PAN. The rate/section come from tds_fresh so the
    form matches what the engine will actually compute. A malformed PAN yields the
    206AA penal rate.
    """
    from .tds_fresh import tds_profile, _FRESH_FREIGHT, _FRESH_EXPENSE
    cat = deductee_category or deductee_category_from_pan(pan) or 'COMPANY_FIRM_LLP'

    # vendor_type → the fresh category bucket (goods vs freight vs expense).
    vt = (vendor_type or '').upper()
    if vt == 'CONTRACTOR':
        fresh_cat = 'FREIGHT'          # labour/transport contractor → 194C path
    elif vt == 'EXPENSE':
        fresh_cat = 'EXPENSE'
    else:
        fresh_cat = 'GOODS'            # raw/packing material → 194Q path

    pan_clean = (pan or '').strip().upper()
    penal = bool(pan_clean) and not _PAN_RE.match(pan_clean)   # malformed → 206AA
    prof = tds_profile({
        'pan': '' if penal else (pan_clean or 'ASSUMEDVALID'),
        'category': fresh_cat,
        'party_type': 'INDIVIDUAL' if (cat or '').startswith('INDIVIDUAL') else 'COMPANY',
        'is_msme': False,
        'transporter_decl': False,
        # Goods: above-threshold so the form shows the 0.1% 194Q rate, not 0.
        'fy_aggregate': 10_000_000,
    })
    rate_pct = prof['rate'] * Decimal('100')
    return {'deductee_category': cat, 'section_code': prof['section'],
            'rate': rate_pct if (section_code is None or section_code == prof['section']) else None}


def _round_tds(amount):
    """Round to the nearest rupee. (Sec 288B is nearest ₹10, but Tally — our
    validation target — rounds to the rupee, and the ±₹10 status tolerance
    absorbs the difference.)"""
    return Decimal(amount).quantize(Decimal('1'), rounding=ROUND_HALF_UP)


def compute_tds(vendor, section, taxable_base, *, ytd_base=ZERO, company=None):
    """Pure calculator — no DB writes. Returns::

        {section, rate, taxable_base (the part taxed), tds_amount, reason, status}

    `taxable_base` = this bill's basic (ex-GST) amount for the section.
    `ytd_base`     = vendor+section FY-to-date basic BEFORE this bill.
    status: 'OK' | 'NONE_DUE' | 'MISSING_DATA'.
    """
    base = Decimal(taxable_base or 0)
    if section is None:
        return {'section': '', 'rate': ZERO, 'taxable_base': ZERO, 'tds_amount': ZERO,
                'reason': 'no TDS section for this bill', 'status': 'MISSING_DATA'}
    code = section.code
    if base <= 0:
        return {'section': code, 'rate': ZERO, 'taxable_base': ZERO, 'tds_amount': ZERO,
                'reason': 'zero taxable base', 'status': 'NONE_DUE'}

    # 194Q applicability gate (buyer turnover > ₹10 Cr).
    if section.is_194q and company is not None and not getattr(company, 'tds_194q_applicable', True):
        return {'section': code, 'rate': ZERO, 'taxable_base': ZERO, 'tds_amount': ZERO,
                'reason': '194Q not applicable (turnover ≤ ₹10 Cr)', 'status': 'NONE_DUE'}
    # Per-vendor 194Q exemption (TCS seller 206C(1H), or agri produce).
    if section.is_194q and getattr(vendor, 'tds_exempt_194q', False):
        why = getattr(vendor, 'tds_exempt_reason', '') or 'exempt'
        return {'section': code, 'rate': ZERO, 'taxable_base': ZERO, 'tds_amount': ZERO,
                'reason': f'194Q exempt ({why})', 'status': 'NONE_DUE'}

    prior = Decimal(ytd_base or 0)
    new_ytd = prior + base
    single = Decimal(section.single_bill_limit or 0)
    annual = Decimal(section.annual_limit or 0)

    # ── How much of THIS bill is taxable? ──
    if section.is_194q:
        # Tax only the cumulative amount exceeding the annual limit (₹50L).
        taxed = max(ZERO, new_ytd - max(annual, prior))
    elif annual > 0 and prior < annual <= new_ytd:
        # First time the FY crosses the annual limit → tax this bill PLUS the
        # prior bills that were still untaxed (retrospective). Simplified: prior
        # under the limit were untaxed, so the whole year-to-date becomes taxable.
        taxed = new_ytd
    elif annual > 0 and prior >= annual:
        taxed = base                                  # annual already breached → whole bill
    elif single > 0 and base >= single:
        taxed = base                                  # single-bill breach → whole bill
    else:
        taxed = ZERO                                  # below every threshold → nothing yet

    if taxed <= 0:
        return {'section': code, 'rate': ZERO, 'taxable_base': ZERO, 'tds_amount': ZERO,
                'reason': 'below threshold', 'status': 'NONE_DUE'}

    # ── Rate (206AA no-PAN → 206AB → category) ──
    pan_status = derive_pan_status(vendor)
    cat = derive_deductee_category(vendor)
    std = Decimal(section.rate_others if cat == 'COMPANY_FIRM_LLP' else section.rate_ind_huf)
    if pan_status in ('MISSING', 'INVALID', 'INOPERATIVE'):
        rate = Decimal(section.rate_no_pan or (5 if section.is_194q else 20))
        reason = f'no/invalid PAN → {rate}%'
    elif getattr(vendor, 'is_206ab_specified', False):
        rate = max(std * 2, Decimal('5'))
        reason = f'206AB specified → max(2×std, 5%) = {rate}%'
    else:
        rate = std
        reason = f'{cat} @ {rate}%'

    return {'section': code, 'rate': rate, 'taxable_base': taxed,
            'tds_amount': _round_tds(taxed * rate / Decimal('100')),
            'reason': reason, 'status': 'OK'}


# ── Bill-level glue (reads the ERP bill, writes computed_tds_*) ───────────

# Spend categories that are "purchase of goods" (→ 194Q) vs freight (→ 194C).
# 194Q covers RM + Packing + UNCLASSIFIED. Unclassified ('') is kept IN because
# real goods vendors are sometimes untagged — notably Sperrholz (the biggest 194Q
# vendor) sits unclassified; dropping '' zeroed it. MAIZE and BOUGHT_NOTE stay OUT:
# agri produce bought from farmers is exempt from 194Q. True exemptions on an
# RM-tagged vendor (agri mis-tag, or a TCS seller like Coromandel) are a per-vendor
# call — flag the vendor rather than widen/narrow the category here.
_GOODS_CATS = ('RM', 'PACKING', '')
_FREIGHT_CATS = ('FREIGHT',)


def _section_for_bill(bill, vendor):
    """Vendor's `default_tds_section` wins; else derive from the bill's spend
    category (goods → 194Q, freight → 194C). Returns a TdsSection or None."""
    from master.models import TdsSection
    if getattr(vendor, 'default_tds_section_id', None):
        return vendor.default_tds_section
    cat = (getattr(bill, 'purchase_category', '') or '').upper()
    code = '194Q' if cat in _GOODS_CATS else '194C' if cat in _FREIGHT_CATS else None
    return TdsSection.objects.filter(code=code, is_active=True).first() if code else None


def taxable_base_of(bill):
    """Basic (ex-GST) amount to tax: the subtotal if present, else total − tax,
    else the total (CBDT 23/2017 — exclude GST when itemised).

    Fallback: some GST-Journal / scan imports keep the value on the LINE ITEMS
    but leave the bill header total at 0 (e.g. an engineering/works-contract bill
    whose lines sum to real money but total_amount=0). When the header is empty,
    fall back to the sum of the line amounts (the ex-GST line value) so the engine
    taxes the real base instead of 0."""
    sub = getattr(bill, 'subtotal', None)
    if sub and Decimal(sub) > 0:
        return Decimal(sub)
    total = Decimal(getattr(bill, 'total_amount', 0) or 0)
    tax = Decimal(getattr(bill, 'tax_amount', 0) or 0)
    if total > 0:
        return total - tax if tax else total
    # Header is 0 — sum the lines instead (abs, since legacy lines could be signed).
    if getattr(bill, 'pk', None):
        from django.db.models import Sum
        from .models import VendorBillLine
        s = (VendorBillLine.objects.filter(bill_id=bill.pk, is_active=True)
             .aggregate(t=Sum('amount'))['t'])
        if s:
            return abs(Decimal(s))
    return ZERO


def _ytd_base(bill, vendor, section):
    """Vendor FY-to-date basic BEFORE this bill, toward this section's threshold.

    194Q counts only GOODS bills (it's TDS on purchase of goods). Every other
    section (194C freight/labour, 194J, 194I, …) counts ALL the vendor's bills —
    such a vendor is wholly a service/freight vendor, and its bills may be tagged
    EXPENSES while its TDS section is set on the vendor, so we must not filter by
    spend category or the cumulative threshold would never build up."""
    from .models import VendorBill
    fy_start, _ = _fy_bounds(bill.bill_date)
    qs = (VendorBill.objects.filter(vendor=vendor, is_active=True,
                                    bill_date__gte=fy_start, bill_date__lt=bill.bill_date)
          .exclude(status='CANCELLED').exclude(pk=bill.pk))
    if section and section.code == '194Q':
        qs = qs.filter(purchase_category__in=list(_GOODS_CATS))
    return sum((taxable_base_of(b) for b in qs.only('subtotal', 'total_amount', 'tax_amount')), ZERO)


def apply_tds(bill, *, save=True, force=False):
    """Compute the expected TDS for `bill`, store it in computed_tds_*, and set
    tds_status by comparing to the deducted `bill.tds_amount`. Reporting-only —
    the bill's totals are untouched. Returns the computed dict, or None when the
    engine is off / the bill has no vendor. `force=True` bypasses the per-company
    enable flag (used by the recompute_tds command to validate before go-live)."""
    vendor = getattr(bill, 'vendor', None)
    if vendor is None:
        return None
    company = getattr(vendor, 'company', None)
    if not force and company is not None and not getattr(company, 'tds_engine_enabled', False):
        return None

    if not bill.bill_date:
        return None
    # Branch / sister-entity vendors = internal stock transfers, NOT a purchase —
    # no TDS applies (Tally deducts nothing). Skip them like the purchase tiles do,
    # or a 194C row Tally booked against the branch wrongly taxes ₹lakhs of transfers.
    if getattr(vendor, 'is_branch', False):
        bill.computed_tds_amount = ZERO
        bill.computed_tds_section = ''
        bill.tds_status = 'NONE_DUE'
        if save and bill.pk:
            bill.save(update_fields=['computed_tds_amount', 'computed_tds_section', 'tds_status'])
        return {'section': '', 'rate': ZERO, 'taxable_base': ZERO, 'tds_amount': ZERO,
                'reason': 'branch transfer (no TDS)', 'status': 'NONE_DUE'}
    # Agri produce bought from farmers (bought notes / maize) is outside 194Q and
    # carries no 194C — so it's explicitly NONE_DUE, not MISSING_DATA (which it
    # would otherwise be, since these categories map to no section). This is the
    # bulk of the "can't compute" bills and Tally deducts nothing on them.
    # BUT only when the vendor has NO explicit default_tds_section: a commercial
    # maize TRADER (e.g. Sperrholz) is a real 194Q vendor and has 194Q set on the
    # master — honour that deliberate determination over the blunt category rule.
    if (not getattr(vendor, 'default_tds_section_id', None)
            and (getattr(bill, 'purchase_category', '') or '').upper() in ('BOUGHT_NOTE', 'MAIZE')):
        bill.computed_tds_amount = ZERO
        bill.computed_tds_section = ''
        bill.tds_status = 'NONE_DUE'
        if save and bill.pk:
            bill.save(update_fields=['computed_tds_amount', 'computed_tds_section', 'tds_status'])
        return {'section': '', 'rate': ZERO, 'taxable_base': ZERO, 'tds_amount': ZERO,
                'reason': 'agri produce from farmer (exempt)', 'status': 'NONE_DUE'}
    # ── Section + rate decided by the fresh prototype logic (tds_fresh) ──────
    # The ERP guards above (branch / agri / enable-flag / persistence / the
    # status comparison below) stay here; only the rate/section determination is
    # now the clean tds_fresh calculator. fy_aggregate = vendor FY-to-date base
    # BEFORE this bill + this bill's base, which drives the 194Q ₹50L threshold.
    from .tds_fresh import compute_for_bill
    base = taxable_base_of(bill)
    _goods_ytd = _ytd_base(bill, vendor, _NS_194Q)   # 194Q counts goods bills only
    fy_aggregate = _goods_ytd + base
    res = compute_for_bill(bill, vendor, taxable_base=base, fy_aggregate=fy_aggregate)
    # Fresh logic always produces a figure; synthesise the status the wrapper
    # expects (NONE_DUE when nothing is due, else OK — no MISSING_DATA path now).
    res['status'] = 'NONE_DUE' if Decimal(res['tds_amount'] or 0) == 0 else 'OK'

    bill.computed_tds_amount = res['tds_amount']
    bill.computed_tds_section = res['section']
    expected = Decimal(res['tds_amount'] or 0)
    deducted = Decimal(bill.tds_amount or 0)
    if res['status'] == 'MISSING_DATA':
        bill.tds_status = 'MISSING_DATA'
    elif expected == 0 and deducted == 0:
        bill.tds_status = 'NONE_DUE'
    elif abs(expected - deducted) <= max(Decimal('100'), expected * Decimal('0.02')):
        bill.tds_status = 'OK'     # within ₹100 or 2% — base/rounding noise, not a real gap
    else:
        bill.tds_status = 'MISMATCH'

    if save and bill.pk:
        bill.save(update_fields=['computed_tds_amount', 'computed_tds_section', 'tds_status'])
    return res

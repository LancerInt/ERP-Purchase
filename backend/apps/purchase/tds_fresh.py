"""Fresh TDS determination logic — a clean, prototype-faithful calculator.

Pure functions, no Django / DB: given a vendor's TDS-relevant attributes it
returns which section + rate applies and the tax due. This is the calculator the
new TDS Summary report uses; the legacy tds_engine.py (which scan, bill-save and
Tally-import depend on) is left untouched.

Mirrors the prototype's `tdsProfile` + FY constants:
  * no PAN            → 206AA  5% penal
  * FREIGHT + decl    → 194C(6) NIL
  * FREIGHT / EXPENSE → 194C   1% individual/MSME, 2% company
  * goods             → 194Q   0.1% on the FY aggregate above ₹50L, else 0%
"""

from decimal import Decimal, ROUND_HALF_UP

# ── FY constants (sync with the prototype FY block) ──────────────────────────
Q194_LIMIT = Decimal('5000000')    # ₹50L per seller per FY
Q194_RATE = Decimal('0.001')       # 0.1% on the excess
NOPAN_RATE = Decimal('0.05')       # sec 206AA penal
C194_IND = Decimal('0.01')         # 194C individual
C194_CO = Decimal('0.02')          # 194C company
C194_MSME = Decimal('0.01')        # 194C MSME
# 194C thresholds (sec 194C(5)): deduct only once a SINGLE bill ≥ ₹30,000 OR the
# vendor's FY aggregate ≥ ₹1,00,000. Below BOTH, nothing is deducted — a small
# expense/freight bill must NOT attract TDS from the first rupee.
C194_SINGLE_LIMIT = Decimal('30000')     # ₹30,000 per single bill
C194_ANNUAL_LIMIT = Decimal('100000')    # ₹1,00,000 FY aggregate per vendor

# Categories that are works/contract (194C) rather than goods (194Q).
_CONTRACT_CATS = {'FREIGHT', 'EXPENSE', 'EXPENSES'}


def _d(v):
    if v is None:
        return Decimal('0')
    if isinstance(v, Decimal):
        return v
    return Decimal(str(v))


def _c194_rate(*, is_msme, party_type):
    """194C rate: MSME 1%, individual 1%, otherwise (company) 2%."""
    if is_msme:
        return C194_MSME
    return C194_IND if (party_type or '').upper() == 'INDIVIDUAL' else C194_CO


def tds_profile(vendor):
    """Return {section, rate, base, reason} for a vendor this FY.

    `vendor` is a dict/obj with: pan, category, party_type, is_msme,
    transporter_decl, fy_aggregate. `base` is None for 194C (assessed per bill);
    for 194Q it is the amount above the ₹50L threshold.
    """
    def g(k, default=None):
        if isinstance(vendor, dict):
            return vendor.get(k, default)
        return getattr(vendor, k, default)

    pan = (g('pan') or '').strip()
    category = (g('category') or '').upper()
    party_type = g('party_type')
    is_msme = bool(g('is_msme'))
    transporter_decl = bool(g('transporter_decl'))

    if not pan:
        # Penal rate assessed on the per-bill / aggregate base (base=None), like
        # 194C — not a fixed excess the way 194Q is.
        return {'section': '206AA', 'rate': NOPAN_RATE, 'base': None,
                'reason': 'No PAN on master — 5% penal rate until PAN captured'}

    if category == 'FREIGHT' and transporter_decl:
        return {'section': '194C(6)', 'rate': Decimal('0'), 'base': Decimal('0'),
                'reason': 'Transporter ≤10 carriages + PAN declaration on file — NIL deduction'}

    if category in _CONTRACT_CATS:
        # 194C(5) threshold: deduct only once a SINGLE bill ≥ ₹30,000 OR the FY
        # aggregate ≥ ₹1,00,000. Below BOTH → NIL (a ₹6,450 expense bill must not
        # be taxed from rupee one). this_bill_base is the single-bill ex-GST base;
        # fy_aggregate is the vendor FY-to-date base (this bill included).
        this_bill = _d(g('this_bill_base'))
        agg = _d(g('fy_aggregate'))
        if this_bill < C194_SINGLE_LIMIT and agg < C194_ANNUAL_LIMIT:
            return {'section': '194C', 'rate': Decimal('0'), 'base': Decimal('0'),
                    'reason': (f'194C below threshold — single bill < ₹30,000 and '
                               f'FY aggregate < ₹1,00,000 (no deduction yet)')}
        rate = _c194_rate(is_msme=is_msme, party_type=party_type)
        label = 'MSME 1%' if is_msme else ('Individual 1%' if (party_type or '').upper() == 'INDIVIDUAL' else 'Company 2%')
        return {'section': '194C', 'rate': rate, 'base': None,
                'reason': f'Works/contract — {label}'}

    agg = _d(g('fy_aggregate'))
    if agg > Q194_LIMIT:
        excess = agg - Q194_LIMIT
        return {'section': '194Q', 'rate': Q194_RATE, 'base': excess,
                'reason': f'FY aggregate crossed ₹50L — 0.1% on the excess {excess}'}
    return {'section': '194Q', 'rate': Decimal('0'), 'base': Decimal('0'),
            'reason': 'FY aggregate still below the ₹50L threshold — no deduction yet'}


def tds_due(profile, taxable_base=0):
    """TDS amount = rate × base. For 194Q the base is the profile's excess;
    for 194C (base None) the caller's per-bill taxable_base is used."""
    rate = _d(profile.get('rate'))
    base = profile.get('base')
    base = _d(taxable_base) if base is None else _d(base)
    return (rate * base).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


# ── Bill-level adapter: map a real VendorBill + Vendor to fresh-logic inputs ──
# The pure functions above are the rate/section decider. This adapter translates
# the ERP's real fields into their inputs, deliberately honouring two ERP
# conventions that the bare prototype lacks (kept as guards, per the plan):
#   * PAN: a BLANK PAN is assumed VALID (Tally often has it even when the master
#     doesn't) — only an explicitly MISSING/INVALID pan_status triggers 206AA.
#     So we pass a sentinel PAN for "assumed valid, blank" so tds_fresh does NOT
#     wrongly apply the penal rate.
#   * party_type: derived from the PAN's 4th char / deductee_category, mapping the
#     ERP's INDIVIDUAL_HUF/COMPANY_FIRM_LLP onto the prototype's INDIVIDUAL/COMPANY.

# Spend categories → the prototype's category buckets.
_FRESH_FREIGHT = ('FREIGHT',)
_FRESH_EXPENSE = ('EXPENSES', 'EXPENSE', 'MACHINERY', 'LAB_EXPENSE')
# everything else (RM/PACKING/MAIZE/BOUGHT_NOTE/blank) is "goods" → 194Q path.


def _fresh_category(purchase_category):
    cat = (purchase_category or '').upper()
    if cat in _FRESH_FREIGHT:
        return 'FREIGHT'
    if cat in _FRESH_EXPENSE:
        return 'EXPENSE'
    return 'GOODS'


def _fresh_party_type(deductee_category):
    # ERP: INDIVIDUAL_HUF / COMPANY_FIRM_LLP → prototype: INDIVIDUAL / COMPANY.
    return 'INDIVIDUAL' if (deductee_category or '').upper().startswith('INDIVIDUAL') else 'COMPANY'


def vendor_inputs_for_bill(bill, vendor, *, fy_aggregate, this_bill_base=None):
    """Build the tds_fresh `vendor` dict from the real bill + vendor + FY aggregate.
    Uses the ERP's PAN convention via derive_pan_status (imported lazily to avoid a
    cycle): a blank-but-assumed-valid PAN is passed as a sentinel so 206AA is NOT
    applied; only an explicitly MISSING/INVALID status drops the PAN (→ penal)."""
    from .tds_engine import derive_pan_status, derive_deductee_category
    pan_status = derive_pan_status(vendor)
    real_pan = (getattr(vendor, 'pan', '') or '').strip()
    # Penal only when the PAN is DELIBERATELY flagged bad. Otherwise present a PAN
    # to tds_fresh (the real one, or an 'assumed valid' sentinel when blank).
    if pan_status in ('MISSING', 'INVALID', 'INOPERATIVE'):
        pan = ''                         # → 206AA
    else:
        pan = real_pan or 'ASSUMEDVALID'  # blank-but-assumed-valid → normal rate
    return {
        'pan': pan,
        'category': _fresh_category(getattr(bill, 'purchase_category', '')),
        'party_type': _fresh_party_type(derive_deductee_category(vendor)),
        'is_msme': bool(getattr(vendor, 'is_msme', False)),
        # No 194C(6) transporter-declaration field on the master yet, so this is
        # always False (freight → 194C, never the nil 194C(6)). Add a vendor
        # boolean later to enable the NIL path; getattr keeps it safe until then.
        'transporter_decl': bool(getattr(vendor, 'transporter_declaration', False)),
        'fy_aggregate': fy_aggregate,
        # Single-bill ex-GST base, for the 194C ₹30,000 single-bill threshold.
        'this_bill_base': this_bill_base,
    }


def compute_for_bill(bill, vendor, *, taxable_base, fy_aggregate):
    """Fresh section+rate+amount for one bill. Returns the tds_fresh profile plus
    the rupee tds_amount on the given taxable_base. The branch/agri/enable-flag
    guards stay in apply_tds (the caller) — this is only the rate/section decision."""
    inputs = vendor_inputs_for_bill(bill, vendor, fy_aggregate=fy_aggregate,
                                    this_bill_base=taxable_base)
    profile = tds_profile(inputs)
    amount = tds_due(profile, taxable_base=taxable_base)
    return {'section': profile['section'], 'rate': profile['rate'],
            'taxable_base': _d(taxable_base), 'tds_amount': amount,
            'reason': profile['reason']}


def summary_row(vendor):
    """One TDS Summary row: {vendor, pan, section, rate_pct, fy_aggregate, tds_due}."""
    def g(k, default=None):
        if isinstance(vendor, dict):
            return vendor.get(k, default)
        return getattr(vendor, k, default)

    prof = tds_profile(vendor)
    agg = _d(g('fy_aggregate'))
    # 194C has no FY-aggregate base; show due on the aggregate so the report has a figure.
    due = tds_due(prof, taxable_base=agg)
    return {
        'vendor': g('name') or g('vendor_name') or '',
        'pan': (g('pan') or '').strip(),
        'section': prof['section'],
        'rate_pct': str((prof['rate'] * Decimal('100')).quantize(Decimal('0.01'))),
        'fy_aggregate': str(agg.quantize(Decimal('0.01'))),
        'tds_due': str(due),
        'reason': prof['reason'],
    }

"""Pure, DB-free logic for freight MSME and freight TDS (section 194C).

Kept deliberately free of Django models so the *rules* can be unit-tested in
isolation and reused by views, importers and the freight workspace. Each
function takes plain values (amounts as Decimal, dates as date) and returns a
plain result — no ORM, no I/O.

Two legal rules live here:

1. MSME §15 payment window (MSMED Act 2006, §15 + Income-tax §43B(h)):
   A buyer must pay an MSME **micro/small** supplier within the agreed period,
   capped at **45 days** when a written agreement exists, else **15 days**.
   MEDIUM enterprises get NO protection. A transporter who is MSME-registered
   (Udyam) is a supplier of services and gets the same protection.

2. TDS on freight (Income-tax §194C — payments to a transport contractor):
   Deduct **1%** when the transporter is an individual/HUF, **2%** otherwise
   (company/firm). §194C(6): NO TDS if the transporter owns <=10 goods carriages
   AND has furnished their PAN + a declaration. A missing PAN forces **20%**
   (§206AA). Small-payment threshold: no TDS if a single payment <= 30,000 and
   the aggregate in the FY <= 1,00,000.
"""
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

Q2 = Decimal('0.01')


def _money(v):
    return (Decimal(str(v or '0'))).quantize(Q2, rounding=ROUND_HALF_UP)


# ─────────────────────────── MSME ───────────────────────────

# Only MICRO and SMALL get §15 protection. MEDIUM is excluded by law.
MSME_PROTECTED = frozenset({'MICRO', 'SMALL'})


def is_msme_protected(category):
    """True only for MICRO / SMALL (the categories §15 protects)."""
    return (category or '').strip().upper() in MSME_PROTECTED


def msme_limit_days(has_written_agreement):
    """§15 window: 45 days WITH a written agreement, else 15 days."""
    return 45 if has_written_agreement else 15


def msme_due_date(advice_date, has_written_agreement):
    """The statutory last day to pay an MSME freight advice without breach."""
    return advice_date + timedelta(days=msme_limit_days(has_written_agreement))


def msme_days_overdue(advice_date, has_written_agreement, as_of):
    """Days past the §15 due date (0 if not yet due). Negative never returned."""
    due = msme_due_date(advice_date, has_written_agreement)
    return max(0, (as_of - due).days)


def msme_breaches(advice_date, has_written_agreement, as_of, is_paid):
    """True when an UNPAID advice to a protected MSME transporter is past §15.

    Paid advices never breach (the clock stops at payment — callers that want
    'paid late' pass the payment date as `as_of` with is_paid=False).
    """
    if is_paid:
        return False
    return msme_days_overdue(advice_date, has_written_agreement, as_of) > 0


def msme_disallowance(amount, category, has_written_agreement,
                      advice_date, as_of, is_paid):
    """§43B(h) disallowed amount: the freight cost is disallowed for the year
    while it sits unpaid beyond the §15 window for a MICRO/SMALL transporter.
    Returns Decimal 0 when not protected, not a micro/small, or within time.
    """
    if not is_msme_protected(category):
        return _money(0)
    if not msme_breaches(advice_date, has_written_agreement, as_of, is_paid):
        return _money(0)
    return _money(amount)


# ─────────────────────────── TDS 194C ───────────────────────────

RATE_INDIVIDUAL = Decimal('0.01')   # individual / HUF transporter
RATE_OTHER = Decimal('0.02')        # company / firm / AOP
RATE_NO_PAN = Decimal('0.20')       # §206AA — PAN not furnished

# §194C small-payment thresholds (freight).
SINGLE_LIMIT = Decimal('30000')     # one payment at/below this: no TDS alone
ANNUAL_LIMIT = Decimal('100000')    # aggregate in FY at/below this: no TDS


def tds_rate_194c(is_individual, has_pan):
    """Applicable §194C rate as a Decimal fraction.

    No PAN -> 20% (§206AA) regardless of constitution. With PAN: 1% for an
    individual/HUF, 2% otherwise.
    """
    if not has_pan:
        return RATE_NO_PAN
    return RATE_INDIVIDUAL if is_individual else RATE_OTHER


def tds_194c_exempt_small_carrier(owns_10_or_fewer_carriages, has_pan,
                                  has_declaration):
    """§194C(6): a goods-transport operator owning <=10 carriages who furnishes
    PAN + a declaration is fully exempt from TDS. All three must hold.
    """
    return bool(owns_10_or_fewer_carriages and has_pan and has_declaration)


def tds_below_threshold(this_payment, fy_aggregate_including_this):
    """True when §194C thresholds exempt the payment: a single payment at/below
    30,000 AND the FY aggregate (this payment included) at/below 1,00,000.
    Once aggregate crosses 1,00,000, TDS applies to the whole aggregate.
    """
    return (_money(this_payment) <= SINGLE_LIMIT
            and _money(fy_aggregate_including_this) <= ANNUAL_LIMIT)


def compute_freight_tds(amount, *, is_individual, has_pan,
                        this_payment=None, fy_aggregate_including_this=None,
                        owns_10_or_fewer_carriages=False, has_declaration=False):
    """Deductible §194C TDS on a freight amount.

    Order of exemptions:
      1. §194C(6) small-carrier declaration -> 0
      2. §194C small-payment thresholds     -> 0
      3. else amount * rate(individual, pan)

    `this_payment` / `fy_aggregate_including_this` default to `amount` / `amount`
    when not supplied (single-payment view). Returns Decimal, 2 dp.
    """
    amount = _money(amount)
    if amount <= 0:
        return _money(0)

    if tds_194c_exempt_small_carrier(owns_10_or_fewer_carriages, has_pan,
                                     has_declaration):
        return _money(0)

    sp = amount if this_payment is None else _money(this_payment)
    agg = amount if fy_aggregate_including_this is None else _money(fy_aggregate_including_this)
    if tds_below_threshold(sp, agg):
        return _money(0)

    return _money(amount * tds_rate_194c(is_individual, has_pan))


# ─────────────────────────── RCM / GTA GST ───────────────────────────
#
# On GTA (Goods Transport Agency) freight, GST is paid under Reverse Charge by
# the RECIPIENT (us) to the government — not to the transporter. The transporter
# is paid the freight ONLY; the GST is a separate govt liability that a
# registered recipient claims straight back as ITC, so it nets to zero.
#
# RCM applies only when:
#   - the service is GTA, AND
#   - the GTA has NOT opted to pay under forward charge (if it charges GST on its
#     own bill, that is forward charge — no RCM), AND
#   - the consignment is not GST-exempt.
#
# Rate under RCM is 5%, split CGST 2.5% + SGST 2.5% (intra-state) or IGST 5%
# (inter-state). §194C TDS is computed on the freight base, unaffected by RCM.

RCM_RATE = Decimal('0.05')          # 5% GTA reverse charge
RCM_HALF = Decimal('0.025')         # CGST / SGST half each (intra-state)

# Small-consignment GTA exemptions (Notification 12/2017-CT(R)):
EXEMPT_SINGLE_CARRIAGE = Decimal('1500')   # one carriage, all goods: <=1500 exempt
EXEMPT_SINGLE_CONSIGNEE = Decimal('750')   # one consignee's goods: <=750 exempt


def gta_is_exempt(freight_amount, *, single_carriage=False,
                  single_consignee=False, agricultural=False):
    """True when a GTA consignment is GST-exempt, so NO GST (RCM or forward).

    - Agricultural produce (and the other blanket-exempt goods) -> exempt.
    - A single carriage carrying goods for a total freight <= 1,500 -> exempt.
    - A single consignee whose goods' freight <= 750 -> exempt.
    """
    if agricultural:
        return True
    amt = _money(freight_amount)
    if single_carriage and amt <= EXEMPT_SINGLE_CARRIAGE:
        return True
    if single_consignee and amt <= EXEMPT_SINGLE_CONSIGNEE:
        return True
    return False


def rcm_applies(*, is_gta, gta_opted_forward_charge, exempt):
    """RCM applies only to non-exempt GTA freight where the GTA has NOT opted
    for forward charge.
    """
    return bool(is_gta and not gta_opted_forward_charge and not exempt)


def compute_rcm_gst(freight_amount, *, is_gta=True, gta_opted_forward_charge=False,
                    single_carriage=False, single_consignee=False,
                    agricultural=False, inter_state=False):
    """Reverse-charge GST payable to govt on a GTA freight amount.

    Returns a dict:
      {applies, taxable, igst, cgst, sgst, total, itc_claimable}
    - `applies` False (not GTA / forward charge / exempt) -> all zero.
    - inter_state True -> IGST 5%; else CGST 2.5% + SGST 2.5%.
    - `itc_claimable` mirrors `total`: a registered recipient claims it back,
      so the net cash tax cost is zero (tracked for the GST return, not as cost).
    """
    amt = _money(freight_amount)
    exempt = gta_is_exempt(amt, single_carriage=single_carriage,
                           single_consignee=single_consignee,
                           agricultural=agricultural)
    if not rcm_applies(is_gta=is_gta,
                       gta_opted_forward_charge=gta_opted_forward_charge,
                       exempt=exempt):
        z = _money(0)
        return {'applies': False, 'taxable': amt, 'igst': z, 'cgst': z,
                'sgst': z, 'total': z, 'itc_claimable': z}

    if inter_state:
        igst = _money(amt * RCM_RATE)
        total = igst
        cgst = sgst = _money(0)
    else:
        cgst = _money(amt * RCM_HALF)
        sgst = _money(amt * RCM_HALF)
        igst = _money(0)
        total = _money(cgst + sgst)

    return {'applies': True, 'taxable': amt, 'igst': igst, 'cgst': cgst,
            'sgst': sgst, 'total': total, 'itc_claimable': total}


def transporter_payable_excludes_rcm(freight_amount):
    """What we actually pay the transporter: the freight ONLY. RCM GST never
    goes to the transporter, so the payable equals the freight amount.
    """
    return _money(freight_amount)


# ─────────────── Road SAC codes (road-only shipper) ───────────────
#
# A consignment note (LR/Bilty) makes the service GTA (SAC 996511). Road
# transport WITHOUT a consignment note (plain truck/fleet hire) is rental of a
# road vehicle (SAC 996791) — not GTA, so RCM does not apply to it.

SAC_GTA_ROAD = '996511'         # GTA road freight (has consignment note)
SAC_ROAD_RENTAL = '996791'      # road vehicle rental (no consignment note)


def classify_road_service(has_consignment_note):
    """Return (sac_code, is_gta) for a road freight entry.

    A consignment note => GTA (996511, RCM-eligible). No note => vehicle rental
    (996791, not GTA — forward-charge / normal, no RCM).
    """
    if has_consignment_note:
        return SAC_GTA_ROAD, True
    return SAC_ROAD_RENTAL, False


# ─────────────── Composite supply: ancillary clubbing ───────────────
#
# Section 8 CGST Act: loading, unloading, packing, detention and fuel surcharge
# billed with the principal freight are part of a composite supply, taxed at the
# freight's rate on the COMBINED value. So RCM/GST is computed on freight +
# ancillaries, not on freight alone.

def composite_taxable_value(freight_amount, *, loading=0, unloading=0,
                            packing=0, detention=0, fuel_surcharge=0, other=0):
    """Principal freight + all clubbed ancillary charges = the taxable value
    the freight GST rate applies to (Section 8 composite supply).
    """
    parts = [freight_amount, loading, unloading, packing, detention,
             fuel_surcharge, other]
    total = sum((_money(p) for p in parts), _money(0))
    return _money(total)


# ─────────────── Forward charge (FCM): 5% vs 12% + Annexure V ───────────────
#
# A GTA may OPT to pay under forward charge by filing Annexure V for the FY.
# Then it charges GST on its own bill — 5% (without ITC to the GTA) or 12%
# (with ITC). For us (the recipient) the GST is on the transporter's invoice and
# claimed as ordinary ITC — NOT reverse charge.

FCM_RATE_5 = Decimal('0.05')
FCM_RATE_12 = Decimal('0.12')


def annexure_v_valid(opted_fy, current_fy):
    """Annexure V opt-in is per financial year. Forward charge is valid only
    for the FY it was filed for (opted_fy == current_fy).
    """
    return bool(opted_fy) and str(opted_fy) == str(current_fy)


def compute_fcm_gst(taxable_value, *, slab_12=False):
    """GST on a forward-charge GTA invoice (charged BY the transporter TO us).
    5% default, 12% when the GTA is on the with-ITC slab. Returned for ITC
    tracking; it is part of the transporter's bill, not a separate liability.
    """
    rate = FCM_RATE_12 if slab_12 else FCM_RATE_5
    return _money(_money(taxable_value) * rate)


def freight_charge_mechanism(*, is_gta, has_consignment_note,
                             annexure_v_opted_fy, current_fy):
    """Decide how GST is borne on a GTA road freight for the given FY.

    Returns one of: 'RCM' (we pay reverse charge), 'FCM' (transporter charges
    GST on its bill), or 'NONE' (not GTA — vehicle rental, ordinary forward GST
    but outside the GTA/RCM regime).
    """
    if not (is_gta and has_consignment_note):
        return 'NONE'
    if annexure_v_valid(annexure_v_opted_fy, current_fy):
        return 'FCM'
    return 'RCM'


# ─────────────── Self-invoicing: unregistered GTA under RCM ───────────────
#
# Section 31(3)(f): when a registered recipient pays RCM on a supply from an
# UNREGISTERED supplier, the recipient must raise a self-invoice. So an RCM
# freight from an unregistered GTA needs a self-invoice; from a registered GTA
# it does not (their consignment note/invoice suffices).

def needs_self_invoice(*, mechanism, supplier_registered):
    """True when we must raise a self-invoice: RCM freight from an unregistered
    GTA (§31(3)(f)). Registered-GTA RCM does not require one.
    """
    return mechanism == 'RCM' and not supplier_registered


# ─────────────── RCM two-ledger posting ───────────────
#
# The RCM 5% must be PAID IN CASH (electronic cash ledger) and simultaneously
# booked as ITC receivable (if eligible) — it is NEVER set off against existing
# ITC to discharge the RCM liability. This returns the two accounting legs so a
# caller can post them; the cash leg and the ITC leg are equal and opposite, so
# the net income-statement cost is zero for an eligible recipient.

def rcm_ledger_postings(rcm_total, *, itc_eligible=True):
    """Two legs for an RCM GST liability:
      - cash_ledger_liability: must be paid in cash (not via ITC set-off)
      - itc_receivable: claimable back, if eligible (else 0 -> a real cost)
    Returns {cash_ledger_liability, itc_receivable, net_cost}.
    """
    liab = _money(rcm_total)
    itc = liab if itc_eligible else _money(0)
    return {'cash_ledger_liability': liab,
            'itc_receivable': itc,
            'net_cost': _money(liab - itc)}

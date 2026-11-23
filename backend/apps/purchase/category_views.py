"""Purchase by Category — the spend split (RM / Packing / Freight / Expenses /
Machinery / Unclassified) across vendor bills, from VendorBill.purchase_category
(set by bill_classification.py). Reporting-only; reads what classify_bills wrote.
The Bills list filters by ?purchase_category=<KEY>, so a category card row links
straight to its bills.
"""
import re
from collections import defaultdict
from datetime import datetime
from decimal import Decimal

from django.db.models import Case, CharField, Count, F, Max, Min, Q, Sum, Value, When
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated

from rbac.permissions import HasModulePermission

from .branch_transfer import branch_transfer_q

# Line "items" that are really CHARGES or ledger/tax postings, not purchased
# materials — hidden from the by-item view (they otherwise appear as odd qty-1,
# no-unit rows, e.g. a "FRIGHT CHARGES" line billed with an RM purchase, or a
# "SGST TAX @ 9% INPUT(EXP)" / "Packing Material Purchase @18%" ledger line that
# some vendors itemise onto the bill).
_CHARGE_RE = re.compile(
    r'(freight|fright|round\s*-?\s*off|discount|\btcs\b|hamali|cartage|transport|'
    r'packing\s+charge|other\s+charge|handling\s+charge|p\s*&\s*f\b|'
    r'shipping|certification|die\s*cost|insurance|rate\s*diff|'  # charge + on-bill expense legs (insurance / rate-difference → Expenses, not a product)
    r'\b[sci]gst\b|input\s*\(exp\)|@\s*\d+\s*%)', re.I)       # tax / ledger lines

# Expense sub-categories / ledgers that are FREIGHT (captured in the Freight module,
# not as an expense bill) or JOURNAL-booked (salary/rent/electricity/interest/bank/
# EPF/ESIC/depreciation/etc. — no vendor invoice exists). A Tally voucher in one of
# these with no ERP bill is "no bill expected" (status 'journal'), NOT a real gap.
_NO_BILL_RE = re.compile(
    r'freight|transport|salary|\brent\b|electric|interest|bank|\bepf\b|\besic?\b|'
    r'depreciat|bonus|gratuit|welfare|\bpf\b|provident|'
    r'rates?\s*(?:&|and)\s*tax|property\s*tax|'
    # muster labour wages (no invoice) + director's remuneration (salary-like).
    # Only ever reached when NOT matched to an ERP bill, so real contractors that
    # DO bill (N.Chandramouli &c.) are already 'erp' before this is consulted.
    r'wage|cooli|coolie|remunerat|director', re.I)


def _nn(s):
    """Normalise a name for loose vendor matching (drop case / punctuation / spaces)."""
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def _expense_status(in_erp, sub, ledger=''):
    """3-way reconcile status for a Tally expense voucher vs the ERP."""
    if in_erp:
        return 'erp'
    if _NO_BILL_RE.search(sub or '') or _NO_BILL_RE.search(ledger or ''):
        return 'journal'
    return 'missing'


def _vendor_matcher(names):
    """match(party) -> True if the Tally party resolves to an ERP vendor that has an
    expense bill. Tolerant of the location/type SUFFIX the ERP vendor carries but the
    Tally party doesn't: 'N.Chandramouli - Labour Contract' must match both the ERP
    'N.Chandramouli - Labour Contract - SLP' AND the shorter 'N.CHANDRAMOULI'. So it
    tests containment BOTH ways, floored at 11 normalised chars to avoid stray hits."""
    exact = {_nn(n) for n in names if n}
    longv = [x for x in exact if len(x) >= 11]

    def match(party):
        p = _nn(party)
        if not p:
            return False
        if p in exact:
            return True
        for v in longv:
            if v in p or (len(p) >= 11 and p in v):
                return True
        return False
    return match

# Bill-note NARRATION typed into a line description (not an item name) — e.g.
# "AS PER B.NO. 332500 / DT: 30-06-2026 / EARLY PAYMENT INTEREST ..." or
# "B.NO: 7 / 29.04.2026 / URAL - 1 NOS @ RS.18000/- ...". Hidden from by-item.
_NARRATION_RE = re.compile(
    r'\bB\.?\s*NO\b|\bBILL\s*NO\b|\bAS\s+PER\b|@\s*RS|\bDT\s*[:.]|\bINTEREST\b'
    r'|EARLY\s+PAYMENT', re.I)

# A line whose "name" is only digits / punctuation (e.g. "8500", "426", a bare
# quantity or date typed into the description) is NOT an item — hidden from by-item.
_NUMERIC_RE = re.compile(r'^[\d\s.,/\-]+$')

# Some imports DOUBLE a name ("Drums MS - 2nd Hand Drums MS - 2nd Hand"). Collapse an
# exact back-to-back repeat (≥4 chars, to spare short legit repeats) to a single copy.
_DOUBLED_RE = re.compile(r'^(.{4,}?)\s+\1$')

# The long-name (>80 char) guard is a NARRATION heuristic — but a corrugated box's
# own spec is legitimately long ("5 Ply corrugated paper boxes size: 375x280x295mm
# with 5 ply top & bottom pads, with offset printing. Specf: 5 Ltr…"). These
# construction words never appear in bill-note narration, so a line carrying them
# is a REAL packing item and must NOT be dropped for length. (A line that also has
# a product master is likewise kept — see the loop.)
_KEEP_LONG_RE = re.compile(
    r'\d\s*ply|top\s*&?\s*bott?om\s*pad|\bpartition|corrugated|\bcartons?\b', re.I)

# Quantity normalisation — weight units FOLD TO KG so a family's quantities are
# comparable (24.7 MTS and 24,660 KG both read as KG). Non-weight units (Nos, PCS,
# L, …) are left as-is: a packing/count item keeps its own unit. A ₹ amount is
# never touched — this only makes the Quantity column consistent.
_WEIGHT_TO_KG = {
    'KG': Decimal('1'), 'KGS': Decimal('1'), 'KGM': Decimal('1'),
    'MT': Decimal('1000'), 'MTS': Decimal('1000'), 'MTON': Decimal('1000'),
    'TON': Decimal('1000'), 'TONS': Decimal('1000'),
    'TONNE': Decimal('1000'), 'TONNES': Decimal('1000'),
    'G': Decimal('0.001'), 'GM': Decimal('0.001'), 'GMS': Decimal('0.001'),
    'GRAM': Decimal('0.001'), 'GRAMS': Decimal('0.001'),
}


def _qty_in_kg(qty, uom):
    """(kg_quantity, True) for a weight unit, else (quantity, False)."""
    f = _WEIGHT_TO_KG.get((uom or '').strip().upper())
    q = Decimal(qty or 0)
    return (q * f, True) if f is not None else (q, False)

# Equivalent WEIGHT-unit spellings fold to ONE canonical label, so a metric tonne
# typed "TON" on one bill and "MTS" on another reads as a SINGLE unit — not two at
# the same price. Non-weight units (PCS, Nos, set, LTR, …) are left exactly as billed.
_UNIT_CANON = {
    'MT': 'MTS', 'MTS': 'MTS', 'MTON': 'MTS', 'TON': 'MTS', 'TONS': 'MTS',
    'TONNE': 'MTS', 'TONNES': 'MTS',
    'KG': 'KG', 'KGS': 'KG', 'KGM': 'KG',
    'G': 'G', 'GM': 'G', 'GMS': 'G', 'GRAM': 'G', 'GRAMS': 'G',
    # Quintal (100 kg) — one label for every spelling, so the per-unit breakdown
    # doesn't show the same unit several times (Qtl. / QT / QUINTALS / the Tamil
    # 'குவிண்டால்' the scan/email AI copied off the invoice were each counted apart).
    'QTL': 'QTL', 'QTLS': 'QTL', 'QT': 'QTL', 'QTS': 'QTL',
    'QUINTAL': 'QTL', 'QUINTALS': 'QTL', 'QNTL': 'QTL', 'QNT': 'QTL',
    # Count units — a piece is a piece however it's spelled.
    'NOS': 'NOS', 'NO': 'NOS', 'PCS': 'NOS', 'PC': 'NOS',
    'PIECE': 'NOS', 'PIECES': 'NOS', 'UNIT': 'NOS', 'UNITS': 'NOS',
    'EA': 'NOS', 'EACH': 'NOS',
    # Litre.
    'L': 'LTR', 'LTR': 'LTR', 'LTRS': 'LTR', 'LITRE': 'LTR', 'LITRES': 'LTR',
    'LITER': 'LTR', 'LITERS': 'LTR',
}
# Regional-script units -> canonical English (upper-casing doesn't fold these).
_REGIONAL_UNIT = {
    'குவிண்டால்': 'QTL',   # quintal (Tamil)
    'கிலோ': 'KG', 'டன்': 'MTS', 'லிட்டர்': 'LTR',   # kilo / ton / litre (Tamil)
    'क्विंटल': 'QTL', 'किलो': 'KG',                 # quintal / kilo (Hindi)
}


def _canon_unit(uom):
    # One label per real unit so the per-unit breakdown never splits the SAME unit
    # across spelling / case / punctuation: Nos/NOS/PCS/PC → NOS, Qtl./QT/குவிண்டால்
    # → QTL, TON/MT → MTS, Kg/s/KGS → KG. Weight spellings also fold for the KG view.
    s = (uom or '').strip()
    if not s:
        return ''
    if s in _REGIONAL_UNIT:
        return _REGIONAL_UNIT[s]
    u = s.upper()
    key = re.sub(r'[\s./\-]', '', u)   # drop punctuation so 'Qtl.'/'Kg/s'/'Nos.' fold
    return _UNIT_CANON.get(key, u)


def _dup_bill_ids(qs):
    """Bill ids to DROP as read-time DUPLICATES so a spend figure is never
    double-counted: the SAME invoice imported twice under a different bill number
    (the importer's "-N" collision suffix — e.g. '3096/2026-27' vs '3096/2026-27-2'),
    identical on (vendor, bill_date, subtotal, total_amount). Keeps the first id per
    group, returns the rest. Self-correcting — once the data is deduped this finds
    nothing. The Bills LIST still shows every row; only the by-category spend nets them."""
    seen, drop = set(), []
    for b in qs.values('id', 'vendor_id', 'bill_date', 'subtotal', 'total_amount').order_by('id'):
        k = (b['vendor_id'], b['bill_date'], str(b['subtotal']), str(b['total_amount']))
        if k in seen:
            drop.append(b['id'])
        else:
            seen.add(k)
    return drop


def _by_effective_category(qs, category):
    """Narrow ``qs`` to the bills a by-category card counts for ``category``, bucketing
    each bill by WHAT IT IS AT ENTRY — the SAME rule the cards use (see the ``_cat``
    Case in PurchaseByCategoryView.get), so the item drill's bill set is identical to
    its card and the item totals tie the card value:
      BRANCH   -> internal branch / stock transfers only.
      EXPENSES -> expense-flagged bills OR purchase_category EXPENSES, minus transfers.
      other    -> that purchase_category, minus transfers and minus expense-flagged bills.
    Branch wins over the expense flag (as in the Case). Nothing is hard-coded — the
    bill's own branch / is_expense flags and stored category decide its bucket."""
    bt = branch_transfer_q()
    if category == 'BRANCH':
        return qs.filter(bt)
    if category == 'EXPENSES':
        return qs.filter(Q(is_expense=True) | Q(purchase_category='EXPENSES')).exclude(bt)
    return qs.filter(purchase_category=category).exclude(bt).exclude(is_expense=True)

# ── By-item grouping (the FAMILY a variety belongs to) ─────────────────
# The product master carries no usable stock-group for packing/RM lines (Tally's
# tree is only imported for finished goods, and many lines are description-only
# with no product), so the family is derived from the item NAME. Ordered rules,
# FIRST MATCH WINS — specific families before generic ones. This is the one place
# to edit / rename / add a family; nothing is hidden elsewhere.
_ITEM_FAMILIES = [(re.compile(rx, re.I), lbl) for rx, lbl in [
    # A CORRUGATED BOX is identified by its construction — "N ply", "top & bottom
    # pads", "partitions", "corrugated", "carton". These words never appear on an
    # RM material, and a box's spec routinely names the PRODUCT it holds
    # ("…250ml nimb", "Taneem 20 ltrs", "NIMB/Export"), so this MUST sit above the
    # RM/neem rules or the box gets mis-grouped as Neem Seed.
    (r'\d\s*ply|top\s*&?\s*bott?om\s*pad|\bpartition|corrugated|\bcartons?\b', 'Corrugated Box'),
    # A BAG / SACK / LINER is packing, and like a box its name routinely carries the
    # PRODUCT it holds ("Subham Neem Cake 50kg Bag", "BOPP … Neem Cake"), so this MUST
    # sit ABOVE the RM/neem rules or the bag gets mis-grouped as Neem Cake. Matched on
    # packing-specific tokens only (bopp / a sized "N kg bag" / poly·pp·hdpe·ldpe bag /
    # liner / closing thread) so a plain RM material is never pulled in.
    (r'\bbopp\b|\d+\s*kg\s*bag|(?:pp|hdpe|ld|ldpe|poly|laminated)\s*bag|\bliner\b|closing\s*thread', 'Bag / Liner'),
    # PRINTED packing — labels, leaflets, stickers, box wrappers, single-colour
    # printing. Exactly like a box or bag, these NAME the product printed on them
    # ("Labels … Nimbecidine 1500ppm", "A5 … Single Colour Printing (Nimbeciding
    # 0.03%)", "NIM Box Wrapper"), so they MUST sit ABOVE the neem/RM rules or the
    # neem catch (\bnim…) drags them into Neem Seed. Packing-print tokens only — a
    # bare RM never says label/leaflet/sticker/wrapper/print.
    (r'leaflet|leaf\s*let|single\s*colou?r\s*print|packing\s*slip|a[45]\s*size.*print', 'Leaflet'),
    (r'\bwrapper\b', 'Wrapper'),
    (r'number\s*sticker|sticker', 'Sticker'),
    # A printing CYLINDER / gravure die — the tooling a bag-printer bills ("NIMBA+
    # 25KG ELECTRONIC CYLINDER"). It NAMES the product it prints, so above neem/RM.
    (r'electronic\s*cylinder|printing\s*cylinder|rotogravure|gravure\s*cylinder', 'Printing Cylinder'),
    (r'\blabels?\b', 'Label'),
    # ── RM / chemical families (name-derived; SPECIFIC → GENERIC, first match
    # wins). Kept ABOVE the packing rules so an RM item that also mentions a
    # container / drum still groups by its material. Spelling variants fold into
    # one family so they stop scattering across the "Other" bucket.
    # Neem products
    (r'azadirachtin|neem[-\s]*extract', 'Neem Extract / Azadirachtin'),
    (r'neem\s*oil', 'Neem Oil'),
    (r'neem\s*cake', 'Neem Cake'),
    (r'neem\s*kern', 'Neem Kernel'),                             # kernal / kernel
    (r'(neem|neern).*(seed|fruit)', 'Neem Seed'),               # + "neern" typo
    # Regional / vernacular neem names — Limbodi·Limboli (neem fruit), Neemboli·
    # Nimboli, Nim Beej (neem seed), Nieem (typo). All are neem seed/fruit (the
    # RM), so fold them into Neem Seed instead of scattering across "Other". Sits
    # AFTER the specific neem products above so Oil/Cake/Kernel/Extract still win.
    (r'neem|nieem|neam|\bnim(?!bu)|limbod|limbol|வேப்ப|வேம்ப|need\s*(kern|fruit)', 'Neem Seed'),  # +"neam"/Tamil வேப்பபழம்(neem fruit)/"need kernal" typos; \bnim but NOT "nimbu"(=lemon)
    # Oils (by type; generic "Oils" catch sits at the end of this block)
    (r'castor', 'Castor Oil'),
    (r'cotton\s*seed', 'Cotton Seed Oil'),
    (r'rice\s*bran', 'Rice Bran Oil'),
    (r'palm\s*ol|\bplam\b|olein', 'Palm Oil'),                  # + "Plam"/"Olein" typos
    (r'sunflower', 'Sunflower Oil'),
    (r'karanja', 'Karanja Oil'),
    # Emulsifiers / surfactants
    (r'\bsvc\b', 'SVC C 408'),
    (r'polysorbate|polysorgen|tween', 'Polysorbate / Tween'),
    (r'\bspan\s*\d', 'Span'),
    (r'garomasol', 'Garomasol'),
    (r'lauryl\s*sulphate', 'Sodium Lauryl Sulphate'),
    # Solvents (Ethyl Acetate its own family; the smaller ones as "Solvent")
    (r'ethyl\s*e?\s*acetate', 'Ethyl Acetate'),
    (r'hexane|butanol|acetone|cyclohexanone|\bsolvents?\b', 'Solvent'),
    # Acids / alkali
    (r'caprylic|caprlic|caprilic', 'Caprylic Acid'),           # + "Caprlic"/"Caprilic" typos
    (r'capric', 'Capric Acid'),
    (r'caustic\s*pot', 'Caustic Potash'),
    (r'caustic\s*soda', 'Caustic Soda'),
    (r'gly[cs]er', 'Glycerine'),
    (r'\bammonia\b', 'Ammonia'),
    # Fillers / bio inputs / misc RM
    (r'biostimulant|stanohume', 'Biostimulant'),
    (r'bentonite', 'Bentonite'),
    (r'\bclay\b', 'Clay'),
    (r'roasted\s*granule|organic\s*granule|\bgranules?\b', 'Granules'),
    # Oil-cakes / de-oiled cakes / extraction residue (seed cakes bought as RM).
    # Specific seed first, then a generic de-oiled/DOC catch; castor/neem cakes
    # already matched their own families ABOVE, so those still win.
    (r'shea', 'Shea Cake'),
    (r'kusum', 'Kusum Cake'),
    (r'mahua|mahuwa|mahwa|mowh?a|mowhow', 'Mahua Cake'),          # + "mowha/mahwa/mowhow" spellings
    (r'palm.*(cake|doc|kernel)|de-?oiled.*palm|screened\s*palm', 'Palm Cake / DOC'),
    (r'de-?oiled|deoiled|\bdoc\b|oil\s*cake|oilcake', 'Oil Cake / DOC'),  # generic de-oiled cake / DOC
    (r'spent\s*waste|chilly\s*spent|\bspent\b', 'Spent / Residue'),
    (r'termeric|turmeric', 'Turmeric'),
    (r'organic\s*manure', 'Organic Manure'),
    (r'citric|guar\s*gum|\bcmc\b|alginate|\bpvp\b|magnesium|sodium\s*sulphate', 'Additives / Excipients'),
    (r'\bsoya\b|milk\s*powder|casein', 'Protein / Dairy'),
    (r'lactobacillus|mrs\s*broth|hi\s*media', 'Lab / Media'),
    (r'plant\s*growth\s*regulat|\bpgr\b', 'Plant Growth Regulator'),
    (r'\boils?\b', 'Oils'),                                      # any remaining "…Oil"
    # ── Packing leftovers that fell into "Other" ──
    # (Leaflet / Label / Sticker / Wrapper now live ABOVE the RM block so a printed
    # packing item that names the product isn't mis-grouped as Neem Seed.)
    (r'\bpallet\b|\bow1\d{3}', 'Pallet'),
    (r'strap\s*roll|strapping', 'Strapping'),
    (r'virgin\s*roll|film\s*roll', 'Roll / Film'),
    # corrugated boxes by their construction (ply / pads / partitions) — safe,
    # these words never appear on a label/bag. The broad "size:"-only catch is
    # LAST (bottom of this list) so Label/Bag win first.
    (r'\d\s*ply|top\s*&?\s*bottom\s*pad|\bpartition', 'Corrugated Box'),
    (r'\bpkt\b|\bpacket\b', 'Pouch'),
    (r'shrink\s*pouch|shrink\s*pou', 'Shrink Pouch'),
    (r'measuring\s*cup', 'Measuring Cup'),
    (r'ang(le|el)\s*board', 'Angle Board'),                     # angle / "angel" typo
    (r'bulktainer|\bibc\b', 'IBC / Bulktainer'),
    (r'sacks|woven', 'Sacks'),
    (r'sleeves', 'Sleeves'),
    (r'\bcaps?\b|\bwad\b|ratchet', 'Caps'),
    (r'vented\s*inner|inner\s*plug|\binner\b', 'Inner / Plug'),
    (r'corrugated', 'Corrugated Box'),
    (r'carton', 'Carton Box'),
    (r'open\s*top\s*drum|paper\s*drum|\bdrums?\b|barrel', 'Drum / Barrel'),
    (r'carbouy', 'Carbouys'),
    (r'bucket', 'Bucket'),
    (r'container\s*with\s*lid', 'Container with Lid'),
    (r'hdpe|hoop|wide\s*mouth|w/m', 'HDPE Container'),
    (r'\bpet\b|pe/evoh|euro\s*neck', 'PET Container'),
    (r'\bcontainer\b', 'Container'),
    (r'bopp|\bbags?\b|liner|closing\s*thread', 'Bag / Liner'),
    (r'plywood|self\s*drilling', 'Plywood / Hardware'),
    (r'\bpouch\b', 'Pouch'),
    (r'polyester|\bbopet\b|\bpet\s*film|poly\s*film', 'Polyester / Film'),   # polyester packing film / fabric
    # LAST RESORT: a dimension-only custom box ("size: … Shefa 500ml"). Kept at the
    # very bottom so Label / Bag / Container / etc. above win first — a "Labels …
    # Size:" or "HIM … BAGS SIZE:" must NOT be dragged into Corrugated Box.
    (r'\bsize\s*:', 'Corrugated Box'),
]]


def _item_family(name):
    for rx, label in _ITEM_FAMILIES:
        if rx.search(name):
            return label
    return ''   # no family rule matched → the frontend shows the item under its OWN
                # (cleaned) name, e.g. "Sago Pith Residue Flour", not a vague "Other"


# Packaging DIMENSIONS + gsm are stripped for DISPLAY only (grouping & search
# still use the raw name). Volumes (ml / ltr / kg) are KEPT — they're what tells
# the varieties in a family apart. e.g. "110mm x 155mm (250ml Pet) Shrink Pouch"
# → "(250ml Pet) Shrink Pouch"; "Label 250 ml (215 x 73 mm) - 100 Gsm" → "Label 250 ml".
_DIM_PARENS_MM = re.compile(r'\(\s*[^)]*\bmm\b[^)]*\)', re.I)
_DIM_PARENS_NUM = re.compile(r'\(\s*[\d.\s]+[x×*][\d.\sx×*]*\)')
_DIM_RUN = re.compile(r'\b\d+(\.\d+)?\s*(mm|cm)?\s*[x×*]\s*\d+(\.\d+)?\s*(mm|cm)?'
                      r'(\s*[x×*]\s*\d+(\.\d+)?\s*(mm|cm)?)*', re.I)
_DIM_UNIT = re.compile(r'\b\d+(\.\d+)?\s*(mm|cm)\b', re.I)
_GSM_RE = re.compile(r'-?\s*\d+\s*gsm\b', re.I)
_LONE_X = re.compile(r'(?<=\s)[x×](?=\s)')
# "size:" / "Specf:" / "Sepcf:" / "Spef:" are just spec labels typed before the
# real name ("size: Sepcf: Shefa 500ml" → "Shefa 500ml"); drop them for display.
_SPEC_PREFIX = re.compile(r'\b(size|specf|sepcf|spef)\s*:', re.I)
# A leading "Label(s) -" is redundant in the by-item view (the family header
# already says "Label"): "Label - 100 ml Art Paper" → "100 ml Art Paper",
# "Labels Label Roll Nimbecidine" → "Label Roll Nimbecidine". Display only.
_LEAD_LABEL = re.compile(r'^\s*labels?\b[\s:\-]*', re.I)

# Vernacular (Tamil) item names get an English display name so the by-item list is
# readable — e.g. "வேப்பபழம்" → "Neem Fruit (வேப்பபழம்)". The raw name still drives
# grouping + search; this is DISPLAY only. First match wins.
_NAME_TRANSLATIONS = [
    (re.compile(r'வேப்பபழம்|வேப்ப\s*பழம்|வேம்பம்\s*பழம்'), 'Neem Fruit'),
    (re.compile(r'வேப்ப\s*விதை|வேம்பு\s*விதை|நிம்\s*விதை'), 'Neem Seed'),
    (re.compile(r'வேப்ப|வேம்ப'), 'Neem'),
]

# Spelling variants of the SAME material, collapsed to one canonical name so the
# by-item view shows a single row instead of near-duplicates. Applied to the
# grouping key (so the rows actually merge), NOT just the display. Reporting-only
# — the product master / bills are unchanged (fix those via merge_products).
# First match wins; extend as more variant-sets come up.
_ITEM_CANON = [
    # Bentonite clay, badly OCR'd off scanned bills into many spellings:
    # Bentumite / Bantumite / Bentonite / Bentimite / Bantamile / Bentonite
    # Arameb / Granneh … — all start b[ae]nt and carry a mite/mile/nite/nate
    # token (plus trailing garble like 'Aramb'/'Frames'/'Granneh'). Collapse
    # anything that matches to one name. Reporting-only.
    (re.compile(r'\bb[ae]nt[aeiou]*(mite|mile|nite|nate|mete)\b', re.I), 'Bentumite'),
]


def _canon_item_name(name):
    for rx, canon in _ITEM_CANON:
        if rx.search(name or ''):
            return canon
    return name


def _clean_display(name):
    for rx, eng in _NAME_TRANSLATIONS:
        if rx.search(name):
            return '%s (%s)' % (eng, name.strip())   # English name + the original
    s = _LEAD_LABEL.sub('', name)
    s = _SPEC_PREFIX.sub(' ', s)
    s = _DIM_PARENS_MM.sub(' ', s)
    s = _DIM_PARENS_NUM.sub(' ', s)
    s = _DIM_RUN.sub(' ', s)
    s = _DIM_UNIT.sub(' ', s)
    s = _GSM_RE.sub(' ', s)
    s = _LONE_X.sub(' ', s)
    s = re.sub(r'\(\s+', '(', s)
    s = re.sub(r'\s+\)', ')', s)
    s = re.sub(r'\s{2,}', ' ', s)
    return s.strip(' -/,') or name


class PurchaseByCategoryView(APIView):
    """GET /api/purchase/by-category/?company=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD

    Count + value per spend category. No date params → all-time (matches the
    classify_bills CLI report). CANCELLED and opening-balance carriers excluded.
    """
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Vendor Bill'

    # Fixed order + labels; '' is the Unclassified bucket, always shown last.
    CATEGORIES = [
        ('RM', 'RM Purchase'),
        ('MAIZE', 'Maize Purchase'),
        ('BOUGHT_NOTE', 'Bought Note (Exempt)'),
        ('PACKING', 'Packing Material'),
        ('FREIGHT', 'Freight / Transport'),
        ('EXPENSES', 'Expenses'),
        ('MACHINERY', 'Machinery / Capital'),
        ('BRANCH', 'Branch Transfer'),
        ('', 'Unclassified'),
    ]

    @staticmethod
    def _money(v):
        return str((v or Decimal('0')).quantize(Decimal('0.01')))

    @staticmethod
    def _pd(s):
        try:
            return datetime.strptime(s, '%Y-%m-%d').date() if s else None
        except (ValueError, TypeError):
            return None

    def get(self, request):
        from .models import VendorBill

        qs = (VendorBill.objects.filter(is_active=True)
              .exclude(status='CANCELLED')
              .exclude(tally_guid__startswith='OPENING'))
        company = request.query_params.get('company') or None
        if company:
            qs = qs.filter(vendor__company_id=company)
        frm = self._pd(request.query_params.get('from'))
        to = self._pd(request.query_params.get('to'))
        if frm:
            qs = qs.filter(bill_date__gte=frm)
        if to:
            qs = qs.filter(bill_date__lte=to)
        source = (request.query_params.get('source') or '').lower()
        if source in ('tally', 'scan'):
            from .source_classify import annotate_source, filter_by_source
            qs = filter_by_source(annotate_source(qs), source)

        # Which Tally expense snapshot to read: a window that STARTS on the 1st and
        # stays within one calendar month is that month ('YYYY-MM') — this includes
        # the current, partial month (1st → today), which must NOT borrow the FY
        # snapshot. Only a full-year / multi-month / unbounded window uses 'FY'. A
        # month with no imported mirror simply shows no Tally figure (no false tie).
        active_key = 'FY'
        if (frm and to and frm.day == 1 and frm.year == to.year and frm.month == to.month):
            active_key = f'{frm.year:04d}-{frm.month:02d}'

        # Synthetic "Tally journal" expense bills (import_expense_bills, guid prefix
        # 'EXPJRNL-') stand in for journal-booked expenses (Salary / Rent / Interest
        # ...) that have no vendor invoice. They are NOT purchases, so keep them OUT
        # of the purchase-category rows + the "Total purchases" headline, but KEEP
        # the ACTIVE period's ones for the Expenses drawer's ERP column (exp_bill_qs).
        # FY journal bills are un-namespaced (or EXPJRNL-FY-); month ones are
        # EXPJRNL-<YYYY-MM>-, so a view never cross-counts another period's journal.
        exp_bill_qs = qs
        if active_key == 'FY':
            exp_bill_qs = exp_bill_qs.exclude(tally_guid__regex=r'^EXPJRNL-\d{4}-\d{2}-')
        else:
            exp_bill_qs = exp_bill_qs.exclude(
                Q(tally_guid__startswith='EXPJRNL-')
                & ~Q(tally_guid__startswith=f'EXPJRNL-{active_key}-'))
        qs = qs.exclude(tally_guid__startswith='EXPJRNL')

        # Drop duplicate bills — the SAME invoice imported twice under a different
        # (collision "-N") bill number — so a category total is never double-counted
        # while the data is being cleaned. Self-correcting once deduped.
        _dups = _dup_bill_ids(qs)
        if _dups:
            qs = qs.exclude(id__in=_dups)
            exp_bill_qs = exp_bill_qs.exclude(id__in=_dups)

        # Categorise each bill by WHAT IT IS AT ENTRY, not just its stored
        # purchase_category, so the cards split the way the Analytics "by scope" page
        # does and RM/Packing/etc. hold only real goods purchases:
        #   - an internal branch / stock transfer  -> BRANCH  (branch_transfer_q)
        #   - a bill flagged an expense at entry    -> EXPENSES (is_expense=True)
        #   - everything else keeps its own purchase_category.
        # A transfer wins over the expense flag (Analytics drops transfers first). No
        # values are hard-coded — the bill's own flags decide its bucket, so a re-entry
        # or re-classification self-corrects.
        _eff_cat = Case(
            When(branch_transfer_q(), then=Value('BRANCH')),
            When(is_expense=True, then=Value('EXPENSES')),
            default=F('purchase_category'),
            output_field=CharField())
        qs = qs.annotate(_cat=_eff_cat)

        # Value mirrors Tally's Purchase Accounts: EX-GST (subtotal), NET of purchase
        # returns. Tally's purchase ledger is booked ex-GST and reduced by its Debit
        # Notes, so a gross incl-GST total never ties it.
        agg = {r['_cat']: r for r in
               qs.values('_cat').annotate(n=Count('id'), v=Sum('subtotal'),
                                          vi=Sum('total_amount'))}

        # Inward freight / other on-bill charges Tally books OUTSIDE its purchase
        # ledgers (a "Shipping charge" / SAC 996511 / "Freight Inward Charges" line on
        # a goods invoice). The importer stores these in other_charges but keeps
        # subtotal FULL, so net them out of each purchase category here and report the
        # total under FREIGHT (it IS inward freight bundled on the bill — not a
        # Packing/RM purchase). Self-correcting: a re-import refreshes other_charges and
        # this nets it, so Packing/RM stay tied to Tally's ledgers with no per-bill patching.
        oc = {r['_cat']: (r['oc'] or Decimal('0')) for r in
              qs.values('_cat').annotate(oc=Sum('other_charges'))}
        total_oc = sum(oc.values(), Decimal('0'))
        # How many bills actually CARRY that on-bill freight. The Freight row's
        # value is this bundled freight (not standalone Freight bills), so its
        # count must reflect the freight-bearing bills — otherwise it reads a
        # value against "0 bills". Exclude any real FREIGHT-category bill so the
        # two don't double-count when both are added below.
        oc_count = (qs.filter(other_charges__gt=0)
                    .exclude(purchase_category='FREIGHT').count())

        # Same treatment for an EXPENSE leg bundled on a goods bill (insurance,
        # rate-difference, misc service) that Tally books to an expense ledger,
        # NOT Purchase Accounts. Stored in expense_charges; net it out of the
        # bill's own category and report it under EXPENSES (mirrors other_charges
        # -> FREIGHT above). e.g. Raj Enterprises' Rs 4,500 Insurance on an RM
        # invoice: leaves RM, lands in Expenses, where Tally books it.
        ec = {r['_cat']: (r['ec'] or Decimal('0')) for r in
              qs.values('_cat').annotate(ec=Sum('expense_charges'))}
        total_ec = sum(ec.values(), Decimal('0'))
        ec_count = (qs.filter(expense_charges__gt=0)
                    .exclude(purchase_category='EXPENSES').count())

        # Purchase returns: a Tally Debit Note (side PURCHASE) lowers the purchase, a
        # Credit Note raises it. The note carries no category of its own, so attribute
        # it to the VENDOR's dominant category (Sperrholz -> Maize, etc.). Use the
        # ex-GST 'taxable' value, falling back to the gross when it wasn't captured.
        from sales.models import DebitNote
        vcat = {}
        # Dominant category per vendor for routing returns; break a COUNT tie
        # toward the higher-VALUE category so a vendor's lone small off-category
        # bill (a mixed fruit+packing vendor) can't misroute its big RM return.
        for r in (qs.exclude(purchase_category='')
                  .values('vendor_id', 'purchase_category')
                  .annotate(n=Count('id'), v=Sum('subtotal')).order_by('vendor_id', '-n', '-v')):
            vcat.setdefault(r['vendor_id'], r['purchase_category'])
        nqs = DebitNote.objects.filter(side='PURCHASE', is_active=True, vendor__isnull=False)
        if company:
            nqs = nqs.filter(company_id=company)
        if frm:
            nqs = nqs.filter(note_date__gte=frm)
        if to:
            nqs = nqs.filter(note_date__lte=to)
        # A vendor can raise a NOTE this period without a purchase BILL this period —
        # e.g. a return / rate-difference on a vendor we only bought from in an earlier
        # month. Such a vendor is absent from the in-period `vcat`, so its note would
        # fall to '' (unclassified) and never net against the category it belongs to
        # (United Agro May: Arvalli's lone ₹9,072 purchase return, vendor is all-time
        # RM but had no May bill). Fall back to the vendor's ALL-TIME dominant category
        # for those, so a return-only month still reduces the right category.
        _note_vendors = set(nqs.values_list('vendor_id', flat=True)) - set(vcat)
        if _note_vendors:
            for r in (VendorBill.objects.filter(vendor_id__in=_note_vendors, is_active=True)
                      .exclude(status='CANCELLED').exclude(purchase_category='')
                      .values('vendor_id', 'purchase_category')
                      .annotate(n=Count('id'), v=Sum('subtotal')).order_by('vendor_id', '-n', '-v')):
                vcat.setdefault(r['vendor_id'], r['purchase_category'])
        ret = {}        # category -> signed EX-GST return (positive reduces the value)
        ret_incl = {}   # same, INCL-GST (gross note amount) for the incl-GST view
        for d in nqs.values('vendor_id', 'note_type', 'taxable', 'amount', 'tally_group'):
            # Only a note raised ON A PURCHASE LEDGER reduces the purchase category,
            # mirroring Tally's Purchase Accounts. A note booked to Discount Earned
            # (Indirect Income), a Rate-Difference, or an expense ledger sits OUTSIDE
            # Purchase Accounts, so it must NOT net against RM / Packing / Maize — else
            # the bill-derived value drops below Tally's own figure. `tally_group` is
            # Tally's group for the note's ledger; blank (hand-entered / imported before
            # the field existed) keeps the prior behaviour so old data isn't dropped.
            grp = (d['tally_group'] or '').strip().lower()
            if grp and 'purchase' not in grp:
                continue
            cat = vcat.get(d['vendor_id'], '')
            val = d['taxable'] if d['taxable'] is not None else (d['amount'] or Decimal('0'))
            vali = d['amount'] or Decimal('0')
            sign = Decimal('1') if d['note_type'] == 'DEBIT' else Decimal('-1')
            ret[cat] = ret.get(cat, Decimal('0')) + sign * (val or Decimal('0'))
            ret_incl[cat] = ret_incl.get(cat, Decimal('0')) + sign * vali

        # Tally's OWN per-category purchase split for THIS EXACT period, if imported
        # (import_purchase_ledgers). The bill-derived `value` can never equal Tally's
        # ledger — Tally splits each invoice across ledgers — so this lets every
        # category show Tally's authoritative number beside the ERP one. Each stored
        # ledger name is mapped to a category with the SAME rules the bills use, so
        # nothing is hard-coded. Only when the window matches an imported (from, to).
        tally_by_cat, tally_total = {}, None
        if company and frm and to:
            from .models import PurchaseAccountsTotal
            try:
                from .tally_align import _ledger_to_category
            except ImportError:
                # Tally comparison not available in this standalone build.
                _ledger_to_category = None
            _pa = (PurchaseAccountsTotal.objects
                   .filter(company_id=company, from_date=frm, to_date=to, is_active=True)
                   .first())
            if _pa and _pa.breakdown:
                for e in _pa.breakdown:
                    cat = _ledger_to_category(e.get('name'))
                    if not cat:
                        continue
                    amt = Decimal(str(e.get('amount') or '0'))
                    tally_by_cat[cat] = tally_by_cat.get(cat, Decimal('0')) + amt
                tally_total = sum(tally_by_cat.values(), Decimal('0'))

        cats, grand_v, grand_vi, grand_n = [], Decimal('0'), Decimal('0'), 0
        for key, label in self.CATEGORIES:
            r = agg.get(key) or {}
            n = r.get('n') or 0
            # Each card is the RAW GROSS subtotal of its category — exactly what's ON
            # the bills — so RM / Packing / Expenses / Freight each equal the Analytics
            # by-scope figure for the same category and the Bills list. NO on-bill
            # freight / expense reallocation and NO returns netting: a bundled freight
            # leg stays on its bill, and purchase RETURNS (which often fall in a
            # different month from their bill — the Sperrholz ₹22.85L maize case) are
            # reported on the Analytics page, not buried in a category here. `v` is
            # EX-GST (subtotal), `vi` the same on an INCL-GST (total_amount) base.
            v = r.get('v') or Decimal('0')
            vi = r.get('vi') or Decimal('0')
            # Branch / stock transfers get their OWN card but stay OUT of the headline
            # Total — a transfer is neither a purchase nor an expense, so dropping it
            # here makes this page's Total tie the Analytics "by scope" Total (which
            # also excludes transfers). Nothing is hidden: the Branch Transfer card
            # still shows its value and count.
            if key != 'BRANCH':
                grand_n += n
                grand_v += v
                grand_vi += vi
            cats.append({
                'key': key or 'UNCLASSIFIED',
                'filter': key,                 # what to send as ?purchase_category=
                'label': label,
                'count': n,
                'value': self._money(v),          # EX-GST, gross (what's on the bills)
                'value_incl': self._money(vi),    # INCL-GST, gross
                # Tally's number for this category (None when not imported / no ledger).
                'tally': self._money(tally_by_cat[key]) if key in tally_by_cat else None,
            })

        # ── Expenses mirror: Tally's Direct / Indirect Expenses, by sub-category ──
        # The three flat spend buckets above (Freight / Expenses / Machinery) don't
        # show Tally's own expense structure, so this adds the finer split that
        # mirrors Tally's "Direct Expenses" and "Indirect Expenses" groups.
        #   Tally side  from the ExpenseLedgerBalance snapshot (import_expenses),
        #               a CUMULATIVE figure as of its import date (full-FY export) —
        #               so it is reported "as of" that date, not per the window.
        #   ERP side    this period's expense bills grouped by the expense_subcategory
        #               classify wrote (ex-GST subtotal). Blank until bills are
        #               classified, so the Tally column leads and the ERP column
        #               fills in as bills are tagged — same as RM/Packing did.
        from .models import ExpenseLedgerBalance
        # Read the ACTIVE period's snapshot (month 'YYYY-MM' or 'FY'). If a month
        # hasn't been imported yet, this is simply empty — the drawer then shows no
        # Tally expense figures for that month (no false cumulative-vs-month gap),
        # rather than the FY number against one month of bills.
        exp_qs = ExpenseLedgerBalance.objects.filter(is_active=True, period_key=active_key)
        if company:
            exp_qs = exp_qs.filter(company_id=company)
        tally_exp, exp_as_of = {}, None
        for r in exp_qs.values('group_type', 'sub_category', 'opening', 'closing', 'as_of'):
            spend = (r['closing'] or Decimal('0')) - (r['opening'] or Decimal('0'))
            k = (r['group_type'], r['sub_category'] or '(Other)')
            tally_exp[k] = tally_exp.get(k, Decimal('0')) + spend
            if r['as_of'] and (exp_as_of is None or r['as_of'] > exp_as_of):
                exp_as_of = r['as_of']

        # ERP expense bills summed per (group, head): ex-GST subtotal (value), the
        # incl-GST total (value_incl), and what Payments Made has settled against
        # them (paid = amount_paid). Outstanding = incl-GST billed - paid, so a
        # part-/un-paid expense bill shows a real balance. Same bill set as before.
        erp_exp, erp_exp_i, erp_exp_p, erp_exp_n = {}, {}, {}, {}
        _exp_bills = exp_bill_qs.filter(Q(expense_group__in=['DIRECT', 'INDIRECT'])
                                        | ~Q(expense_subcategory=''))
        for r in (_exp_bills.values('expense_group', 'expense_subcategory')
                  .annotate(v=Sum('subtotal'), vi=Sum('total_amount'),
                            p=Sum('amount_paid'), n=Count('id'))):
            k = (r['expense_group'] or '', r['expense_subcategory'] or '(Other)')
            erp_exp[k] = erp_exp.get(k, Decimal('0')) + (r['v'] or Decimal('0'))
            erp_exp_i[k] = erp_exp_i.get(k, Decimal('0')) + (r['vi'] or Decimal('0'))
            erp_exp_p[k] = erp_exp_p.get(k, Decimal('0')) + (r['p'] or Decimal('0'))
            erp_exp_n[k] = erp_exp_n.get(k, 0) + (r['n'] or 0)

        _GLAB = {'DIRECT': 'Direct Expenses', 'INDIRECT': 'Indirect Expenses'}
        exp_groups = []
        for g in ('DIRECT', 'INDIRECT'):
            subs = sorted({s for (gg, s) in tally_exp if gg == g}
                          | {s for (gg, s) in erp_exp if gg == g})
            rows_ = []
            for s in subs:
                tv = tally_exp.get((g, s))
                ev = erp_exp.get((g, s), Decimal('0'))
                evi = erp_exp_i.get((g, s), Decimal('0'))
                ep = erp_exp_p.get((g, s), Decimal('0'))
                rows_.append({
                    'sub': s,
                    'value': self._money(ev),            # ex-GST bill sum
                    'value_incl': self._money(evi),      # incl-GST bill sum
                    'paid': self._money(ep),             # settled (amount_paid)
                    'outstanding': self._money(evi - ep),
                    'count': erp_exp_n.get((g, s), 0),
                    'tally': self._money(tv) if tv is not None else None,
                })
            rows_.sort(key=lambda x: -(float(x['tally']) if x['tally'] is not None
                                       else float(x['value'])))
            g_tally = sum((tally_exp[k] for k in tally_exp if k[0] == g), Decimal('0'))
            g_erp = sum((erp_exp.get((g, s), Decimal('0')) for s in subs), Decimal('0'))
            g_erp_i = sum((erp_exp_i.get((g, s), Decimal('0')) for s in subs), Decimal('0'))
            g_paid = sum((erp_exp_p.get((g, s), Decimal('0')) for s in subs), Decimal('0'))
            g_count = sum((erp_exp_n.get((g, s), 0) for s in subs), 0)
            exp_groups.append({
                'key': g,
                'label': _GLAB[g],
                'value': self._money(g_erp),             # ex-GST bill sum (headline)
                'value_incl': self._money(g_erp_i),      # incl-GST bill sum
                'paid': self._money(g_paid),
                'outstanding': self._money(g_erp_i - g_paid),
                'count': g_count,
                'tally': self._money(g_tally) if any(k[0] == g for k in tally_exp) else None,
                'subcategories': rows_,
            })

        return Response({
            'categories': cats,
            'total_count': grand_n,
            'total_value': self._money(grand_v),            # EX-GST headline total
            'total_value_incl': self._money(grand_vi),      # INCL-GST headline total
            # Tally's Purchase Accounts total for the period (sum of mapped ledgers).
            'tally_total': self._money(tally_total) if tally_total is not None else None,
            # Tally's Direct/Indirect Expenses mirror, by sub-category (import_expenses).
            'expenses': {
                'groups': exp_groups,
                'has_tally': bool(tally_exp),
                'as_of': exp_as_of.isoformat() if exp_as_of else None,
            },
            'from': frm.isoformat() if frm else None,
            'to': to.isoformat() if to else None,
        })


class PurchaseByCategoryItemsView(APIView):
    """GET /api/purchase/by-category/items/?category=<KEY>&company=&from=&to=

    For ONE spend category, the item -> vendor breakdown: which item was bought
    from which vendor and for how much, summed from the bills' LINE items
    (VendorBillLine.amount). `category` is the same key the by-category rows
    carry ('' = Unclassified). The item name is the line's product, or its
    description when the line has no product master (ledger-only lines from
    Bought Notes / expense journals). Same CANCELLED / opening exclusions and
    company / date filters as the category totals. Reporting-only.
    """
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Vendor Bill'

    @staticmethod
    def _money(v):
        return str((v or Decimal('0')).quantize(Decimal('0.01')))

    @staticmethod
    def _pd(s):
        try:
            return datetime.strptime(s, '%Y-%m-%d').date() if s else None
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _qty(v):
        return float(v or 0)

    def get(self, request):
        from .models import VendorBill, VendorBillLine

        if 'category' not in request.query_params:
            return Response({'detail': "Pass ?category=<KEY> ('' for Unclassified)."},
                            status=400)
        category = request.query_params.get('category') or ''

        # Bills in this category/window — a BILL-level filter (fast, indexed) that
        # also gives each bill's vendor + date, so the line pass never re-joins them.
        # Bucket each bill by what it IS at entry (transfer / expense-flag / stored
        # category), the SAME rule the cards use, so this drill shows exactly the bills
        # its card counted and the item totals tie the card value.
        bqs = _by_effective_category(
            VendorBill.objects.filter(is_active=True)
            .exclude(status='CANCELLED')
            .exclude(tally_guid__startswith='OPENING')
            .exclude(tally_guid__startswith='EXPJRNL'),
            category)
        company = request.query_params.get('company') or None
        if company:
            bqs = bqs.filter(vendor__company_id=company)
        frm = self._pd(request.query_params.get('from'))
        to = self._pd(request.query_params.get('to'))
        if frm:
            bqs = bqs.filter(bill_date__gte=frm)
        if to:
            bqs = bqs.filter(bill_date__lte=to)
        # Drop duplicate bills (same invoice, different collision "-N" bill_no) so an
        # item's qty/value isn't double-counted — matches the cards view.
        bqs = bqs.exclude(id__in=_dup_bill_ids(bqs))
        bill_map = {b['id']: (b['vendor__vendor_name'] or '(no vendor)', b['bill_date'],
                              b['bill_no'] or b['vendor_invoice_no'] or '')
                    for b in bqs.values('id', 'vendor__vendor_name', 'bill_date',
                                        'bill_no', 'vendor_invoice_no')}
        if not bill_map:
            return Response({'category': category, 'items': [], 'item_count': 0, 'shown': 0})

        # INCL-GST per line. Each line is grossed up by its OWN tax_percent, then all
        # of a bill's lines are scaled by total_amount / sum(line gross) so they still
        # sum to the card's INCL-GST value (Sum total_amount). One formula, two cases:
        #   * GST Purchase (per-line rates): a bill mixing e.g. 18% + 5% now carries
        #     each line's REAL rate instead of the blended bill average, which used to
        #     over-tax the 5% line and under-tax the 18% one.
        #   * Tally header-only (no per-line %): every tax_percent is 0, so the gross
        #     collapses to the subtotal and the scale becomes the old total_amount /
        #     subtotal factor — unchanged.
        bill_total = {b['id']: (b['total_amount'] or Decimal('0'))
                      for b in bqs.values('id', 'total_amount')}
        bill_gross = {}
        for ln in (VendorBillLine.objects.filter(bill_id__in=list(bill_map.keys()))
                   .values('bill_id', 'amount', 'tax_percent')):
            g = (ln['amount'] or Decimal('0')) * (Decimal('1') + (ln['tax_percent'] or Decimal('0')) / 100)
            bill_gross[ln['bill_id']] = bill_gross.get(ln['bill_id'], Decimal('0')) + g
        bill_scale = {}
        for _bid, _tot in bill_total.items():
            _g = bill_gross.get(_bid, Decimal('0'))
            bill_scale[_bid] = (_tot / _g) if _g else Decimal('1')

        # Line pass over ONLY those bills (bill_id FK index), aggregated in Python.
        # This replaces a grouped SQL distinct-count + min/max over multi-joins that
        # was taking ~a minute on a big category. Item = product name, or the line
        # description when the line has no product master. Quantity summed under the
        # item's dominant unit (most-frequent uom) — nearly always one unit per item.
        items = {}   # item -> {'uoms': {uom: n}, 'vendors': {vendor: {...}}}
        # Show EVERY real item purchased on this category's bills. We deliberately
        # do NOT filter by the product's master TYPE: a manufacturer types what it
        # makes as "Finished Good" (SSB's own Castor Deoil Cake / Neem DOC), so
        # type-filtering wrongly HID real RM purchases. The bill's category already
        # scopes this, and category accuracy is a bill-classification job — not the
        # by-item view's. We only drop things that aren't item names at all: charge
        # lines and bill-note narration, both by NAME.
        line_qs = (VendorBillLine.objects.filter(bill_id__in=list(bill_map.keys()))
                   .values('bill_id', 'product__product_name', 'description', 'uom', 'quantity',
                           'amount', 'tax_percent'))
        for ln in line_qs.iterator(chunk_size=2000):
            item = ((ln['product__product_name'] or ln['description'] or '').strip()
                    or '(unspecified)')
            item = _DOUBLED_RE.sub(r'\1', item)   # collapse an import-doubled name
            item = _canon_item_name(item)         # merge known spelling variants (Bentumite…)
            has_master = bool((ln['product__product_name'] or '').strip())
            if (_CHARGE_RE.search(item) or _NARRATION_RE.search(item)
                    or _NUMERIC_RE.match(item)
                    or (len(item) > 80 and not has_master and not _KEEP_LONG_RE.search(item))):
                continue   # a charge, bill-note narration, a bare number, or a long
                           # description-only narration. A real product master or a
                           # corrugated-box spec is kept even when it runs long.
            vendor, bdate, bno = bill_map.get(ln['bill_id'], ('(no vendor)', None, ''))
            _amt = ln['amount'] or Decimal('0')
            _rate = ln['tax_percent'] or Decimal('0')                    # the line's OWN GST rate
            _amt_incl = _amt * (Decimal('1') + _rate / 100) * bill_scale.get(ln['bill_id'], Decimal('1'))
            uom = (ln['uom'] or '').strip()
            cu = _canon_unit(uom)   # TON/MT/MTS → MTS, etc. — equal units read as one
            # Keep BOTH the quantity as billed (qty) and a KG-folded copy (qkg).
            # Which one an item shows is decided at output: an item billed in a
            # SINGLE unit keeps it, so the unit price equals the bill's exact rate
            # (30 MTS @ Rs 6,250 — NOT 30,000 KG @ Rs 6.25); an item billed in more
            # than one weight unit folds to the common KG so its rows compare.
            qkg, is_weight = _qty_in_kg(ln['quantity'], uom)
            qorig = Decimal(ln['quantity'] or 0)
            it = items.setdefault(item, {'item': item, 'uoms': {}, 'wunits': set(),
                                         'unit_qty': {}, 'vendors': {}})
            if cu:
                it['uoms'][cu] = it['uoms'].get(cu, 0) + 1
                if is_weight:
                    it['wunits'].add(cu)   # distinct weight units billed (canonicalised)
            # Quantity summed under the ACTUAL (canonicalised) bill unit, so a
            # mixed-unit item shows a true per-unit breakdown ("9,950 KG · 3,585 set")
            # instead of a meaningless single total. '—' = a line billed with no unit.
            uk = cu or '—'
            it['unit_qty'][uk] = it['unit_qty'].get(uk, Decimal('0')) + qorig
            v = it['vendors'].setdefault(vendor, {'vendor': vendor, 'qty': Decimal('0'),
                                                  'qkg': Decimal('0'), 'amount': Decimal('0'),
                                                  'amount_incl': Decimal('0'),
                                                  'bills': set(), 'first': None, 'last': None,
                                                  'lines': {}})
            v['qty'] += qorig
            v['qkg'] += qkg
            v['amount'] += _amt
            v['amount_incl'] += _amt_incl
            v['bills'].add(ln['bill_id'])
            # Per-bill detail, split BY VARIANT (the line's description) so a generic
            # product like "HDPE Container" shows EACH size as its own row with its
            # own exact qty + rate, instead of one blended row that averages 4 sizes
            # at different prices into a meaningless Rs 22.47. Same variant on a bill
            # rolls up; different variants stay apart.
            variant = _DOUBLED_RE.sub(r'\1', (ln['description'] or '').strip()) or item
            bl = v['lines'].setdefault((ln['bill_id'], variant), {
                'bill_id': str(ln['bill_id']), 'bill_no': bno, 'date': bdate,
                'variant': variant, 'qty': Decimal('0'), 'qkg': Decimal('0'),
                'amount': Decimal('0'), 'amount_incl': Decimal('0'), 'uoms': {}})
            bl['qty'] += qorig
            bl['qkg'] += qkg
            bl['amount'] += _amt
            bl['amount_incl'] += _amt_incl
            # Remember THIS line's own unit so the per-bill drill row shows LTR/NOS/etc.
            # instead of the item's dominant unit (a mixed KG+LTR item was labelling its
            # LTR rows as KG).
            if cu:
                bl['uoms'][cu] = bl['uoms'].get(cu, 0) + 1
            if bdate and (v['first'] is None or bdate < v['first']):
                v['first'] = bdate
            if bdate and (v['last'] is None or bdate > v['last']):
                v['last'] = bdate

        out = []
        for it in items.values():
            # Fold an item's quantities to KG ONLY when it was billed PURELY in weight
            # units, in more than one of them (some bills MTS, some KG). An item billed
            # in a single unit keeps it (exact bill rate); an item that mixes a weight
            # unit WITH a count unit (set / Nos / PCS) must NOT fold — a count can't
            # become KG — so it drops to the dominant-unit path and the frontend shows
            # the per-unit breakdown instead.
            nonweight = set(it['uoms']) - it['wunits']
            use_kg = len(it['wunits']) > 1 and not nonweight
            if use_kg:
                # 2b — fix wrong-UOM lines: a per-bill line whose per-KG rate is
                # ~1000× the item's typical rate had its quantity in MTS but was
                # labelled KG, so it reads 1000× too small (e.g. "24.6 KG @
                # Rs 1,24,700" is really 24,600 KG). Scale it back — a 1000× gap is a
                # unit error, never a price difference — then rebuild the vendor KG
                # total. Reference = per-KG rate of the LARGEST (correctly-unit'd) line.
                ref_line = None
                for v in it['vendors'].values():
                    for d in v['lines'].values():
                        if d['qkg'] > 0 and d['amount'] > 0 and (ref_line is None or d['qkg'] > ref_line['qkg']):
                            ref_line = d
                if ref_line and ref_line['amount'] / ref_line['qkg'] > 0:
                    ref = ref_line['amount'] / ref_line['qkg']
                    for v in it['vendors'].values():
                        for d in v['lines'].values():
                            if d['qkg'] > 0 and d['amount'] > 0 and ref * 300 <= (d['amount'] / d['qkg']) <= ref * 3000:
                                d['qkg'] *= 1000
                        v['qkg'] = sum((d['qkg'] for d in v['lines'].values()), Decimal('0'))
                unit, qk = 'KG', 'qkg'
            else:
                unit = max(it['uoms'].items(), key=lambda kv: kv[1])[0] if it['uoms'] else ''
                qk = 'qty'
            vendors = sorted(it['vendors'].values(), key=lambda x: x[qk], reverse=True)
            out.append({
                'item': it['item'],
                'display': _clean_display(it['item']),   # name without packaging dims
                'group': _item_family(it['item']),       # the family it nests under
                'unit': unit,
                'unit_qty': {u: self._qty(q) for u, q in it['unit_qty'].items()},  # per-unit breakdown

                'qty': self._qty(sum((x[qk] for x in vendors), Decimal('0'))),
                'amount': self._money(sum((x['amount'] for x in vendors), Decimal('0'))),
                'amount_incl': self._money(sum((x['amount_incl'] for x in vendors), Decimal('0'))),
                'bills': sum(len(x['bills']) for x in vendors),
                'vendors': [{'vendor': x['vendor'], 'qty': self._qty(x[qk]),
                             'amount': self._money(x['amount']),
                             'amount_incl': self._money(x['amount_incl']), 'bills': len(x['bills']),
                             'first': x['first'].isoformat() if x['first'] else None,
                             'last': x['last'].isoformat() if x['last'] else None,
                             'lines': [{'bill_id': d['bill_id'], 'bill_no': d['bill_no'],
                                        'variant': d.get('variant') or '',
                                        'date': d['date'].isoformat() if d['date'] else None,
                                        'qty': self._qty(d[qk]),
                                        # KG-folded items read in KG; otherwise each row
                                        # shows its OWN unit (LTR/NOS/KG), not the item's.
                                        'uom': 'KG' if use_kg else (
                                            max(d['uoms'].items(), key=lambda kv: kv[1])[0]
                                            if d.get('uoms') else unit),
                                        'amount': self._money(d['amount']),
                                        'amount_incl': self._money(d['amount_incl']),
                                        'rate': self._money((d['amount'] / d[qk]) if d[qk] else Decimal('0')),
                                        'rate_incl': self._money((d['amount_incl'] / d[qk]) if d[qk] else Decimal('0'))}
                                       for d in sorted(x['lines'].values(),
                                                       key=lambda z: (z['date'].isoformat() if z['date'] else '', -(z['amount'] or 0)))]}
                            for x in vendors],
            })
        out.sort(key=lambda x: x['qty'], reverse=True)
        return Response({
            'category': category,
            'items': out,
            'item_count': len(out),
            'shown': len(out),
        })


class ExpenseVouchersView(APIView):
    """Bill-wise drill for the By-Category month view: company + a single calendar
    month + optional group / sub-category / ledger -> the individual Day Book
    vouchers behind that expense figure (date, voucher no, party, amount)."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    # Same permission as the rest of the By-Category page (cards + items use
    # 'Vendor Bill'); keyed to 'Purchase' it 403'd for roles that can see the page
    # but lack the Purchase module — the "Could not load vouchers" on a colleague login.
    module_name = 'Vendor Bill'

    def get(self, request):
        from .models import ExpenseVoucher
        def _pd(s):
            try:
                return datetime.strptime((s or '').strip(), '%Y-%m-%d').date()
            except Exception:
                return None
        frm, to = _pd(request.query_params.get('from')), _pd(request.query_params.get('to'))
        if not (frm and to):
            return Response({'vouchers': [], 'count': 0, 'total': '0',
                             'note': 'Pick a period to see the bills.'})
        # Span the WHOLE selected window — a single calendar month OR a full FY /
        # custom range. Vouchers carry voucher_date, so filter on it (this was locked
        # to one period_key month, so an FY / multi-month view showed Rs 0). The
        # GUID/vendor-name ERP-match and the ERP-bill fallback below already use frm..to.
        qs = ExpenseVoucher.objects.filter(voucher_date__gte=frm, voucher_date__lte=to)
        company = request.query_params.get('company') or None
        if company:
            qs = qs.filter(company_id=company)
        g = (request.query_params.get('group') or '').upper()
        if g in ('DIRECT', 'INDIRECT'):
            qs = qs.filter(group_type=g)
        sub = request.query_params.get('sub')
        if sub == '(Other)':
            # "(Other)" is the DISPLAY label for a blank sub-category (see the ranked
            # list: `sub_category or '(Other)'`). Filtering the literal text matched
            # nothing, so the drill showed Rs 0 for a head that has a real figure —
            # match the blank/null value the label stands for instead.
            qs = qs.filter(Q(sub_category='') | Q(sub_category__isnull=True))
        elif sub:
            qs = qs.filter(sub_category=sub)
        led = request.query_params.get('ledger')
        if led:
            qs = qs.filter(ledger_name=led)
        qs = qs.order_by('-voucher_date', 'voucher_no')
        vlist = list(qs[:2000])

        # Live month with no Tally mirror (e.g. October): there are no imported
        # Tally vouchers, but the ERP has the real physical bills. Fall back to
        # those so the drawer still shows the bills (all are in the ERP by
        # definition). Scope VendorBill by vendor__company (no direct company FK).
        if not vlist:
            from .models import VendorBill
            bq = (VendorBill.objects.filter(is_active=True)
                  .exclude(status='CANCELLED')
                  .exclude(tally_guid__startswith='OPENING')
                  .exclude(tally_guid__startswith='EXPJRNL'))
            if company:
                bq = bq.filter(vendor__company_id=company)
            if frm:
                bq = bq.filter(bill_date__gte=frm)
            if to:
                bq = bq.filter(bill_date__lte=to)
            # "(Other)" is the DISPLAY label for a BLANK sub-category — the bills
            # carry '' / NULL, not the literal text, so match blanks for it.
            if sub == '(Other)':
                bq = bq.filter(Q(expense_subcategory='') | Q(expense_subcategory__isnull=True))
            elif sub:
                bq = bq.filter(expense_subcategory=sub)
            if g in ('DIRECT', 'INDIRECT'):
                bq = bq.filter(expense_group=g)
            erows = [{'date': str(b.bill_date), 'voucher_no': b.bill_no or b.vendor_invoice_no or '',
                      'voucher_type': 'ERP bill', 'ledger': b.expense_subcategory or '',
                      'party': (b.vendor.vendor_name if b.vendor_id else ''),
                      'amount': str(b.subtotal or b.total_amount or 0),
                      'group': b.expense_group or '', 'sub': b.expense_subcategory or '',
                      'in_erp': True, 'status': 'erp', 'bill_id': str(b.id)}  # a real bill → clickable
                     for b in bq.select_related('vendor').order_by('-bill_date', 'bill_no')[:2000]]
            etot = sum((Decimal(r['amount']) for r in erows), Decimal('0'))
            return Response({'vouchers': erows, 'count': len(erows), 'total': str(etot),
                             'in_erp_count': len(erows), 'in_erp_total': str(etot),
                             'missing_count': 0, 'missing_total': '0', 'source': 'erp'})
        # Which of these Tally vouchers are already a real ERP bill? A real bill
        # imported/stamped from the Day Book carries the voucher GUID in tally_guid
        # (the EXPJRNL mirror bills do NOT — they use 'EXPJRNL-…'), so a GUID hit
        # means the bill is in the ERP; a miss means it's journal-only / missing.
        from .models import VendorBill
        guids = {v.guid for v in vlist if v.guid}
        # VendorBill has NO company FK (it scopes via warehouse/vendor). The Tally
        # GUID is globally unique per voucher, so matching on tally_guid alone is
        # correct — no company filter (filtering by company_id errored).
        present = dict(VendorBill.objects.filter(tally_guid__in=guids).values_list('tally_guid', 'id')) if guids else {}
        # Softer match: many real expense bills are SCANNED, not stamped with the
        # Day Book GUID, so the GUID test alone wrongly reads "missing". A voucher
        # whose PARTY (vendor) has an ERP expense bill in this same month IS captured
        # — count it in-ERP too. Build the vendor-name set for this period.
        erp_names = []
        if frm and to:
            eb = (VendorBill.objects.filter(is_active=True, bill_date__gte=frm, bill_date__lte=to)
                  .exclude(status='CANCELLED').exclude(tally_guid__startswith='OPENING')
                  .exclude(tally_guid__startswith='EXPJRNL'))
            if company:
                eb = eb.filter(vendor__company_id=company)
            erp_names = list(eb.values_list('vendor__vendor_name', flat=True).distinct())
        erp_match = _vendor_matcher(erp_names)
        rows = []
        in_n = jr_n = miss_n = 0
        in_amt = jr_amt = miss_amt = Decimal('0')
        for v in vlist:
            amt = v.amount or Decimal('0')
            inerp = bool((v.guid and v.guid in present) or (v.party and erp_match(v.party)))
            status = _expense_status(inerp, v.sub_category, v.ledger_name)
            if status == 'erp':
                in_n += 1; in_amt += amt
            elif status == 'journal':
                jr_n += 1; jr_amt += amt
            else:
                miss_n += 1; miss_amt += amt
            rows.append({'date': str(v.voucher_date), 'voucher_no': v.voucher_no, 'voucher_type': v.voucher_type,
                         'ledger': v.ledger_name, 'party': v.party, 'amount': str(v.amount),
                         'group': v.group_type, 'sub': v.sub_category, 'in_erp': inerp, 'status': status,
                         # a GUID-matched voucher resolves to one ERP bill → clickable; a
                         # vendor-name match can't pick one bill, so it stays unlinked.
                         'bill_id': (str(present[v.guid]) if (v.guid and v.guid in present) else None)})
        total = in_amt + jr_amt + miss_amt
        return Response({'vouchers': rows, 'count': len(rows), 'total': str(total),
                         'in_erp_count': in_n, 'in_erp_total': str(in_amt),
                         'journal_count': jr_n, 'journal_total': str(jr_amt),
                         'missing_count': miss_n, 'missing_total': str(miss_amt)})


class ExpenseReconcileView(APIView):
    """Whole-company reconciliation summary: every Tally expense sub-category split
    into ✓ in ERP (a real bill) · journal (no bill expected — freight/salary/rent/…)
    · ⚠ missing (a genuine bill gap). One block per company. Used by the Expense
    Reconcile page so the match can be seen at a glance, not via a shell.
    Open to any logged-in user (no module gate) — a read-only reconciliation view."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        import calendar
        from .models import ExpenseVoucher, VendorBill
        from core.models import Company

        company = request.query_params.get('company') or None
        g = (request.query_params.get('group') or '').upper()
        period = (request.query_params.get('period') or '').strip()   # 'YYYY-MM' or '' = whole year
        if not (len(period) == 7 and period[4] == '-'):
            period = ''

        comps = Company.objects.all()
        if company:
            comps = comps.filter(id=company)

        # Months available to pick (across the selected company/group), newest first.
        pq = ExpenseVoucher.objects.all()
        if company:
            pq = pq.filter(company_id=company)
        if g in ('DIRECT', 'INDIRECT'):
            pq = pq.filter(group_type=g)
        periods = sorted(set(pq.values_list('period_key', flat=True)), reverse=True)

        out = []
        for c in comps.order_by('company_code'):
            vs = ExpenseVoucher.objects.filter(company=c)
            if g in ('DIRECT', 'INDIRECT'):
                vs = vs.filter(group_type=g)
            if period:
                vs = vs.filter(period_key=period)
            # Grab the distinct period_keys in one query (also tells us if the
            # company has ANY vouchers — avoids a separate .exists() round-trip).
            month_keys = sorted(set(vs.values_list('period_key', flat=True)))
            if not month_keys:
                continue
            # Exact match: Day-Book GUID stamped onto a real bill.
            guids = set(vs.exclude(guid='').values_list('guid', flat=True))
            present = set(VendorBill.objects.filter(
                tally_guid__in=guids
            ).values_list('tally_guid', flat=True)) if guids else set()
            # Vendor-level match — ONE query spanning all months for this company,
            # then bucket vendor names by bill_date month in Python. Replaces the
            # per-month query loop (N+1 -> 1).
            valid_months = [m for m in month_keys if len(m) == 7 and m[4] == '-']
            mv = {}
            if valid_months:
                first_m, last_m = valid_months[0], valid_months[-1]
                fy, fmo = int(first_m[:4]), int(first_m[5:7])
                ly, lmo = int(last_m[:4]), int(last_m[5:7])
                range_start = f'{fy:04d}-{fmo:02d}-01'
                range_end = f'{ly:04d}-{lmo:02d}-{calendar.monthrange(ly, lmo)[1]:02d}'
                eb_rows = (VendorBill.objects
                           .filter(is_active=True, bill_date__gte=range_start,
                                   bill_date__lte=range_end, vendor__company_id=c.id)
                           .exclude(status='CANCELLED')
                           .exclude(tally_guid__startswith='OPENING')
                           .exclude(tally_guid__startswith='EXPJRNL')
                           .values_list('vendor__vendor_name', 'bill_date'))
                # Bucket by YYYY-MM
                names_by_month = defaultdict(set)
                for vname, bdate in eb_rows:
                    if vname and bdate:
                        names_by_month[f'{bdate.year:04d}-{bdate.month:02d}'].add(vname)
                for m in valid_months:
                    mv[m] = _vendor_matcher(names_by_month.get(m, set()))

            cats = {}
            tot = {'tally': Decimal('0'), 'erp': Decimal('0'), 'journal': Decimal('0'), 'missing': Decimal('0')}
            cnt = {'erp': 0, 'journal': 0, 'missing': 0}
            for v in vs.only('sub_category', 'group_type', 'ledger_name', 'party', 'guid', 'amount', 'period_key').iterator():
                amt = v.amount or Decimal('0')
                m_match = mv.get(v.period_key)
                inerp = bool((v.guid and v.guid in present)
                             or (m_match and v.party and m_match(v.party)))
                st = _expense_status(inerp, v.sub_category, v.ledger_name)
                key = v.sub_category or '(Other)'
                row = cats.setdefault(key, {'sub': key, 'group': v.group_type,
                                            'tally': Decimal('0'), 'erp': Decimal('0'),
                                            'journal': Decimal('0'), 'missing': Decimal('0'),
                                            'erp_n': 0, 'journal_n': 0, 'missing_n': 0})
                row['tally'] += amt
                row[st] += amt
                row[st + '_n'] += 1
                tot['tally'] += amt
                tot[st] += amt
                cnt[st] += 1

            rows = sorted(cats.values(), key=lambda r: r['missing'], reverse=True)
            for r in rows:
                for k in ('tally', 'erp', 'journal', 'missing'):
                    r[k] = str(r[k])
            out.append({
                'company_id': str(c.id), 'company_code': c.company_code,
                'company_name': c.legal_name or c.company_code,
                'rows': rows,
                'tally_total': str(tot['tally']), 'erp_total': str(tot['erp']),
                'journal_total': str(tot['journal']), 'missing_total': str(tot['missing']),
                'erp_count': cnt['erp'], 'journal_count': cnt['journal'], 'missing_count': cnt['missing'],
                'voucher_count': cnt['erp'] + cnt['journal'] + cnt['missing'],
            })
        return Response({'companies': out, 'periods': periods, 'period': period})

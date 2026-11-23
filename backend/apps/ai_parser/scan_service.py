"""Invoice-scan pipeline logic.

Claude vision reads each uploaded PDF/image WHOLE (no local OCR — the heavy
tesseract/easyocr stack is optional and often absent on Render), segments it
into individual invoices with page ranges, and extracts header + item lines via
a forced tool schema. Each detected invoice becomes an InvoiceScanBill, is
matched to an existing Tally VendorBill (or flagged to create a new one), and —
only on the operator's manual CONFIRM — its item lines are written to the bill.

Vendor/product matching and the reconstructed PO/GRN chain are REUSED from the
Tally importer (sales.tally_import_run) so scanned bills behave identically to
imported ones (same masters, same dashboard scoping).
"""
import base64
import logging
import re
import os
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.utils import timezone
from common.ai_log import generate_logged

logger = logging.getLogger(__name__)


# Standard TDS rates a residual is tested against when the scanner couldn't read a
# TDS line (194C 1%/2% contract/labour, 194Q 0.1% goods). A labour bill like Falcon
# deducts 194C @ 2%, so subtotal 2,91,863 × 2% = 5,837 — the "Round off" the display
# was forced to show. Rupee tolerance absorbs rate rounding.
_TDS_RATES = (Decimal('0.001'), Decimal('0.0075'), Decimal('0.01'), Decimal('0.02'), Decimal('0.05'), Decimal('0.1'))


def infer_tds_from_residual(subtotal, line_gst, total, *, already_tds, tol=Decimal('5')):
    """When the scanner missed a bill's TDS line, the gap between (subtotal + GST)
    and the NET total is really the TDS — but with tds_amount=0 it fell into the
    frontend's catch-all "Round off". This tests that gap against the standard TDS
    rates: when the UNEXPLAINED negative residual = subtotal × a known rate (within
    `tol` rupees), it's almost certainly TDS, so return that rupee amount; else
    return 0 (leave a genuine rounding alone). Pure — no DB, no LLM.

    Returns the inferred TDS (Decimal, >0) or Decimal('0'). Never fires when the
    scanner already captured a TDS amount, or the residual is tiny (real rounding),
    or positive (total ≥ gross — nothing withheld)."""
    sub = Decimal(subtotal or 0)
    gst = Decimal(line_gst or 0)
    tot = Decimal(total or 0)
    if (already_tds or 0) > 0 or sub <= 0 or tot <= 0:
        return Decimal('0')
    residual = (sub + gst) - tot        # positive = money missing from the total = candidate TDS
    if residual <= tol:                 # ≤ tolerance → genuine rounding, not TDS
        return Decimal('0')
    for rate in _TDS_RATES:
        if abs(residual - (sub * rate)) <= tol:
            return residual.quantize(Decimal('0.01'))
    return Decimal('0')                 # matches no standard rate → leave as round-off


class DuplicateBillError(ValueError):
    """Raised by commit_scan_bill when the scan matches an existing bill.

    Carries that bill so the API can offer MERGE (attach this scan to it — one
    bill, "Scan + Tally", no duplicate) instead of only "create a separate bill".
    Subclasses ValueError so existing `except ValueError` callers still behave;
    scan_views catches it first to add the bill's id to the response.
    """

    def __init__(self, message, bill=None):
        super().__init__(message)
        self.bill = bill

# Vision-capable default; override with env AI_SCAN_MODEL. Sonnet balances
# accuracy and cost for high-volume batches; swap to claude-opus-4-8 for the
# hardest scans.
DEFAULT_MODEL = os.environ.get('AI_SCAN_MODEL', 'claude-sonnet-5')
MAX_TOKENS = 8192

# Reconcile tolerance: items must sum to the bill total within max(₹1, 0.5%).
_REL_TOL = Decimal('0.005')
_ABS_TOL = Decimal('1')


EXTRACT_TOOL = {
    'name': 'record_invoices',
    'description': (
        'Record EVERY distinct purchase invoice/bill found in the document. '
        'One PDF may contain several separate bills (possibly different '
        'vendors) — return one array element per invoice, with the page range '
        'it spans.'
    ),
    'input_schema': {
        'type': 'object',
        'properties': {
            'invoices': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'properties': {
                        'page_start': {'type': 'integer', 'description': '1-based first page of this invoice'},
                        'page_end': {'type': 'integer', 'description': '1-based last page of this invoice'},
                        'vendor_name': {'type': 'string', 'description': 'the SELLER / supplier who ISSUED this bill (the party at the top, near "GSTIN/UIN"). NOT the buyer / "Bill to" / "Billed to" / "Ship to" / "Consignee" / "Buyer (Bill to)".'},
                        'vendor_name_en': {'type': 'string', 'description': 'the SELLER / supplier name ROMANIZED into English/Latin letters when the printed name is in a regional script (Tamil, Hindi, Telugu, etc.) — transliterate it. If the name is ALREADY in English, repeat it unchanged. Lets the ERP match a regional-script bill to its English vendor master.'},
                        'vendor_gstin': {'type': 'string', 'description': 'the SELLER / supplier\'s 15-char GSTIN (printed next to the seller name at the top). NEVER the buyer\'s / "Bill to" GSTIN — on a purchase bill the buyer is the recipient, so its GSTIN must not go here. If a bill shows two GSTINs, this is the seller\'s (the one NOT under "Bill to"/"Ship to").'},
                        'transporter_name': {'type': 'string', 'description': 'transport/carrier company if shown ("Dispatched through" / "Transporter" / "Lorry freight by") — NOT the supplier'},
                        'lorry_no': {'type': 'string', 'description': 'lorry / vehicle number if shown'},
                        'invoice_no': {'type': 'string'},
                        'marketplace_order_no': {'type': 'string', 'description': 'ON A MARKETPLACE INVOICE (Amazon / Flipkart etc.): the ORDER number ("Order Number", e.g. "406-4030665-3165147"), which is DIFFERENT from the invoice number. Omit if the bill is not a marketplace invoice.'},
                        'invoice_date': {'type': 'string', 'description': 'YYYY-MM-DD'},
                        'due_date': {'type': 'string', 'description': 'payment due date if the bill prints one ("Payment Due Date", "Due Date"), YYYY-MM-DD; omit if absent'},
                        'subtotal': {'type': 'number', 'description': 'taxable value before GST'},
                        'tax_amount': {'type': 'number', 'description': 'total GST'},
                        'total_amount': {'type': 'number', 'description': 'invoice grand total'},
                        'tds_amount': {'type': 'number', 'description': 'TDS amount deducted on the bill if the invoice shows one (e.g. "Less: TDS", "TDS @ 2%") — the rupee amount, not the %; omit if absent'},
                        'ref_invoice_no': {'type': 'string', 'description': 'ON A FREIGHT / TRANSPORTER SLIP: the GOODS invoice/bill number this freight is AGAINST, often hand-written (e.g. "AS PER B.NO SS033/26-27", "Ref", "Against Bill"). Omit if not a freight slip.'},
                        'confidence': {'type': 'number', 'description': '0-1 overall extraction confidence'},
                        'despatch_to': {'type': 'string', 'description': 'the place this bill is DELIVERED / shipped TO — read from "Despatched to", "Ship to", "Consignee", "Destination" or the delivery address. Return just the town/city/branch name (e.g. "Namakkal", "NKP"). Omit if not shown.'},
                        'despatch_from': {'type': 'string', 'description': 'ON A BRANCH-TRANSFER / DELIVERY-CHALLAN or FREIGHT slip (goods moving between locations, often marked "Branch Transfer" / "Delivery Challan" / "NOT FOR SALE", or a route written "X to Y"): the place/branch the goods move FROM (the consignor / dispatch-from / the first place in a "From … To …" route). Return just the town/branch name (e.g. "Salem", "SLP"). Omit if not shown.'},
                        'suggested_category': {'type': 'string', 'enum': ['RM', 'PACKING', 'FRUIT', 'FREIGHT', 'EXPENSES', 'LAB_EXPENSE', 'MACHINERY'], 'description': 'best-fit spend category for the goods/services on THIS bill, judged from the line items: RM=raw material / ingredients / chemicals; PACKING=bags, boxes, cartons, labels, tape; FRUIT=fruit / fresh agricultural produce bought as fruit; FREIGHT=transport / freight / lorry charges; EXPENSES=general expenses or services (printing, repairs, electrical, stationery); LAB_EXPENSE=laboratory / testing / analysis; MACHINERY=machines, equipment, spare parts, capital goods. Omit if genuinely unclear.'},
                        'suggested_purchase_type': {'type': 'string', 'enum': ['GST Purchase', 'GST Purchase-Fruit', 'Purchase-Bought Note', 'Journal'], 'description': 'Tally purchase voucher type: "GST Purchase"=normal goods bill charging GST; "GST Purchase-Fruit"=fruit / agricultural produce bill charging GST; "Purchase-Bought Note"=farmer / agri bought note (usually GST-exempt, titled "Bought Note"/"BNP"); "Journal"=a service / expense bill with no goods. Omit if unclear.'},
                        'lines': {
                            'type': 'array',
                            'items': {
                                'type': 'object',
                                'properties': {
                                    'product_name': {'type': 'string', 'description': 'the CONCISE product/item NAME only, in ENGLISH — the main item WITHOUT its size / dimension / material / printing / spec detail. E.g. "Label - 5 Litre Back (Size 140 x 150 mm) ... Die Cutting" -> "Label - 5 Litre Back". If the printed name is in a regional script (Tamil, Hindi, Telugu, etc.), TRANSLATE it to its common English name (e.g. the Tamil for neem fruit -> "Neem Fruit"); if already English, use it as printed.'},
                                    'description': {'type': 'string', 'description': 'the FULL line particulars, in ENGLISH — the item name plus all its size / material / spec / printing detail. Translate a regional-script (Tamil / Hindi) description to English; keep an English one as printed.'},
                                    'hsn': {'type': 'string', 'description': 'HSN/SAC code. Also read it from inside the line text when written there, e.g. "(HSN 39232990)".'},
                                    'qty': {'type': 'number', 'description': 'quantity. If the bill has no Qty COLUMN, read it out of the line text — "Bentonite 30 TON @ 6250" -> 30, "2760 Nos x 120.00" -> 2760. Never invent 1 when a real number is printed.'},
                                    'uom': {'type': 'string', 'description': 'unit as printed (KG, TON, NOS, LTR, BAGS, BOX, MTR...). Take the unit written against the QUANTITY, not a unit word inside the product name — in "HDPE Bags 25 KG" the unit is KG, not bags.'},
                                    'rate': {'type': 'number', 'description': 'price per unit. If there is no Rate COLUMN, read it from the line text after @ / x / "Rate:" — "30 TON @ 6250" -> 6250. It must satisfy qty x rate = amount.'},
                                    'amount': {'type': 'number', 'description': 'line taxable amount'},
                                    'gst': {'type': 'number', 'description': 'GST rate % for the line'},
                                    'batch': {'type': 'string', 'description': 'batch / lot number, including when written inside the line text ("Batch No: AX-99").'},
                                    'expiry': {'type': 'string', 'description': 'YYYY-MM-DD if present'},
                                    'discount': {'type': 'number', 'description': 'line discount % if present'},
                                },
                                'required': ['description', 'qty', 'amount'],
                            },
                        },
                    },
                    'required': ['invoice_no', 'total_amount', 'lines'],
                },
            },
        },
        'required': ['invoices'],
    },
}

EXTRACT_PROMPT = (
    'You are reading scanned PURCHASE invoices (vendor bills) for an Indian ERP. '
    'The file may contain MULTIPLE separate invoices — segment them and return '
    'one entry per invoice with its page range. The VENDOR is the SELLER / supplier '
    'who issued the bill (shown at the top, next to "GSTIN/UIN"); it is NOT the buyer. '
    'Never use the "Bill to" / "Billed to" / "Ship to" / "Consignee" / "Buyer" party '
    'or their GSTIN as the vendor — that is the recipient (our own company). If two '
    'GSTINs appear, the vendor\'s is the one that is NOT under Bill-to/Ship-to. '
    'Also give vendor_name_en — the vendor name ROMANIZED into English/Latin '
    'letters when it is printed in a regional script (Tamil, Hindi, Telugu, etc.); '
    'transliterate it, or repeat it unchanged when already in English. This lets '
    'the ERP match a regional-script bill to its English vendor master. '
    'For each invoice extract the '
    'vendor name + GSTIN, invoice number, invoice date, the payment due date if '
    'the bill prints one ("Payment Due Date" / "Due Date"), taxable subtotal, total '
    'GST, grand total, the transport/carrier company if the bill shows one '
    '("Dispatched through" / "Transporter" / "Lorry freight by") and the lorry/'
    'vehicle number, and EVERY line item — give both product_name (the CONCISE '
    'item name only, WITHOUT the size/spec/printing detail) and description (the '
    'full particulars) — BOTH in ENGLISH: translate a regional-script (Tamil / '
    'Hindi / Telugu) product name to its common English name (e.g. the Tamil for '
    'neem fruit -> "Neem Fruit"), and keep English names as printed — plus HSN/SAC, '
    'quantity, unit of measure, rate, taxable amount, GST %, and batch / expiry / '
    'discount when shown. Also capture any TDS amount the bill deducts (e.g. '
    '"Less: TDS", "TDS @ 2%") as tds_amount (the rupee figure, not the percent). '
    'On a FREIGHT / transporter slip, capture ref_invoice_no — the GOODS invoice/'
    'bill number the freight is against (often hand-written, "AS PER B.NO ..."). '
    'Also capture despatch_to (the town/city/branch the goods are delivered to, '
    'from "Despatched to" / "Ship to" / "Consignee" / the delivery address) and, '
    'on a BRANCH-TRANSFER / DELIVERY-CHALLAN or FREIGHT slip that shows a route '
    '("From X to Y", "Branch Transfer", "Delivery Challan"), despatch_from (the '
    'place/branch the goods move FROM — the first place in the route). And — '
    'judging from the line items and whether GST is charged — suggested_category '
    '(RM / PACKING / FRUIT / FREIGHT / EXPENSES / LAB_EXPENSE / MACHINERY) and '
    'suggested_purchase_type (GST Purchase / GST Purchase-Fruit / Purchase-Bought '
    'Note / Journal). Omit any of these three if genuinely unclear. '
    'Read HANDWRITTEN figures carefully — many of these bills and freight slips '
    'are hand-written. Always return the invoice number, the taxable subtotal, '
    'the GST and the grand total whenever they are legible, even if some line '
    'items are faint or unreadable; capture the lines you CAN read rather than '
    'returning none. Do not leave a field blank when its value is printed or '
    'written on the bill. '
    'Read amounts as plain numbers (no currency symbols or '
    'commas). If a value is genuinely absent, omit it. Call record_invoices once '
    'with all invoices found.'
)


# --------------------------------------------------------------------- helpers
def _to_dec(v, default='0'):
    if v is None or v == '':
        return Decimal(default)
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal(default)


def _pdate(s):
    if not s:
        return None
    from datetime import datetime
    for fmt in ('%Y-%m-%d', '%d-%m-%Y', '%d/%m/%Y', '%Y/%m/%d', '%d-%b-%Y', '%d %b %Y'):
        try:
            return datetime.strptime(str(s).strip(), fmt).date()
        except ValueError:
            continue
    return None


def _vendor_credit_days(vendor):
    """Credit days from the vendor master (int) or None — used to compute a bill's
    due date when the invoice doesn't print one. Mirrors email_bills' helper:
    credit_days first, else the first number in payment_terms."""
    days = getattr(vendor, 'credit_days', None)
    if days:
        try:
            return int(days)
        except (ValueError, TypeError):
            pass
    m = re.search(r'(\d+)', str(getattr(vendor, 'payment_terms', '') or ''))
    return int(m.group(1)) if m else None


def _due_date_for(sb, vendor, bill_date):
    """A bill's due date: the value read/typed on the scan (the invoice's printed
    due date, or the operator's override) wins; else compute bill_date + the
    vendor's credit days; else None (left blank rather than guessed)."""
    # Use the read/typed date only when it's on or after the bill date — a due
    # date before the invoice date is invalid, so fall back to the computation.
    if sb.due_date and (not bill_date or sb.due_date >= bill_date):
        return sb.due_date
    from datetime import timedelta
    days = _vendor_credit_days(vendor)
    return (bill_date + timedelta(days=days)) if (days and bill_date) else None


# Categories the Scan review dropdown offers (keep in sync with the frontend
# CATEGORIES list). The AI's bill-content guess is accepted only if it is one of
# these, so we never set a value the dropdown can't show.
_AI_SUGGESTABLE_CATS = {'RM', 'PACKING', 'FRUIT', 'FREIGHT', 'EXPENSES', 'LAB_EXPENSE', 'MACHINERY'}


def _match_warehouse_by_location(company, text):
    """A warehouse whose city (or name/code) appears in the bill's delivery place,
    or vice-versa — so "Despatched to … (Namakkal)" picks the Namakkal warehouse.
    City is tried first because warehouse NAMES are often codes (e.g. NKP-SS).
    None when nothing matches."""
    text = (text or '').strip().lower()
    if not text or company is None:
        return None
    from core.models import Warehouse
    whs = list(Warehouse.objects.filter(company=company, is_active=True, active_flag=True))
    for w in whs:
        city = (w.city or '').strip().lower()
        if city and (city in text or text in city):
            return w
    for w in whs:
        for token in ((w.name or ''), (w.warehouse_code or '')):
            token = token.strip().lower()
            if len(token) >= 3 and (token in text or text in token):
                return w
    return None


# A DC / branch-transfer slip names the route by VILLAGE ("from Sellapatti to
# Neykilpatti"), but the warehouse NAMES are abbreviations (SLP = Sellapatti,
# NKP = Neikkarapatti, TVP = Thevur) — NOT substrings of the village — so a text
# match can't connect them. This maps the village (and its spellings) to the
# warehouse-code fragment. Add a line here when a new route/village shows up.
_WH_ALIASES = [
    (('sellapatti', 'sellappatti', 'selapatti', 'sellapati'), 'slp'),
    (('neikkarapatti', 'neikarapatti', 'neykilpatti', 'naikampatti', 'neikkampatti', 'naickenpatti'), 'nkp'),
    (('thevur', 'thevupatti', 'thevar', 'thevoor'), 'tvp'),
    (('karuppur', 'sidco'), 'sid'),
    (('bangalore', 'bengaluru', 'blore', 'blr'), 'blre'),
    (('kondalampatti', 'kondapatti'), 'kdp'),
]


def _match_warehouse_text(company, text):
    """Resolve a place/village named on a DC or freight slip to a company warehouse.
    Tries the village→code aliases FIRST (warehouse names are abbreviations, not
    substrings of the village), then the generic city / name / code matcher."""
    t = (text or '').strip().lower()
    if not t or company is None:
        return None
    from core.models import Warehouse
    whs = list(Warehouse.objects.filter(company=company, is_active=True, active_flag=True))
    for villages, code in _WH_ALIASES:
        if any(v in t for v in villages):
            for w in whs:
                nm = f"{w.name or ''} {w.warehouse_code or ''}".lower()
                if code in nm:
                    return w
    return _match_warehouse_by_location(company, text)


# Indian vehicle-plate shapes: TN30AE3335, TN 30 AE 3335, TN30A3335.
_VEHICLE_RE = re.compile(r'\b([A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{3,4})\b')


def _dc_route(sb):
    """(from_place, to_place) for a DC slip. The AI's despatch_from/to first; then
    the KNOWN warehouse villages named on the slip, in the order they appear
    ("Sellapatti … Neikarapatti" -> from SLP, to NKP) — the most reliable signal,
    since we know the village list; then a plain "X to Y" route in the text (slips
    write it WITHOUT a leading "from", which the old parser required and missed)."""
    raw = sb.raw if isinstance(sb.raw, dict) else {}
    frm = (raw.get('despatch_from') or '').strip()
    to = (raw.get('despatch_to') or '').strip()
    if frm and to:
        return frm, to
    narr = ' '.join(
        (ln.get('description') or ln.get('product_name') or '')
        for ln in (sb.lines or []) if isinstance(ln, dict))
    narr = f"{frm} {to} {narr} {sb.dc_material or ''}"
    # 1) known warehouse villages named on the slip, in order of appearance
    low = narr.lower()
    hits = []
    for villages, _code in _WH_ALIASES:
        pos = min([low.find(v) for v in villages if v in low] or [-1])
        if pos >= 0:
            hits.append((pos, villages[0]))
    hits.sort()
    if len(hits) >= 2:
        frm = frm or hits[0][1]
        to = to or hits[1][1]
    # 2) a plain "X to Y" route (optional leading "from") fills whatever's left
    if not frm or not to:
        m = re.search(r'(?:from\s+)?([A-Za-z][A-Za-z.]+)\s+to\s+([A-Za-z][A-Za-z.]+)', narr, re.I)
        if m:
            frm = frm or m.group(1).strip()
            to = to or m.group(2).strip()
    # 3) only one known village and still no destination -> it's the destination
    if len(hits) == 1 and not to:
        to = hits[0][1]
    return frm, to


def _scan_lorry_from_text(sb):
    """Recover a lorry/vehicle number the AI missed (common on handwritten freight
    slips) by scanning the extracted text for an Indian plate pattern. Returns the
    normalised plate, or '' if the slip already has one / none is found."""
    if (sb.lorry_no or '').strip():
        return ''
    raw = sb.raw if isinstance(sb.raw, dict) else {}
    parts = [str(raw.get('lorry_no') or ''), str(raw.get('vehicle_no') or '')]
    for ln in (sb.lines or []):
        if isinstance(ln, dict):
            parts.append(str(ln.get('description') or ''))
            parts.append(str(ln.get('product_name') or ''))
    m = _VEHICLE_RE.search(' '.join(parts).upper())
    return re.sub(r'[\s-]', '', m.group(1))[:50] if m else ''


def _vendor_usual_warehouse(vendor):
    """The warehouse this vendor's goods usually land in — most common across the
    vendor's recent warehoused bills. The fallback when the bill's delivery place
    matches no warehouse. None when the vendor has none yet."""
    if vendor is None:
        return None
    from collections import Counter
    from purchase.models import VendorBill
    rows = (VendorBill.objects
            .filter(vendor=vendor, is_active=True, warehouse__isnull=False)
            .order_by('-bill_date', '-created_at')
            .values_list('warehouse_id', flat=True)[:20])
    c = Counter(rows)
    if not c:
        return None
    from core.models import Warehouse
    return Warehouse.objects.filter(pk=c.most_common(1)[0][0]).first()


def _apply_class_suggestion(sb):
    """Pre-fill Purchase type, Category and Warehouse on a scanned goods bill —
    only blanks, so an operator's own pick is never overwritten.

    Purchase type + Category: the vendor's usual (most-common past bills) first,
    then — when the vendor has no such history — what the bill ITSELF says (the
    AI's read of the goods, from sb.raw). Warehouse: the delivery place printed on
    the bill matched to a warehouse first, else the vendor's usual warehouse."""
    vend = sb.matched_vendor
    raw = sb.raw if isinstance(sb.raw, dict) else {}
    changed = []

    # Purchase type + Category — vendor history, then the bill's own content.
    if not ((sb.voucher_type or '').strip() and (sb.category or '').strip()):
        from purchase.bill_classification import suggest_bill_class
        pids = [l.get('product_id') for l in (sb.lines or [])
                if isinstance(l, dict) and l.get('product_id')]
        vt, cat = suggest_bill_class(sb.batch.company, vend, pids) if vend else ('', '')
        if not vt:
            vt = (raw.get('suggested_purchase_type') or '').strip()
        if not cat:
            ai_cat = (raw.get('suggested_category') or '').strip().upper()
            cat = ai_cat if ai_cat in _AI_SUGGESTABLE_CATS else ''
        if vt and not (sb.voucher_type or '').strip():
            sb.voucher_type = vt[:100]
            changed.append('voucher_type')
        if cat and not (sb.category or '').strip():
            sb.category = cat
            changed.append('category')

    # Warehouse — the bill's delivery place, else the vendor's usual.
    if not sb.warehouse_id:
        wh = _match_warehouse_by_location(sb.batch.company, raw.get('despatch_to'))
        if wh is None:
            wh = _vendor_usual_warehouse(vend)
        if wh is not None:
            sb.warehouse = wh
            changed.append('warehouse')

    if changed:
        sb.save(update_fields=changed)


def _media_type(doc):
    ct = (doc.content_type or '').lower()
    if ct:
        return ct
    name = (doc.original_name or doc.file.name or '').lower()
    if name.endswith('.pdf'):
        return 'application/pdf'
    if name.endswith('.png'):
        return 'image/png'
    if name.endswith(('.jpg', '.jpeg')):
        return 'image/jpeg'
    if name.endswith('.webp'):
        return 'image/webp'
    return 'application/pdf'


def _read_bytes(doc):
    doc.file.open('rb')
    try:
        return doc.file.read()
    finally:
        doc.file.close()


# JSON shape appended to the shared prompt for the Gemini path (Gemini returns
# text, not tool calls — we ask for strict JSON and parse it).
GEMINI_JSON_SUFFIX = (
    '\n\nReturn ONLY a JSON object of this exact shape — no markdown, no code '
    'fences, no commentary:\n'
    '{"invoices":[{"page_start":1,"page_end":1,"vendor_name":"","vendor_name_en":"","vendor_gstin":"",'
    '"transporter_name":"","lorry_no":"",'
    '"invoice_no":"","marketplace_order_no":"","invoice_date":"YYYY-MM-DD","due_date":"YYYY-MM-DD","subtotal":0,"tax_amount":0,'
    '"total_amount":0,"confidence":0.0,"despatch_to":"","suggested_category":"","suggested_purchase_type":"","lines":[{"product_name":"","description":"","hsn":"","qty":0,'
    '"uom":"","rate":0,"amount":0,"gst":0,"batch":"","expiry":"","discount":0}]}]}'
)


# ------------------------------------------------------------------ extraction
_STATUS_RANK = {'failed': 0, 'partial': 1, 'success': 2}


def _scan_status(invoices, err):
    """Classify a Gemini attempt the same 3-way way receipt/weighment extraction
    does, so the retry-vs-keep decision below can compare attempts consistently."""
    if err:
        return 'failed'
    return 'success' if invoices else 'partial'


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _result_score(invoices):
    """How COMPLETE an extraction is — higher is better. Sums the critical fields
    actually captured across every invoice, so the retry can prefer the RICHER
    read even when the cheap model already returned *something*. The old 3-way
    status counted any non-empty result as 'success', so a thin read (blank
    invoice no / zero totals / no line items — the common handwritten-bill case)
    was kept and the stronger model was never paid for."""
    score = 0
    for inv in (invoices or []):
        if not isinstance(inv, dict):
            continue
        for k in ('vendor_name', 'vendor_gstin', 'invoice_no', 'invoice_date'):
            if str(inv.get(k) or '').strip():
                score += 1
        for k in ('subtotal', 'tax_amount', 'total_amount'):
            if _num(inv.get(k)) != 0:
                score += 1
        lines = inv.get('lines')
        for ln in (lines if isinstance(lines, list) else []):
            if not isinstance(ln, dict):
                continue
            if str(ln.get('product_name') or ln.get('description') or '').strip():
                score += 1
                if _num(ln.get('amount')) != 0:
                    score += 1
    return score


def _is_complete(invoices):
    """True only when EVERY extracted invoice has the fields a goods/expense bill
    must have to be trusted straight off the cheap model: an invoice number, a
    non-zero total, and at least one named line. A freight slip is sparse by
    nature (often just a lorry number + amount), so a slip with no line items but
    a total still counts — those are reconciled downstream."""
    if not invoices:
        return False
    for inv in invoices:
        if not isinstance(inv, dict):
            return False
        lines = inv.get('lines')
        has_line = any(
            isinstance(l, dict)
            and str(l.get('product_name') or l.get('description') or '').strip()
            for l in (lines if isinstance(lines, list) else []))
        has_total = _num(inv.get('total_amount')) != 0
        has_no = bool(str(inv.get('invoice_no') or '').strip())
        # A freight-looking slip (amount but no line items) is allowed to be lean.
        looks_freight = has_total and not has_line
        if looks_freight:
            continue
        if not (has_no and has_total and has_line):
            return False
    return True


def extract_document(doc):
    """Read the file with the configured LLM → (invoices, raw, error).

    Provider is auto-selected: Gemini when GEMINI_API_KEY is set (the key this
    project already uses for document extraction), else Claude. Override with
    env AI_SCAN_PROVIDER=gemini|anthropic.
    """
    provider = (os.environ.get('AI_SCAN_PROVIDER') or '').strip().lower()
    if not provider:
        provider = 'gemini' if os.environ.get('GEMINI_API_KEY') else 'anthropic'
    if provider == 'gemini':
        return _extract_with_gemini_retrying(doc)
    return _extract_with_anthropic(doc)


def _extract_with_gemini_retrying(doc):
    """Primary/fallback wrapper around _extract_with_gemini, same shape as the
    already-proven pattern in receipt_gemini_extractor.extract_receipt() /
    weighment_gemini_extractor.extract_weighment(): try the cheap model first,
    and only pay for the heavier one when the cheap one didn't fully succeed.

    AI_SCAN_GEMINI_MODEL default is gemini-2.5-flash-lite (same primary as
    receipts/weighment) with AI_SCAN_GEMINI_FALLBACK_MODEL (new, default
    gemini-2.5-flash) as the safety net this file never had before — the
    single-shot version just returned whatever the one model gave it, good or
    bad. Kept as its OWN var pair (not GEMINI_PRIMARY_MODEL/GEMINI_FALLBACK_MODEL)
    so Scan/bank-statement/email-extraction can be tuned independently of
    receipts/weighment, matching how quote extraction already has its own
    GEMINI_QUOTE_PRIMARY_MODEL/GEMINI_QUOTE_FALLBACK_MODEL pair.
    """
    primary = os.environ.get('AI_SCAN_GEMINI_MODEL', 'gemini-2.5-flash-lite').strip()
    fallback_env = os.environ.get('AI_SCAN_GEMINI_FALLBACK_MODEL')
    fallback = (fallback_env if fallback_env is not None else 'gemini-2.5-flash').strip()

    invoices, raw, err = _extract_with_gemini(doc, primary)
    primary_status = _scan_status(invoices, err)

    # Escalate to the stronger model when the cheap one FAILED *or* came back
    # thin (missing invoice no / totals / line items) — the common "many fields
    # missed" case on faint or handwritten bills, which the old status-only gate
    # kept as a good-enough 'success'. Only pay for the heavy model when there's
    # actually something to recover.
    need_escalation = (primary_status != 'success') or not _is_complete(invoices)

    if need_escalation and fallback and fallback.lower() != primary.lower():
        logger.info('Scan extraction primary=%s status=%s complete=%s — retrying with %s',
                     primary, primary_status, _is_complete(invoices), fallback)
        f_invoices, f_raw, f_err = _extract_with_gemini(doc, fallback)
        f_status = _scan_status(f_invoices, f_err)
        # Keep whichever read is richer: a better 3-way status wins outright; on a
        # tie (both 'success'), the higher completeness score wins, so a thin read
        # yields to a fuller one instead of being kept just because it parsed.
        better = (
            _STATUS_RANK.get(f_status, 0) > _STATUS_RANK.get(primary_status, 0)
            or (_STATUS_RANK.get(f_status, 0) == _STATUS_RANK.get(primary_status, 0)
                and _result_score(f_invoices) > _result_score(invoices)))
        if better:
            return f_invoices, f_raw, f_err

    return invoices, raw, err


def _extract_with_gemini(doc, model_name):
    """Gemini vision path — mirrors the app's proven inline-data extractors."""
    try:
        import google.generativeai as genai
    except ImportError:
        return [], None, 'google-generativeai not installed'
    api_key = os.environ.get('GEMINI_API_KEY', '').strip()
    if not api_key:
        return [], None, 'GEMINI_API_KEY not set'
    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(model_name)
        resp = generate_logged(
            model,
            [{'mime_type': _media_type(doc), 'data': _read_bytes(doc)},
             EXTRACT_PROMPT + GEMINI_JSON_SUFFIX],
            what='scan-extract', model_name=model_name,
            request_options={'timeout': 180},
        )
        text = (getattr(resp, 'text', '') or '').strip()
    except Exception as e:  # noqa: BLE001
        logger.exception('gemini scan extract failed (model=%s)', model_name)
        return [], None, f'Gemini error: {e}'
    if not text:
        return [], None, 'empty response from Gemini'
    invoices = _json_invoices(text)
    if invoices is None:
        return [], {'raw': text[:2000]}, 'could not parse JSON from Gemini response'
    return invoices, {'raw': text[:2000]}, ''


def _json_invoices(text):
    """Parse the {"invoices":[...]} JSON out of a model text response.

    Tolerant of ```json fences and leading/trailing prose. Returns the list, or
    None if no JSON object could be recovered."""
    import json
    import re
    t = text.strip()
    t = re.sub(r'^```(?:json)?', '', t).strip()
    t = re.sub(r'```$', '', t).strip()
    try:
        obj = json.loads(t)
    except Exception:  # noqa: BLE001
        m = re.search(r'\{[\s\S]*\}', t)
        if not m:
            return None
        try:
            obj = json.loads(m.group(0))
        except Exception:  # noqa: BLE001
            return None
    if isinstance(obj, list):
        return obj
    return obj.get('invoices', []) or []


def translate_descriptions(texts):
    """Translate a list of (possibly Tamil/Hindi) line descriptions to ENGLISH via
    a text-only AI call (the same provider the extractor uses). Returns a list the
    SAME length and order; on ANY failure returns the originals unchanged so an
    operator's lines are never lost."""
    import json
    import re
    originals = list(texts)
    items = [(t or '').strip() for t in originals]
    if not any(items):
        return originals
    provider = (os.environ.get('AI_SCAN_PROVIDER') or '').strip().lower()
    if not provider:
        provider = 'gemini' if os.environ.get('GEMINI_API_KEY') else 'anthropic'
    prompt = (
        'Translate each item in this JSON array to clear ENGLISH. Transliterate '
        'product / brand names; keep all numbers, sizes, codes and units exactly. '
        'Return ONLY a JSON array of strings, the SAME length and order, no prose.\n\n'
        + json.dumps(items, ensure_ascii=False))
    raw = ''
    try:
        if provider == 'gemini':
            import google.generativeai as genai
            if not os.environ.get('GEMINI_API_KEY', '').strip():
                return originals
            genai.configure(api_key=os.environ['GEMINI_API_KEY'].strip())
            model = genai.GenerativeModel(
                os.environ.get('AI_SCAN_GEMINI_MODEL', 'gemini-2.5-flash').strip())
            resp = generate_logged(model, [prompt], what='scan-translate',
                                   request_options={'timeout': 120})
            raw = (getattr(resp, 'text', '') or '').strip()
        else:
            import anthropic
            if not os.environ.get('ANTHROPIC_API_KEY'):
                return originals
            msg = anthropic.Anthropic().messages.create(
                model=os.environ.get('AI_SCAN_ANTHROPIC_MODEL', 'claude-3-5-haiku-latest'),
                max_tokens=2000, messages=[{'role': 'user', 'content': prompt}])
            raw = ''.join(getattr(bl, 'text', '') for bl in msg.content).strip()
    except Exception:  # noqa: BLE001
        logger.exception('translate_descriptions AI call failed')
        return originals
    raw = re.sub(r'^```(?:json)?', '', raw).strip()
    raw = re.sub(r'```$', '', raw).strip()
    try:
        out = json.loads(raw)
    except Exception:  # noqa: BLE001
        return originals
    if not isinstance(out, list) or len(out) != len(originals):
        return originals
    return [(str(o).strip() or orig) for o, orig in zip(out, originals)]


def translate_scan_lines(sb):
    """Translate this scan's line descriptions to English IN PLACE. Returns the
    number of lines changed; safe (nothing changes on failure)."""
    lines = sb.lines if isinstance(sb.lines, list) else []
    if not lines:
        return 0
    eng = translate_descriptions(
        [l.get('description') if isinstance(l, dict) else '' for l in lines])
    changed = 0
    for l, new in zip(lines, eng):
        if isinstance(l, dict) and new and new != (l.get('description') or ''):
            l['description'] = new
            changed += 1
    if changed:
        sb.lines = lines
        sb.save(update_fields=['lines'])
    return changed


def _extract_with_anthropic(doc):
    """Claude vision path — forced tool schema for clean structured output."""
    try:
        import anthropic
    except ImportError:
        return [], None, 'anthropic SDK not installed'
    if not os.environ.get('ANTHROPIC_API_KEY'):
        return [], None, 'ANTHROPIC_API_KEY not set'
    mt = _media_type(doc)
    file_block = {
        'type': 'document' if mt == 'application/pdf' else 'image',
        'source': {'type': 'base64', 'media_type': mt,
                   'data': base64.b64encode(_read_bytes(doc)).decode('ascii')},
    }
    try:
        client = anthropic.Anthropic()
        resp = client.messages.create(
            model=DEFAULT_MODEL,
            max_tokens=MAX_TOKENS,
            tools=[EXTRACT_TOOL],
            tool_choice={'type': 'tool', 'name': 'record_invoices'},
            messages=[{'role': 'user',
                       'content': [file_block, {'type': 'text', 'text': EXTRACT_PROMPT}]}],
        )
    except Exception as e:  # noqa: BLE001
        logger.exception('anthropic scan extract failed')
        return [], None, str(e)
    for block in resp.content:
        if getattr(block, 'type', None) == 'tool_use' and block.name == 'record_invoices':
            return block.input.get('invoices', []) or [], block.input, ''
    return [], None, 'model returned no structured invoices'


# ---------------------------------------------------------------- ctx (reuse)
def _ctx(company, user):
    """Reuse the Tally importer's per-run context (product cache + resolvers)."""
    from sales.tally_import_run import _Ctx
    return _Ctx(company, user, dry_run=False)


def _sum_lines(lines):
    return sum((_to_dec(l.get('amount')) for l in (lines or [])), Decimal('0'))


def _reconciles(items_sum, target):
    target = _to_dec(target)
    if target == 0:
        return items_sum == 0
    tol = max(_ABS_TOL, (target.copy_abs() * _REL_TOL))
    return (items_sum - target).copy_abs() <= tol


# ------------------------------------------------------------------ matching
def _resolve_vendor_ordered(sb, company):
    """Smart, ordered vendor resolution (Part C). Tries cheapest/most-reliable
    first; the paid GST API is the LAST resort and stays OFF until Part A.

        1. mapping   — operator-saved TallyPartyMap (highest trust)
        2. GSTIN     — exact tax-ID match in the ERP (more reliable than name)
        3. name      — name / fuzzy match
        4. GST API   — [disabled] look up the official name, then match/create
        5. unmatched — leave for the operator to map or create manually

    Returns (vendor_or_None, method).
    """
    from master.models import Vendor
    from sales.models import TallyPartyMap
    from sales.tally_import_run import _match_vendor, _match_by_gstin

    name = (sb.vendor_name or '').strip()
    gstin = (sb.vendor_gstin or '').strip()

    # 1. Operator mapping — highest trust.
    if company and name:
        m = (TallyPartyMap.objects
             .filter(company=company, tally_name__iexact=name, vendor__isnull=False)
             .select_related('vendor').first())
        if m and m.vendor and m.vendor.is_active:
            return m.vendor, 'mapping'

    # 2. GSTIN — reliable tax ID (beats a fuzzy name).
    if len(gstin) == 15:
        v = _match_by_gstin(Vendor, 'gstin__iexact', gstin, company)
        if v:
            return v, 'gstin'

    # 3. Name / fuzzy — the printed name first.
    if name:
        v = _match_vendor(name, company)
        if v:
            return v, 'name'

    # 3b. Romanized name — a regional-script bill (Tamil/Hindi/Telugu) can't
    #     fuzzy-match a Latin master, and handwritten bills often carry no GSTIN.
    #     The AI's transliteration (sb.raw['vendor_name_en']) bridges the scripts:
    #     try it against a saved mapping first, then fuzzy, so "A.S.<tamil>" reaches
    #     the "A.S.Traders" master without the operator mapping it by hand.
    raw = sb.raw if isinstance(sb.raw, dict) else {}
    rom = (raw.get('vendor_name_en') or '').strip()
    if rom and rom.lower() != name.lower():
        if company:
            m = (TallyPartyMap.objects
                 .filter(company=company, tally_name__iexact=rom, vendor__isnull=False)
                 .select_related('vendor').first())
            if m and m.vendor and m.vendor.is_active:
                return m.vendor, 'mapping_romanized'
        v = _match_vendor(rom, company)
        if v:
            return v, 'name_romanized'

    # 4. GST API — LAST RESORT (off until Part A). When enabled:
    #    official = lookup_gstin(gstin) -> match by official name / create vendor.

    # 5. Unmatched — operator maps or creates.
    return None, 'unmatched'


def find_matched_bill(sb):
    """The existing REAL bill this scan belongs to: the (operator-resolved) vendor's
    bill carrying the SAME invoice number (vendor_invoice_no / bill_no). None when
    there is none. Never a bill a scan itself created, and deliberately NOT matched
    on amount (a vendor repeats amounts). Used at scan time AND when the operator
    remaps the vendor in review, so the merge target follows the chosen vendor."""
    from purchase.models import VendorBill
    from django.db.models import Q
    from .scan_models import InvoiceScanBill
    inv = (sb.invoice_no or '').strip()
    if not (sb.matched_vendor_id and inv):
        return None
    scan_created = InvoiceScanBill.objects.filter(
        created_bill__isnull=False).values('created_bill')
    return (VendorBill.objects.filter(vendor_id=sb.matched_vendor_id)
            .filter(Q(vendor_invoice_no__iexact=inv) | Q(bill_no__iexact=inv))
            .exclude(id__in=scan_created)
            .order_by('-bill_date').first())


def match_scan_bill(sb):
    """Resolve vendor + find the existing Tally VendorBill this scan belongs to,
    set reconciliation, and stamp status. Pure DB — safe to re-run."""
    from master.models import Vendor
    from purchase.models import VendorBill
    from sales.tally_import_run import _resolve_vendor, _match_by_gstin
    from django.db.models import Q
    from .scan_models import InvoiceScanBill

    company = _bill_company(sb)
    ctx = _ctx(company, sb.created_by)

    # Vendor — ordered resolution (Part C).
    vend, method = _resolve_vendor_ordered(sb, company)
    if method != 'unmatched':
        logger.info('scan %s vendor resolved by %s', sb.pk, method)
    sb.matched_vendor = vend

    # Existing bill: same vendor + invoice-no (bill_no / vendor_invoice_no) — the
    # SAME rule as the Email Inbox (find_existing_bill). Never a scan's own copy;
    # deliberately NOT amount-matched (a vendor repeats amounts). No invoice-no
    # match -> it's a NEW bill (re-scans are still caught by the confirm guard).
    bill = find_matched_bill(sb)
    sb.matched_bill = bill

    items = _sum_lines(sb.lines)
    if bill:
        # Item-less Tally bills carry the full taxable in `subtotal`.
        sb.reconciled = _reconciles(items, bill.subtotal) or _reconciles(items, sb.subtotal)
        sb.status = 'MATCHED' if sb.reconciled else 'MISMATCH'
    else:
        sb.reconciled = _reconciles(items, sb.subtotal or sb.total_amount)
        sb.status = 'UNMATCHED'   # will create a new bill on confirm
    sb.save(update_fields=['matched_vendor', 'matched_bill', 'reconciled', 'status'])
    return sb


def recompute_status(sb):
    """Recompute reconciliation + status from the CURRENT matched_bill/vendor,
    WITHOUT re-resolving — used after the operator edits lines or picks a
    vendor/bill manually in review."""
    if sb.status == 'CONFIRMED':
        return sb
    items = _sum_lines(sb.lines)
    if sb.matched_bill_id:
        bill = sb.matched_bill
        sb.reconciled = _reconciles(items, bill.subtotal) or _reconciles(items, sb.subtotal)
        sb.status = 'MATCHED' if sb.reconciled else 'MISMATCH'
    else:
        sb.reconciled = _reconciles(items, sb.subtotal or sb.total_amount)
        sb.status = 'UNMATCHED'
    sb.save(update_fields=['reconciled', 'status'])
    return sb


# --------------------------------------------------------------- orchestration
def _file_sha256(doc):
    """SHA-256 of the uploaded file bytes (for the OCR-once file cache)."""
    import hashlib
    return hashlib.sha256(_read_bytes(doc)).hexdigest()


def _cache_invoice(doc, inv):
    """Upsert the per-invoice-number cache (company, invoice_no) → last data."""
    from .scan_models import ScanInvoiceCache
    invno = (inv.get('invoice_no') or '').strip()[:100]
    if not invno:
        return
    company = doc.batch.company if doc.batch_id else None
    try:
        row = ScanInvoiceCache.objects.filter(company=company, invoice_no=invno).first()
        vals = dict(vendor_name=(inv.get('vendor_name') or '')[:255],
                    file_hash=doc.file_hash, data=inv)
        if row:
            for k, v in vals.items():
                setattr(row, k, v)
            row.save(update_fields=list(vals.keys()))
        else:
            ScanInvoiceCache.objects.create(company=company, invoice_no=invno, **vals)
    except Exception:  # noqa: BLE001
        logger.warning('could not cache invoice %r', invno)


def find_inbox_duplicates(new_bills):
    """Freshly-scanned bills that DUPLICATE one already sitting UNCONFIRMED in the
    scan inbox. STRICT: same company + vendor + bill/invoice no + invoice date must
    ALL match — so a real re-scan is caught, but a genuinely different bill is never
    touched. Only the LATER copy is flagged (the earlier one is kept). Returns a
    descriptor per just-scanned duplicate, with the existing bill it matches."""
    from django.db.models import Q
    from .scan_models import InvoiceScanBill
    out = []
    for sb in new_bills:
        inv = (sb.invoice_no or '').strip()
        if not inv or not sb.invoice_date:
            continue   # need bill no AND date to be sure — never guess
        vn = (sb.vendor_name or '').strip()
        qs = (InvoiceScanBill.objects
              .filter(batch__company_id=sb.batch.company_id,
                      invoice_date=sb.invoice_date, invoice_no__iexact=inv)
              .exclude(pk=sb.pk)
              .exclude(status__in=['CONFIRMED', 'SKIPPED', 'FAILED']))
        if sb.matched_vendor_id:
            vq = Q(matched_vendor_id=sb.matched_vendor_id)
            if vn:
                vq |= Q(vendor_name__iexact=vn)
            qs = qs.filter(vq)
        elif vn:
            qs = qs.filter(vendor_name__iexact=vn)
        else:
            continue   # no vendor to match on — don't guess
        existing = (qs.filter(Q(created_at__lt=sb.created_at)
                              | Q(created_at=sb.created_at, id__lt=sb.id))
                    .order_by('created_at', 'id').first())
        if existing is not None:
            # Keep the NEW scan, remove the OLD one (per the owner's rule) — so the
            # copy offered for removal is the EXISTING (older) one, not the fresh sb.
            out.append({
                'scan_id': str(existing.id),    # the OLDER copy to REMOVE
                'bill_no': inv,
                'vendor': (sb.matched_vendor.vendor_name if sb.matched_vendor_id else sb.vendor_name) or '',
                'date': sb.invoice_date.isoformat(),
                'kept_id': str(sb.id),          # the just-scanned copy we keep
            })
    return out


def process_document(doc):
    """Extract → create InvoiceScanBill rows → match each. Returns the rows.

    OCR runs only ONCE per file: an identical re-upload (same SHA-256) reuses the
    cached extraction instead of calling the LLM again.
    """
    from .scan_models import InvoiceScanBill, InvoiceScanDocument

    # File hash → identical-file cache.
    if not doc.file_hash:
        try:
            doc.file_hash = _file_sha256(doc)
            doc.save(update_fields=['file_hash'])
        except Exception:  # noqa: BLE001
            logger.warning('could not hash scan file %s', doc.pk)

    invoices = None
    if doc.file_hash:
        prior = (InvoiceScanDocument.objects
                 .filter(file_hash=doc.file_hash, status='EXTRACTED', extraction__isnull=False)
                 .exclude(pk=doc.pk).order_by('created_at').first())
        if prior and prior.extraction:
            invoices = prior.extraction        # reuse — skip the LLM call
            logger.info('scan %s: reused cached extraction (file already read)', doc.pk)

    if invoices is None:
        invoices, raw, err = extract_document(doc)
        if err:
            doc.status = 'FAILED'
            doc.error_message = err
            doc.save(update_fields=['status', 'error_message'])
            return []

    doc.extraction = invoices

    created = []
    for inv in invoices:
        _idate = _pdate(inv.get('invoice_date'))
        _ddate = _pdate(inv.get('due_date'))
        if _ddate and _idate and _ddate < _idate:
            _ddate = None   # a due date before the invoice date is invalid — drop it
        sb = InvoiceScanBill.objects.create(
            document=doc, batch=doc.batch,
            page_start=int(inv.get('page_start') or 1),
            page_end=int(inv.get('page_end') or inv.get('page_start') or 1),
            vendor_name=(inv.get('vendor_name') or '')[:255],
            vendor_gstin=(inv.get('vendor_gstin') or '')[:20],
            transporter_name=(inv.get('transporter_name') or '')[:255],
            lorry_no=(inv.get('lorry_no') or '')[:50],
            invoice_no=(inv.get('invoice_no') or '')[:100],
            marketplace_order_no=(inv.get('marketplace_order_no') or '')[:80],
            invoice_date=_idate,
            due_date=_ddate,
            subtotal=_to_dec(inv.get('subtotal')),
            tax_amount=_to_dec(inv.get('tax_amount')),
            total_amount=_to_dec(inv.get('total_amount')),
            tds_amount=_to_dec(inv.get('tds_amount')),
            freight_ref_no=(inv.get('ref_invoice_no') or '')[:100],
            lines=_norm_lines(inv.get('lines')),
            raw=inv,
            confidence=_to_dec(inv.get('confidence')),
            created_by=doc.created_by,
        )
        # Auto-open a transporter's bill as FREIGHT (even inside a goods batch) so
        # it doesn't look like a goods bill. Operator can still flip it back.
        if _looks_like_freight(sb):
            sb.bill_type = 'FREIGHT'
            # GROSS model: the scanned total is the NET to-pay (after TDS), so the
            # gross = net + TDS. Payable then = gross - TDS = the net the slip shows.
            sb.freight_amount = (sb.total_amount or Decimal('0')) + (sb.tds_amount or Decimal('0'))
            sb.freight_tds = sb.tds_amount or Decimal('0')
            sb.freight_invoice_no = sb.invoice_no or ''
            sb.freight_invoice_date = sb.invoice_date
            sb.transporter = _match_transporter(sb, company=_bill_company(sb))
            # Automatic goods-bill mapping is DISABLED for now — the operator links
            # the freight to its bill by hand (Link button + popup). Kept here,
            # commented, because it will be wanted again later:
            #   sb.freight_linked_bill = _match_bill_by_ref(sb.freight_ref_no)
            sb.save(update_fields=['bill_type', 'freight_amount', 'freight_invoice_no',
                                   'freight_invoice_date', 'transporter'])
        try:
            match_scan_bill(sb)
        except Exception as e:  # noqa: BLE001
            logger.exception('match failed for scan bill %s', sb.pk)
            sb.status = 'FAILED'
            sb.error_message = str(e)
            sb.save(update_fields=['status', 'error_message'])
        # Auto-suggest Purchase type + Category from the (now matched) vendor's
        # usual, else the products — a goods bill only; freight has neither.
        if sb.bill_type != 'FREIGHT':
            try:
                _apply_class_suggestion(sb)
            except Exception:  # noqa: BLE001 — a suggestion must never fail the scan
                logger.exception('class suggestion failed for scan bill %s', sb.pk)
        created.append(sb)
        _cache_invoice(doc, inv)   # remember this invoice number → its extraction

    doc.status = 'EXTRACTED'
    doc.page_count = max([sb.page_end for sb in created] or [0])
    doc.save(update_fields=['status', 'page_count', 'extraction'])
    return created


# Per-invoice trailing noise to drop from a DERIVED product name (never from an
# operator-typed one): a date / date-range, and a village/warehouse suffix.
# Sizes and specs are NOT touched — only clearly date/location text — so
# "Transport Charges" or an "... 500ML" keep their identity.
_CPN_DATE = re.compile(
    r'\s*\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b'
    r'(?:\s*(?:to|till|[-–—])\s*\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b)?\s*$',
    re.I)
_CPN_WH = re.compile(r'[\s\-]+(?:slp|nkp|tvp|sid|kdp|blre|bangalore)\s*$', re.I)


def _concise_product_name(text):
    """A short product NAME from a line's full particulars: the part before the
    first bracket or line break (where the size/spec block usually begins), so
    "Label - 5 Litre Back (Size 140x150) 100 Gsm ..." -> "Label - 5 Litre Back".
    Then trims a trailing date / date-range and a warehouse suffix, so the same
    service billed on different dates ("Man Power Service 01-04-2026 to
    30-04-2026") resolves to ONE master instead of a fresh one each invoice.
    Falls back to the full text when there's no such split or the head is too
    short to be a real name."""
    text = (text or '').strip()
    if not text:
        return ''
    head = re.split(r'[(\[{]|\r|\n', text, maxsplit=1)[0].strip(' -,:;.')
    base = head if len(head) >= 3 else text
    for _ in range(3):   # peel e.g. "... 01-04-2026 to 30-04-2026 - SLP"
        trimmed = _CPN_WH.sub('', _CPN_DATE.sub('', base)).strip(' -,:;.')
        if trimmed == base:
            break
        base = trimmed
    return base or head or text


_CPN_DATE_ANY = re.compile(r'\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b')


def _tighten_create_name(name):
    """Conservative clean for an operator '+ create product' name (scan review /
    email inbox): drop a TRAILING "(...)" that is per-invoice text — one holding
    a date or long free text like "(As per Bill ... 3num)" or "(... 01-04-2026 to
    30-04-2026)" — plus a trailing bare date/date-range and warehouse suffix.
    KEEPS short size/spec brackets ("(500ML)", "(Tanker)", "(PP Bags)") so a
    deliberate variant the operator typed is never merged away. More cautious
    than _concise_product_name, which is only the last-resort auto-fallback."""
    s = (name or '').strip()
    if not s:
        return s
    prev = None
    while prev != s and s:
        prev = s
        m = re.search(r'\(([^()]*)\)\s*$', s)
        if m:
            inner = m.group(1).strip()
            if _CPN_DATE_ANY.search(inner) or len(inner) > 15:   # dated / free-text tail
                s = s[:m.start()].rstrip(' -,:;.')
                continue
        trimmed = _CPN_WH.sub('', _CPN_DATE.sub('', s)).rstrip(' -,:;.')
        if trimmed != s:
            s = trimmed
            continue
        break
    return s or name.strip()


# ACTUAL regional scripts (Cyrillic + Devanagari..Malayalam) — NOT the typographic
# symbols ½ ® ² or a non-breaking space, which are legitimate in English product
# names ("2½\" CPVC Union", "SUPERTEK®"). Matching "any non-ASCII" would wrongly
# strip those.
_REGIONAL = re.compile(r'[Ѐ-ӿऀ-෿]')
# Tamil / Hindi markers for raw neem (seed & fruit) — the recurring regional-script
# product name.  வேப்ப / வேம்ப = neem (Tamil); நீம / नीम / लिंब = neem.
_NEEM_RE_TA = re.compile(r'வேப்ப|வேம்ப|நீம|नीम|लिंब')


def _englishify_name(name):
    """Never let a REGIONAL-SCRIPT (Tamil/Hindi/…) string become a product MASTER
    name — it makes every linked bill show e.g. 'ஆக வேப்பபழம்' instead of 'Neem
    Seed / Fruit'. The AI is asked to romanise item names; this is the backstop for
    when it didn't. Raw neem collapses to ONE English master; any other regional
    name keeps its English remainder (or a 'rename me' placeholder). An already-
    English name — including one with ½ / ® / ² — is returned unchanged."""
    s = (name or '').strip()
    if not s or not _REGIONAL.search(s):
        return s
    if _NEEM_RE_TA.search(s):
        return 'Neem Seed / Fruit'
    ascii_part = re.sub(r'\s+', ' ', _REGIONAL.sub(' ', s)).strip(' -,:;.')
    return ascii_part if len(ascii_part) >= 3 else 'Unnamed item - regional script (rename)'


# Regional-script UNITS the AI copies off the invoice verbatim (Tamil 'குவிண்டால்'
# = quintal). The bill line's unit must stay English, else it shows a Tamil word in
# the UOM column and the by-category per-unit breakdown. An English unit — even one
# with punctuation like 'Qtl.' — passes through unchanged; an unknown regional unit
# becomes blank so no regional script is ever stored.
_REGIONAL_UOM = {
    'குவிண்டால்': 'Qtl', 'கிலோ': 'Kg', 'டன்': 'MT', 'லிட்டர்': 'Ltr',   # Tamil
    'क्विंटल': 'Qtl', 'किलो': 'Kg',                                      # Hindi
}


def _englishify_uom(uom):
    """Romanise a regional-script unit (e.g. Tamil 'குவிண்டால்' → 'Qtl'); English
    units pass through unchanged; an unknown regional unit returns ''."""
    u = (uom or '').strip()
    if not u or not _REGIONAL.search(u):
        return u
    return _REGIONAL_UOM.get(u, '')


def _norm_lines(lines):
    """Coerce model output to our stored line shape (JSON-safe).

    Runs `fill_lines` first: plenty of vendors print the quantity, unit, rate,
    HSN or batch INSIDE the item text instead of in columns, and a reader can
    miss them there. That pass fills only blanks — by arithmetic where possible,
    by pattern otherwise — and marks a quantity it could not establish, so the
    review screen asks instead of silently shipping 1.
    """
    from .line_fields import fill_lines
    lines = fill_lines(lines, label='scan')
    out = []
    for l in (lines or []):
        out.append({
            'product_name': (l.get('product_name') or '')[:255],
            'description': (l.get('description') or '')[:2000],
            'hsn': (l.get('hsn') or '')[:20],
            'qty': str(_to_dec(l.get('qty'), '1')),
            'uom': (l.get('uom') or '')[:20],
            'rate': str(_to_dec(l.get('rate'))),
            'amount': str(_to_dec(l.get('amount'))),
            'gst': str(_to_dec(l.get('gst'))),
            'batch': (l.get('batch') or '')[:50],
            'expiry': l.get('expiry') or '',
            'discount': str(_to_dec(l.get('discount'))),
            'product_id': l.get('product_id'),   # set during review mapping
            # True when the quantity could not be read or derived and fell back to 1
            # — the review screen flags it rather than letting a wrong qty through.
            'qty_assumed': bool(l.get('qty_assumed')),
        })
    return out


def process_batch(batch):
    """Process every pending document in a batch, then roll up the status."""
    batch.status = 'PROCESSING'
    batch.save(update_fields=['status'])
    total_bills = 0
    try:
        for doc in batch.documents.all():
            if doc.status in ('EXTRACTED', 'FAILED'):
                continue
            rows = process_document(doc)
            total_bills += len(rows)
        batch.bill_count = batch.bills.count()
        batch.doc_count = batch.documents.count()
        batch.status = 'FAILED' if batch.documents.filter(status='FAILED').count() == batch.documents.count() else 'READY'
        batch.save(update_fields=['status', 'bill_count', 'doc_count'])
    except Exception as e:  # noqa: BLE001
        logger.exception('batch processing failed')
        batch.status = 'FAILED'
        batch.error_message = str(e)
        batch.save(update_fields=['status', 'error_message'])
    return batch


# --------------------------------------------------------------------- commit
def _tally_shape(lines):
    """Our JSON lines → the {item,qty,uom,rate,amount} shape _build_purchase_chain wants."""
    return [{
        'item': l.get('description') or '',
        'qty': _to_dec(l.get('qty'), '1'),
        'uom': l.get('uom') or '',
        'rate': _to_dec(l.get('rate')),
        'amount': _to_dec(l.get('amount')),
    } for l in (lines or [])]


def _remember_map(company, tally_name, vendor=None, product=None):
    """Persist an invoice name -> ERP master mapping (TallyPartyMap) so the same
    name auto-resolves on the next scan / Tally import — 'keep Tally as-is,
    maintain a mapping'. Tally is never modified; only this ERP-side link is
    stored. Best-effort — a mapping hiccup never blocks the commit."""
    from sales.models import TallyPartyMap
    name = (tally_name or '').strip()[:255]
    if not (company and name):
        return
    defaults = {}
    if vendor is not None:
        defaults['vendor'] = vendor
    if product is not None:
        defaults['product'] = product
    if not defaults:
        return
    try:
        TallyPartyMap.objects.update_or_create(
            company=company, tally_name=name, defaults=defaults)
    except Exception:  # noqa: BLE001
        logger.warning('could not persist TallyPartyMap for %r', name)


def _attach_scan_to_bill(bill, doc, sb, user):
    """Attach the scanned invoice to the bill so it's viewable from Bills.
    Slices out just this invoice's pages when PyMuPDF is available; otherwise
    attaches the whole source file. Best-effort — never blocks the commit."""
    from django.core.files.base import ContentFile
    from purchase.models import PurchaseAttachment
    if doc is None:
        return
    try:
        data = _read_bytes(doc)
        is_pdf = ('pdf' in (doc.content_type or '').lower()
                  or (doc.original_name or '').lower().endswith('.pdf'))
        if is_pdf:
            try:
                import fitz  # PyMuPDF (optional) — slice this invoice's pages
                src = fitz.open(stream=data, filetype='pdf')
                start = max(0, (sb.page_start or 1) - 1)
                end = min(src.page_count - 1, (sb.page_end or sb.page_start or 1) - 1)
                out = fitz.open()
                out.insert_pdf(src, from_page=start, to_page=end)
                data = out.tobytes()
                out.close(); src.close()
            except Exception:  # noqa: BLE001
                pass  # keep the full file
        name = f"scan-{(sb.invoice_no or 'invoice')}.pdf"[:255]
        if PurchaseAttachment.objects.filter(module='BILL', record_id=bill.id, file_name=name).exists():
            return
        att = PurchaseAttachment(
            module='BILL', record_id=bill.id, file_name=name, file_size=len(data),
            file_type='application/pdf' if is_pdf else (doc.content_type or ''),
            uploaded_by=user)
        att.file.save(name, ContentFile(data), save=True)
    except Exception:  # noqa: BLE001
        logger.warning('could not attach scan to bill %s', getattr(bill, 'pk', None))


def _attach_scan_to_freight(fa, doc, sb, user):
    """Attach the scanned freight bill to the Freight record (module='FREIGHT') so
    it's viewable from the freight page. The WHOLE original file is attached (not a
    page slice) under its own name, so the record carries the complete scanned slip.
    Best-effort. Operators can also add files by hand on the freight page."""
    from django.core.files.base import ContentFile
    from purchase.models import PurchaseAttachment
    if doc is None:
        return
    try:
        data = _read_bytes(doc)
        is_pdf = ('pdf' in (doc.content_type or '').lower()
                  or (doc.original_name or '').lower().endswith('.pdf'))
        name = (doc.original_name or f"freight-{(sb.invoice_no or 'bill')}.pdf")[:255]
        if PurchaseAttachment.objects.filter(module='FREIGHT', record_id=fa.id, file_name=name).exists():
            return
        att = PurchaseAttachment(
            module='FREIGHT', record_id=fa.id, file_name=name, file_size=len(data),
            file_type=(doc.content_type or ('application/pdf' if is_pdf else '')),
            uploaded_by=user)
        att.file.save(name, ContentFile(data), save=True)
    except Exception:  # noqa: BLE001
        logger.warning('could not attach scan to freight %s', getattr(fa, 'pk', None))


def _post_scan_stock(bill, warehouse, godown, user, replace=False, batches=None):
    """Post the bill's received goods into the inventory ledger — a stock RECEIPT
    per bill line at the chosen warehouse + godown. Runs for new bills AND merges
    (the reviewed bill lines are the physical goods either way).

    replace=True (a re-confirm that overwrote the bill lines): the previously
    posted stock for this receipt is reversed first, then the new quantities are
    posted — so re-confirming actually updates stock instead of leaving the old
    numbers.

    The ledger rows are keyed to the bill's reconstructed goods-receipt
    (source_document_type='PurchaseReceiptAdvice', source_document_id=grn.id) so
    they sit under the same source the rest of Purchase uses and the delete-
    reversal signal cleans them up. Quantities/cost come from the actual
    VendorBillLine rows (accurate for merges, where a stale Tally GRN line might
    not match). The receipt is then marked APPROVED so the manual receipt-approve
    path can't post the same goods a second time.

    Idempotent per receipt; best-effort — a stock hiccup must never roll back the
    confirmed bill, so it runs in its own savepoint and swallows errors.
    """
    from decimal import Decimal as _D
    grn = getattr(bill, 'receipt_advice', None)
    if grn is None or warehouse is None or godown is None:
        return
    try:
        from inventory.models import InventoryLedger
        from inventory.services import InventoryService, StockLedgerService
        with transaction.atomic():
            if replace:
                # Re-confirm: wipe the stock this receipt posted before so the new
                # quantities replace it (allow_negative — an overwrite is explicit).
                StockLedgerService.reverse_stock_movement(
                    'PurchaseReceiptAdvice', grn.id, user=user,
                    reason=f'Re-confirmed scan {bill.vendor_invoice_no or bill.bill_no} — replacing stock',
                    allow_negative=True)
            already = InventoryLedger.objects.filter(
                source_document_type='PurchaseReceiptAdvice',
                source_document_id=grn.id, is_active=True).exists()
            if not already:
                for line in bill.bill_lines.filter(is_active=True).select_related('product'):
                    if not line.product_id:
                        continue
                    # A SERVICE is not goods — it must never create stock. A service
                    # saved via service_catalogue has no product_id (already skipped
                    # above); this catches a service the scan's get-or-create stored
                    # as a Product typed SERVICES.
                    if getattr(line.product, 'product_type', '') == 'SERVICES':
                        continue
                    qty = line.quantity
                    if qty is None or _D(str(qty)) <= 0:
                        continue
                    InventoryService.record_stock_entry(
                        warehouse_id=warehouse.id,
                        godown_id=godown.id,
                        product_id=line.product_id,
                        # the batch printed on the bill, when the caller read one
                        # (Email Inbox); blank otherwise, exactly as before
                        batch=(batches or {}).get(line.id, ''),
                        quantity_in=_D(str(qty)),
                        uom=line.uom or None,
                        transaction_type='RECEIPT',
                        source_document_type='PurchaseReceiptAdvice',
                        source_document_id=grn.id,
                        cost=line.rate,
                        transaction_date=bill.bill_date or timezone.now().date(),
                        created_by=user,
                        remarks=f'Auto-posted from scanned invoice {bill.vendor_invoice_no or bill.bill_no}',
                    )
            # Point the receipt at the chosen location and mark it APPROVED so the
            # goods can't be posted a second time via the manual receipt-approve.
            grn.warehouse = warehouse
            for rl in grn.receipt_lines.all():
                if not rl.godown_location_id:
                    rl.godown_location = godown
                    rl.save(update_fields=['godown_location'])
            grn.approval_status = 'APPROVED'
            grn.approved_by = getattr(user, 'stakeholder_profile', None)
            grn.approved_at = timezone.now()
            grn.save(update_fields=['warehouse', 'approval_status', 'approved_by', 'approved_at'])
    except Exception as e:  # noqa: BLE001
        logger.warning('scan stock post failed for bill %s: %s', getattr(bill, 'bill_no', None), e)


def unpost_scan_stock(bill, user):
    """Undo the stock a scan posted for this bill: soft-delete its ledger rows and
    return the goods-receipt to DRAFT so nothing shows in the Stock Ledger. The
    bill and its lines are left untouched — only the stock movement is reversed.

    Raises ValidationError (surfaced to the operator) if a downstream document has
    already consumed the stock, so it can't be silently driven negative. Returns
    the number of ledger rows removed.
    """
    grn = getattr(bill, 'receipt_advice', None)
    if grn is None:
        return 0
    from inventory.services import StockLedgerService
    removed = StockLedgerService.reverse_stock_movement(
        'PurchaseReceiptAdvice', grn.id, user=user,
        reason=f'Undo scan stock {bill.vendor_invoice_no or bill.bill_no}')
    if grn.approval_status != 'DRAFT':
        grn.approval_status = 'DRAFT'
        grn.approved_by = None
        grn.approved_at = None
        grn.save(update_fields=['approval_status', 'approved_by', 'approved_at'])
    return len(removed)


def scan_stock_posted(bill):
    """True if this bill currently has active scan-posted stock rows in the ledger
    (drives the 'Undo stock' button visibility on the converted list)."""
    grn_id = getattr(bill, 'receipt_advice_id', None)
    if not grn_id:
        return False
    from inventory.models import InventoryLedger
    return InventoryLedger.objects.filter(
        source_document_type='PurchaseReceiptAdvice',
        source_document_id=grn_id, is_active=True).exists()


def _match_transporter(sb, company=None):
    """Find the Transporter for a freight bill — by the CARRIER name read off the
    bill (transporter_name), falling back to the bill party (a pure transporter
    bill). Does NOT create. GSTIN is only used when the party IS the transporter
    (else the GSTIN belongs to the goods supplier).

    SCOPED TO THE BILL'S COMPANY: transporters are per-company, and the same real
    carrier is often entered under BOTH companies with slightly different spelling
    ("New Bangalore Roadlines" in SSB vs "New Bangalore Road Lines" in UAI). An
    unscoped name match grabbed whichever spelling happened to be exact — so an
    SSB freight slip could land on the UAI transporter and never show up when the
    SSB bank payment looked for it. Restricting to the bill's company (plus any
    company-less transporters) keeps the slip on the right company's master, or
    returns None so the reviewer maps/creates it there — never a wrong-company
    silent match. Mirrors email_bills._match_transporter_name."""
    from master.models import Transporter
    qs = Transporter.objects.all()
    if company is not None:
        qs = qs.filter(company=company) | qs.filter(company__isnull=True)
    carrier = (sb.transporter_name or '').strip()
    name = carrier or (sb.vendor_name or '').strip()
    gstin = (sb.vendor_gstin or '').strip()
    if not carrier and len(gstin) == 15:
        t = qs.filter(gstin__iexact=gstin).first()
        if t:
            return t
    if name:
        return qs.filter(name__iexact=name).first()
    return None


_FREIGHT_VENDOR_RE = re.compile(
    r'\b(transport|lorry|freight|roadway|road ?line|logistic|carrier|packers?|movers?|cargo|tempo)\b', re.I)


def _looks_like_freight(sb):
    """A scanned bill is likely a FREIGHT slip when its party is a transporter — it
    references a goods invoice (ref_invoice_no), matches a Transporter master, or
    the vendor name reads like a transport firm. Best-effort; the operator can
    always flip the Goods/Freight toggle back."""
    if (sb.freight_ref_no or '').strip():
        return True
    name = (sb.vendor_name or '').strip()
    if not name:
        return False
    try:
        from master.models import Transporter
        if Transporter.objects.filter(name__iexact=name).exists():
            return True
    except Exception:  # noqa: BLE001
        pass
    # A party we already know as a GOODS vendor is NOT freight — even when its
    # name carries a transport-ish word (a supplier called "... Logistics", a
    # chemicals firm with "Carriers" in the name). The loose name pattern below
    # only applies to parties we don't already buy goods from, so a real goods
    # bill never lands in the Freight view by mistake.
    try:
        from master.models import Vendor
        if Vendor.objects.filter(vendor_name__iexact=name).exists():
            return False
    except Exception:  # noqa: BLE001
        pass
    return bool(_FREIGHT_VENDOR_RE.search(name))


def _match_bill_by_ref(ref_no):
    """Find the goods bill a freight slip is AGAINST — by the invoice/bill number
    written (by hand) on the slip, ACROSS companies (the matched bill supplies the
    company). Exact match first, then contains. None if nothing matches."""
    ref = (ref_no or '').strip()
    if not ref:
        return None
    from django.db.models import Q
    from purchase.models import VendorBill
    return (VendorBill.objects.filter(Q(vendor_invoice_no__iexact=ref) | Q(bill_no__iexact=ref)).first()
            or VendorBill.objects.filter(Q(vendor_invoice_no__icontains=ref) | Q(bill_no__icontains=ref)).first())


@transaction.atomic
def _stakeholder(user):
    """FreightAdviceInbound.created_by is a core.StakeholderUser, NOT the auth
    User the request carries — resolve it via the auth user's OneToOne profile so
    the create doesn't raise (nullable, so None is an acceptable fallback)."""
    if user is None:
        return None
    try:
        from core.models import StakeholderUser
        if isinstance(user, StakeholderUser):
            return user
    except Exception:  # noqa: BLE001
        pass
    return getattr(user, 'stakeholder_profile', None)


def _bill_company(sb):
    """The company this scan bill belongs to — the per-bill override if the reviewer
    set one, else the batch's company. Drives vendor matching + the created records."""
    return sb.company or (sb.batch.company if sb.batch_id else None)


def _fill_scan_dc_fields(sb):
    """Fill BLANK DC fields on a scanned branch-transfer freight bill from what we
    already have — the reviewer's own edits are kept (blanks only). Mirrors the
    Email Inbox's fill_draft_dc_fields. dc_value is the goods value (reference only,
    never booked). Returns True if anything changed."""
    changed = False
    company = _bill_company(sb)
    if not sb.dc_no and sb.invoice_no:
        sb.dc_no = (sb.invoice_no or '')[:100]; changed = True
    # FROM / TO — read the route off the slip ("from Sellapatti to Neykilpatti"),
    # then resolve each place to the ACTUAL warehouse (Sellapatti -> SLP PLANT,
    # Neykilpatti -> NKP-SS). Fall back to the raw place text, then (TO only) the
    # delivery warehouse / our company. FROM is left blank only if the slip has none.
    frm_txt, to_txt = _dc_route(sb)
    if not sb.dc_from and frm_txt:
        w = _match_warehouse_text(company, frm_txt)
        sb.dc_from = ((w.name if w else frm_txt) or '')[:255]; changed = True
    # Resolved warehouse → raw place text → the bill's delivery warehouse. NOT the
    # company name: a transporter slip's destination is a place/branch, and
    # defaulting "To" to our legal name was just wrong. A "To" that still holds that
    # old company-name default is treated as stale and re-derived (or cleared).
    comp_nm = ((getattr(company, 'legal_name', '') or '') if company else '').strip().lower()
    to_stale = bool(comp_nm) and (sb.dc_to or '').strip().lower() == comp_nm
    if not sb.dc_to or to_stale:
        w = _match_warehouse_text(company, to_txt) if to_txt else None
        new_to = ((w.name if w else '') or to_txt
                  or (sb.warehouse.name if sb.warehouse_id else '') or '').strip()
        if new_to.lower() == comp_nm:
            new_to = ''
        if new_to and new_to != (sb.dc_to or ''):
            sb.dc_to = new_to[:255]; changed = True
        elif to_stale and not new_to:
            sb.dc_to = ''; changed = True     # drop the wrong company-name default
    if not sb.dc_material:
        for ln in (sb.lines or []):
            mat = (ln.get('description') or '').strip()
            if mat:
                sb.dc_material = mat[:255]; changed = True
                break
    # Lorry no — recover a plate the AI missed off a handwritten slip.
    if not (sb.lorry_no or '').strip():
        lor = _scan_lorry_from_text(sb)
        if lor:
            sb.lorry_no = lor; changed = True
    # dc_value is the GOODS value — NOT the freight. On a transporter slip the total
    # IS the freight, so never copy it here (that wrongly showed the freight as the
    # goods value). Left blank for the reviewer to enter if the slip prints a goods value.
    if changed:
        sb.save(update_fields=['dc_no', 'dc_from', 'dc_to', 'dc_material', 'dc_value', 'lorry_no'])
    return changed


def _commit_freight(sb, user):
    """Freight-only bill → two ways (operator's choice):

    - "Pick from Tally": ``matched_bill`` is set → the freight is ALREADY in the
      system (imported from Tally). Don't create anything new — just attach the
      scanned freight invoice to that bill and mark confirmed.
    - "Create new": no matched_bill → create the freight record the operator
      chose (Local Freight standalone, or Inward Freight advice). No products,
      no VendorBill — the route text is just the remarks.
    """
    # Already-in-Tally path: link to the picked bill, attach the scan, done.
    if sb.matched_bill_id:
        _attach_scan_to_bill(sb.matched_bill, sb.document, sb, user)
        if sb.transporter_id or sb.transporter_name:
            sb.transporter = sb.transporter or _match_transporter(sb, company=_bill_company(sb))
        sb.status = 'CONFIRMED'
        sb.committed_at = timezone.now()
        sb.save(update_fields=['transporter', 'status', 'committed_at'])
        return sb

    # Freight mapped to a goods bill (invoice no written on the slip): the freight
    # is NOT a separate payable — just ATTACH the freight slip to that bill and
    # confirm. No Freight Advice is created (manual review already happened here).
    # Only the operator's manual link is used — automatic matching is disabled for
    # now (kept, commented): `sb.freight_linked_bill or _match_bill_by_ref(...)`.
    linked = sb.freight_linked_bill
    if linked is not None:
        _attach_scan_to_bill(linked, sb.document, sb, user)
        if sb.transporter_id or sb.transporter_name:
            sb.transporter = sb.transporter or _match_transporter(sb, company=_bill_company(sb))
        sb.freight_linked_bill = linked
        sb.status = 'CONFIRMED'
        sb.committed_at = timezone.now()
        sb.save(update_fields=['transporter', 'freight_linked_bill', 'status', 'committed_at'])
        return sb

    create_freight_record_for_scan(sb, user)
    sb.status = 'CONFIRMED'
    sb.committed_at = timezone.now()
    sb.save(update_fields=['status', 'committed_at'])
    return sb


def create_freight_record_for_scan(sb, user):
    """Create the freight RECORD a confirmed freight scan should have — an Inward
    FreightAdviceInbound (freight_target INWARD) or a LocalFreight (else) — link it
    back onto the scan, and attach the scanned slip. Returns the created record.

    This is the single authority for turning a freight scan into its freight
    record, called by both _commit_freight (live confirm) and the
    backfill_freight_advices command (for scans confirmed before they got one), so
    the two can never drift. Does NOT touch the scan's status/committed_at — the
    caller owns that."""
    company = _bill_company(sb)
    if not company:
        raise ValueError('This batch has no company — cannot create freight.')
    transporter = sb.transporter or _match_transporter(sb, company=company)
    # Transporter is OPTIONAL. Many freight slips are a driver / own-vehicle cash
    # voucher with no registered carrier (e.g. a "pay to <vehicle no>" voucher, or
    # a company gate-pass for internal shifting). Identify those by the vehicle
    # number (lorry_no) and/or the free-text payee read off the slip, and only
    # block when there is nothing at all to identify the freight by.
    payee = (sb.transporter_name or '').strip()
    if not transporter and not (sb.lorry_no or '').strip() and not payee:
        raise ValueError('No transporter, vehicle number, or payee — add one before confirming.')
    route = '; '.join((l.get('description') or '').strip()
                      for l in (sb.lines or []) if (l.get('description') or '').strip())[:400]
    # GROSS model (mirrors the Email Inbox): freight_amount is the GROSS freight;
    # Payable = gross − TDS − round-off. TDS/round-off are their OWN fields now, so
    # the figure the reviewer sees is booked exactly.
    amount = sb.freight_amount or Decimal('0')          # GROSS (lorry hire)
    tds = sb.freight_tds or Decimal('0')
    roundoff = sb.freight_roundoff or Decimal('0')
    weight = sb.freight_weight_charge or Decimal('0')   # optional weight/weighment add-on
    payable = max(Decimal('0'), amount + weight - tds - roundoff)
    linked_bill = sb.freight_linked_bill
    fields = ['transporter']
    if sb.freight_target == 'INWARD':
        from purchase.models import FreightAdviceInbound
        rec = FreightAdviceInbound.objects.create(
            # Land as DRAFT (pending approval) — an operator approves it on the
            # Freight page before it counts as a live payable, so a raw OCR
            # confirm never records straight to the freight ledger.
            status='DRAFT',
            direction='INBOUND', source_type='PURCHASE_RECEIPT',
            transporter=transporter, freight_type='LINEHAUL',
            freight_source='SEPARATE_SLIP', vendor_bill=linked_bill,
            base_amount=amount, tds_less=tds, other_charges=weight,
            less_amount=abs(roundoff), less_amount_sign=('LESS' if roundoff >= 0 else 'PLUS'),
            payable_amount=payable, created_by=_stakeholder(user),
            # No registered carrier → keep the slip's free-text payee as the
            # driver/party name so the freight is still identifiable.
            driver_name=(payee[:100] if not transporter else ''),
            lorry_no=(sb.lorry_no or '')[:50],
            freight_date=(sb.freight_invoice_date or sb.invoice_date or timezone.now().date()),
            transport_document_no=(sb.freight_invoice_no or sb.invoice_no or '')[:100],
        )
        sb.created_freight_advice = rec
        fields.append('created_freight_advice')
        _attach_scan_to_freight(rec, sb.document, sb, user)
    else:
        from purchase.local_freight import LocalFreight, generate_local_freight_no
        # A branch-transfer DC: fill any blank DC fields, then tag the LocalFreight.
        # Goods value (dc_value) is reference only — only freight_amount is money.
        if sb.is_dc:
            _fill_scan_dc_fields(sb)
        rec = LocalFreight.objects.create(
            # DRAFT (pending approval) — approved on the Freight page before it
            # becomes a live payable (mirrors the goods-bill DRAFT→OPEN gate).
            status='DRAFT',
            freight_no=generate_local_freight_no(), company=company,
            date=sb.invoice_date or timezone.now().date(),
            factory=sb.warehouse,
            freight_type='LOCAL_FREIGHT',
            transporter=transporter, lorry_no=(sb.lorry_no or '')[:50],
            bill_no=(sb.freight_invoice_no or sb.invoice_no or '')[:100],
            freight_amount=amount, tds_less=tds, additional_freight_amount=weight,
            less_amount=(roundoff if roundoff and roundoff > 0 else Decimal('0')),
            amount_pay=Decimal('0'),   # UNPAID on import, like the Email Inbox
            is_dc=bool(sb.is_dc),
            dc_no=(sb.dc_no or '')[:100], dc_from=(sb.dc_from or '')[:255],
            dc_to=(sb.dc_to or '')[:255], dc_material=(sb.dc_material or '')[:255],
            dc_value=(sb.dc_value or Decimal('0')),
            remarks=((('[DC / Branch Transfer] ' if sb.is_dc else '')
                      + (f'Payee: {payee}. ' if (payee and not transporter) else '')
                      + (f'From scan — {route}' if route else 'From scan'))[:500]),
            created_by=user,
        )
        sb.created_local_freight = rec
        fields.append('created_local_freight')
        _attach_scan_to_freight(rec, sb.document, sb, user)

    sb.transporter = transporter
    sb.save(update_fields=fields)
    return rec


def _pct(v):
    """A GST / discount RATE for the DECIMAL(5,2) line columns (max 999.99). The
    AI sometimes misreads an AMOUNT into the rate (e.g. 5800 into 'gst'), which
    overflows the column and fails the whole commit — so a value outside the
    valid 0-100 percent range is treated as a misread and dropped to 0. The real
    tax/discount money lives in the line AMOUNT and the bill header, not here."""
    d = _to_dec(v)
    return d if Decimal('0') <= d <= Decimal('100') else Decimal('0')


_HALF_TAX_RATES = {Decimal('2.5'), Decimal('6'), Decimal('9'), Decimal('14')}


def _fix_half_component_tax(bill):
    """Repair a single CGST/SGST HALF-rate (2.5/6/9/14) the scanner may have
    stored on a line (e.g. 2.5% where the invoice is 5%, reading only "Output
    CGST 2.5%"). When the bill HEADER already holds the full COMBINED tax, double
    the half line%(s) so the line matches — otherwise a later Edit -> Save
    recomputes off the half rate and HALVES the real tax.

    Acts ONLY when doubling the half lines ties the line-derived tax to the header
    within Rs 1 / 0.5%; a bill whose header also sits at the half rate is left
    alone (genuinely under-taxed — never silently inflated here). Best-effort; a
    hiccup never blocks the commit."""
    try:
        Z = Decimal('0')
        C = Decimal('0.01')
        lines = list(bill.bill_lines.all())
        half = [l for l in lines if (l.tax_percent or Z) in _HALF_TAX_RATES]
        if not half:
            return
        half_tax = Z
        full_tax = Z
        for l in lines:
            base = (l.quantity or Z) * (l.rate or Z)
            base -= base * (l.discount_percent or Z) / 100
            tp = (l.tax_percent or Z)
            half_tax += base * tp / 100
            full_tax += base * (tp * 2 if tp in _HALF_TAX_RATES else tp) / 100
        hdr = (bill.tax_amount or Z)
        tol = max(Decimal('1'), hdr * Decimal('0.005'))
        if abs(hdr - full_tax.quantize(C)) <= tol and abs(hdr - half_tax.quantize(C)) > tol:
            for l in half:
                l.tax_percent = (l.tax_percent or Z) * 2
                l.save(update_fields=['tax_percent'])
    except Exception:  # noqa: BLE001 — reconcile is best-effort, never block a commit
        logger.exception('half-component tax reconcile failed for bill %s', getattr(bill, 'id', '?'))


def _split_folded_charges(bill):
    """If a goods line's amount EXCEEDS rate*qty by a real charge — loading/packing
    the vendor folded into the taxable line (e.g. Godrej De-Oiled Palm Kernel Cake:
    amount = rate*qty + Loading + Packing) — move the excess to a separate
    'Loading & Unloading' line at the SAME Tax %, so the item keeps its invoice
    rate instead of reading rate + charges. Totals/GST are unaffected: one line
    becomes two with the same sum and the same tax rate.

    Skips the GST-inclusive case (excess == the tax, not a charge) and an
    implausibly large excess (a scale error). Best-effort; never blocks a commit."""
    try:
        from purchase.models import VendorBillLine
        Z = Decimal('0')
        C = Decimal('0.01')
        lines = list(bill.bill_lines.all())
        # Only trust the per-line amounts enough to carve a charge out of them
        # when they're internally consistent with the bill's stated GST. A
        # mis-read amount, or a standalone discount line the extractor dropped
        # (e.g. "Less 8%"), inflates a line's taxable value out of step with the
        # header tax; splitting then fabricates a 'Loading & Unloading' charge
        # that isn't on the paper bill (scanned bill CR/340: amount read as 5,960
        # vs a true taxable of 5,465, so the 5,960-5,940=20 excess spun off a
        # phantom line). The folded loading/packing this helper legitimately
        # targets IS part of the taxable base, so a correctly-extracted bill's
        # lines still tie to the GST and still split. GST-based so it's immune to
        # TDS / non-GST charges in total_amount.
        hdr_tax = (bill.tax_amount or Z)
        if hdr_tax > 0:
            expected_tax = Z
            for l in lines:
                tp = (l.tax_percent or Z)
                expected_tax += (l.amount or Z) * (tp * 2 if tp in _HALF_TAX_RATES else tp) / 100
            tol = max(Decimal('2'), hdr_tax * Decimal('0.01'))
            if abs(expected_tax.quantize(C) - hdr_tax) > tol:
                return  # per-line amounts don't reconcile to the GST — don't split
        for l in lines:
            if not l.product_id and not (l.description or '').strip():
                continue                                   # not a real goods/item line
            base = (l.quantity or Z) * (l.rate or Z)
            base -= base * (l.discount_percent or Z) / 100
            base = base.quantize(C)
            if base <= 0:
                continue
            tp = (l.tax_percent or Z)
            excess = ((l.amount or Z) - base).quantize(C)
            tol = max(Decimal('1'), base * Decimal('0.002'))
            if excess <= tol:
                continue                                   # amount already = rate*qty
            if tp > 0 and abs(excess - base * tp / 100) <= tol:
                continue                                   # GST-inclusive, not a charge
            if excess >= base:
                continue                                   # implausible (scale error) — leave it
            l.amount = base
            l.save(update_fields=['amount'])
            VendorBillLine.objects.create(
                bill=bill, product=None, description='Loading & Unloading',
                quantity=Decimal('1'), uom='', rate=excess, tax_percent=tp, amount=excess,
                created_by=getattr(bill, 'created_by', None))
    except Exception:  # noqa: BLE001 — best-effort, never block a commit
        logger.exception('split folded charges failed for bill %s', getattr(bill, 'id', '?'))


@transaction.atomic
def commit_scan_bill(sb, user, replace=False, remember=True, ignore_duplicate=False):
    """Write the reviewed item lines onto the bill. Manual-confirm only.

    ignore_duplicate=True bypasses the same-bill guard — the operator has looked
    at the near-match and said "this is a SEPARATE bill, create it anyway"
    (transport/freight vendors legitimately bill the same amount many times, so
    the guard can flag two genuine bills as one).

    - MATCHED: append VendorBillLine rows to the existing (item-less) Tally bill.
    - UNMATCHED: create a new VendorBill from the scan, then build the PO/GRN
      chain (so it is scoped to the company and shows in purchase analytics).

    Reuses `_get_or_create_product` / `_build_purchase_chain` from the importer.
    """
    from purchase.models import VendorBill, VendorBillLine
    from sales.tally_import_run import _get_or_create_product, _build_purchase_chain

    if sb.status == 'CONFIRMED':
        return sb
    # Freight-only bill → create a Local Freight record instead of a VendorBill.
    if sb.bill_type == 'FREIGHT':
        return _commit_freight(sb, user)
    if not sb.matched_vendor:
        raise ValueError('No vendor resolved — map the vendor before confirming.')

    # Stock posting is DISABLED for now (per user: scans stay stock-neutral until
    # they say to enable it). The "Update stock" toggle + Warehouse/Godown fields
    # are still shown and SAVED on the scan (sb.update_stock / warehouse / godown),
    # but confirm writes nothing to the stock ledger and doesn't require a location.
    #   To re-enable, change this back to:  post_stock = bool(sb.update_stock)
    post_stock = False

    company = _bill_company(sb)
    ctx = _ctx(company, user)
    vend = sb.matched_vendor
    lines = sb.lines or []

    # Lines the operator marked as "not a product" (freight / packing / other
    # charges). They never reach the item master or the bill lines — only their
    # money does, via the bill's `other_charges`. `additional_charges` keeps the
    # per-charge breakdown ({type,label,amount,add_to_total}) so the bill page
    # can show "Freight charge" / "Other charge" as their own summary rows.
    # A "Round Off" the scanner marked as a charge is NOT a real extra — it's the
    # invoice's rounding, reconciled below into `adjustment`. Dropping it stops a
    # phantom "Other charge · Round Off" and its cancelling round-off line. No LLM call.
    charge_lines = [l for l in lines
                    if l.get('is_charge')
                    and not re.search(r'round\s*-?\s*off|rounding', (l.get('description') or ''), re.I)]
    charge_total = sum((_to_dec(l.get('amount')) for l in charge_lines), Decimal('0'))
    charge_breakdown = [{
        'type': (l.get('charge_type') or 'OTHER').upper(),
        'label': (l.get('description') or '').strip()[:100] or (
            'Freight charge' if (l.get('charge_type') or '').upper() == 'FREIGHT' else 'Other charge'),
        'amount': str(_to_dec(l.get('amount'))),
        'add_to_total': True,
    } for l in charge_lines]

    # Snap the header tax to the LINE GST and book any rounding as one adjustment
    # when the bill is purely goods + GST (total ties subtotal + line GST within a
    # rupee). Fixes a scan that DOUBLED the header tax though each line's GST% was
    # right (Greif: IGST 1,29,600 vs the 18% line's 64,800). Pure arithmetic on the
    # already-scanned lines — no extra LLM call.
    _sub = sb.subtotal or _sum_lines(lines)
    _total = sb.total_amount or ((sb.subtotal or Decimal('0')) + (sb.tax_amount or Decimal('0')))
    _line_gst = sum(
        (_to_dec(l.get('amount')) * _pct(l.get('gst')) / 100
         for l in lines if isinstance(l, dict) and not l.get('is_charge')),
        Decimal('0')).quantize(Decimal('0.01'))
    _tax_amount = sb.tax_amount or Decimal('0')
    _adjustment = Decimal('0')
    if _line_gst > 0 and _total and abs(_total - (_sub + _line_gst)) <= Decimal('2'):
        _tax_amount = _line_gst
        _adjustment = (_total - _sub - _line_gst).quantize(Decimal('0.01'))
        charge_total = Decimal('0')      # pure goods + GST -> no real extra charges
        charge_breakdown = []

    # TDS the scanner read off the invoice ("Less: TDS"), if any.
    _tds_amount = sb.tds_amount or Decimal('0')
    # …but Gemini sometimes MISSES the TDS line (e.g. a labour bill whose net total
    # already has 194C @ 2% removed). Then (subtotal + GST − total) is an unexplained
    # gap that the bill page is forced to show as "Round off". Recover it: if that
    # residual matches a standard TDS rate on the taxable base, it IS the TDS — book
    # it as tds_amount and mark the total net, so it shows on the TDS line (and the
    # double-TDS guard treats the total correctly) instead of a phantom round-off.
    _total_is_net = None
    if _tds_amount <= 0:
        _inferred = infer_tds_from_residual(_sub, _tax_amount, _total, already_tds=_tds_amount)
        if _inferred > 0:
            _tds_amount = _inferred
            _total_is_net = True

    bill = sb.matched_bill
    if bill is None:
        # Duplicate guard: a real duplicate is the SAME VENDOR billing the same
        # invoice number twice. Two different vendors both numbering an invoice
        # "3/2026-2027" is ordinary — small suppliers restart at 1 every year —
        # and must not be blocked.
        inv = (sb.invoice_no or '').strip()
        bill_no = None
        # Robust cross-channel duplicate guard (any door: Tally/Zoho/scan/manual).
        # The old check caught only the SAME vendor master + EXACT invoice no, so a
        # copy that arrived earlier under a different spelling, a rounded amount or
        # a day-shifted date slipped through and became a second bill. The shared
        # detector looks past all of those (same firm, ±tolerance, TDS gross/net).
        from purchase.zoho_mismatch import find_existing_bill
        dup = find_existing_bill(vend, inv, sb.total_amount, sb.invoice_date) if not ignore_duplicate else None
        if dup is not None:
            raise DuplicateBillError(
                f'{vend.vendor_name} already has a bill ({dup.bill_no}) with the same '
                f'invoice / amount / date.',
                bill=dup)
        if inv:
            # `bill_no` is globally unique and VendorBill.save() defaults it to
            # the vendor's own invoice number, so ANOTHER vendor already holding
            # that number would crash the insert. Keep the natural number when
            # it's free; otherwise disambiguate with a suffix ("3/2026-2027-2")
            # so it stays recognisable. vendor_invoice_no keeps the true number
            # untouched either way.
            bill_no = inv[:50]
            n = 1
            while VendorBill.objects.filter(bill_no__iexact=bill_no).exists():
                n += 1
                suffix = f'-{n}'
                bill_no = f'{inv[:50 - len(suffix)]}{suffix}'
        # Cut-over: scan owns dates ON/AFTER 1 Oct only. A scanned invoice dated
        # before the cut-over belongs to Tally — refuse it so the two sources can
        # never duplicate a pre-Oct bill again. (No date → defaults to today → ok.)
        from purchase.cutover import assert_scan_allowed
        assert_scan_allowed(sb.invoice_date)
        # Unmatched → create a new bill from the scanned header.
        # Charge lines (operator turned "Product?" off — freight, packing, …)
        # are NOT purchases. `subtotal` stays FULL (charges included) and the
        # amount is ALSO recorded in `other_charges`: the purchase dashboard
        # nets `subtotal - other_charges` itself, because Tally books freight
        # outside Purchase Accounts. Subtracting it here too would double-count.
        bill = VendorBill.objects.create(
            vendor=vend,
            bill_no=bill_no or '',      # '' only when the scan carried no invoice no
            vendor_invoice_no=(sb.invoice_no or '')[:100],
            marketplace_order_no=(sb.marketplace_order_no or '')[:80],
            bill_date=sb.invoice_date or timezone.now().date(),
            due_date=_due_date_for(sb, vend, sb.invoice_date or timezone.now().date()),
            # Land in the Bills screen as DRAFT so it still gets a final look
            # before it's an open payable (matches the Email Bill Inbox).
            status='DRAFT',
            subtotal=_sub,
            other_charges=charge_total,
            additional_charges=charge_breakdown or None,
            tax_amount=_tax_amount,
            tds_amount=_tds_amount,
            adjustment=_adjustment,
            total_amount=_total,
            total_is_net=_total_is_net,
            warehouse=sb.warehouse,   # bill-level tag picked in review (carries on)
            notes='Created from scanned invoice',
            created_by=user,
        )
        sb.created_bill = bill
    else:
        existing = bill.bill_lines.filter(is_active=True).count()
        if existing and not replace:
            raise ValueError(f'Bill {bill.bill_no} already has {existing} line(s). '
                             'Re-confirm with replace=true to overwrite.')
        if existing and replace:
            bill.bill_lines.all().delete()
        # Merging onto a bill that came from Tally: record the charges, but
        # leave its subtotal alone — Tally already booked the split its own way.
        if charge_total:
            bill.other_charges = charge_total
            bill.additional_charges = charge_breakdown or None
            bill.save(update_fields=['other_charges', 'additional_charges'])
        # Record a TDS the scan read, but only if the bill doesn't already carry
        # one (don't clobber a value Tally booked).
        if sb.tds_amount and not bill.tds_amount:
            bill.tds_amount = sb.tds_amount
            bill.save(update_fields=['tds_amount'])
        # Stamp the warehouse picked in review onto the bill if it has none yet.
        if sb.warehouse_id and not bill.warehouse_id:
            bill.warehouse_id = sb.warehouse_id
            bill.save(update_fields=['warehouse'])

    line_batches = {}   # VendorBillLine.id -> batch read off the scan (for stock posting)
    for l in lines:
        if l.get('is_charge'):
            continue      # money already folded into other_charges above
        pid = l.get('product_id')
        prod = None
        if pid:
            from master.models import Product
            prod = Product.objects.filter(pk=pid).first()
        if prod is None and l.get('description'):
            # Use the EDITED master name if the operator set one; else the scanned
            # description. The bill line keeps the vendor's exact text (below).
            master_name = _englishify_name(
                (l.get('product_name') or '').strip() or _concise_product_name(l.get('description') or ''))
            prod = _get_or_create_product(master_name, l.get('uom') or '', ctx)
        vbl = VendorBillLine.objects.create(
            bill=bill, product=prod,
            description=(l.get('description') or '')[:2000],
            quantity=_to_dec(l.get('qty'), '1'), uom=(_englishify_uom(l.get('uom')) or '')[:10],
            rate=_to_dec(l.get('rate')), amount=_to_dec(l.get('amount')),
            discount_percent=_pct(l.get('discount')), tax_percent=_pct(l.get('gst')),
        )
        # Carry the scanned batch/lot so stock posting (when enabled) lands it on
        # the ledger instead of blank — the AI already reads it per line.
        if l.get('batch'):
            line_batches[vbl.id] = str(l.get('batch'))[:50]
        # Remember item name -> ERP product so future scans/imports auto-map it.
        # Only when the operator left "remember" ticked at confirm time.
        if remember and prod is not None:
            _remember_map(company, l.get('description'), product=prod)

    # Remember vendor name -> ERP vendor for future auto-matching (opt-out).
    if remember:
        _remember_map(company, sb.vendor_name, vendor=vend)
        # Learn this vendor's GSTIN from the e-invoice so FUTURE bills auto-match
        # by GSTIN (the unambiguous signal) instead of needing a manual remap each
        # time — which is what left recurring vendors (e.g. the several "Kumaran
        # Traders" masters) unmapped, so the duplicate/merge check never ran. Only
        # when this master has no GSTIN yet AND no sibling in the company already
        # carries it (keeps one master per GSTIN, so the match stays unambiguous).
        g = (sb.vendor_gstin or '').strip().upper()
        if vend is not None and len(g) == 15 and not (getattr(vend, 'gstin', '') or '').strip():
            from master.models import Vendor
            if not (Vendor.objects.filter(company=vend.company, gstin__iexact=g)
                    .exclude(pk=vend.pk).exists()):
                vend.gstin = g
                vend.save(update_fields=['gstin'])

    # Merging into a matched Tally bill: the scanned copy IS the physical
    # invoice, so its date wins. The Tally bill was created with the voucher
    # date (often the payment/entry date); stamp the real invoice date so the
    # one surviving bill shows the correct date. Payment (folded in from Tally)
    # keeps its own date separately.
    if sb.matched_bill is not None and sb.invoice_date and bill.bill_date != sb.invoice_date:
        bill.bill_date = sb.invoice_date
        bill.save(update_fields=['bill_date'])
    # Fill the due date on a merged (existing) bill too, when it carries none.
    if sb.matched_bill is not None and bill.due_date is None:
        due = _due_date_for(sb, bill.vendor, bill.bill_date or sb.invoice_date)
        if due:
            bill.due_date = due
            bill.save(update_fields=['due_date'])

    # Operator-picked Tally voucher type -> tag the bill so it reconciles under
    # the right type (GST Purchase / Bought Note / …) instead of "(no type)".
    # Only set it when the bill has none — never override a type Tally supplied.
    if (sb.voucher_type or '').strip() and not (bill.tally_voucher_type or '').strip():
        bill.tally_voucher_type = sb.voucher_type.strip()[:100]
        bill.save(update_fields=['tally_voucher_type'])

    # An operator pick of any JOURNAL voucher type ("Journal", "GST Journal",
    # "GST - Journal", …) means this is an EXPENSE (rent, professional, freight/
    # contract) — flag it so it lands under the Bills "Expenses" tab, EVEN when
    # matched to a Tally "GST Purchase" bill (whose tally_voucher_type above we
    # must not overwrite). Match on "contains 'journal'" to catch every spelling.
    vt_pick = (sb.voucher_type or '').strip().lower()
    if vt_pick:
        want_expense = 'journal' in vt_pick
        if bill.is_expense != want_expense:
            bill.is_expense = want_expense
            bill.save(update_fields=['is_expense'])

    # Link any already-imported TDS (from Tally's TDS Payable) to this bill right
    # now, so the operator does NOT have to re-import Tally just to see the
    # deduction. Same vendor + bill ref. No-op if the TDS isn't imported yet — a
    # later import will link it from the other side.
    try:
        from purchase.tds_payable_import import link_bill_to_tds
        link_bill_to_tds(bill)
    except Exception:  # noqa: BLE001 — linking is best-effort, never block a confirm
        logger.exception("TDS auto-link failed for bill %s", getattr(bill, "id", "?"))

    # GST split: same-state (vendor's GSTIN state == company's) -> CGST + SGST
    # (each half); different state -> IGST. Derived from the combined tax_amount.
    from decimal import Decimal as _D

    def _state(g):
        g = (g or '').strip()
        return g[:2] if len(g) >= 2 and g[:2].isdigit() else ''

    tax = bill.tax_amount or _D('0')
    if tax:
        comp_gstin = getattr(getattr(sb.batch, 'company', None), 'gstin', '') if sb.batch_id else ''
        vend_gstin = sb.vendor_gstin or (getattr(vend, 'gstin', '') if vend else '')
        cs, vs = _state(comp_gstin), _state(vend_gstin)
        interstate = bool(cs and vs and cs != vs)
        if interstate:
            bill.igst_amount, bill.cgst_amount, bill.sgst_amount = tax, _D('0'), _D('0')
        else:
            half = (tax / 2).quantize(_D('0.01'))
            bill.cgst_amount, bill.sgst_amount, bill.igst_amount = half, tax - half, _D('0')
        bill.save(update_fields=['cgst_amount', 'sgst_amount', 'igst_amount'])

    # Attach the scanned invoice to the bill (traceability).
    _attach_scan_to_bill(bill, sb.document, sb, user)

    # Scan-confirmed bills do NOT get an auto-created PO/GRN (per operator
    # request — scans should only ever write a bill, nothing else). This is
    # safe for company scoping: every dashboard/analytics query that filters
    # bills by company already falls back to `vendor__company` when there's
    # no purchase_order/receipt_advice (see purchase/dashboard_views.py), and
    # every vendor has a mandatory company, so a PO-less bill still shows up
    # correctly everywhere.
    #
    # The one thing an auto-built PO/GRN chain still exists for is giving
    # `_post_scan_stock` a receipt to post quantities against — stock posting
    # is disabled for scans right now (post_stock is always False), so that
    # need doesn't currently apply. If stock posting for scans is ever turned
    # back on, build the chain here, gated on post_stock.
    if bill.receipt_advice_id is None and post_stock:
        _build_purchase_chain(
            None, bill, vend,
            _tally_shape([l for l in lines if not l.get('is_charge')]), ctx,
            warehouse=sb.warehouse, godown=sb.godown,
        )

    # Post the received goods to the stock ledger (new bills and merges alike).
    # On a replace (overwrite of existing lines), old stock is reversed first.
    if post_stock:
        _post_scan_stock(bill, sb.warehouse, sb.godown, user, replace=replace, batches=line_batches)

    # Category: the operator's manual pick WINS (written straight to the bill);
    # only fall back to the auto-classifier when they left it blank. Best-effort;
    # never blocks a confirm. (See purchase.bill_classification.)
    if (sb.category or '').strip():
        bill.purchase_category = sb.category.strip()
        bill.category_source = 'manual'
        bill.save(update_fields=['purchase_category', 'category_source'])
    else:
        try:
            from purchase.bill_classification import classify_and_save_bill
            classify_and_save_bill(bill)
        except Exception:  # noqa: BLE001 — classification is best-effort
            logger.exception("Category auto-classify failed for bill %s", getattr(bill, "id", "?"))

    # Stop the half-CGST/SGST line Tax% bug at the source: if a line carries a
    # 2.5/6/9/14 while the header already holds the full combined tax, double it.
    _fix_half_component_tax(bill)
    # Keep loading/packing charges OUT of the item price: move any amount folded
    # over rate*qty into a separate taxable 'Loading & Unloading' line.
    _split_folded_charges(bill)

    # Mirror any freight line on the bill into the freight tracker
    # (invoice-included). Best-effort; never blocks a confirm.
    try:
        from purchase.invoice_freight import sync_invoice_freight
        sync_invoice_freight(bill, user)
    except Exception:  # noqa: BLE001
        logger.exception("invoice-freight sync failed for bill %s", getattr(bill, "id", "?"))

    # Link this goods bill to an EXISTING shared freight (one slip covering several
    # bills), if the reviewer chose one — adds it to that freight's covered_bills.
    if sb.link_freight_id and bill is not None:
        try:
            sb.link_freight.covered_bills.add(bill)
        except Exception:  # noqa: BLE001
            logger.exception('scan: link-to-existing-freight failed for %s', getattr(sb, 'pk', None))

    sb.status = 'CONFIRMED'
    sb.committed_at = timezone.now()
    sb.save(update_fields=['status', 'created_bill', 'committed_at'])
    return sb


def revert_scan_bill(sb, user):
    """Undo everything `commit_scan_bill` / `_commit_freight` did for this
    scan — the operator's safety net for a confirm made by mistake.

    Three cases, mirroring the three things confirm can create:
    - Freight (Local/Inward): delete the freight record.
    - New bill (`created_bill` set): this scan is the SOLE owner of that
      bill — nothing else could reference it yet, so it's safe to fully
      delete: stock first, then the reconstructed PO/GRN chain, then the
      bill itself (cascades its lines).
    - Merged onto an existing bill (`matched_bill` set, no `created_bill`):
      that bill pre-existed (e.g. imported from Tally) and may carry data
      beyond this scan, so the bill itself is NEVER deleted here — only the
      stock this scan posted and the item lines it wrote are removed,
      returning the bill to its pre-confirm (item-less) state.

    Stock is unposted FIRST and is the one step that can refuse: if a
    downstream document already consumed it, `unpost_scan_stock` raises and
    nothing else is torn down — same as it already does for the standalone
    "Undo stock" action.
    """
    if sb.status != 'CONFIRMED':
        raise ValueError('Only a confirmed scan can be reverted.')

    if sb.created_local_freight_id or sb.created_freight_advice_id:
        if sb.created_local_freight_id:
            sb.created_local_freight.delete()
            sb.created_local_freight = None
        if sb.created_freight_advice_id:
            sb.created_freight_advice.delete()
            sb.created_freight_advice = None
        sb.status = 'EXTRACTED'
        sb.committed_at = None
        sb.save(update_fields=['created_local_freight', 'created_freight_advice',
                               'status', 'committed_at'])
        return sb

    # Freight attached to a goods bill: remove only the freight attachment this
    # scan added — NEVER touch that goods bill.
    if sb.bill_type == 'FREIGHT' and sb.freight_linked_bill_id:
        try:
            from purchase.models import PurchaseAttachment
            name = (sb.document.original_name or '')[:255]
            if name:
                PurchaseAttachment.objects.filter(
                    module='BILL', record_id=sb.freight_linked_bill_id, file_name=name).delete()
        except Exception:  # noqa: BLE001
            logger.exception('freight-attach revert cleanup failed for scan %s', getattr(sb, 'pk', None))
        sb.status = 'EXTRACTED'
        sb.committed_at = None
        sb.save(update_fields=['status', 'committed_at'])
        return sb

    bill = sb.created_bill or sb.matched_bill
    if bill is None:
        sb.status = 'EXTRACTED'
        sb.committed_at = None
        sb.save(update_fields=['status', 'committed_at'])
        return sb

    if scan_stock_posted(bill):
        unpost_scan_stock(bill, user)   # raises if already consumed downstream

    if sb.created_bill_id:
        po, grn = bill.purchase_order, bill.receipt_advice
        bill.delete()          # cascades VendorBillLine
        if grn is not None:
            grn.delete()        # cascades ReceiptLine
        if po is not None:
            po.delete()          # cascades POLine
        sb.created_bill = None
    else:
        # Merge case — the bill stays; only the lines THIS scan wrote go.
        bill.bill_lines.filter(is_active=True).delete()

    sb.committed_at = None
    sb.save(update_fields=['created_bill', 'committed_at'])
    match_scan_bill(sb)   # re-derive matched_bill/status from current DB state
    return sb

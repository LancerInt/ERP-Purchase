"""Gemini-based document extractor for Purchase → Quote Response Auto-Fill.

Uses ``gemini-2.5-flash`` (full Flash, not Lite) as the primary model — vendor
quote PDFs include tables, photos, GST footers and handwritten rates, and the
Lite model was returning too many partial extractions. Lite still serves as
the cheap-fast option for receipts / weighbridge slips elsewhere.

``genai.upload_file(path=...)`` via a temp file, no ``generation_config``
constraints, and a prompt that asks for plain-text labelled output. We then
run a tiny regex/heuristic pass to convert that text into the JSON schema the
Quote Response form expects.

Reads ``GEMINI_API_KEY`` from environment. Model overrides:
  - ``GEMINI_QUOTE_PRIMARY_MODEL``  (quote-specific primary; default ``gemini-2.5-flash``)
  - ``GEMINI_QUOTE_FALLBACK_MODEL`` (quote-specific fallback; default ``gemini-2.5-pro``)
  - ``GEMINI_PRIMARY_MODEL`` / ``GEMINI_FALLBACK_MODEL`` (generic for all extractors)

Response contract (flat top-level):
{
  "rfq_no":           "...",
  "vendor_name":      "...",
  "quote_date":       "YYYY-MM-DD",
  "price_valid_till": "YYYY-MM-DD",
  "currency":         "INR",
  "payment_terms":    "Net 30 days",
  "lead_time_days":   "7-10 days from PO",
  "delivery_terms":   "...",
  "freight_terms":    "...",
  "remarks":          "...",
  "items": [{ product_name, product_code, description, quantity, uom,
              rate, discount, tax, amount, delivery_date, remarks }],
  "extraction_status": "success" | "partial" | "failed",
  "missing_fields":    [],
  "model_used":        "gemini-2.5-flash",
  "attempts":          [{ model, status, response_preview, ... }],
  "warnings":          [],
  "raw_response":      "...the model's plain-text output, for diagnostics..."
}
"""

from __future__ import annotations

import logging
import mimetypes
import os
import re
import tempfile
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple
from common.ai_log import generate_logged

logger = logging.getLogger(__name__)


# ─── Schema ────────────────────────────────────────────────────────────────
HEADER_FIELDS: List[str] = [
    'rfq_no',
    'vendor_name',
    'quote_date',
    'price_valid_till',
    'currency',
    'payment_terms',
    'lead_time_days',
    'delivery_terms',
    'freight_terms',
    'gst_percentage',
    'remarks',
]
LINE_FIELDS: List[str] = [
    'product_name',
    'product_code',
    'description',
    'quantity',
    'uom',
    'rate',
    'discount',
    'tax',
    'amount',
    'delivery_date',
    'remarks',
]
REQUIRED_FIELDS: List[str] = ['vendor_name', 'quote_date']


# Same prompt style as the user's working script — ask for plain text first,
# then we transform the result to our JSON. This avoids JSON-mode quirks.
EXTRACTION_PROMPT = """Read this vendor quotation / RFQ response document
carefully and extract EVERY field that is present. Do not assume a fixed
schema — capture whatever the document actually contains.

Output format (plain text, NO markdown, NO code fences, NO commentary):

=== HEADER FIELDS ===
<Every label/value pair found at the top of the document, one per line.>
Example:
RFQ No: RFQ-2026-0003
Quotation Date: 23-03-2026
Vendor: 3F Industries
Vendor Email: ...
Payment Terms: Net 30 days
Delivery: 7-10 days from PO
Validity: 30 days
Currency: INR
GST: 18%
(include any other header field you find)

=== LINE ITEMS ===
<For each PRODUCT row in the items table, output one block. Include every
column the table has. Use the column header label exactly as printed when
in doubt about which slot a value belongs in.>
Example:
Item 1:
  Product: Anandham 40 kg
  SKU: STP-24155
  Quantity: 110
  UOM: KG
  Rate: 500
  Amount: 55000
  GST: 18%
  (any other column the table has)

=== TOTALS ===
<Subtotal, GST, Grand Total, Amount in Words — every total/summary on the document>

=== OTHER ===
<Anything else: bank details, terms & conditions, notes>

CRITICAL RULES FOR THE ITEMS TABLE:
- A product name that wraps across 2+ lines (description spilling into
  the next line of the same row) MUST be joined into a single Product
  value. Use a single space between the wrapped parts. Do NOT emit
  separate "Item N" blocks for the same product.
- DO NOT include subtotal / total / "Grand Total" / "Round Off" /
  "Amount in Words" rows as Item blocks — those belong under === TOTALS ===.
- If the row has SKU/Code embedded inside the Product cell like
  "Amino Acid Powder (RMNM00127)", extract the code into the SKU slot
  AND remove the parenthesised code from the Product value.
- Numeric columns (Quantity, Rate, Amount, GST, Discount) must be plain
  numbers — no commas, no currency symbols, no "kg" suffix in the value.
- If the table uses a separate UOM column, put just the unit (KG, LTR,
  NOS, PCS) in the UOM slot; do NOT repeat it inside the Quantity slot.
- If Rate is missing but Amount and Quantity are present, leave Rate
  blank (do NOT compute it) — the back-end will derive it.
- If GST/Tax is printed once at the bottom of the table (e.g. "GST: 18%
  extra"), still place it under === HEADER FIELDS === as `GST: 18%` so
  every line item picks it up.

GST PERCENTAGE — DO NOT CONFUSE WITH GSTIN (important):
- GST percentage is a TAX RATE — always a small number followed by `%`,
  with India-only allowed values: 0, 5, 12, 18, 28. Sometimes printed
  as "GST 18%", "GST @ 18%", "IGST 18%", "CGST 9% + SGST 9%", "Tax 18%".
- A GSTIN is a 15-character alphanumeric tax-registration ID — looks like
  `33AABFU0310L1ZM` (2-digit state code + 10-char PAN + 3-char suffix).
  The FIRST TWO DIGITS of a GSTIN are the state code (33 = Tamil Nadu,
  27 = Maharashtra, etc.) — NOT a GST percentage.
- NEVER extract the first two digits of a GSTIN as `GST`. If the only
  GST-looking value on the page is part of a GSTIN (e.g. "GST NO
  33AABFU0310L1ZM", "GSTIN: 27ABCDE1234F1Z5"), leave GST blank.
- Treat labels like "GST No", "GSTIN", "GST Reg", "Tax No", "PAN",
  "TAN" as identity numbers and IGNORE them for the GST percentage
  field — they are NEVER tax rates.

GENERAL RULES:
- Extract every visible field. Do not skip a field just because it doesn't fit a slot.
- Do not invent fields. No "N/A" placeholders for fields not on the document.
- Monetary values as plain numbers (no commas, no currency symbols).
- Return ONLY the formatted text above.

VENDOR vs BROKER (important):
- The Vendor is the company/firm actually SUPPLYING the goods or services
  (manufacturer, producer, exporter, trading company). Their name usually
  appears in the letterhead, "From:" block, signature block, or under
  "Supplier" / "Seller" / "Manufacturer".
- A Broker / Agent / Commission Agent is an INTERMEDIARY who quotes on
  behalf of a vendor. Broker info usually appears with explicit labels
  like "Broker Name", "Agent", "Commission Agent", "Broker Email",
  "Broker Cell", "Broker Address".
- NEVER put a broker's name in the Vendor slot. If the document is
  from a broker and the vendor is named anywhere (e.g. in the body,
  signature, GSTIN section, bank-details block, or product listing
  header like "Material from XYZ Industries"), use THAT name for
  Vendor.
- If the document is from a broker and no vendor is identifiable,
  leave the Vendor field blank — do NOT fall back to the broker's
  name. Emit broker info under its own labels so the back-end can
  capture it separately:
    Broker Name: <name>
    Broker Company: <firm, if separate from name>
    Broker Email: <email>
    Broker Cell: <phone>
"""


# ─── Helpers ────────────────────────────────────────────────────────────────

def _guess_mime(filename: str) -> str:
    ext = (filename.rsplit('.', 1)[-1] or '').lower()
    by_ext = {
        'pdf': 'application/pdf',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'webp': 'image/webp',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xls': 'application/vnd.ms-excel',
        'csv': 'text/csv',
        'txt': 'text/plain',
    }
    return by_ext.get(ext) or mimetypes.guess_type(filename)[0] or 'application/octet-stream'


def _coerce_number(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        return None
    cleaned = re.sub(r'[^\d.\-]', '', s.replace(',', ''))
    try:
        return float(cleaned) if cleaned not in ('', '-', '.', '-.') else None
    except (TypeError, ValueError):
        return None


# Detect commodity-trade range strings ("150 / 155", "150 to 155",
# "150-155 MT", "150~155") so the importer doesn't concatenate the two
# numbers into 150155 when running them through _coerce_number. We take
# the FIRST value because it's the lower bound / committed quantity in
# standard Indian commodity-broker contracts ("supply 150 MT minimum,
# up to 155 MT"). The operator can adjust on the form if they want the
# upper bound or midpoint.
_RANGE_PATTERN = re.compile(
    r'^\s*(\d+(?:\.\d+)?)\s*[/~\-]\s*(\d+(?:\.\d+)?)\s*(?:[A-Za-z./]+)?\s*$'
)


def _coerce_quantity(v: Any) -> Optional[float]:
    """Quantity-aware coercion. Handles range strings like '150 / 155'
    by picking the first number; otherwise falls through to the
    generic _coerce_number which strips units / commas / currency."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        return None
    m = _RANGE_PATTERN.match(s)
    if m:
        try:
            return float(m.group(1))
        except (TypeError, ValueError):
            pass
    # Also catch "150 to 155 MT" style (word separator, harder regex).
    word_range = re.match(
        r'^\s*(\d+(?:\.\d+)?)\s+(?:to|TO|To|or|OR|Or)\s+\d+(?:\.\d+)?\s*(?:[A-Za-z./]+)?\s*$',
        s,
    )
    if word_range:
        try:
            return float(word_range.group(1))
        except (TypeError, ValueError):
            pass
    return _coerce_number(v)


_DATE_FORMATS = [
    '%Y-%m-%d',
    # Indian / European convention (day first) — both 4- and 2-digit year.
    # Real vendor PDFs use 2-digit year often enough ("02/04/26", "1-3-26",
    # "22.11.25") that leaving them unparsed is the most common cause of
    # the "could not be parsed" warning. strptime maps 2-digit years
    # 00-68 → 20xx and 69-99 → 19xx, which matches Indian fiscal practice.
    '%d-%m-%Y', '%d/%m/%Y', '%d.%m.%Y',
    '%d-%m-%y', '%d/%m/%y', '%d.%m.%y',
    # Month-name variants (Mar/March etc.).
    '%d-%b-%Y', '%d-%B-%Y',
    '%d %b %Y', '%d %B %Y',
    '%b %d, %Y', '%B %d, %Y',
    '%d-%b-%y', '%d-%B-%y',
    # US convention (month first) — last because it conflicts with
    # %d/%m/%Y for 1/2-1/12 / 1-12 (e.g. "03/04/2026" is read as Apr 3
    # by Indian convention, Mar 4 by US). Listing day-first first
    # matches the dominant locale for this codebase.
    '%m/%d/%Y',
]


# When multiple date labels are present on the same vendor doc, the
# parser picks the one with the LOWEST priority number. Lower = more
# specific / more authoritative. Labels not in this dict default to
# 99 so any explicit alias above will win over an un-prioritised one.
#
# Keep in sync with the quote_date label list in LABEL_TO_FIELD below.
QUOTE_DATE_LABEL_PRIORITY: Dict[str, int] = {
    'vendor quote date': 1,
    'quotation submission date': 2,
    'rfq response date': 3,
    'offer date': 4,
    'proposal date': 5,
    'price offer date': 6,
    'bid date': 7,
    'submission date': 8,
    'commercial offer date': 9,
    # Generic / legacy labels share priority 10 — last-seen wins among
    # these, which matches the historic behaviour.
    'quotation date': 10,
    'quote date': 10,
    'document date': 10,
    'issued on': 10,
    'dated': 10,
    'date': 10,
}


# When multiple price/rate labels appear on the same line item, pick
# the one with the LOWEST priority number (most authoritative).
# Quote-specific labels ("Quoted Rate", "Offer Price") outrank
# vendor-cost labels ("Purchase Rate") which outrank generic ones
# ("Rate", "Price"). Order copied verbatim from the user spec.
LINE_RATE_LABEL_PRIORITY: Dict[str, int] = {
    'quoted rate': 1,
    'offer price': 2,
    'purchase rate': 3,
    'unit price': 4,
    'price per unit': 5,
    'per unit rate': 6,
    'item rate': 7,
    'product rate': 8,
    'material rate': 9,
    'basic rate': 10,
    'commercial rate': 11,
    'bid price': 12,
    'unit cost': 13,
    'cost per unit': 14,
    'unit value': 15,
    'item price': 16,
    'cost price': 17,
    'unit amount': 18,
    'selling price': 19,
    'rate': 20,
    'price': 21,
}


def _line_rate_priority_for(norm_label: str) -> int:
    """Same longest-whole-word-match rule as `_match_label`, but
    returns the LINE_RATE_LABEL_PRIORITY entry rather than the field
    name. Used by the line-item parser to pick between competing
    price labels on the same item.
    """
    best_key = ''
    best_pri = 99
    for key, pri in LINE_RATE_LABEL_PRIORITY.items():
        if re.search(rf'\b{re.escape(key)}\b', norm_label) and len(key) > len(best_key):
            best_key = key
            best_pri = pri
    return best_pri


def _quote_date_priority_for(norm_label: str) -> int:
    """Return the QUOTE_DATE_LABEL_PRIORITY entry that matches the
    normalised label, or 99 if no priority is assigned for this alias.
    Uses the same longest-whole-word-match rule as `_match_label` so the
    priority lookup is consistent with which alias actually matched.
    """
    best_key = ''
    best_pri = 99
    for key, pri in QUOTE_DATE_LABEL_PRIORITY.items():
        if re.search(rf'\b{re.escape(key)}\b', norm_label) and len(key) > len(best_key):
            best_key = key
            best_pri = pri
    return best_pri


def _coerce_date(v: Any) -> str:
    if not v:
        return ''
    s = str(v).strip()
    if not s:
        return ''
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', s):
        return s
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    # Try the leading date if the string carries trailing text.
    m = re.match(r'(\d{1,2}[-/.\s]\w{2,9}[-/.\s]\d{2,4}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})', s)
    if m:
        for fmt in _DATE_FORMATS:
            try:
                return datetime.strptime(m.group(1), fmt).date().isoformat()
            except ValueError:
                continue
    return ''


# Label → schema field. Match on a normalised lower-cased label, allowing
# partial / fuzzy matches via "contains" on substring.
LABEL_TO_FIELD: List[Tuple[List[str], str]] = [
    (['rfq no', 'rfq#', 'rfq number', 'against rfq', 'rfq reference', 'inquiry no', 'reference no', 'your ref', 'tender no'], 'rfq_no'),
    # Broker / agent labels intentionally route to a SEPARATE sink so a
    # broker's name doesn't silently become the vendor. The Quote
    # response doesn't surface `broker_name` (it's not in HEADER_FIELDS),
    # so this row effectively drops broker info on the floor — better
    # than mis-filling vendor with a broker name. If we later want to
    # show the broker on the form, add 'broker_name' to HEADER_FIELDS.
    #
    # Listed BEFORE vendor_name so the longest-match rule prefers a
    # specific "Broker Name" / "Agent Name" over a generic "Name".
    (['broker', 'broker name', 'broker company', 'agent', 'agent name',
      'commission agent', 'broker firm', 'agency'], 'broker_name'),
    (['vendor', 'supplier', 'quoted by', 'from', 'company', 'issued by', 'seller', 'manufacturer'], 'vendor_name'),
    # Vendor quote dates appear under wildly varying labels in real
    # vendor PDFs — "Vendor Quote Date", "Offer Date", "Proposal Date",
    # "Submission Date", etc. all mean the same thing. Keep this list
    # comprehensive so the field doesn't silently miss.
    #
    # When MULTIPLE date labels appear on the same document (rare but
    # possible — e.g. both "Vendor Quote Date" and a generic "Date"),
    # QUOTE_DATE_LABEL_PRIORITY below picks the most specific one.
    (['vendor quote date', 'quotation submission date', 'rfq response date',
      'offer date', 'proposal date', 'price offer date', 'bid date',
      'submission date', 'commercial offer date',
      'quotation date', 'quote date', 'document date', 'issued on',
      'dated', 'date'], 'quote_date'),
    (['price valid till', 'validity', 'valid until', 'valid till', 'valid for', 'expiry', 'offer valid'], 'price_valid_till'),
    (['currency'], 'currency'),
    (['payment terms', 'payment', 'credit period', 'terms'], 'payment_terms'),
    (['lead time', 'delivery period', 'eta', 'shipping time', 'dispatch'], 'lead_time_days'),
    (['delivery terms', 'shipping terms', 'incoterms', 'delivery'], 'delivery_terms'),
    (['freight terms', 'freight', 'transport'], 'freight_terms'),
    (['gst', 'gst percentage', 'gst rate', 'tax', 'tax rate', 'tax percentage',
      'cgst', 'sgst', 'igst', 'vat', 'gst extra', 'gst at'], 'gst_percentage'),
    (['remarks', 'notes', 'comments', 'special instructions'], 'remarks'),
]
LINE_LABEL_TO_FIELD: List[Tuple[List[str], str]] = [
    (['product', 'item', 'description', 'material', 'goods', 'particulars'], 'product_name'),
    (['sku', 'part no', 'part number', 'item code', 'product code', 'code', 'model', 'catalogue no', 'article'], 'product_code'),
    (['quantity', 'qty', 'nos', 'pcs'], 'quantity'),
    (['uom', 'unit', 'units', 'per'], 'uom'),
    # Vendor docs label per-unit price under wildly different headers
    # depending on industry / template — "Rate", "Unit Price",
    # "Quoted Rate", "Material Rate", "Per Unit Rate", etc. Keep this
    # list comprehensive so the field doesn't silently miss.
    #
    # When multiple price columns appear on the same line item (rare
    # but possible — e.g. "Unit Price" plus "Quoted Rate"), the
    # LINE_RATE_LABEL_PRIORITY dict below picks the most authoritative
    # one (Quoted/Offer/Purchase Rate > generic Rate/Price).
    (['rate', 'unit price', 'unit rate', 'unit cost', 'price', 'price per unit',
      'per unit', 'per unit rate', 'per piece', 'per kg', 'per ltr', 'cost',
      'cost per unit', 'list price', 'sell price', 'selling price',
      'offered price', 'mrp', 'unit value', 'unit amount',
      'item rate', 'item price', 'product rate', 'purchase rate',
      'material rate', 'basic rate', 'cost price', 'quoted rate',
      'offer price', 'bid price', 'commercial rate'], 'rate'),
    (['discount', 'disc', 'rebate', 'less'], 'discount'),
    (['gst', 'tax', 'vat', 'cgst', 'sgst', 'igst'], 'tax'),
    (['amount', 'total', 'total amount', 'line total', 'line amount', 'gross amount',
      'net amount', 'net value', 'total value', 'subtotal', 'extended price',
      'extended amount', 'total price', 'value'], 'amount'),
    (['delivery date'], 'delivery_date'),
    (['remarks', 'notes'], 'remarks'),
]


def _match_label(label: str, table: List[Tuple[List[str], str]]) -> str:
    """Return the schema field name for a label, or '' if no match.

    Matching prefers the LONGEST whole-word key match, so a label like
    'Unit Price (INR)' routes to `rate` (via 'unit price', 10 chars) instead
    of `uom` (via 'unit', 4 chars).
    """
    norm = re.sub(r'[^\w\s]', ' ', label.lower()).strip()
    norm = re.sub(r'\s+', ' ', norm)
    if not norm:
        return ''
    # Exact match wins outright.
    for keys, field in table:
        if norm in keys:
            return field
    # Otherwise, scan every key in every row and keep the longest whole-word
    # hit. Whole-word so 'unit' doesn't half-match inside 'units'; longest so
    # multi-word keys ('unit price') beat their single-word prefixes ('unit').
    best_key = ''
    best_field = ''
    for keys, field in table:
        for k in keys:
            if not k:
                continue
            if re.search(rf'\b{re.escape(k)}\b', norm) and len(k) > len(best_key):
                best_key = k
                best_field = field
    return best_field


def _split_sections(text: str) -> Dict[str, str]:
    """Split the model's output into the labeled sections we asked for."""
    sections: Dict[str, str] = {}
    current = None
    buf: List[str] = []
    for line in text.splitlines():
        m = re.match(r'^\s*===\s*(.+?)\s*===\s*$', line)
        if m:
            if current is not None:
                sections[current] = '\n'.join(buf).strip()
            current = m.group(1).strip().upper()
            buf = []
        else:
            if current is None:
                # Lines before any section — treat as HEADER FIELDS fallback.
                current = 'HEADER FIELDS'
                buf = []
            buf.append(line)
    if current is not None:
        sections[current] = '\n'.join(buf).strip()
    return sections


def _parse_label_value_block(block: str) -> List[Tuple[str, str]]:
    """Parse 'Label: value' lines from a block, ignoring indentation."""
    pairs: List[Tuple[str, str]] = []
    for raw_line in block.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m = re.match(r'^([^:]{1,80}?)\s*:\s*(.+)$', line)
        if m:
            pairs.append((m.group(1).strip(), m.group(2).strip()))
    return pairs


def _parse_items_block(block: str) -> List[Dict[str, Any]]:
    """Parse the LINE ITEMS section. Each item starts with 'Item N:' or a
    blank line separating it from the previous item, then has indented
    label:value lines."""
    items: List[Dict[str, Any]] = []
    if not block.strip():
        return items

    # Split on "Item N:" markers or blank-line gaps.
    blocks: List[str] = []
    cur: List[str] = []
    for line in block.splitlines():
        if re.match(r'^\s*Item\s+\d+\s*:\s*$', line, re.IGNORECASE):
            if cur:
                blocks.append('\n'.join(cur).strip())
                cur = []
        elif not line.strip():
            if cur:
                blocks.append('\n'.join(cur).strip())
                cur = []
        else:
            cur.append(line)
    if cur:
        blocks.append('\n'.join(cur).strip())

    numeric_keys = {'quantity', 'rate', 'discount', 'tax', 'amount'}
    for raw in blocks:
        if not raw:
            continue
        item: Dict[str, Any] = {f: '' if f not in numeric_keys else None for f in LINE_FIELDS}
        # Track which rate alias produced the current rate value so a
        # later, lower-priority alias on the same line doesn't clobber
        # a higher-priority one we already captured.
        rate_priority = 99
        rate_raw_label = ''
        for label, value in _parse_label_value_block(raw):
            field = _match_label(label, LINE_LABEL_TO_FIELD)
            if not field:
                continue
            if field == 'rate':
                norm = re.sub(r'[^\w\s]', ' ', label.lower()).strip()
                norm = re.sub(r'\s+', ' ', norm)
                new_priority = _line_rate_priority_for(norm)
                if new_priority < rate_priority:
                    item['rate'] = _coerce_number(value)
                    rate_priority = new_priority
                    rate_raw_label = label
            elif field in numeric_keys:
                # Quantity gets range-aware coercion so '150 / 155 MT'
                # picks 150 instead of being squashed to 150155. Other
                # numeric fields use the standard coercer.
                if field == 'quantity':
                    item[field] = _coerce_quantity(value)
                else:
                    item[field] = _coerce_number(value)
            elif field == 'delivery_date':
                item[field] = _coerce_date(value)
            else:
                # Strip trailing units from quantity-like values we incorrectly
                # mapped (e.g., "110 KG" → "110" for rate but keep UOM separate)
                item[field] = value

        # Fallback: per user spec, if rate is missing/zero but
        # `amount` and `quantity` are both present, compute
        # rate = amount / quantity. Common when vendor docs list only
        # "Qty | Total" columns and expect the reader to divide.
        rate_val = item.get('rate')
        if (rate_val is None or rate_val == 0) and item.get('amount') and item.get('quantity'):
            try:
                qty = float(item['quantity'])
                amt = float(item['amount'])
                if qty > 0:
                    item['rate'] = round(amt / qty, 4)
                    rate_raw_label = '(derived from amount/quantity)'
            except (TypeError, ValueError):
                pass

        # Validation: 0 or negative rate is almost always a parse miss.
        # Blank the field so the frontend doesn't silently save a free
        # line. The diagnostics warning lets the user know why.
        if item.get('rate') is not None and item['rate'] <= 0:
            item['_rate_warning'] = (
                f'Unit price extracted as {item["rate"]} which is invalid; '
                f'field left blank for manual entry.'
            )
            item['rate'] = None
        if rate_raw_label and item.get('rate') is not None:
            item['_rate_source_label'] = rate_raw_label

        # Fallback: if no product_name / product_code was captured via
        # label:value, scan the block for a "bare" line (no colon, or a
        # colon-prefixed line whose label didn't match anything known). Gemini
        # sometimes emits the product name as a free-text first line of an
        # item block, e.g.:
        #   Item 1:
        #     ANANDHAM 40 KG
        #     Quantity: 110
        #     Rate: 91.5
        # Without this fallback the row would have rate/qty but no name.
        if not item.get('product_name') and not item.get('product_code'):
            for raw_line in raw.splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                # Skip lines that ARE recognized label:value pairs.
                m = re.match(r'^([^:]{1,80}?)\s*:\s*(.+)$', line)
                if m:
                    if _match_label(m.group(1).strip(), LINE_LABEL_TO_FIELD):
                        continue
                    # Unknown label — take the value as the product name.
                    candidate = m.group(2).strip()
                else:
                    candidate = line
                # Reject obvious non-names (pure numbers, very short fragments).
                if len(candidate) < 3 or re.fullmatch(r'[\d.,\-/]+', candidate):
                    continue
                item['product_name'] = candidate
                break

        # Fallback: derive rate from amount / quantity when rate is missing.
        # Helps when the vendor doc shows "Qty 110, Amount 55000" without an
        # explicit "Unit Price" / "Rate" label.
        if item.get('rate') in (None, '') and item.get('amount') and item.get('quantity'):
            try:
                qty = Decimal(str(item['quantity']))
                amt = Decimal(str(item['amount']))
                if qty > 0:
                    item['rate'] = float(amt / qty)
            except Exception:
                pass

        # Reverse fallback: derive amount from rate * quantity when missing.
        if item.get('amount') in (None, '') and item.get('rate') and item.get('quantity'):
            try:
                qty = Decimal(str(item['quantity']))
                rate = Decimal(str(item['rate']))
                item['amount'] = float(qty * rate)
            except Exception:
                pass

        if any(v not in ('', None) for v in item.values()):
            items.append(item)
    return items


def _parse_plain_text_response(text: str) -> Dict[str, Any]:
    """Convert the model's plain-text labelled output into our JSON schema."""
    sections = _split_sections(text)
    header_block = sections.get('HEADER FIELDS', '') or sections.get('HEADER', '')
    items_block = sections.get('LINE ITEMS', '') or sections.get('ITEMS', '')

    parsed: Dict[str, Any] = {f: '' for f in HEADER_FIELDS}
    # Tracks the priority of the most-specific quote_date alias seen so
    # far. Starts at 99 (i.e. nothing seen). New matches only overwrite
    # if their priority is strictly higher (lower number).
    quote_date_priority = 99
    # Original extracted text per field — surfaced in `diagnostics` so
    # debugging mis-parses doesn't require re-running the model.
    quote_date_raw = ''
    for label, value in _parse_label_value_block(header_block):
        field = _match_label(label, LABEL_TO_FIELD)
        if not field:
            continue
        if field == 'quote_date':
            # Compare against the most-specific alias we've seen so far.
            norm = re.sub(r'[^\w\s]', ' ', label.lower()).strip()
            norm = re.sub(r'\s+', ' ', norm)
            new_priority = _quote_date_priority_for(norm)
            if new_priority < quote_date_priority:
                # Per spec: leave Quote Date empty if the raw extract
                # can't be coerced into a supported date format. The
                # warning published in diagnostics tells the user what
                # we saw so they can manually enter the right date.
                # (Previously this echoed the raw value back, which was
                # better for debugging but made the date input show
                # "nonsense" / "TBD" / etc.)
                parsed['quote_date'] = _coerce_date(value)
                quote_date_priority = new_priority
                quote_date_raw = value
        elif field == 'price_valid_till':
            parsed[field] = _coerce_date(value) or value
        elif field == 'currency':
            # Normalise "₹" → "INR", "$" → "USD", "€" → "EUR".
            v = value.strip()
            if v.startswith('₹') or v.upper() == 'RS' or v.upper() == 'RS.':
                parsed[field] = 'INR'
            elif v.startswith('$'):
                parsed[field] = 'USD'
            elif v.startswith('€'):
                parsed[field] = 'EUR'
            else:
                parsed[field] = v.upper()[:3] if len(v) <= 4 else v
        elif field == 'gst_percentage':
            # Strip "%", "Extra", "GST @", currency symbols → leave bare number.
            num = _coerce_number(value)
            if num is None:
                parsed[field] = value
            else:
                # Sanity-clamp: India GST rates are 0/5/12/18/28 — anything
                # > 28 is almost certainly a GSTIN-prefix leak (state code
                # like '33' from `33AABFU0310L1ZM`) or some other parsing
                # confusion. Reject the value rather than letting it
                # snowball into a wrong line-total downstream. Operator
                # can fill GST manually if the doc actually had one.
                if num > 28:
                    parsed[field] = ''
                    parsed.setdefault('_warnings', []).append(
                        f"GST {num}% rejected (above India max 28% — likely "
                        f"extracted from a GSTIN state-code, not a tax rate). "
                        f"Field cleared; enter manually if the document has GST."
                    )
                else:
                    parsed[field] = str(num)
        else:
            parsed[field] = value

    parsed['items'] = _parse_items_block(items_block)
    # Stash diagnostics so the final extractor response can surface
    # what we saw vs what we coerced. Today only quote_date is tracked;
    # extend the dict for other coerced fields as needed.
    if quote_date_raw:
        parsed['_quote_date_raw'] = quote_date_raw
        if not parsed.get('quote_date'):
            parsed['_quote_date_warning'] = (
                f"Quote date extracted as {quote_date_raw!r} but could not be "
                f"parsed into a supported format (YYYY-MM-DD, DD/MM/YYYY, "
                f"DD-MM-YYYY, DD.MM.YYYY). Field left empty for manual entry."
            )
    return parsed


def _is_usable(parsed: Dict[str, Any]) -> bool:
    if any(parsed.get(f) for f in HEADER_FIELDS):
        return True
    for line in parsed.get('items') or []:
        if line.get('product_name') or line.get('product_code') or line.get('description'):
            return True
    return False


def _missing_required(parsed: Dict[str, Any]) -> List[str]:
    return [f for f in REQUIRED_FIELDS if not parsed.get(f)]


# ─── Gemini call ───────────────────────────────────────────────────────────

def _call_gemini(model_name: str, file_bytes: bytes, mime: str, filename: str,
                 debug_sink: Optional[Dict[str, Any]] = None) -> Tuple[Optional[str], str]:
    """Send the file to Gemini and return the extracted plain-text response.

    Prefers INLINE data over the Files API for files under the 20 MB inline
    limit. Inline avoids the separate ``upload_file()`` call that was
    timing out / 503-ing on Render → Google's storage endpoint, so a
    single failure mode replaces two.

    Files >= 20 MB still fall back to the Files API (no choice).
    """
    try:
        import google.generativeai as genai  # type: ignore
    except ImportError as exc:
        return None, f'google-generativeai not installed ({exc}). Run: pip install google-generativeai'

    api_key = os.environ.get('GEMINI_API_KEY', '').strip()
    if not api_key:
        return None, 'GEMINI_API_KEY not configured in backend/.env'

    INLINE_LIMIT = 20 * 1024 * 1024  # 20 MB — Gemini's inline data limit

    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(model_name)
    except Exception as exc:
        logger.exception('Gemini init failed (model=%s)', model_name)
        return None, f'Gemini init error: {type(exc).__name__}: {exc}'

    use_inline = len(file_bytes) <= INLINE_LIMIT
    upload_path = 'inline' if use_inline else 'files-api'

    tmp_path: Optional[str] = None
    response = None
    try:
        if use_inline:
            # ── Inline path (faster, no separate upload) ──
            try:
                # 90s timeout via request_options — covers the slowest
                # legitimate extraction without pinning a worker forever.
                response = generate_logged(
                    model,
                    [
                        {'mime_type': mime, 'data': file_bytes},
                        EXTRACTION_PROMPT,
                    ],
                    what='quote-inline', model_name=model_name,
                    request_options={'timeout': 90},
                )
            except Exception as exc:
                logger.exception('Gemini inline generate_content failed (model=%s)', model_name)
                return None, f'Gemini API error: {type(exc).__name__}: {exc}'
        else:
            # ── Files API path (only for files > 20 MB) ──
            ext = ''
            if '.' in filename:
                ext = '.' + filename.rsplit('.', 1)[-1].lower()
            elif mime == 'application/pdf':
                ext = '.pdf'
            elif mime.startswith('image/'):
                ext = '.' + mime.split('/', 1)[1]
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
            tmp.write(file_bytes)
            tmp.flush()
            tmp.close()
            tmp_path = tmp.name

            try:
                sample_file = genai.upload_file(path=tmp_path, display_name=filename or 'Quotation')
            except Exception as exc:
                logger.exception('Gemini upload failed (model=%s)', model_name)
                return None, f'Gemini upload error: {type(exc).__name__}: {exc}'

            try:
                response = generate_logged(
                    model,
                    [sample_file, EXTRACTION_PROMPT],
                    what='quote-filesapi', model_name=model_name,
                    request_options={'timeout': 90},
                )
            except Exception as exc:
                logger.exception('Gemini generate_content failed (model=%s)', model_name)
                return None, f'Gemini API error: {type(exc).__name__}: {exc}'

        # Robust response text extraction.
        text = ''
        try:
            text = (getattr(response, 'text', '') or '').strip()
        except Exception:
            text = ''
        if not text:
            for cand in (getattr(response, 'candidates', None) or []):
                content = getattr(cand, 'content', None)
                for part in (getattr(content, 'parts', None) or []):
                    piece = getattr(part, 'text', '') or ''
                    if piece:
                        text += piece
            text = text.strip()

        finish_reason = ''
        safety = ''
        try:
            cands = getattr(response, 'candidates', None) or []
            if cands:
                finish_reason = str(getattr(cands[0], 'finish_reason', '') or '')
                safety = str(getattr(cands[0], 'safety_ratings', '') or '')[:200]
        except Exception:
            pass

        if debug_sink is not None:
            debug_sink['upload_path'] = upload_path
            debug_sink['response_length'] = len(text)
            debug_sink['response_preview'] = text[:800]
            debug_sink['finish_reason'] = finish_reason
            debug_sink['safety'] = safety

        if not text:
            return None, f'Empty response from Gemini (finish_reason={finish_reason})'

        return text, f'ok (model={model_name}, transport={upload_path})'
    finally:
        # Only the >20 MB Files API branch creates a temp file.
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ─── Public entry point ────────────────────────────────────────────────────

_STATUS_RANK = {'failed': 0, 'partial': 1, 'success': 2}


def _try_extract(model_name: str, file_bytes: bytes, mime: str, filename: str):
    """Run a single Gemini extraction attempt. Returns (response, attempt_meta)."""
    debug: Dict[str, Any] = {}
    text, status_msg = _call_gemini(model_name, file_bytes, mime, filename, debug_sink=debug)
    attempt = {'model': model_name, 'status': status_msg, **debug}

    if not text:
        resp = _format_response(_empty_payload(), model_name, [attempt], '', [
            'Gemini returned no text. See diagnostics.'
        ])
        return resp, attempt

    try:
        parsed = _parse_plain_text_response(text)
    except Exception as exc:
        logger.exception('Plain-text response parsing failed')
        resp = _format_response(_empty_payload(), model_name, [attempt], text, [
            f'Response parsing failed: {type(exc).__name__}: {exc}',
        ])
        return resp, attempt

    warnings: List[str] = []
    if not _is_usable(parsed):
        warnings.append('No usable fields parsed from the model response. The raw response is in `raw_response` for review.')
    elif _missing_required(parsed):
        warnings.append('Some required fields are missing — review before saving.')

    resp = _format_response(parsed, model_name, [attempt], text, warnings)
    return resp, attempt


def extract_quote(file_bytes: bytes, filename: str) -> Dict[str, Any]:
    """Run extraction and return the spec-shaped response.

    Quote Response extraction is locked to ``gemini-2.5-flash`` with a
    single-attempt retry on transient errors. We deliberately do NOT
    fall back to flash-lite — the lite model was producing too many
    partial extractions on real vendor quotes, and falling back hid
    that fact behind a "succeeded with partial data" message.

    A single retry covers the common transient cases (503 Service
    Unavailable, momentary timeout) without doubling the worst-case
    latency the way a different-model fallback would.
    """
    mime = _guess_mime(filename)

    # Locked to gemini-2.5-flash. Env vars cannot downgrade the model.
    # If someone needs to override (e.g. testing on a key without Flash
    # access), they can set GEMINI_QUOTE_PRIMARY_MODEL — but we ignore
    # the generic GEMINI_PRIMARY_MODEL so local .env files set for the
    # cheaper receipt/weighment extractors don't accidentally affect
    # Quote extraction.
    model_name = (
        os.environ.get('GEMINI_QUOTE_PRIMARY_MODEL') or 'gemini-2.5-flash'
    ).strip()

    attempts: List[Dict[str, Any]] = []
    last_resp: Optional[Dict[str, Any]] = None

    # Up to 2 attempts with the SAME model — covers transient 503 / read
    # timeout cases without falling back to a weaker model.
    MAX_ATTEMPTS = 2
    for attempt_num in range(1, MAX_ATTEMPTS + 1):
        resp, attempt = _try_extract(model_name, file_bytes, mime, filename)
        attempts.append(attempt)
        last_resp = resp
        if resp.get('extraction_status') == 'success':
            break
        if attempt_num < MAX_ATTEMPTS:
            logger.info(
                'Quote extraction attempt %d/%d returned %s (model=%s) — retrying',
                attempt_num, MAX_ATTEMPTS,
                resp.get('extraction_status'), model_name,
            )

    if last_resp is None:
        last_resp = _format_response(_empty_payload(), model_name, attempts, '', [
            'Extraction produced no response.'
        ])

    last_resp['attempts'] = attempts
    last_resp['model_used'] = model_name
    return last_resp


def _empty_payload() -> Dict[str, Any]:
    out: Dict[str, Any] = {f: '' for f in HEADER_FIELDS}
    out['items'] = []
    return out


def _format_response(parsed: Dict[str, Any], model_used: str,
                     attempts: List[Dict[str, Any]], raw_response: str,
                     warnings: List[str]) -> Dict[str, Any]:
    parsed = parsed or _empty_payload()
    missing = _missing_required(parsed)
    has_items = bool(parsed.get('items'))
    has_anything = _is_usable(parsed)

    if not has_anything:
        status = 'failed'
    elif missing or not has_items:
        status = 'partial'
    else:
        status = 'success'

    if missing:
        warnings = list(warnings) + [
            f"Required field(s) missing: {', '.join(missing)} — review before saving."
        ]
    if not has_items and has_anything:
        warnings = list(warnings) + ['No line items detected.']
    # Surface unparseable date warning so the frontend can toast it
    # AND the API consumer can see what was extracted.
    quote_date_warning = parsed.get('_quote_date_warning')
    if quote_date_warning:
        warnings = list(warnings) + [quote_date_warning]
    # Per-line rate warnings (zero / negative rate). Surface them all
    # so the user knows which line(s) need manual entry. Also collect
    # the source label of each rate that did parse, for diagnostics.
    rate_diagnostics: List[Dict[str, Any]] = []
    items = parsed.get('items') or []
    for idx, line in enumerate(items, start=1):
        if line.get('_rate_warning'):
            warnings = list(warnings) + [f'Line {idx}: {line["_rate_warning"]}']
        if line.get('_rate_source_label'):
            rate_diagnostics.append({
                'line': idx,
                'label': line['_rate_source_label'],
                'value': line.get('rate'),
            })

    # Strip internal `_*` keys from items so the frontend doesn't see
    # them. They're already surfaced via warnings + diagnostics above.
    cleaned_items: List[Dict[str, Any]] = []
    for line in items:
        cleaned_items.append({k: v for k, v in line.items() if not k.startswith('_')})

    response: Dict[str, Any] = {f: parsed.get(f, '') for f in HEADER_FIELDS}
    response['items'] = cleaned_items
    response['extraction_status'] = status
    response['missing_fields'] = missing
    response['model_used'] = model_used
    response['attempts'] = attempts
    response['warnings'] = warnings
    response['raw_response'] = raw_response[:6000]  # keep response size bounded
    # Diagnostics — original extracted strings for fields that went
    # through coercion. Useful when the user reports "the date / rate is
    # wrong" and you need to know what the model actually returned.
    diagnostics: Dict[str, Any] = {}
    if parsed.get('_quote_date_raw'):
        diagnostics['quote_date_raw'] = parsed['_quote_date_raw']
    if rate_diagnostics:
        diagnostics['rate_sources'] = rate_diagnostics
    if diagnostics:
        response['diagnostics'] = diagnostics
    return response

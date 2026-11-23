"""Gemini-based document extractor for Purchase → Receipt Advice Auto-Fill.

Same pattern as quote_gemini_extractor: matches the user-validated Python
script (model ``gemini-2.5-flash-lite``, ``upload_file(path=…)``, no
``generation_config``). Prompt is invoice/DC/GRN-focused since receipts are
created against vendor invoices or delivery challans, not quotations.

Response contract (flat top-level, what the Receipt Advice form expects):
{
  "po_no":           "PO-2026-00199",
  "invoice_no":      "INV-12345",
  "vendor_name":     "Victory Cards",
  "receipt_date":    "YYYY-MM-DD",
  "driver_name":     "...",
  "vehicle_no":      "TN-30-A-1234",
  "lr_no":           "...",
  "transporter":     "Spicejet",
  "freight_terms":   "PAID" | "TO_PAY",
  "freight_value":   0,
  "advance_amount":  0,
  "remarks":         "...",
  "items": [{ product_name, product_code, batch_no, quantity, uom,
              rate, amount, godown, remarks }],
  "extraction_status": "success" | "partial" | "failed",
  "missing_fields":    [],
  "model_used":        "gemini-2.5-flash-lite",
  "attempts":          [{ model, status, response_preview, ... }],
  "warnings":          [],
  "raw_response":      "..."
}
"""

from __future__ import annotations

import logging
import mimetypes
import os
import re
import tempfile
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from common.ai_log import generate_logged

logger = logging.getLogger(__name__)


# ─── Schema ────────────────────────────────────────────────────────────────
HEADER_FIELDS: List[str] = [
    'po_no',
    'invoice_no',
    'invoice_date',
    'invoice_amount',
    'vendor_name',
    'receipt_date',
    'driver_name',
    'vehicle_no',
    'lr_no',
    'transporter',
    'freight_terms',
    'freight_value',
    'advance_amount',
    'remarks',
]
LINE_FIELDS: List[str] = [
    'product_name',
    'product_code',
    'batch_no',
    'quantity',
    'uom',
    'rate',
    'amount',
    'godown',
    'remarks',
]
REQUIRED_FIELDS: List[str] = ['vendor_name', 'receipt_date']


EXTRACTION_PROMPT = """Read this vendor INVOICE / DELIVERY CHALLAN / GRN /
RECEIPT document carefully and extract EVERY field that is present. Do not
assume a fixed schema — capture whatever the document actually contains.

Output format (plain text, NO markdown, NO code fences, NO commentary):

=== HEADER FIELDS ===
<Every label/value pair found at the top of the document, one per line.>
Example:
PO No: PO-2026-00199
Invoice No: INV-12345
Invoice Date: 09-05-2026
Invoice Amount: 18500
Vendor: Victory Cards
Receipt Date: 10-05-2026
Vehicle No: TN-30-AB-1234
Driver Name: Suresh
Transporter: Spicejet
LR No: LR-44512
Freight Terms: Paid
Freight Value: 2500
Advance Amount: 5000
(include any other header field you find)

IMPORTANT DATE DISAMBIGUATION:
- "Invoice Date" / "Bill Date" / "DC Date" / "GRN Date" → output as `Invoice Date:` (the vendor's bill date)
- "Received Date" / "Receipt Date" / a generic "Date:" stamped at the top → output as `Receipt Date:`
- If only ONE date is on the document, output it as `Invoice Date:` (we'll default Receipt Date to today)
- "Invoice Amount" / "Grand Total" / "Net Payable" / final total at the bottom → output as `Invoice Amount:`

=== LINE ITEMS ===
<For each product row, output one block. Include every column the table has.>
Example:
Item 1:
  Product: NEEM OIL
  SKU: 101
  Batch No: BTH-2026-04
  Quantity: 100
  UOM: KG
  Rate: 250
  Amount: 25000
  Godown: Main Godown
  (any other column the table has)

=== TOTALS ===
<Subtotal, Tax, Grand Total — every total/summary on the document>

=== OTHER ===
<Anything else: bank details, terms & conditions, notes>

RULES:
- Extract every visible field. Do not skip a field just because it doesn't fit a slot.
- Do not invent fields. No "N/A" placeholders for fields not on the document.
- Monetary values as plain numbers (no commas, no currency symbols).
- Quantities as plain numbers (strip "kg", "nos" etc., put them in UOM).
- Dates as printed; the parser will normalize them.
- Return ONLY the formatted text above.
"""


# ─── Helpers ───────────────────────────────────────────────────────────────

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


_DATE_FORMATS = [
    '%Y-%m-%d',
    '%d-%m-%Y', '%d/%m/%Y', '%d.%m.%Y',
    '%d-%b-%Y', '%d-%B-%Y', '%d %b %Y', '%d %B %Y',
    '%b %d, %Y', '%B %d, %Y',
    '%d-%b-%y', '%d-%B-%y',
    '%m/%d/%Y',
]


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
    m = re.match(r'(\d{1,2}[-/.\s]\w{2,9}[-/.\s]\d{2,4}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})', s)
    if m:
        for fmt in _DATE_FORMATS:
            try:
                return datetime.strptime(m.group(1), fmt).date().isoformat()
            except ValueError:
                continue
    return ''


# Label → schema field. Order matters: more specific phrases first.
# Invoice fields are distinct from receipt fields:
#   invoice_*  = what the vendor printed on the bill (their dating / numbering)
#   receipt_*  = when WE received the goods (our internal record)
# The Direct Receipt UI exposes invoice_no / invoice_date / invoice_amount as
# separate fields so this mapping must keep them separate too — previously
# "invoice date" was lumped into receipt_date which clobbered the UI field.
LABEL_TO_FIELD: List[Tuple[List[str], str]] = [
    (['po no', 'po number', 'purchase order no', 'po reference', 'order no', 'against po'], 'po_no'),
    (['invoice no', 'invoice number', 'bill no', 'bill number', 'gst invoice', 'tax invoice', 'dc no', 'delivery challan', 'dc number', 'grn no'], 'invoice_no'),
    (['invoice date', 'bill date', 'dc date', 'grn date', 'invoice dt', 'bill dt'], 'invoice_date'),
    (['invoice amount', 'invoice total', 'invoice value', 'bill amount', 'bill total', 'grand total', 'total amount', 'net payable', 'total invoice'], 'invoice_amount'),
    (['vendor', 'supplier', 'from', 'quoted by', 'company', 'issued by', 'seller', 'manufacturer'], 'vendor_name'),
    (['receipt date', 'received on', 'received date', 'document date', 'date', 'dated'], 'receipt_date'),
    (['driver name', 'driver'], 'driver_name'),
    (['vehicle no', 'vehicle number', 'lorry no', 'lorry number', 'truck no', 'truck number'], 'vehicle_no'),
    (['lr no', 'lr number', 'lr#', 'awb', 'consignment'], 'lr_no'),
    (['transporter', 'logistics partner', 'carrier'], 'transporter'),
    (['freight terms', 'freight'], 'freight_terms'),
    (['freight value', 'freight charges', 'freight amount'], 'freight_value'),
    (['advance amount', 'advance', 'advance paid'], 'advance_amount'),
    (['remarks', 'notes', 'comments', 'special instructions'], 'remarks'),
]
LINE_LABEL_TO_FIELD: List[Tuple[List[str], str]] = [
    (['product', 'item', 'description', 'material', 'goods', 'particulars'], 'product_name'),
    (['sku', 'part no', 'part number', 'item code', 'product code', 'code', 'model', 'catalogue no', 'article', 'hsn'], 'product_code'),
    (['batch no', 'batch number', 'batch', 'lot no', 'lot number'], 'batch_no'),
    (['quantity', 'qty', 'nos', 'pcs', 'received qty', 'qty received'], 'quantity'),
    (['uom', 'unit', 'units', 'per'], 'uom'),
    (['rate', 'unit price', 'price', 'per unit', 'cost', 'mrp'], 'rate'),
    (['amount', 'total', 'line total', 'net amount', 'net value', 'subtotal'], 'amount'),
    (['godown', 'warehouse', 'location', 'storage'], 'godown'),
    (['remarks', 'notes'], 'remarks'),
]


def _match_label(label: str, table: List[Tuple[List[str], str]]) -> str:
    norm = re.sub(r'[^\w\s]', ' ', label.lower()).strip()
    norm = re.sub(r'\s+', ' ', norm)
    if not norm:
        return ''
    for keys, field in table:
        if norm in keys:
            return field
    for keys, field in table:
        for k in keys:
            if norm == k or norm.startswith(k + ' ') or norm.endswith(' ' + k) or k in norm:
                return field
    return ''


def _split_sections(text: str) -> Dict[str, str]:
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
                current = 'HEADER FIELDS'
                buf = []
            buf.append(line)
    if current is not None:
        sections[current] = '\n'.join(buf).strip()
    return sections


def _parse_label_value_block(block: str) -> List[Tuple[str, str]]:
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
    items: List[Dict[str, Any]] = []
    if not block.strip():
        return items

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

    numeric_keys = {'quantity', 'rate', 'amount'}
    for raw in blocks:
        if not raw:
            continue
        item: Dict[str, Any] = {f: '' if f not in numeric_keys else None for f in LINE_FIELDS}
        for label, value in _parse_label_value_block(raw):
            field = _match_label(label, LINE_LABEL_TO_FIELD)
            if not field:
                continue
            if field in numeric_keys:
                item[field] = _coerce_number(value)
            else:
                item[field] = value
        if any(v not in ('', None) for v in item.values()):
            items.append(item)
    return items


def _parse_plain_text_response(text: str) -> Dict[str, Any]:
    sections = _split_sections(text)
    header_block = sections.get('HEADER FIELDS', '') or sections.get('HEADER', '')
    items_block = sections.get('LINE ITEMS', '') or sections.get('ITEMS', '')

    parsed: Dict[str, Any] = {f: '' for f in HEADER_FIELDS}
    for label, value in _parse_label_value_block(header_block):
        field = _match_label(label, LABEL_TO_FIELD)
        if not field:
            continue
        if field in ('receipt_date', 'invoice_date'):
            parsed[field] = _coerce_date(value) or value
        elif field in ('freight_value', 'advance_amount', 'invoice_amount'):
            n = _coerce_number(value)
            parsed[field] = n if n is not None else ''
        elif field == 'freight_terms':
            v = value.upper()
            if 'PAID' in v and 'TO' not in v:
                parsed[field] = 'PAID'
            elif 'TO PAY' in v or 'TO_PAY' in v:
                parsed[field] = 'TO_PAY'
            else:
                parsed[field] = value
        else:
            parsed[field] = value

    parsed['items'] = _parse_items_block(items_block)
    return parsed


def _is_usable(parsed: Dict[str, Any]) -> bool:
    if any(parsed.get(f) for f in HEADER_FIELDS):
        return True
    for line in parsed.get('items') or []:
        if line.get('product_name') or line.get('product_code') or line.get('batch_no'):
            return True
    return False


def _missing_required(parsed: Dict[str, Any]) -> List[str]:
    return [f for f in REQUIRED_FIELDS if not parsed.get(f)]


# ─── Gemini call (same shape as quote_gemini_extractor) ────────────────────

def _call_gemini(model_name: str, file_bytes: bytes, mime: str, filename: str,
                 debug_sink: Optional[Dict[str, Any]] = None) -> Tuple[Optional[str], str]:
    try:
        import google.generativeai as genai  # type: ignore
    except ImportError as exc:
        return None, f'google-generativeai not installed ({exc}). Run: pip install google-generativeai'

    api_key = os.environ.get('GEMINI_API_KEY', '').strip()
    if not api_key:
        return None, 'GEMINI_API_KEY not configured in backend/.env'

    ext = ''
    if '.' in filename:
        ext = '.' + filename.rsplit('.', 1)[-1].lower()
    elif mime == 'application/pdf':
        ext = '.pdf'
    elif mime.startswith('image/'):
        ext = '.' + mime.split('/', 1)[1]
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    try:
        tmp.write(file_bytes)
        tmp.flush()
        tmp.close()

        try:
            genai.configure(api_key=api_key)
            model = genai.GenerativeModel(model_name)   # NO generation_config — matches working script
            sample_file = genai.upload_file(path=tmp.name, display_name=filename or 'Receipt')
        except Exception as exc:
            logger.exception('Gemini init/upload failed (model=%s)', model_name)
            return None, f'Gemini init/upload error: {type(exc).__name__}: {exc}'

        try:
            # 90s timeout via request_options — without it the SDK's own
            # default (600s) outlives gunicorn's 120s worker timeout
            # (render.yaml), so a slow response gets the worker SIGKILLed
            # instead of returning a clean error. Matches the convention
            # already used in quote_gemini_extractor.py.
            response = generate_logged(
                model, [sample_file, EXTRACTION_PROMPT],
                what='receipt', model_name=model_name,
                request_options={'timeout': 90})
        except Exception as exc:
            logger.exception('Gemini generate_content failed (model=%s)', model_name)
            return None, f'Gemini API error: {type(exc).__name__}: {exc}'

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
            debug_sink['upload_path'] = 'files-api'
            debug_sink['response_length'] = len(text)
            debug_sink['response_preview'] = text[:800]
            debug_sink['finish_reason'] = finish_reason
            debug_sink['safety'] = safety

        if not text:
            return None, f'Empty response from Gemini (finish_reason={finish_reason})'

        return text, f'ok (model={model_name})'
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


# ─── Public entry point ────────────────────────────────────────────────────

_STATUS_RANK = {'failed': 0, 'partial': 1, 'success': 2}


def _try_extract(model_name: str, file_bytes: bytes, mime: str, filename: str):
    """Run a single Gemini extraction attempt. Returns (response, attempt_meta).

    The response is the same dict shape `_format_response` would return — so
    callers can rank attempts by `extraction_status` and pick the best one.
    """
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


def extract_receipt(file_bytes: bytes, filename: str) -> Dict[str, Any]:
    mime = _guess_mime(filename)
    primary = (os.environ.get('GEMINI_PRIMARY_MODEL') or 'gemini-2.5-flash-lite').strip()
    # Fall back to the heavier model when the lite one returns failed/partial.
    # Override via GEMINI_FALLBACK_MODEL; empty string disables the fallback.
    fallback_env = os.environ.get('GEMINI_FALLBACK_MODEL')
    fallback = (fallback_env if fallback_env is not None else 'gemini-2.5-flash').strip()

    primary_resp, primary_attempt = _try_extract(primary, file_bytes, mime, filename)
    attempts = [primary_attempt]

    primary_status = primary_resp.get('extraction_status', 'failed')

    # Retry with the heavier model only when primary didn't fully succeed AND
    # a fallback is configured AND it's actually a different model.
    if (
        primary_status != 'success'
        and fallback
        and fallback.lower() != primary.lower()
    ):
        logger.info('Receipt extraction primary=%s returned %s — retrying with %s',
                    primary, primary_status, fallback)
        fallback_resp, fallback_attempt = _try_extract(fallback, file_bytes, mime, filename)
        attempts.append(fallback_attempt)
        fallback_status = fallback_resp.get('extraction_status', 'failed')

        if _STATUS_RANK.get(fallback_status, 0) > _STATUS_RANK.get(primary_status, 0):
            fallback_resp['attempts'] = attempts
            return fallback_resp

    primary_resp['attempts'] = attempts
    return primary_resp


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

    response: Dict[str, Any] = {f: parsed.get(f, '') for f in HEADER_FIELDS}
    response['items'] = parsed.get('items') or []
    response['extraction_status'] = status
    response['missing_fields'] = missing
    response['model_used'] = model_used
    response['attempts'] = attempts
    response['warnings'] = warnings
    response['raw_response'] = raw_response[:6000]
    return response

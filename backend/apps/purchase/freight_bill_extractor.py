"""Gemini-based freight bill / transporter slip extractor.

Same two-tier pattern as receipt_gemini_extractor: try the cheap model first,
escalate to the heavier one only when the extraction is incomplete.

Response contract:
{
  "transporter_name":  "Sri Logistics",
  "freight_bill_no":   "FB-2024-001",
  "freight_bill_date": "2026-11-24",
  "vehicle_no":        "TN-30-AB-1234",
  "driver_name":       "Suresh",
  "freight_value":     2500,
  "freight_terms":     "PAID" | "TO_PAY",
  "advance_amount":    0,
  "lr_no":             "LR-44512",
  "extraction_status": "success" | "partial" | "failed",
  "model_used":        "gemini-2.5-flash-lite",
  "attempts":          [...],
  "warnings":          [],
  "raw_response":      "..."
}
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from common.ai_log import generate_logged

logger = logging.getLogger(__name__)

HEADER_FIELDS: List[str] = [
    'transporter_name',
    'freight_bill_no',
    'freight_bill_date',
    'vehicle_no',
    'driver_name',
    'freight_value',
    'freight_terms',
    'advance_amount',
    'lr_no',
]

REQUIRED_FIELDS: List[str] = ['transporter_name']

EXTRACTION_PROMPT = """Read this FREIGHT BILL / TRANSPORTER SLIP / LORRY RECEIPT
document carefully and extract the transport-related fields.

This is a freight/transport document — NOT a goods invoice. Focus on:
- Transporter / carrier name
- Freight bill number / LR number / consignment note number
- Date on the freight bill
- Vehicle / lorry number
- Driver name
- Freight amount / lorry hire
- Freight terms (Paid or To Pay)
- Advance amount (if any)

Output format (plain text, NO markdown, NO code fences, NO commentary):

=== HEADER FIELDS ===
Transporter Name: Sri Logistics
Freight Bill No: FB-2024-001
Freight Bill Date: 24-11-2026
Vehicle No: TN-30-AB-1234
Driver Name: Suresh
LR No: LR-44512
Freight Value: 2500
Freight Terms: Paid
Advance Amount: 500
(include any other transport field you find)

RULES:
- Extract every visible field. Do not skip a field just because it doesn't fit a slot.
- Do not invent fields. No "N/A" placeholders for fields not on the document.
- Monetary values as plain numbers (no commas, no currency symbols).
- Dates as printed; the parser will normalize them.
- "Lorry Hire" / "Freight Charge" / "Total" on a freight slip → Freight Value.
- Return ONLY the formatted text above.
"""


# ─── Helpers (shared shape with receipt extractor) ────────────────────────

def _guess_mime(filename: str) -> str:
    ext = (filename.rsplit('.', 1)[-1] or '').lower()
    return {
        'pdf': 'application/pdf', 'png': 'image/png',
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp',
    }.get(ext, 'application/octet-stream')


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
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', s):
        return s
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return ''


LABEL_TO_FIELD: List[Tuple[List[str], str]] = [
    (['transporter name', 'transporter', 'carrier', 'logistics', 'transport company', 'agency'], 'transporter_name'),
    (['freight bill no', 'freight bill number', 'bill no', 'bill number', 'fb no', 'cn no',
      'consignment note', 'consignment no', 'memo no', 'gc no', 'gr no'], 'freight_bill_no'),
    (['freight bill date', 'bill date', 'date', 'dated', 'fb date', 'cn date'], 'freight_bill_date'),
    (['vehicle no', 'vehicle number', 'lorry no', 'lorry number', 'truck no', 'truck number'], 'vehicle_no'),
    (['driver name', 'driver'], 'driver_name'),
    (['lr no', 'lr number', 'lr#', 'awb', 'consignment', 'bilti no', 'builty no'], 'lr_no'),
    (['freight value', 'freight charges', 'freight amount', 'lorry hire', 'freight',
      'total freight', 'hire charges', 'total', 'amount', 'net payable', 'grand total'], 'freight_value'),
    (['freight terms', 'payment terms', 'payment mode', 'terms'], 'freight_terms'),
    (['advance amount', 'advance', 'advance paid'], 'advance_amount'),
]


def _match_label(label: str) -> str:
    norm = re.sub(r'[^\w\s]', ' ', label.lower()).strip()
    norm = re.sub(r'\s+', ' ', norm)
    if not norm:
        return ''
    for keys, field in LABEL_TO_FIELD:
        if norm in keys:
            return field
    for keys, field in LABEL_TO_FIELD:
        for k in keys:
            if k in norm:
                return field
    return ''


def _parse_response(text: str) -> Dict[str, Any]:
    parsed: Dict[str, Any] = {f: '' for f in HEADER_FIELDS}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith('==='):
            continue
        m = re.match(r'^([^:]{1,80}?)\s*:\s*(.+)$', line)
        if not m:
            continue
        field = _match_label(m.group(1))
        value = m.group(2).strip()
        if not field:
            continue
        if field == 'freight_bill_date':
            parsed[field] = _coerce_date(value) or value
        elif field in ('freight_value', 'advance_amount'):
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
    return parsed


def _is_usable(parsed: Dict[str, Any]) -> bool:
    return any(parsed.get(f) for f in HEADER_FIELDS)


# ─── Gemini call ──────────────────────────────────────────────────────────

def _call_gemini(model_name: str, file_bytes: bytes, mime: str, filename: str) -> Tuple[Optional[str], str]:
    try:
        import google.generativeai as genai
    except ImportError as exc:
        return None, f'google-generativeai not installed ({exc})'

    api_key = os.environ.get('GEMINI_API_KEY', '').strip()
    if not api_key:
        return None, 'GEMINI_API_KEY not configured'

    INLINE_LIMIT = 20 * 1024 * 1024  # 20 MB

    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(model_name)
    except Exception as exc:
        logger.exception('Gemini init failed (model=%s)', model_name)
        return None, f'Gemini init error: {type(exc).__name__}: {exc}'

    use_inline = len(file_bytes) <= INLINE_LIMIT
    tmp_path = None
    try:
        if use_inline:
            response = generate_logged(
                model,
                [{'mime_type': mime, 'data': file_bytes}, EXTRACTION_PROMPT],
                what='freight-bill-inline', model_name=model_name,
                request_options={'timeout': 90},
            )
        else:
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
            sample_file = genai.upload_file(path=tmp_path, display_name=filename or 'FreightBill')
            response = generate_logged(
                model, [sample_file, EXTRACTION_PROMPT],
                what='freight-bill-filesapi', model_name=model_name,
                request_options={'timeout': 90},
            )

        text = (getattr(response, 'text', '') or '').strip()
        if not text:
            for cand in (getattr(response, 'candidates', None) or []):
                content = getattr(cand, 'content', None)
                for part in (getattr(content, 'parts', None) or []):
                    piece = getattr(part, 'text', '') or ''
                    if piece:
                        text += piece
            text = text.strip()

        return text or None, f'ok (model={model_name})'
    except Exception as exc:
        logger.exception('Gemini freight-bill extract failed (model=%s)', model_name)
        return None, f'Gemini error: {type(exc).__name__}: {exc}'
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ─── Public entry point ──────────────────────────────────────────────────

_STATUS_RANK = {'failed': 0, 'partial': 1, 'success': 2}


def _try_extract(model_name: str, file_bytes: bytes, mime: str, filename: str):
    text, status_msg = _call_gemini(model_name, file_bytes, mime, filename)
    attempt = {'model': model_name, 'status': status_msg}

    if not text:
        return _build_response({f: '' for f in HEADER_FIELDS}, model_name, [attempt], '', ['Gemini returned no text.']), attempt

    parsed = _parse_response(text)
    warnings = [] if _is_usable(parsed) else ['No usable fields parsed from the response.']
    return _build_response(parsed, model_name, [attempt], text, warnings), attempt


def extract_freight_bill(file_bytes: bytes, filename: str) -> Dict[str, Any]:
    mime = _guess_mime(filename)
    primary = (os.environ.get('GEMINI_PRIMARY_MODEL') or 'gemini-2.5-flash-lite').strip()
    fallback_env = os.environ.get('GEMINI_FALLBACK_MODEL')
    fallback = (fallback_env if fallback_env is not None else 'gemini-2.5-flash').strip()

    primary_resp, primary_attempt = _try_extract(primary, file_bytes, mime, filename)
    attempts = [primary_attempt]
    primary_status = primary_resp.get('extraction_status', 'failed')

    if primary_status != 'success' and fallback and fallback.lower() != primary.lower():
        logger.info('Freight-bill extraction primary=%s returned %s — retrying with %s',
                    primary, primary_status, fallback)
        fallback_resp, fallback_attempt = _try_extract(fallback, file_bytes, mime, filename)
        attempts.append(fallback_attempt)
        if _STATUS_RANK.get(fallback_resp.get('extraction_status', 'failed'), 0) > _STATUS_RANK.get(primary_status, 0):
            fallback_resp['attempts'] = attempts
            return fallback_resp

    primary_resp['attempts'] = attempts
    return primary_resp


def _build_response(parsed: Dict[str, Any], model_used: str,
                    attempts: List[Dict[str, Any]], raw_response: str,
                    warnings: List[str]) -> Dict[str, Any]:
    missing = [f for f in REQUIRED_FIELDS if not parsed.get(f)]
    has_anything = _is_usable(parsed)

    if not has_anything:
        extraction_status = 'failed'
    elif missing:
        extraction_status = 'partial'
    else:
        extraction_status = 'success'

    if missing:
        warnings = list(warnings) + [f"Missing: {', '.join(missing)}"]

    return {
        **{f: parsed.get(f, '') for f in HEADER_FIELDS},
        'extraction_status': extraction_status,
        'missing_fields': missing,
        'model_used': model_used,
        'attempts': attempts,
        'warnings': warnings,
        'raw_response': (raw_response or '')[:4000],
    }

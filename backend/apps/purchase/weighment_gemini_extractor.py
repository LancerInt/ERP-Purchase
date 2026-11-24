"""Gemini-based extractor for weighbridge / weighment slips.

Mirrors the same model + temp-file upload pattern used by quote_gemini_extractor.
A weighment slip typically contains:
- Weighbridge / weighment station name
- Slip number / ticket number
- Gross weight (first weight)
- Tare weight (empty truck)
- Net weight (second weight = gross - tare)
- Sometimes vehicle / lorry number, date/time
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
from typing import Any, Dict, List, Optional, Tuple
from common.ai_log import generate_logged

logger = logging.getLogger(__name__)


EXTRACTION_PROMPT = """Read this weighbridge / weighment slip and extract every field.

Output format (plain text, NO markdown, NO code fences, NO commentary):

=== WEIGHMENT FIELDS ===
Weighment Name: <weighbridge / weigh station name>
Weighment No: <slip / ticket / receipt number>
First Weight: <gross weight as plain number, no unit>
Second Weight: <net weight as plain number, no unit>
Tare Weight: <tare / empty weight as plain number, no unit>
UOM: <unit of measurement printed on the slip, uppercase, e.g. KG / MTS / TON / QUINTAL / LTR>
Vehicle No: <if present>
Transporter: <transporter / transport company / carrier / lorry owner name, if present>
Driver Name: <driver / operator name, if present>
Date: <if present>

RULES:
- Numbers as plain digits (no commas, no unit suffix in the VALUE — put the unit on its own UOM line).
- If a value isn't on the slip, omit the line entirely. Don't write "N/A".
- A typical weighment slip says: "Gross Wt: 8520 kg / Tare Wt: 3200 kg / Net Wt: 5320 kg".
  Map "Gross" → First Weight, "Net" → Second Weight, "Tare" → Tare Weight.
- For UOM:
    * Slip says "Kg" / "kg" / "KGS" / "Kilogram" → UOM: KG
    * Slip says "MT" / "Metric Ton" / "Tonne"  → UOM: MTS
    * Slip says "TON" / "Tonnes"                → UOM: TON
    * Slip says "Quintal" / "Qntl"              → UOM: QUINTAL
    * Slip says "L" / "Ltr" / "Litre"           → UOM: LTR
    * If no unit is visible anywhere on the slip → omit the UOM line entirely.
- Return ONLY the formatted text above.
"""


def _guess_mime(filename: str) -> str:
    ext = (filename.rsplit('.', 1)[-1] or '').lower()
    return {
        'pdf': 'application/pdf', 'png': 'image/png',
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp',
    }.get(ext, 'application/octet-stream')


def _coerce_number(v: Any) -> Optional[float]:
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    cleaned = re.sub(r'[^\d.\-]', '', s.replace(',', ''))
    try:
        return float(cleaned) if cleaned not in ('', '-', '.', '-.') else None
    except ValueError:
        return None


_FIELD_ALIASES = {
    'weighment_name':   ['weighment name', 'weighbridge name', 'weigh bridge', 'station', 'weigh station'],
    'weighment_number': ['weighment no', 'weighment number', 'slip no', 'slip number', 'ticket no',
                         'ticket number', 'receipt no', 'serial no', 'sl no', 's no'],
    'first_weight':     ['first weight', 'gross weight', 'gross wt', 'gross', 'loaded weight'],
    'second_weight':    ['second weight', 'net weight', 'net wt', 'net'],
    'tare_weight':      ['tare weight', 'tare wt', 'tare', 'empty weight', 'empty wt'],
    'vehicle_no':       ['vehicle no', 'vehicle number', 'lorry no', 'truck no', 'reg no', 'registration'],
    'transporter_name': ['transporter', 'transport company', 'transporter name',
                         'transport name', 'carrier', 'lorry owner'],
    'driver_name':      ['driver name', 'driver', 'operator', 'driver/operator'],
    'date':             ['date', 'weighment date', 'slip date'],
    'uom':              ['uom', 'unit', 'unit of measurement', 'units'],
}

# Map common UOM strings the slip might print to the canonical codes the
# Receipt Advice UI dropdown accepts (KG / MTS / TON / QUINTAL / LTR / PCS).
_UOM_ALIASES = {
    'KG': 'KG', 'KGS': 'KG', 'KILO': 'KG', 'KILOS': 'KG', 'KILOGRAM': 'KG', 'KILOGRAMS': 'KG',
    'MT': 'MTS', 'MTS': 'MTS', 'METRIC TON': 'MTS', 'METRIC TONS': 'MTS', 'TONNE': 'MTS', 'TONNES': 'MTS',
    'TON': 'TON', 'TONS': 'TON',
    'QUINTAL': 'QUINTAL', 'QNTL': 'QUINTAL', 'QTL': 'QUINTAL',
    'L': 'LTR', 'LT': 'LTR', 'LTR': 'LTR', 'LITRE': 'LTR', 'LITRES': 'LTR', 'LITER': 'LTR', 'LITERS': 'LTR',
    'PCS': 'PCS', 'PC': 'PCS', 'NOS': 'PCS', 'NO': 'PCS', 'PIECE': 'PCS', 'PIECES': 'PCS',
}


def _normalise_uom(value: str) -> str:
    """Map a free-form UOM string the slip printed to a canonical code."""
    if not value:
        return ''
    raw = re.sub(r'[^\w\s]', ' ', str(value).strip().upper())
    raw = re.sub(r'\s+', ' ', raw).strip()
    if not raw:
        return ''
    return _UOM_ALIASES.get(raw, raw)


def _match_field(label: str) -> str:
    norm = re.sub(r'[^\w\s]', ' ', label.lower()).strip()
    norm = re.sub(r'\s+', ' ', norm)
    best_key = ''
    best_field = ''
    for field, aliases in _FIELD_ALIASES.items():
        for alias in aliases:
            if re.search(rf'\b{re.escape(alias)}\b', norm) and len(alias) > len(best_key):
                best_key = alias
                best_field = field
    return best_field


def _parse_response(text: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        'weighment_name': '', 'weighment_number': '',
        'first_weight': None, 'second_weight': None, 'tare_weight': None,
        'vehicle_no': '', 'transporter_name': '', 'driver_name': '',
        'date': '', 'uom': '',
    }
    numeric = {'first_weight', 'second_weight', 'tare_weight'}
    # If the model didn't emit a UOM line, sniff the surrounding raw text
    # for a unit hint near a weight value. Works for slips that print
    # "Gross Wt : 8520 kg" inline.
    text_upper = text.upper()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith('==='):
            continue
        m = re.match(r'^([^:]{1,80}?)\s*:\s*(.+)$', line)
        if not m:
            continue
        field = _match_field(m.group(1).strip())
        if not field:
            continue
        value = m.group(2).strip()
        if field == 'uom':
            out['uom'] = _normalise_uom(value)
            continue
        if field in numeric:
            out[field] = _coerce_number(value)
        else:
            out[field] = value
    # Derive tare = first - second if missing.
    if out.get('tare_weight') is None and out.get('first_weight') and out.get('second_weight'):
        try:
            out['tare_weight'] = float(out['first_weight']) - float(out['second_weight'])
        except Exception:
            pass
    # UOM fallback: scan the raw text for a unit suffix near a weight value
    # if Gemini didn't emit an explicit "UOM:" line. E.g. slips that print
    # "43650 Kg" inline next to the Gross Wt label.
    if not out.get('uom'):
        # Look for a number followed by a known unit word.
        unit_pat = re.compile(
            r'\d+(?:[.,]\d+)?\s*(KG|KGS|MT|MTS|TON|TONS|QUINTAL|QNTL|QTL|LTR|LITRE|LITRES|LITER|LITERS)\b',
            re.IGNORECASE,
        )
        match = unit_pat.search(text)
        if match:
            out['uom'] = _normalise_uom(match.group(1))
    return out


def _call_gemini(model_name: str, file_bytes: bytes, filename: str) -> Tuple[Optional[str], str]:
    try:
        import google.generativeai as genai  # type: ignore
    except ImportError as exc:
        return None, f'google-generativeai not installed ({exc})'
    api_key = os.environ.get('GEMINI_API_KEY', '').strip()
    if not api_key:
        return None, 'GEMINI_API_KEY not configured'

    import mimetypes as _mt
    INLINE_LIMIT = 20 * 1024 * 1024  # 20 MB

    ext = '.' + filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    mime = _mt.guess_type(filename)[0] or 'application/octet-stream'

    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(model_name)
    except Exception as exc:
        return None, f'Gemini init error: {type(exc).__name__}: {exc}'

    use_inline = len(file_bytes) <= INLINE_LIMIT
    tmp_path = None
    try:
        if use_inline:
            response = generate_logged(
                model,
                [{'mime_type': mime, 'data': file_bytes}, EXTRACTION_PROMPT],
                what='weighment-inline', model_name=model_name,
                request_options={'timeout': 90},
            )
        else:
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
            tmp.write(file_bytes)
            tmp.flush()
            tmp.close()
            tmp_path = tmp.name
            sample = genai.upload_file(path=tmp_path)
            response = generate_logged(
                model, [sample, EXTRACTION_PROMPT],
                what='weighment-filesapi', model_name=model_name,
                request_options={'timeout': 90},
            )
        return getattr(response, 'text', None) or '', 'ok'
    except Exception as exc:
        return None, f'{type(exc).__name__}: {exc}'
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


def _try_extract(model_name: str, file_bytes: bytes, filename: str) -> Dict[str, Any]:
    """Run one weighment extraction attempt against `model_name`."""
    text, status = _call_gemini(model_name, file_bytes, filename)
    if not text:
        return {
            'extraction_status': 'failed',
            'error': status,
            'extracted': {},
            'raw_response': '',
            'model_used': model_name,
        }
    try:
        parsed = _parse_response(text)
    except Exception as exc:
        logger.exception('Weighment parse failed')
        return {
            'extraction_status': 'failed',
            'error': f'parse error: {exc}',
            'extracted': {},
            'raw_response': text[:2000],
            'model_used': model_name,
        }
    has_any = any(parsed.get(k) not in ('', None) for k in parsed)
    return {
        'extraction_status': 'success' if has_any else 'failed',
        'extracted': parsed,
        'raw_response': text[:2000],
        'model_used': model_name,
    }


def extract_weighment(file_bytes: bytes, filename: str) -> Dict[str, Any]:
    primary = (os.environ.get('GEMINI_PRIMARY_MODEL') or 'gemini-2.5-flash-lite').strip()
    # Retry with the heavier model if the lite one fails. Empty env disables.
    fallback_env = os.environ.get('GEMINI_FALLBACK_MODEL')
    fallback = (fallback_env if fallback_env is not None else 'gemini-2.5-flash').strip()

    resp = _try_extract(primary, file_bytes, filename)
    if (
        resp.get('extraction_status') != 'success'
        and fallback
        and fallback.lower() != primary.lower()
    ):
        logger.info('Weighment extraction primary=%s returned %s — retrying with %s',
                    primary, resp.get('extraction_status'), fallback)
        retry = _try_extract(fallback, file_bytes, filename)
        # Use the retry result only if it's strictly better (success > failed).
        if retry.get('extraction_status') == 'success':
            return retry
    return resp

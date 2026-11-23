"""Parse an uploaded bank statement into transaction rows.

Two paths, chosen by file extension:

  CSV / Excel — direct column parsing. Netbanking exports are already clean
  tabular data, and bank statement column names vary a lot bank to bank
  ("Withdrawal Amt." vs "Debit" vs "Dr Amount"), so headers are matched by a
  set of known aliases rather than a fixed position — same idea as
  bank.tally_import._parse_sheet's header detection.

  PDF / image — sent WHOLE to Gemini vision, mirroring this project's proven
  document-extraction pattern (ai_parser.scan_service): no local OCR step,
  just hand the model the raw file and a forced JSON shape. Scanned statement
  layouts vary too much for a fixed-column parser, and there is no working
  local OCR-for-PDF path anywhere in this codebase yet (pdf2image isn't even
  installed) — the vision-LLM route is the only thing that actually works
  today for a genuinely scanned/photographed statement.

Both paths return the same shape: a list of dicts with
{line_no, txn_date (date), narration, reference_no, debit, credit, balance}.
"""
import csv
import io
import json
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from decimal import Decimal, InvalidOperation

import openpyxl
from common.ai_log import generate_logged

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------- #
# Column-header aliases for the CSV/Excel path
# --------------------------------------------------------------------- #
_DATE_ALIASES = ('txn date', 'transaction date', 'value date', 'date')
_NARRATION_ALIASES = ('narration', 'description', 'particulars', 'transaction details', 'details', 'remarks')
_REF_ALIASES = ('chq/ref no', 'chq./ref.no.', 'cheque no', 'reference no', 'ref no', 'ref. no.', 'utr', 'transaction id', 'chq no')
_DEBIT_ALIASES = ('debit', 'withdrawal amt', 'withdrawal amt.', 'withdrawal', 'debit amount', 'dr amount')
_CREDIT_ALIASES = ('credit', 'deposit amt', 'deposit amt.', 'deposit', 'credit amount', 'cr amount')
_BALANCE_ALIASES = ('balance', 'closing balance', 'available balance', 'running balance')
_AMOUNT_ALIASES = ('amount',)
_DRCR_ALIASES = ('dr/cr', 'type', 'txn type', 'transaction type')


def _norm(s):
    return re.sub(r'\s+', ' ', str(s or '').strip().lower())


def _find_col(headers, aliases):
    for i, h in enumerate(headers):
        if h in aliases:
            return i
    # Loose fallback: substring match, for headers with extra punctuation.
    for i, h in enumerate(headers):
        if any(a in h for a in aliases):
            return i
    return None


def _is_header_row(low):
    """low: a row's cells, already _norm'd. True if it names a date column AND
    at least one money column (debit, credit, or a single signed amount).

    Uses _find_col so the SAME exact+substring matching that later reads the
    columns also finds the header row. Real bank exports suffix their headers
    ('Withdrawal Amt (INR)', 'Deposit Amt (INR)', 'Value Date'), which an
    exact-equality test misses — that mismatch made otherwise-valid ICICI/HDFC
    workbooks fail with 'no recognisable date/amount columns'."""
    return _find_col(low, _DATE_ALIASES) is not None and (
        _find_col(low, _DEBIT_ALIASES) is not None
        or _find_col(low, _CREDIT_ALIASES) is not None
        or _find_col(low, _AMOUNT_ALIASES) is not None
    )


def _dec(v):
    if v in (None, ''):
        return Decimal('0')
    s = str(v).replace(',', '').replace('₹', '').replace('Rs.', '').replace('Rs', '').strip()
    if s in ('', '-'):
        return Decimal('0')
    neg = s.startswith('(') and s.endswith(')')
    if neg:
        s = s[1:-1]
    try:
        d = Decimal(s)
    except InvalidOperation:
        return Decimal('0')
    return -d if neg else d


_DATE_FORMATS = ('%Y-%m-%d', '%d-%m-%Y', '%d/%m/%Y', '%d-%b-%Y', '%d-%b-%y',
                  '%d/%b/%Y', '%d/%b/%y', '%d %b %Y', '%m/%d/%Y', '%Y/%m/%d')


def _pdate(v):
    if v is None or v == '':
        return None
    if isinstance(v, datetime):
        return v.date()
    if hasattr(v, 'year') and hasattr(v, 'month'):  # datetime.date
        return v
    s = str(v).strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _rows_to_lines(rows):
    """rows: list of {header_lower: raw_value}. -> parsed line dicts, skipping
    header/footer/blank rows that don't carry a real transaction."""
    if not rows:
        return []
    headers = list(rows[0].keys())
    c_date = _find_col(headers, _DATE_ALIASES)
    c_narr = _find_col(headers, _NARRATION_ALIASES)
    c_ref = _find_col(headers, _REF_ALIASES)
    c_debit = _find_col(headers, _DEBIT_ALIASES)
    c_credit = _find_col(headers, _CREDIT_ALIASES)
    c_balance = _find_col(headers, _BALANCE_ALIASES)
    c_amount = _find_col(headers, _AMOUNT_ALIASES)
    c_drcr = _find_col(headers, _DRCR_ALIASES)
    if c_date is None or (c_debit is None and c_credit is None and c_amount is None):
        return []

    out = []
    for row in rows:
        vals = list(row.values())
        date = _pdate(vals[c_date] if c_date < len(vals) else None)
        if date is None:
            continue
        debit = _dec(vals[c_debit]) if c_debit is not None and c_debit < len(vals) else Decimal('0')
        credit = _dec(vals[c_credit]) if c_credit is not None and c_credit < len(vals) else Decimal('0')
        if c_debit is None and c_credit is None and c_amount is not None:
            amt = _dec(vals[c_amount]) if c_amount < len(vals) else Decimal('0')
            drcr = _norm(vals[c_drcr]) if c_drcr is not None and c_drcr < len(vals) else ''
            if amt < 0 or drcr.startswith('d'):
                debit, credit = abs(amt), Decimal('0')
            else:
                debit, credit = Decimal('0'), abs(amt)
        if debit == 0 and credit == 0:
            continue
        out.append({
            'txn_date': date,
            'narration': str(vals[c_narr]).strip() if c_narr is not None and c_narr < len(vals) and vals[c_narr] else '',
            'reference_no': str(vals[c_ref]).strip() if c_ref is not None and c_ref < len(vals) and vals[c_ref] else '',
            'debit': debit,
            'credit': credit,
            'balance': _dec(vals[c_balance]) if c_balance is not None and c_balance < len(vals) and vals[c_balance] not in (None, '') else None,
        })
    for i, line in enumerate(out, start=1):
        line['line_no'] = i
    return out


def _parse_csv(file_obj):
    raw = file_obj.read()
    text = raw.decode('utf-8-sig') if isinstance(raw, bytes) else raw
    reader = csv.reader(io.StringIO(text))
    all_rows = [r for r in reader if any(c.strip() for c in r)]
    header_idx = None
    for i, r in enumerate(all_rows):
        if _is_header_row([_norm(c) for c in r]):
            header_idx = i
            break
    if header_idx is None:
        return []
    headers = [_norm(c) for c in all_rows[header_idx]]
    rows = [dict(zip(headers, r)) for r in all_rows[header_idx + 1:] if len(r) >= 2]
    return _rows_to_lines(rows)


def _read_all_rows(file_obj, read_only):
    """Every non-blank row across all sheets, as lists. read_only=True is memory-
    cheap but TRUSTS the sheet's declared <dimension>; read_only=False recomputes
    the real used range."""
    wb = openpyxl.load_workbook(file_obj, read_only=read_only, data_only=True)
    try:
        out = []
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            out.append((sheet_name,
                        [list(r) for r in ws.iter_rows(values_only=True)
                         if any(c not in (None, '') for c in r)]))
        return out
    finally:
        wb.close()


def _parse_excel(file_obj):
    # Read cheaply first (read_only). ICICI's "Detailed Statement" export, though,
    # LIES about its size — it writes <dimension ref="A1"/> while really holding
    # hundreds of rows, and read_only mode obeys that false dimension and yields an
    # almost-empty sheet, so the date/amount header row is never found ("no
    # recognisable date/amount columns"). When the cheap read finds no usable rows,
    # retry WITHOUT read_only, which recomputes the true used range and reads the
    # real rows. Bank statements are small, so the fallback is safe on 512 MB.
    for read_only in (True, False):
        try:
            file_obj.seek(0)
        except Exception:  # noqa: BLE001
            pass
        for _sheet_name, all_rows in _read_all_rows(file_obj, read_only):
            header_idx = None
            for i, r in enumerate(all_rows):
                if _is_header_row([_norm(c) for c in r]):
                    header_idx = i
                    break
            if header_idx is None:
                continue
            headers = [_norm(c) for c in all_rows[header_idx]]
            rows = [dict(zip(headers, r)) for r in all_rows[header_idx + 1:]]
            lines = _rows_to_lines(rows)
            if lines:
                return lines
    return []


# --------------------------------------------------------------------- #
# PDF / image path — Gemini vision, mirrors ai_parser.scan_service
# --------------------------------------------------------------------- #
STATEMENT_PROMPT = (
    'You are reading a bank account statement (may be a clean export or a '
    'scanned/photographed page) for an Indian business. Extract EVERY '
    'transaction row in order: the date, the narration/description/'
    'particulars text, any cheque/UTR/reference number shown, the debit '
    '(withdrawal) amount, the credit (deposit) amount, and the running '
    'balance if a balance column is shown. Exactly one of debit/credit is '
    'non-zero per row — never both. Read amounts as plain numbers with no '
    'currency symbols or thousands separators — read Indian-formatted '
    'numbers with 4+ comma groups (crore-scale, e.g. "5,30,00,000.00") with '
    'extra care and double-check the digit count; these are the amounts '
    'most often misread by adding a spurious digit. Use YYYY-MM-DD for '
    'dates (the statement may show DD/MM/YY or DD-Mon-YYYY — convert it). '
    'Also extract the account\'s opening/brought-forward balance shown '
    'before the first transaction (e.g. a "B/F" row) as "opening_balance" — '
    'do not include that row itself as a transaction. Skip any other '
    'non-transaction summary rows. Return ONLY a JSON object of this exact '
    'shape — no markdown, no code fences, no commentary:\n'
    '{"opening_balance":0,"transactions":[{"date":"YYYY-MM-DD","narration":"",'
    '"reference_no":"","debit":0,"credit":0,"balance":0}]}'
)


def _media_type(filename, content_type=''):
    ct = (content_type or '').lower()
    if ct:
        return ct
    name = (filename or '').lower()
    if name.endswith('.pdf'):
        return 'application/pdf'
    if name.endswith('.png'):
        return 'image/png'
    if name.endswith(('.jpg', '.jpeg')):
        return 'image/jpeg'
    if name.endswith('.webp'):
        return 'image/webp'
    return 'application/pdf'


def _loads(s):
    # strict=False accepts literal control characters (raw newlines, tabs)
    # inside string values — Gemini has been seen embedding these in
    # narration text despite being asked for single-line JSON, which the
    # default strict json.loads rejects outright as "Invalid control
    # character".
    try:
        return json.loads(s, strict=False)
    except (json.JSONDecodeError, ValueError):
        return None


def _iter_top_level_objects(s, start):
    """Yield each complete top-level {...} object inside a JSON array whose
    '[' ends at index `start`, stopping at the first incomplete one. String-
    literal aware so a stray brace inside a narration value doesn't miscount
    nesting depth."""
    depth = 0
    obj_start = None
    in_string = False
    escape = False
    i = start
    while i < len(s):
        ch = s[i]
        if in_string:
            if escape:
                escape = False
            elif ch == '\\':
                escape = True
            elif ch == '"':
                in_string = False
        else:
            if ch == '"':
                in_string = True
            elif ch == '{':
                if depth == 0:
                    obj_start = i
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0 and obj_start is not None:
                    yield s[obj_start:i + 1]
                    obj_start = None
            elif ch == ']' and depth == 0:
                return
        i += 1


def _salvage_truncated(s):
    """The response looks like our JSON shape but won't parse as a whole —
    most often because generation was cut off mid-array on a long statement
    (confirmed live: two near-miss "504 Stream cancelled" timeouts on this
    exact file right before this failure, i.e. Gemini was already straining
    on it). Keep every complete transaction object seen before the cut-off
    instead of discarding the whole response; the caller flags the result
    as partial so it's never mistaken for a complete read."""
    m = re.search(r'"transactions"\s*:\s*\[', s)
    if not m:
        return None
    objects = [o for o in (_loads(c) for c in _iter_top_level_objects(s, m.end())) if isinstance(o, dict)]
    if not objects:
        return None
    result = {'transactions': objects, '_truncated': True}
    ob_match = re.search(r'"opening_balance"\s*:\s*(-?[0-9.]+)', s)
    if ob_match:
        result['opening_balance'] = ob_match.group(1)
    return result


def _json_response(text):
    """Parse the {"opening_balance":..., "transactions":[...]} JSON out of a
    model text response. Returns the dict, or None if unrecoverable."""
    t = text.strip()
    t = re.sub(r'^```(?:json)?', '', t).strip()
    t = re.sub(r'```$', '', t).strip()
    obj = _loads(t)
    if isinstance(obj, dict):
        return obj
    m = re.search(r'\{[\s\S]*\}', t)
    body = m.group(0) if m else t
    obj = _loads(body)
    if not isinstance(obj, dict):
        # A trailing comma before a closing bracket is a common near-miss —
        # cheap to strip and retry before giving up on it as malformed.
        obj = _loads(re.sub(r',\s*([}\]])', r'\1', body))
    if not isinstance(obj, dict):
        obj = _salvage_truncated(body)
    return obj if isinstance(obj, dict) else None


# A number this large (8+ digits, i.e. crore-and-above in Indian notation —
# "5,30,00,000" has 4 comma groups) is where Gemini vision has been observed
# to insert a spurious extra digit — confirmed live: "5,30,00,000.00"
# (53,00,000 -> 53000000) came back as 530000000.00, an exact 10x error,
# while every 7-digit-or-smaller amount in the same document parsed
# correctly. Below this threshold the correction pass never applies.
_CRORE_SCALE = Decimal('10000000')


def _reconcile_balance_chain(lines, opening_balance):
    """Cross-check each parsed amount against the statement's own running
    balance (balance[i] - balance[i-1] must equal the signed amount) and
    correct the specific known failure mode above when it's detected: divide
    the misread amount (and, if it shows the same corruption, the balance
    that resulted from it) by 10 when doing so makes the chain reconcile
    within a paisa. Never guesses beyond that exact, verified correction —
    an amount that simply doesn't reconcile for some other reason is left
    alone (the reconciliation matcher will surface it as unmatched instead
    of silently mis-stating a figure this tool can't actually verify).

    Corrections are noted in `match_notes` up front so a corrected line is
    never mistaken for one Gemini read cleanly.
    """
    tol = Decimal('1')
    prev_balance = opening_balance
    for line in lines:
        amount = line['debit'] or line['credit']
        is_debit = bool(line['debit'])
        balance = line.get('balance')
        if prev_balance is None or balance is None or amount == 0:
            prev_balance = balance if balance is not None else prev_balance
            continue
        signed_actual = -amount if is_debit else amount
        expected = balance - prev_balance
        if abs(signed_actual - expected) > tol:
            corrected_amount = (amount / 10).quantize(Decimal('0.01'))
            corrected_signed = -corrected_amount if is_debit else corrected_amount
            if amount >= _CRORE_SCALE and abs(corrected_signed - expected) <= tol:
                # The amount alone explains the whole gap — balance was fine.
                note = f'Amount corrected from {amount} to {corrected_amount} (balance-column cross-check)'
                if is_debit:
                    line['debit'] = corrected_amount
                else:
                    line['credit'] = corrected_amount
                line['match_notes'] = note
                balance_for_next = balance
            elif balance >= _CRORE_SCALE and abs(signed_actual - ((balance / 10).quantize(Decimal('0.01')) - prev_balance)) <= tol:
                # The balance alone was misread — amount was fine.
                corrected_balance = (balance / 10).quantize(Decimal('0.01'))
                line['match_notes'] = f'Balance corrected from {balance} to {corrected_balance} (running-total cross-check)'
                line['balance'] = corrected_balance
                balance_for_next = corrected_balance
            elif amount >= _CRORE_SCALE and abs(corrected_signed - ((balance / 10).quantize(Decimal('0.01')) - prev_balance)) <= tol:
                # Both the amount and its own resulting balance were misread together.
                corrected_balance = (balance / 10).quantize(Decimal('0.01'))
                if is_debit:
                    line['debit'] = corrected_amount
                else:
                    line['credit'] = corrected_amount
                line['balance'] = corrected_balance
                line['match_notes'] = f'Amount and balance both corrected /10 (was {amount} / {balance}) — balance-column cross-check'
                balance_for_next = corrected_balance
            else:
                # Doesn't reconcile and isn't the known /10 pattern — leave as
                # parsed rather than guess; it'll surface as unmatched.
                balance_for_next = balance
        else:
            balance_for_next = balance
        prev_balance = balance_for_next
    return lines


# A multi-page statement can take Gemini a while, and its own infrastructure
# occasionally drops the stream outright rather than returning slowly —
# confirmed live: "504 Stream cancelled; RPC from prefill servable to decode
# servable failed" twice in a row on the same file, ~183s in both times,
# i.e. right at the old 180s budget with zero margin.
_TRANSIENT_MARKERS = ('504', 'stream cancelled', 'deadline exceeded', 'unavailable', 'reset by peer', 'timeout')


def _gemini_extract_once(model, generation_config, raw_bytes, filename, content_type):
    """One extraction call, retried once for a transient infra failure.
    Returns (txns_raw, opening_balance_raw, error, truncated):
      - on a hard failure: ([], None, error_str, False)
      - on a truncated-but-otherwise-fine response: ([], None, error_str, True)
        (error_str here is diagnostic, not necessarily shown to the user —
        the caller decides whether to retry via chunking first)
      - on success: (transactions_list, opening_balance_raw_or_None, '', False)
    """
    text, last_err, truncated_by_length = '', None, False
    for attempt in range(2):
        try:
            resp = generate_logged(
                model,
                [{'mime_type': _media_type(filename, content_type), 'data': raw_bytes}, STATEMENT_PROMPT],
                what='bank-statement',
                generation_config=generation_config,
                request_options={'timeout': 280},
            )
            text = (getattr(resp, 'text', '') or '').strip()
            try:
                finish_reason = resp.candidates[0].finish_reason
                truncated_by_length = getattr(finish_reason, 'name', str(finish_reason)) == 'MAX_TOKENS'
            except (IndexError, AttributeError):
                truncated_by_length = False
            last_err = None
            break
        except Exception as e:  # noqa: BLE001 — surface as a parse error, never crash the upload
            last_err = e
            transient = any(m in str(e).lower() for m in _TRANSIENT_MARKERS)
            logger.exception('gemini bank-statement extract failed (attempt %d, transient=%s)', attempt + 1, transient)
            if not transient or attempt == 1:
                break
    if last_err is not None:
        return [], None, f'Gemini error: {last_err}', False
    if not text:
        return [], None, 'empty response from Gemini', False
    resp_obj = _json_response(text)
    if resp_obj is None:
        # Log the full text for server-side diagnosis, but also surface a
        # snippet directly in the error that reaches the UI — this failure
        # was previously a dead end without shell/log access.
        logger.error('bank-statement Gemini response was not parseable JSON (%d chars): %s', len(text), text[:4000])
        snippet = text[:400].replace('\n', ' ').strip()
        return [], None, f'could not parse JSON from Gemini response — it started with: "{snippet}"', False
    if truncated_by_length or resp_obj.get('_truncated'):
        n = len(resp_obj.get('transactions', []))
        logger.warning('bank-statement Gemini response was truncated after %d transaction(s) (%d chars)', n, len(text))
        return [], None, f'cut off after {n} row(s)', True
    return resp_obj.get('transactions', []), resp_obj.get('opening_balance'), '', False


def _split_pdf_pages(raw_bytes, pages_per_chunk=3):
    """Split a PDF into consecutive `pages_per_chunk`-page chunks, each as
    standalone PDF bytes Gemini can read on its own. Pure-Python via pypdf —
    no poppler/external binary dependency."""
    from pypdf import PdfReader, PdfWriter
    reader = PdfReader(io.BytesIO(raw_bytes))
    chunks = []
    for start in range(0, len(reader.pages), pages_per_chunk):
        writer = PdfWriter()
        for page in reader.pages[start:start + pages_per_chunk]:
            writer.add_page(page)
        buf = io.BytesIO()
        writer.write(buf)
        chunks.append(buf.getvalue())
    return chunks


def _extract_pdf_in_chunks(model, generation_config, raw_bytes, filename):
    """Fallback when a single-shot read of the whole PDF got cut off —
    confirmed live on a dense multi-page statement that still hit the
    model's output-token ceiling even after it was raised to the max
    (65536) and even after JSON mode was forced. Splitting the source PDF
    into page ranges and reading each separately keeps each individual
    response well within budget. Each row already carries the statement's
    own absolute running balance (not reset per chunk), so the chunks can
    just be concatenated in page order and reconciled as one sequence
    afterwards — only the very first chunk can see the statement's real
    opening/brought-forward balance, so that's the only one kept.

    Chunks are fetched CONCURRENTLY, not one after another — this whole
    parse already runs synchronously inside the upload request/response
    cycle, and a sequential fallback (each chunk its own up-to-280s-times-2
    retry budget) turned a several-page statement into a multi-minute
    request that got killed mid-flight before it could even record an
    error (confirmed live: a stuck PENDING row with created_at==updated_at,
    i.e. the process died before reaching any save() call at all). Fetching
    in parallel keeps the wall-clock close to a single chunk's time instead
    of the sum of all of them.

    Returns (all_txns, opening_balance_raw) on full success, or None if
    chunking doesn't help either (caller falls back to the original error)."""
    try:
        chunks = _split_pdf_pages(raw_bytes)
    except Exception:
        logger.exception('failed to split PDF into page chunks for a truncation retry')
        return None
    if len(chunks) <= 1:
        return None  # already as small as it gets — nothing to gain

    results = [None] * len(chunks)
    with ThreadPoolExecutor(max_workers=min(len(chunks), 4)) as executor:
        future_to_index = {
            executor.submit(_gemini_extract_once, model, generation_config, chunk_bytes, filename, 'application/pdf'): i
            for i, chunk_bytes in enumerate(chunks)
        }
        for future in future_to_index:
            results[future_to_index[future]] = future.result()

    all_txns, opening_balance = [], None
    for i, (txns, ob, err, truncated) in enumerate(results):
        if err or truncated:
            logger.error('chunked bank-statement extraction still failed on chunk %d/%d: %s', i + 1, len(chunks), err)
            return None
        if i == 0:
            opening_balance = ob
        all_txns.extend(txns)
    return all_txns, opening_balance


def _parse_with_gemini(raw_bytes, filename, content_type=''):
    """Primary/fallback wrapper — tries the cheap model first (including its
    own truncation/chunking retry below) and only pays for the heavier model
    when the cheap one comes back with nothing. Same pattern as
    receipt_gemini_extractor.extract_receipt(); own var pair (not
    GEMINI_PRIMARY_MODEL/GEMINI_FALLBACK_MODEL) so this can be tuned
    independently of receipts/weighment, matching scan_service.py."""
    primary = os.environ.get('AI_SCAN_GEMINI_MODEL', 'gemini-2.5-flash-lite').strip()
    fallback_env = os.environ.get('AI_SCAN_GEMINI_FALLBACK_MODEL')
    fallback = (fallback_env if fallback_env is not None else 'gemini-2.5-flash').strip()

    out, err = _parse_with_gemini_once(raw_bytes, filename, primary, content_type)
    if not out and fallback and fallback.lower() != primary.lower():
        logger.info('Bank-statement extraction primary=%s returned %r — retrying with %s',
                     primary, err, fallback)
        f_out, f_err = _parse_with_gemini_once(raw_bytes, filename, fallback, content_type)
        if f_out:
            return f_out, f_err
    return out, err


def _parse_with_gemini_once(raw_bytes, filename, model_name, content_type=''):
    try:
        import google.generativeai as genai
    except ImportError:
        return [], 'google-generativeai not installed'
    api_key = os.environ.get('GEMINI_API_KEY', '').strip()
    if not api_key:
        return [], 'GEMINI_API_KEY not set — cannot OCR a PDF/image statement'
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(model_name)
    # Force strict JSON output and ask for the model's maximum output budget
    # explicitly — confirmed live: a dense multi-page statement was silently
    # cut off after its first day's worth of rows (16 of what should have
    # been 300+) while still producing syntactically valid, well-formed
    # JSON, so this was NOT caught by JSON-parse-failure handling at all —
    # the upload showed a clean "PARSED" status with a fraction of the real
    # data. This alone doesn't guarantee no cut-off, so it's paired with the
    # finish_reason check in _gemini_extract_once, which is the only
    # reliable signal.
    generation_config = genai.GenerationConfig(response_mime_type='application/json', max_output_tokens=65536)

    txns, opening_balance_raw, err, truncated = _gemini_extract_once(model, generation_config, raw_bytes, filename, content_type)
    if truncated:
        # A statement reconciliation report that silently shows a fraction
        # of the real data as if it were complete is worse than one that
        # fails outright — it looks trustworthy (clean PARSED status, tidy
        # matched/unmatched counts) while actually missing most of the
        # document, which surfaces as false "Tally has this, statement
        # doesn't" gaps for transactions that were genuinely on the
        # statement but never read. So a still-truncated result (chunking
        # failed or wasn't applicable) is a hard failure, not a
        # partial-success-with-a-note.
        chunked = _extract_pdf_in_chunks(model, generation_config, raw_bytes, filename) \
            if _media_type(filename, content_type) == 'application/pdf' else None
        if chunked is None:
            return [], (
                f'The statement was too long for a single AI read — it {err}. '
                'Re-upload the same file to retry, or split a very long statement into smaller date '
                'ranges if this keeps happening.'
            )
        txns, opening_balance_raw = chunked
    elif err:
        return [], err

    opening_balance = _dec(opening_balance_raw) if opening_balance_raw not in (None, '') else None
    out = []
    for t in txns:
        date = _pdate(t.get('date'))
        if date is None:
            continue
        debit, credit = _dec(t.get('debit')), _dec(t.get('credit'))
        if debit == 0 and credit == 0:
            continue
        out.append({
            'txn_date': date,
            'narration': str(t.get('narration') or '').strip(),
            'reference_no': str(t.get('reference_no') or '').strip(),
            'debit': debit,
            'credit': credit,
            'balance': _dec(t.get('balance')) if t.get('balance') not in (None, '') else None,
        })
    out = _reconcile_balance_chain(out, opening_balance)
    for i, line in enumerate(out, start=1):
        line['line_no'] = i
        line.setdefault('match_notes', '')
    return out, ('' if out else 'no transactions recognised in the file')


# --------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------- #
def parse_statement_file(django_file):
    """django_file: a Django FieldFile/UploadedFile. -> (lines, error)."""
    name = (django_file.name or '').lower()
    django_file.open('rb')
    try:
        if name.endswith('.csv'):
            lines = _parse_csv(django_file)
            return (lines, '') if lines else ([], 'no recognisable date/amount columns found in the CSV')
        if name.endswith(('.xlsx', '.xls')):
            lines = _parse_excel(django_file)
            return (lines, '') if lines else ([], 'no recognisable date/amount columns found in the workbook')
        # PDF / image — vision path. Also the fallback for anything else.
        raw = django_file.read()
        content_type = getattr(django_file, 'content_type', '') or ''
        lines, err = _parse_with_gemini(raw, name, content_type)
        return lines, err
    finally:
        django_file.close()

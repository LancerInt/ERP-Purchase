"""One log line per Gemini call — model, tokens, duration, outcome.

WHY THIS EXISTS
---------------
Nothing was logged when a Gemini call SUCCEEDED. The failure paths shouted
(`gemini scan extract failed`, `Gemini error: ...`), but a normal day left no
trace at all, so "how many calls did we make, on which model, and what did
they cost?" could only be answered from AI Studio's Usage page — aggregate
numbers, a day late, with no way to tie a spike back to a particular upload.
AI Studio's Logs tab stays empty because prompt logging is opt-in and off.

After this, the answer is in Render's own log stream:

    GEMINI scan-extract model=gemini-2.5-flash-lite in=1874 out=423 total=2297 2.41s ok
    GEMINI bank-statement model=gemini-2.5-flash in=9102 out=5561 total=14663 11.08s ok
    GEMINI receipt model=gemini-2.5-flash-lite FAILED 0.84s ResourceExhausted: 429 quota exceeded

Grep `GEMINI` for every call, `GEMINI.*FAILED` for the bad ones, and
`GEMINI <label>` for one feature (scan-extract, bank-statement, receipt,
quote-inline, quote-filesapi, weighment, email-bill, po-extraction,
product-match, invoice-check, customer-match, speech-translate,
scan-translate, ai-parser-llm). The token columns are the actual billable
figures the SDK reports (usage_metadata), not an estimate, so summing
total= over a day gives the real spend driver; a label appearing far more
often than expected is the thing to look at first.

This is the only server-side record. apps/sales/views.py also collects
per-call tokens into `meta.gemini_calls` on its PO-upload response, but
that goes to the BROWSER console and is gone when the tab closes — those
call sites log here as well so the data survives.

Logged at INFO on the 'perf' logger, which render.py already routes to
stdout — same place the PERF request lines land, so a slow page and the
model call underneath it sit side by side.

DELIBERATELY NOT LOGGED: the prompt or the response text. These documents
are vendor invoices and bank statements; putting their contents in a log
stream would spread the very data the rest of the app is careful with.
Sizes and counts are enough to answer the cost and volume questions.
"""
import logging
import time

logger = logging.getLogger('perf')


def _usage(response):
    """(prompt, candidates, total) token counts, or Nones when they are not
    available — older models and some error shapes omit usage_metadata, and
    on some response objects it is a property that raises. Swallowing that
    here (rather than at the call site) means an odd response still gets a
    log line with its model and duration, just with '?' for the tokens,
    instead of vanishing from the log entirely."""
    try:
        meta = getattr(response, 'usage_metadata', None)
        if meta is None:
            return None, None, None
        return (getattr(meta, 'prompt_token_count', None),
                getattr(meta, 'candidates_token_count', None),
                getattr(meta, 'total_token_count', None))
    except Exception:  # noqa: BLE001 — tokens are nice to have, not essential
        return None, None, None


def _name_of(model, model_name):
    """The model id for the log line.

    Call sites that already have the name in hand pass it; the rest let it
    come off the SDK object, which reports it as 'models/gemini-2.5-flash'
    — the prefix is stripped so a log line matches the name used in env
    vars and in AI Studio.
    """
    if model_name:
        return str(model_name).replace('models/', '')
    raw = getattr(model, 'model_name', None) or getattr(model, '_model_name', None)
    return str(raw).replace('models/', '') if raw else '?'


def generate_logged(model, contents, *, what, model_name=None, **kwargs):
    """model.generate_content(...) with a log line either way.

    Returns exactly what generate_content returns and re-raises whatever it
    raises — callers keep their own error handling, this only observes. A
    failure inside the logging itself must never break an extraction, so the
    bookkeeping is wrapped too.

    `what` labels the call site (scan-extract, bank-statement, receipt...)
    so one grep can separate invoice OCR from bank parsing from translation.
    """
    started = time.time()
    model_name = _name_of(model, model_name)
    try:
        response = model.generate_content(contents, **kwargs)
    except Exception as exc:  # noqa: BLE001 — logged, then re-raised untouched
        try:
            # Type alone would not separate a quota 429 from a timeout,
            # and several call sites swallow the exception into a return
            # value without logging it, so this line has to stand on its
            # own. Truncated: an SDK error can carry a long payload dump,
            # and only the leading reason is diagnostic.
            logger.info('GEMINI %s model=%s FAILED %.2fs %s: %s',
                        what, model_name, time.time() - started,
                        type(exc).__name__,
                        ' '.join(str(exc).split())[:160])
        except Exception:  # noqa: BLE001
            pass
        raise
    try:
        took = time.time() - started
        prompt_tokens, out_tokens, total_tokens = _usage(response)
        logger.info('GEMINI %s model=%s in=%s out=%s total=%s %.2fs ok',
                    what, model_name,
                    prompt_tokens if prompt_tokens is not None else '?',
                    out_tokens if out_tokens is not None else '?',
                    total_tokens if total_tokens is not None else '?',
                    took)
    except Exception:  # noqa: BLE001 — never let logging break a good result
        pass
    return response

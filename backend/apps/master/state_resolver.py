"""Helpers for state-aware price-line lookup.

Two responsibilities:

1. `resolve_state_code(addr)` — given a buyer's address (free text or a
   dict like what Gemini emits during CPO extraction), return the ISO
   3166-2:IN two-letter state code (TN, KA, …). We try the address's
   explicit state field first, then the pincode prefix, then a substring
   match against the state-name dictionary. Returns '' when nothing
   matched — the resolver in the price-line lookup then falls back to
   the customer-wide default line.

2. `best_state_group_for(state_code, queryset)` — pick the most specific
   StateGroup whose member_states contains `state_code`. "Specific" =
   fewest members. So "Tamilnadu, Pondicherry & Karnataka" (3 members)
   wins over "South States" (~6). When two groups tie, the alphabetically
   first wins — deterministic across runs but the user can rename to
   force a different pick.

These are pure functions (no DB hits in `resolve_state_code`, just a
queryset filter in `best_state_group_for`) so they're safe to call from
inside a hot extraction loop.
"""
from __future__ import annotations


# ISO 3166-2:IN codes. Keep names lower-cased + stripped for matching.
STATE_NAMES = {
    'andhra pradesh':            'AP',
    'arunachal pradesh':         'AR',
    'assam':                     'AS',
    'bihar':                     'BR',
    'chhattisgarh':              'CG',
    'goa':                       'GA',
    'gujarat':                   'GJ',
    'haryana':                   'HR',
    'himachal pradesh':          'HP',
    'jharkhand':                 'JH',
    'karnataka':                 'KA',
    'kerala':                    'KL',
    'madhya pradesh':            'MP',
    'maharashtra':               'MH',
    'manipur':                   'MN',
    'meghalaya':                 'ML',
    'mizoram':                   'MZ',
    'nagaland':                  'NL',
    'odisha':                    'OD',
    'orissa':                    'OD',  # alternate spelling
    'punjab':                    'PB',
    'rajasthan':                 'RJ',
    'sikkim':                    'SK',
    'tamil nadu':                'TN',
    'tamilnadu':                 'TN',  # PDF often writes it as one word
    'telangana':                 'TG',
    'tripura':                   'TR',
    'uttar pradesh':             'UP',
    'uttarakhand':               'UK',
    'west bengal':               'WB',
    # UTs
    'andaman and nicobar islands': 'AN',
    'chandigarh':                  'CH',
    'dadra and nagar haveli':      'DN',
    'daman and diu':               'DD',
    'delhi':                       'DL',
    'jammu and kashmir':           'JK',
    'ladakh':                      'LA',
    'lakshadweep':                 'LD',
    'puducherry':                  'PY',
    'pondicherry':                 'PY',  # PDF's preferred spelling
}

# Map of two-letter codes back to display names. Useful when an upstream
# system passes us a state code and we want to log/print a name.
STATE_CODE_TO_NAME = {code: name.title() for name, code in STATE_NAMES.items()}

# Pincode first-digit ranges. India PIN codes are deterministic at the
# region level but only at the FULL six-digit level for state — we keep
# a small range table so the common buckets resolve correctly. Anything
# ambiguous (e.g. 8xxxxx covers several NE states) returns '' so the
# caller falls back to the state-name match.
#
# Source: India Post pincode region scheme.
#   1xx — Delhi, Haryana, Punjab, HP, J&K
#   2xx — Uttar Pradesh, Uttarakhand
#   3xx — Rajasthan, Gujarat
#   4xx — Maharashtra, MP, Chhattisgarh, Goa
#   5xx — AP, Telangana, Karnataka
#   6xx — Tamil Nadu, Kerala, Puducherry, Lakshadweep
#   7xx — West Bengal, Odisha, NE states
#   8xx — Bihar, Jharkhand
# The two-digit prefix narrows it further; we only encode the prefixes
# we can resolve UNAMBIGUOUSLY to a single state.
PINCODE_PREFIX_TO_STATE = {
    '11': 'DL',
    '12': 'HR', '13': 'HR',
    '14': 'PB', '15': 'PB', '16': 'PB',
    '17': 'HP',
    '18': 'JK', '19': 'JK',
    '20': 'UP', '21': 'UP', '22': 'UP', '23': 'UP', '25': 'UP',
    '26': 'UP', '27': 'UP', '28': 'UP',
    '24': 'UK',  # narrower than 2x→UP — fewer collisions in practice
    '30': 'RJ', '31': 'RJ', '32': 'RJ', '33': 'RJ', '34': 'RJ',
    '36': 'GJ', '37': 'GJ', '38': 'GJ', '39': 'GJ',
    '40': 'MH', '41': 'MH', '42': 'MH', '43': 'MH', '44': 'MH',
    '45': 'MP', '46': 'MP', '47': 'MP', '48': 'MP',
    '49': 'CG',
    '50': 'TG', '51': 'AP', '52': 'AP', '53': 'AP',
    '56': 'KA', '57': 'KA', '58': 'KA', '59': 'KA',
    '60': 'TN', '61': 'TN', '62': 'TN', '63': 'TN', '64': 'TN',
    '65': 'TN', '66': 'TN',
    '67': 'KL', '68': 'KL', '69': 'KL',
    '70': 'WB', '71': 'WB', '72': 'WB', '73': 'WB', '74': 'WB',
    '75': 'OD', '76': 'OD', '77': 'OD',
    '78': 'AS',
    '80': 'BR', '81': 'BR', '82': 'BR', '83': 'BR', '84': 'BR',
    '85': 'JH',
}

# GST state-code prefixes (first two digits of a GSTIN) → the same
# two-letter codes STATE_NAMES / resolve_state_code use, so the two
# compose. Unlike pincodes this mapping is exact by construction —
# the GST registration encodes the state deterministically.
#
# Source: standard GST state-code list. Note Telangana is 'TG' here
# (matching STATE_NAMES above), even though GSTN documents often
# print it as 'TS'.
GSTIN_PREFIX_TO_STATE = {
    '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK',
    '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR',
    '11': 'SK', '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ',
    '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH',
    '21': 'OD', '22': 'CG', '23': 'MP', '24': 'GJ', '26': 'DD',
    '27': 'MH', '28': 'AP', '29': 'KA', '30': 'GA', '31': 'LD',
    '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TG',
    '37': 'AP', '38': 'LA',
}


def state_code_from_gstin(gstin) -> str:
    """Two-letter state code from a GSTIN's 2-digit prefix, or '' when
    the value is missing / doesn't start with two digits / uses a code
    we don't recognise. Same code format as `resolve_state_code`."""
    g = str(gstin or '').strip()
    if len(g) >= 2 and g[:2].isdigit():
        return GSTIN_PREFIX_TO_STATE.get(g[:2], '')
    return ''


def _norm(text):
    if not text:
        return ''
    return str(text).strip().lower()


def resolve_state_code(addr) -> str:
    """Best-effort extraction of an ISO 3166-2:IN state code from a
    buyer address. Accepts:

    - a dict with optional `state` / `state_code` / `pincode` / `line1`
      / `raw_address` keys (the shape Gemini emits for CPO extraction
      and what `parse_address` returns).
    - a free-text string (one of the address fields concatenated, or
      the consignee_address text from CustomerPOUpload).

    Returns the two-letter code, or '' if nothing matched.
    """
    if addr is None or addr == '':
        return ''

    text = ''
    pincode = ''
    explicit_state = ''

    if isinstance(addr, dict):
        explicit_state = _norm(addr.get('state') or addr.get('state_name'))
        pincode = str(addr.get('pincode') or addr.get('pin') or addr.get('zip') or '').strip()
        # Already a two-letter code?
        code = (addr.get('state_code') or '').strip().upper()
        if len(code) == 2 and code.isalpha():
            return code
        # Concatenate the address fields into one search string so the
        # substring match in the fallback below can see all of them.
        text = ' '.join(str(v) for v in addr.values() if v).lower()
    else:
        text = str(addr).lower()
        # Try to pluck a 6-digit pincode out of the text.
        import re
        m = re.search(r'\b(\d{6})\b', text)
        if m:
            pincode = m.group(1)

    # 1. Explicit state name on the dict — fastest, most reliable.
    if explicit_state and explicit_state in STATE_NAMES:
        return STATE_NAMES[explicit_state]

    # 2. Pincode prefix lookup.
    if pincode and len(pincode) >= 2:
        code = PINCODE_PREFIX_TO_STATE.get(pincode[:2])
        if code:
            return code

    # 3. Substring match against the state-name dictionary. We sort by
    # NAME LENGTH descending so "Andhra Pradesh" wins over "Andhra"
    # and "Tamil Nadu" beats "Tamil".
    for name in sorted(STATE_NAMES.keys(), key=len, reverse=True):
        if name in text:
            return STATE_NAMES[name]

    return ''


def best_state_group_for(state_code: str, queryset=None, prefer_groups=None):
    """Return the most-specific active StateGroup containing
    `state_code`, or None.

    "Specific" = fewest member states. So "Tamilnadu, Pondicherry &
    Karnataka" (3) wins over "South States" (~6). Ties on specificity
    are broken alphabetically by name (deterministic).

    `prefer_groups` — optional iterable of StateGroup IDs to bias the
    pick toward. Used by the Customer PO extractor to prefer groups
    that the customer's price list actually references, so a generic
    "TN" group doesn't shadow a customer-specific "TN,KA" group that
    matches a price-list line. Preferred groups always win over
    non-preferred ones; tie-breaking inside each bucket is by
    specificity then name (deterministic).

    Membership AND sorting are both done in Python rather than via
    Django's `__contains` JSONField lookup, because SQLite doesn't
    support that lookup (Django raises NotSupportedError). Pulling
    the whole table is fine — StateGroup is a master table with at
    most a few dozen rows.
    """
    if not state_code:
        return None
    # Local import — keeps this module importable from migrations and
    # management commands without dragging the model registry in early.
    from .models import StateGroup
    qs = queryset if queryset is not None else StateGroup.objects.filter(is_active=True)
    code_upper = state_code.upper()
    candidates = [
        g for g in qs
        if code_upper in {str(s).upper() for s in (g.member_states or [])}
    ]
    if not candidates:
        return None
    preferred_ids = {str(pid) for pid in (prefer_groups or [])}
    candidates.sort(key=lambda g: (
        0 if str(g.id) in preferred_ids else 1,
        len(g.member_states or []),
        g.name,
    ))
    return candidates[0]

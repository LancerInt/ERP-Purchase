"""Provider-agnostic GSTIN verification against the GST portal (A5).

There is no free official GSTN API; verification goes through a paid GSP /
aggregator. This module is a thin, pluggable adapter so the provider can be
swapped with configuration, not code:

    GST_VERIFY_PROVIDER   sandbox | custom | ''(off)   — default off
    GST_VERIFY_API_KEY    provider API key / id
    GST_VERIFY_API_SECRET provider API secret (sandbox auth)
    GST_VERIFY_BASE_URL   override base URL (custom provider)

When nothing is configured, `is_configured()` is False and the API endpoint
tells the UI to hide the Verify button — every other vendor flow still works.

`verify(gstin)` returns a normalised dict the vendor form and serializer
understand:

    {
      'gstin', 'status',            # ACTIVE/CANCELLED/SUSPENDED/...
      'legal_name', 'trade_name',
      'gst_treatment',              # maps to Vendor.gst_treatment
      'deductee_category',          # INDIVIDUAL_HUF / COMPANY_FIRM_LLP (TDS)
      'constitution', 'registration_date',
      'address': {line1, city, state, pincode},
      'raw',                        # full provider payload (audit snapshot)
    }

It raises GstVerifyError on any failure (not configured, network, bad GSTIN,
provider error) — callers surface the message; they never fabricate a result.
"""
import os
import re

try:
    import requests
except ImportError:  # requests is a hard dep in prod; guard dev shells
    requests = None


class GstVerifyError(Exception):
    """A GSTIN lookup could not be completed (config / network / provider)."""


def _session():
    """A requests session that retries transient connect/DNS failures and 5xx.
    Flaky DNS (getaddrinfo timeouts) and brief network blips would otherwise
    surface as a hard 'lookup failed' — a couple of quick retries smooth them
    over. Degrades to a plain session if urllib3's Retry isn't importable."""
    sess = requests.Session()
    try:
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry
        retry = Retry(
            total=3, connect=3, read=2, backoff_factor=0.5,
            status_forcelist=(502, 503, 504),
            allowed_methods=frozenset(['GET', 'POST']),
        )
        adapter = HTTPAdapter(max_retries=retry)
        sess.mount('https://', adapter)
        sess.mount('http://', adapter)
    except Exception:  # pragma: no cover - fall back to no-retry session
        pass
    return sess


_GSTIN_RE = re.compile(r'^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d][Z][A-Z\d]$')

# GST-portal "status" → our GSTIN_PORTAL_STATUS_CHOICES.
_STATUS_MAP = {
    'active': 'ACTIVE',
    'cancelled': 'CANCELLED',
    'suspended': 'SUSPENDED',
    'provisional': 'PROVISIONAL',
    'inactive': 'INACTIVE',
}

# Taxpayer type ("dty") → Vendor.GST_TREATMENT_CHOICES.
_TREATMENT_MAP = {
    'regular': 'REGISTERED_REGULAR',
    'composition': 'REGISTERED_COMPOSITION',
    'sez unit': 'SEZ',
    'sez developer': 'SEZ',
    'input service distributor': 'REGISTERED_REGULAR',
    'input service distributor (isd)': 'REGISTERED_REGULAR',
}

# Constitution of business ("ctb") → TDS deductee category. Proprietor / HUF are
# individual; every registered entity form takes the "others" rate column.
_INDIVIDUAL_CTB = ('proprietor', 'individual', 'huf', 'hindu undivided')


def normalise_gstin(gstin):
    return (gstin or '').strip().upper()


def is_valid_gstin(gstin):
    return bool(_GSTIN_RE.match(normalise_gstin(gstin)))


def _map_status(sts):
    return _STATUS_MAP.get((sts or '').strip().lower(), '')


def _map_treatment(dty):
    return _TREATMENT_MAP.get((dty or '').strip().lower(), 'REGISTERED_REGULAR')


def _map_deductee(ctb):
    c = (ctb or '').strip().lower()
    if any(k in c for k in _INDIVIDUAL_CTB):
        return 'INDIVIDUAL_HUF'
    return 'COMPANY_FIRM_LLP' if c else ''


def _first(rec, *keys):
    """First non-empty value among `keys` in `rec` — lets the normaliser accept
    either the GSTN abbreviations or a provider's snake_case aliases."""
    for k in keys:
        v = rec.get(k)
        if v not in (None, ''):
            return v
    return ''


def _parse_address(rec):
    """Build a flat {line1, city, state, pincode} from either shape:
      • GSTN principal-address block (`pradr` → {'addr': {...}} with bno/st/…)
      • a provider's flat snake_case fields (`address` string + `pincode`)
    Tolerant of missing keys; returns {} only when nothing usable is present."""
    pradr = rec.get('pradr')
    if isinstance(pradr, dict):
        addr = pradr.get('addr') if isinstance(pradr.get('addr'), dict) else pradr
        if isinstance(addr, dict):
            parts = [addr.get('bno'), addr.get('bnm'), addr.get('flno'),
                     addr.get('st'), addr.get('loc')]
            line1 = ', '.join(str(p).strip() for p in parts if p and str(p).strip())
            return {
                'line1': line1,
                'city': (addr.get('dst') or addr.get('loc') or '').strip(),
                'state': (addr.get('stcd') or '').strip(),
                'pincode': str(addr.get('pncd') or '').strip(),
            }
    # Flat snake_case shape (e.g. gstinapi.in): a formatted `address` string,
    # with pincode separate. City/state aren't reliably provided here, so we
    # leave them blank rather than feed the form a value its state <select>
    # can't match — the operator keeps whatever they already typed.
    line1 = _first(rec, 'address', 'adr', 'addr')
    pincode = _first(rec, 'pincode', 'pncd')
    if not (line1 or pincode):
        return {}
    return {
        'line1': str(line1).strip(),
        'city': str(_first(rec, 'city', 'dst')).strip(),
        'state': str(_first(rec, 'state')).strip(),
        'pincode': str(pincode).strip(),
    }


def normalise_gstn_payload(raw, gstin):
    """Map a provider's 'search taxpayer' payload to our normalised dict.

    Accepts both the GSTN field names (lgnm, tradeNam, sts, dty, ctb, rgdt,
    pradr) that most GSP aggregators pass through, AND common snake_case
    aliases (legal_name, trade_name, status, taxpayer_type,
    business_constitution, registration_date, address) used by providers such
    as gstinapi.in — so a provider swap is config, not code."""
    if not isinstance(raw, dict):
        raise GstVerifyError('Unexpected response from the GST provider.')
    # An explicit failure flag (e.g. {"success": false, "message": "..."}) is an
    # error even on HTTP 200 — surface it instead of returning blank fields.
    if raw.get('success') is False or raw.get('error'):
        msg = (raw.get('message') or raw.get('error')
               or 'GSTIN could not be verified by the provider.')
        raise GstVerifyError(str(msg))
    # Some providers wrap the record under 'data' / 'result' / 'taxpayerInfo'.
    rec = raw
    for key in ('data', 'result', 'taxpayerInfo', 'gstin_details'):
        if isinstance(rec.get(key), dict):
            rec = rec[key]
            break
    constitution = _first(rec, 'ctb', 'business_constitution')
    taxpayer_type = str(_first(rec, 'dty', 'taxpayer_type')).strip()
    g = normalise_gstin(gstin)
    # PAN is the GSTIN's chars 3–12; use the provider's if it sends one, else
    # derive it (the public GST search doesn't return PAN separately).
    pan = str(_first(rec, 'pan', 'pan_number', 'panNo')).strip() or (
        g[2:12] if is_valid_gstin(g) else '')
    # Nature of business can arrive as a list ('nba'/'nature_of_business') or a
    # single string — normalise to a clean list for display.
    nob = rec.get('nature_of_business')
    if nob is None:
        nob = rec.get('nba')
    if isinstance(nob, str):
        nob = [nob]
    nob = [str(x).strip() for x in nob if x and str(x).strip()] if isinstance(nob, (list, tuple)) else []
    return {
        'gstin': g,
        'pan': pan,
        'status': _map_status(_first(rec, 'sts', 'status')),
        'legal_name': str(_first(rec, 'lgnm', 'legal_name')).strip(),
        'trade_name': str(_first(rec, 'tradeNam', 'tradeName', 'trade_name')).strip(),
        'gst_treatment': _map_treatment(taxpayer_type),
        'taxpayer_type': taxpayer_type,
        'deductee_category': _map_deductee(constitution),
        'constitution': str(constitution).strip(),
        'registration_date': str(_first(rec, 'rgdt', 'registration_date')).strip(),
        'cancellation_date': str(_first(rec, 'cxdt', 'cancellation_date')).strip(),
        'jurisdiction': str(_first(rec, 'stj', 'state_jurisdiction', 'ctj')).strip(),
        'nature_of_business': nob,
        # GSTN public search does not expose contact mobile/email, but some
        # aggregators add them — surface when present, hide otherwise.
        'mobile': str(_first(rec, 'mobile', 'mobile_number', 'mob', 'phone')).strip(),
        'email': str(_first(rec, 'email', 'email_id', 'emailId')).strip(),
        'address': _parse_address(rec),
        'raw': raw,
    }


# ── Providers ────────────────────────────────────────────────────────────────

class _Provider:
    name = 'base'

    def verify(self, gstin):  # pragma: no cover - interface
        raise NotImplementedError


class SandboxProvider(_Provider):
    """api.sandbox.co.in GSP. Authenticates for a bearer token, then calls the
    public GSTIN search. Endpoint shapes can change per their versioning — the
    parser keys off GSTN field names, so a minor path change is the only thing a
    future tweak touches."""
    name = 'sandbox'
    AUTH_URL = 'https://api.sandbox.co.in/authenticate'
    SEARCH_URL = 'https://api.sandbox.co.in/gst/compliance/public/gstin/{gstin}'

    def __init__(self, api_key, api_secret):
        self.api_key = api_key
        self.api_secret = api_secret

    def _token(self, sess=None):
        sess = sess or _session()
        resp = sess.post(self.AUTH_URL, headers={
            'x-api-key': self.api_key,
            'x-api-secret': self.api_secret,
            'x-api-version': '1.0',
            'accept': 'application/json',
        }, timeout=20)
        if resp.status_code != 200:
            raise GstVerifyError(f'GST provider auth failed ({resp.status_code}).')
        data = resp.json()
        token = data.get('access_token') or (data.get('data') or {}).get('access_token')
        if not token:
            raise GstVerifyError('GST provider auth returned no token.')
        return token

    def verify(self, gstin):
        sess = _session()
        token = self._token(sess)
        url = self.SEARCH_URL.format(gstin=normalise_gstin(gstin))
        resp = sess.get(url, headers={
            'Authorization': token,
            'x-api-key': self.api_key,
            'x-api-version': '1.0',
            'accept': 'application/json',
        }, timeout=25)
        if resp.status_code == 404:
            raise GstVerifyError('GSTIN not found on the GST portal.')
        if resp.status_code != 200:
            raise GstVerifyError(f'GST provider error ({resp.status_code}).')
        return normalise_gstn_payload(resp.json(), gstin)


class CustomProvider(_Provider):
    """Any aggregator that returns the standard GSTN JSON from a single GET with
    an API-key header. Configure GST_VERIFY_BASE_URL with a `{gstin}`
    placeholder, e.g. https://api.example.com/gstin/{gstin}."""
    name = 'custom'

    def __init__(self, base_url, api_key):
        self.base_url = base_url
        self.api_key = api_key

    def verify(self, gstin):
        url = self.base_url.replace('{gstin}', normalise_gstin(gstin))
        headers = {'accept': 'application/json'}
        if self.api_key:
            headers['Authorization'] = self.api_key
            headers['x-api-key'] = self.api_key
        resp = _session().get(url, headers=headers, timeout=25)
        if resp.status_code != 200:
            raise GstVerifyError(f'GST provider error ({resp.status_code}).')
        return normalise_gstn_payload(resp.json(), gstin)


def _env(name):
    return (os.environ.get(name) or '').strip()


def get_provider():
    """The configured provider instance, or None when verification is off."""
    provider = _env('GST_VERIFY_PROVIDER').lower()
    if not provider:
        return None
    if requests is None:
        return None
    if provider == 'sandbox':
        key, secret = _env('GST_VERIFY_API_KEY'), _env('GST_VERIFY_API_SECRET')
        return SandboxProvider(key, secret) if (key and secret) else None
    if provider == 'custom':
        base = _env('GST_VERIFY_BASE_URL')
        key = _env('GST_VERIFY_API_KEY')
        # Require the key too: every real aggregator (incl. gstinapi.in) needs
        # one, and we'd rather hide the Verify button than show one that 401s.
        return CustomProvider(base, key) if (base and key) else None
    return None


def is_configured():
    return get_provider() is not None


def verify(gstin):
    """Normalised GSTIN details, or raise GstVerifyError."""
    g = normalise_gstin(gstin)
    if not is_valid_gstin(g):
        raise GstVerifyError('Enter a valid 15-character GSTIN first.')
    provider = get_provider()
    if provider is None:
        raise GstVerifyError('GSTIN verification is not configured.')
    try:
        return provider.verify(g)
    except GstVerifyError:
        raise
    except Exception as exc:  # noqa: BLE001 - network/parse → uniform error
        raise GstVerifyError(f'GSTIN lookup failed: {exc}') from exc

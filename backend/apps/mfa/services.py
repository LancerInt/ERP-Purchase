"""Login-time helpers shared between core.jwt_auth (the password step) and
this app's own views (the second-factor step). Kept separate from
views.py so jwt_auth.py can import just this, not the whole DRF view layer.
"""
import logging

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.models import update_last_login
from django.core import signing
from django.core.cache import cache
from rest_framework_simplejwt.tokens import RefreshToken

from .models import TOTPDevice, MFABackupCode, WebAuthnCredential

logger = logging.getLogger(__name__)

# How long a WebAuthn challenge (registration or authentication) stays
# valid — the ceremony is a single round trip through the browser's
# built-in biometric prompt, so this only needs to cover someone actually
# completing that prompt, not sitting on a stale tab.
WEBAUTHN_CHALLENGE_TTL = 5 * 60

# How long the intermediate "password verified, second factor pending"
# token is valid for. Short on purpose — it grants no API access by
# itself (see verify_mfa_challenge), but a long-lived one would let an
# attacker who steals it keep retrying a stolen/guessed TOTP code at
# leisure instead of within one login attempt's natural window.
MFA_CHALLENGE_MAX_AGE = 5 * 60

_SALT = 'mfa.challenge'


def user_has_mfa(user):
    """True if this user has ANY confirmed second factor — TOTP or a
    registered WebAuthn (biometric) credential, either one is sufficient."""
    return (
        TOTPDevice.objects.filter(user=user, confirmed_at__isnull=False).exists()
        or WebAuthnCredential.objects.filter(user=user).exists()
    )


def available_methods(user):
    methods = []
    if TOTPDevice.objects.filter(user=user, confirmed_at__isnull=False).exists():
        methods.append('totp')
    if WebAuthnCredential.objects.filter(user=user).exists():
        methods.append('webauthn')
    return methods


def make_mfa_challenge(user):
    """A signed, short-lived token identifying which user is mid-login.
    Not a JWT and not accepted by any authenticated endpoint — it only
    means anything to verify_mfa_challenge below."""
    return signing.dumps({'user_id': user.pk}, salt=_SALT)


def resolve_mfa_challenge(token):
    """Return the User the challenge token was issued for, or None if it's
    missing, tampered with, expired, or the user no longer exists/is
    inactive (mirrors the active-user check the password step already
    does — a deactivated account mid-login shouldn't be completable)."""
    try:
        data = signing.loads(token, salt=_SALT, max_age=MFA_CHALLENGE_MAX_AGE)
    except signing.BadSignature:
        return None
    User = get_user_model()
    try:
        user = User.objects.get(pk=data['user_id'])
    except User.DoesNotExist:
        return None
    return user if user.is_active else None


def verify_second_factor(user, method, code):
    """Check a submitted code against the user's registered factor(s).
    `method` is 'totp' or 'backup_code' — the caller (the /verify/ view)
    picks based on what the client sent, this just checks the one path."""
    if method == 'totp':
        device = TOTPDevice.objects.filter(user=user, confirmed_at__isnull=False).first()
        if not device:
            return False
        import pyotp
        return pyotp.TOTP(device.secret).verify(code, valid_window=1)
    if method == 'backup_code':
        return MFABackupCode.consume(user, code)
    return False


def mint_tokens(user):
    """Issue a real access+refresh pair for `user`, identical in shape and
    side effects (last_login stamp) to what TokenObtainPairSerializer.validate
    does on a no-MFA login — used both there and by the post-2FA /verify/
    endpoint, so a completed login looks the same regardless of which path
    got it there."""
    refresh = RefreshToken.for_user(user)
    if getattr(settings, 'SIMPLE_JWT', {}).get('UPDATE_LAST_LOGIN', False):
        update_last_login(None, user)
    return {'access': str(refresh.access_token), 'refresh': str(refresh)}


def role_requires_mfa(user):
    """True if this user's assigned role has mfa_required=True (see
    rbac.ERPRole). Never raises — a user with no role assignment yet
    (mid-onboarding) simply isn't required."""
    assignment = getattr(user, 'erp_role_assignment', None)
    return bool(assignment and assignment.role.mfa_required)


def would_leave_user_without_mfa(user, *, dropping_totp=False, dropping_webauthn_id=None):
    """True if removing the given factor(s) would leave `user` with NO
    confirmed second factor at all. Used to stop a mandatory-role user from
    self-disabling their OWN last factor — mfa_required is meaningless if
    the person it applies to can just turn it back off whenever they like.
    A user whose role does NOT require MFA is never blocked by this; call
    sites check role_requires_mfa first."""
    has_totp = TOTPDevice.objects.filter(user=user, confirmed_at__isnull=False).exists()
    if dropping_totp:
        has_totp = False
    webauthn_qs = WebAuthnCredential.objects.filter(user=user)
    if dropping_webauthn_id is not None:
        webauthn_qs = webauthn_qs.exclude(pk=dropping_webauthn_id)
    return not has_totp and not webauthn_qs.exists()


# ── WebAuthn (biometric) ────────────────────────────────────────────────
# The two ceremonies (register a device, authenticate with one) each need
# a server-generated challenge remembered between the "begin" and
# "complete" calls, so the browser's signed response can be checked
# against the exact value that was issued. Registration happens on an
# authenticated session; authentication happens mid-login (no session
# yet) — both are keyed by user id in the cache, which is available in
# either case (from request.user, or from the already-resolved mfa
# challenge), so one storage scheme covers both.

def _webauthn_cache_key(user, purpose):
    return f'webauthn:{purpose}:{user.pk}'


def webauthn_registration_options(user):
    """Start enrolling a new device. Returns the JSON-ready options dict
    for navigator.credentials.create() on the frontend. Excludes the
    user's already-registered credentials so re-registering the SAME
    physical device (e.g. clicking the button twice) doesn't create a
    duplicate row for it."""
    import json
    import webauthn
    from webauthn.helpers.structs import PublicKeyCredentialDescriptor

    existing = [
        PublicKeyCredentialDescriptor(id=webauthn.base64url_to_bytes(c))
        for c in WebAuthnCredential.objects.filter(user=user).values_list('credential_id', flat=True)
    ]
    options = webauthn.generate_registration_options(
        rp_id=settings.WEBAUTHN_RP_ID,
        rp_name=settings.WEBAUTHN_RP_NAME,
        user_name=user.get_username(),
        user_display_name=user.get_username(),
        exclude_credentials=existing or None,
    )
    cache.set(_webauthn_cache_key(user, 'reg'), options.challenge, WEBAUTHN_CHALLENGE_TTL)
    # options_to_json returns a JSON STRING (it's meant for a raw HTTP
    # body) — parse it back to a dict so DRF's Response serializes it as
    # actual JSON instead of double-encoding it as a quoted string.
    return json.loads(webauthn.options_to_json(options))


def webauthn_verify_registration(user, credential_json, device_name):
    """Complete enrollment. Returns True and saves the credential on
    success; False (nothing saved) on any verification failure — a bad
    signature, a stale/missing challenge, or an unsupported algorithm."""
    import webauthn

    challenge = cache.get(_webauthn_cache_key(user, 'reg'))
    if not challenge:
        return False
    try:
        verification = webauthn.verify_registration_response(
            credential=credential_json,
            expected_challenge=challenge,
            expected_rp_id=settings.WEBAUTHN_RP_ID,
            expected_origin=settings.WEBAUTHN_ORIGIN,
        )
    except Exception:
        # Silently returning False here used to leave zero trace of WHY a
        # registration failed (wrong RP ID/origin, unsupported algorithm, a
        # replayed/expired challenge, ...) — logged now so a real failure
        # is diagnosable from the server logs instead of guessed at.
        logger.exception('WebAuthn registration verification failed for user %s', user.pk)
        return False
    cache.delete(_webauthn_cache_key(user, 'reg'))
    WebAuthnCredential.objects.create(
        user=user,
        credential_id=webauthn.helpers.bytes_to_base64url(verification.credential_id),
        public_key=webauthn.helpers.bytes_to_base64url(verification.credential_public_key),
        sign_count=verification.sign_count,
        device_name=device_name or 'Registered device',
    )
    return True


def webauthn_authentication_options(user):
    """Mid-login: generate a challenge scoped to THIS user's registered
    credentials (so the browser only offers to unlock ones enrolled for
    this account, not any biometric credential it happens to hold)."""
    import json
    import webauthn
    from webauthn.helpers.structs import PublicKeyCredentialDescriptor

    allow = [
        PublicKeyCredentialDescriptor(id=webauthn.base64url_to_bytes(c))
        for c in WebAuthnCredential.objects.filter(user=user).values_list('credential_id', flat=True)
    ]
    options = webauthn.generate_authentication_options(
        rp_id=settings.WEBAUTHN_RP_ID,
        allow_credentials=allow or None,
    )
    cache.set(_webauthn_cache_key(user, 'auth'), options.challenge, WEBAUTHN_CHALLENGE_TTL)
    # Same JSON-string-vs-dict fix as webauthn_registration_options above.
    return json.loads(webauthn.options_to_json(options))


def webauthn_verify_authentication(user, credential_json):
    """Second half of a biometric login. Looks up which of the user's
    credentials the browser responded with (a user may have several
    devices), verifies the signature against ITS stored public key, and
    bumps sign_count — rejecting a response whose counter doesn't advance,
    which is what catches a cloned authenticator or a replayed response."""
    import json
    import webauthn

    challenge = cache.get(_webauthn_cache_key(user, 'auth'))
    if not challenge:
        return False

    raw = json.loads(credential_json) if isinstance(credential_json, str) else credential_json
    credential_id = raw.get('id') or raw.get('rawId')
    if not credential_id:
        return False
    stored = WebAuthnCredential.objects.filter(user=user, credential_id=credential_id).first()
    if not stored:
        return False

    try:
        verification = webauthn.verify_authentication_response(
            credential=credential_json,
            expected_challenge=challenge,
            expected_rp_id=settings.WEBAUTHN_RP_ID,
            expected_origin=settings.WEBAUTHN_ORIGIN,
            credential_public_key=webauthn.base64url_to_bytes(stored.public_key),
            credential_current_sign_count=stored.sign_count,
        )
    except Exception:
        logger.exception('WebAuthn authentication verification failed for user %s', user.pk)
        return False

    cache.delete(_webauthn_cache_key(user, 'auth'))
    from django.utils import timezone
    stored.sign_count = verification.new_sign_count
    stored.last_used_at = timezone.now()
    stored.save(update_fields=['sign_count', 'last_used_at', 'updated_at'])
    return True

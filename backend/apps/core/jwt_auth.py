"""JWT auth views that keep User.last_login meaningful.

`SIMPLE_JWT['UPDATE_LAST_LOGIN']` already stamps last_login on a fresh
sign-in (TokenObtainPairView). But the SPA keeps a session alive for
days by silently refreshing the access token — and a refresh is not a
login, so a user who never signs out would otherwise show a stale (or
"Never") last_login forever.

To make the admin Users page reflect *active* sessions, we also stamp
last_login on token refresh. The effect: last_login tracks "last active"
(updated each time the access token is refreshed, i.e. roughly once per
access-token lifetime while the user keeps using the app), not just the
last credential entry.
"""
import logging

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from core.throttling import ResilientScopedRateThrottle
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer, TokenRefreshSerializer
from rest_framework_simplejwt.tokens import AccessToken
from rest_framework_simplejwt.views import (
    TokenBlacklistView, TokenObtainPairView, TokenRefreshView,
)

_log = logging.getLogger(__name__)

# Account lockout after repeated failed sign-ins. Keyed by (identifier, IP)
# so an attacker can't lock a legitimate user out by guessing their username
# from elsewhere. Complements the per-IP 'login' throttle (defense in depth).
LOGIN_MAX_FAILS = 8          # failures before a lock kicks in
LOGIN_FAIL_WINDOW = 15 * 60   # seconds the failure counter is remembered
LOGIN_LOCK_SECONDS = 5 * 60   # seconds a locked (ident, IP) stays locked


def _client_ip(request):
    xff = request.META.get('HTTP_X_FORWARDED_FOR')
    if xff:
        return xff.split(',')[0].strip()
    return request.META.get('REMOTE_ADDR', '')


def _cache_get(key, default=None):
    """cache.get that survives the cache being down.

    Every cache touch on the sign-in path is best-effort for the same reason
    core.throttling fails open: an unreachable Redis must not be able to stop
    people signing in. A lockout that cannot be read is treated as absent,
    which is the same position we are in on a cold cache anyway.
    """
    try:
        return cache.get(key)
    except Exception:
        _log.error('Login cache unreadable (%s); continuing without it.', key, exc_info=True)
        return default


def _cache_set(key, value, ttl):
    try:
        cache.set(key, value, ttl)
    except Exception:
        _log.error('Login cache unwritable (%s); lockout counting is degraded.', key, exc_info=True)


def _login_locked(ident, ip):
    # A fresh admin password reset lifts any standing lock: the lock almost
    # certainly came from the user fumbling the OLD password, and keeping it
    # would block the brand-new credential for 15 minutes. The reset flow
    # (rbac user update) stamps `pwreset:<ident>`; an attacker can't mint
    # that key, so the lockout's protection is unchanged.
    if ident and _cache_get(f'pwreset:{ident}'):
        return False
    return bool(ident) and bool(_cache_get(f'loginlock:{ident}:{ip}'))


def clear_login_lock_for(*idents):
    """Called after an admin password reset: lift the lockout for every
    identifier this user can sign in with (username and email)."""
    for ident in idents:
        ident = (ident or '').strip().lower()
        if ident:
            _cache_set(f'pwreset:{ident}', True, LOGIN_LOCK_SECONDS)


def _record_login_failure(ident, ip):
    """Returns the fail count AFTER this failure (None if ident was blank, so
    the caller can tell "nothing recorded" from "this was the 1st failure").
    Callers use this to warn the user how many tries are left before a lock."""
    if not ident:
        return None
    key = f'loginfail:{ident}:{ip}'
    fails = (_cache_get(key) or 0) + 1
    _cache_set(key, fails, LOGIN_FAIL_WINDOW)
    if fails >= LOGIN_MAX_FAILS:
        _cache_set(f'loginlock:{ident}:{ip}', True, LOGIN_LOCK_SECONDS)
    return fails


def _clear_login_failures(ident, ip):
    if not ident:
        return
    try:
        cache.delete(f'loginfail:{ident}:{ip}')
        cache.delete(f'loginlock:{ident}:{ip}')
    except Exception:
        _log.error('Login cache undeletable; failure counters not cleared.', exc_info=True)


class LastLoginTokenRefreshSerializer(TokenRefreshSerializer):
    def validate(self, attrs):
        data = super().validate(attrs)
        # Read the user id from the freshly-issued access token and bump
        # last_login. Best-effort: a failure here must never break the
        # refresh (the user staying logged in matters more than the stamp).
        try:
            user_id = AccessToken(data['access']).get('user_id')
            if user_id:
                get_user_model().objects.filter(pk=user_id).update(
                    last_login=timezone.now()
                )
        except Exception:
            pass
        return data


class LastLoginTokenRefreshView(TokenRefreshView):
    serializer_class = LastLoginTokenRefreshSerializer


class LogoutView(TokenBlacklistView):
    """Make "Logout" revoke the session instead of only forgetting it.

    Until this existed, signing out was purely client-side: the frontend
    cleared Redux and both storages, and the refresh token stayed VALID
    server-side for its full 7 days. Anyone holding a copy — a shared
    machine, a browser profile left behind, a laptop with "Remember me" on
    — kept working access long after the user believed they were out.

    Blacklisting the refresh token ends that: the next refresh is rejected,
    so the session dies with the access token already in flight (<= 1 hour)
    rather than a week later.

    Deliberately tolerant. A token that is expired, malformed, already
    blacklisted, or simply missing still returns 205: the user asked to
    leave, and the client has already thrown its credentials away by the
    time this answers. Failing the call would only produce an error toast
    on a logout that did, from the user's side, happen.
    """
    permission_classes = [AllowAny]

    def post(self, request, *args, **kwargs):
        try:
            super().post(request, *args, **kwargs)
            # 205 on EVERY path, not SimpleJWT's 200-on-success: the client
            # should not have to tell "revoked" from "was already unusable"
            # — it has discarded its tokens either way, and both mean the
            # same thing to the user. One status, one code path.
            return Response(status=status.HTTP_205_RESET_CONTENT)
        except (TokenError, InvalidToken, KeyError, AttributeError) as exc:
            _log.info('Logout with an unusable refresh token (%s); treating as done.',
                      type(exc).__name__)
            return Response(status=status.HTTP_205_RESET_CONTENT)
        except Exception:
            # A blacklist write needs the DB. If that fails the user must
            # still get out of the app; the token simply expires normally.
            _log.error('Logout could not blacklist the refresh token.', exc_info=True)
            return Response(status=status.HTTP_205_RESET_CONTENT)


class LogoutAllView(APIView):
    """Sign out of EVERY device, not just this one.

    Ordinary logout blacklists only the refresh token belonging to the
    device that asked, which is the right default — signing out of the
    laptop shouldn't kill the phone. But it leaves no answer to "my phone
    was stolen, cut it off", because the other sessions keep refreshing
    happily for the full 7 days.

    This blacklists every outstanding refresh token the user has, so no
    session anywhere can renew itself.

    Access tokens already issued are cut off too, not just the refresh
    tokens: the revocation stamp written here is checked on every
    authenticated request by core.authentication.RevocableJWTAuthentication.
    Without
    that, the other device kept working for up to ACCESS_TOKEN_LIFETIME
    (an hour), which made this button a lie — you hit "sign out
    everywhere" and the missing phone carried on regardless.
    """
    permission_classes = [IsAuthenticated]

    def post(self, request):
        from rest_framework_simplejwt.token_blacklist.models import (
            BlacklistedToken, OutstandingToken,
        )
        revoked = 0
        try:
            for token in OutstandingToken.objects.filter(user=request.user):
                _, created = BlacklistedToken.objects.get_or_create(token=token)
                if created:
                    revoked += 1
        except Exception:
            # Same reasoning as LogoutView: leaving must not depend on the
            # DB behaving. The caller still drops its own credentials.
            _log.error('Sign-out-everywhere could not blacklist all tokens.', exc_info=True)
            return Response(
                {'detail': 'Could not sign out every device. Please change your password.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        # Cut off the access tokens already out there, not just renewals.
        # Stamped AFTER the blacklisting so there's no window where a
        # refresh could mint a fresh access token that outlives the stamp.
        from core.models import UserSessionRevocation
        UserSessionRevocation.objects.update_or_create(
            user=request.user, defaults={'revoked_at': timezone.now()},
        )
        return Response({'sessions_revoked': revoked})


def _mfa_exempt_usernames():
    """Usernames that skip the 2FA challenge — machine accounts only.

    From settings.MFA_EXEMPT_USERNAMES / the env var of the same name, so
    adding a service account is a deployment change, not a code change.
    Lower-cased for a case-insensitive match against get_username().
    """
    raw = getattr(settings, 'MFA_EXEMPT_USERNAMES', '') or ''
    if isinstance(raw, (list, tuple, set)):
        names = raw
    else:
        names = str(raw).split(',')
    return {str(n).strip().lower() for n in names if str(n).strip()}


class MessagefulTokenObtainPairSerializer(TokenObtainPairSerializer):
    """Token serializer that tells the user *why* a sign-in failed.

    Stock SimpleJWT returns one opaque "No active account found with the
    given credentials" for both an unknown username and a wrong password
    (deliberately, to avoid username enumeration). This internal ERP
    prefers actionable feedback, so we check existence, password and the
    active flag separately and raise a specific message for each. As a
    bonus the user may sign in with their email as well as their username.
    """
    def validate(self, attrs):
        User = get_user_model()
        ident = (attrs.get(self.username_field) or '').strip()
        # Django usernames are unique case-SENSITIVELY, so "kumaresan" and
        # "Kumaresan" can both exist. A bare `iexact ... .first()` here used
        # to pick whichever had the lower pk — which could be the WRONG
        # account, making a freshly-reset password fail with "incorrect
        # password". Collect every case-variant candidate (exact-case match
        # first) and authenticate against whichever one the password fits.
        candidates = list(
            User.objects.filter(**{f'{self.username_field}__iexact': ident})
        ) or list(User.objects.filter(email__iexact=ident))
        if not candidates:
            raise AuthenticationFailed('No account found with that username or email.', 'no_account')
        candidates.sort(key=lambda u: (u.get_username() != ident,))  # exact case first
        password = attrs.get('password') or ''
        user = next((u for u in candidates if u.check_password(password)), None)
        if user is None:
            raise AuthenticationFailed('Incorrect password. Please try again.', 'wrong_password')
        if not user.is_active:
            raise AuthenticationFailed('This account is inactive. Please contact your administrator.', 'inactive')
        # Hand the canonical username to the parent so token issuance and
        # the standard active-user checks run unchanged (also resolves an
        # email sign-in back to the right account).
        attrs[self.username_field] = user.get_username()

        # Two-factor login (see the mfa app). A user with a confirmed TOTP
        # device doesn't get tokens from a correct password alone — the
        # password step ends here with a short-lived challenge instead;
        # mfa.views.MFAVerifyView mints the real tokens once the second
        # factor also checks out. A user whose ROLE requires 2FA but who
        # hasn't set it up yet is deliberately let through anyway (with
        # `must_setup_mfa: True` on the response) rather than locked out —
        # a hard block before first-time setup is the one failure mode
        # that could strand an admin with no way back into their own
        # account, so the frontend enforces "set up 2FA now" itself.
        from mfa.services import user_has_mfa, available_methods, make_mfa_challenge, role_requires_mfa
        # A SERVICE account is exempt. The Tally connector signs in with a
        # username/password from its config.ini and has no human to read an
        # authenticator app, so the moment a factor is enrolled on its account
        # the challenge below becomes unanswerable: the ERP returns 200 with
        # `mfa_required` and no `access`, and the connector dies reporting
        # "ERP did not return a login token" — which reads like a credentials
        # or base_url fault and is neither.
        #
        # Listed by username in MFA_EXEMPT_USERNAMES (env, comma-separated) so
        # the set is deployment configuration rather than anything baked into
        # the code. Deliberately checked HERE and not inside user_has_mfa():
        # that helper also drives the profile screen, and exempting it there
        # would hide a person's own enrolled factors from them.
        if user.get_username().lower() in _mfa_exempt_usernames():
            data = super().validate(attrs)
            data['mfa_exempt'] = True
            return data
        if user_has_mfa(user):
            return {
                'mfa_required': True,
                'mfa_token': make_mfa_challenge(user),
                'methods': available_methods(user),
            }

        data = super().validate(attrs)
        if role_requires_mfa(user):
            data['must_setup_mfa'] = True
        return data


class MessagefulTokenObtainPairView(TokenObtainPairView):
    serializer_class = MessagefulTokenObtainPairSerializer
    # Throttle credential guessing on the primary login endpoint
    # (5/min per IP via the 'login' scope). Without this the endpoint
    # accepts unlimited password attempts.
    throttle_classes = [ResilientScopedRateThrottle]
    throttle_scope = 'login'

    def post(self, request, *args, **kwargs):
        ident = (request.data.get('username') or '').strip().lower()
        ip = _client_ip(request)
        if _login_locked(ident, ip):
            raise AuthenticationFailed(
                'Too many failed sign-in attempts. Please wait about 5 '
                'minutes before trying again.',
                'locked_out',
            )
        try:
            response = super().post(request, *args, **kwargs)
        except AuthenticationFailed as exc:
            # Bad credentials (or inactive account) — count it toward lockout.
            fails = _record_login_failure(ident, ip)
            # Only a WRONG PASSWORD burns down the attempt budget in the
            # user's eyes — 'no_account'/'inactive' aren't something a retry
            # fixes, so leave those messages alone. Warn before the lock
            # hits instead of the first sign of trouble being "you're
            # locked out": by the time fails reaches LOGIN_MAX_FAILS this
            # very attempt IS the one that just triggered the lock, so say
            # that instead of "0 attempts left".
            code = getattr(exc.detail, 'code', None)
            if code == 'wrong_password' and fails is not None:
                remaining = LOGIN_MAX_FAILS - fails
                if remaining <= 0:
                    raise AuthenticationFailed(
                        f'Too many failed sign-in attempts. Please wait about '
                        f'{LOGIN_LOCK_SECONDS // 60} minutes before trying again.',
                        'locked_out',
                    ) from None
                raise AuthenticationFailed(
                    'Incorrect password. Please try again. '
                    f'{remaining} attempt{"s" if remaining != 1 else ""} left '
                    f'before your account is locked for {LOGIN_LOCK_SECONDS // 60} minutes.',
                    'wrong_password',
                ) from None
            raise
        # Successful sign-in — wipe the failure history for this (ident, IP).
        _clear_login_failures(ident, ip)
        return response

"""Two-factor login endpoints.

Setup/confirm/disable/status/regenerate all require a normal authenticated
session (the user is already logged in — TOTP is something you turn on
from Settings, not something you need before you can log in the first
time). `verify` is the one exception: it runs mid-login, before real
tokens exist, keyed by the short-lived challenge token from
core.jwt_auth instead of a session.
"""
import base64
import io

import pyotp
import qrcode
from django.contrib.auth.hashers import check_password
from rest_framework import status
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response
from core.throttling import ResilientScopedRateThrottle
from rest_framework.views import APIView

from .models import TOTPDevice, MFABackupCode, WebAuthnCredential
from .serializers import (
    TOTPConfirmSerializer, TOTPDisableSerializer, MFAVerifySerializer,
    WebAuthnRegisterCompleteSerializer, WebAuthnLoginBeginSerializer, WebAuthnLoginCompleteSerializer,
)
from .services import (
    verify_second_factor, resolve_mfa_challenge, mint_tokens,
    webauthn_registration_options, webauthn_verify_registration,
    webauthn_authentication_options, webauthn_verify_authentication,
    role_requires_mfa, would_leave_user_without_mfa,
)

MFA_REQUIRED_ERROR = (
    'Your role requires two-factor login. Set up another method first, '
    'or ask an admin to lift the requirement, before removing this one.'
)

ISSUER = 'Lancer ERP'


class TOTPSetupView(APIView):
    """Start (or restart) enrolling an authenticator app. Always replaces
    any unconfirmed device from a previous abandoned attempt — but leaves
    an already-CONFIRMED device alone (disable it first, via
    TOTPDisableView, before re-enrolling)."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        existing = TOTPDevice.objects.filter(user=request.user).first()
        if existing and existing.is_confirmed:
            return Response(
                {'error': 'Two-factor login is already set up. Disable it first to re-enroll.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if existing:
            existing.delete()

        secret = pyotp.random_base32()
        TOTPDevice.objects.create(user=request.user, secret=secret)

        uri = pyotp.totp.TOTP(secret).provisioning_uri(
            name=request.user.get_username(), issuer_name=ISSUER,
        )
        img = qrcode.make(uri)
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        qr_b64 = base64.b64encode(buf.getvalue()).decode('ascii')

        return Response({
            'secret': secret,  # manual-entry fallback for a QR scan that won't work
            'qr_code': f'data:image/png;base64,{qr_b64}',
        })


class TOTPConfirmView(APIView):
    """Second half of setup — the user submits one real code from their
    app to prove the enrollment actually works before it's trusted for
    login. Returns backup codes ONCE; they cannot be retrieved again."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = TOTPConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        device = TOTPDevice.objects.filter(user=request.user, confirmed_at__isnull=True).first()
        if not device:
            return Response(
                {'error': 'No pending two-factor setup found. Start setup again.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not pyotp.TOTP(device.secret).verify(serializer.validated_data['code'], valid_window=1):
            return Response({'error': 'Incorrect code. Please try again.'}, status=status.HTTP_400_BAD_REQUEST)

        from django.utils import timezone
        device.confirmed_at = timezone.now()
        device.save(update_fields=['confirmed_at', 'updated_at'])
        backup_codes = MFABackupCode.generate_batch(request.user)

        return Response({'backup_codes': backup_codes})


class TOTPDisableView(APIView):
    """Requires a fresh code, not just the current session — turning OFF a
    second factor is exactly the kind of action a stolen-but-still-valid
    access token shouldn't be able to do alone."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = TOTPDisableSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        if not verify_second_factor(request.user, 'totp', serializer.validated_data['code']):
            return Response({'error': 'Incorrect code.'}, status=status.HTTP_400_BAD_REQUEST)

        if role_requires_mfa(request.user) and would_leave_user_without_mfa(request.user, dropping_totp=True):
            return Response({'error': MFA_REQUIRED_ERROR}, status=status.HTTP_400_BAD_REQUEST)

        TOTPDevice.objects.filter(user=request.user).delete()
        MFABackupCode.objects.filter(user=request.user).delete()
        return Response({'message': 'Two-factor login disabled.'})


class MFAStatusView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        device = TOTPDevice.objects.filter(user=request.user, confirmed_at__isnull=False).first()
        remaining = MFABackupCode.objects.filter(user=request.user, used_at__isnull=True).count() if device else 0
        credentials = WebAuthnCredential.objects.filter(user=request.user).order_by('-created_at')
        return Response({
            'totp_enabled': bool(device),
            'backup_codes_remaining': remaining,
            'webauthn_credentials': [
                {'id': str(c.id), 'device_name': c.device_name, 'created_at': c.created_at,
                 'last_used_at': c.last_used_at}
                for c in credentials
            ],
            # Lets the frontend hide/explain "Turn off" and "remove device"
            # before the user even tries, instead of only erroring after —
            # see would_leave_user_without_mfa for the actual rule enforced.
            'role_requires_mfa': role_requires_mfa(request.user),
        })


class RegenerateBackupCodesView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = TOTPConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        if not verify_second_factor(request.user, 'totp', serializer.validated_data['code']):
            return Response({'error': 'Incorrect code.'}, status=status.HTTP_400_BAD_REQUEST)

        codes = MFABackupCode.generate_batch(request.user)
        return Response({'backup_codes': codes})


def _second_factor_locked(user, request):
    """The lockout answer for this account, or None if it may proceed.

    The password step has had a per-account lockout for a while; the code
    step had only the shared 20/min per-IP throttle, so one office NAT IP
    rationed legitimate staff while an attacker on their own IP got a
    fresh bucket against any account, with no per-account ceiling at all.
    This gives the second step the same treatment, keyed the same way.

    Deliberately the SAME (ident, IP) counter as the password step rather
    than a second one: a correct password clears it (jwt_auth calls
    _clear_login_failures on the mfa_required response, which is a 200),
    so the user arrives here with a full budget, and an attacker can't
    collect one allowance for passwords and another for codes.
    """
    from core.jwt_auth import _client_ip, _login_locked, LOGIN_LOCK_SECONDS

    ident = (user.get_username() or '').strip().lower()
    ip = _client_ip(request)
    if _login_locked(ident, ip):
        return Response(
            {'error': f'Too many failed attempts. Please wait about '
                      f'{LOGIN_LOCK_SECONDS // 60} minutes before trying again.'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    return None


def _record_second_factor_failure(user, request, wrong_message):
    """Count a wrong code and answer with how many tries are left — the
    same countdown the password step gives, so a user fumbling a code
    isn't locked out with no warning."""
    from core.jwt_auth import (_client_ip, _record_login_failure,
                               LOGIN_MAX_FAILS, LOGIN_LOCK_SECONDS)

    ident = (user.get_username() or '').strip().lower()
    fails = _record_login_failure(ident, _client_ip(request))
    minutes = LOGIN_LOCK_SECONDS // 60
    if fails is not None:
        remaining = LOGIN_MAX_FAILS - fails
        if remaining <= 0:
            return Response(
                {'error': f'Too many failed attempts. Please wait about '
                          f'{minutes} minutes before trying again.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            {'error': f'{wrong_message} {remaining} attempt'
                      f'{"" if remaining == 1 else "s"} left before your account '
                      f'is locked for {minutes} minutes.'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    return Response({'error': wrong_message}, status=status.HTTP_400_BAD_REQUEST)


def _clear_second_factor_failures(user, request):
    from core.jwt_auth import _clear_login_failures, _client_ip
    _clear_login_failures((user.get_username() or '').strip().lower(), _client_ip(request))


class MFAVerifyView(APIView):
    """Second step of login (TOTP / backup code). No session yet —
    authenticated only by the challenge token core.jwt_auth issued after
    the password check."""
    permission_classes = [AllowAny]
    throttle_classes = [ResilientScopedRateThrottle]
    throttle_scope = 'login'  # same rate limit as the password step

    def post(self, request):
        serializer = MFAVerifySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        user = resolve_mfa_challenge(data['mfa_token'])
        if user is None:
            return Response(
                {'error': 'This sign-in attempt has expired. Please log in again.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        locked = _second_factor_locked(user, request)
        if locked is not None:
            return locked
        if not verify_second_factor(user, data['method'], data['code']):
            return _record_second_factor_failure(user, request, 'Incorrect code.')

        _clear_second_factor_failures(user, request)
        return Response(mint_tokens(user))


class WebAuthnRegisterBeginView(APIView):
    """Start registering a biometric device — done from Settings, on a
    normal session, same as TOTPSetupView."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        return Response(webauthn_registration_options(request.user))


class WebAuthnRegisterCompleteView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = WebAuthnRegisterCompleteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        ok = webauthn_verify_registration(
            request.user,
            serializer.validated_data['credential'],
            serializer.validated_data.get('device_name', ''),
        )
        if not ok:
            return Response(
                {'error': 'Could not verify that device. Please try registering it again.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response({'message': 'Device registered.'})


class WebAuthnCredentialDeleteView(APIView):
    """Remove one registered device. Unlike disabling TOTP, this doesn't
    require a fresh code — a user who still has their session open (and
    still has the OTHER factor they used to get it) removing a lost/old
    device is exactly the self-service case this exists for; requiring a
    code they may no longer have (the device being removed) would lock
    them out of the removal itself in the one scenario it matters most
    (a lost phone)."""
    permission_classes = [IsAuthenticated]

    def delete(self, request, pk):
        cred = WebAuthnCredential.objects.filter(user=request.user, pk=pk).first()
        if not cred:
            return Response({'error': 'Device not found.'}, status=status.HTTP_404_NOT_FOUND)

        if role_requires_mfa(request.user) and would_leave_user_without_mfa(
            request.user, dropping_webauthn_id=cred.pk,
        ):
            return Response({'error': MFA_REQUIRED_ERROR}, status=status.HTTP_400_BAD_REQUEST)

        cred.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class WebAuthnLoginBeginView(APIView):
    """Mid-login: generate the authentication challenge for whichever
    biometric devices this user has registered, keyed by the same
    mfa_token TOTP verification uses."""
    permission_classes = [AllowAny]
    throttle_classes = [ResilientScopedRateThrottle]
    throttle_scope = 'login'

    def post(self, request):
        serializer = WebAuthnLoginBeginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = resolve_mfa_challenge(serializer.validated_data['mfa_token'])
        if user is None:
            return Response(
                {'error': 'This sign-in attempt has expired. Please log in again.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(webauthn_authentication_options(user))


class WebAuthnLoginCompleteView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ResilientScopedRateThrottle]
    throttle_scope = 'login'

    def post(self, request):
        serializer = WebAuthnLoginCompleteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        user = resolve_mfa_challenge(data['mfa_token'])
        if user is None:
            return Response(
                {'error': 'This sign-in attempt has expired. Please log in again.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        locked = _second_factor_locked(user, request)
        if locked is not None:
            return locked
        if not webauthn_verify_authentication(user, data['credential']):
            return _record_second_factor_failure(
                user, request, 'Could not verify with that device.')

        _clear_second_factor_failures(user, request)
        return Response(mint_tokens(user))

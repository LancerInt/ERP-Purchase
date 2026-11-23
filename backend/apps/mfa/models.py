"""Two-factor login — an authenticator-app (TOTP) second factor and a
WebAuthn (biometric: Face ID / Windows Hello / a fingerprint reader)
second factor, either of which satisfies the same login-time check. See
MessagefulTokenObtainPairSerializer (core.jwt_auth) for where this plugs
into the login flow: password is verified first, exactly as today — this
only gates whether tokens get minted immediately or a second step is
required first.
"""
import secrets

from django.conf import settings
from django.contrib.auth.hashers import make_password, check_password
from django.db import models

from common.models import BaseModel


class TOTPDevice(BaseModel):
    """One authenticator-app enrollment per user.

    `secret` is the shared TOTP seed (base32, per pyotp convention) — it has
    to be readable in plaintext server-side to verify a code, unlike a
    password, so there is no hashing here; protecting it is a database/
    secrets-at-rest concern, not an application-layer one.

    `confirmed_at` stays null from creation until the user proves they
    scanned the QR code correctly by submitting one real code back — an
    unconfirmed device grants no login capability at all (see
    TOTPDevice.objects.confirmed()), so a setup flow abandoned halfway
    can't leave an account in a state nobody can complete.
    """
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='totp_device',
    )
    secret = models.CharField(max_length=64)
    confirmed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'mfa_totp_device'

    def __str__(self):
        return f'TOTP for {self.user.get_username()}' + ('' if self.confirmed_at else ' (unconfirmed)')

    @property
    def is_confirmed(self):
        return self.confirmed_at is not None


class MFABackupCode(BaseModel):
    """A one-time recovery code, issued in a batch of 10 when a user
    confirms their TOTP device. Each code is shown to the user exactly
    once (at generation time) and stored only as a hash — same reasoning
    as a password, since a leaked backup-codes table would otherwise be a
    direct account-takeover list.
    """
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='mfa_backup_codes',
    )
    code_hash = models.CharField(max_length=128)
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'mfa_backup_code'
        indexes = [models.Index(fields=['user', 'used_at'])]

    def __str__(self):
        return f'Backup code for {self.user.get_username()}' + (' (used)' if self.used_at else '')

    @staticmethod
    def generate_batch(user, count=10):
        """Create `count` fresh codes, invalidating any the user already
        had (a regenerate always fully replaces the set — a mix of old and
        new codes floating around is exactly the confusion this avoids).
        Returns the PLAINTEXT codes — the only time they're ever available,
        the caller must show them to the user now."""
        MFABackupCode.objects.filter(user=user).delete()
        plaintext_codes = []
        rows = []
        for _ in range(count):
            # 10 hex chars (40 bits) — short enough to type by hand under
            # pressure (a lost-phone recovery flow), long enough that
            # brute-forcing it isn't realistic behind normal rate limiting.
            code = secrets.token_hex(5)
            plaintext_codes.append(code)
            rows.append(MFABackupCode(user=user, code_hash=make_password(code)))
        MFABackupCode.objects.bulk_create(rows)
        return plaintext_codes

    @staticmethod
    def consume(user, code):
        """Verify `code` against the user's unused backup codes; if it
        matches, mark that ONE code used (so it can never be replayed) and
        return True. Checked against every unused row because the hash
        can't be looked up directly — same reason password reset tokens
        aren't queried by their plaintext either."""
        from django.utils import timezone
        for row in MFABackupCode.objects.filter(user=user, used_at__isnull=True):
            if check_password(code, row.code_hash):
                row.used_at = timezone.now()
                row.save(update_fields=['used_at', 'updated_at'])
                return True
        return False


class WebAuthnCredential(BaseModel):
    """One registered biometric/security-key device. A user may register
    more than one (a laptop's fingerprint reader AND a phone's Face ID),
    each independently sufficient as the second factor.

    `credential_id` and `public_key` are stored base64url-encoded TEXT
    rather than a binary column — the webauthn library already produces
    and consumes these as base64url strings/bytes at every boundary, and a
    portable text column avoids per-database binary-type differences for
    values that are never queried by content, only looked up by
    credential_id.

    `sign_count` is the authenticator's own strictly-increasing usage
    counter — verify_authentication_response rejects a response whose
    counter doesn't exceed the stored value, which is what stops a cloned
    authenticator (or a replayed response) from being reused; NOT a
    "times used" display figure, though it happens to correlate.
    """
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='webauthn_credentials',
    )
    credential_id = models.CharField(max_length=512, unique=True, db_index=True)
    public_key = models.TextField()
    sign_count = models.PositiveIntegerField(default=0)
    device_name = models.CharField(max_length=100)
    last_used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'mfa_webauthn_credential'
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.device_name} ({self.user.get_username()})'

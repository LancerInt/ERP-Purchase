"""Django admin for two-factor login records — support/recovery only.

A user manages their OWN 2FA from Profile > Security; this exists for the
one case self-service can't cover: someone locked out with no working
authenticator, no backup codes, and no registered biometric device, where
clearing their factors so they can re-enroll is the only way back in.

TOTPDevice.secret and MFABackupCode.code_hash are deliberately never
shown here — a leaked/misused secret is just as bad coming from an admin
screen as from anywhere else, and neither is needed to support a user
(the fix is always "clear it and let them set up fresh", never "read the
existing one").
"""
from django.contrib import admin, messages

from .models import TOTPDevice, MFABackupCode, WebAuthnCredential


def reset_2fa(modeladmin, request, queryset):
    """Clear EVERY two-factor method for the user(s) behind the selected
    rows — not just the one row selected — so a support action always
    leaves the account in a clean, consistent state (no orphaned backup
    codes for a TOTP device that no longer exists, etc.) rather than
    depending on the admin remembering to clean up every model."""
    users = {obj.user for obj in queryset}
    for user in users:
        TOTPDevice.objects.filter(user=user).delete()
        MFABackupCode.objects.filter(user=user).delete()
        WebAuthnCredential.objects.filter(user=user).delete()
    modeladmin.message_user(
        request,
        f'Cleared all two-factor login methods for {len(users)} user(s). '
        f'They can set up fresh ones from Profile > Security.',
        messages.SUCCESS,
    )


reset_2fa.short_description = 'Reset two-factor login (clear ALL methods) for selected users'


@admin.register(TOTPDevice)
class TOTPDeviceAdmin(admin.ModelAdmin):
    list_display = ('user', 'is_confirmed', 'confirmed_at', 'created_at')
    list_filter = ('confirmed_at',)
    search_fields = ('user__username', 'user__email')
    readonly_fields = ('user', 'confirmed_at', 'created_at', 'updated_at')
    exclude = ('secret',)
    actions = [reset_2fa]

    def has_add_permission(self, request):
        # A TOTPDevice created here would have no real secret behind it —
        # enrollment only makes sense through the actual QR-code setup flow.
        return False


@admin.register(MFABackupCode)
class MFABackupCodeAdmin(admin.ModelAdmin):
    list_display = ('user', 'used_at', 'created_at')
    list_filter = ('used_at',)
    search_fields = ('user__username', 'user__email')
    readonly_fields = ('user', 'used_at', 'created_at', 'updated_at')
    exclude = ('code_hash',)
    actions = [reset_2fa]

    def has_add_permission(self, request):
        return False


@admin.register(WebAuthnCredential)
class WebAuthnCredentialAdmin(admin.ModelAdmin):
    list_display = ('user', 'device_name', 'created_at', 'last_used_at')
    list_filter = ('created_at',)
    search_fields = ('user__username', 'user__email', 'device_name')
    readonly_fields = (
        'user', 'credential_id', 'public_key', 'sign_count',
        'device_name', 'created_at', 'last_used_at', 'updated_at',
    )
    actions = [reset_2fa]

    def has_add_permission(self, request):
        # A row here without a real registration ceremony behind it has no
        # matching private key on any device — it could never actually sign in.
        return False

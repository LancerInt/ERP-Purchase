from django.urls import path

from .views import (
    TOTPSetupView, TOTPConfirmView, TOTPDisableView,
    MFAStatusView, RegenerateBackupCodesView, MFAVerifyView,
    WebAuthnRegisterBeginView, WebAuthnRegisterCompleteView, WebAuthnCredentialDeleteView,
    WebAuthnLoginBeginView, WebAuthnLoginCompleteView,
)

urlpatterns = [
    path('totp/setup/', TOTPSetupView.as_view(), name='mfa-totp-setup'),
    path('totp/confirm/', TOTPConfirmView.as_view(), name='mfa-totp-confirm'),
    path('totp/disable/', TOTPDisableView.as_view(), name='mfa-totp-disable'),
    path('status/', MFAStatusView.as_view(), name='mfa-status'),
    path('backup-codes/regenerate/', RegenerateBackupCodesView.as_view(), name='mfa-backup-codes-regenerate'),
    path('verify/', MFAVerifyView.as_view(), name='mfa-verify'),

    path('webauthn/register/begin/', WebAuthnRegisterBeginView.as_view(), name='mfa-webauthn-register-begin'),
    path('webauthn/register/complete/', WebAuthnRegisterCompleteView.as_view(), name='mfa-webauthn-register-complete'),
    path('webauthn/credentials/<uuid:pk>/', WebAuthnCredentialDeleteView.as_view(), name='mfa-webauthn-credential-delete'),
    path('webauthn/login/begin/', WebAuthnLoginBeginView.as_view(), name='mfa-webauthn-login-begin'),
    path('webauthn/login/complete/', WebAuthnLoginCompleteView.as_view(), name='mfa-webauthn-login-complete'),
]

from rest_framework import serializers


class TOTPConfirmSerializer(serializers.Serializer):
    code = serializers.CharField(min_length=6, max_length=6)


class TOTPDisableSerializer(serializers.Serializer):
    code = serializers.CharField(min_length=6, max_length=6)


class MFAVerifySerializer(serializers.Serializer):
    mfa_token = serializers.CharField()
    method = serializers.ChoiceField(choices=['totp', 'backup_code'])
    code = serializers.CharField()


class WebAuthnRegisterCompleteSerializer(serializers.Serializer):
    credential = serializers.JSONField()
    device_name = serializers.CharField(required=False, allow_blank=True, max_length=100)


class WebAuthnLoginBeginSerializer(serializers.Serializer):
    mfa_token = serializers.CharField()


class WebAuthnLoginCompleteSerializer(serializers.Serializer):
    mfa_token = serializers.CharField()
    credential = serializers.JSONField()

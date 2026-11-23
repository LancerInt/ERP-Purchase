"""Authentication classes.

Deliberately separate from core.jwt_auth: DRF resolves
DEFAULT_AUTHENTICATION_CLASSES very early, and jwt_auth imports
rest_framework.views (for APIView), so pointing the setting at a class
living there means importing rest_framework.views while it is still
initialising — a circular import at startup. This module imports only
what an authentication class needs.
"""
from datetime import datetime, timezone as dt_timezone

from django.contrib.auth import get_user_model
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import AuthenticationFailed, InvalidToken
from rest_framework_simplejwt.settings import api_settings


class RevocableJWTAuthentication(JWTAuthentication):
    """JWTAuthentication that honours "sign out everywhere".

    Blacklisting refresh tokens stops sessions RENEWING but cannot touch
    an access token already issued — it is verified by signature and
    never looked up, so the other device keeps working for up to
    ACCESS_TOKEN_LIFETIME. Measured before this existed: after a
    logout-all the second device's refresh correctly 401'd while its API
    calls still answered 200, i.e. the phone carried on as if nothing had
    happened, which made the button a lie.

    This closes that window by rejecting any access token minted before
    the user's revocation stamp (core.models.UserSessionRevocation).

    get_user is reimplemented rather than wrapped so the stamp rides
    along on the SAME query the parent already makes for the user —
    select_related here, no second round trip on every authenticated
    request. A user who has never revoked has no row, so the check
    short-circuits and nothing changes for them.
    """

    def get_user(self, validated_token):
        try:
            user_id = validated_token[api_settings.USER_ID_CLAIM]
        except KeyError:
            raise InvalidToken('Token contained no recognizable user identification')

        User = get_user_model()
        try:
            user = (User.objects
                    .select_related('session_revocation')
                    .get(**{api_settings.USER_ID_FIELD: user_id}))
        except User.DoesNotExist:
            raise AuthenticationFailed('User not found', code='user_not_found')

        if not user.is_active:
            raise AuthenticationFailed('User is inactive', code='user_inactive')

        revocation = getattr(user, 'session_revocation', None)
        issued_at = validated_token.get('iat')
        if revocation is not None and issued_at is not None:
            issued = datetime.fromtimestamp(int(issued_at), tz=dt_timezone.utc)
            if issued < revocation.revoked_at:
                raise AuthenticationFailed(
                    'This session was ended from another device. Please sign in again.',
                    code='session_revoked',
                )
        return user

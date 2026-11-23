"""WebAuthn (biometric) second-factor tests.

The actual cryptographic signature verification (verify_registration_response
/ verify_authentication_response) requires a real authenticator's private
key — that's the `webauthn` library's own job and its own test suite's
responsibility, not this app's. These tests mock ONLY that one call and
verify everything AROUND it: challenge issue/consume, credential storage,
ownership checks, and that the login flow actually mints tokens once
verification succeeds — the same boundary-mocking approach used for any
third-party crypto/payment/signature library.
"""
import json
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase
from webauthn.helpers.structs import (
    AttestationFormat, CredentialDeviceType, PublicKeyCredentialType,
)
from webauthn.registration.verify_registration_response import VerifiedRegistration
from webauthn.authentication.verify_authentication_response import VerifiedAuthentication

from django.utils import timezone

from mfa.models import TOTPDevice, WebAuthnCredential
from rbac.models import ERPRole, UserRoleAssignment


def _fake_registration(credential_id=b'fake-cred-id'):
    return VerifiedRegistration(
        credential_id=credential_id,
        credential_public_key=b'fake-public-key',
        sign_count=0,
        aaguid='00000000-0000-0000-0000-000000000000',
        fmt=AttestationFormat.NONE,
        credential_type=PublicKeyCredentialType.PUBLIC_KEY,
        user_verified=True,
        attestation_object=b'',
        credential_device_type=CredentialDeviceType.SINGLE_DEVICE,
        credential_backed_up=False,
    )


def _fake_authentication(credential_id=b'fake-cred-id', new_sign_count=1):
    return VerifiedAuthentication(
        credential_id=credential_id,
        new_sign_count=new_sign_count,
        credential_device_type=CredentialDeviceType.SINGLE_DEVICE,
        credential_backed_up=False,
        user_verified=True,
    )


class WebAuthnFlowTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        User = get_user_model()
        cls.user = User.objects.create_user(username='webauthn_tester', password='S3curePass!')

    def test_register_begin_requires_auth(self):
        resp = self.client.post('/api/mfa/webauthn/register/begin/')
        self.assertEqual(resp.status_code, 401)

    def test_register_begin_returns_options(self):
        self.client.force_authenticate(self.user)
        resp = self.client.post('/api/mfa/webauthn/register/begin/')
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertIn('challenge', resp.data)
        # Whatever WEBAUTHN_RP_ID actually resolves to in THIS environment
        # (localhost by default, but a developer's .env may point it at a
        # real domain) — the point of this assertion is that the options
        # actually carry settings.WEBAUTHN_RP_ID, not a specific value.
        self.assertEqual(resp.data['rp']['id'], settings.WEBAUTHN_RP_ID)

    def test_register_complete_stores_credential(self):
        self.client.force_authenticate(self.user)
        self.client.post('/api/mfa/webauthn/register/begin/')  # seeds the challenge in cache

        with patch('webauthn.verify_registration_response', return_value=_fake_registration()):
            resp = self.client.post('/api/mfa/webauthn/register/complete/', {
                'credential': {'id': 'fake', 'rawId': 'fake', 'type': 'public-key', 'response': {}},
                'device_name': "Mani's Laptop",
            }, format='json')
        self.assertEqual(resp.status_code, 200, resp.data)

        cred = WebAuthnCredential.objects.get(user=self.user)
        self.assertEqual(cred.device_name, "Mani's Laptop")
        self.assertEqual(cred.sign_count, 0)

    def test_register_complete_without_begin_fails(self):
        """No challenge in cache (never called /begin/, or it expired) —
        must reject rather than trust an unverified credential blob."""
        self.client.force_authenticate(self.user)
        resp = self.client.post('/api/mfa/webauthn/register/complete/', {
            'credential': {'id': 'fake', 'rawId': 'fake', 'type': 'public-key', 'response': {}},
        }, format='json')
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(WebAuthnCredential.objects.filter(user=self.user).exists())

    def test_full_login_flow_via_webauthn(self):
        WebAuthnCredential.objects.create(
            user=self.user, credential_id='ZmFrZS1jcmVkLWlk', public_key='ZmFrZS1wdWJsaWMta2V5',
            sign_count=3, device_name='Test Device',
        )

        login = self.client.post('/api/token/', {'username': 'webauthn_tester', 'password': 'S3curePass!'})
        self.assertEqual(login.status_code, 200, login.data)
        self.assertTrue(login.data.get('mfa_required'))
        self.assertEqual(login.data.get('methods'), ['webauthn'])
        mfa_token = login.data['mfa_token']

        begin = self.client.post('/api/mfa/webauthn/login/begin/', {'mfa_token': mfa_token}, format='json')
        self.assertEqual(begin.status_code, 200, begin.data)
        self.assertIn('challenge', begin.data)

        credential_payload = {'id': 'ZmFrZS1jcmVkLWlk', 'rawId': 'ZmFrZS1jcmVkLWlk', 'type': 'public-key', 'response': {}}
        with patch(
            'webauthn.verify_authentication_response',
            return_value=_fake_authentication(new_sign_count=4),
        ):
            complete = self.client.post('/api/mfa/webauthn/login/complete/', {
                'mfa_token': mfa_token, 'credential': credential_payload,
            }, format='json')
        self.assertEqual(complete.status_code, 200, complete.data)
        self.assertIn('access', complete.data)

        cred = WebAuthnCredential.objects.get(user=self.user)
        self.assertEqual(cred.sign_count, 4)
        self.assertIsNotNone(cred.last_used_at)

    def test_login_complete_rejects_unknown_credential_id(self):
        WebAuthnCredential.objects.create(
            user=self.user, credential_id='knownCredId', public_key='ZmFrZS1wdWJsaWMta2V5',
            sign_count=0, device_name='Test Device',
        )
        login = self.client.post('/api/token/', {'username': 'webauthn_tester', 'password': 'S3curePass!'})
        mfa_token = login.data['mfa_token']
        self.client.post('/api/mfa/webauthn/login/begin/', {'mfa_token': mfa_token}, format='json')

        resp = self.client.post('/api/mfa/webauthn/login/complete/', {
            'mfa_token': mfa_token,
            'credential': {'id': 'someOtherCredentialEntirely', 'rawId': 'x', 'type': 'public-key', 'response': {}},
        }, format='json')
        self.assertEqual(resp.status_code, 400)

    def test_delete_credential_is_scoped_to_owner(self):
        other_user = get_user_model().objects.create_user(username='other_user', password='x')
        cred = WebAuthnCredential.objects.create(
            user=other_user, credential_id='otherCred', public_key='pk', sign_count=0, device_name='Other',
        )
        self.client.force_authenticate(self.user)
        resp = self.client.delete(f'/api/mfa/webauthn/credentials/{cred.id}/')
        self.assertEqual(resp.status_code, 404, "A user must not be able to delete another user's credential.")
        self.assertTrue(WebAuthnCredential.objects.filter(pk=cred.id).exists())

    def test_status_lists_registered_devices(self):
        WebAuthnCredential.objects.create(
            user=self.user, credential_id='c1', public_key='pk', sign_count=0, device_name='Phone',
        )
        self.client.force_authenticate(self.user)
        resp = self.client.get('/api/mfa/status/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data['webauthn_credentials']), 1)
        self.assertEqual(resp.data['webauthn_credentials'][0]['device_name'], 'Phone')

    def test_mandatory_role_blocks_removing_only_credential(self):
        role = ERPRole.objects.create(name='__TEST_MFA_MANDATORY_WA__', mfa_required=True)
        user = get_user_model().objects.create_user(username='mfa_mandatory_wa', password='x')
        UserRoleAssignment.objects.create(user=user, role=role)
        cred = WebAuthnCredential.objects.create(
            user=user, credential_id='onlyOne', public_key='pk', sign_count=0, device_name='Only device',
        )
        self.client.force_authenticate(user)

        resp = self.client.delete(f'/api/mfa/webauthn/credentials/{cred.id}/')
        self.assertEqual(resp.status_code, 400, resp.data)
        self.assertTrue(WebAuthnCredential.objects.filter(pk=cred.id).exists())

    def test_mandatory_role_allows_removing_credential_when_totp_remains(self):
        role = ERPRole.objects.create(name='__TEST_MFA_MANDATORY_WA_2__', mfa_required=True)
        user = get_user_model().objects.create_user(username='mfa_mandatory_wa2', password='x')
        UserRoleAssignment.objects.create(user=user, role=role)
        TOTPDevice.objects.create(user=user, secret='JBSWY3DPEHPK3PXP', confirmed_at=timezone.now())
        cred = WebAuthnCredential.objects.create(
            user=user, credential_id='removable', public_key='pk', sign_count=0, device_name='Removable',
        )
        self.client.force_authenticate(user)

        resp = self.client.delete(f'/api/mfa/webauthn/credentials/{cred.id}/')
        self.assertEqual(resp.status_code, 204, resp.data)
        self.assertFalse(WebAuthnCredential.objects.filter(pk=cred.id).exists())

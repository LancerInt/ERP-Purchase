"""End-to-end tests for the two-factor login flow: setup -> confirm ->
challenged login -> verify. Hits the real /api/token/ and /api/mfa/*
endpoints, not the service functions in isolation, so this exercises the
actual MessagefulTokenObtainPairSerializer interception point too."""
import pyotp
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from mfa.models import TOTPDevice, MFABackupCode
from rbac.models import ERPRole, UserRoleAssignment


class TOTPLoginFlowTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        User = get_user_model()
        cls.user = User.objects.create_user(username='mfa_tester', password='S3curePass!')

    def test_login_without_2fa_is_unchanged(self):
        resp = self.client.post('/api/token/', {'username': 'mfa_tester', 'password': 'S3curePass!'})
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertIn('access', resp.data)
        self.assertIn('refresh', resp.data)
        self.assertNotIn('mfa_required', resp.data)

    def test_setup_confirm_and_challenged_login(self):
        self.client.force_authenticate(self.user)

        setup = self.client.post('/api/mfa/totp/setup/')
        self.assertEqual(setup.status_code, 200, setup.data)
        secret = setup.data['secret']
        self.assertTrue(setup.data['qr_code'].startswith('data:image/png;base64,'))

        wrong = self.client.post('/api/mfa/totp/confirm/', {'code': '000000'})
        self.assertEqual(wrong.status_code, 400)

        code = pyotp.TOTP(secret).now()
        confirm = self.client.post('/api/mfa/totp/confirm/', {'code': code})
        self.assertEqual(confirm.status_code, 200, confirm.data)
        backup_codes = confirm.data['backup_codes']
        self.assertEqual(len(backup_codes), 10)

        device = TOTPDevice.objects.get(user=self.user)
        self.assertTrue(device.is_confirmed)

        self.client.force_authenticate(None)  # simulate a fresh, unauthenticated login attempt

        login = self.client.post('/api/token/', {'username': 'mfa_tester', 'password': 'S3curePass!'})
        self.assertEqual(login.status_code, 200, login.data)
        self.assertTrue(login.data.get('mfa_required'))
        self.assertEqual(login.data.get('methods'), ['totp'])
        self.assertNotIn('access', login.data)
        mfa_token = login.data['mfa_token']

        bad_verify = self.client.post('/api/mfa/verify/', {
            'mfa_token': mfa_token, 'method': 'totp', 'code': '000000',
        })
        self.assertEqual(bad_verify.status_code, 400)

        good_code = pyotp.TOTP(secret).now()
        verify = self.client.post('/api/mfa/verify/', {
            'mfa_token': mfa_token, 'method': 'totp', 'code': good_code,
        })
        self.assertEqual(verify.status_code, 200, verify.data)
        self.assertIn('access', verify.data)
        self.assertIn('refresh', verify.data)

    def test_backup_code_works_once(self):
        self.client.force_authenticate(self.user)
        secret = self.client.post('/api/mfa/totp/setup/').data['secret']
        confirm = self.client.post('/api/mfa/totp/confirm/', {'code': pyotp.TOTP(secret).now()})
        backup_code = confirm.data['backup_codes'][0]
        self.client.force_authenticate(None)

        login = self.client.post('/api/token/', {'username': 'mfa_tester', 'password': 'S3curePass!'})
        mfa_token = login.data['mfa_token']

        first = self.client.post('/api/mfa/verify/', {
            'mfa_token': mfa_token, 'method': 'backup_code', 'code': backup_code,
        })
        self.assertEqual(first.status_code, 200, first.data)

        # Same code again, fresh challenge (the first is spent, not the challenge).
        login2 = self.client.post('/api/token/', {'username': 'mfa_tester', 'password': 'S3curePass!'})
        second = self.client.post('/api/mfa/verify/', {
            'mfa_token': login2.data['mfa_token'], 'method': 'backup_code', 'code': backup_code,
        })
        self.assertEqual(second.status_code, 400, 'A backup code must not be reusable.')

    def test_role_flagged_mfa_required_does_not_lock_out_unenrolled_user(self):
        User = get_user_model()
        role = ERPRole.objects.create(name='__TEST_MFA_REQUIRED_ROLE__', mfa_required=True)
        flagged_user = User.objects.create_user(username='mfa_flagged', password='AnotherPass1!')
        UserRoleAssignment.objects.create(user=flagged_user, role=role)

        login = self.client.post('/api/token/', {'username': 'mfa_flagged', 'password': 'AnotherPass1!'})
        self.assertEqual(login.status_code, 200, login.data)
        self.assertIn('access', login.data, 'A role-mandated-but-not-yet-enrolled user must still be able to log in.')
        self.assertTrue(login.data.get('must_setup_mfa'))

    def test_mandatory_role_blocks_disabling_only_factor(self):
        """mfa_required is meaningless if the person it applies to can just
        turn their own (only) factor back off whenever they like."""
        role = ERPRole.objects.create(name='__TEST_MFA_MANDATORY_DISABLE__', mfa_required=True)
        user = get_user_model().objects.create_user(username='mfa_mandatory', password='AnotherPass1!')
        UserRoleAssignment.objects.create(user=user, role=role)
        self.client.force_authenticate(user)

        secret = self.client.post('/api/mfa/totp/setup/').data['secret']
        self.client.post('/api/mfa/totp/confirm/', {'code': pyotp.TOTP(secret).now()})

        resp = self.client.post('/api/mfa/totp/disable/', {'code': pyotp.TOTP(secret).now()})
        self.assertEqual(resp.status_code, 400, resp.data)
        self.assertTrue(TOTPDevice.objects.filter(user=user, confirmed_at__isnull=False).exists())

    def test_mandatory_role_allows_disabling_totp_when_webauthn_remains(self):
        """Blocking is about ending up with ZERO factors, not about TOTP
        specifically — a registered biometric device is just as valid."""
        from mfa.models import WebAuthnCredential

        role = ERPRole.objects.create(name='__TEST_MFA_MANDATORY_DISABLE_2__', mfa_required=True)
        user = get_user_model().objects.create_user(username='mfa_mandatory2', password='AnotherPass1!')
        UserRoleAssignment.objects.create(user=user, role=role)
        self.client.force_authenticate(user)

        secret = self.client.post('/api/mfa/totp/setup/').data['secret']
        self.client.post('/api/mfa/totp/confirm/', {'code': pyotp.TOTP(secret).now()})
        WebAuthnCredential.objects.create(
            user=user, credential_id='mandatory-disable-2', public_key='pk',
            sign_count=0, device_name='Backup device',
        )

        resp = self.client.post('/api/mfa/totp/disable/', {'code': pyotp.TOTP(secret).now()})
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertFalse(TOTPDevice.objects.filter(user=user).exists())

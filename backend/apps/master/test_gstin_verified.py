"""Tests for the verified-GSTIN improvement on Vendor:
  - is_gstin_verified / gstin_verification_stale / gstin_status_ok properties
  - verify endpoint stores the snapshot AND fills blank deductee_category / PAN
    from the portal truth (without clobbering operator-set values).

The provider is monkeypatched, so no network. Run:
  python manage.py test master.test_gstin_verified
"""
from datetime import timedelta
from unittest import mock

from django.test import TestCase
from django.utils import timezone
from django.contrib.auth.models import User
from rest_framework.test import APIClient

from core.models import Company
from master.models import Vendor


class GstinVerifiedPropertyTests(TestCase):
    def setUp(self):
        self.co = Company.objects.create(legal_name='SS Biochem', company_code='SS')

    def _vendor(self, **kw):
        return Vendor.objects.create(company=self.co, vendor_name='Acme', **kw)

    def test_unverified_vendor(self):
        v = self._vendor()
        self.assertFalse(v.is_gstin_verified)
        self.assertFalse(v.gstin_verification_stale)
        self.assertFalse(v.gstin_status_ok)

    def test_verified_active_is_ok(self):
        v = self._vendor(gstin_verified_at=timezone.now(), gstin_portal_status='ACTIVE')
        self.assertTrue(v.is_gstin_verified)
        self.assertFalse(v.gstin_verification_stale)
        self.assertTrue(v.gstin_status_ok)

    def test_verified_cancelled_not_ok(self):
        v = self._vendor(gstin_verified_at=timezone.now(), gstin_portal_status='CANCELLED')
        self.assertTrue(v.is_gstin_verified)
        self.assertFalse(v.gstin_status_ok)

    def test_stale_after_90_days(self):
        old = timezone.now() - timedelta(days=91)
        v = self._vendor(gstin_verified_at=old, gstin_portal_status='ACTIVE')
        self.assertTrue(v.gstin_verification_stale)

    def test_fresh_within_90_days_not_stale(self):
        recent = timezone.now() - timedelta(days=30)
        v = self._vendor(gstin_verified_at=recent, gstin_portal_status='ACTIVE')
        self.assertFalse(v.gstin_verification_stale)


class VerifyEndpointStoreTests(TestCase):
    def setUp(self):
        self.co = Company.objects.create(legal_name='SS Biochem', company_code='SS')
        self.user = User.objects.create_superuser('u', 'u@x.com', 'p')
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.vendor = Vendor.objects.create(company=self.co, vendor_name='Kriya')

    FAKE = {
        'gstin': '33FECPS9234D1ZH', 'status': 'ACTIVE',
        'legal_name': 'KRIYA BIOSYS PRIVATE LIMITED',
        'deductee_category': 'COMPANY_FIRM_LLP', 'pan': 'FECPS9234D',
        'constitution': 'Private Limited Company',
        'raw': {'gstin': '33FECPS9234D1ZH', 'sts': 'Active'},
    }

    def _post(self, body):
        with mock.patch('master.gst_verify.verify', return_value=dict(self.FAKE)):
            return self.client.post('/api/vendors/verify-gstin/', body, format='json')

    def test_stores_snapshot_and_status(self):
        r = self._post({'gstin': self.FAKE['gstin'], 'vendor_id': str(self.vendor.id)})
        self.assertEqual(r.status_code, 200)
        self.vendor.refresh_from_db()
        self.assertTrue(self.vendor.is_gstin_verified)
        self.assertEqual(self.vendor.gstin_portal_status, 'ACTIVE')
        self.assertEqual(self.vendor.gstin_snapshot.get('sts'), 'Active')

    def test_fills_blank_deductee_and_pan(self):
        self._post({'gstin': self.FAKE['gstin'], 'vendor_id': str(self.vendor.id)})
        self.vendor.refresh_from_db()
        self.assertEqual(self.vendor.deductee_category, 'COMPANY_FIRM_LLP')
        self.assertEqual(self.vendor.pan, 'FECPS9234D')

    def test_does_not_clobber_operator_values(self):
        self.vendor.deductee_category = 'INDIVIDUAL_HUF'
        self.vendor.pan = 'AAAAA1111A'
        self.vendor.save(update_fields=['deductee_category', 'pan'])
        self._post({'gstin': self.FAKE['gstin'], 'vendor_id': str(self.vendor.id)})
        self.vendor.refresh_from_db()
        self.assertEqual(self.vendor.deductee_category, 'INDIVIDUAL_HUF')  # unchanged
        self.assertEqual(self.vendor.pan, 'AAAAA1111A')                    # unchanged

    def test_raw_not_leaked_in_response(self):
        r = self._post({'gstin': self.FAKE['gstin'], 'vendor_id': str(self.vendor.id)})
        self.assertNotIn('raw', r.json())

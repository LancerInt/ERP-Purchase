"""Stock-issue UOM validation.

A packing (PM) item should not be issued in a weight unit (MT/KG), and a
raw-material (RM) item should not be issued in a count unit (PCS/NOS). The
issue endpoint flags a clear cross-type mistake with a helpful message, lets a
sensible unit through, and allows an explicit override.

Covers:
  * the pure rule (uom_fits_category) for RM, PM, unknown category, blank unit,
    and an unlisted custom unit (never block those);
  * the API: PM + 'MT' is rejected 400 with code 'uom_mismatch' + allowed list;
  * the API: PM + 'PCS' is accepted 201;
  * the API: PM + 'MT' + force_uom=true is accepted 201 (override).
"""
from decimal import Decimal
from unittest import mock

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from purchase import stock_views
from purchase.stock_views import uom_fits_category, allowed_uoms_for
from master.models import Product
from inventory.models import StockIssue


class UomRuleTests(TestCase):
    """The pure category↔unit rule, no DB."""

    def test_rm_accepts_weight_rejects_count(self):
        self.assertTrue(uom_fits_category('MT', 'RM'))
        self.assertTrue(uom_fits_category('kg', 'RM'))   # case-insensitive
        self.assertFalse(uom_fits_category('PCS', 'RM'))
        self.assertFalse(uom_fits_category('ROLL', 'RM'))

    def test_pm_accepts_count_rejects_weight(self):
        self.assertTrue(uom_fits_category('PCS', 'PM'))
        self.assertTrue(uom_fits_category('nos', 'PM'))
        self.assertFalse(uom_fits_category('MT', 'PM'))
        self.assertFalse(uom_fits_category('KG', 'PM'))

    def test_no_opinion_cases_never_block(self):
        # Unknown category, blank unit, or a unit in neither list → allowed.
        self.assertTrue(uom_fits_category('MT', ''))
        self.assertTrue(uom_fits_category('MT', 'EXPENSE'))
        self.assertTrue(uom_fits_category('', 'PM'))
        self.assertTrue(uom_fits_category('WIDGET', 'PM'))  # custom unit, unlisted

    def test_allowed_uoms_by_category(self):
        self.assertIn('MT', allowed_uoms_for('RM'))
        self.assertIn('PCS', allowed_uoms_for('PM'))
        self.assertEqual(allowed_uoms_for('EXPENSE'), [])


class IssueUomApiTests(TestCase):
    """The /api/purchase/stock/ issue endpoint enforces the rule."""

    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user('tester', password='pw12345')
        cls.product = Product.objects.create(
            product_name='Bag / Liner', sku_code='SKU-PM-TEST',
        )

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        # Pretend this product resolves to a PM (packing) category, without
        # having to build the whole bill graph the real resolver walks.
        self._patch = mock.patch.object(
            stock_views, 'product_category', return_value='PM')
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def _issue(self, **extra):
        body = {
            'action': 'issue', 'product': str(self.product.id),
            'quantity': '10', 'issue_date': '2026-11-24',
        }
        body.update(extra)
        return self.client.post('/api/purchase/stock/', body, format='json')

    def test_pm_weight_unit_is_rejected(self):
        resp = self._issue(uom='MT')
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.data.get('code'), 'uom_mismatch')
        self.assertEqual(resp.data.get('category'), 'PM')
        self.assertIn('PCS', resp.data.get('allowed_uoms', []))
        # Nothing was written.
        self.assertEqual(StockIssue.objects.filter(product=self.product).count(), 0)

    def test_pm_count_unit_is_accepted(self):
        resp = self._issue(uom='PCS')
        self.assertEqual(resp.status_code, 201)
        si = StockIssue.objects.get(product=self.product)
        self.assertEqual(si.uom, 'PCS')
        self.assertEqual(si.quantity, Decimal('10'))

    def test_force_override_allows_mismatch(self):
        resp = self._issue(uom='MT', force_uom='true')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(StockIssue.objects.filter(product=self.product, uom='MT').count(), 1)

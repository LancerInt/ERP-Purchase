"""Regression test for RolePermissionViewSet.bulk_assign's delete scope.

Why this exists: bulk_assign used to do
`RolePermission.objects.filter(role=role).delete()` — every permission row
for the WHOLE role — before recreating only the modules in the request.
That was safe only if every caller always submitted a role's complete
permission set in one request. It doesn't: the admin permissions UI is nine
separate category pages (Sales/Purchase/Freight/Production/Inventory/HR/
Finance/Bank/Masters — see frontend/src/pages/admin/permissions/*.jsx),
each fetching and saving ONLY its own category's modules. Saving from any
one of those pages silently deleted the role's permissions for every OTHER
category, with nothing in the request to restore them — indistinguishable
from "permissions got reset" from an admin's point of view, and it happened
on every single save, not as a rare edge case.

DO NOT weaken or remove this test to make some other change pass — if it
starts failing, the fix is to scope the delete more carefully, not to
delete fewer assertions here. If you're touching bulk_assign at all, re-read
the incident this guards against first.
"""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from rbac.models import ERPRole, ERPModule, RolePermission


class BulkAssignScopingTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.role = ERPRole.objects.create(name='Test Role — Bulk Assign Scoping')
        cls.module_sales = ERPModule.objects.create(
            name='Test Sales Module', slug='test-sales-module', category='SALES',
        )
        cls.module_purchase = ERPModule.objects.create(
            name='Test Purchase Module', slug='test-purchase-module', category='PURCHASE',
        )
        User = get_user_model()
        cls.user = User.objects.create_superuser(
            username='rbac_tester', email='rbac_tester@test.com', password='x',
        )

    def setUp(self):
        self.client.force_authenticate(self.user)
        self.url = '/api/rbac/role-permissions/bulk/'
        RolePermission.objects.create(
            role=self.role, module=self.module_sales, can_view=True, can_create=True,
        )
        RolePermission.objects.create(
            role=self.role, module=self.module_purchase, can_view=True, can_create=False,
        )

    def test_partial_category_save_does_not_delete_other_categories(self):
        """Saving ONLY the Sales-category permissions (as the real Sales
        permissions page does) must leave the role's Purchase-category
        permissions untouched."""
        resp = self.client.post(self.url, {
            'role_id': self.role.id,
            'permissions': [
                {'module_id': self.module_sales.id, 'can_view': True, 'can_create': False},
            ],
        }, format='json')
        self.assertEqual(resp.status_code, 200, resp.data)

        sales_perm = RolePermission.objects.get(role=self.role, module=self.module_sales)
        self.assertTrue(sales_perm.can_view)
        self.assertFalse(sales_perm.can_create, 'Submitted change should apply.')

        self.assertTrue(
            RolePermission.objects.filter(role=self.role, module=self.module_purchase).exists(),
            "A Sales-only save deleted this role's Purchase permissions — "
            "the exact regression this test exists to catch. See "
            "RolePermissionViewSet.bulk_assign's docstring.",
        )
        purchase_perm = RolePermission.objects.get(role=self.role, module=self.module_purchase)
        self.assertTrue(purchase_perm.can_view)
        self.assertFalse(purchase_perm.can_create)

    def test_full_role_save_still_replaces_submitted_modules(self):
        """Submitting a module already covered replaces its flags (not an
        insert-only / ignore-on-conflict no-op)."""
        resp = self.client.post(self.url, {
            'role_id': self.role.id,
            'permissions': [
                {'module_id': self.module_sales.id, 'can_view': False, 'can_create': True},
                {'module_id': self.module_purchase.id, 'can_view': True, 'can_create': True},
            ],
        }, format='json')
        self.assertEqual(resp.status_code, 200, resp.data)

        sales_perm = RolePermission.objects.get(role=self.role, module=self.module_sales)
        self.assertFalse(sales_perm.can_view)
        self.assertTrue(sales_perm.can_create)
        purchase_perm = RolePermission.objects.get(role=self.role, module=self.module_purchase)
        self.assertTrue(purchase_perm.can_create)

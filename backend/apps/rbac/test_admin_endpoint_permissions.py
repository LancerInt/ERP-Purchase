"""Regression test: the Admin menu and the Admin API must agree on "admin".

Why this exists: the RBAC viewsets used to be gated on DRF's `IsAdminUser`,
which tests Django's `is_staff` flag. Everything the USER sees is decided
somewhere else — the sidebar, the Profile page and /api/rbac/my-permissions/
all read the ERP ROLE (`_is_office_manager_or_admin`, i.e. Office Manager /
IT Admin / superuser).

Those are two different notions of "admin", and nothing kept them in sync.
A real account holding the "IT Admin" role but with `is_staff=False` was
therefore shown the entire Admin section and then got 403 from every
endpoint behind it. In production that surfaced as "We couldn't load this
list." on /admin/users, with `GET /api/rbac/users/?page_size=500 403
(Forbidden)` in the browser console — a user who had been granted admin
being told, by the same app, that they were not one.

The invariant these tests pin down is the agreement itself: if
my-permissions reports `is_admin: true`, the admin endpoints must answer;
if it reports false, they must refuse. Checking the two sides together is
the point — testing either alone is what let them drift apart.

Note the two tiers below. `roles` and `modules` deliberately allow ANY
authenticated user to list/retrieve (see the get_permissions overrides on
ERPRoleViewSet / ERPModuleViewSet — the app needs every user to be able to
read the role and module catalogue) and gate only writes. That split is
pre-existing and was NOT changed by the is_staff fix; only the write gate
on those two moved. Lumping them in with the admin-only endpoints is wrong
and an earlier draft of this file got it wrong, so the tiers are kept
explicit here rather than inferred.

DO NOT relax these by granting the test users `is_staff=True`. That would
make the suite pass while restoring the exact production bug, because
`is_staff=True` is precisely the condition the broken code needed and the
real IT Admin account did not have.
"""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from rbac.models import ERPRole, UserRoleAssignment

# Admin-only for READ as well as write: the data itself is privileged.
# Listed explicitly rather than discovered from the router so a newly added
# admin viewset doesn't silently opt out of this guarantee.
ADMIN_ONLY_ENDPOINTS = (
    '/api/rbac/users/',
    '/api/rbac/permissions/',
    '/api/rbac/role-permissions/',
    '/api/rbac/role-field-permissions/',
    '/api/rbac/user-permission-overrides/',
    '/api/rbac/user-field-permission-overrides/',
)

# Readable by any authenticated user, writable only by an admin. This is the
# tier whose WRITE gate the is_staff fix actually moved.
OPEN_READ_ADMIN_WRITE_ENDPOINTS = (
    '/api/rbac/roles/',
    '/api/rbac/modules/',
)


class AdminEndpointPermissionTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        User = get_user_model()
        # get_or_create, not create: the rbac migrations seed the real
        # 'IT Admin' and 'Office Manager' rows (0003 does an
        # ERPRole.objects.get on IT Admin), and ERPRole.name is unique, so
        # create() would raise IntegrityError against a migrated test DB.
        cls.it_admin_role, _ = ERPRole.objects.get_or_create(name='IT Admin')
        cls.office_manager_role, _ = ERPRole.objects.get_or_create(name='Office Manager')
        cls.plain_role, _ = ERPRole.objects.get_or_create(name='Test Store Keeper')

        # is_staff deliberately left False on all of these — that is the
        # production situation the old gate got wrong.
        cls.it_admin = User.objects.create_user(
            username='perm_it_admin', email='it_admin@test.com', password='x',
        )
        UserRoleAssignment.objects.create(user=cls.it_admin, role=cls.it_admin_role)

        cls.office_manager = User.objects.create_user(
            username='perm_office_mgr', email='office_mgr@test.com', password='x',
        )
        UserRoleAssignment.objects.create(
            user=cls.office_manager, role=cls.office_manager_role,
        )

        cls.non_admin = User.objects.create_user(
            username='perm_store_keeper', email='store_keeper@test.com', password='x',
        )
        UserRoleAssignment.objects.create(user=cls.non_admin, role=cls.plain_role)

        cls.roleless = User.objects.create_user(
            username='perm_roleless', email='roleless@test.com', password='x',
        )

    def _is_admin_per_api(self, user):
        """What the app TELLS this user they are — the same flag the sidebar
        uses to decide whether to render the Admin section."""
        self.client.force_authenticate(user)
        resp = self.client.get('/api/rbac/my-permissions/')
        self.assertEqual(
            resp.status_code, 200,
            'my-permissions must answer for any authenticated user',
        )
        return resp.data.get('is_admin', False)

    # ── the bug ───────────────────────────────────────────────────────────

    def test_it_admin_role_without_is_staff_can_read_admin_endpoints(self):
        """The exact production account: IT Admin role, is_staff False."""
        self.assertFalse(
            self.it_admin.is_staff,
            'guard: this test is only meaningful while is_staff is False',
        )
        self.client.force_authenticate(self.it_admin)
        for url in ADMIN_ONLY_ENDPOINTS:
            with self.subTest(url=url):
                self.assertEqual(
                    self.client.get(url).status_code, 200,
                    '%s refused a user the app shows the Admin menu to' % url,
                )

    def test_office_manager_role_without_is_staff_can_read_admin_endpoints(self):
        self.assertFalse(self.office_manager.is_staff)
        self.client.force_authenticate(self.office_manager)
        for url in ADMIN_ONLY_ENDPOINTS:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 200, url)

    def test_it_admin_role_without_is_staff_can_write_roles_and_modules(self):
        """The write gate on roles/modules moved from is_staff to the ERP
        role, so an IT Admin must now get past the permission layer. Asserts
        only "not 403" — whether the payload then validates is the
        serializer's business, not this gate's."""
        self.client.force_authenticate(self.it_admin)
        for url in OPEN_READ_ADMIN_WRITE_ENDPOINTS:
            with self.subTest(url=url):
                code = self.client.post(url, {}, format='json').status_code
                self.assertNotEqual(
                    code, 403,
                    '%s refused a write to a user holding the IT Admin role' % url,
                )

    # ── the other half: it must still be locked ───────────────────────────

    def test_non_admin_role_is_refused_on_admin_only_endpoints(self):
        """Widening the gate must not have opened it to everyone."""
        self.client.force_authenticate(self.non_admin)
        for url in ADMIN_ONLY_ENDPOINTS:
            with self.subTest(url=url):
                self.assertEqual(
                    self.client.get(url).status_code, 403,
                    '%s let a non-admin role through' % url,
                )

    def test_roleless_user_is_refused_on_admin_only_endpoints(self):
        self.client.force_authenticate(self.roleless)
        for url in ADMIN_ONLY_ENDPOINTS:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 403, url)

    def test_non_admin_can_read_but_not_write_roles_and_modules(self):
        """The pre-existing two-tier rule on these two viewsets: the
        catalogue is readable by anyone signed in, writable only by an
        admin. The fix must not have flattened either half."""
        self.client.force_authenticate(self.non_admin)
        for url in OPEN_READ_ADMIN_WRITE_ENDPOINTS:
            with self.subTest(url=url, method='GET'):
                self.assertEqual(
                    self.client.get(url).status_code, 200,
                    '%s should stay readable by any authenticated user' % url,
                )
            with self.subTest(url=url, method='POST'):
                self.assertEqual(
                    self.client.post(url, {}, format='json').status_code, 403,
                    '%s let a non-admin write' % url,
                )

    def test_anonymous_is_refused(self):
        self.client.force_authenticate(None)
        for url in ADMIN_ONLY_ENDPOINTS + OPEN_READ_ADMIN_WRITE_ENDPOINTS:
            with self.subTest(url=url):
                self.assertIn(self.client.get(url).status_code, (401, 403), url)

    # ── the invariant that actually broke ─────────────────────────────────

    def test_menu_and_api_agree_for_every_kind_of_user(self):
        """is_admin from my-permissions must predict whether the admin
        endpoints answer. This is the assertion that would have caught the
        original bug: both sides were individually "correct", just by
        different definitions."""
        for user in (self.it_admin, self.office_manager,
                     self.non_admin, self.roleless):
            shown_as_admin = self._is_admin_per_api(user)
            self.client.force_authenticate(user)
            got = self.client.get('/api/rbac/users/').status_code
            with self.subTest(user=user.username, is_admin=shown_as_admin):
                if shown_as_admin:
                    self.assertEqual(
                        got, 200,
                        '%s is told is_admin=true but the API returns %s'
                        % (user.username, got),
                    )
                else:
                    self.assertEqual(
                        got, 403,
                        '%s is told is_admin=false but the API returns %s'
                        % (user.username, got),
                    )

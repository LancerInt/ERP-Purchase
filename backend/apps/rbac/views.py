from django.contrib.auth import get_user_model
from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from rbac.filters import AuditLogFilter
from rbac.models import (
    ERPRole,
    ERPModule,
    ERPPermission,
    RolePermission,
    UserRoleAssignment,
    AuditLog,
)
from rbac.serializers import (
    ERPRoleSerializer,
    ERPModuleSerializer,
    ERPPermissionSerializer,
    ERPPermissionWriteSerializer,
    RolePermissionSerializer,
    RolePermissionWriteSerializer,
    UserRoleAssignmentSerializer,
    AuditLogSerializer,
    UserWithRoleSerializer,
    UserWithPermissionsSerializer,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _validate_admin_set_password(password, user=None):
    """Password policy for ADMIN-set passwords (user create + reset).

    Runs the configured AUTH_PASSWORD_VALIDATORS minus the
    UserAttributeSimilarityValidator: admins hand out initial passwords
    like "<username>123" as a deliberate convention, and rejecting those
    with "too similar to the username" just blocks the reset flow. The
    remaining validators (minimum length, common-password, numeric-only)
    still apply. Raises django ValidationError on failure.
    """
    from django.conf import settings
    from django.contrib.auth.password_validation import (
        get_password_validators, validate_password,
    )
    validators = [
        v for v in get_password_validators(settings.AUTH_PASSWORD_VALIDATORS)
        if v.__class__.__name__ != 'UserAttributeSimilarityValidator'
    ]
    validate_password(password, user=user, password_validators=validators)


def _is_office_manager_or_admin(user):
    """Return True if user is superuser or has Office Manager / IT Admin role."""
    if user.is_superuser:
        return True
    try:
        assignment = UserRoleAssignment.objects.select_related('role').get(user=user)
        if assignment.role.name in ('Office Manager', 'IT Admin'):
            return True
    except UserRoleAssignment.DoesNotExist:
        pass
    return False


class IsAdminOrOfficeManager(permissions.BasePermission):
    """Allow access to superusers and Office Manager / IT Admin role holders.

    This, not DRF's IsAdminUser, is what gates the RBAC admin screens.
    IsAdminUser tests Django's is_staff flag, which is a DIFFERENT notion of
    "admin" from the one this app actually uses everywhere else: the sidebar,
    the Profile page and /api/rbac/my-permissions/ all decide from the ERP
    ROLE. The two disagreeing meant a user holding the "IT Admin" role was
    shown the whole Admin section and then got 403 from every endpoint behind
    it — observed in production as "We couldn't load this list." on
    /admin/users, with `GET /api/rbac/users/ 403 (Forbidden)` in the console.
    Gating on the same thing the UI grants keeps the menu and the API telling
    the same story."""

    def has_permission(self, request, view):
        return (
            request.user
            and request.user.is_authenticated
            and _is_office_manager_or_admin(request.user)
        )


# ---------------------------------------------------------------------------
# ViewSets
# ---------------------------------------------------------------------------

class ERPRoleViewSet(viewsets.ModelViewSet):
    """CRUD for ERP Roles.  Non-admin users get read-only access."""

    queryset = ERPRole.objects.all()
    serializer_class = ERPRoleSerializer
    permission_classes = [IsAuthenticated]
    search_fields = ['name']
    ordering_fields = ['name', 'created_at']

    def get_permissions(self):
        if self.action in ('list', 'retrieve'):
            return [IsAuthenticated()]
        return [IsAdminOrOfficeManager()]


class ERPModuleViewSet(viewsets.ModelViewSet):
    """List ERP Modules.  Returns only modules the user's role has access to
    (unless user is admin, in which case all are returned)."""

    serializer_class = ERPModuleSerializer
    permission_classes = [IsAuthenticated]
    search_fields = ['name', 'slug']
    ordering_fields = ['order', 'name']

    def get_queryset(self):
        qs = ERPModule.objects.filter(is_active=True)
        if self.request.user.is_superuser:
            return qs
        # Role-based: get user's role, then find modules with can_view
        try:
            assignment = UserRoleAssignment.objects.select_related('role').get(
                user=self.request.user
            )
            allowed_module_ids = RolePermission.objects.filter(
                role=assignment.role,
                can_view=True,
            ).values_list('module_id', flat=True)
            return qs.filter(id__in=allowed_module_ids)
        except UserRoleAssignment.DoesNotExist:
            return qs.none()

    def get_permissions(self):
        if self.action in ('list', 'retrieve'):
            return [IsAuthenticated()]
        return [IsAdminOrOfficeManager()]


class ERPPermissionViewSet(viewsets.ModelViewSet):
    """Manage per-user module permissions (LEGACY).  Admin only."""

    queryset = ERPPermission.objects.select_related('user', 'module', 'granted_by').all()
    permission_classes = [IsAdminOrOfficeManager]
    filterset_fields = ['user', 'module', 'can_view', 'can_create', 'can_edit', 'can_delete']
    search_fields = ['user__username', 'module__name']
    ordering_fields = ['granted_at', 'module__order']

    def get_serializer_class(self):
        if self.action in ('create', 'update', 'partial_update'):
            return ERPPermissionWriteSerializer
        return ERPPermissionSerializer

    @action(detail=False, methods=['post'], url_path='bulk')
    def bulk_assign(self, request):
        """Bulk-assign permissions (LEGACY user-based).

        Expects: { "user": <id>, "permissions": [ { "module": <id>, "can_view": true, ... }, ... ] }
        """
        user_id = request.data.get('user')
        perms_data = request.data.get('permissions', [])

        if not user_id or not perms_data:
            return Response(
                {'detail': 'user and permissions are required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            target_user = User.objects.get(pk=user_id)
        except User.DoesNotExist:
            return Response(
                {'detail': 'User not found.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        results = []
        for perm in perms_data:
            module_id = perm.get('module')
            if not module_id:
                continue
            obj, _ = ERPPermission.objects.update_or_create(
                user=target_user,
                module_id=module_id,
                defaults={
                    'can_view': perm.get('can_view', False),
                    'can_create': perm.get('can_create', False),
                    'can_edit': perm.get('can_edit', False),
                    'can_delete': perm.get('can_delete', False),
                    'granted_by': request.user,
                },
            )
            results.append(ERPPermissionSerializer(obj).data)

        return Response(results, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# NEW: Role-based Permission ViewSet
# ---------------------------------------------------------------------------

class RolePermissionViewSet(viewsets.ModelViewSet):
    """Manage role-module permissions.  Admin only.

    Supports standard CRUD plus a bulk_assign action.
    """

    queryset = RolePermission.objects.select_related('role', 'module').all()
    permission_classes = [IsAdminOrOfficeManager]
    filterset_fields = ['role', 'module', 'can_view', 'can_create', 'can_edit', 'can_delete', 'can_approve', 'can_reject', 'can_send_email', 'can_export', 'can_print', 'can_import', 'can_confirm', 'can_close', 'can_cancel', 'can_issue', 'can_convert']
    search_fields = ['role__name', 'module__name']
    ordering_fields = ['role__name', 'module__name']

    def get_serializer_class(self):
        if self.action in ('create', 'update', 'partial_update'):
            return RolePermissionWriteSerializer
        return RolePermissionSerializer

    # Every writable flag on RolePermission. Kept as one explicit list so
    # bulk_assign can build each row with a dict comprehension instead of a
    # 40-plus-line literal repeated per module.
    _FLAG_FIELDS = [
        'can_view', 'can_create', 'can_edit', 'can_delete', 'can_approve',
        'can_reject', 'can_submit', 'can_proceed_approval', 'can_send_email',
        'can_export', 'can_print', 'can_import', 'can_confirm', 'can_close',
        'can_cancel', 'can_issue', 'can_convert', 'can_acknowledge',
        'can_create_dc', 'can_create_so', 'can_view_inbox', 'can_create_freight',
        'can_create_bom', 'can_quote_response', 'can_evaluate', 'can_create_bill',
        'can_create_wage', 'can_record_payment', 'can_apply_debit', 'can_apply_credit',
        'can_apply_advance', 'can_apply_to_bill', 'can_skip_rfq', 'can_direct_receipt',
        'can_return_customer', 'can_return_sales', 'can_return_damage', 'can_return_qc',
        'can_request_amendment', 'can_approve_amendment', 'req_scope_goods',
        'req_scope_services', 'req_scope_machinery', 'can_push_tally',
    ]

    @action(detail=False, methods=['post'], url_path='bulk')
    def bulk_assign(self, request):
        """Replace RolePermission rows for the modules SUBMITTED, in one round trip.

        Expects:
        {
            "role_id": <id>,
            "permissions": [
                { "module_id": <id>, "can_view": true, "can_create": false, ... },
                ...
            ]
        }

        Deliberately scoped to only the submitted module ids — NOT a
        delete-everything-for-this-role. The admin permissions UI is nine
        separate category pages (Sales/Purchase/Freight/Production/
        Inventory/HR/Finance/Bank/Masters — see frontend/src/pages/admin/
        permissions/*.jsx), each fetching and submitting only its own
        category's modules. An earlier version of this action deleted
        EVERY RolePermission row for the role before recreating only the
        submitted ones, on the wrong assumption that "the grid always
        submits the full set at once" — true per-module, false per-role.
        Saving from the Sales page alone silently wiped that role's
        Purchase/Finance/HR/... permissions on every single save. Scoping
        the delete to `module_id__in=valid_ids` makes a save touch only
        the modules it actually carries data for.

        This still validates every module id with one query, replaces
        rows with a single bulk_create (which does not fire post_save —
        the per-row signal write is gone, in favour of the one summary
        row below), and reads the result back in one query — the
        N+1-query fix this action was built for is unaffected.
        """
        role_id = request.data.get('role_id')
        perms_data = request.data.get('permissions', [])

        if not role_id or not perms_data:
            return Response(
                {'detail': 'role_id and permissions are required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            role = ERPRole.objects.get(pk=role_id)
        except ERPRole.DoesNotExist:
            return Response(
                {'detail': 'Role not found.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        submitted_ids = {p.get('module_id') for p in perms_data if p.get('module_id')}
        # Compared as strings on both sides — module_id arrives as whatever
        # JSON sends (a string), while .values_list('id', ...) hands back
        # real int/UUID PK objects, and `123 in {123}` is fine but
        # `"123" in {123}` silently never matches.
        valid_ids = {str(x) for x in
                    ERPModule.objects.filter(id__in=submitted_ids).values_list('id', flat=True)}

        rows = [
            RolePermission(
                role=role, module_id=perm['module_id'],
                **{f: bool(perm.get(f, False)) for f in self._FLAG_FIELDS},
            )
            for perm in perms_data
            if str(perm.get('module_id')) in valid_ids
        ]

        from django.db import transaction as db_transaction
        from rbac.signals import suppress_role_permission_delete_log
        with db_transaction.atomic():
            with suppress_role_permission_delete_log():
                RolePermission.objects.filter(role=role, module_id__in=valid_ids).delete()
            if rows:
                RolePermission.objects.bulk_create(rows)
            AuditLog.objects.create(
                user=request.user,
                action='EDIT',
                module_name='Permissions',
                details=f"Updated permissions for role '{role.name}' ({len(rows)} module(s)).",
            )

        fresh = RolePermission.objects.filter(role=role).select_related('role', 'module')
        return Response(RolePermissionSerializer(fresh, many=True).data, status=status.HTTP_200_OK)


class AuditLogViewSet(viewsets.ReadOnlyModelViewSet):
    """Read-only access to audit logs.

    Two access modes:
      * Per-record activity tab — any authenticated user, but ONLY when
        the query includes `record_id` (they already need to know the
        UUID, and the RBAC gate on the parent record's detail page
        controls whether the UI even surfaces the tab).
      * Full audit browser — admin / office manager only; the
        `IsAdminOrOfficeManager` check enforces this when no
        `record_id` is supplied.

    The full per-event trail (list/retrieve, below) is never pruned or
    collapsed — a record's own Activity tab depends on every past event
    for THAT record still being there. `by_user` is a read-only summary
    on top of the same table, not a replacement for it.
    """

    queryset = AuditLog.objects.select_related('user').all()
    serializer_class = AuditLogSerializer
    filterset_class = AuditLogFilter
    search_fields = ['user__username', 'module_name', 'details', 'record_repr']
    ordering_fields = ['timestamp']

    def get_permissions(self):
        # Per-record queries (`?record_id=<uuid>`) are open to any
        # authenticated user. Broader browsing requires the elevated
        # role — same rule as before for that path.
        rid = self.request.query_params.get('record_id') if hasattr(self, 'request') else None
        if rid:
            from rest_framework.permissions import IsAuthenticated
            return [IsAuthenticated()]
        return [IsAdminOrOfficeManager()]

    @action(detail=False, methods=['get'], url_path='by-user')
    def by_user(self, request):
        """One row per active user: current role, last login, and their
        single most recent audit event (across every module). This is
        what the Audit Logs page shows by default — a fast summary,
        not a second copy of the data. A user's full history is still
        the plain list view (`?user=<username>`), unaffected.
        """
        from django.db.models import Max
        from common.audit import _role_name_for

        latest_ids = (
            AuditLog.objects.exclude(user__isnull=True)
            .values('user').annotate(latest_id=Max('id'))
            .values_list('latest_id', flat=True)
        )
        latest_by_user_id = {
            row.user_id: row
            for row in AuditLog.objects.filter(id__in=latest_ids).select_related('user')
        }

        rows = []
        for u in User.objects.filter(is_active=True).order_by('username'):
            last = latest_by_user_id.get(u.id)
            rows.append({
                'id': u.id,
                'username': u.username,
                'user_display': u.get_full_name() or u.username,
                'role_name': _role_name_for(u),
                'last_login': u.last_login,
                'last_activity': AuditLogSerializer(last).data if last else None,
            })
        # Most recently active first; a user who's never done anything
        # (no audit row at all — e.g. a brand-new account) sorts last.
        rows.sort(key=lambda r: (r['last_activity'] or {}).get('timestamp') or '', reverse=True)
        return Response(rows)


class UserManagementViewSet(viewsets.ModelViewSet):
    """Admin-only user management.

    Provides list, create (with optional ERP role assignment), and
    role assignment helpers.  Users are returned with their ERP role info.
    """

    queryset = User.objects.all().order_by('username')
    serializer_class = UserWithRoleSerializer
    permission_classes = [IsAdminOrOfficeManager]
    search_fields = ['username', 'email', 'first_name', 'last_name']
    ordering_fields = ['username', 'date_joined']

    def create(self, request, *args, **kwargs):
        """Create a new Django user with optional ERP role assignment.

        Expects:
        {
            "username": "...",
            "password": "...",
            "email": "...",
            "first_name": "...",
            "last_name": "...",
            "role_id": 1   // optional - ERPRole ID
        }
        """
        data = request.data
        username = data.get('username')
        password = data.get('password')

        if not username or not password:
            return Response(
                {'detail': 'username and password are required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Case-INSENSITIVE duplicate check. Django's username uniqueness is
        # case-sensitive, so "kumaresan" and "Kumaresan" could both be
        # created — and login then authenticated against whichever the
        # lookup found first, making a password reset on the other account
        # appear to "not work". Never allow a case-variant duplicate.
        if User.objects.filter(username__iexact=username).exists():
            return Response(
                {'detail': 'A user with that username already exists (usernames are case-insensitive).'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Enforce the configured password policy (AUTH_PASSWORD_VALIDATORS).
        # create_user()/set_password() do NOT run validators on their own.
        from django.core.exceptions import ValidationError as DjangoValidationError
        try:
            _validate_admin_set_password(password)
        except DjangoValidationError as e:
            return Response({'detail': ' '.join(e.messages), 'password': e.messages},
                            status=status.HTTP_400_BAD_REQUEST)

        user = User.objects.create_user(
            username=username,
            password=password,
            email=data.get('email', ''),
            first_name=data.get('first_name', ''),
            last_name=data.get('last_name', ''),
        )

        # Stamp the audit log so the "password last changed" timestamp
        # on the edit page is populated from the moment the user exists.
        AuditLog.objects.create(
            user=user,
            action='PASSWORD',
            module_name='User',
            details=f'Initial password set by {getattr(request.user, "username", "system")}',
            ip_address=request.META.get('REMOTE_ADDR'),
        )

        # Auto-provision a StakeholderUser profile so the new account
        # immediately shows up in the Sales > Data Permissions tab and
        # any other surface that lists `/api/users/`. Without this, the
        # new Django user is invisible to warehouse-scope assignment
        # until something else triggers the list-backfill in
        # StakeholderUserViewSet.list(). Idempotent via get_or_create.
        try:
            from core.models import StakeholderUser
            su, _su_created = StakeholderUser.objects.get_or_create(
                user=user,
                defaults={
                    'primary_email': user.email or '',
                    'status': 'ACTIVE',
                },
            )
            # Link the chosen HR Staff record so company/warehouse defaults
            # resolve for the new account (the create form's Staff dropdown
            # previously only suggested a username and was otherwise dropped).
            staff_id = data.get('staff') or data.get('employee_record')
            if staff_id:
                from hr.models import Staff
                try:
                    staff_obj = Staff.objects.get(pk=staff_id)
                    su.employee_record = staff_obj
                    # Backfill email from the staff record when the request
                    # didn't carry one, so the account isn't left contactless.
                    if not user.email and staff_obj.email:
                        user.email = staff_obj.email
                        user.save(update_fields=['email'])
                    if not su.primary_email:
                        su.primary_email = user.email or staff_obj.email or ''
                    su.save(update_fields=['employee_record', 'primary_email'])
                except Staff.DoesNotExist:
                    pass
        except Exception:
            # If core app isn't installed for some reason, fall back
            # silently — the list-backfill in core will catch it later.
            pass

        # Assign ERP role if provided (accept both 'role_id' and 'role')
        role_id = data.get('role_id') or data.get('role')
        if role_id:
            try:
                role = ERPRole.objects.get(pk=role_id)
                UserRoleAssignment.objects.create(
                    user=user,
                    role=role,
                    assigned_by=request.user,
                )
            except ERPRole.DoesNotExist:
                pass  # silently skip if role doesn't exist

        serializer = self.get_serializer(user)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    def perform_update(self, serializer):
        """Handle user update including role change and password hashing."""
        # Extract password before serializer.save() to avoid saving plain text
        password = self.request.data.get('password')

        # Enforce the password policy BEFORE persisting anything, so an invalid
        # password is a clean 400 with no partial write of the other fields.
        if password:
            from django.core.exceptions import ValidationError as DjangoValidationError
            from rest_framework.exceptions import ValidationError as DRFValidationError
            try:
                _validate_admin_set_password(password, user=serializer.instance)
            except DjangoValidationError as e:
                raise DRFValidationError({'password': e.messages})

        user = serializer.save()

        # Hash the password properly if it was provided
        if password:
            user.set_password(password)
            user.save(update_fields=['password'])
            # Lift any login lockout — it was earned with the OLD password,
            # and must not block the freshly-reset credential.
            from core.jwt_auth import clear_login_lock_for
            clear_login_lock_for(user.username, user.email)
            # Stamp the audit log so the edit page can show admins when
            # the user's password was last changed. Separate from EDIT so
            # a quick `.filter(action='PASSWORD')` is cheap.
            AuditLog.objects.create(
                user=user,
                action='PASSWORD',
                module_name='User',
                details=f'Password changed by {getattr(self.request.user, "username", "system")}',
                ip_address=self.request.META.get('REMOTE_ADDR'),
            )

        # Handle role assignment if role_id is in the request
        role_id = self.request.data.get('role_id') or self.request.data.get('role')
        if role_id:
            try:
                role = ERPRole.objects.get(pk=role_id)
                UserRoleAssignment.objects.update_or_create(
                    user=user,
                    defaults={'role': role, 'assigned_by': self.request.user}
                )
            except ERPRole.DoesNotExist:
                pass

    def destroy(self, request, *args, **kwargs):
        """Delete a user — but if they have transaction history (records
        protected by FK, e.g. PurchaseOrder.created_by / InventoryLedger.
        created_by), a hard delete would wipe who-created-what. In that
        case DEACTIVATE the account instead: login is revoked while every
        record is preserved. Users with no history are deleted outright."""
        from django.db.models import ProtectedError
        instance = self.get_object()
        try:
            self.perform_destroy(instance)
        except ProtectedError:
            if instance.is_active:
                instance.is_active = False
                instance.save(update_fields=['is_active'])
            return Response(
                {
                    'detail': (
                        f"'{instance.username}' has existing records in the system and can't be "
                        "permanently deleted. The account has been deactivated instead — login is "
                        "revoked and all their records are kept."
                    ),
                    'deactivated': True,
                },
                status=status.HTTP_200_OK,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)

    def perform_destroy(self, instance):
        """Guard hard-deletes so an admin can't lock the org out: block
        deleting your own account or the last remaining active superuser."""
        from rest_framework.exceptions import ValidationError as DRFValidationError
        if instance.pk == self.request.user.pk:
            raise DRFValidationError({'detail': 'You cannot delete your own account.'})
        if instance.is_superuser:
            other_superusers = (
                User.objects.filter(is_superuser=True, is_active=True)
                .exclude(pk=instance.pk)
                .exists()
            )
            if not other_superusers:
                raise DRFValidationError(
                    {'detail': 'Cannot delete the last active superuser — the system would have no admin.'}
                )
        instance.delete()

    @action(detail=True, methods=['post'], url_path='reset-mfa')
    def reset_mfa(self, request, pk=None):
        """Clear every second factor on an account — the lost-phone escape hatch.

        Without this there is NO way back in for a user who loses their
        authenticator after spending their backup codes: regenerating codes
        needs a valid TOTP code, disabling TOTP needs a live session, and
        neither is reachable when you can't complete the second step. The
        only remaining options were adding the account to
        MFA_EXEMPT_USERNAMES (an env var meant for machine accounts, and a
        redeploy) or deleting rows by hand in a shell.

        Deliberately removes TOTP, every registered biometric device AND
        the backup codes together. Leaving any one behind would leave the
        user still unable to sign in, which is the whole problem.

        The account keeps its role, so if that role sets mfa_required the
        user is walked through fresh enrolment on their next login rather
        than being left without a second factor — see must_setup_mfa in
        core.jwt_auth.

        Admin-only by virtue of the viewset's IsAdminOrOfficeManager, and
        audit-logged: clearing someone's second factor is exactly the action
        that should never be quietly possible.
        """
        from mfa.models import MFABackupCode, TOTPDevice, WebAuthnCredential

        user = self.get_object()
        totp = TOTPDevice.objects.filter(user=user).delete()[0]
        keys = WebAuthnCredential.objects.filter(user=user).delete()[0]
        codes = MFABackupCode.objects.filter(user=user).delete()[0]

        # A user locked out of the password step as well (fumbling it while
        # fighting the 2FA prompt) should not then hit a 5-minute wait on
        # the way back in — same reasoning as the password reset above.
        from core.jwt_auth import clear_login_lock_for
        clear_login_lock_for(user.username, user.email)

        AuditLog.objects.create(
            user=user,
            action='MFA_RESET',
            module_name='User',
            details=(f'Two-factor reset by {getattr(request.user, "username", "system")} '
                     f'(totp={totp}, devices={keys}, backup_codes={codes})'),
            ip_address=request.META.get('REMOTE_ADDR'),
        )
        return Response({
            'message': 'Two-factor login reset. The user can sign in with their password alone.',
            'totp_removed': totp,
            'devices_removed': keys,
            'backup_codes_removed': codes,
        })

    @action(detail=True, methods=['post'], url_path='assign-role')
    def assign_role(self, request, pk=None):
        """Assign or change a user's ERP role.

        Expects: { "role_id": 1 }
        """
        user = self.get_object()
        role_id = request.data.get('role_id')
        if not role_id:
            return Response(
                {'detail': 'role_id is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            role = ERPRole.objects.get(pk=role_id)
        except ERPRole.DoesNotExist:
            return Response(
                {'detail': 'Role not found.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        assignment, created = UserRoleAssignment.objects.update_or_create(
            user=user,
            defaults={
                'role': role,
                'assigned_by': request.user,
            },
        )

        return Response(
            UserWithRoleSerializer(user).data,
            status=status.HTTP_200_OK,
        )

    @action(detail=True, methods=['post'], url_path='assign-permissions')
    def assign_permissions(self, request, pk=None):
        """Assign module permissions to a user (LEGACY - kept for backward compat).

        Expects: { "permissions": [ { "module": <id>, "can_view": true, ... }, ... ] }
        """
        user = self.get_object()
        perms_data = request.data.get('permissions', [])

        results = []
        for perm in perms_data:
            module_id = perm.get('module')
            if not module_id:
                continue
            obj, _ = ERPPermission.objects.update_or_create(
                user=user,
                module_id=module_id,
                defaults={
                    'can_view': perm.get('can_view', False),
                    'can_create': perm.get('can_create', False),
                    'can_edit': perm.get('can_edit', False),
                    'can_delete': perm.get('can_delete', False),
                    'granted_by': request.user,
                },
            )
            results.append(ERPPermissionSerializer(obj).data)

        return Response(results, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Standalone view - current user's permissions (for sidebar rendering)
# ---------------------------------------------------------------------------

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def user_permissions_view(request):
    """Return the current user's role and module permissions.

    Response format:
    {
        "is_superuser": true/false,
        "is_admin": true/false,
        "role": {"id": 1, "name": "IT Admin"} or null,
        "permissions": [
            {"module_name": "Company", "module_slug": "company",
             "can_view": true, "can_create": true, "can_edit": true, "can_delete": true},
            ...
        ]
    }
    """
    user = request.user

    # Determine role
    role_data = None
    try:
        assignment = UserRoleAssignment.objects.select_related('role').get(user=user)
        role_data = {'id': assignment.role.id, 'name': assignment.role.name}
    except UserRoleAssignment.DoesNotExist:
        pass

    # Build permissions list
    if user.is_superuser:
        modules = ERPModule.objects.filter(is_active=True)
        perms = [
            {
                'module_name': m.name,
                'module_slug': m.slug,
                'can_view': True, 'can_create': True, 'can_edit': True, 'can_delete': True,
                'can_approve': True, 'can_reject': True, 'can_send_email': True,
                'can_submit': True, 'can_proceed_approval': True,
                'can_export': True, 'can_print': True, 'can_import': True,
                'can_confirm': True, 'can_close': True, 'can_cancel': True,
                'can_issue': True, 'can_convert': True,
                'can_acknowledge': True, 'can_create_dc': True, 'can_create_so': True,
                'can_view_inbox': True, 'can_create_freight': True,
                'can_create_bom': True, 'can_quote_response': True,
                'can_evaluate': True,
                'can_create_bill': True, 'can_create_wage': True,
                'can_record_payment': True, 'can_apply_debit': True,
                'can_apply_credit': True, 'can_apply_advance': True,
                'can_apply_to_bill': True,
                'can_skip_rfq': True,
                'can_direct_receipt': True,
                'can_return_customer': True, 'can_return_sales': True,
                'can_return_damage': True, 'can_return_qc': True,
                'can_push_tally': True,
                'can_request_amendment': True, 'can_approve_amendment': True,
            }
            for m in modules
        ]
    elif role_data:
        role_perms = RolePermission.objects.filter(
            role_id=role_data['id'],
            can_view=True,
        ).select_related('module').filter(module__is_active=True)
        perms = [
            {
                'module_name': rp.module.name,
                'module_slug': rp.module.slug,
                'can_view': rp.can_view, 'can_create': rp.can_create,
                'can_edit': rp.can_edit, 'can_delete': rp.can_delete,
                'can_approve': rp.can_approve, 'can_reject': rp.can_reject,
                'can_submit': rp.can_submit,
                'can_proceed_approval': rp.can_proceed_approval,
                'can_send_email': rp.can_send_email, 'can_export': rp.can_export,
                'can_print': rp.can_print, 'can_import': rp.can_import,
                'can_confirm': rp.can_confirm, 'can_close': rp.can_close,
                'can_cancel': rp.can_cancel, 'can_issue': rp.can_issue,
                'can_convert': rp.can_convert,
                'can_acknowledge': rp.can_acknowledge,
                'can_create_dc': rp.can_create_dc,
                'can_create_so': rp.can_create_so,
                'can_view_inbox': rp.can_view_inbox,
                'can_create_freight': rp.can_create_freight,
                'can_create_bom': rp.can_create_bom,
                'can_quote_response': rp.can_quote_response,
                'can_evaluate': rp.can_evaluate,
                'can_create_bill': rp.can_create_bill,
                'can_create_wage': rp.can_create_wage,
                'can_record_payment': rp.can_record_payment,
                'can_apply_debit': rp.can_apply_debit,
                'can_apply_credit': rp.can_apply_credit,
                'can_apply_advance': rp.can_apply_advance,
                'can_apply_to_bill': rp.can_apply_to_bill,
                'can_skip_rfq': rp.can_skip_rfq,
                'can_direct_receipt': rp.can_direct_receipt,
                'can_return_customer': rp.can_return_customer,
                'can_return_sales': rp.can_return_sales,
                'can_return_damage': rp.can_return_damage,
                'can_return_qc': rp.can_return_qc,
                'can_push_tally': rp.can_push_tally,
                'can_request_amendment': rp.can_request_amendment,
                'can_approve_amendment': rp.can_approve_amendment,
            }
            for rp in role_perms
        ]
    else:
        perms = []

    # Fold in per-user overrides so the sidebar/menu matches real access
    # (parity with HasModulePermission, which already applies them at the API
    # layer). A GRANT reveals a module/action for THIS user even if the role
    # lacks it — this is how "show a page to one user in a role" works; a DENY
    # hides it. DENY wins over a co-existing GRANT. Superusers are unaffected.
    if not user.is_superuser:
        from rbac.models import UserPermissionOverride
        ov = list(UserPermissionOverride.objects
                  .filter(user=user).values('module_name', 'action', 'mode'))
        if ov:
            by_name = {p['module_name']: p for p in perms}
            resolved = {}
            for o in ov:
                k = (o['module_name'], o['action'])
                if resolved.get(k) == 'DENY':
                    continue                      # an explicit DENY sticks
                resolved[k] = o['mode']
            need = {m for (m, a), mode in resolved.items()
                    if mode == 'GRANT' and m not in by_name}
            slug_of = dict(ERPModule.objects
                           .filter(name__in=need, is_active=True)
                           .values_list('name', 'slug'))
            for (mname, action), mode in resolved.items():
                row = by_name.get(mname)
                if row is None:
                    if mode != 'GRANT' or mname not in slug_of:
                        continue                  # DENY on a non-granted module: nothing to hide
                    row = {'module_name': mname, 'module_slug': slug_of[mname]}
                    by_name[mname] = row
                    perms.append(row)
                row[action] = (mode == 'GRANT')

    # Staff profile data — used by the Purchase Request form (and any
    # other create form that wants to pre-fill company/warehouse for
    # a role like Warehouse Coordinator without making the operator
    # pick them every time).
    #
    # Resolution order, most-authoritative first:
    #   1. StakeholderUser.employee_record (the canonical HR link) →
    #      gives company + primary_location set by HR when the staff
    #      record was created.
    #   2. Direct HR Staff lookup by username / full name — covers the
    #      common case where admin created the HR Staff record AND the
    #      login user, but forgot to wire StakeholderUser.employee_record.
    #      Locally this was always set up; production frequently isn't.
    #   3. StakeholderUser.default_warehouse → admins often set this
    #      directly when granting warehouse access, without ever
    #      creating an HR Staff record.
    #   4. First entry of StakeholderUser.warehouse_scope.
    #
    # Any unresolved slot stays null; the frontend leaves the dropdown
    # empty and the user picks manually.
    staff_data = None

    def _serialize_staff(staff, source):
        return {
            'staff_id': staff.staff_id,
            'first_name': staff.first_name,
            'last_name': staff.last_name,
            'company': str(staff.company_id) if staff.company_id else None,
            'company_name': staff.company.legal_name if staff.company else None,
            'primary_location': str(staff.primary_location_id) if staff.primary_location_id else None,
            'location_name': staff.primary_location.name if staff.primary_location else None,
            # Optional default godown — used by the PR / Receipt forms
            # to pre-fill the Godown picker. May be None when the admin
            # didn't set one (the form just stays unselected then).
            'default_godown': str(staff.default_godown_id) if staff.default_godown_id else None,
            'default_godown_name': staff.default_godown.godown_name if staff.default_godown else None,
            'department': staff.department or '',
            'designation': staff.designation or '',
            'source': source,
        }

    try:
        from core.models import StakeholderUser
        from hr.models import Staff

        stakeholder = None
        try:
            stakeholder = StakeholderUser.objects.select_related(
                'employee_record__company',
                'employee_record__primary_location',
                'employee_record__default_godown',
                'default_warehouse__company',
            ).prefetch_related('warehouse_scope__company').get(user=user)
        except StakeholderUser.DoesNotExist:
            stakeholder = None

        # Path 1 — canonical HR link via StakeholderUser.employee_record
        if stakeholder and stakeholder.employee_record:
            staff_data = _serialize_staff(stakeholder.employee_record, 'hr_staff')

        # Path 2 — direct HR Staff lookup by identity match. This is
        # the production-resilience path: if the admin created a Staff
        # row that obviously belongs to this user (same staff_id as
        # username, OR same full name) but never linked it via
        # StakeholderUser.employee_record, we still find it.
        if not staff_data:
            full_name = f"{user.first_name} {user.last_name}".strip()
            candidate_qs = Staff.objects.select_related('company', 'primary_location', 'default_godown').filter(
                is_active=True, employment_status='ACTIVE',
            )
            staff_match = None
            # By staff_id == username (most common — staff_id usually
            # mirrors the login username in this deployment).
            if user.username:
                staff_match = candidate_qs.filter(staff_id__iexact=user.username).first()
            # By full name fallback. Skip when names are blank to avoid
            # mass-matching the empty-name corner case.
            if staff_match is None and full_name and user.first_name and user.last_name:
                staff_match = candidate_qs.filter(
                    first_name__iexact=user.first_name,
                    last_name__iexact=user.last_name,
                ).first()
            if staff_match is not None:
                staff_data = _serialize_staff(staff_match, 'hr_staff_by_identity')

        # Path 3 — StakeholderUser.default_warehouse
        if not staff_data and stakeholder and stakeholder.default_warehouse_id:
            wh = stakeholder.default_warehouse
            staff_data = {
                'staff_id': '',
                'first_name': user.first_name or user.username,
                'last_name': user.last_name or '',
                'company': str(wh.company_id) if wh.company_id else None,
                'company_name': wh.company.legal_name if wh.company else None,
                'primary_location': str(wh.id),
                'location_name': wh.name,
                'department': '',
                'designation': '',
                'source': 'stakeholder_default_warehouse',
            }

        # Path 4 — first scoped warehouse
        if not staff_data and stakeholder:
            scoped = stakeholder.warehouse_scope.first()
            if scoped is not None:
                staff_data = {
                    'staff_id': '',
                    'first_name': user.first_name or user.username,
                    'last_name': user.last_name or '',
                    'company': str(scoped.company_id) if scoped.company_id else None,
                    'company_name': scoped.company.legal_name if scoped.company else None,
                    'primary_location': str(scoped.id),
                    'location_name': scoped.name,
                    'department': '',
                    'designation': '',
                    'source': 'stakeholder_warehouse_scope',
                }
    except Exception:
        pass

    return Response({
        'is_superuser': user.is_superuser,
        'is_admin': user.is_superuser or _is_office_manager_or_admin(user),
        'role': role_data,
        'staff': staff_data,
        'permissions': perms,
    })


# ─── Field-level permissions (Phase 3) ────────────────────────────────
# Read / write RoleFieldPermission rows + expose the catalog of
# manageable sales fields so the admin UI knows what to render. The
# enforcement happens in `apps.sales.field_permissions.FieldPermissionMixin`,
# not here.

from rbac.models import RoleFieldPermission
from rest_framework import serializers as drf_serializers


class RoleFieldPermissionSerializer(drf_serializers.ModelSerializer):
    class Meta:
        model = RoleFieldPermission
        fields = ['id', 'role', 'module_name', 'field_name', 'access']


class RoleFieldPermissionViewSet(viewsets.ModelViewSet):
    """Admin-only CRUD over field-level permission overrides.

    The standard list / create / patch / delete is enough — the Sales
    permissions admin page does a fetch on tab open and a bulk save on
    submit. A dedicated bulk endpoint is included below to avoid 10
    round-trips when toggling several fields at once.
    """
    queryset = RoleFieldPermission.objects.all().order_by('module_name', 'field_name')
    serializer_class = RoleFieldPermissionSerializer
    permission_classes = [IsAuthenticated, IsAdminOrOfficeManager]
    filterset_fields = ['role', 'module_name']

    @action(detail=False, methods=['post'], url_path='bulk')
    def bulk(self, request):
        """Replace the field-permission rows for one (role, module) atomically.

        Payload:
            {
                "role_id": 1,
                "module_name": "Sales Order",
                "permissions": [
                    {"field_name": "approval_status", "access": "READ_ONLY"},
                    {"field_name": "payment_terms",   "access": "HIDDEN"}
                ]
            }

        Rows with access='VIEW' are deleted (VIEW is the absence of an
        override, no need to store it). Anything not in the payload is
        also deleted — the request is the new ground truth for that
        (role, module) pair.
        """
        role_id = request.data.get('role_id')
        module_name = request.data.get('module_name')
        items = request.data.get('permissions') or []
        if not role_id or not module_name:
            return Response(
                {'detail': 'role_id and module_name are required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            role = ERPRole.objects.get(pk=role_id)
        except ERPRole.DoesNotExist:
            return Response(
                {'detail': 'Role not found.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        from django.db import transaction as db_transaction
        with db_transaction.atomic():
            RoleFieldPermission.objects.filter(
                role=role, module_name=module_name,
            ).delete()
            to_create = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                fname = item.get('field_name')
                access = item.get('access') or 'VIEW'
                if not fname or access == 'VIEW':
                    continue
                if access not in {'VIEW', 'READ_ONLY', 'HIDDEN'}:
                    continue
                to_create.append(RoleFieldPermission(
                    role=role,
                    module_name=module_name,
                    field_name=fname,
                    access=access,
                ))
            if to_create:
                RoleFieldPermission.objects.bulk_create(to_create)

        # Return the new state so the frontend can refresh without a
        # separate GET.
        fresh = RoleFieldPermission.objects.filter(
            role=role, module_name=module_name,
        )
        return Response(RoleFieldPermissionSerializer(fresh, many=True).data)


# ─── User-level overrides (Phase 4) ───────────────────────────────────


class UserPermissionOverrideSerializer(drf_serializers.ModelSerializer):
    class Meta:
        from rbac.models import UserPermissionOverride as _M
        model = _M
        fields = ['id', 'user', 'module_name', 'action', 'mode', 'granted_by', 'notes']
        read_only_fields = ['granted_by']


class UserPermissionOverrideViewSet(viewsets.ModelViewSet):
    """CRUD over per-user module-action overrides.

    The bulk endpoint replaces every override for one (user,
    module_name) atomically — same semantics as the role-perm and
    field-perm bulk endpoints, so the admin UI saves cleanly with
    one round-trip per module section.
    """
    from rbac.models import UserPermissionOverride as _M
    queryset = _M.objects.all().order_by('user_id', 'module_name', 'action')
    serializer_class = UserPermissionOverrideSerializer
    permission_classes = [IsAuthenticated, IsAdminOrOfficeManager]
    filterset_fields = ['user', 'module_name']

    def perform_create(self, serializer):
        serializer.save(granted_by=self.request.user)

    @action(detail=False, methods=['post'], url_path='bulk')
    def bulk(self, request):
        from rbac.models import UserPermissionOverride
        user_id = request.data.get('user_id')
        module_name = request.data.get('module_name')
        items = request.data.get('overrides') or []
        if not user_id or not module_name:
            return Response(
                {'detail': 'user_id and module_name are required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            target_user = User.objects.get(pk=user_id)
        except User.DoesNotExist:
            return Response({'detail': 'User not found.'}, status=status.HTTP_404_NOT_FOUND)

        from django.db import transaction as db_transaction
        with db_transaction.atomic():
            UserPermissionOverride.objects.filter(
                user=target_user, module_name=module_name,
            ).delete()
            to_create = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                action_name = item.get('action')
                mode = item.get('mode')
                if not action_name or mode not in ('GRANT', 'DENY'):
                    continue
                to_create.append(UserPermissionOverride(
                    user=target_user,
                    module_name=module_name,
                    action=action_name,
                    mode=mode,
                    granted_by=request.user,
                    notes=item.get('notes', ''),
                ))
            if to_create:
                UserPermissionOverride.objects.bulk_create(to_create)

        fresh = UserPermissionOverride.objects.filter(
            user=target_user, module_name=module_name,
        )
        return Response(UserPermissionOverrideSerializer(fresh, many=True).data)


class UserFieldPermissionOverrideSerializer(drf_serializers.ModelSerializer):
    class Meta:
        from rbac.models import UserFieldPermissionOverride as _M
        model = _M
        fields = ['id', 'user', 'module_name', 'field_name', 'access']


class UserFieldPermissionOverrideViewSet(viewsets.ModelViewSet):
    """CRUD + bulk for per-user field-permission overrides."""
    from rbac.models import UserFieldPermissionOverride as _M
    queryset = _M.objects.all().order_by('user_id', 'module_name', 'field_name')
    serializer_class = UserFieldPermissionOverrideSerializer
    permission_classes = [IsAuthenticated, IsAdminOrOfficeManager]
    filterset_fields = ['user', 'module_name']

    @action(detail=False, methods=['post'], url_path='bulk')
    def bulk(self, request):
        from rbac.models import UserFieldPermissionOverride
        user_id = request.data.get('user_id')
        module_name = request.data.get('module_name')
        items = request.data.get('overrides') or []
        if not user_id or not module_name:
            return Response(
                {'detail': 'user_id and module_name are required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            target_user = User.objects.get(pk=user_id)
        except User.DoesNotExist:
            return Response({'detail': 'User not found.'}, status=status.HTTP_404_NOT_FOUND)

        from django.db import transaction as db_transaction
        with db_transaction.atomic():
            UserFieldPermissionOverride.objects.filter(
                user=target_user, module_name=module_name,
            ).delete()
            to_create = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                fname = item.get('field_name')
                access = item.get('access')
                if not fname or access not in ('VIEW', 'READ_ONLY', 'HIDDEN'):
                    continue
                # 'VIEW' is the absence of an override — skip storing it.
                if access == 'VIEW':
                    continue
                to_create.append(UserFieldPermissionOverride(
                    user=target_user,
                    module_name=module_name,
                    field_name=fname,
                    access=access,
                ))
            if to_create:
                UserFieldPermissionOverride.objects.bulk_create(to_create)

        fresh = UserFieldPermissionOverride.objects.filter(
            user=target_user, module_name=module_name,
        )
        return Response(UserFieldPermissionOverrideSerializer(fresh, many=True).data)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def my_field_permissions(request):
    """Return the requesting user's effective field-level access for one
    module, or for all modules if ?module= is omitted.

    Response shape (single-module form):
        { "module": "Sales Order", "fields": { "payment_due_date": "HIDDEN", "discount": "READ_ONLY" } }

    Response shape (all-modules form):
        { "modules": { "Sales Order": { "payment_due_date": "HIDDEN" }, ... } }

    Used by the frontend on create/edit forms — the API GET endpoints
    already strip HIDDEN fields, but POST/PATCH forms have no response
    to detect missing keys from, so they need this preflight to know
    which inputs to skip and which to render disabled. Superusers and
    legacy users without a role see an empty map (fail-open, same as
    the backend FieldPermissionMixin).
    """
    from sales.field_permissions import _get_field_perms_for_user, MANAGEABLE_SALES_FIELDS
    requested_module = request.query_params.get('module')

    if requested_module:
        perms = _get_field_perms_for_user(request, requested_module)
        return Response({'module': requested_module, 'fields': perms})

    # No module filter — return everything the catalog declares.
    out = {}
    for module_name in MANAGEABLE_SALES_FIELDS.keys():
        out[module_name] = _get_field_perms_for_user(request, module_name)
    return Response({'modules': out})


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def manageable_sales_fields(request):
    """Return the catalog of fields the Sales Permissions admin page
    can manage. Static data — driven by the
    `apps.sales.field_permissions.MANAGEABLE_SALES_FIELDS` dict.

    Lives in rbac/views.py rather than the catalog file to keep the
    HTTP layer in one place.
    """
    from sales.field_permissions import MANAGEABLE_SALES_FIELDS
    return Response({
        'modules': [
            {'name': module_name, 'fields': fields}
            for module_name, fields in MANAGEABLE_SALES_FIELDS.items()
        ],
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def manageable_purchase_fields(request):
    """Return the catalog of fields the Purchase Permissions admin page
    can manage. Mirrors `manageable_sales_fields` — driven by the
    `apps.purchase.field_permissions.MANAGEABLE_PURCHASE_FIELDS` dict.
    Same shape so the frontend Field Permissions tab is a near-identical
    copy of the Sales one (just a different fetch URL).
    """
    from purchase.field_permissions import MANAGEABLE_PURCHASE_FIELDS
    return Response({
        'modules': [
            {'name': module_name, 'fields': fields}
            for module_name, fields in MANAGEABLE_PURCHASE_FIELDS.items()
        ],
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def manageable_freight_fields(request):
    """Return the catalog of fields the Freight Permissions admin page
    can manage. Same shape and same response envelope as
    `manageable_sales_fields` / `manageable_purchase_fields` — driven
    by `apps.purchase.freight_field_permissions.MANAGEABLE_FREIGHT_FIELDS`.

    The four freight modules (Freight Advice, Freight Payment, Wage
    Entry, Wage Payment) live in the purchase Django app, so the
    catalog file ships from there — but the admin page surfacing
    these belongs to the Freight category, hence the separate endpoint.
    Outward Freight is intentionally NOT included; it's managed on the
    Sales Permissions page.
    """
    from purchase.freight_field_permissions import MANAGEABLE_FREIGHT_FIELDS
    return Response({
        'modules': [
            {'name': module_name, 'fields': fields}
            for module_name, fields in MANAGEABLE_FREIGHT_FIELDS.items()
        ],
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def manageable_production_fields(request):
    """Return the catalog of fields the Production Permissions admin page
    can manage. Same shape and envelope as the sales/purchase/freight
    endpoints — driven by
    `apps.production.field_permissions.MANAGEABLE_PRODUCTION_FIELDS`.
    """
    from production.field_permissions import MANAGEABLE_PRODUCTION_FIELDS
    return Response({
        'modules': [
            {'name': module_name, 'fields': fields}
            for module_name, fields in MANAGEABLE_PRODUCTION_FIELDS.items()
        ],
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def manageable_inventory_fields(request):
    """Return the catalog of fields the Inventory Permissions admin page
    can manage. Same shape and envelope as the other module endpoints —
    driven by `apps.inventory.field_permissions.MANAGEABLE_INVENTORY_FIELDS`.
    """
    from inventory.field_permissions import MANAGEABLE_INVENTORY_FIELDS
    return Response({
        'modules': [
            {'name': module_name, 'fields': fields}
            for module_name, fields in MANAGEABLE_INVENTORY_FIELDS.items()
        ],
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def manageable_hr_fields(request):
    """Return the catalog of fields the HR Permissions admin page can
    manage. Same shape and envelope as the other module endpoints —
    driven by `apps.hr.field_permissions.MANAGEABLE_HR_FIELDS`. Covers the
    sensitive HR fields (salary, bank, ID proofs, biometric/geo, payroll
    figures) that roles may need hidden or made read-only.
    """
    from hr.field_permissions import MANAGEABLE_HR_FIELDS
    return Response({
        'modules': [
            {'name': module_name, 'fields': fields}
            for module_name, fields in MANAGEABLE_HR_FIELDS.items()
        ],
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def manageable_import_fields(request):
    """Catalog for the Import Data permissions page's User Overrides tab.

    The six Import pages (Overview, Scan Inbox, Payments Made, Mappings,
    Sales/Purchase Tally Import) have no field-level permissions, so each
    module carries an empty field list — the tab needs the catalog only to
    offer per-user module-action GRANT/DENY overrides (e.g. grant Import Data
    to one user in a role without granting the whole role).
    """
    IMPORT_MODULES = [
        'Import Overview', 'Import Scan Inbox', 'Import Payments Made',
        'Import Mappings', 'Sales Tally Import', 'Purchase Tally Import',
    ]
    return Response({'modules': [{'name': n, 'fields': []} for n in IMPORT_MODULES]})

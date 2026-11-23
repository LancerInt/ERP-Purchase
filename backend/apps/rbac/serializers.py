from django.contrib.auth import get_user_model
from rest_framework import serializers

from common.serializer_cache import ctx_store, page_pks

from rbac.models import (
    ERPRole,
    ERPModule,
    ERPPermission,
    RolePermission,
    UserRoleAssignment,
    AuditLog,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Existing serializers (kept as-is)
# ---------------------------------------------------------------------------

class ERPRoleSerializer(serializers.ModelSerializer):
    # How many users are assigned to this role — the Roles list renders it
    # as the "Users" column (was always 0 because the API never sent it).
    user_count = serializers.SerializerMethodField()

    # How many of this role's users skip 2FA via MFA_EXEMPT_USERNAMES. A role
    # that says "Required" while some of its holders are exempt is the exact
    # mismatch this number exists to make visible.
    mfa_exempt_count = serializers.SerializerMethodField()

    class Meta:
        model = ERPRole
        fields = ['id', 'name', 'description', 'is_active', 'mfa_required', 'created_at',
                  'user_count', 'mfa_exempt_count']
        read_only_fields = ['id', 'created_at']

    def get_mfa_exempt_count(self, obj):
        from core.jwt_auth import _mfa_exempt_usernames
        exempt = _mfa_exempt_usernames()
        if not exempt:
            return 0
        # Usernames are compared lower-cased, matching the login check.
        return sum(
            1 for u in UserRoleAssignment.objects
            .filter(role=obj).select_related('user')
            .values_list('user__username', flat=True)
            if (u or '').lower() in exempt
        )

    def get_user_count(self, obj):
        # Prefer an annotation set by the viewset (avoids an N+1 across the
        # roles list); fall back to a direct count if it isn't present.
        annotated = getattr(obj, 'user_count', None)
        if isinstance(annotated, int):
            return annotated
        return UserRoleAssignment.objects.filter(role=obj).count()


class ERPModuleSerializer(serializers.ModelSerializer):
    class Meta:
        model = ERPModule
        fields = ['id', 'name', 'slug', 'description', 'icon', 'category', 'order', 'is_active']
        read_only_fields = ['id']


class AuditLogSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source='user.username', read_only=True, default=None)
    # Prefer full name in the UI (falls back to username via CharField
    # default when the user has no first/last set).
    user_display = serializers.SerializerMethodField()

    class Meta:
        model = AuditLog
        fields = [
            'id', 'user', 'username', 'user_display', 'role_name',
            'module_name', 'action', 'details',
            'record_id', 'record_repr',
            'ip_address', 'timestamp',
        ]
        read_only_fields = fields

    def get_user_display(self, obj):
        u = obj.user
        if not u:
            return 'System'
        full = (getattr(u, 'get_full_name', lambda: '')() or '').strip()
        return full or u.username


# ---------------------------------------------------------------------------
# Legacy serializers (kept for backward compatibility)
# ---------------------------------------------------------------------------

class ERPPermissionSerializer(serializers.ModelSerializer):
    """Read serializer with nested module info (LEGACY - user-based)."""

    module = ERPModuleSerializer(read_only=True)
    username = serializers.CharField(source='user.username', read_only=True)
    granted_by_username = serializers.CharField(
        source='granted_by.username', read_only=True, default=None
    )

    class Meta:
        model = ERPPermission
        fields = [
            'id', 'user', 'username', 'module',
            'can_view', 'can_create', 'can_edit', 'can_delete',
            'granted_by', 'granted_by_username', 'granted_at',
        ]
        read_only_fields = ['id', 'granted_at']


class ERPPermissionWriteSerializer(serializers.ModelSerializer):
    """Write serializer for creating/updating permissions (LEGACY - user-based)."""

    class Meta:
        model = ERPPermission
        fields = [
            'id', 'user', 'module',
            'can_view', 'can_create', 'can_edit', 'can_delete',
        ]
        read_only_fields = ['id']

    def create(self, validated_data):
        request = self.context.get('request')
        if request and request.user:
            validated_data['granted_by'] = request.user
        return super().create(validated_data)

    def update(self, instance, validated_data):
        request = self.context.get('request')
        if request and request.user:
            validated_data['granted_by'] = request.user
        return super().update(instance, validated_data)


# ---------------------------------------------------------------------------
# NEW: Role-based permission serializers
# ---------------------------------------------------------------------------

class RolePermissionSerializer(serializers.ModelSerializer):
    """Read serializer for role-based permissions with nested names."""

    role_name = serializers.CharField(source='role.name', read_only=True)
    module_name = serializers.CharField(source='module.name', read_only=True)
    module_slug = serializers.CharField(source='module.slug', read_only=True)

    class Meta:
        model = RolePermission
        fields = [
            'id', 'role', 'role_name', 'module', 'module_name', 'module_slug',
            'can_view', 'can_create', 'can_edit', 'can_delete',
            'can_approve', 'can_reject', 'can_submit', 'can_proceed_approval',
            'can_send_email', 'can_export', 'can_print',
            'can_import',
            'can_confirm', 'can_close', 'can_cancel', 'can_issue', 'can_convert',
            'can_acknowledge', 'can_create_dc', 'can_create_so', 'can_view_inbox',
            'can_create_freight', 'can_create_bom', 'can_quote_response',
            'can_evaluate', 'can_create_bill', 'can_create_wage',
            'can_record_payment', 'can_apply_debit', 'can_apply_credit', 'can_apply_advance',
            'can_apply_to_bill',
            'can_skip_rfq',
            'can_direct_receipt',
            'can_return_customer', 'can_return_sales', 'can_return_damage', 'can_return_qc',
            'can_request_amendment', 'can_approve_amendment',
            'req_scope_goods', 'req_scope_services', 'req_scope_machinery',
            'can_push_tally',
        ]
        read_only_fields = ['id']


class RolePermissionWriteSerializer(serializers.ModelSerializer):
    """Write serializer for creating/updating role-based permissions."""

    class Meta:
        model = RolePermission
        fields = [
            'id', 'role', 'module',
            'can_view', 'can_create', 'can_edit', 'can_delete',
            'can_approve', 'can_reject', 'can_submit', 'can_proceed_approval',
            'can_send_email', 'can_export', 'can_print',
            'can_import',
            'can_confirm', 'can_close', 'can_cancel', 'can_issue', 'can_convert',
            'can_acknowledge', 'can_create_dc', 'can_create_so', 'can_view_inbox',
            'can_create_freight', 'can_create_bom', 'can_quote_response',
            'can_evaluate', 'can_create_bill', 'can_create_wage',
            'can_record_payment', 'can_apply_debit', 'can_apply_credit', 'can_apply_advance',
            'can_apply_to_bill',
            'can_skip_rfq',
            'can_direct_receipt',
            'can_return_customer', 'can_return_sales', 'can_return_damage', 'can_return_qc',
            'can_request_amendment', 'can_approve_amendment',
            'req_scope_goods', 'req_scope_services', 'req_scope_machinery',
            'can_push_tally',
        ]
        read_only_fields = ['id']


class UserRoleAssignmentSerializer(serializers.ModelSerializer):
    """Serializer for user-to-role assignments."""

    username = serializers.CharField(source='user.username', read_only=True)
    role_name = serializers.CharField(source='role.name', read_only=True)
    assigned_by_username = serializers.CharField(
        source='assigned_by.username', read_only=True, default=None
    )

    class Meta:
        model = UserRoleAssignment
        fields = [
            'id', 'user', 'username', 'role', 'role_name',
            'assigned_by', 'assigned_by_username', 'assigned_at',
        ]
        read_only_fields = ['id', 'assigned_at']


# ---------------------------------------------------------------------------
# NEW: User serializer with role info
# ---------------------------------------------------------------------------

class UserWithRoleSerializer(serializers.ModelSerializer):
    """Returns user info together with their ERP role and permissions."""

    def get_fields(self):
        """Drop `permissions` from LIST responses.

        Every row carried the user's full per-module permission matrix —
        ~23 KB each, so the admin Users page at its default page size of
        100 shipped ~2.3 MB, and the Permissions tabs ask for
        ?page_size=500, i.e. roughly 11 MB in one response. Against a slow
        instance that is a real chance of blowing the frontend's 30s axios
        timeout, which surfaces as "We couldn't load this list."

        Nothing reading a LIST ever used the field: the Users page, the
        user edit page, the six Permissions tabs and the role detail page
        all ignore it. Only users/[id] (the detail route) renders it, and
        that still gets it, because `action` is 'retrieve' there.

        Dropped in get_fields rather than popped in to_representation so
        the SerializerMethodField never runs — this saves the per-row work
        as well as the bytes.
        """
        fields = super().get_fields()
        view = self.context.get('view')
        if getattr(view, 'action', None) == 'list':
            fields.pop('permissions', None)
        return fields

    role = serializers.SerializerMethodField()
    staff_name = serializers.SerializerMethodField()
    permissions = serializers.SerializerMethodField()
    # Most-recent PASSWORD action from the audit log. Powers the
    # "Last changed" display on the admin edit page so it's clear
    # how stale a user's credentials are.
    password_last_changed = serializers.SerializerMethodField()
    # Whether MFA_EXEMPT_USERNAMES lets this account skip the 2FA challenge.
    # Surfaced because the exemption is an ENV VAR: without this the Roles
    # page can show "2FA Required" while a user under that role signs in
    # with a password alone, and nothing on screen explains the difference.
    mfa_exempt = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            'id', 'username', 'email', 'first_name', 'last_name',
            'is_active', 'is_staff', 'is_superuser',
            'role', 'staff_name', 'permissions', 'mfa_exempt',
            'password_last_changed', 'last_login', 'date_joined',
        ]
        read_only_fields = ['id', 'role', 'staff_name', 'permissions', 'mfa_exempt',
                            'password_last_changed', 'last_login', 'date_joined']

    def get_mfa_exempt(self, obj):
        from core.jwt_auth import _mfa_exempt_usernames
        return obj.get_username().lower() in _mfa_exempt_usernames()

    # ---- three page-wide maps -------------------------------------------
    # Each of the fields below used to ask the database about ONE user. Read on
    # the users list that is a query per row, and three of them together made
    # the admin Users page cost roughly four queries per person. The answers
    # are now worked out once for the whole page and read from a dict.
    #
    # page_pks returns None off a list route (a detail page, a create/update
    # response); every map below then falls back to the single-user query it
    # ran before, so the answer never changes - only the number of round trips.

    def _assignment_map(self):
        store = ctx_store(self, '_rbac_assignments')
        if 'm' not in store:
            ids = page_pks(self)
            store['m'] = None if ids is None else {
                a.user_id: a for a in UserRoleAssignment.objects
                .filter(user_id__in=ids).select_related('role')
            }
        return store['m']

    def _assignment(self, obj):
        m = self._assignment_map()
        if m is not None:
            return m.get(obj.pk)
        return (UserRoleAssignment.objects.select_related('role')
                .filter(user=obj).first())

    def get_password_last_changed(self, obj):
        from rbac.models import AuditLog
        store = ctx_store(self, '_rbac_pwd')
        if 'm' not in store:
            ids = page_pks(self)
            if ids is None:
                store['m'] = None
            else:
                # Newest first, so the first row seen per user is the latest.
                m = {}
                for uid, ts in (AuditLog.objects
                                .filter(user_id__in=ids, action='PASSWORD')
                                .order_by('-timestamp')
                                .values_list('user_id', 'timestamp')):
                    m.setdefault(uid, ts)
                store['m'] = m
        m = store['m']
        if m is not None:
            ts = m.get(obj.pk)
            return ts.isoformat() if ts else None
        log = (AuditLog.objects.filter(user=obj, action='PASSWORD')
               .order_by('-timestamp').first())
        return log.timestamp.isoformat() if log else None

    def get_role(self, obj):
        """Return the user's ERP role from UserRoleAssignment."""
        a = self._assignment(obj)
        return {'id': a.role.id, 'name': a.role.name} if a else None

    def get_staff_name(self, obj):
        """Return the user's display name."""
        full_name = obj.get_full_name()
        return full_name if full_name else obj.username

    def get_permissions(self, obj):
        if obj.is_superuser:
            modules = ERPModule.objects.filter(is_active=True)
            return [
                {
                    'module_name': m.name, 'module_slug': m.slug,
                    'can_view': True, 'can_create': True, 'can_edit': True, 'can_delete': True,
                    'can_approve': True, 'can_reject': True, 'can_send_email': True,
                    'can_export': True, 'can_print': True, 'can_import': True,
                    'can_confirm': True, 'can_close': True, 'can_cancel': True,
                    'can_issue': True, 'can_convert': True,
                    'can_acknowledge': True, 'can_create_dc': True, 'can_create_so': True,
                    'can_view_inbox': True, 'can_create_freight': True,
                }
                for m in modules
            ]

        assignment = self._assignment(obj)
        if assignment is None:
            return []

        # Permissions per ROLE, not per user: a page of 27 users usually spans
        # a handful of roles, so this reads each role's rows once instead of
        # once for every person holding it.
        store = ctx_store(self, '_rbac_roleperms')
        rid = assignment.role_id
        if rid not in store:
            store[rid] = list(RolePermission.objects.filter(role_id=rid)
                              .select_related('module'))
        role_perms = store[rid]
        return [
            {
                'module_name': rp.module.name, 'module_slug': rp.module.slug,
                'can_view': rp.can_view, 'can_create': rp.can_create,
                'can_edit': rp.can_edit, 'can_delete': rp.can_delete,
                'can_approve': rp.can_approve, 'can_reject': rp.can_reject,
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
            }
            for rp in role_perms
        ]


# ---------------------------------------------------------------------------
# Keep legacy serializer alias for backward compatibility
# ---------------------------------------------------------------------------
UserWithPermissionsSerializer = UserWithRoleSerializer

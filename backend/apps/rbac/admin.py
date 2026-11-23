from collections import OrderedDict

from django.contrib import admin, messages
from django.http import HttpResponseRedirect
from django.shortcuts import render
from django.urls import path, reverse

from rbac.models import (
    ERPRole, ERPModule, ERPPermission, RolePermission,
    UserRoleAssignment, AuditLog,
)


# 14 action flags managed by the matrix view — order matters: it determines
# the column order in the grid template.
PERMISSION_ACTIONS = (
    'can_view', 'can_create', 'can_edit', 'can_delete',
    'can_approve', 'can_reject', 'can_confirm', 'can_close', 'can_cancel',
    'can_issue', 'can_convert',
    'can_send_email', 'can_export', 'can_print',
)
# Short names exposed to the template (matches the form field suffix).
ACTION_SHORT_NAMES = (
    'view', 'create', 'edit', 'delete',
    'approve', 'reject', 'confirm', 'close', 'cancel',
    'issue', 'convert',
    'email', 'export', 'print',
)
ACTION_NAME_TO_FIELD = dict(zip(ACTION_SHORT_NAMES, PERMISSION_ACTIONS))


@admin.register(ERPRole)
class ERPRoleAdmin(admin.ModelAdmin):
    list_display = ('name', 'is_active', 'created_at')
    list_filter = ('is_active',)
    search_fields = ('name',)
    ordering = ('name',)


@admin.register(ERPModule)
class ERPModuleAdmin(admin.ModelAdmin):
    list_display = ('name', 'slug', 'category', 'order', 'is_active')
    list_filter = ('is_active', 'category')
    search_fields = ('name', 'slug')
    ordering = ('order', 'name')
    prepopulated_fields = {'slug': ('name',)}


@admin.register(ERPPermission)
class ERPPermissionAdmin(admin.ModelAdmin):
    list_display = (
        'user', 'module', 'can_view', 'can_create',
        'can_edit', 'can_delete', 'granted_by', 'granted_at',
    )
    list_filter = ('can_view', 'can_create', 'can_edit', 'can_delete', 'module')
    search_fields = ('user__username', 'module__name')
    raw_id_fields = ('user', 'granted_by')
    ordering = ('user__username', 'module__order')


@admin.register(RolePermission)
class RolePermissionAdmin(admin.ModelAdmin):
    """
    Replaces the default add/list pages with a frontend-style matrix view:
    a Role dropdown plus a grid of all modules with 14 permission checkboxes
    per row. Saves all permissions for the chosen role in one POST.
    """
    list_display = (
        'role', 'module', 'can_view', 'can_create',
        'can_edit', 'can_delete',
    )
    list_filter = ('role', 'module')
    search_fields = ('role__name', 'module__name')
    ordering = ('role__name', 'module__name')

    # ── URL routing ─────────────────────────────────────────────────────
    def get_urls(self):
        urls = super().get_urls()
        custom = [
            path(
                'matrix/',
                self.admin_site.admin_view(self.permission_matrix_view),
                name='rbac_rolepermission_matrix',
            ),
        ]
        return custom + urls

    def changelist_view(self, request, extra_context=None):
        # Send the default changelist users straight to the matrix.
        return HttpResponseRedirect(
            reverse('admin:rbac_rolepermission_matrix')
        )

    def add_view(self, request, form_url='', extra_context=None):
        # The matrix is also our "add" surface.
        return HttpResponseRedirect(
            reverse('admin:rbac_rolepermission_matrix')
        )

    # ── The matrix view itself ──────────────────────────────────────────
    def permission_matrix_view(self, request):
        roles = ERPRole.objects.filter(is_active=True).order_by('name')

        if request.method == 'POST':
            return self._save_matrix(request, roles)

        role_id = request.GET.get('role_id')
        selected_role = None
        if role_id:
            try:
                selected_role = ERPRole.objects.get(pk=role_id, is_active=True)
            except (ERPRole.DoesNotExist, ValueError):
                selected_role = None

        grouped_modules = []
        modules = []
        if selected_role:
            modules_qs = ERPModule.objects.filter(is_active=True).order_by('order', 'name')
            existing = {
                rp.module_id: rp
                for rp in RolePermission.objects.filter(role=selected_role)
            }
            # Build per-module dict keyed by short action name so the template
            # can do {{ m.current|dictlookup:action }} with the action loop var.
            modules = []
            for m in modules_qs:
                rp = existing.get(m.id)
                current = {}
                for short, field in ACTION_NAME_TO_FIELD.items():
                    current[short] = bool(getattr(rp, field, False)) if rp else False
                modules.append({
                    'id': m.id,
                    'name': m.name,
                    'category': m.category,
                    'category_label': m.get_category_display() if m.category else 'Other',
                    'current': current,
                })

            # Group by category, preserving the model's ordering.
            buckets = OrderedDict()
            for m in modules:
                key = m['category'] or 'OTHER'
                if key not in buckets:
                    buckets[key] = {'label': m['category_label'] or 'Other', 'modules': []}
                buckets[key]['modules'].append(m)
            grouped_modules = list(buckets.values())

        context = {
            **self.admin_site.each_context(request),
            'title': 'Role Permission Management',
            'roles': roles,
            'selected_role': selected_role,
            'modules': modules,
            'grouped_modules': grouped_modules,
            'actions': ACTION_SHORT_NAMES,
            'opts': self.model._meta,
            'has_view_permission': True,
        }
        return render(request, 'admin/rbac/rolepermission/matrix.html', context)

    def _save_matrix(self, request, roles):
        role_id = request.POST.get('role_id')
        if not role_id:
            messages.error(request, 'No role selected.')
            return HttpResponseRedirect(
                reverse('admin:rbac_rolepermission_matrix')
            )
        try:
            role = ERPRole.objects.get(pk=role_id, is_active=True)
        except (ERPRole.DoesNotExist, ValueError):
            messages.error(request, 'Selected role no longer exists.')
            return HttpResponseRedirect(
                reverse('admin:rbac_rolepermission_matrix')
            )

        modules = ERPModule.objects.filter(is_active=True)
        existing = {
            rp.module_id: rp
            for rp in RolePermission.objects.filter(role=role)
        }
        # Walk every (module, action) combination from POST and persist.
        for m in modules:
            rp = existing.get(m.id)
            updates = {}
            for short, field in ACTION_NAME_TO_FIELD.items():
                key = f'perm_{m.id}_{short}'
                updates[field] = key in request.POST
            if rp:
                changed = False
                for f, v in updates.items():
                    if getattr(rp, f) != v:
                        setattr(rp, f, v)
                        changed = True
                if changed:
                    rp.save(update_fields=list(updates.keys()))
            else:
                # Only create rows when at least one permission is granted —
                # avoids cluttering the table with empty placeholder rows.
                if any(updates.values()):
                    RolePermission.objects.create(role=role, module=m, **updates)

        messages.success(
            request,
            f'Saved permissions for "{role.name}".'
        )
        return HttpResponseRedirect(
            f"{reverse('admin:rbac_rolepermission_matrix')}?role_id={role.id}"
        )


@admin.register(UserRoleAssignment)
class UserRoleAssignmentAdmin(admin.ModelAdmin):
    list_display = ('user', 'role', 'assigned_by', 'assigned_at')
    list_filter = ('role',)
    search_fields = ('user__username', 'role__name')
    raw_id_fields = ('user', 'assigned_by')
    ordering = ('user__username',)


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ('user', 'action', 'module_name', 'role_name', 'ip_address', 'timestamp')
    list_filter = ('action', 'module_name')
    search_fields = ('user__username', 'module_name', 'details')
    readonly_fields = (
        'user', 'role_name', 'module_name', 'action',
        'details', 'ip_address', 'timestamp',
    )
    ordering = ('-timestamp',)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser

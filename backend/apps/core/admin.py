"""
Django admin configuration for core app.
"""
from django import forms
from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin
from django.contrib.auth.forms import UserCreationForm
from django.utils.html import format_html
from .models import (
    Company, Warehouse, Godown, RoleDefinition,
    ApprovalLevel, StakeholderUser
)


# ── Custom Add-User form: pick a Staff record to seed username/email/names ──
class StaffBackedUserCreationForm(UserCreationForm):
    """Add-User form that lets the admin pick an existing Staff record.

    When a Staff is chosen, the username pre-fills from staff_id and
    first_name/last_name/email/mobile are copied onto the User on save.
    A StakeholderUser linking the new User to the chosen Staff is also
    created so the user can log in with the role/warehouse scope.
    """

    staff_record = forms.ModelChoiceField(
        queryset=None,  # set in __init__ to avoid app-loading issues
        required=False,
        label='Staff (master data)',
        help_text='Optional. Pick an existing Staff record to auto-fill name, '
                  'email and mobile, and to link this login to that Staff.'
    )
    role = forms.ModelChoiceField(
        queryset=None,  # populated in __init__ from rbac.ERPRole
        required=True,
        empty_label='Select role...',
        label='Role',
        help_text='Pick the ERP role this user will have — same as the frontend Add User form.'
    )
    default_warehouse = forms.ModelChoiceField(
        queryset=Warehouse.objects.filter(active_flag=True).order_by('warehouse_code'),
        required=False,
        empty_label='Select warehouse...',
        label='Default warehouse',
        help_text='Optional. Sets the user\'s primary warehouse.'
    )

    class Meta(UserCreationForm.Meta):
        # UserCreationForm.Meta.fields is ('username',). We add staff_record
        # before username so it appears at the top of the form.
        fields = ('staff_record', 'username')

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        try:
            from hr.models import Staff
            self.fields['staff_record'].queryset = (
                Staff.objects.filter(is_active=True).order_by('staff_id')
            )
        except Exception:
            # hr app not ready; leave the choice empty so the form still works.
            self.fields['staff_record'].queryset = None
            self.fields['staff_record'].disabled = True

        # Pull the role list from rbac.ERPRole (the canonical predefined ERP
        # role list), not core.RoleDefinition. This matches what the frontend
        # Add User form shows.
        try:
            from rbac.models import ERPRole
            self.fields['role'].queryset = (
                ERPRole.objects.filter(is_active=True).order_by('name')
            )
        except Exception:
            self.fields['role'].queryset = None
            self.fields['role'].disabled = True
            self.fields['role'].required = False

        # Username is now optional — derived from staff_id when a Staff is picked.
        self.fields['username'].required = False
        self.fields['username'].help_text = (
            'Optional if a Staff is selected (uses Staff ID). '
            'Letters, digits and @/./+/-/_ only.'
        )

    def clean(self):
        cleaned = super().clean()
        staff = cleaned.get('staff_record')
        username = cleaned.get('username')
        if not username and staff:
            cleaned['username'] = staff.staff_id
            self.cleaned_data['username'] = staff.staff_id
        elif not username and not staff:
            self.add_error('username', 'Provide a username or pick a Staff record.')
        # Re-run username uniqueness check now that we may have populated it.
        uname = cleaned.get('username')
        User = get_user_model()
        if uname and User.objects.filter(username=uname).exists():
            self.add_error('username', f'A user with username "{uname}" already exists.')
        return cleaned

    def save(self, commit=True):
        user = super().save(commit=False)
        staff = self.cleaned_data.get('staff_record')
        role = self.cleaned_data.get('role')
        default_wh = self.cleaned_data.get('default_warehouse')
        if staff:
            if not user.first_name:
                user.first_name = staff.first_name or ''
            if not user.last_name:
                user.last_name = staff.last_name or ''
            # Staff has no email field; leave User.email blank by default.
            # Mark as staff so the user lights up green in the admin list and
            # can log into the admin site if granted appropriate permissions.
            user.is_staff = True
        if commit:
            user.save()
            # Always create the StakeholderUser bridge for staff link / default
            # warehouse. The role itself is stored separately in rbac.
            stakeholder, _ = StakeholderUser.objects.get_or_create(
                user=user,
                defaults={
                    'employee_record': staff,
                    'mobile': staff.contact_number if staff else '',
                    'default_warehouse': default_wh,
                },
            )
            # Persist the chosen ERPRole via rbac.UserRoleAssignment — this
            # is the bridge the frontend uses to resolve permissions.
            if role:
                try:
                    from rbac.models import UserRoleAssignment
                    UserRoleAssignment.objects.update_or_create(
                        user=user,
                        defaults={'role': role, 'assigned_by': user},
                    )
                except Exception:
                    # rbac not migrated yet — silently skip; the user still
                    # gets created so the admin form doesn't error out.
                    pass
        return user


User = get_user_model()
try:
    admin.site.unregister(User)
except admin.sites.NotRegistered:
    pass


@admin.register(User)
class StaffBackedUserAdmin(UserAdmin):
    """Standard UserAdmin with a Staff selector on the add form."""
    add_form = StaffBackedUserCreationForm
    add_fieldsets = (
        ('User Information', {
            'classes': ('wide',),
            'fields': ('staff_record', 'username', 'password1', 'password2'),
        }),
        ('Role Assignment', {
            'classes': ('wide',),
            'description': 'Same as the frontend Add User form.',
            'fields': ('role', 'default_warehouse'),
        }),
    )
    # Show both is_active ("Active") and is_staff ("Staff Status") so it's
    # obvious which flag is which in the user list.
    list_display = (
        'username', 'email', 'first_name', 'last_name', 'is_active', 'is_staff'
    )
    list_filter = ('is_active', 'is_staff', 'is_superuser', 'groups')



@admin.register(Company)
class CompanyAdmin(admin.ModelAdmin):
    """Admin for Company model."""

    list_display = (
        'company_code', 'legal_name', 'gstin', 'contact_email',
        'default_currency', 'is_active_display', 'created_at'
    )
    list_filter = ('is_active', 'default_currency', 'created_at')
    search_fields = ('company_code', 'legal_name', 'gstin', 'pan')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    fieldsets = (
        ('Company Information', {
            'fields': ('company_code', 'legal_name', 'trade_name', 'id')
        }),
        ('Tax & Legal', {
            'fields': ('gstin', 'pan', 'cin')
        }),
        ('Address', {
            'fields': ('registered_address', 'billing_address'),
            'classes': ('collapse',)
        }),
        ('Contact', {
            'fields': ('contact_email', 'contact_phone')
        }),
        ('Settings', {
            'fields': ('default_currency', 'books_export_flag')
        }),
        ('Status', {
            'fields': ('active_from', 'active_to', 'is_active')
        }),
        ('Notes', {
            'fields': ('notes',),
            'classes': ('collapse',)
        }),
        ('Audit', {
            'fields': ('created_by', 'created_at', 'updated_by', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
    date_hierarchy = 'created_at'
    actions = ['make_active', 'make_inactive']

    def is_active_display(self, obj):
        """Display active status with color."""
        color = 'green' if obj.is_active else 'red'
        text = 'Active' if obj.is_active else 'Inactive'
        return format_html(
            '<span style="color: {};">{}</span>',
            color,
            text
        )
    is_active_display.short_description = 'Status'

    @admin.action(description='Mark selected companies as active')
    def make_active(self, request, queryset):
        queryset.update(is_active=True)

    @admin.action(description='Mark selected companies as inactive')
    def make_inactive(self, request, queryset):
        queryset.update(is_active=False)


@admin.register(Warehouse)
class WarehouseAdmin(admin.ModelAdmin):
    """Admin for Warehouse model."""

    list_display = (
        'warehouse_code', 'name', 'company', 'warehouse_type', 'city', 'state',
        'active_flag_display', 'created_at'
    )
    list_filter = ('warehouse_type', 'state', 'active_flag', 'created_at')
    search_fields = ('warehouse_code', 'name', 'city', 'company__company_code')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    filter_horizontal = (
        'warehouse_managers', 'warehouse_coordinators', 'warehouse_supervisors'
    )
    fieldsets = (
        ('Warehouse Information', {
            'fields': ('warehouse_code', 'company', 'name', 'warehouse_type', 'id')
        }),
        ('Location', {
            'fields': (
                'address', 'city', 'state', 'country', 'pincode',
                'geo_latitude', 'geo_longitude', 'time_zone'
            )
        }),
        ('Configuration', {
            'fields': ('default_currency', 'active_flag')
        }),
        ('Coordinators', {
            'fields': ('warehouse_coordinator_office', 'warehouse_hr_coordinator'),
            'classes': ('collapse',)
        }),
        ('Staff Assignment', {
            'fields': (
                'warehouse_managers', 'warehouse_coordinators', 'warehouse_supervisors'
            ),
            'classes': ('collapse',)
        }),
        ('Notes', {
            'fields': ('notes',),
            'classes': ('collapse',)
        }),
        ('Audit', {
            'fields': ('created_by', 'created_at', 'updated_by', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
    date_hierarchy = 'created_at'

    def active_flag_display(self, obj):
        """Display active flag with color."""
        color = 'green' if obj.active_flag else 'red'
        text = 'Active' if obj.active_flag else 'Inactive'
        return format_html(
            '<span style="color: {};">{}</span>',
            color,
            text
        )
    active_flag_display.short_description = 'Status'


@admin.register(Godown)
class GodownAdmin(admin.ModelAdmin):
    """Admin for Godown model."""

    list_display = (
        'godown_code', 'warehouse', 'godown_name', 'storage_condition',
        'capacity_value', 'capacity_uom', 'active_flag_display'
    )
    list_filter = ('storage_condition', 'active_flag', 'created_at')
    search_fields = ('godown_code', 'godown_name', 'warehouse__warehouse_code')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    fieldsets = (
        ('Godown Information', {
            'fields': ('godown_code', 'warehouse', 'godown_name', 'id')
        }),
        ('Storage Configuration', {
            'fields': (
                'storage_condition', 'capacity_uom', 'capacity_value',
                'batch_tracking_enabled', 'default_qc_hold_area'
            )
        }),
        ('Status', {
            'fields': ('active_flag',)
        }),
        ('Notes', {
            'fields': ('notes',),
            'classes': ('collapse',)
        }),
        ('Audit', {
            'fields': ('created_by', 'created_at', 'updated_by', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
    date_hierarchy = 'created_at'

    def active_flag_display(self, obj):
        """Display active flag with color."""
        color = 'green' if obj.active_flag else 'red'
        text = 'Active' if obj.active_flag else 'Inactive'
        return format_html(
            '<span style="color: {};">{}</span>',
            color,
            text
        )
    active_flag_display.short_description = 'Status'


class ApprovalLevelInline(admin.TabularInline):
    """Inline admin for ApprovalLevel."""

    model = ApprovalLevel
    extra = 1
    fields = ('module', 'stage', 'min_amount', 'max_amount')


@admin.register(RoleDefinition)
class RoleDefinitionAdmin(admin.ModelAdmin):
    """Admin for RoleDefinition model."""

    list_display = (
        'role_code', 'role_name', 'data_scope', 'active_flag_display', 'created_at'
    )
    list_filter = ('data_scope', 'active_flag', 'created_at')
    search_fields = ('role_code', 'role_name')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    inlines = [ApprovalLevelInline]
    fieldsets = (
        ('Role Information', {
            'fields': ('role_code', 'role_name', 'id')
        }),
        ('Configuration', {
            'fields': ('data_scope', 'module_permissions', 'active_flag')
        }),
        ('Audit', {
            'fields': ('created_by', 'created_at', 'updated_by', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
    date_hierarchy = 'created_at'

    def active_flag_display(self, obj):
        """Display active flag with color."""
        color = 'green' if obj.active_flag else 'red'
        text = 'Active' if obj.active_flag else 'Inactive'
        return format_html(
            '<span style="color: {};">{}</span>',
            color,
            text
        )
    active_flag_display.short_description = 'Status'


@admin.register(StakeholderUser)
class StakeholderUserAdmin(admin.ModelAdmin):
    """Admin for StakeholderUser model."""

    list_display = (
        'username_display', 'primary_email', 'mobile', 'status',
        'default_warehouse_display', 'is_active_display'
    )
    list_filter = ('status', 'is_active', 'created_at')
    search_fields = (
        'user__username', 'user__first_name', 'user__last_name', 'primary_email'
    )
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    filter_horizontal = ('assigned_roles', 'warehouse_scope')
    fieldsets = (
        ('User Information', {
            'fields': ('user', 'employee_record', 'id')
        }),
        ('Contact', {
            'fields': ('primary_email', 'mobile')
        }),
        ('Configuration', {
            'fields': ('default_warehouse', 'status')
        }),
        ('Access Control', {
            'fields': ('assigned_roles', 'warehouse_scope'),
            'classes': ('collapse',)
        }),
        ('Activity', {
            'fields': ('last_accessed',),
            'classes': ('collapse',)
        }),
        ('Notes', {
            'fields': ('notes',),
            'classes': ('collapse',)
        }),
        ('Audit', {
            'fields': ('created_by', 'created_at', 'updated_by', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
    date_hierarchy = 'created_at'

    def username_display(self, obj):
        """Display user's full username."""
        return obj.user.username
    username_display.short_description = 'Username'

    def default_warehouse_display(self, obj):
        """Display default warehouse."""
        return obj.default_warehouse.warehouse_code if obj.default_warehouse else '-'
    default_warehouse_display.short_description = 'Default Warehouse'

    def is_active_display(self, obj):
        """Display active status with color."""
        color = 'green' if obj.is_active else 'red'
        text = 'Active' if obj.is_active else 'Inactive'
        return format_html(
            '<span style="color: {};">{}</span>',
            color,
            text
        )
    is_active_display.short_description = 'Status'


@admin.register(ApprovalLevel)
class ApprovalLevelAdmin(admin.ModelAdmin):
    """Admin for ApprovalLevel model."""

    list_display = (
        'role', 'module', 'stage', 'min_amount', 'max_amount'
    )
    list_filter = ('module', 'stage', 'created_at')
    search_fields = ('role__role_code', 'module')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    fieldsets = (
        ('Approval Configuration', {
            'fields': ('role', 'module', 'stage', 'id')
        }),
        ('Amount Thresholds', {
            'fields': ('min_amount', 'max_amount')
        }),
        ('Audit', {
            'fields': ('created_by', 'created_at', 'updated_by', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
    date_hierarchy = 'created_at'

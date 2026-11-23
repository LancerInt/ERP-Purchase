"""
Django admin configuration for master app.
"""
from django.contrib import admin
from django.utils.html import format_html
from .models import (
    Product, SecondaryUOM, ServiceCatalogue, Vendor, VendorBankDetail,
    Customer, ShippingAddress, Transporter, PriceList, PriceLine, TaxMaster,
    TemplateLibrary, TemplateApprovalLog,
    MachineryDivision, MachineryExpense, ExpenseCategory,
)


class _ActiveStateFilter(admin.SimpleListFilter):
    """Sidebar filter for the SoftDeleteAdminMixin.

    "Active" (default) — only is_active=True (and active_flag=True
        where the model has it). Matches the frontend list pages.
    "Deactivated"      — only soft-deleted rows (is_active=False or
        active_flag=False).
    "All"              — no filter at all (admin's traditional view).
    """

    title = 'state'
    parameter_name = 'state'

    def lookups(self, request, model_admin):
        return (
            ('active', 'Active'),
            ('deactivated', 'Deactivated'),
            ('all', 'All (incl. deactivated)'),
        )

    def value(self):
        # Default to 'active' so the admin matches what the operator
        # sees on the frontend the moment they land on the page.
        v = super().value()
        return v if v in {'active', 'deactivated', 'all'} else 'active'

    def queryset(self, request, queryset):
        from django.db.models import Q
        state = self.value()
        if state == 'all':
            return queryset
        model = queryset.model
        has_active_flag = any(f.name == 'active_flag' for f in model._meta.get_fields())
        has_is_active   = any(f.name == 'is_active'   for f in model._meta.get_fields())
        if state == 'deactivated':
            cond = Q()
            if has_is_active:   cond |= Q(is_active=False)
            if has_active_flag: cond |= Q(active_flag=False)
            return queryset.filter(cond) if cond else queryset.none()
        # state == 'active'
        if has_is_active:   queryset = queryset.filter(is_active=True)
        if has_active_flag: queryset = queryset.filter(active_flag=True)
        return queryset


class SoftDeleteAdminMixin:
    """Hide soft-deleted rows from the admin changelist by default so
    the admin view matches what the frontend lists show — without
    losing access to deactivated rows entirely (the State filter in
    the sidebar still lets an operator toggle to "Deactivated" or
    "All").

    Drop this mixin in alongside ``admin.ModelAdmin``::

        @admin.register(Product)
        class ProductAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
            ...
    """

    def get_list_filter(self, request):
        existing = list(super().get_list_filter(request) or [])
        if _ActiveStateFilter not in existing:
            existing.insert(0, _ActiveStateFilter)
        return existing


@admin.register(Product)
class ProductAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Admin for Product model."""

    list_display = (
        'sku_code', 'product_name', 'product_type', 'goods_sub_type',
        'uom', 'batch_tracking_display', 'active_flag_display', 'created_at'
    )
    list_filter = ('product_type', 'goods_sub_type', 'batch_tracking_required', 'active_flag')
    search_fields = ('sku_code', 'product_name')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    fieldsets = (
        ('Product Information', {
            'fields': ('sku_code', 'product_name', 'product_type', 'id')
        }),
        ('Classification', {
            'fields': ('goods_sub_type', 'service_sub_type', 'custom_service_category')
        }),
        ('Physical Properties', {
            'fields': (
                'uom', 'specific_gravity', 'packing_material_default',
                'conversion_notes'
            )
        }),
        ('Tracking & QC', {
            'fields': (
                'batch_tracking_required', 'shelf_life_days', 'qc_responsibility',
                'qc_template', 'yield_tracking_required', 'yield_parameters'
            ),
            'classes': ('collapse',)
        }),
        ('Description', {
            'fields': ('description',)
        }),
        ('Location (Machinery)', {
            'fields': (
                'company', 'warehouse',
                'godown', 'division',
            ),
            'description': 'Machinery products use Company, Warehouse, Godown and Division.',
            'classes': ('collapse',),
        }),
        ('Status', {
            'fields': ('active_flag',)
        }),
        ('Audit', {
            'fields': ('created_by', 'created_at', 'updated_by', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
    autocomplete_fields = ('division',)
    date_hierarchy = 'created_at'
    actions = ['soft_delete_selected', 'reactivate_selected']

    def get_actions(self, request):
        # Django's default `delete_selected` does a hard delete that
        # cascades through PROTECT FKs (inventory ledger, PO lines,
        # invoices…) and surfaces an unhelpful "Cannot delete" page.
        # Drop it from the dropdown so operators only see the soft-
        # delete action that actually works on a Product with history.
        actions = super().get_actions(request)
        actions.pop('delete_selected', None)
        return actions

    def soft_delete_selected(self, request, queryset):
        """Bulk soft-delete — flips ``is_active`` + ``active_flag``
        without touching FK constraints. Matches the
        ``SoftDeleteMixin.bulk_delete`` API behaviour."""
        count = queryset.update(is_active=False, active_flag=False)
        self.message_user(
            request,
            f'Deactivated {count} product{"" if count == 1 else "s"}.',
            level='success',
        )
    soft_delete_selected.short_description = 'Deactivate (soft delete) selected products'
    soft_delete_selected.allowed_permissions = ('delete',)

    def reactivate_selected(self, request, queryset):
        """Flip everything in the selection back to active — useful when
        the operator soft-deleted a batch by mistake."""
        count = queryset.update(is_active=True, active_flag=True)
        self.message_user(
            request,
            f'Reactivated {count} product{"" if count == 1 else "s"}.',
            level='success',
        )
    reactivate_selected.short_description = 'Reactivate selected products'
    reactivate_selected.allowed_permissions = ('change',)

    def batch_tracking_display(self, obj):
        """Display batch tracking status."""
        if obj.batch_tracking_required:
            return format_html('<span style="color: green;">Yes</span>')
        return format_html('<span style="color: gray;">No</span>')
    batch_tracking_display.short_description = 'Batch Track'

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


class SecondaryUOMInline(admin.TabularInline):
    """Inline admin for SecondaryUOM."""

    model = SecondaryUOM
    extra = 1
    fields = ('to_uom', 'conversion_factor', 'specific_gravity_override', 'valid_from', 'valid_to')


@admin.register(ServiceCatalogue)
class ServiceCatalogueAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Admin for ServiceCatalogue model."""

    list_display = (
        'service_code', 'name', 'category', 'direction', 'default_tds',
        'default_tcs', 'active_flag_display'
    )
    list_filter = ('category', 'direction', 'active_flag')
    search_fields = ('service_code', 'name')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    filter_horizontal = ('warehouse_availability',)
    fieldsets = (
        ('Service Information', {
            'fields': ('service_code', 'name', 'category', 'direction', 'id')
        }),
        ('Tax Configuration', {
            'fields': ('default_tds', 'default_tcs')
        }),
        ('Warehouse Availability', {
            'fields': ('warehouse_availability',)
        }),
        ('Description', {
            'fields': ('description',)
        }),
        ('Status', {
            'fields': ('active_flag',)
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


class VendorBankDetailInline(admin.TabularInline):
    """Inline admin for VendorBankDetail."""

    model = VendorBankDetail
    extra = 1
    fields = ('account_holder_name', 'account_number', 'ifsc_code', 'bank_name', 'is_primary')


@admin.register(Vendor)
class VendorAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Admin for Vendor model."""

    list_display = (
        'vendor_code', 'vendor_name', 'company', 'city', 'payment_terms',
        'credit_limit', 'active_flag_display', 'created_at'
    )
    list_filter = ('company', 'payment_terms', 'active_flag')
    search_fields = ('vendor_code', 'vendor_name', 'gstin')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    filter_horizontal = ('preferred_transporters', 'allowed_warehouses')
    inlines = [VendorBankDetailInline]
    fieldsets = (
        ('Vendor Information', {
            'fields': ('vendor_code', 'vendor_name', 'vendor_type', 'company', 'id')
        }),
        ('Tax & Legal', {
            'fields': ('gstin', 'pan')
        }),
        ('Address', {
            'fields': ('address', 'city', 'state', 'country', 'pincode')
        }),
        ('Contact', {
            'fields': ('contact_person', 'contact_email', 'contact_phone')
        }),
        ('Payment Terms', {
            'fields': ('payment_terms', 'custom_payment_days', 'credit_limit', 'credit_days')
        }),
        ('Tax', {
            'fields': ('tds_rate', 'tcs_rate'),
            'classes': ('collapse',)
        }),
        ('Relationships', {
            'fields': ('preferred_transporters', 'allowed_warehouses'),
            'classes': ('collapse',)
        }),
        ('Status', {
            'fields': ('active_flag',)
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


@admin.register(VendorBankDetail)
class VendorBankDetailAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Admin for VendorBankDetail model."""

    list_display = (
        'vendor', 'account_holder_name', 'bank_name', 'account_number',
        'ifsc_code', 'is_primary_display'
    )
    list_filter = ('vendor', 'is_primary')
    search_fields = ('vendor__vendor_code', 'account_number', 'ifsc_code')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')

    def is_primary_display(self, obj):
        """Display if primary account."""
        if obj.is_primary:
            return format_html('<span style="color: blue;">Primary</span>')
        return format_html('<span style="color: gray;">Secondary</span>')
    is_primary_display.short_description = 'Account Type'


class ShippingAddressInline(admin.TabularInline):
    """Inline admin for ShippingAddress."""

    model = ShippingAddress
    extra = 1
    fields = ('address_label', 'delivery_region', 'default_price_list')


@admin.register(Customer)
class CustomerAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Admin for Customer model."""

    list_display = (
        'customer_code', 'customer_name', 'company', 'credit_terms',
        'active_flag_display', 'created_at'
    )
    list_filter = ('company', 'credit_terms', 'active_flag')
    search_fields = ('customer_code', 'customer_name', 'gstin')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    filter_horizontal = ('allowed_price_lists', 'overdue_notification_recipients')
    inlines = [ShippingAddressInline]
    fieldsets = (
        ('Customer Information', {
            'fields': ('customer_code', 'customer_name', 'company', 'id')
        }),
        ('Tax & Legal', {
            'fields': ('gstin', 'pan')
        }),
        ('Billing Address', {
            'fields': ('billing_address',)
        }),
        ('Contact', {
            'fields': ('contact_person', 'contact_email', 'contact_phone')
        }),
        ('Credit Terms', {
            'fields': ('credit_terms', 'custom_credit_days')
        }),
        ('Freight', {
            'fields': ('freight_split_notes',),
            'classes': ('collapse',)
        }),
        ('Access Control', {
            'fields': ('allowed_price_lists', 'overdue_notification_recipients'),
            'classes': ('collapse',)
        }),
        ('Status', {
            'fields': ('active_flag',)
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


@admin.register(ShippingAddress)
class ShippingAddressAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Admin for ShippingAddress model."""

    list_display = (
        'address_label', 'customer', 'delivery_region', 'contact_person'
    )
    list_filter = ('customer', 'delivery_region')
    search_fields = ('customer__customer_code', 'address_label')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')


@admin.register(Transporter)
class TransporterAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Admin for Transporter model."""

    list_display = (
        'transporter_code', 'name',
        'active_flag_display', 'created_at'
    )
    list_filter = ('active_flag',)
    search_fields = ('transporter_code', 'name', 'gstin')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    fieldsets = (
        ('Transporter Information', {
            'fields': ('transporter_code', 'name', 'gstin', 'id')
        }),
        ('Contact', {
            'fields': ('contact_person', 'contact_email', 'contact_phone')
        }),
        ('Status', {
            'fields': ('active_flag',)
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


class PriceLineInline(admin.TabularInline):
    """Inline admin for PriceLine."""

    model = PriceLine
    extra = 1
    fields = ('product', 'uom', 'rate', 'discount', 'gst', 'freight_component', 'valid_from')


@admin.register(PriceList)
class PriceListAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Admin for PriceList model."""

    list_display = (
        'price_list_id', 'company', 'customer_display', 'currency', 'status',
        'effective_from', 'created_at'
    )
    list_filter = ('company', 'status', 'currency', 'effective_from')
    search_fields = ('price_list_id', 'company__company_code', 'customer__customer_code')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    inlines = [PriceLineInline]
    fieldsets = (
        ('Price List Information', {
            'fields': ('price_list_id', 'company', 'customer', 'id')
        }),
        ('Configuration', {
            'fields': (
                'delivery_region', 'currency', 'default_freight_terms',
                'status'
            )
        }),
        ('Validity', {
            'fields': ('effective_from', 'effective_to')
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

    def customer_display(self, obj):
        """Display customer or 'Universal'."""
        return obj.customer.customer_code if obj.customer else '(Universal)'
    customer_display.short_description = 'Customer'


@admin.register(PriceLine)
class PriceLineAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Admin for PriceLine model."""

    list_display = (
        'price_list', 'product', 'uom', 'rate', 'discount', 'gst'
    )
    list_filter = ('price_list', 'uom')
    search_fields = ('price_list__price_list_id', 'product__sku_code')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')


@admin.register(TaxMaster)
class TaxMasterAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Admin for TaxMaster model."""

    list_display = (
        'tax_type', 'section_reference', 'rate', 'company_scope',
        'effective_from', 'effective_to'
    )
    list_filter = ('tax_type', 'company_scope', 'effective_from')
    search_fields = ('tax_type', 'section_reference', 'company_scope__company_code')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    fieldsets = (
        ('Tax Configuration', {
            'fields': ('tax_type', 'section_reference', 'rate', 'company_scope', 'id')
        }),
        ('Applicability', {
            'fields': ('applicable_on', 'threshold_amount')
        }),
        ('Validity', {
            'fields': ('effective_from', 'effective_to')
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
    date_hierarchy = 'effective_from'


class TemplateApprovalLogInline(admin.TabularInline):
    """Inline admin for TemplateApprovalLog."""

    model = TemplateApprovalLog
    extra = 0
    fields = ('approval_status', 'approved_by', 'approval_date')
    readonly_fields = ('approval_date',)
    can_delete = False


@admin.register(TemplateLibrary)
class TemplateLibraryAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Admin for TemplateLibrary model."""

    list_display = (
        'template_id', 'template_type', 'name', 'revision_no', 'status',
        'requires_signature_display', 'created_at'
    )
    list_filter = ('template_type', 'status', 'requires_digital_signature')
    search_fields = ('template_id', 'name')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    filter_horizontal = ('warehouse_scope',)
    inlines = [TemplateApprovalLogInline]
    fieldsets = (
        ('Template Information', {
            'fields': ('template_id', 'template_type', 'name', 'id')
        }),
        ('Version & Status', {
            'fields': ('revision_no', 'status')
        }),
        ('Configuration', {
            'fields': ('layout_json', 'requires_digital_signature')
        }),
        ('Validity', {
            'fields': ('effective_from', 'effective_to')
        }),
        ('Scope', {
            'fields': ('warehouse_scope',),
            'classes': ('collapse',)
        }),
        ('Audit', {
            'fields': ('created_by', 'created_at', 'updated_by', 'updated_at'),
            'classes': ('collapse',)
        }),
    )
    date_hierarchy = 'created_at'

    def requires_signature_display(self, obj):
        """Display signature requirement."""
        if obj.requires_digital_signature:
            return format_html('<span style="color: orange;">Signature Required</span>')
        return format_html('<span style="color: gray;">No Signature</span>')
    requires_signature_display.short_description = 'Digital Signature'


@admin.register(TemplateApprovalLog)
class TemplateApprovalLogAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Admin for TemplateApprovalLog model."""

    list_display = (
        'template', 'approval_status_display', 'approved_by', 'approval_date'
    )
    list_filter = ('approval_status', 'approval_date')
    search_fields = ('template__template_id', 'approved_by__user__username')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    date_hierarchy = 'approval_date'

    def approval_status_display(self, obj):
        """Display approval status with color."""
        colors = {
            'PENDING': 'orange',
            'APPROVED': 'green',
            'REJECTED': 'red',
        }
        color = colors.get(obj.approval_status, 'gray')
        return format_html(
            '<span style="color: {};">{}</span>',
            color,
            obj.approval_status
        )
    approval_status_display.short_description = 'Status'


# ── Machinery Division ─────────────────────────────────────────────────
@admin.register(MachineryDivision)
class MachineryDivisionAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Django admin for the Machinery Division master.

    Surfaced so a superuser can seed Divisions without going through the
    React frontend — the frontend Machinery Expense create page now only
    *picks* from existing Divisions (the inline "Add" button is gone),
    so the rows have to be created somewhere; this admin is that
    somewhere.
    """

    list_display  = ('name', 'company', 'warehouse', 'godown', 'active_flag_display', 'created_at')
    list_filter   = ('company', 'warehouse', 'active_flag')
    search_fields = ('name',)
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    autocomplete_fields = ()  # Company/Warehouse/Godown autocompletes can be added later
    fieldsets = (
        ('Division', {
            'fields': ('name', 'company', 'warehouse', 'godown', 'notes'),
        }),
        ('Status', {'fields': ('active_flag',)}),
        ('Audit', {
            'fields': ('id', 'created_by', 'created_at', 'updated_by', 'updated_at'),
            'classes': ('collapse',),
        }),
    )

    def active_flag_display(self, obj):
        color = 'green' if obj.active_flag else 'red'
        text  = 'Active' if obj.active_flag else 'Inactive'
        return format_html('<span style="color: {};">{}</span>', color, text)
    active_flag_display.short_description = 'Status'


# ── Machinery Expense ──────────────────────────────────────────────────
@admin.register(MachineryExpense)
class MachineryExpenseAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """Django admin for the Machinery Expense master.

    `category` is a single FK to ExpenseCategory — the frontend renders
    it as a dropdown (one category per expense, no multi-select).
    """

    list_display  = ('name', 'company', 'warehouse', 'category',
                     'active_flag_display', 'created_at')
    list_filter   = ('company', 'warehouse', 'category', 'active_flag')
    search_fields = ('name',)
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    autocomplete_fields = ('category',)
    fieldsets = (
        ('Expense', {
            'fields': ('name', 'company', 'warehouse', 'category', 'notes'),
        }),
        ('Status', {'fields': ('active_flag',)}),
        ('Audit', {
            'fields': ('id', 'created_by', 'created_at', 'updated_by', 'updated_at'),
            'classes': ('collapse',),
        }),
    )

    def active_flag_display(self, obj):
        color = 'green' if obj.active_flag else 'red'
        text  = 'Active' if obj.active_flag else 'Inactive'
        return format_html('<span style="color: {};">{}</span>', color, text)
    active_flag_display.short_description = 'Status'


# ── Expense Category ──────────────────────────────────────────────────
@admin.register(ExpenseCategory)
class ExpenseCategoryAdmin(SoftDeleteAdminMixin, admin.ModelAdmin):
    """The ONLY place new expense categories are created. The frontend
    Machinery Expense form reads `/api/expense-categories/` but cannot
    POST to it (the matching ViewSet is read-only), so a superuser
    seeds the list here."""

    list_display  = ('name', 'description_short', 'active_flag_display', 'created_at')
    list_filter   = ('active_flag',)
    search_fields = ('name', 'description')
    readonly_fields = ('id', 'created_at', 'updated_at', 'created_by', 'updated_by')
    fieldsets = (
        ('Category', {'fields': ('name', 'description', 'active_flag')}),
        ('Audit', {
            'fields': ('id', 'created_by', 'created_at', 'updated_by', 'updated_at'),
            'classes': ('collapse',),
        }),
    )

    def description_short(self, obj):
        return (obj.description[:60] + '…') if len(obj.description or '') > 60 else (obj.description or '—')
    description_short.short_description = 'Description'

    def active_flag_display(self, obj):
        color = 'green' if obj.active_flag else 'red'
        text  = 'Active' if obj.active_flag else 'Inactive'
        return format_html('<span style="color: {};">{}</span>', color, text)
    active_flag_display.short_description = 'Status'

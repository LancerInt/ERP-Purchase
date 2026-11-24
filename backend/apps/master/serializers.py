"""
Serializers for master app models.
"""
import re

from rest_framework import serializers
from .models import (
    Product, ProductCustomerName, SecondaryUOM, ServiceCatalogue, Vendor, VendorBankDetail,
    Customer, ShippingAddress, Transporter, PriceList, PriceLine, TaxMaster,
    TemplateLibrary, TemplateApprovalLog, Broker, StateGroup,
    MachineryDivision, MachineryExpense, ExpenseCategory, MasterAttachment,
    ExpenseParty,
)


class SecondaryUOMSerializer(serializers.ModelSerializer):
    """Serializer for SecondaryUOM."""

    class Meta:
        model = SecondaryUOM
        fields = [
            'id', 'product', 'to_uom', 'conversion_factor',
            'specific_gravity_override', 'valid_from', 'valid_to',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']
        extra_kwargs = {
            'specific_gravity_override': {'required': False},
            'valid_from': {'required': False},
            'valid_to': {'required': False},
        }


class ProductCustomerNameSerializer(serializers.ModelSerializer):
    """A (customer, trade_name) alias row for a product."""

    customer_name = serializers.CharField(source='customer.customer_name', read_only=True, default='')

    class Meta:
        model = ProductCustomerName
        fields = ['id', 'customer', 'customer_name', 'trade_name']
        extra_kwargs = {
            'customer': {'required': False, 'allow_null': True},
            'trade_name': {'required': True},
        }


class ProductLookupSerializer(serializers.ModelSerializer):
    """The handful of fields a PRODUCT DROPDOWN needs, and nothing else.

    Opt-in only, via ?slim=1 - callers that don't ask for it keep the full
    ProductSerializer byte for byte, so this cannot change what any existing
    screen shows.

    Why it exists: the full serializer emits 45 fields, about 1.2 KB a row.
    Pages that only populate an "All products" <select> were pulling 4.6 MB
    and waiting ~3s for it, of which only 0.5s was the database - the rest was
    building JSON nobody reads. useLookup turns each row into {value, label}
    where label falls back to product_name, so these four fields cover it.
    """

    class Meta:
        model = Product
        # goods_sub_type is what lets a dropdown GROUP these. The master is
        # 2,600+ rows of which 865 are machine spares, so an ungrouped list is
        # mostly bolts whatever order it is in.
        fields = ['id', 'product_name', 'sku_code', 'uom', 'goods_sub_type']


class ProductSerializer(serializers.ModelSerializer):
    """Serializer for Product model."""

    secondary_uoms = SecondaryUOMSerializer(many=True, read_only=True)
    # Per-customer trade names — a product can be sold to many customers under
    # different brand names; the Customer-PO extractor matches PO lines against
    # these. Nested writable so the product edit form manages them inline.
    customer_names = ProductCustomerNameSerializer(many=True, required=False)
    preferred_vendors_detail = serializers.SerializerMethodField()
    # Full set of warehouses this product is stocked at (multi-select). The
    # single `warehouse` FK is kept as the PRIMARY (first picked) for every
    # existing reader (stock report, etc.); `warehouses` holds the full set.
    warehouses_detail = serializers.SerializerMethodField()

    # Read-only label mirrors so the edit form can render the saved
    # dropdown choices before the lookup endpoints resolve.
    company_name   = serializers.CharField(source='company.legal_name',   read_only=True, default='')
    warehouse_name = serializers.CharField(source='warehouse.name',       read_only=True, default='')
    godown_name    = serializers.CharField(source='godown.godown_name',   read_only=True, default='')
    division_name  = serializers.CharField(source='division.name',        read_only=True, default='')

    # Write-only: for a new MACHINERY spare, the machine base whose /part
    # sequence the auto-generated sku_code continues (e.g. "BU-001"). Not a
    # model field — consumed in create() to build the SKU.
    machine_base = serializers.CharField(write_only=True, required=False, allow_blank=True)
    # Write-only: for a new PACKING_MATERIAL, the plant series whose -PACK-###
    # sequence the code continues (e.g. "SSB-002"). Also create-only.
    pack_base = serializers.CharField(write_only=True, required=False, allow_blank=True)
    # UOM accepts any short code. The frontend offers a curated dropdown
    # (KG / NOS / LTRS / …) that evolves over time; a fixed choices list on the
    # model drifts out of sync and rejects valid picks (e.g. "NOS"), so the API
    # takes the raw string instead of a ChoiceField.
    uom = serializers.CharField(max_length=10)

    class Meta:
        model = Product
        fields = [
            'id', 'sku_code', 'product_name', 'product_type', 'goods_sub_type',
            'service_sub_type', 'custom_service_category', 'description',
            'batch_tracking_required', 'sg_applicable', 'shelf_life_days', 'qc_responsibility',
            'qc_template', 'uom', 'specific_gravity',
            'pack_size_kg', 'pack_size_ltr',
            'conversion_notes', 'gst_percentage',
            'packing_material_default', 'yield_tracking_required', 'yield_parameters',
            'active_flag', 'secondary_uoms',
            'preferred_vendors', 'preferred_vendors_detail',
            'company',  'company_name',
            'warehouse', 'warehouse_name',
            'warehouses', 'warehouses_detail',
            'godown',   'godown_name',
            'division', 'division_name',
            'finished_good_customer', 'product_trade_name', 'parent_product',
            'customer_names', 'machine_base', 'pack_base',
            'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at',
            'company_name', 'warehouse_name', 'godown_name',
            'division_name',
        ]
        extra_kwargs = {
            'sku_code': {'required': False, 'allow_blank': True},
            'goods_sub_type': {'required': False, 'allow_blank': True},
            'service_sub_type': {'required': False, 'allow_blank': True},
            'custom_service_category': {'required': False},
            'description': {'required': False, 'allow_blank': True},
            'finished_good_customer': {'required': False, 'allow_null': True},
            'product_trade_name': {'required': False, 'allow_blank': True},
            'parent_product': {'required': False, 'allow_null': True},
            'shelf_life_days': {'required': False},
            'qc_responsibility': {'required': False, 'allow_blank': True},
            'qc_template': {'required': False},
            'specific_gravity': {'required': False},
            'gst_percentage': {'required': False, 'allow_null': True},
            'conversion_notes': {'required': False, 'allow_blank': True},
            'packing_material_default': {'required': False},
            'yield_parameters': {'required': False},
            'preferred_vendors': {'required': False},
            'warehouses': {'required': False},
            'company':   {'required': False, 'allow_null': True},
            'warehouse': {'required': False, 'allow_null': True},
            'godown':    {'required': False, 'allow_null': True},
            'division':  {'required': False, 'allow_null': True},
        }

    def get_preferred_vendors_detail(self, obj):
        return [
            {
                'id': str(v.id),
                'vendor_name': v.vendor_name,
                'vendor_code': v.vendor_code,
                'contact_email': v.contact_email or '',
            }
            for v in obj.preferred_vendors.all()
        ]

    # ── nested customer-trade-name rows ────────────────────────────────
    def _sync_customer_names(self, product, rows):
        """Replace the product's customer alias rows with `rows` (a list of
        {customer, trade_name}). Blank trade names are ignored."""
        product.customer_names.all().delete()
        for row in rows or []:
            name = (row.get('trade_name') or '').strip()
            if not name:
                continue
            ProductCustomerName.objects.create(
                product=product, customer=row.get('customer'), trade_name=name,
            )

    def create(self, validated_data):
        from django.db import IntegrityError, transaction
        from .sku_gen import next_sku

        customer_names = validated_data.pop('customer_names', None)
        machine_base = (validated_data.pop('machine_base', '') or '').strip()
        pack_base = (validated_data.pop('pack_base', '') or '').strip()
        auto = not (validated_data.get('sku_code') or '').strip()

        # When the SKU is left blank, generate it from the category (goods /
        # service prefix), the machine base, or the packing series — continuing
        # that series' running number. Two people creating the same category at
        # once could compute the same number, so retry on the unique-constraint
        # violation, each attempt recomputing max+1.
        if auto and next_sku(validated_data.get('product_type'),
                             validated_data.get('goods_sub_type'),
                             machine_base, pack_base) is None:
            raise serializers.ValidationError({'sku_code':
                'This category has no auto-numbering scheme — enter a SKU code.'})

        product = None
        for attempt in range(6 if auto else 1):
            if auto:
                validated_data['sku_code'] = next_sku(
                    validated_data.get('product_type'),
                    validated_data.get('goods_sub_type'), machine_base, pack_base)
            try:
                with transaction.atomic():
                    product = super().create(validated_data)
                break
            except IntegrityError:
                if not auto or attempt == 5:
                    raise

        if customer_names is not None:
            self._sync_customer_names(product, customer_names)
        return product

    def update(self, instance, validated_data):
        customer_names = validated_data.pop('customer_names', None)
        validated_data.pop('machine_base', None)   # write-only; not used on edit
        validated_data.pop('pack_base', None)      # write-only; not used on edit
        product = super().update(instance, validated_data)
        if customer_names is not None:
            self._sync_customer_names(product, customer_names)
        return product

    def get_warehouses_detail(self, obj):
        return [
            {'id': str(w.id), 'name': w.name, 'warehouse_code': w.warehouse_code}
            for w in obj.warehouses.all()
        ]

    def validate(self, data):
        # A product NAME must be unique within its location scope:
        #   - if a GODOWN is set → unique within that godown (any division);
        #   - if NO godown → unique across the whole WAREHOUSE.
        # (Division no longer widens the scope — two "Liner - 5kg" rows in the
        # same warehouse are a duplicate even under different divisions.)
        # Compare case-insensitively, whitespace stripped ("Belt" / " belt "
        # collide). Partial updates fall back to the instance for omitted fields.
        inst = self.instance

        def val(field):
            return data[field] if field in data else (getattr(inst, field, None) if inst else None)

        name = (val('product_name') or '').strip()
        warehouse = val('warehouse')
        godown = val('godown')
        if name:
            qs = Product.objects.filter(
                product_name__iexact=name,
                active_flag=True,
                warehouse=warehouse,
            )
            # Godown given → scope to that godown; otherwise the name must be
            # unique across every product in the warehouse.
            scope = 'godown' if godown else 'warehouse'
            if godown:
                qs = qs.filter(godown=godown)
            if inst is not None:
                qs = qs.exclude(pk=inst.pk)
            if qs.exists():
                raise serializers.ValidationError({
                    'product_name': (
                        f'An active product named "{name}" already exists in this '
                        f'{scope}. Use a different name'
                        + (' or assign a godown.' if scope == 'warehouse' else '.')
                    )
                })
        return data


class ServiceCatalogueSerializer(serializers.ModelSerializer):
    """Serializer for ServiceCatalogue model."""

    warehouse_availability = serializers.StringRelatedField(many=True, read_only=True)
    company_name = serializers.CharField(source='company.legal_name', read_only=True, default='')
    warehouse_name = serializers.CharField(source='warehouse.name', read_only=True, default='')
    godown_name = serializers.CharField(source='godown.godown_name', read_only=True, default='')

    class Meta:
        model = ServiceCatalogue
        fields = [
            'id', 'service_code', 'name', 'category', 'direction',
            'default_tds', 'default_tcs', 'description', 'active_flag',
            'warehouse_availability',
            'company', 'company_name',
            'warehouse', 'warehouse_name',
            'godown', 'godown_name',
            'division',
            'is_active', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']
        extra_kwargs = {
            'default_tds': {'required': False},
            'default_tcs': {'required': False},
            'description': {'required': False, 'allow_blank': True},
            # Location fields are optional — a service can be company-wide
            # or unbound to any specific warehouse.
            'company': {'required': False, 'allow_null': True},
            'warehouse': {'required': False, 'allow_null': True},
            'godown': {'required': False, 'allow_null': True},
            'division': {'required': False, 'allow_blank': True},
        }


class VendorBankDetailSerializer(serializers.ModelSerializer):
    """Serializer for VendorBankDetail."""

    class Meta:
        model = VendorBankDetail
        fields = [
            'id', 'vendor', 'account_holder_name', 'account_number',
            'ifsc_code', 'bank_name', 'branch_name', 'is_primary',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']
        extra_kwargs = {
            'branch_name': {'required': False, 'allow_blank': True},
        }


class VendorLookupSerializer(serializers.ModelSerializer):
    """The few fields a VENDOR DROPDOWN needs. Opt-in via ?slim=1 only.

    Purchase Analytics, Dashboard and Vendor Insights each pull the vendor
    master purely to fill a <select>; useLookup turns a row into
    {value: id, label: vendor_name}. Sending the full vendor record for that
    cost ~758 KB and 0.8s per page open on production.

    Callers that do not pass the flag keep the full VendorSerializer byte for
    byte, so no existing screen can change.
    """

    class Meta:
        model = Vendor
        fields = ['id', 'vendor_name', 'vendor_code', 'gstin']


class VendorSerializer(serializers.ModelSerializer):
    """Serializer for Vendor model."""

    company_name = serializers.CharField(source='company.company_code', read_only=True)
    bank_details = VendorBankDetailSerializer(many=True, read_only=True)
    linked_customer_name = serializers.SerializerMethodField()
    # Write-only: the specific Customer the user picked in the suggestion picker.
    # When present it links to THAT record (via link_existing_customer) instead
    # of running the auto-matcher. Never stored directly; popped in create/update.
    link_to_customer_id = serializers.UUIDField(
        write_only=True, required=False, allow_null=True)

    def get_linked_customer_name(self, obj):
        lc = getattr(obj, 'linked_customer', None)
        return lc.customer_name if lc else None

    class Meta:
        model = Vendor
        fields = [
            'id', 'vendor_code', 'vendor_name', 'vendor_type', 'company',
            'company_name', 'gstin', 'pan', 'gst_treatment', 'address', 'city', 'state', 'country',
            'pincode', 'contact_person', 'contact_email', 'contact_phone',
            'payment_terms', 'custom_payment_days',
            'gst_type', 'gst', 'sgst_rate', 'cgst_rate', 'igst_rate',
            'freight_split_notes', 'credit_limit', 'credit_days', 'tds_rate',
            'tcs_rate',
            # TDS engine inputs (A2 / A7)
            'deductee_category', 'pan_status', 'default_tds_section', 'is_206ab_specified',
            # MSME (A4)
            'is_msme', 'msme_category', 'msme_udyam_no', 'msme_certificate',
            'has_written_agreement', 'written_agreement_doc',
            # GST compliance (A4)
            'gstin_certificate', 'is_rcm',
            # GSTIN portal verification (A5) — status/snapshot are set by the
            # verify endpoint, read-only here.
            'gstin_verified_at', 'gstin_portal_status', 'gstin_snapshot',
            # Also-a-customer link. linked_customer / its name are managed by
            # the party-linking service, so they are read-only here.
            'is_group',
            'is_also_customer', 'linked_customer', 'linked_customer_name',
            'link_to_customer_id',
            'active_flag', 'bank_details', 'is_active',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'company_name', 'bank_details',
                            'gstin_verified_at', 'gstin_portal_status', 'gstin_snapshot',
                            'linked_customer', 'linked_customer_name']
        extra_kwargs = {
            # Auto-generated (<COMPANY_CODE>-VEN-### per company) when omitted —
            # the form no longer asks for it. Still accepted if explicitly sent
            # (e.g. bulk import) so a supplied code can override.
            'vendor_code': {'required': False, 'allow_blank': True},
            # GSTIN is required for REGISTERED vendors (the common case) but must
            # be blank for Unregistered / Overseas — enforced per gst_treatment
            # in validate(), so the field itself is relaxed here.
            'gstin': {'required': False, 'allow_null': True, 'allow_blank': True},
            'gst_treatment': {'required': False, 'allow_blank': True},
            'pan': {'required': False, 'allow_blank': True},
            'address': {'required': False},
            'city': {'required': False, 'allow_blank': True},
            'state': {'required': False, 'allow_blank': True},
            'country': {'required': False, 'allow_blank': True},
            'pincode': {'required': False, 'allow_blank': True},
            'contact_person': {'required': False, 'allow_blank': True},
            'contact_email': {'required': True, 'allow_blank': False},
            'contact_phone': {'required': False, 'allow_blank': True},
            'payment_terms': {'required': False, 'allow_blank': True},
            'custom_payment_days': {'required': False, 'allow_null': True},
            'gst_type': {'required': False, 'allow_blank': True},
            'gst': {'required': False},
            'sgst_rate': {'required': False},
            'cgst_rate': {'required': False},
            'igst_rate': {'required': False},
            'freight_split_notes': {'required': False, 'allow_blank': True},
            'credit_limit': {'required': False},
            'credit_days': {'required': False},
            'tds_rate': {'required': False},
            'tcs_rate': {'required': False},
            'deductee_category': {'required': False, 'allow_blank': True},
            'pan_status': {'required': False, 'allow_blank': True},
            'default_tds_section': {'required': False, 'allow_null': True},
            'is_206ab_specified': {'required': False},
            'is_msme': {'required': False},
            'msme_category': {'required': False, 'allow_blank': True},
            'msme_udyam_no': {'required': False, 'allow_blank': True},
            'msme_certificate': {'required': False, 'allow_null': True},
            'has_written_agreement': {'required': False},
            'written_agreement_doc': {'required': False, 'allow_null': True},
            'gstin_certificate': {'required': False, 'allow_null': True},
            'is_rcm': {'required': False},
            'is_also_customer': {'required': False},
        }

    # ── Create / update: run the party-linking after the save ───────────────
    # When is_also_customer is True:
    #   • link_to_customer_id present → link to THAT specific customer the user
    #     picked in the suggestion picker (link_existing_customer); else
    #   • auto create-or-match the counterpart (ensure_customer_for_vendor).
    # Both are idempotent + recursion-safe, so re-saves are harmless.
    def _run_customer_link(self, vendor, link_to_id):
        if not vendor.is_also_customer or vendor.linked_customer_id:
            return
        if link_to_id:
            from .models import Customer
            from .party_linking import link_existing_customer
            cust = Customer.objects.filter(
                pk=link_to_id, company=vendor.company, is_active=True).first()
            if cust is not None:
                link_existing_customer(vendor, cust)
                return
            # Chosen record vanished / wrong company — fall through to auto.
        from .party_linking import ensure_customer_for_vendor
        ensure_customer_for_vendor(vendor)

    def create(self, validated_data):
        link_to_id = validated_data.pop('link_to_customer_id', None)
        vendor = super().create(validated_data)
        self._run_customer_link(vendor, link_to_id)
        return vendor

    def update(self, instance, validated_data):
        link_to_id = validated_data.pop('link_to_customer_id', None)
        vendor = super().update(instance, validated_data)
        self._run_customer_link(vendor, link_to_id)
        return vendor

    # ── MSME payment-term caps (MSMED Act §15) ──────────────────────────────
    # Only MICRO & SMALL get the protection; MEDIUM is excluded. With a written
    # agreement the term may reach 45 days, otherwise 15.
    _MSME_PROTECTED = {'MICRO', 'SMALL'}
    _MSME_CAP_WITH_AGREEMENT = 45
    _MSME_CAP_NO_AGREEMENT = 15

    @staticmethod
    def _payment_term_days(payment_terms, custom_days):
        """Day count implied by a payment term, or None when unbounded
        ('as agreed' / blank). A legacy CUSTOM term reads custom_payment_days."""
        import re as _re
        m = _re.search(r'\d+', payment_terms or '')
        if m:
            return int(m.group())
        if custom_days:
            try:
                return int(custom_days)
            except (TypeError, ValueError):
                return None
        return None

    def _attr(self, attrs, name, default=None):
        """Incoming value for `name`, falling back to the instance on a partial
        update, then `default`."""
        if name in attrs:
            return attrs[name]
        if self.instance is not None:
            return getattr(self.instance, name, default)
        return default

    def _validate_msme(self, attrs):
        """MSME document + payment-term rules. Only fires when is_msme is on, so
        the legacy (non-MSME) create path is untouched."""
        is_msme = self._attr(attrs, 'is_msme', False)
        if not is_msme:
            return
        category = (self._attr(attrs, 'msme_category', '') or '').upper()
        if not category:
            raise serializers.ValidationError({
                'msme_category': 'Select the MSME category (Micro / Small / Medium).'
            })
        if not (self._attr(attrs, 'msme_udyam_no', '') or '').strip():
            raise serializers.ValidationError({
                'msme_udyam_no': 'Udyam / UAM registration number is required for an MSME vendor.'
            })
        if not self._attr(attrs, 'msme_certificate'):
            raise serializers.ValidationError({
                'msme_certificate': 'Upload the Udyam registration certificate for an MSME vendor.'
            })
        # A written agreement, when claimed, must carry its signed document.
        has_agreement = self._attr(attrs, 'has_written_agreement', False)
        if has_agreement and not self._attr(attrs, 'written_agreement_doc'):
            raise serializers.ValidationError({
                'written_agreement_doc': 'Upload the signed written agreement, '
                                         'or turn off "written agreement".'
            })
        # Payment-term cap — Micro & Small only (Medium is excluded by §15).
        if category in self._MSME_PROTECTED:
            cap = (self._MSME_CAP_WITH_AGREEMENT if has_agreement
                   else self._MSME_CAP_NO_AGREEMENT)
            days = self._payment_term_days(
                self._attr(attrs, 'payment_terms', ''),
                self._attr(attrs, 'custom_payment_days'))
            if days is None or days > cap:
                extra = ('with' if has_agreement else 'without')
                raise serializers.ValidationError({
                    'payment_terms': (
                        f'MSME ({category.title()}) vendor {extra} a written agreement: '
                        f'payment terms must be within {cap} days (MSMED Act §15). '
                        f'Pick a term of {cap} days or fewer'
                        + ('' if has_agreement else
                           '; add a written agreement to allow up to 45 days') + '.'
                    )
                })

    def _validate_duplicate(self, attrs):
        """Hard-block a duplicate vendor within the same company on the
        normalised name key (case / spacing / legal-suffix insensitive)."""
        name = (self._attr(attrs, 'vendor_name', '') or '').strip()
        company = self._attr(attrs, 'company')
        if not name or not company:
            return
        from .merge_utils import vkey
        key = vkey(name)
        if not key:
            return
        qs = Vendor.objects.filter(company=company, vendor_name_key=key, is_active=True)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        existing = qs.first()
        if existing:
            raise serializers.ValidationError({
                'vendor_name': (
                    f'A vendor that normalises to the same name already exists under '
                    f'this company: "{existing.vendor_name}" (code: {existing.vendor_code}). '
                    f'Use that vendor, or change the name so it is distinct.'
                )
            })

    def validate(self, attrs):
        """Enforce GSTIN uniqueness PER COMPANY (not globally). The same
        vendor GSTIN can be registered under two of our companies; only a
        clash within the SAME company is rejected. Mirrors CustomerSerializer.
        """
        company = attrs.get('company') or (self.instance.company if self.instance else None)
        gstin = (attrs.get('gstin') or (self.instance.gstin if self.instance else '') or '').strip()
        if gstin and company:
            qs = Vendor.objects.filter(gstin__iexact=gstin, company=company, is_active=True)
            if self.instance:
                qs = qs.exclude(pk=self.instance.pk)
            existing = qs.first()
            if existing:
                company_label = (getattr(company, 'company_code', None)
                                 or getattr(company, 'legal_name', None) or str(company))
                raise serializers.ValidationError({
                    'gstin': (
                        f'GSTIN "{gstin}" is already used by vendor "{existing.vendor_name}" '
                        f'(code: {existing.vendor_code}) under company "{company_label}". '
                        f'The same GSTIN can be reused under a different company.'
                    ),
                })

        # GST treatment ↔ GSTIN. A registered vendor (or one with no treatment
        # set — the default/common case) must carry a GSTIN; an Unregistered /
        # Overseas vendor must not. This is what makes GSTIN "mandatory" for
        # normal vendors while still allowing genuine unregistered suppliers.
        treatment = (attrs.get('gst_treatment') if 'gst_treatment' in attrs
                     else (self.instance.gst_treatment if self.instance else '')) or ''
        if treatment in ('UNREGISTERED', 'OVERSEAS'):
            if gstin:
                label = dict(Vendor.GST_TREATMENT_CHOICES).get(treatment, treatment)
                raise serializers.ValidationError({
                    'gst_treatment': (
                        f'{label} vendors cannot have a GSTIN — clear the GSTIN '
                        f'or change the treatment.'
                    )
                })
        elif not gstin and getattr(self, '_require_registered_gstin', True):
            # Registered / Regular, Composition, or unspecified → GSTIN required.
            # (The lenient bulk-import serializer turns this off for legacy rows.)
            raise serializers.ValidationError({
                'gstin': 'GSTIN is required for a registered vendor.'
            })
        # Hard duplicate guard + MSME compliance. Bulk import relaxes the
        # duplicate guard (legacy lists carry their own dupes to be merged
        # later) via _enforce_duplicate_guard = False.
        if getattr(self, '_enforce_duplicate_guard', True):
            self._validate_duplicate(attrs)
        self._validate_msme(attrs)
        return attrs

    # JSONField columns that arrive as a JSON STRING over multipart (the file-
    # upload path) rather than a native JSON value. DRF's JSONField does not
    # parse a plain multipart string, so we coerce them here — making the JSON
    # body and the multipart paths behave identically.
    def to_internal_value(self, data):
        import json as _json
        from django.http import QueryDict
        # A QueryDict (multipart/form POST) IS a dict subclass, so it must be
        # handled FIRST: dict(QueryDict) wraps every value in a list
        # (vendor_name -> ['x']) and CharField then rejects it as "Not a valid
        # string". .copy() keeps a mutable QueryDict whose .get() returns scalars.
        if isinstance(data, QueryDict):
            data = data.copy()
        elif isinstance(data, dict):
            data = dict(data)           # plain JSON body
        elif hasattr(data, 'copy'):
            data = data.copy()

        is_qd = isinstance(data, QueryDict)

        def _coerce(field, to_list):
            if field not in data:
                return
            raw = data.get(field)
            if to_list:
                if isinstance(raw, list):
                    value = raw
                else:
                    s = (raw or '').strip() if isinstance(raw, str) else ''
                    if s.startswith('['):
                        try:
                            value = [str(x) for x in _json.loads(s)]
                        except (ValueError, TypeError):
                            value = [s] if s else []
                    else:
                        value = [s] if s else []
            else:
                if isinstance(raw, dict):
                    value = raw
                else:
                    s = (raw or '').strip() if isinstance(raw, str) else ''
                    if not s.startswith('{'):
                        return                      # not a JSON object — leave as-is
                    try:
                        value = _json.loads(s)
                    except (ValueError, TypeError):
                        return                      # malformed — leave for DRF to flag
            # Over multipart, DRF's JSONField re-parses the field with json.loads
            # (it wraps form input as a JSON string), so hand it a JSON STRING.
            # Over a JSON body it validates with json.dumps, so hand the object.
            data[field] = _json.dumps(value) if is_qd else value

        _coerce('vendor_type', to_list=True)
        _coerce('address', to_list=False)
        return super().to_internal_value(data)


class VendorImportSerializer(VendorSerializer):
    """Lenient serializer used by the bulk-import endpoint only.

    The main `VendorSerializer` enforces GSTIN as required because the
    manual create form expects it (per user rule). Bulk imports of
    legacy vendor lists routinely contain rows without a GSTIN — the
    model field is `null=True, blank=True` precisely to support that
    case (see the field comment on `Vendor.gstin`).

    This subclass relaxes GSTIN to optional / blank so those legacy
    rows import cleanly. Every other validation (uniqueness, regex
    format, etc.) still applies because we inherit the rest of the
    Meta.extra_kwargs unchanged.
    """

    # Legacy import rows often have no GSTIN at all — don't force the
    # registered-vendor GSTIN rule on them (the manual form still does).
    _require_registered_gstin = False
    # Legacy lists carry their own duplicates — those are merged later with the
    # merge tooling, not rejected at import (which would abort the whole sheet).
    _enforce_duplicate_guard = False

    class Meta(VendorSerializer.Meta):
        extra_kwargs = {
            **VendorSerializer.Meta.extra_kwargs,
            'gstin': {'required': False, 'allow_null': True, 'allow_blank': True},
            'contact_email': {'required': False, 'allow_blank': True},
        }

    # Maps Excel-friendly vendor-type strings to the model's choice keys.
    # The legacy single 'MATERIAL' bucket now resolves to RAW_MATERIAL (the
    # data migration rewrites existing rows the same way). Anything already a
    # valid new key flows through untouched.
    _VENDOR_TYPE_ALIASES = {
        'MATERIAL':         'RAW_MATERIAL',
        'MATERIALS':        'RAW_MATERIAL',
        'RAW':              'RAW_MATERIAL',
        'RAW MATERIAL':     'RAW_MATERIAL',
        'RAW_MATERIAL':     'RAW_MATERIAL',
        'RAWMATERIAL':      'RAW_MATERIAL',
        'PACKING':          'PACKING_MATERIAL',
        'PACKING MATERIAL': 'PACKING_MATERIAL',
        'PACKING_MATERIAL': 'PACKING_MATERIAL',
        'PACKAGING':        'PACKING_MATERIAL',
        'EXPENSE':          'EXPENSE',
        'EXPENSES':         'EXPENSE',
        'CONTRACTOR':       'CONTRACTOR',
        'CONTRACT':         'CONTRACTOR',
        'LABOUR':           'CONTRACTOR',
        'LABOR':            'CONTRACTOR',
    }

    def validate_gstin(self, value):
        # Normalise empty strings to None so the unique-constraint
        # check doesn't fire on stacked '' values (NULL is excluded
        # from the unique index, '' is not on SQLite).
        if value in (None, ''):
            return None
        return value

    def to_internal_value(self, data):
        """Pre-massage the incoming row so the underlying serializer
        validation works on data the legacy Excel actually carries:

        - `vendor_type` arrives as a single string like 'Material' from
          the source sheet, but the model stores a list of choice keys
          ('MATERIAL', 'CONTRACTOR'). Strings are split on `,`/`|`/`/`,
          each piece normalised through `_VENDOR_TYPE_ALIASES`, and the
          de-duped result is set back on `data` before validation.

        - The importer mixin parses the Address cell into a dict via
          `parse_address`; we mirror its `city`/`state`/`pincode`/
          `country` keys into the standalone columns when those columns
          weren't sent explicitly. Without this, the JSON dict stayed in
          `address` and the visible City/State columns were always blank.
        """
        if isinstance(data, dict):
            data = dict(data)  # shallow-copy to avoid mutating caller's payload

            # ── vendor_type: string → list[str] of model choice keys ──
            vt = data.get('vendor_type')
            if isinstance(vt, str):
                parts = [p.strip().upper() for p in re.split(r'[,;|/]+', vt) if p.strip()]
                normalised = []
                for p in parts:
                    mapped = self._VENDOR_TYPE_ALIASES.get(p, p)
                    if mapped and mapped not in normalised:
                        normalised.append(mapped)
                data['vendor_type'] = normalised

            # ── address dict → city/state/pincode/country mirrors ────
            addr = data.get('address')
            if isinstance(addr, dict):
                for key in ('city', 'state', 'pincode', 'country'):
                    if not data.get(key) and addr.get(key):
                        data[key] = str(addr[key]).strip()

        return super().to_internal_value(data)


class VendorDetailSerializer(serializers.ModelSerializer):
    """Detailed serializer for Vendor with relationships."""

    company_name = serializers.CharField(source='company.company_code', read_only=True)
    bank_details = VendorBankDetailSerializer(many=True, read_only=True)
    preferred_transporters = serializers.StringRelatedField(many=True, read_only=True)
    allowed_warehouses = serializers.StringRelatedField(many=True, read_only=True)

    class Meta:
        model = Vendor
        fields = [
            'id', 'vendor_code', 'vendor_name', 'vendor_type', 'company',
            'company_name', 'gstin', 'pan', 'gst_treatment', 'address', 'city', 'state', 'country',
            'pincode', 'contact_person', 'contact_email', 'contact_phone',
            'payment_terms', 'custom_payment_days',
            'gst_type', 'gst', 'sgst_rate', 'cgst_rate', 'igst_rate',
            'freight_split_notes', 'credit_limit', 'credit_days', 'tds_rate',
            'tcs_rate',
            'deductee_category', 'pan_status', 'default_tds_section', 'is_206ab_specified',
            'is_msme', 'msme_category', 'msme_udyam_no', 'msme_certificate',
            'has_written_agreement', 'written_agreement_doc',
            'gstin_certificate', 'is_rcm', 'is_group',
            'gstin_verified_at', 'gstin_portal_status', 'gstin_snapshot',
            'active_flag', 'bank_details', 'preferred_transporters',
            'allowed_warehouses', 'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at', 'company_name', 'bank_details',
            'preferred_transporters', 'allowed_warehouses',
            'gstin_verified_at', 'gstin_portal_status', 'gstin_snapshot'
        ]
        extra_kwargs = {
            'gstin': {'required': True, 'allow_null': False},
            'pan': {'required': False, 'allow_blank': True},
            'address': {'required': False},
            'city': {'required': False, 'allow_blank': True},
            'state': {'required': False, 'allow_blank': True},
            'country': {'required': False, 'allow_blank': True},
            'pincode': {'required': False, 'allow_blank': True},
            'contact_person': {'required': False, 'allow_blank': True},
            'contact_email': {'required': False, 'allow_blank': True},
            'contact_phone': {'required': False, 'allow_blank': True},
            'payment_terms': {'required': False, 'allow_blank': True},
            'custom_payment_days': {'required': False, 'allow_null': True},
            'gst_type': {'required': False, 'allow_blank': True},
            'gst': {'required': False},
            'sgst_rate': {'required': False},
            'cgst_rate': {'required': False},
            'igst_rate': {'required': False},
            'freight_split_notes': {'required': False, 'allow_blank': True},
            'credit_limit': {'required': False},
            'credit_days': {'required': False},
            'tds_rate': {'required': False},
            'tcs_rate': {'required': False},
        }


class ShippingAddressSerializer(serializers.ModelSerializer):
    """Serializer for ShippingAddress."""

    price_list_name = serializers.CharField(source='default_price_list.price_list_id', read_only=True)

    class Meta:
        model = ShippingAddress
        fields = [
            'id', 'customer', 'address_label', 'address', 'delivery_region',
            'default_price_list', 'price_list_name', 'contact_person',
            'contact_phone', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'price_list_name']
        extra_kwargs = {
            'delivery_region': {'required': False, 'allow_blank': True},
            'default_price_list': {'required': False},
            'contact_person': {'required': False, 'allow_blank': True},
            'contact_phone': {'required': False, 'allow_blank': True},
        }


class ShippingAddressWriteSerializer(serializers.ModelSerializer):
    class Meta:
        model = ShippingAddress
        fields = ['address_label', 'address', 'delivery_region', 'contact_person', 'contact_phone']
        extra_kwargs = {
            'address_label': {'required': False, 'allow_blank': True},
            'delivery_region': {'required': False, 'allow_blank': True},
            'contact_person': {'required': False, 'allow_blank': True},
            'contact_phone': {'required': False, 'allow_blank': True},
        }


class CustomerSerializer(serializers.ModelSerializer):
    """Serializer for Customer model."""

    company_name = serializers.CharField(source='company.company_code', read_only=True)
    shipping_address_count = serializers.SerializerMethodField()
    shipping_addresses = ShippingAddressWriteSerializer(many=True, required=False)
    # Bulk-import convenience fields — a single address payload that
    # the importer can fill from the "Shipping Address" column, plus
    # an optional label column. On create / update they are folded
    # into the shipping_addresses list so we share the existing
    # nested-write plumbing without duplicating logic.
    shipping_address = serializers.JSONField(
        write_only=True, required=False, allow_null=True,
    )
    shipping_address_label = serializers.CharField(
        write_only=True, required=False, allow_blank=True, allow_null=True,
    )
    linked_vendor_name = serializers.SerializerMethodField()
    # Write-only: the specific Vendor the user picked in the suggestion picker.
    # When present it links to THAT record (via link_existing_vendor) instead of
    # running the auto-matcher. Never stored directly; popped in create/update.
    link_to_vendor_id = serializers.UUIDField(
        write_only=True, required=False, allow_null=True)

    def get_linked_vendor_name(self, obj):
        lv = getattr(obj, 'linked_vendor', None)
        return lv.vendor_name if lv else None

    class Meta:
        model = Customer
        fields = [
            'id', 'customer_code', 'customer_name', 'company', 'company_name',
            'gstin', 'pan', 'gst_treatment', 'billing_address', 'credit_terms', 'custom_credit_days',
            'credit_terms_effective_from',
            'freight_split_notes',
            'contact_person', 'contact_email',
            'contact_phone', 'active_flag', 'allow_multi_po_consolidation',
            'is_export', 'customer_type',
            # Also-a-vendor link. linked_vendor / its name are managed by the
            # party-linking service, so they are read-only here.
            'is_also_vendor', 'linked_vendor', 'linked_vendor_name',
            'link_to_vendor_id',
            'shipping_address_count',
            'shipping_addresses', 'shipping_address', 'shipping_address_label',
            'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at', 'company_name',
            'shipping_address_count', 'linked_vendor', 'linked_vendor_name'
        ]
        extra_kwargs = {
            # Auto-generated (CUS-###) when omitted — the form no longer asks
            # for it. Still accepted if explicitly sent (e.g. bulk import).
            'customer_code': {'required': False, 'allow_blank': True},
            'gstin': {'required': False, 'allow_null': True},
            'pan': {'required': False, 'allow_blank': True},
            'gst_treatment': {'required': False, 'allow_blank': True},
            'billing_address': {'required': False},
            'credit_terms': {'required': False, 'allow_blank': True},
            'custom_credit_days': {'required': False, 'allow_null': True},
            'credit_terms_effective_from': {'required': False, 'allow_null': True},
            'freight_split_notes': {'required': False, 'allow_blank': True},
            'contact_person': {'required': False, 'allow_blank': True},
            'contact_email': {'required': False, 'allow_blank': True},
            'contact_phone': {'required': False, 'allow_blank': True},
            'is_also_vendor': {'required': False},
        }

    def get_shipping_address_count(self, obj):
        # Read from the prefetched `shipping_addresses` cache (len of the
        # already-loaded list) rather than issuing a fresh COUNT per row.
        # On a customer LIST that COUNT was one extra round-trip PER
        # customer (a classic N+1) — on Render's ~30ms-RTT Postgres that
        # alone pushed a few-hundred-customer company past the 30s client
        # timeout. The viewset prefetches `shipping_addresses`, so this is
        # a plain in-memory len().
        return len(obj.shipping_addresses.all())

    def validate(self, attrs):
        """Enforce (company, customer_name) uniqueness — case-insensitive.

        A customer master record is keyed by the buyer's NAME within the
        seller's COMPANY. Two customers with the same name under the
        same of our companies would cause downstream PO / DC / invoice
        ambiguity ("which Greenstar did this PO go to?"). Soft-deleted
        rows are excluded so a previously-deactivated customer's slot
        can be reused.

        Implemented as serializer-level validation rather than a DB
        UNIQUE so that:
          • The check is case-insensitive without collation tricks.
          • Soft-deleted rows (is_active=False) don't block recreation.
          • The error message names BOTH the company and the customer
            so the user can act on it immediately.
        """
        # On partial-update PATCH some keys may be absent — fall back to
        # the existing instance for those.
        customer_name = (
            attrs.get('customer_name')
            or (self.instance.customer_name if self.instance else '')
        )
        company = attrs.get('company') or (self.instance.company if self.instance else None)

        if customer_name and company:
            qs = Customer.objects.filter(
                customer_name__iexact=customer_name.strip(),
                company=company,
                is_active=True,
            )
            if self.instance:
                qs = qs.exclude(pk=self.instance.pk)
            existing = qs.first()
            if existing:
                company_label = getattr(company, 'company_code', None) or getattr(company, 'legal_name', None) or str(company)
                raise serializers.ValidationError({
                    'customer_name': (
                        f'A customer named "{customer_name}" already exists under '
                        f'company "{company_label}" (code: {existing.customer_code}). '
                        f'Pick a different name or edit the existing record.'
                    ),
                })

        # GSTIN uniqueness is also PER COMPANY — the same buyer GSTIN can be
        # registered under a different one of our companies. Only enforced
        # when a GSTIN is actually provided (blank/null customers don't clash).
        gstin = (attrs.get('gstin') or (self.instance.gstin if self.instance else '') or '').strip()
        if gstin and company:
            qs = Customer.objects.filter(gstin__iexact=gstin, company=company, is_active=True)
            if self.instance:
                qs = qs.exclude(pk=self.instance.pk)
            existing = qs.first()
            if existing:
                company_label = getattr(company, 'company_code', None) or getattr(company, 'legal_name', None) or str(company)
                raise serializers.ValidationError({
                    'gstin': (
                        f'GSTIN "{gstin}" is already used by customer "{existing.customer_name}" '
                        f'(code: {existing.customer_code}) under company "{company_label}". '
                        f'The same GSTIN can be reused under a different company.'
                    ),
                })

        # GST treatment ↔ GSTIN consistency. Registered / SEZ / Deemed-Export
        # customers must carry a GSTIN; Unregistered / Consumer / Overseas must
        # not. On PATCH the key may be absent — fall back to the saved value.
        treatment = (attrs.get('gst_treatment') if 'gst_treatment' in attrs
                     else (self.instance.gst_treatment if self.instance else '')) or ''
        if treatment:
            label = dict(Customer.GST_TREATMENT_CHOICES).get(treatment, treatment)
            gstin_required = {'REGISTERED_REGULAR', 'REGISTERED_COMPOSITION', 'SEZ', 'DEEMED_EXPORT'}
            gstin_forbidden = {'UNREGISTERED', 'CONSUMER', 'OVERSEAS'}
            if treatment in gstin_required and not gstin:
                raise serializers.ValidationError({
                    'gstin': f'A GSTIN is required when the GST treatment is "{label}".'
                })
            if treatment in gstin_forbidden and gstin:
                raise serializers.ValidationError({
                    'gst_treatment': (
                        f'GST treatment "{label}" cannot have a GSTIN — clear the GSTIN '
                        f'or change the treatment.'
                    )
                })

        # 15/30/45/60 are already the named NET_ terms, so a CUSTOM value equal
        # to one of them would just duplicate a named term ("CUSTOM-30" == NET_30).
        # Reject it and point to the named term. 0 (due on bill date) and any
        # other day count remain valid custom values.
        terms = (attrs.get('credit_terms') if 'credit_terms' in attrs
                 else (self.instance.credit_terms if self.instance else '')) or ''
        if terms.upper() == 'CUSTOM':
            days = (attrs.get('custom_credit_days') if 'custom_credit_days' in attrs
                    else (self.instance.custom_credit_days if self.instance else None))
            if days is not None and int(days) in (15, 30, 45, 60):
                raise serializers.ValidationError({
                    'custom_credit_days': (
                        f'{int(days)} days is already available as NET_{int(days)} — '
                        f'select that term instead of Custom.'
                    ),
                })
        return attrs

    def _fold_shipping_address_single(self, validated_data, addrs):
        """If the bulk-import `shipping_address` (singular) field is
        populated, fold it into the `shipping_addresses` list. The
        accompanying `shipping_address_label` (also write-only) is
        used as the label; falls back to "Default" when blank. Both
        fields are popped off `validated_data` so the model doesn't
        see them. Returns the (possibly extended) list."""
        single = validated_data.pop('shipping_address', None)
        label = (validated_data.pop('shipping_address_label', '') or '').strip()
        if not single:
            return addrs
        # The importer sends a dict (parsed via parse_address). UI
        # might send a string — wrap consistently.
        if isinstance(single, str):
            payload_addr = {'full': single}
        else:
            payload_addr = single
        return list(addrs) + [{
            'address_label': label or 'Default',
            'address': payload_addr,
            'contact_person': '',
            'contact_phone': '',
        }]

    # ── Also-a-vendor linking after save ────────────────────────────────────
    # link_to_vendor_id present → link to THAT specific vendor the user picked;
    # else auto create-or-match the counterpart. Both idempotent + recursion-safe.
    def _run_vendor_link(self, customer, link_to_id):
        if not customer.is_also_vendor or customer.linked_vendor_id:
            return
        if link_to_id:
            from .models import Vendor
            from .party_linking import link_existing_vendor
            vend = Vendor.objects.filter(
                pk=link_to_id, company=customer.company, is_active=True).first()
            if vend is not None:
                link_existing_vendor(customer, vend)
                return
            # Chosen record vanished / wrong company — fall through to auto.
        from .party_linking import ensure_vendor_for_customer
        ensure_vendor_for_customer(customer)

    def create(self, validated_data):
        link_to_id = validated_data.pop('link_to_vendor_id', None)
        addrs = validated_data.pop('shipping_addresses', [])
        addrs = self._fold_shipping_address_single(validated_data, addrs)
        customer = Customer.objects.create(**validated_data)
        for addr in addrs:
            ShippingAddress.objects.create(customer=customer, **addr)
        self._run_vendor_link(customer, link_to_id)
        return customer

    def update(self, instance, validated_data):
        link_to_id = validated_data.pop('link_to_vendor_id', None)
        addrs = validated_data.pop('shipping_addresses', None)
        # On update, fold the singular field only if it carries a
        # value — preserves the "leave shipping addresses alone"
        # semantics of partial updates.
        extra_single = self._fold_shipping_address_single(validated_data, [])
        for attr, val in validated_data.items():
            setattr(instance, attr, val)
        instance.save()
        if addrs is not None:
            instance.shipping_addresses.all().delete()
            for addr in addrs:
                ShippingAddress.objects.create(customer=instance, **addr)
        # Append the bulk-import singular address (if any) without
        # nuking the existing list.
        for addr in extra_single:
            ShippingAddress.objects.create(customer=instance, **addr)
        self._run_vendor_link(instance, link_to_id)
        return instance


class CustomerDetailSerializer(serializers.ModelSerializer):
    """Detailed serializer for Customer with relationships."""

    company_name = serializers.CharField(source='company.company_code', read_only=True)
    shipping_addresses = ShippingAddressSerializer(many=True, read_only=True)
    allowed_price_lists = serializers.StringRelatedField(many=True, read_only=True)

    class Meta:
        model = Customer
        fields = [
            'id', 'customer_code', 'customer_name', 'company', 'company_name',
            'gstin', 'pan', 'gst_treatment', 'billing_address', 'credit_terms', 'custom_credit_days',
            'credit_terms_effective_from',
            'freight_split_notes',
            'contact_person', 'contact_email', 'contact_phone', 'active_flag',
            'allow_multi_po_consolidation',
            'shipping_addresses', 'allowed_price_lists',
            'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at', 'company_name',
            'shipping_addresses', 'allowed_price_lists'
        ]
        extra_kwargs = {
            'gstin': {'required': False, 'allow_null': True},
            'pan': {'required': False, 'allow_blank': True},
            'gst_treatment': {'required': False, 'allow_blank': True},
            'billing_address': {'required': False},
            'credit_terms': {'required': False, 'allow_blank': True},
            'custom_credit_days': {'required': False, 'allow_null': True},
            'credit_terms_effective_from': {'required': False, 'allow_null': True},
            'freight_split_notes': {'required': False, 'allow_blank': True},
            'contact_person': {'required': False, 'allow_blank': True},
            'contact_email': {'required': False, 'allow_blank': True},
            'contact_phone': {'required': False, 'allow_blank': True},
        }


class TransporterSerializer(serializers.ModelSerializer):
    """Serializer for Transporter model."""

    class Meta:
        model = Transporter
        fields = [
            'id', 'transporter_code', 'name', 'gstin', 'contact_person',
            'contact_email', 'contact_phone', 'active_flag',
            'bank_name', 'ifsc_code', 'beneficiary_name', 'account_no',
            'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']
        extra_kwargs = {
            'gstin': {'required': False, 'allow_null': True},
            'contact_person': {'required': False, 'allow_blank': True},
            'contact_email': {'required': False, 'allow_blank': True},
            'contact_phone': {'required': False, 'allow_blank': True},
            'bank_name': {'required': False, 'allow_blank': True},
            'ifsc_code': {'required': False, 'allow_blank': True},
            'beneficiary_name': {'required': False, 'allow_blank': True},
            'account_no': {'required': False, 'allow_blank': True},
        }


class ExpensePartySerializer(serializers.ModelSerializer):
    """Serializer for ExpenseParty master."""

    class Meta:
        model = ExpenseParty
        fields = [
            'id', 'name', 'company', 'tally_group', 'gstin',
            'active_flag', 'is_active', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']
        extra_kwargs = {
            'gstin': {'required': False, 'allow_null': True},
            'tally_group': {'required': False, 'allow_blank': True},
        }


class StateGroupSerializer(serializers.ModelSerializer):
    """Serializer for the StateGroup master."""

    specificity = serializers.IntegerField(read_only=True)

    class Meta:
        model = StateGroup
        fields = [
            'id', 'name', 'member_states', 'region', 'notes',
            'specificity', 'is_active', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'specificity']


class PriceLineSerializer(serializers.ModelSerializer):
    """Serializer for PriceLine."""

    # Expose the product's identifying fields so the customer-PO Auto
    # Extractor can fall back to SKU / trade-name lookups when the
    # Gemini-matched product UUID doesn't appear on the price list
    # (common when the customer's PO trade name resolves to a different
    # Product row than the one the price list was authored against).
    product_name = serializers.CharField(source='product.product_name', read_only=True)
    product_sku = serializers.CharField(source='product.sku_code', read_only=True)
    product_trade_name = serializers.CharField(source='product.product_trade_name', read_only=True)
    state_group_name = serializers.CharField(source='state_group.name', read_only=True)

    class Meta:
        model = PriceLine
        fields = [
            'id', 'product', 'product_name', 'product_sku', 'product_trade_name',
            'customer_trade_name',
            'uom', 'rate',
            'discount', 'gst', 'sgst_rate', 'cgst_rate', 'igst_rate',
            'freight_component', 'valid_from', 'valid_to',
            'state_group', 'state_group_name', 'packing', 'hsn_code',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at',
                            'product_name', 'product_sku', 'product_trade_name',
                            'state_group_name']
        extra_kwargs = {
            'customer_trade_name': {'required': False, 'allow_blank': True},
            'discount': {'required': False},
            'gst': {'required': False},
            'sgst_rate': {'required': False},
            'cgst_rate': {'required': False},
            'igst_rate': {'required': False},
            'freight_component': {'required': False},
            'valid_from': {'required': False},
            'valid_to': {'required': False},
            'state_group': {'required': False, 'allow_null': True},
            'packing': {'required': False, 'allow_blank': True},
            'hsn_code': {'required': False, 'allow_blank': True},
        }


class PriceListSerializer(serializers.ModelSerializer):
    """Serializer for PriceList."""

    company_name = serializers.CharField(source='company.legal_name', read_only=True)
    customer_name = serializers.CharField(source='customer.customer_name', read_only=True)
    line_count = serializers.SerializerMethodField()
    price_lines = PriceLineSerializer(many=True, required=False)

    class Meta:
        model = PriceList
        fields = [
            'id', 'price_list_id', 'company', 'company_name', 'customer',
            'customer_name', 'delivery_region', 'currency', 'effective_from',
            'effective_to', 'default_freight_terms', 'payment_terms', 'delivery_terms', 'gst_type',
            'status', 'notes',
            'price_lines', 'line_count', 'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at', 'company_name', 'customer_name', 'line_count'
        ]
        extra_kwargs = {
            'customer': {'required': False},
            'delivery_region': {'required': False, 'allow_blank': True},
            'currency': {'required': False, 'allow_blank': True},
            'effective_to': {'required': False},
            'default_freight_terms': {'required': False, 'allow_blank': True},
            'payment_terms': {'required': False, 'allow_blank': True},
            'delivery_terms': {'required': False, 'allow_blank': True},
            'gst_type': {'required': False, 'allow_blank': True},
            'status': {'required': False, 'allow_blank': True},
            'notes': {'required': False, 'allow_blank': True},
        }

    def get_line_count(self, obj):
        return obj.price_lines.count()

    def create(self, validated_data):
        lines_data = validated_data.pop('price_lines', [])
        price_list = PriceList.objects.create(**validated_data)
        for line_data in lines_data:
            line_data.pop('price_list', None)
            PriceLine.objects.create(price_list=price_list, **line_data)
        return price_list

    def update(self, instance, validated_data):
        lines_data = validated_data.pop('price_lines', None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if lines_data is not None:
            instance.price_lines.all().delete()
            for line_data in lines_data:
                line_data.pop('price_list', None)
                PriceLine.objects.create(price_list=instance, **line_data)
        return instance


class PriceListListSerializer(serializers.ModelSerializer):
    """Lightweight LIST serializer for PriceList.

    The default `PriceListSerializer` nests every child `PriceLine`
    (and each line touches product + state_group) and computes
    `line_count` with a per-row `.count()`. On the list endpoint that
    meant serializing hundreds of lines and firing one COUNT query per
    price list — the reason "price lists are not fetching" in prod
    (30s client timeout against Render's ~30ms-RTT Postgres).

    This serializer drops the nested lines entirely (the list page only
    renders header columns) and reads `line_count` from a queryset
    annotation, so listing N price lists is a couple of queries total.
    Create/update still use `PriceListSerializer` and retrieve uses
    `PriceListDetailSerializer`, both of which keep the nested lines.
    """

    company_name = serializers.CharField(source='company.legal_name', read_only=True)
    customer_name = serializers.CharField(source='customer.customer_name', read_only=True)
    # Populated by `.annotate(line_count=Count('price_lines'))` in the
    # viewset's get_queryset for the `list` action.
    line_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = PriceList
        fields = [
            'id', 'price_list_id', 'company', 'company_name', 'customer',
            'customer_name', 'delivery_region', 'currency', 'effective_from',
            'effective_to', 'default_freight_terms', 'payment_terms',
            'delivery_terms', 'gst_type', 'status', 'notes', 'line_count',
            'is_active', 'created_at', 'updated_at',
        ]
        read_only_fields = fields


class PriceListDetailSerializer(serializers.ModelSerializer):
    """Detailed serializer for PriceList with lines."""

    company_name = serializers.CharField(source='company.legal_name', read_only=True)
    customer_name = serializers.CharField(source='customer.customer_name', read_only=True)
    price_lines = PriceLineSerializer(many=True, read_only=True)

    class Meta:
        model = PriceList
        fields = [
            'id', 'price_list_id', 'company', 'company_name', 'customer',
            'customer_name', 'delivery_region', 'currency', 'effective_from',
            'effective_to', 'default_freight_terms', 'payment_terms', 'delivery_terms', 'gst_type',
            'status', 'notes',
            'price_lines', 'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at', 'company_name', 'customer_name', 'price_lines'
        ]
        extra_kwargs = {
            'customer': {'required': False},
            'delivery_region': {'required': False, 'allow_blank': True},
            'currency': {'required': False, 'allow_blank': True},
            'effective_to': {'required': False},
            'default_freight_terms': {'required': False, 'allow_blank': True},
            'payment_terms': {'required': False, 'allow_blank': True},
            'delivery_terms': {'required': False, 'allow_blank': True},
            'gst_type': {'required': False, 'allow_blank': True},
            'status': {'required': False, 'allow_blank': True},
            'notes': {'required': False, 'allow_blank': True},
        }


class TaxMasterSerializer(serializers.ModelSerializer):
    """Serializer for TaxMaster model."""

    company_name = serializers.CharField(source='company_scope.company_code', read_only=True)

    class Meta:
        model = TaxMaster
        fields = [
            'id', 'tax_type', 'section_reference', 'rate', 'effective_from',
            'effective_to', 'applicable_on', 'threshold_amount', 'company_scope',
            'company_name', 'notes', 'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'company_name']
        extra_kwargs = {
            'section_reference': {'required': False, 'allow_blank': True},
            'effective_to': {'required': False},
            'threshold_amount': {'required': False},
            'notes': {'required': False, 'allow_blank': True},
        }


class TemplateApprovalLogSerializer(serializers.ModelSerializer):
    """Serializer for TemplateApprovalLog."""

    approved_by_name = serializers.CharField(
        source='approved_by.user.get_full_name',
        read_only=True
    )

    class Meta:
        model = TemplateApprovalLog
        fields = [
            'id', 'template', 'approved_by', 'approved_by_name',
            'approval_status', 'approval_date', 'comments', 'change_summary',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'approved_by_name']
        extra_kwargs = {
            'approved_by': {'required': False},
            'approval_status': {'required': False, 'allow_blank': True},
            'approval_date': {'required': False},
            'comments': {'required': False, 'allow_blank': True},
            'change_summary': {'required': False, 'allow_blank': True},
        }


class TemplateLibrarySerializer(serializers.ModelSerializer):
    """Serializer for TemplateLibrary."""

    warehouse_scope = serializers.StringRelatedField(many=True, read_only=True)
    approval_count = serializers.SerializerMethodField()

    class Meta:
        model = TemplateLibrary
        fields = [
            'id', 'template_id', 'template_type', 'name', 'revision_no',
            'effective_from', 'effective_to', 'layout_json',
            'requires_digital_signature', 'status', 'warehouse_scope',
            'approval_count', 'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'warehouse_scope', 'approval_count']
        extra_kwargs = {
            'revision_no': {'required': False},
            'effective_to': {'required': False},
            'layout_json': {'required': False},
            'status': {'required': False, 'allow_blank': True},
        }

    def get_approval_count(self, obj):
        return obj.approval_logs.count()


class TemplateLibraryDetailSerializer(serializers.ModelSerializer):
    """Detailed serializer for TemplateLibrary with approvals."""

    warehouse_scope = serializers.StringRelatedField(many=True, read_only=True)
    approval_logs = TemplateApprovalLogSerializer(many=True, read_only=True)

    class Meta:
        model = TemplateLibrary
        fields = [
            'id', 'template_id', 'template_type', 'name', 'revision_no',
            'effective_from', 'effective_to', 'layout_json',
            'requires_digital_signature', 'status', 'warehouse_scope',
            'approval_logs', 'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at', 'warehouse_scope', 'approval_logs'
        ]
        extra_kwargs = {
            'revision_no': {'required': False},
            'effective_to': {'required': False},
            'layout_json': {'required': False},
            'status': {'required': False, 'allow_blank': True},
        }


class BrokerSerializer(serializers.ModelSerializer):
    """Serializer for Broker master."""

    broker_type_display = serializers.CharField(source='get_broker_type_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    commission_type_display = serializers.CharField(source='get_commission_type_display', read_only=True)
    preferred_vendor_names = serializers.SerializerMethodField()
    assigned_purchase_manager_name = serializers.SerializerMethodField()

    class Meta:
        model = Broker
        fields = [
            'id', 'broker_code', 'broker_name', 'broker_type', 'broker_type_display',
            'contact_person', 'status', 'status_display',
            # Contact
            'mobile_number', 'alternate_mobile', 'whatsapp_number', 'email', 'website',
            # Address
            'address_line1', 'address_line2', 'city', 'state', 'country', 'pincode',
            # Commission
            'commission_type', 'commission_type_display', 'commission_value',
            'gst_applicable', 'gst_number', 'pan_number', 'tds_applicable',
            # Banking
            'bank_account_holder', 'bank_name', 'bank_account_number',
            'bank_ifsc_code', 'bank_branch_name', 'upi_id',
            # Business linkage
            'preferred_vendors', 'preferred_vendor_names',
            'preferred_categories',
            'assigned_purchase_manager', 'assigned_purchase_manager_name',
            'operating_regions',
            # Attachments
            'gst_certificate', 'pan_copy', 'agreement',
            # Notes
            'remarks', 'internal_notes',
            # Audit
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'broker_code', 'created_at', 'updated_at']
        extra_kwargs = {
            # Nothing is hard-required except broker_name; everything else
            # is captured progressively as the user fills the form.
            'broker_type': {'required': False},
            'contact_person': {'required': False, 'allow_blank': True},
            'status': {'required': False},
            'mobile_number': {'required': False, 'allow_blank': True},
            'alternate_mobile': {'required': False, 'allow_blank': True},
            'whatsapp_number': {'required': False, 'allow_blank': True},
            'email': {'required': False, 'allow_blank': True},
            'website': {'required': False, 'allow_blank': True},
            'address_line1': {'required': False, 'allow_blank': True},
            'address_line2': {'required': False, 'allow_blank': True},
            'city': {'required': False, 'allow_blank': True},
            'state': {'required': False, 'allow_blank': True},
            'country': {'required': False, 'allow_blank': True},
            'pincode': {'required': False, 'allow_blank': True},
            'commission_type': {'required': False},
            'commission_value': {'required': False},
            'gst_number': {'required': False, 'allow_blank': True},
            'pan_number': {'required': False, 'allow_blank': True},
            'bank_account_holder': {'required': False, 'allow_blank': True},
            'bank_name': {'required': False, 'allow_blank': True},
            'bank_account_number': {'required': False, 'allow_blank': True},
            'bank_ifsc_code': {'required': False, 'allow_blank': True},
            'bank_branch_name': {'required': False, 'allow_blank': True},
            'upi_id': {'required': False, 'allow_blank': True},
            'preferred_vendors': {'required': False},
            'preferred_categories': {'required': False, 'allow_blank': True},
            'assigned_purchase_manager': {'required': False, 'allow_null': True},
            'operating_regions': {'required': False, 'allow_blank': True},
            'gst_certificate': {'required': False, 'allow_null': True},
            'pan_copy': {'required': False, 'allow_null': True},
            'agreement': {'required': False, 'allow_null': True},
            'remarks': {'required': False, 'allow_blank': True},
            'internal_notes': {'required': False, 'allow_blank': True},
        }

    def get_preferred_vendor_names(self, obj):
        return [v.vendor_name for v in obj.preferred_vendors.all()]

    def get_assigned_purchase_manager_name(self, obj):
        mgr = obj.assigned_purchase_manager
        if not mgr:
            return ''
        # StakeholderUser has either a `name` or a user FK with first/last name.
        return getattr(mgr, 'name', None) or getattr(mgr, 'full_name', None) or str(mgr)

    # ── Field-level validation ────────────────────────────────────────
    def validate_broker_name(self, value):
        if not value or not value.strip():
            raise serializers.ValidationError('Broker name is required.')
        return value.strip()

    def validate_gst_number(self, value):
        if not value:
            return value
        v = value.strip().upper()
        # 15-char Indian GSTIN — 2 digit state + 10 char PAN + 1 entity + Z + 1 check
        import re
        if not re.fullmatch(r'[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]', v):
            raise serializers.ValidationError(
                'GST Number must be a valid 15-character GSTIN.'
            )
        return v

    def validate_pan_number(self, value):
        if not value:
            return value
        v = value.strip().upper()
        import re
        if not re.fullmatch(r'[A-Z]{5}[0-9]{4}[A-Z]', v):
            raise serializers.ValidationError(
                'PAN Number must be 10 characters (5 letters + 4 digits + 1 letter).'
            )
        return v

    def validate_commission_value(self, value):
        if value is None:
            return value
        if value < 0:
            raise serializers.ValidationError('Commission value cannot be negative.')
        return value

    def validate_mobile_number(self, value):
        if not value:
            return value
        import re
        stripped = re.sub(r'[\s\-()+]', '', value)
        if not stripped.isdigit() or not (6 <= len(stripped) <= 15):
            raise serializers.ValidationError('Mobile number must be 6-15 digits.')
        return value


# ── Machinery Division ────────────────────────────────────────────────
class MachineryDivisionSerializer(serializers.ModelSerializer):
    """FK + `*_name` companion fields so the edit form can show the
    saved labels while useLookup is still fetching."""

    company_name   = serializers.CharField(source='company.legal_name', read_only=True, default='')
    warehouse_name = serializers.CharField(source='warehouse.name',     read_only=True, default='')
    godown_name    = serializers.CharField(source='godown.godown_name', read_only=True, default='')

    class Meta:
        model = MachineryDivision
        fields = [
            'id', 'name',
            'company',   'company_name',
            'warehouse', 'warehouse_name',
            'godown',    'godown_name',
            'notes', 'active_flag', 'is_active',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at',
            'company_name', 'warehouse_name', 'godown_name',
        ]
        extra_kwargs = {
            'godown': {'required': False, 'allow_null': True},
            'notes': {'required': False, 'allow_blank': True},
        }

    def validate(self, attrs):
        company   = attrs.get('company')   or getattr(self.instance, 'company',   None)
        warehouse = attrs.get('warehouse') or getattr(self.instance, 'warehouse', None)
        godown    = attrs.get('godown')    or getattr(self.instance, 'godown',    None)
        if warehouse and company and warehouse.company_id != company.id:
            raise serializers.ValidationError({'warehouse': 'Warehouse must belong to the selected Company.'})
        if godown and warehouse and godown.warehouse_id != warehouse.id:
            raise serializers.ValidationError({'godown': 'Godown must belong to the selected Warehouse.'})
        return attrs


# ── Machinery Expense ─────────────────────────────────────────────────
class MachineryExpenseSerializer(serializers.ModelSerializer):
    """`category` is a single FK to ExpenseCategory (one dropdown on
    the form). `category_name` is the read-only mirror used by the
    edit page to paint the dropdown label before the lookup endpoint
    finishes."""

    company_name   = serializers.CharField(source='company.legal_name', read_only=True, default='')
    warehouse_name = serializers.CharField(source='warehouse.name',     read_only=True, default='')
    category_name  = serializers.CharField(source='category.name',      read_only=True, default='')

    class Meta:
        model = MachineryExpense
        fields = [
            'id', 'name',
            'company',   'company_name',
            'warehouse', 'warehouse_name',
            'category',  'category_name',
            'notes', 'active_flag', 'is_active',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at',
            'company_name', 'warehouse_name', 'category_name',
        ]
        extra_kwargs = {
            'category': {'required': False, 'allow_null': True},
            'notes':    {'required': False, 'allow_blank': True},
        }

    def validate(self, attrs):
        company   = attrs.get('company')   or getattr(self.instance, 'company',   None)
        warehouse = attrs.get('warehouse') or getattr(self.instance, 'warehouse', None)
        if warehouse and company and warehouse.company_id != company.id:
            raise serializers.ValidationError({'warehouse': 'Warehouse must belong to the selected Company.'})
        return attrs


# ── Expense Category ──────────────────────────────────────────────────
class ExpenseCategorySerializer(serializers.ModelSerializer):
    """Read-mostly serializer for the ExpenseCategory list endpoint.

    The matching viewset is read-only for non-superusers; categories
    are curated in the Django admin panel."""

    class Meta:
        model = ExpenseCategory
        fields = ['id', 'name', 'description', 'active_flag', 'is_active',
                  'created_at', 'updated_at']
        read_only_fields = ['id', 'created_at', 'updated_at']


class MasterAttachmentSerializer(serializers.ModelSerializer):
    """File attachments (images / documents) for master records."""
    uploaded_by_name = serializers.CharField(
        source='uploaded_by.get_full_name', read_only=True, default=''
    )

    class Meta:
        model = MasterAttachment
        fields = [
            'id', 'module', 'record_id', 'file', 'file_name',
            'file_size', 'file_type', 'uploaded_by', 'uploaded_by_name',
            'created_at',
        ]
        read_only_fields = ['id', 'file_name', 'file_size', 'file_type',
                            'uploaded_by', 'uploaded_by_name', 'created_at']



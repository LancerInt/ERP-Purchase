"""
Serializers for core app models.
"""
from rest_framework import serializers
from django.contrib.auth.models import User
from .models import (
    Company, Warehouse, Godown, RoleDefinition,
    ApprovalLevel, StakeholderUser
)


class CompanySerializer(serializers.ModelSerializer):
    """Serializer for Company model."""

    class Meta:
        model = Company
        fields = [
            'id', 'company_code', 'legal_name', 'trade_name', 'tally_company_name',
            'gstin', 'pan', 'cin',
            'msme_no', 'msme_name', 'is_msme', 'msme_category', 'msme_certificate',
            'registered_address', 'billing_address', 'contact_email', 'contact_phone',
            'geo_latitude', 'geo_longitude',
            'default_currency', 'books_export_flag', 'active_from', 'active_to',
            'notes', 'is_active', 'created_at', 'updated_at', 'created_by', 'updated_by'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'created_by', 'updated_by']
        extra_kwargs = {
            'pan': {'required': False, 'allow_blank': True},
            'cin': {'required': False, 'allow_blank': True},
            'msme_no': {'required': False, 'allow_blank': True},
            'msme_name': {'required': False, 'allow_blank': True},
            'is_msme': {'required': False},
            'msme_category': {'required': False, 'allow_blank': True},
            'msme_certificate': {'required': False, 'allow_null': True},
            'trade_name': {'required': False, 'allow_blank': True},
            'gstin': {'required': False, 'allow_null': True},
            'contact_email': {'required': False, 'allow_blank': True},
            'contact_phone': {'required': False, 'allow_blank': True},
            'registered_address': {'required': False},
            'billing_address': {'required': False},
            'active_from': {'required': False},
            'active_to': {'required': False},
            'notes': {'required': False, 'allow_blank': True},
            'geo_latitude': {'required': False, 'allow_null': True},
            'geo_longitude': {'required': False, 'allow_null': True},
        }


class GodownSerializer(serializers.ModelSerializer):
    """Serializer for Godown model."""

    warehouse_name = serializers.CharField(source='warehouse.name', read_only=True)
    # Derived parent-company FK exposed read-only so the edit form can
    # pre-select the Company dropdown (which in turn loads the
    # warehouse list) without needing a second API hit to the
    # warehouse detail endpoint. Without this the Edit Godown page
    # opens with empty Company + Warehouse selects even though the
    # godown clearly has a warehouse on file.
    warehouse_company = serializers.PrimaryKeyRelatedField(
        source='warehouse.company', read_only=True,
    )
    # Human-readable parent-company name for the godown LIST page,
    # which would otherwise have to render the UUID or do per-row
    # lookups. Falls back through legal_name → trade_name →
    # company_code so we always emit something useful regardless of
    # which name fields the company master fills.
    warehouse_company_name = serializers.SerializerMethodField()

    def get_warehouse_company_name(self, obj):
        c = getattr(obj.warehouse, 'company', None) if obj.warehouse_id else None
        if not c:
            return ''
        return getattr(c, 'legal_name', '') or getattr(c, 'trade_name', '') \
            or getattr(c, 'company_code', '') or ''

    class Meta:
        model = Godown
        fields = [
            'id', 'godown_code', 'warehouse', 'warehouse_name',
            'warehouse_company', 'warehouse_company_name',
            'godown_name',
            'storage_condition', 'capacity_uom', 'capacity_value',
            'batch_tracking_enabled', 'default_qc_hold_area', 'active_flag',
            'notes', 'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at',
            'warehouse_company', 'warehouse_company_name',
        ]
        extra_kwargs = {
            'storage_condition': {'required': False, 'allow_blank': True},
            'capacity_uom': {'required': False, 'allow_blank': True},
            'capacity_value': {'required': False},
            'notes': {'required': False, 'allow_blank': True},
        }


class ApprovalLevelSerializer(serializers.ModelSerializer):
    """Serializer for ApprovalLevel model."""

    class Meta:
        model = ApprovalLevel
        fields = [
            'id', 'role', 'module', 'stage', 'min_amount', 'max_amount',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']
        extra_kwargs = {
            'min_amount': {'required': False},
            'max_amount': {'required': False},
        }


class RoleDefinitionSerializer(serializers.ModelSerializer):
    """Serializer for RoleDefinition with nested ApprovalLevels."""

    approval_levels = ApprovalLevelSerializer(many=True, read_only=True)

    class Meta:
        model = RoleDefinition
        fields = [
            'id', 'role_code', 'role_name', 'module_permissions', 'data_scope',
            'active_flag', 'approval_levels', 'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']
        extra_kwargs = {
            'module_permissions': {'required': False},
            'data_scope': {'required': False, 'allow_blank': True},
        }


class RoleDefinitionWriteSerializer(serializers.ModelSerializer):
    """Serializer for creating/updating RoleDefinition with nested writes."""

    approval_levels = ApprovalLevelSerializer(many=True, required=False)

    class Meta:
        model = RoleDefinition
        fields = [
            'id', 'role_code', 'role_name', 'module_permissions', 'data_scope',
            'active_flag', 'approval_levels'
        ]
        extra_kwargs = {
            'module_permissions': {'required': False},
            'data_scope': {'required': False, 'allow_blank': True},
        }

    def create(self, validated_data):
        approval_levels_data = validated_data.pop('approval_levels', [])
        role = RoleDefinition.objects.create(**validated_data)

        for level_data in approval_levels_data:
            ApprovalLevel.objects.create(role=role, **level_data)

        return role

    def update(self, instance, validated_data):
        approval_levels_data = validated_data.pop('approval_levels', None)

        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        if approval_levels_data is not None:
            instance.approval_levels.all().delete()
            for level_data in approval_levels_data:
                ApprovalLevel.objects.create(role=instance, **level_data)

        return instance


class WarehouseSerializer(serializers.ModelSerializer):
    """Serializer for Warehouse model."""

    company_name = serializers.CharField(source='company.legal_name', read_only=True)
    warehouse_managers_count = serializers.SerializerMethodField()
    godowns_count = serializers.SerializerMethodField()

    class Meta:
        model = Warehouse
        fields = [
            'id', 'warehouse_code', 'company', 'company_name', 'name', 'warehouse_type',
            'address', 'city', 'state', 'country', 'pincode', 'geo_latitude',
            'geo_longitude', 'time_zone', 'default_currency', 'active_flag', 'notes',
            'warehouse_coordinator_office', 'warehouse_hr_coordinator',
            'warehouse_managers_count', 'godowns_count',
            'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'warehouse_managers_count', 'godowns_count']
        extra_kwargs = {
            'warehouse_type': {'required': False, 'allow_blank': True},
            'address': {'required': False},
            'city': {'required': False, 'allow_blank': True},
            'state': {'required': False, 'allow_blank': True},
            'country': {'required': False, 'allow_blank': True},
            'pincode': {'required': False, 'allow_blank': True},
            'geo_latitude': {'required': False},
            'geo_longitude': {'required': False},
            'time_zone': {'required': False, 'allow_blank': True},
            'default_currency': {'required': False, 'allow_blank': True},
            'notes': {'required': False, 'allow_blank': True},
            'warehouse_coordinator_office': {'required': False},
            'warehouse_hr_coordinator': {'required': False},
        }

    def get_warehouse_managers_count(self, obj):
        return obj.warehouse_managers.count()

    def get_godowns_count(self, obj):
        return obj.godowns.count()

    def validate(self, attrs):
        attrs = super().validate(attrs)
        name = (attrs.get('name') or (self.instance.name if self.instance else '') or '').strip()
        company = attrs.get('company') or (self.instance.company if self.instance else None)
        if name and company:
            qs = Warehouse.objects.filter(company=company, name__iexact=name)
            if self.instance:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise serializers.ValidationError(
                    {'name': 'A warehouse with this name already exists in this company.'})
        return attrs


class WarehouseDetailSerializer(serializers.ModelSerializer):
    """Detailed serializer for Warehouse with related data."""

    company_name = serializers.CharField(source='company.legal_name', read_only=True)
    godowns = GodownSerializer(many=True, read_only=True)
    warehouse_managers = serializers.StringRelatedField(many=True, read_only=True)
    warehouse_coordinators = serializers.StringRelatedField(many=True, read_only=True)
    warehouse_supervisors = serializers.StringRelatedField(many=True, read_only=True)

    class Meta:
        model = Warehouse
        fields = [
            'id', 'warehouse_code', 'company', 'company_name', 'name', 'warehouse_type',
            'address', 'city', 'state', 'country', 'pincode', 'geo_latitude',
            'geo_longitude', 'time_zone', 'default_currency', 'active_flag', 'notes',
            'warehouse_coordinator_office', 'warehouse_hr_coordinator',
            'godowns', 'warehouse_managers', 'warehouse_coordinators',
            'warehouse_supervisors', 'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'godowns']
        extra_kwargs = {
            'warehouse_type': {'required': False, 'allow_blank': True},
            'address': {'required': False},
            'city': {'required': False, 'allow_blank': True},
            'state': {'required': False, 'allow_blank': True},
            'country': {'required': False, 'allow_blank': True},
            'pincode': {'required': False, 'allow_blank': True},
            'geo_latitude': {'required': False},
            'geo_longitude': {'required': False},
            'time_zone': {'required': False, 'allow_blank': True},
            'default_currency': {'required': False, 'allow_blank': True},
            'notes': {'required': False, 'allow_blank': True},
            'warehouse_coordinator_office': {'required': False},
            'warehouse_hr_coordinator': {'required': False},
        }


class StakeholderUserSerializer(serializers.ModelSerializer):
    """Serializer for StakeholderUser model."""

    username = serializers.CharField(source='user.username', read_only=True)
    full_name = serializers.CharField(source='user.get_full_name', read_only=True)
    # Flattened user attributes so the admin Data Permissions tab can
    # display first_name / last_name / email without making a second
    # request. Kept alongside the existing FK `user` field — the FK
    # still serializes as the PK for write paths.
    user_first_name = serializers.CharField(source='user.first_name', read_only=True, default='')
    user_last_name = serializers.CharField(source='user.last_name', read_only=True, default='')
    user_email = serializers.EmailField(source='user.email', read_only=True, default='')
    assigned_roles_data = serializers.StringRelatedField(
        source='assigned_roles',
        many=True,
        read_only=True
    )
    warehouse_count = serializers.SerializerMethodField()
    # Warehouse IDs in the user's scope. Powering the Data Permissions
    # tab's pre-ticked checkboxes — without this the UI always rendered
    # "No scope → sees all" regardless of what had been saved, because
    # the list endpoint never sent this field.
    warehouse_scope = serializers.PrimaryKeyRelatedField(
        many=True, read_only=True
    )

    class Meta:
        model = StakeholderUser
        fields = [
            'id', 'user', 'username', 'full_name',
            'user_first_name', 'user_last_name', 'user_email',
            'employee_record', 'primary_email',
            'mobile', 'default_warehouse', 'status', 'last_accessed', 'notes',
            'assigned_roles_data', 'warehouse_count', 'warehouse_scope',
            'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at', 'username', 'full_name',
            'user_first_name', 'user_last_name', 'user_email',
            'warehouse_count', 'warehouse_scope',
        ]
        extra_kwargs = {
            'employee_record': {'required': False},
            'primary_email': {'required': False, 'allow_blank': True},
            'mobile': {'required': False, 'allow_blank': True},
            'default_warehouse': {'required': False},
            'status': {'required': False, 'allow_blank': True},
            'last_accessed': {'required': False},
            'notes': {'required': False, 'allow_blank': True},
        }

    def get_warehouse_count(self, obj):
        return obj.warehouse_scope.count()


class StakeholderUserDetailSerializer(serializers.ModelSerializer):
    """Detailed serializer for StakeholderUser with related data."""

    username = serializers.CharField(source='user.username', read_only=True)
    full_name = serializers.CharField(source='user.get_full_name', read_only=True)
    email = serializers.CharField(source='user.email', read_only=True)
    assigned_roles = RoleDefinitionSerializer(many=True, read_only=True)
    warehouse_scope = WarehouseSerializer(many=True, read_only=True)

    class Meta:
        model = StakeholderUser
        fields = [
            'id', 'user', 'username', 'full_name', 'email', 'employee_record',
            'primary_email', 'mobile', 'default_warehouse', 'status', 'last_accessed',
            'notes', 'assigned_roles', 'warehouse_scope',
            'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']
        extra_kwargs = {
            'employee_record': {'required': False},
            'primary_email': {'required': False, 'allow_blank': True},
            'mobile': {'required': False, 'allow_blank': True},
            'default_warehouse': {'required': False},
            'status': {'required': False, 'allow_blank': True},
            'last_accessed': {'required': False},
            'notes': {'required': False, 'allow_blank': True},
        }

"""HR serializers (standalone) — Staff and its child records."""
from rest_framework import serializers

from .models import Staff, StaffBankAccount, StaffIDProof


class StaffBankAccountSerializer(serializers.ModelSerializer):
    class Meta:
        model = StaffBankAccount
        fields = [
            'id', 'staff', 'account_holder', 'bank_name', 'ifsc_code',
            'account_number', 'account_type',
        ]
        read_only_fields = ['id']


class StaffIDProofSerializer(serializers.ModelSerializer):
    document_type_display = serializers.CharField(
        source='get_document_type_display', read_only=True)

    class Meta:
        model = StaffIDProof
        fields = [
            'id', 'staff', 'document_type', 'document_type_display',
            'document_number', 'expiry_date', 'attachment',
        ]
        read_only_fields = ['id']


class StaffSerializer(serializers.ModelSerializer):
    full_name = serializers.CharField(read_only=True)
    staff_type_display = serializers.CharField(source='get_staff_type_display', read_only=True)
    employment_status_display = serializers.CharField(source='get_employment_status_display', read_only=True)
    company_name = serializers.CharField(source='company.legal_name', read_only=True, default='')
    location_name = serializers.CharField(source='primary_location.name', read_only=True, default='')
    bank_account = StaffBankAccountSerializer(read_only=True)
    id_proofs = StaffIDProofSerializer(many=True, read_only=True)

    class Meta:
        model = Staff
        fields = [
            'id', 'staff_id', 'first_name', 'last_name', 'full_name',
            'staff_type', 'staff_type_display', 'gender', 'date_of_birth',
            'company', 'company_name', 'company_ids',
            'primary_location', 'location_name', 'location_ids',
            'default_godown', 'godown_ids',
            'designation', 'department',
            'employment_status', 'employment_status_display',
            'employment_start_date', 'employment_end_date',
            'overtime_eligible', 'contractor_flag', 'contractor_vendor',
            'salary_per_day',
            'contact_number', 'email', 'emergency_contact', 'address',
            'photo_reference', 'remarks', 'is_active',
            'bank_account', 'id_proofs',
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'staff_id': {'required': False, 'allow_blank': True},
            'first_name': {'required': True},
            'last_name': {'required': True},
            'company': {'required': True},
            'primary_location': {'required': True},
            'employment_status': {'required': False, 'allow_blank': True},
        }

    def create(self, validated_data):
        # Auto-assign a staff_id if the caller left it blank.
        if not validated_data.get('staff_id'):
            n = Staff.objects.count() + 1
            validated_data['staff_id'] = f'STF-{n:05d}'
        if not validated_data.get('employment_status'):
            validated_data['employment_status'] = 'ACTIVE'
        return super().create(validated_data)

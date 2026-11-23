"""Bank serializers (standalone)."""
from rest_framework import serializers

from .models import BankAccount, BankStatementUpload, BankStatementLine


class BankAccountSerializer(serializers.ModelSerializer):
    class Meta:
        model = BankAccount
        fields = ['id', 'code', 'nickname', 'bank_name', 'account_number', 'company', 'is_active']
        read_only_fields = ['id']


class BankStatementLineSerializer(serializers.ModelSerializer):
    recorded = serializers.SerializerMethodField()

    class Meta:
        model = BankStatementLine
        fields = [
            'id', 'line_no', 'txn_date', 'narration', 'reference_no',
            'debit', 'credit', 'balance', 'matched_vendor_payment', 'recorded',
        ]
        read_only_fields = ['id']

    def get_recorded(self, obj):
        return obj.matched_vendor_payment_id is not None


class BankStatementUploadSerializer(serializers.ModelSerializer):
    bank_account_name = serializers.CharField(source='bank_account.nickname', read_only=True, default='')
    company_name = serializers.CharField(source='company.legal_name', read_only=True, default='')
    lines = BankStatementLineSerializer(many=True, read_only=True)

    class Meta:
        model = BankStatementUpload
        fields = [
            'id', 'bank_account', 'bank_account_name', 'company', 'company_name',
            'file_name', 'parsing_status', 'parse_error', 'line_count',
            'remarks', 'created_at', 'lines',
        ]
        read_only_fields = ['id', 'parsing_status', 'parse_error', 'line_count', 'created_at']


class BankStatementUploadListSerializer(BankStatementUploadSerializer):
    """List view without the (potentially large) lines array."""
    class Meta(BankStatementUploadSerializer.Meta):
        fields = [f for f in BankStatementUploadSerializer.Meta.fields if f != 'lines']

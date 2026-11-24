from rest_framework import serializers
from .models import EmailTemplate, EmailLog


class EmailTemplateSerializer(serializers.ModelSerializer):
    class Meta:
        model = EmailTemplate
        fields = [
            'id', 'name', 'subject', 'body_html',
            'pdf_header_html', 'pdf_body_html', 'pdf_footer_html',
            'is_default', 'is_active',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']
        extra_kwargs = {
            'is_active': {'required': False, 'default': True},
        }


class EmailLogSerializer(serializers.ModelSerializer):
    vendor_name = serializers.CharField(source='vendor.vendor_name', read_only=True, default='')
    template_name = serializers.CharField(source='template.name', read_only=True, default='')
    rfq_no = serializers.CharField(source='rfq.rfq_no', read_only=True, default='')

    class Meta:
        model = EmailLog
        fields = [
            'id', 'rfq', 'po', 'template', 'template_name',
            'vendor', 'vendor_name', 'rfq_no',
            'to_email', 'subject', 'body_html',
            'status', 'sent_at',
            'created_at',
        ]
        read_only_fields = fields

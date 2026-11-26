from rest_framework import serializers
from .models import StockDeclaration


class StockDeclarationSerializer(serializers.ModelSerializer):
    created_by_name = serializers.SerializerMethodField()
    approved_by_name = serializers.SerializerMethodField()
    product_sku = serializers.SerializerMethodField()
    warehouse_name = serializers.SerializerMethodField()
    godown_name = serializers.SerializerMethodField()

    class Meta:
        model = StockDeclaration
        fields = [
            'id', 'product', 'is_new_product', 'product_name',
            'specification', 'quantity', 'uom', 'warehouse', 'godown',
            'approval_status', 'approved_by', 'approved_by_name',
            'approved_at', 'admin_remarks',
            'created_by', 'created_by_name', 'product_sku',
            'warehouse_name', 'godown_name', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'approval_status', 'approved_by', 'approved_at',
            'created_by', 'created_at', 'updated_at',
        ]

    def get_created_by_name(self, obj):
        u = obj.created_by
        if u:
            return u.get_full_name() or u.username
        return ''

    def get_approved_by_name(self, obj):
        u = obj.approved_by
        if u:
            return u.get_full_name() or u.username
        return ''

    def get_product_sku(self, obj):
        if obj.product:
            return obj.product.sku_code
        return ''

    def get_warehouse_name(self, obj):
        if obj.warehouse:
            return obj.warehouse.name
        return ''

    def get_godown_name(self, obj):
        if obj.godown:
            return obj.godown.godown_name
        return ''

    def create(self, validated_data):
        validated_data['created_by'] = self.context['request'].user
        if validated_data.get('product'):
            validated_data['is_new_product'] = False
            validated_data['product_name'] = validated_data['product'].product_name
        else:
            validated_data['is_new_product'] = True
        return super().create(validated_data)

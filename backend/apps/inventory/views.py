from datetime import date

from django.utils import timezone
from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import StockDeclaration, OpeningStock
from .serializers import StockDeclarationSerializer


class StockDeclarationViewSet(viewsets.ModelViewSet):
    serializer_class = StockDeclarationSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        qs = StockDeclaration.objects.filter(is_active=True).select_related(
            'product', 'warehouse', 'godown', 'created_by', 'approved_by',
        )
        st = self.request.query_params.get('status')
        if st:
            qs = qs.filter(approval_status=st.upper())
        return qs

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        decl = self.get_object()
        if decl.approval_status != 'PENDING':
            return Response(
                {'error': f'Cannot approve — status is {decl.approval_status}.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        product = decl.product
        if decl.is_new_product and not product:
            from master.models import Product
            from master.serializers import ProductSerializer
            ctx = {'request': request}
            prod_data = {
                'product_name': decl.product_name,
                'description': decl.specification,
                'product_type': 'GOODS',
                'goods_sub_type': 'RAW_MATERIAL',
                'uom': decl.uom,
            }
            if decl.warehouse:
                prod_data['warehouse'] = decl.warehouse.pk
            ser = ProductSerializer(data=prod_data, context=ctx)
            ser.is_valid(raise_exception=True)
            product = ser.save(created_by=request.user)
            decl.product = product

        if product:
            OpeningStock.objects.update_or_create(
                product=product,
                warehouse=decl.warehouse,
                defaults={
                    'as_of_date': date.today(),
                    'quantity': decl.quantity,
                    'uom': decl.uom,
                    'created_by': request.user,
                },
            )

        decl.approval_status = 'APPROVED'
        decl.approved_by = request.user
        decl.approved_at = timezone.now()
        decl.admin_remarks = request.data.get('admin_remarks', decl.admin_remarks)
        decl.save()

        return Response(StockDeclarationSerializer(decl).data)

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        decl = self.get_object()
        if decl.approval_status != 'PENDING':
            return Response(
                {'error': f'Cannot reject — status is {decl.approval_status}.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        decl.approval_status = 'REJECTED'
        decl.approved_by = request.user
        decl.approved_at = timezone.now()
        decl.admin_remarks = request.data.get('admin_remarks', '')
        decl.save()

        return Response(StockDeclarationSerializer(decl).data)

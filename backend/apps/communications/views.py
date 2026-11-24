import datetime

from django.db.models import Q
from django.utils import timezone
from rest_framework import viewsets, status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import EmailTemplate, EmailLog
from .serializers import EmailTemplateSerializer, EmailLogSerializer


class EmailTemplateViewSet(viewsets.ModelViewSet):
    queryset = EmailTemplate.objects.filter(is_active=True)
    serializer_class = EmailTemplateSerializer
    permission_classes = [IsAuthenticated]

    @action(detail=True, methods=['post'])
    def preview(self, request, pk=None):
        template = self.get_object()
        context = {
            'company_name': request.data.get('company_name', 'SS Biochem India Pvt Ltd'),
            'company_address': request.data.get('company_address', 'Salem, Tamil Nadu'),
            'vendor_name': request.data.get('vendor_name', 'Sample Vendor'),
            'vendor_email': request.data.get('vendor_email', 'vendor@example.com'),
            'rfq_number': request.data.get('rfq_number', 'RFQ-2026-0001'),
            'date': request.data.get('date', datetime.date.today().strftime('%d-%b-%Y')),
            'notes': request.data.get('notes', ''),
            'product_table': request.data.get('product_table', '<table><tr><th>Product</th><th>Qty</th><th>UOM</th></tr><tr><td>Sample Product</td><td>100</td><td>KG</td></tr></table>'),
        }
        html = template.body_html
        for key, val in context.items():
            html = html.replace('{{' + key + '}}', str(val))
        subject = template.subject
        for key, val in context.items():
            subject = subject.replace('{{' + key + '}}', str(val))
        return Response({'subject': subject, 'body_html': html})


class EmailLogViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = EmailLogSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        qs = EmailLog.objects.select_related('vendor', 'template', 'rfq')
        rfq = self.request.query_params.get('rfq')
        po = self.request.query_params.get('po')
        if rfq:
            qs = qs.filter(rfq_id=rfq)
        if po:
            qs = qs.filter(po_id=po)
        return qs


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def email_suggestions(request):
    q = request.query_params.get('q', '').strip()
    limit = int(request.query_params.get('limit', 8))
    if len(q) < 2:
        return Response([])

    from master.models import Vendor, Customer
    results = []
    for v in Vendor.objects.filter(
        Q(contact_email__icontains=q) | Q(vendor_name__icontains=q),
        is_active=True,
    ).exclude(contact_email='')[:limit]:
        results.append({
            'email': v.contact_email,
            'name': v.vendor_name,
            'type': 'vendor',
        })
    for c in Customer.objects.filter(
        Q(contact_email__icontains=q) | Q(customer_name__icontains=q),
        is_active=True,
    ).exclude(contact_email='')[:limit]:
        results.append({
            'email': c.contact_email,
            'name': c.customer_name,
            'type': 'customer',
        })
    return Response(results[:limit])


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def send_rfq_emails(request):
    rfq_id = request.data.get('rfq_id')
    template_id = request.data.get('template_id')
    vendor_ids = request.data.get('vendor_ids', [])

    if not rfq_id or not template_id or not vendor_ids:
        return Response(
            {'error': 'rfq_id, template_id, and vendor_ids are required'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    from purchase.models import RFQHeader
    from master.models import Vendor

    try:
        rfq = RFQHeader.objects.get(pk=rfq_id)
    except RFQHeader.DoesNotExist:
        return Response({'error': 'RFQ not found'}, status=status.HTTP_404_NOT_FOUND)

    try:
        template = EmailTemplate.objects.get(pk=template_id)
    except EmailTemplate.DoesNotExist:
        return Response({'error': 'Template not found'}, status=status.HTTP_404_NOT_FOUND)

    vendors = Vendor.objects.filter(pk__in=vendor_ids)
    sent = []
    for vendor in vendors:
        context = {
            'company_name': rfq.company_name if hasattr(rfq, 'company_name') else '',
            'vendor_name': vendor.vendor_name,
            'vendor_email': vendor.contact_email,
            'rfq_number': rfq.rfq_no,
            'date': timezone.now().strftime('%d-%b-%Y'),
            'notes': '',
            'product_table': '',
        }
        subject = template.subject
        body = template.body_html
        for key, val in context.items():
            subject = subject.replace('{{' + key + '}}', str(val))
            body = body.replace('{{' + key + '}}', str(val))

        EmailLog.objects.create(
            rfq=rfq,
            template=template,
            vendor=vendor,
            to_email=vendor.contact_email or 'no-email@example.com',
            subject=subject,
            body_html=body,
            status='SENT',
            created_by=request.user,
        )
        sent.append(vendor.vendor_name)

    return Response({
        'message': f'RFQ emails sent to {len(sent)} vendor(s)',
        'vendors': sent,
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def resolved_sender(request):
    return Response({
        'email': 'purchase@company.com',
        'name': 'Purchase Department',
        'is_configured': True,
    })

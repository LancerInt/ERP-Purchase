"""Local Freight — standalone freight / charges billing (no receipt or DC link).

Mirrors the legacy 'Local Freight' Zoho form: ad-hoc freight, stock-transfer,
unloading and in/out charges keyed in directly against a company + factory.
"""
from datetime import datetime

from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from rbac.permissions import HasModulePermission

from .models import LocalFreight, LocalFreightPayment


def _looks_uuid(s):
    return isinstance(s, str) and len(s) == 36 and s.count('-') == 4


def generate_local_freight_no():
    """LF-<counter>-<year>.

    Counts ALL rows for the year, not just active ones: freight_no carries a
    DB-level unique constraint that spans soft-deleted rows too, so excluding
    is_active=False here would regenerate a number still physically present
    (e.g. after the top-numbered bill is soft-deleted) and collide on create.
    """
    prefix, year = 'LF', datetime.now().year
    sp, ss = f'{prefix}-', f'-{year}'
    existing = (LocalFreight.objects
                .filter(freight_no__startswith=sp, freight_no__endswith=ss)
                .values_list('freight_no', flat=True))
    mx = 0
    for n in existing:
        try:
            mx = max(mx, int(n.replace(sp, '').replace(ss, '').strip('-')))
        except (ValueError, TypeError):
            continue
    return f'{prefix}-{mx + 1:04d}-{year}'


def generate_local_freight_payment_no():
    """LFP-<counter>-<year> voucher number for a local-freight payment."""
    prefix, year = 'LFP', datetime.now().year
    sp, ss = f'{prefix}-', f'-{year}'
    existing = (LocalFreightPayment.objects
                .filter(payment_no__startswith=sp, payment_no__endswith=ss)
                .values_list('payment_no', flat=True))
    mx = 0
    for n in existing:
        try:
            mx = max(mx, int(n.replace(sp, '').replace(ss, '').strip('-')))
        except (ValueError, TypeError):
            continue
    return f'{prefix}-{mx + 1:04d}-{year}'


class LocalFreightPaymentSerializer(serializers.ModelSerializer):
    class Meta:
        model = LocalFreightPayment
        fields = ['id', 'payment_no', 'local_freight', 'payment_date', 'amount_paid', 'payment_mode',
                  'paid_to', 'reference_no', 'notes', 'created_at']
        read_only_fields = ['id', 'payment_no', 'local_freight', 'created_at']


class LocalFreightSerializer(serializers.ModelSerializer):
    company_name = serializers.CharField(source='company.legal_name', read_only=True, default='')
    factory_name = serializers.CharField(source='factory.name', read_only=True, default='')
    transporter_name = serializers.CharField(source='transporter.name', read_only=True, default='')
    freight_type_display = serializers.CharField(source='get_freight_type_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    payable_amount = serializers.SerializerMethodField()
    total_paid = serializers.SerializerMethodField()
    balance = serializers.SerializerMethodField()
    payments = LocalFreightPaymentSerializer(many=True, read_only=True)

    class Meta:
        model = LocalFreight
        fields = [
            'id', 'freight_no', 'date', 'received', 'company', 'company_name',
            'factory', 'factory_name', 'freight_type', 'freight_type_display',
            'total_quantity', 'bill_no', 'bill_date', 'lorry_no',
            'transporter', 'transporter_name', 'freight_amount', 'amount_pay',
            'payment_mode', 'remarks', 'additional_freight_amount', 'less_amount',
            'tds_less', 'payable_amount', 'total_paid', 'balance', 'payments',
            'status', 'status_display',
            'is_dc', 'dc_no', 'dc_from', 'dc_to', 'dc_material', 'dc_value',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'freight_no', 'created_at', 'updated_at']
        extra_kwargs = {
            'received': {'required': False, 'allow_blank': True},
            'bill_no': {'required': False, 'allow_blank': True},
            'payment_mode': {'required': False, 'allow_blank': True},
            'remarks': {'required': False, 'allow_blank': True},
            'factory': {'required': False, 'allow_null': True},
            'transporter': {'required': False, 'allow_null': True},
            'total_quantity': {'required': False, 'allow_null': True},
            'bill_date': {'required': False, 'allow_null': True},
        }

    def get_payable_amount(self, obj):
        return str(obj.get_total_payable())

    def get_total_paid(self, obj):
        return str(obj.get_total_paid())

    def get_balance(self, obj):
        return str(obj.balance)

    def create(self, validated_data):
        validated_data['freight_no'] = generate_local_freight_no()
        return super().create(validated_data)


class LocalFreightViewSet(viewsets.ModelViewSet):
    queryset = (LocalFreight.objects.filter(is_active=True)
                .select_related('company', 'factory', 'transporter'))
    serializer_class = LocalFreightSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Local Freight'
    filterset_fields = ['company', 'factory', 'freight_type']
    search_fields = ['freight_no', 'lorry_no', 'bill_no', 'transporter__name']
    ordering_fields = ['date', 'freight_amount']
    ordering = ['-date']

    @property
    def alternate_modules(self):
        # The Freight Analytics page sums local freight into its totals, so a
        # role granted the read-only 'Freight Analytics' module may list it.
        # Scoped to read actions — create/edit/delete still need Local Freight.
        return ['Freight Analytics'] if getattr(self, 'action', None) in ('list', 'retrieve') else []

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    def perform_update(self, serializer):
        serializer.save(updated_by=self.request.user)

    def perform_destroy(self, instance):
        instance.is_active = False
        instance.save(update_fields=['is_active', 'updated_at'])

    @action(detail=True, methods=['post'], url_path='add-payment')
    def add_payment(self, request, pk=None):
        """Record a payment against this local freight bill."""
        freight = self.get_object()
        serializer = LocalFreightPaymentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        amount = serializer.validated_data['amount_paid']
        balance = freight.balance
        if amount > balance:
            return Response(
                {'error': f'Payment amount ({amount}) exceeds balance ({balance}).'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            from core.models import StakeholderUser
            created_by = StakeholderUser.objects.get(user=request.user)
        except Exception:
            created_by = None
        payment = LocalFreightPayment.objects.create(
            local_freight=freight, created_by=created_by,
            payment_no=generate_local_freight_payment_no(), **serializer.validated_data,
        )
        return Response(LocalFreightPaymentSerializer(payment).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['get'], url_path='payments')
    def list_payments(self, request, pk=None):
        freight = self.get_object()
        return Response(LocalFreightPaymentSerializer(freight.payments.all(), many=True).data)

    @action(detail=False, methods=['post'], url_path='import-daybook',
            parser_classes=[MultiPartParser, FormParser])
    def import_daybook(self, request):
        """Upload a Tally Day Book XML -> create OUTWARD (FreightAdviceOutbound)
        and LOCAL (LocalFreight) freight records from the LFO/LFR vouchers.

        The Tally connector drops voucher narration, so outward/local freight
        payments land as a bare PaymentMade with no freight record — this fills
        that gap from a full Day Book export. Pass ?apply=1 to write (default is
        a dry-run preview); ?revert=1 deletes records a prior import created.
        Idempotent by voucher GUID. Admin-only (module 'Local Freight')."""
        from core.models import Company
        from finance.daybook_freight_parser import (
            parse_daybook_freight_stream, summarize)
        from .daybook_freight_import import import_daybook_freight

        token = (request.data.get('company') or request.query_params.get('company') or '').strip()
        comp = Company.objects.filter(company_code__iexact=token).first()
        if comp is None and token:
            comp = Company.objects.filter(pk=token).first() if _looks_uuid(token) else None
        if comp is None:
            return Response({'error': 'Pick a company first.'}, status=status.HTTP_400_BAD_REQUEST)

        apply = str(request.query_params.get('apply') or request.data.get('apply') or '').lower() \
            in ('1', 'true', 'yes')
        revert = str(request.query_params.get('revert') or request.data.get('revert') or '').lower() \
            in ('1', 'true', 'yes')

        if revert:
            r = import_daybook_freight(comp, [], request.user, apply=apply, revert=True)
            return Response(r)

        f = request.FILES.get('file')
        if not f:
            return Response({'error': 'No file uploaded.'}, status=status.HTTP_400_BAD_REQUEST)
        # STREAM-parse the upload. A full-company Day Book is 400-450 MB; decoding
        # it whole (a ~0.9 GB UTF-16 string) OOM-kills the 512 MB worker — hence
        # the "Network Error". parse_daybook_freight_stream reads it chunk by
        # chunk with ~one-voucher peak memory. Django already spooled the upload
        # to a temp file (>5 MB), so we read from disk, not RAM.
        try:
            f.seek(0)
            records = parse_daybook_freight_stream(f)
        except Exception as e:  # noqa: BLE001
            return Response({'error': f'Could not read the Day Book: {e}'},
                            status=status.HTTP_400_BAD_REQUEST)
        if not records:
            return Response({'error': 'No freight vouchers (LFO/LFI/LFR) found in this file.'},
                            status=status.HTTP_400_BAD_REQUEST)

        res = import_daybook_freight(comp, records, request.user, apply=apply)
        res['parsed'] = {'total': len(records),
                         'by_direction': {d: {'count': v['count'], 'amount': str(v['amount'])}
                                          for d, v in summarize(records).items()}}
        # Decimals -> str for JSON.
        for key in ('outward', 'local'):
            res[key] = {k: (str(v) if k == 'amount' else v) for k, v in res[key].items()}
        res['gap_amount'] = str(res['gap_amount'])
        return Response(res)

    @action(detail=True, methods=['post'], url_path='approve')
    def approve(self, request, pk=None):
        """DRAFT → APPROVED. A scan-confirmed local freight lands as DRAFT so the
        OCR'd figures get a final look before it becomes a live payable — the
        local-freight counterpart of VendorBill DRAFT→OPEN."""
        freight = self.get_object()
        if freight.status != 'DRAFT':
            return Response({'error': f'Cannot approve freight in {freight.status} status.'},
                            status=status.HTTP_400_BAD_REQUEST)
        freight.status = 'APPROVED'
        freight.save(update_fields=['status', 'updated_at'])
        return Response(LocalFreightSerializer(freight).data)

    @action(detail=False, methods=['post'], url_path='approve-all')
    def approve_all(self, request):
        """Approve many DRAFT local-freight rows at once. Pass {"ids": [...]} for a
        selection, or omit it to approve every DRAFT row."""
        ids = request.data.get('ids') or None
        qs = self.get_queryset().filter(status='DRAFT')
        if ids:
            qs = qs.filter(id__in=ids)
        approved = qs.update(status='APPROVED')
        return Response({'approved': approved})

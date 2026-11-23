"""Bank views (standalone):
  * BankAccountViewSet       — accounts for the payment "paid from" picker
  * BankStatementUploadViewSet — upload a statement (CSV/Excel/PDF), parse it
    into lines, and turn a debit row into a vendor PaymentMade.
No Tally reconciliation.
"""
from decimal import Decimal

from django.db import transaction
from rest_framework import viewsets, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from django_filters.rest_framework import DjangoFilterBackend

from .models import BankAccount, BankStatementUpload, BankStatementLine
from .serializers import (
    BankAccountSerializer, BankStatementUploadSerializer,
    BankStatementUploadListSerializer, BankStatementLineSerializer,
)


class BankAccountViewSet(viewsets.ModelViewSet):
    queryset = BankAccount.objects.filter(is_active=True)
    serializer_class = BankAccountSerializer
    permission_classes = [IsAuthenticated]
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['company']


class BankStatementUploadViewSet(viewsets.ModelViewSet):
    queryset = BankStatementUpload.objects.select_related('bank_account', 'company').all()
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['company', 'bank_account', 'parsing_status']

    def get_serializer_class(self):
        if self.action == 'list':
            return BankStatementUploadListSerializer
        return BankStatementUploadSerializer

    def create(self, request, *args, **kwargs):
        """Upload a statement file and parse it immediately."""
        f = request.FILES.get('statement_file') or request.FILES.get('file')
        if not f:
            return Response({'detail': 'No statement_file provided.'},
                            status=status.HTTP_400_BAD_REQUEST)
        upload = BankStatementUpload.objects.create(
            bank_account_id=request.data.get('bank_account') or None,
            company_id=request.data.get('company') or None,
            statement_file=f,
            file_name=getattr(f, 'name', ''),
            remarks=request.data.get('remarks', ''),
        )
        self._parse(upload)
        ser = BankStatementUploadSerializer(upload, context={'request': request})
        return Response(ser.data, status=status.HTTP_201_CREATED)

    def _parse(self, upload):
        from .bank_statement_parser import parse_statement_file
        try:
            upload.statement_file.open('rb')
            lines, err = parse_statement_file(upload.statement_file)
        except Exception as exc:  # noqa: BLE001
            upload.parsing_status = 'FAILED'
            upload.parse_error = str(exc)[:2000]
            upload.save(update_fields=['parsing_status', 'parse_error'])
            return
        if err and not lines:
            upload.parsing_status = 'FAILED'
            upload.parse_error = err
            upload.save(update_fields=['parsing_status', 'parse_error'])
            return
        objs = [
            BankStatementLine(
                upload=upload,
                line_no=ln.get('line_no', i),
                txn_date=ln.get('txn_date'),
                narration=ln.get('narration', ''),
                reference_no=ln.get('reference_no', ''),
                debit=ln.get('debit') or Decimal('0'),
                credit=ln.get('credit') or Decimal('0'),
                balance=ln.get('balance'),
            )
            for i, ln in enumerate(lines, start=1)
        ]
        BankStatementLine.objects.bulk_create(objs)
        upload.parsing_status = 'PARSED'
        upload.parse_error = err or ''
        upload.line_count = len(objs)
        upload.save(update_fields=['parsing_status', 'parse_error', 'line_count'])

    @action(detail=False, methods=['get'], url_path='inbox')
    def inbox(self, request):
        """Statement uploads with pipeline counts (detected / entered / missing).

        Only DEBIT rows are the recordable universe on this purchase-side page.
        """
        qs = self.filter_queryset(self.get_queryset())[:100]
        out = []
        for u in qs:
            debit_lines = u.lines.filter(debit__gt=0)
            detected = debit_lines.count()
            entered = debit_lines.filter(matched_vendor_payment__isnull=False).count()
            out.append({
                'id': str(u.id),
                'account': u.bank_account.nickname if u.bank_account_id else '',
                'account_code': u.bank_account.code if u.bank_account_id else '',
                'company_name': u.company.legal_name if u.company_id else '',
                'file_name': u.file_name,
                'parsing_status': u.parsing_status,
                'period_start': None,
                'period_end': None,
                'uploaded_at': u.created_at.isoformat() if u.created_at else None,
                'detected': detected,
                'entered': entered,
                'missing': detected - entered,
            })
        return Response(out)

    @action(detail=True, methods=['get'], url_path='lines')
    def lines(self, request, pk=None):
        """Lines of a statement, filtered by side + recorded state, each with a
        best-guess vendor suggestion (name-match against the vendor master)."""
        upload = self.get_object()
        side = (request.query_params.get('side') or 'debit').lower()
        qs = upload.lines.all()
        qs = qs.filter(debit__gt=0) if side == 'debit' else qs.filter(credit__gt=0)
        if request.query_params.get('unrecorded'):
            qs = qs.filter(matched_vendor_payment__isnull=True)
        elif request.query_params.get('recorded'):
            qs = qs.filter(matched_vendor_payment__isnull=False)

        from master.models import Vendor
        rows = []
        for ln in qs:
            amount = ln.debit if side == 'debit' else ln.credit
            suggestion = _guess_vendor(ln.narration, Vendor)
            rows.append({
                'id': str(ln.id),
                'line_no': ln.line_no,
                'txn_date': ln.txn_date.isoformat() if ln.txn_date else None,
                'date': ln.txn_date.isoformat() if ln.txn_date else None,
                'narration': ln.narration,
                'reference_no': ln.reference_no,
                'amount': str(amount),
                'debit': str(ln.debit),
                'credit': str(ln.credit),
                'balance': str(ln.balance) if ln.balance is not None else None,
                'suggested_vendor': suggestion,
                'recorded': ln.matched_vendor_payment_id is not None,
                'payment_no': ln.matched_vendor_payment.payment_no if ln.matched_vendor_payment_id else None,
            })
        return Response(rows)

    @action(detail=True, methods=['post'], url_path='dismiss')
    def dismiss(self, request, pk=None):
        """Remove a statement upload from the inbox (delete it)."""
        upload = self.get_object()
        upload.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def _record_line(self, upload, line, vendor_id, bill_id=None, amount=None, payment_mode='BANK_TRANSFER'):
        from purchase.models import PaymentMade
        pay = PaymentMade.objects.create(
            vendor_id=vendor_id,
            payment_date=line.txn_date,
            amount=amount if amount is not None else line.debit,
            payment_mode=payment_mode,
            reference_no=line.reference_no or '',
            bank_name=(upload.bank_account.nickname if upload.bank_account_id else ''),
            bank_account_id=upload.bank_account_id,
            bill_id=bill_id or None,
            notes=f'From bank statement: {line.narration[:180]}',
            status='CONFIRMED',
        )
        return pay

    @action(detail=True, methods=['post'], url_path='create-entry')
    def create_entry(self, request, pk=None):
        """Record ONE debit line as a vendor payment (optionally against a bill).

        Body: { line_id, target, vendor|party_id, document_id (bill, optional) }
        """
        upload = self.get_object()
        line_id = request.data.get('line_id')
        vendor_id = request.data.get('vendor') or request.data.get('party_id')
        bill_id = request.data.get('document_id') or request.data.get('bill')
        if not line_id or not vendor_id:
            return Response({'detail': 'line_id and vendor are required.'},
                            status=status.HTTP_400_BAD_REQUEST)
        try:
            line = upload.lines.get(pk=line_id)
        except BankStatementLine.DoesNotExist:
            return Response({'detail': 'line not found on this statement.'},
                            status=status.HTTP_404_NOT_FOUND)
        if line.matched_vendor_payment_id:
            return Response({'detail': 'This line is already recorded.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if (line.debit or 0) <= 0:
            return Response({'detail': 'Only debit (money-out) rows can become payments.'},
                            status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            pay = self._record_line(upload, line, vendor_id, bill_id)
            line.matched_vendor_payment = pay
            line.save(update_fields=['matched_vendor_payment'])
        return Response({'payment_id': str(pay.id), 'payment_no': pay.payment_no},
                        status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], url_path='create-split-entry')
    def create_split_entry(self, request, pk=None):
        """Record one debit line split across several bills.

        Body: { line_id, vendor|party_id, allocations:[{bill_id, amount}] }
        The first allocation's bill carries the PaymentMade; the full line
        amount is recorded (any remainder is 'on account').
        """
        upload = self.get_object()
        line_id = request.data.get('line_id')
        vendor_id = request.data.get('vendor') or request.data.get('party_id')
        allocations = request.data.get('allocations') or []
        if not line_id or not vendor_id:
            return Response({'detail': 'line_id and vendor are required.'},
                            status=status.HTTP_400_BAD_REQUEST)
        try:
            line = upload.lines.get(pk=line_id)
        except BankStatementLine.DoesNotExist:
            return Response({'detail': 'line not found on this statement.'},
                            status=status.HTTP_404_NOT_FOUND)
        if line.matched_vendor_payment_id:
            return Response({'detail': 'This line is already recorded.'},
                            status=status.HTTP_400_BAD_REQUEST)
        first_bill = allocations[0].get('bill_id') if allocations else None
        with transaction.atomic():
            pay = self._record_line(upload, line, vendor_id, first_bill)
            line.matched_vendor_payment = pay
            line.save(update_fields=['matched_vendor_payment'])
        return Response({'payment_id': str(pay.id), 'payment_no': pay.payment_no},
                        status=status.HTTP_201_CREATED)


def _guess_vendor(narration, Vendor):
    """Best-effort: match a vendor whose name appears in the narration.
    Returns {id, name} or None. Purely a convenience hint for the UI."""
    import re
    text = (narration or '').upper()
    if not text:
        return None
    # Try each active vendor; pick the longest name that is a substring of the
    # narration (so 'ASIACRYSTALCOMMO' matches 'Asia Crystal Commodity').
    best = None
    best_len = 3
    compact = re.sub(r'[^A-Z0-9]', '', text)
    for v in Vendor.objects.filter(is_active=True).only('id', 'vendor_name')[:2000]:
        name = (v.vendor_name or '').upper()
        cname = re.sub(r'[^A-Z0-9]', '', name)
        if len(cname) > best_len and cname in compact:
            best, best_len = v, len(cname)
    if best:
        return {'id': str(best.id), 'name': best.vendor_name}
    return None

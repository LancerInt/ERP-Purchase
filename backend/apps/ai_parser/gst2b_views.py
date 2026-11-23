"""GSTR-2B reconciliation API.

    POST /api/purchase/gst2b/upload/     multipart: company, file  → upload + reconcile
    GET  /api/purchase/gst2b/            list recent uploads
    GET  /api/purchase/gst2b/<id>/       summary + rows (?status=MATCHED|MISMATCH|ONLY_2B|ONLY_BOOKS)
    DELETE /api/purchase/gst2b/<id>/     remove an upload
"""
from django.shortcuts import get_object_or_404
from rest_framework import status as http
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from rbac.permissions import HasModulePermission

from .gst2b_models import Gst2BUpload


def _summary(u, with_itc=True):
    out = {
        'id': str(u.id), 'kind': u.kind, 'period': u.period, 'file_name': u.file_name,
        'company_name': u.company.legal_name if u.company_id else None,
        'total_rows': u.total_rows, 'matched': u.matched, 'mismatch': u.mismatch,
        'only_in_2b': u.only_in_2b, 'only_in_books': u.only_in_books,
        'error_message': u.error_message,
        'created_at': u.created_at.isoformat() if u.created_at else None,
    }
    if with_itc:
        # Money view — this is what the page should LEAD with. ITC (tax) is the
        # number that costs money, and the "in 2B not booked" count is split by
        # the action it needs (create a vendor vs just book the bill).
        from decimal import Decimal
        from django.db.models import Count, Q, Sum
        a = u.rows.aggregate(
            itc_2b=Sum('total_tax', filter=~Q(status='ONLY_BOOKS')),       # ITC the 2B offers
            itc_matched=Sum('total_tax', filter=Q(status='MATCHED')),       # cleanly claimable
            itc_mismatch=Sum('total_tax', filter=Q(status='MISMATCH')),     # claimable but tax differs
            itc_only_2b=Sum('total_tax', filter=Q(status='ONLY_2B')),       # in 2B, not booked
            itc_at_risk=Sum('total_tax', filter=Q(status='ONLY_BOOKS')),    # booked, supplier hasn't filed
            no_vendor=Count('id', filter=Q(status='ONLY_2B', note__icontains='not in ERP vendors')),
        )
        s = lambda v: str((v or Decimal('0')))
        no_vendor = a['no_vendor'] or 0
        out.update({
            'itc_2b': s(a['itc_2b']), 'itc_matched': s(a['itc_matched']),
            'itc_mismatch': s(a['itc_mismatch']), 'itc_only_2b': s(a['itc_only_2b']),
            'itc_at_risk': s(a['itc_at_risk']),
            'only_2b_no_vendor': no_vendor,
            'only_2b_not_booked': (u.only_in_2b or 0) - no_vendor,
        })
    return out


def _row(r):
    return {
        'id': str(r.id), 'section': r.section, 'supplier_gstin': r.supplier_gstin,
        'supplier_name': r.supplier_name, 'invoice_no': r.invoice_no,
        'invoice_date': r.invoice_date.isoformat() if r.invoice_date else None,
        'invoice_value': str(r.invoice_value), 'taxable': str(r.taxable),
        'igst': str(r.igst), 'cgst': str(r.cgst), 'sgst': str(r.sgst), 'cess': str(r.cess),
        'total_tax': str(r.total_tax), 'itc_available': r.itc_available,
        'status': r.status, 'note': r.note,
        'bill_id': str(r.matched_bill_id) if r.matched_bill_id else None,
        'bill_no': r.matched_bill.bill_no if r.matched_bill_id else None,
    }


class Gst2BUploadView(APIView):
    parser_classes = [MultiPartParser, FormParser]
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'GST 2B Match'

    def post(self, request):
        f = request.FILES.get('file')
        if not f:
            return Response({'detail': 'No file uploaded.'}, status=http.HTTP_400_BAD_REQUEST)
        company = None
        cid = request.data.get('company')
        if cid:
            from core.models import Company
            company = Company.objects.filter(pk=cid).first()

        from .gst2b_service import period_from_name, reconcile
        # Kind from the tab; else auto-detect from the file name (…GSTR2A… / …GSTR2B…).
        kind = (request.data.get('kind') or '').upper()
        if kind not in ('2A', '2B'):
            name_u = (f.name or '').upper()
            kind = '2A' if 'GSTR2A' in name_u or '2A' in name_u else '2B'
        label, start, end = period_from_name(f.name)
        # Reject a duplicate: a 2A/2B for the same company + period is already
        # here. Re-uploading an updated statement? Delete the existing report
        # first (the Delete button on the row). Guards against the same file
        # being imported twice and creating two identical reports.
        if company and label:
            dup = Gst2BUpload.objects.filter(
                company=company, kind=kind, period=label).first()
            if dup:
                co = getattr(company, 'legal_name', None) or getattr(company, 'trade_name', '') or 'this company'
                return Response(
                    {'detail': f'A GSTR-{kind} report for {co} · {label} is already uploaded. '
                               f'Delete the existing one first if you want to re-upload.'},
                    status=http.HTTP_409_CONFLICT)
        up = Gst2BUpload.objects.create(
            company=company, kind=kind, file=f, file_name=(f.name or '')[:255],
            period=label, period_start=start, period_end=end, created_by=request.user)
        reconcile(up)
        if up.error_message:
            return Response({'detail': up.error_message}, status=http.HTTP_400_BAD_REQUEST)
        return Response(_summary(up), status=http.HTTP_201_CREATED)


class Gst2BListView(APIView):
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'GST 2B Match'

    def get(self, request):
        qs = Gst2BUpload.objects.all()
        cid = request.query_params.get('company')
        if cid:
            qs = qs.filter(company_id=cid)
        kind = request.query_params.get('kind')
        if kind in ('2A', '2B'):
            qs = qs.filter(kind=kind)
        # The "Recent uploads" list only needs the counts, so skip the per-row
        # ITC aggregation (one query per upload) here.
        return Response([_summary(u, with_itc=False) for u in qs[:50]])


class Gst2BReportView(APIView):
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'GST 2B Match'

    def get(self, request, pk):
        up = get_object_or_404(Gst2BUpload, pk=pk)
        rows = up.rows.select_related('matched_bill')
        st = request.query_params.get('status')
        if st:
            rows = rows.filter(status=st)
        return Response({'summary': _summary(up), 'rows': [_row(r) for r in rows[:3000]]})

    def delete(self, request, pk):
        get_object_or_404(Gst2BUpload, pk=pk).delete()
        return Response(status=http.HTTP_204_NO_CONTENT)

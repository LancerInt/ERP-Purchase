"""API for the invoice-scan inbox.

    POST   /api/purchase/scan/upload/            multipart: company, note, files[]
    GET    /api/purchase/scan/batches/           list batches (inbox)
    GET    /api/purchase/scan/batches/<id>/      batch + its detected bills
    GET    /api/purchase/scan/bills/<id>/        one bill (with vendor candidates)
    PATCH  /api/purchase/scan/bills/<id>/        edit header/lines/vendor mapping
    POST   /api/purchase/scan/bills/<id>/<action>/   action in confirm|rematch|skip
    GET    /api/purchase/scan/suggest/           ?kind=product|vendor&q=...&company=
"""
import logging

from django.shortcuts import get_object_or_404
from rest_framework import status as http
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from rbac.permissions import HasModulePermission

from . import scan_service
from .scan_models import InvoiceScanBatch, InvoiceScanBill, InvoiceScanDocument
from .scan_serializers import ScanBatchSerializer, ScanBillSerializer, ScanDocumentSerializer

logger = logging.getLogger(__name__)


class ScanUploadView(APIView):
    """Create a batch from uploaded files and run vision extraction inline.

    Long-running (one Claude call per document) — the frontend posts with a
    generous timeout, same as the Tally import.
    """
    parser_classes = [MultiPartParser, FormParser]
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def post(self, request):
        files = request.FILES.getlist('files') or request.FILES.getlist('file')
        if not files:
            return Response({'detail': 'No files uploaded.'}, status=http.HTTP_400_BAD_REQUEST)

        company = None
        company_id = request.data.get('company')
        if company_id:
            from core.models import Company
            company = Company.objects.filter(pk=company_id).first()

        # Append into an existing batch (e.g. scanning a freight bill from inside
        # the review popup) instead of starting a new one, when a batch is given.
        batch = None
        batch_id = request.data.get('batch')
        if batch_id:
            batch = InvoiceScanBatch.objects.filter(pk=batch_id).first()
        if batch is None:
            batch = InvoiceScanBatch.objects.create(
                company=company, note=(request.data.get('note') or '')[:255],
                status='UPLOADED', created_by=request.user,
            )
        elif company and not batch.company_id:
            batch.company = company
            batch.save(update_fields=['company'])

        new_docs = []
        for f in files:
            new_docs.append(InvoiceScanDocument.objects.create(
                batch=batch, file=f, original_name=(f.name or '')[:255],
                content_type=getattr(f, 'content_type', '') or '',
                created_by=request.user,
            ))
        scan_service.process_batch(batch)

        # Bills read from the just-uploaded docs. When the caller says these are
        # FREIGHT (the "Scan (new freight)" button), stamp the type and auto-match
        # the transporter so the review opens straight in freight mode.
        new_bills = list(InvoiceScanBill.objects.filter(document__in=new_docs))
        bill_type = (request.data.get('bill_type') or '').upper()
        if bill_type == 'FREIGHT':
            for sb in new_bills:
                sb.bill_type = 'FREIGHT'
                # Freshly-scanned freight slip: the extracted total/invoice ARE the
                # freight's own, so seed the freight-specific fields from them (a
                # toggled goods bill keeps these blank/0 instead). GROSS model: the
                # scanned total is the NET to-pay (after TDS), so gross = net + TDS;
                # payable = gross - TDS = the net the slip shows.
                sb.freight_amount = (sb.total_amount or 0) + (sb.tds_amount or 0)
                sb.freight_tds = sb.tds_amount or 0
                sb.freight_invoice_no = sb.invoice_no or ''
                sb.freight_invoice_date = sb.invoice_date
                if not sb.transporter_id:
                    sb.transporter = scan_service._match_transporter(sb)
                # Recover a lorry/vehicle plate the AI missed off a handwritten slip.
                if not (sb.lorry_no or '').strip():
                    sb.lorry_no = scan_service._scan_lorry_from_text(sb)
                # Automatic goods-bill mapping is DISABLED for now — operator links
                # by hand. Kept, commented, for later:
                #   sb.freight_linked_bill = scan_service._match_bill_by_ref(sb.freight_ref_no)
                sb.save(update_fields=['bill_type', 'freight_amount', 'freight_tds', 'freight_invoice_no',
                                       'freight_invoice_date', 'transporter', 'lorry_no'])

        payload = _batch_payload(batch, request)
        payload['new_bill_ids'] = [str(sb.id) for sb in new_bills]
        # Strict duplicate check: any just-scanned bill that already sits UNCONFIRMED
        # in the inbox (same vendor + bill no + date). The page asks Remove / Cancel.
        payload['duplicates'] = scan_service.find_inbox_duplicates(new_bills)
        return Response(payload, status=http.HTTP_201_CREATED)


class ScanBatchListView(APIView):
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def get(self, request):
        from django.db.models import Count, Q
        qs = InvoiceScanBatch.objects.all().prefetch_related('documents')
        company_id = request.query_params.get('company')
        if company_id:
            qs = qs.filter(company_id=company_id)
        # Recent list = only batches that still have work: at least one bill NOT
        # yet converted (CONFIRMED) or skipped. A fully-converted batch drops off
        # automatically. (Pass ?all=1 to list every batch regardless.)
        if request.query_params.get('all') not in ('1', 'true'):
            qs = qs.annotate(
                pending_n=Count('bills', filter=~Q(bills__status__in=['CONFIRMED', 'SKIPPED']))
            ).filter(pending_n__gt=0)
        qs = qs.order_by('-created_at')[:100]
        return Response(ScanBatchSerializer(qs, many=True, context={'request': request}).data)


class ScanBatchDetailView(APIView):
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def get(self, request, pk):
        batch = get_object_or_404(InvoiceScanBatch, pk=pk)
        return Response(_batch_payload(batch, request))

    def patch(self, request, pk):
        # Free-text internal note on a scan batch (Recent-scans list). No link to
        # anything — just a reminder the operator can write, see and edit.
        batch = get_object_or_404(InvoiceScanBatch, pk=pk)
        if 'note' in request.data:
            batch.note = (request.data.get('note') or '')[:255]
            batch.save(update_fields=['note'])
        return Response(ScanBatchSerializer(batch, context={'request': request}).data)

    def delete(self, request, pk):
        # Remove the scan record (cascades its documents + scan bills). Any
        # VendorBill already created from it is NOT touched (FK is SET_NULL).
        batch = get_object_or_404(InvoiceScanBatch, pk=pk)
        batch.delete()
        return Response(status=http.HTTP_204_NO_CONTENT)


class ScanBillDetailView(APIView):
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'
    parser_classes = [JSONParser, FormParser, MultiPartParser]

    EDITABLE = {'vendor_name', 'vendor_gstin', 'invoice_no', 'invoice_date', 'due_date',
                'subtotal', 'tax_amount', 'total_amount', 'lines', 'voucher_type',
                'update_stock', 'bill_type', 'freight_target', 'lorry_no', 'transporter_name',
                'freight_amount', 'tds_amount', 'category',
                'freight_invoice_no', 'freight_invoice_date', 'freight_ref_no',
                # Freight money (GROSS model) + DC / branch-transfer — mirrors Email Inbox.
                'freight_tds', 'freight_roundoff', 'freight_weight_charge',
                'is_dc', 'dc_no', 'dc_from', 'dc_to', 'dc_material', 'dc_value'}

    def get(self, request, pk):
        sb = get_object_or_404(InvoiceScanBill, pk=pk)
        return Response(ScanBillSerializer(sb, context={'request': request, 'detail': True}).data)

    def delete(self, request, pk):
        # Remove ONE scanned bill from the inbox (e.g. a mis-scanned freight row) —
        # the per-bill equivalent of the X on the Recent-scans list, which deletes a
        # whole batch. Anything already created/linked from it is NOT touched.
        sb = get_object_or_404(InvoiceScanBill, pk=pk)
        sb.delete()
        return Response(status=http.HTTP_204_NO_CONTENT)

    def patch(self, request, pk):
        sb = get_object_or_404(InvoiceScanBill, pk=pk)
        if sb.status == 'CONFIRMED':
            return Response({'detail': 'Already confirmed.'}, status=http.HTTP_400_BAD_REQUEST)

        data = request.data
        for field in self.EDITABLE & set(data.keys()):
            setattr(sb, field, data[field])

        # Explicit operator overrides for vendor / bill mapping.
        explicit = False
        vendor_changed = False
        if 'matched_vendor' in data:
            from master.models import Vendor
            _old_vendor_id = sb.matched_vendor_id
            sb.matched_vendor = Vendor.objects.filter(pk=data['matched_vendor']).first() if data['matched_vendor'] else None
            explicit = True
            vendor_changed = str(_old_vendor_id or '') != str(sb.matched_vendor_id or '')
        if 'matched_bill' in data:
            from purchase.models import VendorBill
            sb.matched_bill = VendorBill.objects.filter(pk=data['matched_bill']).first() if data['matched_bill'] else None
            explicit = True
        # PER-BILL company override. A stack scanned under one company can hold a bill
        # for another — the reviewer re-routes it here. Changing it re-scopes the
        # vendor (vendors are per-company): drop one from the OLD company and re-find
        # the match in the NEW company by GSTIN (exact) then name. Mirrors Email Inbox.
        if 'company' in data:
            from core.models import Company
            from master.models import Vendor
            old_eff = sb.company_id or (sb.batch.company_id if sb.batch_id else None)
            sb.company = Company.objects.filter(pk=data['company']).first() if data['company'] else None
            new_eff = sb.company_id or (sb.batch.company_id if sb.batch_id else None)
            if str(old_eff or '') != str(new_eff or ''):
                explicit = True
                vendor_changed = True
                if sb.matched_vendor_id and sb.matched_vendor.company_id != new_eff:
                    sb.matched_vendor = None
                if sb.matched_vendor_id is None and new_eff:
                    gst = (sb.vendor_gstin or '').strip()
                    vn = (sb.vendor_name or '').strip()
                    cand = (Vendor.objects.filter(company_id=new_eff, is_active=True, gstin__iexact=gst).first() if gst else None)
                    if cand is None and vn:
                        cand = Vendor.objects.filter(company_id=new_eff, is_active=True, vendor_name__iexact=vn).first()
                    sb.matched_vendor = cand
                sb.matched_bill = None   # the Tally match was scoped to the old company
        # Link this goods bill to an EXISTING shared inward-freight ("Merge into
        # this"). On confirm, commit_scan_bill adds the bill to that freight's
        # covered_bills. Not in EDITABLE (it's an FK), so handle it explicitly —
        # without this branch the pick is silently dropped and never persists.
        if 'link_freight' in data:
            from purchase.models import FreightAdviceInbound
            sb.link_freight = FreightAdviceInbound.objects.filter(pk=data['link_freight']).first() if data['link_freight'] else None
        if 'transporter' in data:
            from master.models import Transporter
            sb.transporter = Transporter.objects.filter(pk=data['transporter']).first() if data['transporter'] else None
        # Switched to a freight bill → auto-match the transporter if not set yet.
        if data.get('bill_type') == 'FREIGHT' and not sb.transporter_id:
            sb.transporter = scan_service._match_transporter(sb)
        # Automatic goods-bill re-mapping on ref change is DISABLED for now — the
        # operator links by hand (Link button). Kept, commented, for later:
        #   if 'freight_ref_no' in data:
        #       sb.freight_linked_bill = scan_service._match_bill_by_ref(sb.freight_ref_no)
        # Stock-intake location (goods-received warehouse + godown). Godown is
        # re-validated to sit inside the chosen warehouse, so a stale pick can't
        # send stock to the wrong place.
        if 'warehouse' in data:
            from core.models import Warehouse
            sb.warehouse = Warehouse.objects.filter(pk=data['warehouse']).first() if data['warehouse'] else None
        if 'godown' in data:
            from core.models import Godown
            gd = Godown.objects.filter(pk=data['godown']).first() if data['godown'] else None
            if gd and sb.warehouse_id and gd.warehouse_id != sb.warehouse_id:
                gd = None
            sb.godown = gd
        # A cleared date input arrives as '' — store NULL, not an invalid date.
        for _df in ('invoice_date', 'due_date', 'freight_invoice_date'):
            if getattr(sb, _df, None) == '':
                setattr(sb, _df, None)
        # A cleared NUMBER input arrives as '' — store 0, not an invalid decimal.
        for _nf in ('freight_amount', 'tds_amount', 'freight_tds', 'freight_roundoff', 'freight_weight_charge', 'dc_value'):
            if getattr(sb, _nf, None) in ('', None):
                setattr(sb, _nf, 0)
        # A due date before the invoice date is invalid — drop it (safety net;
        # the UI also blocks it). Edited fields arrive as strings, so parse first.
        from datetime import date as _date, datetime as _dt

        def _d(v):
            if isinstance(v, _date):
                return v
            if isinstance(v, str) and v.strip():
                try:
                    return _dt.strptime(v.strip()[:10], '%Y-%m-%d').date()
                except ValueError:
                    return None
            return None
        _dd, _ii = _d(sb.due_date), _d(sb.invoice_date)
        if _dd and _ii and _dd < _ii:
            sb.due_date = None
        sb.save()
        # Learned alias: when the operator maps this scanned name to a vendor,
        # remember it so the next scan / Tally import of the SAME printed name
        # resolves to the same vendor automatically (TallyPartyMap is consulted
        # first by every resolver). Only on a real change, and only when the
        # scanned name differs from the vendor's own name (an exact match needs
        # no alias). Never blocks the save.
        if vendor_changed and sb.matched_vendor_id and (sb.vendor_name or '').strip():
            try:
                from master.merge_utils import record_alias, vkey
                if vkey(sb.vendor_name) != vkey(sb.matched_vendor.vendor_name):
                    record_alias(sb.vendor_name, sb.matched_vendor,
                                 sb.matched_vendor.company)
            except Exception:  # noqa: BLE001 — an alias must never break review
                pass
        # Just turned DC on → pre-fill the blank branch-transfer fields from the
        # parse so the reviewer only confirms/corrects (blanks only; edits kept).
        if str(data.get('is_dc')) in ('True', 'true', '1') and sb.is_dc:
            scan_service._fill_scan_dc_fields(sb)

        # Recompute status: honor explicit picks; otherwise auto-resolve afresh.
        if explicit:
            # A re-picked vendor must drag the merge target with it — otherwise the
            # review keeps the stale "no related bill" from the scan-time vendor and
            # the operator can't merge, so a duplicate gets written. Re-find the
            # existing bill ONLY when the vendor actually CHANGED (not when a save()
            # just re-sends the same vendor — that would clobber an explicit
            # matched_bill the operator picked and re-trigger the merge prompt in a
            # loop), and never when they picked a bill by hand.
            if vendor_changed and 'matched_bill' not in data:
                sb.matched_bill = scan_service.find_matched_bill(sb)
                sb.save(update_fields=['matched_bill'])
            scan_service.recompute_status(sb)
        else:
            scan_service.match_scan_bill(sb)
        # A vendor was just picked/changed → suggest its usual type/category
        # (only fills blanks, so it never overwrites what the operator set).
        if 'matched_vendor' in data:
            scan_service._apply_class_suggestion(sb)
        # Operator-triggered re-run of the AI pre-fill (purchase type / category /
        # warehouse) on THIS bill — fills only blanks, so a manual pick is kept.
        if data.get('rerun_suggest'):
            scan_service._apply_class_suggestion(sb)
        # Operator asked to translate the line descriptions to English (for a bill
        # scanned before the English extraction, or a regional-script one).
        if data.get('translate_lines'):
            scan_service.translate_scan_lines(sb)
        return Response(ScanBillSerializer(sb, context={'request': request, 'detail': True}).data)


class ScanBillActionView(APIView):
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'
    parser_classes = [JSONParser, FormParser, MultiPartParser]

    def post(self, request, pk, action):
        sb = get_object_or_404(InvoiceScanBill, pk=pk)
        if action == 'rematch':
            scan_service.match_scan_bill(sb)
        elif action == 'skip':
            sb.status = 'SKIPPED'
            sb.save(update_fields=['status'])
        elif action == 'link_bill':
            # Manual link: attach this freight slip to the chosen purchase bill and
            # confirm it, so it shows on that bill's "Freight attached" card. This is
            # the manual replacement for the (now disabled) automatic matching.
            if sb.bill_type != 'FREIGHT':
                return Response({'detail': 'Only a freight bill can be linked to a purchase bill.'},
                                status=http.HTTP_400_BAD_REQUEST)
            from purchase.models import VendorBill
            _bid = request.data.get('bill_id')
            bill = VendorBill.objects.filter(pk=_bid).first() if _bid else None
            if bill is None:
                return Response({'detail': 'Pick a bill to link.'}, status=http.HTTP_400_BAD_REQUEST)
            sb.freight_linked_bill = bill
            sb.save(update_fields=['freight_linked_bill'])
            try:
                scan_service._commit_freight(sb, request.user)
            except Exception as e:  # noqa: BLE001
                logger.exception('freight link commit failed')
                return Response({'detail': f'Could not link: {e}'}, status=http.HTTP_400_BAD_REQUEST)
        elif action == 'create_vendor':
            # Create a new Vendor master from the scanned name/GSTIN and map it.
            # Allowed even if auto-matched — the operator is overriding a wrong
            # match with a deliberately-new vendor.
            from master.models import Vendor
            company = sb.batch.company
            if not company:
                return Response({'detail': 'This batch has no company — cannot create a vendor.'},
                                status=http.HTTP_400_BAD_REQUEST)
            name = (request.data.get('vendor_name') or sb.vendor_name or '').strip()
            if not name:
                return Response({'detail': 'No vendor name to create.'}, status=http.HTTP_400_BAD_REQUEST)
            gstin = (sb.vendor_gstin or '').strip()
            gstin = gstin if len(gstin) == 15 else None   # only store a well-formed GSTIN
            vfields = dict(vendor_name=name[:255], company=company, gstin=gstin,
                           vendor_type=['MATERIAL'], created_by=request.user)
            if gstin:
                # Fuller master: a well-formed GSTIN means a registered vendor;
                # derive PAN from it so the vendor is complete.
                vfields['gst_treatment'] = 'REGISTERED_REGULAR'
                try:
                    from common.gst import pan_from_gstin
                    pan = pan_from_gstin(gstin)
                    if pan:
                        vfields['pan'] = pan
                except Exception:  # noqa: BLE001
                    pass
            try:
                vend = Vendor.objects.create(**vfields)
            except Exception as e:  # noqa: BLE001
                return Response({'detail': f'Could not create vendor: {e}'}, status=http.HTTP_400_BAD_REQUEST)
            sb.matched_vendor = vend
            sb.save(update_fields=['matched_vendor'])
            scan_service.recompute_status(sb)
            scan_service._apply_class_suggestion(sb)   # suggest type/category now
            # Remember it + stamp it onto the other pending scan bills from this
            # same vendor, so they show the created vendor instead of Create.
            try:
                scan_service._remember_map(company, name, vendor=vend)
                from django.db.models import Q
                q = Q(vendor_name__iexact=name)
                if gstin:
                    q |= Q(vendor_gstin__iexact=gstin)
                siblings = (InvoiceScanBill.objects
                            .filter(batch__company=company, matched_vendor__isnull=True)
                            .filter(q).exclude(pk=sb.pk)
                            .exclude(status__in=['CONFIRMED', 'SKIPPED', 'FAILED']))
                for other in siblings:
                    other.matched_vendor = vend
                    other.save(update_fields=['matched_vendor'])
                    scan_service.recompute_status(other)
                    scan_service._apply_class_suggestion(other)
            except Exception:  # noqa: BLE001 — reuse is a convenience, never block the create
                logger.exception('scan vendor reuse-apply failed')
        elif action == 'create_product':
            # Create the item-master Product NOW (not deferred to Confirm) so it
            # exists immediately, shows in Masters, and the SAME item on every
            # other pending invoice in this batch — and the next scan — auto-maps
            # to it. Mirrors create_vendor. Reuses the importer's get-or-create so
            # a later Confirm resolves the same product (never a duplicate).
            company = sb.batch.company
            if not company:
                return Response({'detail': 'This batch has no company — cannot create a product.'},
                                status=http.HTTP_400_BAD_REQUEST)
            name = (request.data.get('name') or '').strip()
            if not name:
                return Response({'detail': 'No product name to create.'}, status=http.HTTP_400_BAD_REQUEST)
            uom = request.data.get('uom') or ''
            descr = (request.data.get('description') or '').strip()
            # Tighten: a prefilled name can still carry per-invoice dates / free
            # text ("(... 01-04-2026 ...)"). Create the master under a CLEAN name
            # so a re-scan reuses it instead of minting a dated duplicate; the raw
            # typed name is still remembered below so it auto-maps next time.
            clean = scan_service._tighten_create_name(name)
            from sales.tally_import_run import _get_or_create_product
            ctx = scan_service._ctx(company, request.user)
            try:
                prod = _get_or_create_product(clean, uom, ctx)
            except Exception as e:  # noqa: BLE001
                return Response({'detail': f'Could not create product: {e}'}, status=http.HTTP_400_BAD_REQUEST)
            if prod is None:
                return Response({'detail': f'"{name}" is set to skip in the mapping — pick an existing product instead.'},
                                status=http.HTTP_400_BAD_REQUEST)
            # Learn the name + stamp it onto matching UNMAPPED lines on this bill
            # and the other pending bills of this company, so the same goods on the
            # next invoice already shows as this product.
            targets = {name.lower()}
            if descr:
                targets.add(descr.lower())

            def _stamp(bill_obj):
                changed = False
                for ol in (bill_obj.lines or []):
                    if ol.get('is_charge') or ol.get('product_id'):
                        continue
                    od = (ol.get('description') or '').strip().lower()
                    on = (ol.get('product_name') or '').strip().lower()
                    if (od and od in targets) or (on and on in targets):
                        ol['product_id'] = str(prod.id)
                        ol['product_name'] = prod.product_name
                        changed = True
                if changed:
                    bill_obj.save(update_fields=['lines'])

            try:
                scan_service._remember_map(company, name, product=prod)
                if clean.lower() != name.lower():
                    scan_service._remember_map(company, clean, product=prod)
                if descr and descr.lower() != name.lower():
                    scan_service._remember_map(company, descr, product=prod)
                _stamp(sb)
                siblings = (InvoiceScanBill.objects
                            .filter(batch__company=company)
                            .exclude(pk=sb.pk)
                            .exclude(status__in=['CONFIRMED', 'SKIPPED', 'FAILED']))
                for other in siblings:
                    _stamp(other)
            except Exception:  # noqa: BLE001 — reuse is a convenience, never block the create
                logger.exception('scan product reuse-apply failed')
            return Response({'id': str(prod.id), 'name': prod.product_name,
                             'uom': prod.uom or '', 'sku': prod.sku_code or ''})
        elif action == 'create_transporter':
            # Create a Transporter master from the CARRIER name (the transporter on
            # the bill), not the goods supplier. GSTIN only when the party IS the
            # transporter (no separate carrier name).
            from master.models import Transporter
            company = sb.batch.company
            name = (request.data.get('transporter_name') or sb.transporter_name
                    or sb.vendor_name or '').strip()
            if not name:
                return Response({'detail': 'No transporter name to create.'}, status=http.HTTP_400_BAD_REQUEST)
            # GSTIN only when the party IS the transporter (a pure freight slip, no
            # separate carrier name) — then vendor_gstin is the transporter's own.
            gstin = (sb.vendor_gstin or '').strip()
            gstin = gstin if (len(gstin) == 15 and not (sb.transporter_name or '').strip()) else None
            # Reuse an existing transporter (same GSTIN, else same name) instead of
            # duplicating — GSTIN is unique, so a second freight bill from the same
            # transporter would otherwise error out.
            t = None
            if gstin:
                t = Transporter.objects.filter(gstin__iexact=gstin).first()
            if t is None:
                t = Transporter.objects.filter(name__iexact=name).first()
            if t is None:
                try:
                    import uuid
                    t = Transporter.objects.create(
                        transporter_code=f'TRP-{uuid.uuid4().hex[:8].upper()}',
                        name=name[:255], gstin=gstin, company=company,
                        created_by=request.user)
                except Exception as e:  # noqa: BLE001
                    return Response({'detail': f'Could not create transporter: {e}'}, status=http.HTTP_400_BAD_REQUEST)
            else:
                # Backfill details the scan carries that the existing record lacks.
                upd = []
                if gstin and not (t.gstin or ''):
                    t.gstin = gstin
                    upd.append('gstin')
                if company and not t.company_id:
                    t.company = company
                    upd.append('company')
                if upd:
                    t.save(update_fields=upd)
            sb.transporter = t
            sb.save(update_fields=['transporter'])
        elif action == 'unpost_stock':
            # Undo the stock this scan posted (soft-delete ledger rows, receipt →
            # DRAFT). Bill + lines are kept; only the stock movement is reversed.
            bill = sb.target_bill
            if bill is None:
                return Response({'detail': 'No bill linked to this scan.'}, status=http.HTTP_400_BAD_REQUEST)
            try:
                n = scan_service.unpost_scan_stock(bill, request.user)
            except Exception as e:  # noqa: BLE001
                return Response({'detail': f'Could not undo stock: {e}'}, status=http.HTTP_400_BAD_REQUEST)
            msg = f'Removed {n} stock row(s) from the ledger.' if n else 'No stock was posted for this bill.'
            return Response({'detail': msg, 'removed': n})
        elif action == 'confirm':
            replace = str(request.data.get('replace', '')).lower() in ('1', 'true', 'yes')
            remember = str(request.data.get('remember', 'true')).lower() in ('1', 'true', 'yes')
            ignore_duplicate = str(request.data.get('ignore_duplicate', '')).lower() in ('1', 'true', 'yes')
            try:
                scan_service.commit_scan_bill(sb, request.user, replace=replace,
                                              remember=remember, ignore_duplicate=ignore_duplicate)
            except scan_service.DuplicateBillError as e:
                # A bill already exists for this scan. This is NOT a failure — it's a
                # prompt: hand the frontend that bill's id so it can offer MERGE
                # (attach this scan to it — one bill, no duplicate). Returned as a
                # normal 200 with a `needs_merge_choice` flag (NOT a 4xx), so it does
                # not show up as a red error in the console / network log — the
                # operator simply picks merge vs separate.
                payload = {'detail': str(e), 'needs_merge_choice': True}
                dup = getattr(e, 'bill', None)
                if dup is not None:
                    from decimal import Decimal as _D
                    payload['duplicate_bill'] = {
                        'id': str(dup.id),
                        'bill_no': dup.bill_no,
                        'invoice_no': dup.vendor_invoice_no or None,
                        'total': str(_D(str(dup.total_amount or 0))),
                        'from_tally': bool(dup.tally_guid),
                    }
                return Response(payload, status=http.HTTP_200_OK)
            except ValueError as e:
                return Response({'detail': str(e)}, status=http.HTTP_400_BAD_REQUEST)
            except Exception as e:  # noqa: BLE001
                logger.exception('scan confirm failed')
                return Response({'detail': f'Commit failed: {e}'}, status=http.HTTP_400_BAD_REQUEST)
        elif action == 'revert':
            # Undo a mistaken confirm — see revert_scan_bill's docstring for
            # exactly what does and doesn't get torn down.
            try:
                scan_service.revert_scan_bill(sb, request.user)
            except ValueError as e:
                return Response({'detail': str(e)}, status=http.HTTP_400_BAD_REQUEST)
            except Exception as e:  # noqa: BLE001
                logger.exception('scan revert failed')
                return Response({'detail': f'Revert failed: {e}'}, status=http.HTTP_400_BAD_REQUEST)
        elif action == 'replace_freight_doc':
            # Attach a picked freight PDF/image as THIS bill's document (replace it)
            # and mark it a freight bill — NO AI re-read (no cost), NO new bill (no
            # duplicate). The operator fills the freight amount / TDS. The review's
            # preview then shows this freight bill right here.
            f = request.FILES.get('file') or (request.FILES.getlist('files') or [None])[0]
            if f is None:
                return Response({'detail': 'No file uploaded.'}, status=http.HTTP_400_BAD_REQUEST)
            from .scan_models import InvoiceScanDocument
            doc = InvoiceScanDocument.objects.create(
                batch=sb.batch, file=f,
                original_name=(getattr(f, 'name', '') or 'freight')[:255],
                content_type=(getattr(f, 'content_type', '') or '')[:100],
                status='EXTRACTED', created_by=request.user)
            sb.document = doc
            sb.bill_type = 'FREIGHT'
            if not sb.transporter_id:
                sb.transporter = scan_service._match_transporter(sb)
            sb.save(update_fields=['document', 'bill_type', 'transporter'])
        else:
            return Response({'detail': f'Unknown action {action}.'}, status=http.HTTP_400_BAD_REQUEST)
        return Response(ScanBillSerializer(sb, context={'request': request, 'detail': True}).data)


class ScanConvertedView(APIView):
    """Recently CONVERTED scan invoices (Confirmed → written to a bill).

    Shown as a separate list under Recent Scans so the operator sees what has
    already been pushed to Bills.
    """
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def get(self, request):
        qs = (InvoiceScanBill.objects.filter(status='CONFIRMED')
              .select_related('matched_bill', 'created_bill', 'matched_vendor', 'batch',
                              'created_local_freight', 'created_freight_advice', 'transporter',
                              'freight_linked_bill'))
        company_id = request.query_params.get('company')
        if company_id:
            qs = qs.filter(batch__company_id=company_id)
        qs = list(qs.order_by('-committed_at')[:100])
        # Which bills still carry scan-posted stock (one bulk query, no N+1) — so
        # the list can offer an "Undo stock" button only where there is stock.
        grn_ids = [b.receipt_advice_id for b in
                   (sb.matched_bill or sb.created_bill for sb in qs)
                   if b and b.receipt_advice_id]
        posted = set()
        if grn_ids:
            from inventory.models import InventoryLedger
            posted = set(InventoryLedger.objects.filter(
                source_document_type='PurchaseReceiptAdvice',
                source_document_id__in=grn_ids, is_active=True)
                .values_list('source_document_id', flat=True))
        out = []
        for sb in qs:
            if sb.bill_type == 'FREIGHT':
                # Freight confirmations don't create a VendorBill — they create a
                # Local/Inward freight record (or link to an existing Tally bill).
                # Surface the freight number + a link to the right page.
                if sb.created_local_freight_id:
                    ref_no = sb.created_local_freight.freight_no
                    link = '/freight/local'
                elif sb.created_freight_advice_id:
                    ref_no = sb.created_freight_advice.advice_no
                    link = f'/freight/purchase/{sb.created_freight_advice_id}'
                elif sb.matched_bill_id:
                    ref_no = sb.matched_bill.bill_no
                    link = f'/purchase/bills/{sb.matched_bill_id}'
                elif sb.freight_linked_bill_id:
                    # Freight attached to a goods bill — show that bill.
                    ref_no = sb.freight_linked_bill.bill_no
                    link = f'/purchase/bills/{sb.freight_linked_bill_id}'
                else:
                    ref_no, link = None, None
                out.append({
                    'id': str(sb.id),
                    'kind': 'FREIGHT',
                    'vendor_name': (sb.transporter.name if sb.transporter_id
                                    else sb.transporter_name or sb.vendor_name) or '',
                    'invoice_no': sb.invoice_no,
                    'invoice_date': sb.invoice_date,
                    'total_amount': str(sb.total_amount),
                    'bill_no': ref_no,
                    'link': link,
                    'committed_at': sb.committed_at,
                    'stock_posted': False,
                })
                continue
            bill = sb.matched_bill or sb.created_bill
            out.append({
                'id': str(sb.id),
                'kind': 'GOODS',
                'vendor_name': (sb.matched_vendor.vendor_name if sb.matched_vendor_id and sb.matched_vendor else sb.vendor_name) or '',
                'invoice_no': sb.invoice_no,
                'invoice_date': sb.invoice_date,
                'total_amount': str(sb.total_amount),
                'bill_no': bill.bill_no if bill else None,
                'bill_id': str(bill.id) if bill else None,
                'link': f'/purchase/bills/{bill.id}' if bill else None,
                'committed_at': sb.committed_at,
                'stock_posted': bool(bill and bill.receipt_advice_id in posted),
            })
        return Response(out)


class ScanFreightBillsView(APIView):
    """Pending scanned FREIGHT bills (bill_type=FREIGHT, not yet confirmed) — for
    the Scan page's separate Freight view. Each shows the transporter, amount and
    the goods bill it maps to (from the invoice no written on the slip)."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def get(self, request):
        qs = (InvoiceScanBill.objects.filter(bill_type='FREIGHT')
              .exclude(status__in=['CONFIRMED', 'SKIPPED', 'FAILED'])
              .select_related('batch', 'transporter', 'freight_linked_bill'))
        company_id = request.query_params.get('company')
        if company_id:
            qs = qs.filter(batch__company_id=company_id)
        out = [{
            'id': str(sb.id),
            'batch': str(sb.batch_id),
            'transporter_name': (sb.transporter.name if sb.transporter_id
                                 else sb.transporter_name or sb.vendor_name) or '',
            'freight_invoice_no': sb.freight_invoice_no or sb.invoice_no or '',
            'freight_amount': str(sb.freight_amount or sb.total_amount or 0),
            'freight_ref_no': sb.freight_ref_no or '',
            'freight_linked_bill_no': (sb.freight_linked_bill.bill_no if sb.freight_linked_bill_id else ''),
            'scanned_at': sb.created_at,
            'status': sb.status,
        } for sb in qs.order_by('-created_at')[:200]]
        return Response(out)


class GstinLookupView(APIView):
    """GSTIN → official business name (gstincheck.co.in)."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def get(self, request):
        from .gst_lookup import lookup_gstin
        return Response(lookup_gstin(request.query_params.get('gstin', '')))


class ScanSuggestView(APIView):
    """On-demand fuzzy suggestions for mapping a scanned name to a master."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def get(self, request):
        kind = request.query_params.get('kind', 'product')
        q = request.query_params.get('q', '')
        company = None
        company_id = request.query_params.get('company')
        if company_id:
            from core.models import Company
            company = Company.objects.filter(pk=company_id).first()
        if not q.strip():
            return Response([])
        from sales.tally_import_run import suggest_party_candidates
        return Response(suggest_party_candidates(q, kind, company))


class ScanProductSearchView(APIView):
    """Product matches for the 'Map product' popup — fuzzy candidates from the
    item master PLUS where each has been used before (which bills), so the
    operator can confirm it's the right existing product before mapping. A
    product with no match here is a genuinely new one to create."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def get(self, request):
        q = request.query_params.get('q', '')
        if not q.strip():
            return Response([])
        company = None
        company_id = request.query_params.get('company')
        if company_id:
            from core.models import Company
            company = Company.objects.filter(pk=company_id).first()

        from sales.tally_import_run import suggest_party_candidates
        from master.models import Product
        from purchase.models import VendorBillLine
        cands = suggest_party_candidates(q, 'product', company, limit=8)
        prods = {str(p.id): p for p in Product.objects.filter(
            id__in=[c['id'] for c in cands]).only('id', 'product_name', 'sku_code', 'uom')}

        out = []
        for c in cands:
            p = prods.get(str(c['id']))
            if not p:
                continue
            lines = VendorBillLine.objects.filter(product_id=p.id, is_active=True)
            if company:
                lines = lines.filter(bill__vendor__company_id=company.id)
            times = lines.count()
            recent = []
            for bl in (lines.select_related('bill', 'bill__vendor')
                       .order_by('-bill__bill_date')[:3]):
                b = bl.bill
                recent.append({
                    'bill_no': b.bill_no,
                    'vendor': (b.vendor.vendor_name if b.vendor_id else '') or '',
                    'date': b.bill_date.isoformat() if b.bill_date else None,
                    'qty': str(bl.quantity) if bl.quantity is not None else '',
                })
            out.append({
                'id': str(p.id), 'name': p.product_name, 'sku': p.sku_code or '',
                'uom': p.uom or '', 'times_used': times, 'recent': recent,
            })
        return Response(out)


class ScanBillSearchView(APIView):
    """Search existing VendorBills (imported from Tally / entered by hand) so a
    freight scan can be linked to a bill that is ALREADY in the system — the
    "Pick from Tally" side of the two-way freight flow — instead of creating a
    new freight record. Matches on bill no, supplier invoice no, or vendor name.
    Company-scoped; excludes scan-created bills and opening-balance carriers."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def get(self, request):
        from decimal import Decimal
        from django.db.models import Q
        from purchase.models import VendorBill
        q = (request.query_params.get('q') or '').strip()
        if not q:
            return Response([])
        include_scan = str(request.query_params.get('include_scan', '')).lower() in ('1', 'true', 'yes')
        bills = (VendorBill.objects.filter(is_active=True)
                 .exclude(tally_guid__startswith='OPENING')
                 .exclude(vendor_invoice_no__iexact='OPENING')
                 .exclude(bill_no__iexact='OPENING')
                 .select_related('vendor', 'vendor__company'))
        if not include_scan:
            # "Pick from Tally": only bills already in the system, not scan-created.
            # Freight linking passes include_scan=1 so ANY goods bill can be chosen.
            scan_created = InvoiceScanBill.objects.filter(
                created_bill__isnull=False).values('created_bill')
            bills = bills.exclude(id__in=scan_created)
        company_id = request.query_params.get('company')
        if company_id:
            bills = bills.filter(vendor__company_id=company_id)
        bills = bills.filter(
            Q(bill_no__icontains=q) | Q(vendor_invoice_no__icontains=q)
            | Q(vendor__vendor_name__icontains=q))
        out = []
        for b in bills.order_by('-bill_date')[:25]:
            out.append({
                'id': str(b.id),
                'bill_no': b.bill_no,
                'invoice_no': b.vendor_invoice_no or None,
                'vendor': (b.vendor.vendor_name if b.vendor_id else '') or '',
                'company': (b.vendor.company.legal_name if (b.vendor_id and b.vendor.company_id) else '') or '',
                'bill_date': b.bill_date.isoformat() if b.bill_date else None,
                'total': str(Decimal(str(b.total_amount or 0))),
                'from_tally': bool(b.tally_guid),
            })
        return Response(out)


class ScanLinkCandidatesView(APIView):
    """For the freight-link popup: the purchase bill SUGGESTED by the number the
    transporter wrote on the slip (via _match_bill_by_ref), plus that ref text.
    Suggestion only — the operator confirms the link. Automatic linking at scan
    time is disabled; this endpoint just surfaces the same match as a hint."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def get(self, request, pk):
        sb = get_object_or_404(InvoiceScanBill, pk=pk)
        ref = (sb.freight_ref_no or '').strip()
        bill = scan_service._match_bill_by_ref(ref) if ref else None

        def _fmt(b):
            if b is None:
                return None
            return {
                'id': str(b.id), 'bill_no': b.bill_no,
                'invoice_no': b.vendor_invoice_no or None,
                'vendor': (b.vendor.vendor_name if b.vendor_id else '') or '',
                'company': (b.vendor.company.legal_name if (b.vendor_id and b.vendor.company_id) else '') or '',
                'bill_date': b.bill_date.isoformat() if b.bill_date else None,
                'total': str(b.total_amount or 0),
                'from_tally': bool(b.tally_guid),
            }
        return Response({'ref_no': ref, 'suggested': _fmt(bill)})


class ScanLocationsView(APIView):
    """Warehouses (with their godowns) for the stock-intake dropdowns in the
    review popup. Lightweight + auth-only so the scan operator never needs the
    heavier Warehouse-module permission just to pick a receipt location."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def get(self, request):
        from core.models import Warehouse, Godown
        company_id = request.query_params.get('company')
        whs = Warehouse.objects.filter(is_active=True, active_flag=True)
        if company_id:
            whs = whs.filter(company_id=company_id)
        whs = whs.order_by('warehouse_code')
        gd_by_wh = {}
        for g in (Godown.objects.filter(is_active=True, active_flag=True,
                                        warehouse__in=whs)
                  .order_by('godown_name')):
            gd_by_wh.setdefault(str(g.warehouse_id), []).append(
                {'id': str(g.id), 'name': g.godown_name, 'code': g.godown_code})
        out = []
        for w in whs:
            out.append({
                'id': str(w.id), 'name': w.name, 'code': w.warehouse_code,
                'type': w.warehouse_type,
                'godowns': gd_by_wh.get(str(w.id), []),
            })
        return Response(out)


class ScanDocRetryView(APIView):
    """Re-run extraction on a document that FAILED (nothing lost silently)."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def post(self, request, pk):
        doc = get_object_or_404(InvoiceScanDocument, pk=pk)
        doc.status = 'PENDING'
        doc.error_message = ''
        doc.save(update_fields=['status', 'error_message'])
        scan_service.process_document(doc)
        batch = doc.batch
        batch.bill_count = batch.bills.count()
        batch.save(update_fields=['bill_count'])
        return Response(_batch_payload(batch, request))


class ScanDocFileView(APIView):
    """Stream the scanned file itself, from OUR origin.

    In production the file lives on Cloudflare R2, so the storage URL is
    absolute and cross-origin. A browser can't read that from the app's origin:
    R2 serves no `Access-Control-Allow-Origin`, so the fetch is blocked and the
    preview dies with an opaque "network error". Proxying the bytes through
    Django makes it same-origin, so CORS never applies — the same trick the
    Zoho photo endpoint already uses ("the browser never sees Zoho"). It also
    keeps the presigned R2 URL out of the browser entirely.
    """
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def get(self, request, pk):
        from django.http import Http404

        from common.file_stream import stream_stored_file

        doc = get_object_or_404(InvoiceScanDocument, pk=pk)
        if not doc.file:
            raise Http404('Scan file is not retrievable: no file on the record.')
        try:
            # Streams in chunks instead of buffering the object. `.open('rb')` on
            # an R2 file pulled the WHOLE thing into memory first - a 14 MB
            # preview was 14 MB of RAM, on a 2 GB box. Same url, same headers.
            return stream_stored_file(
                doc.file,
                content_type=(doc.content_type or 'application/pdf'),
                filename=(doc.original_name or 'scan.pdf'),
            )
        except Exception as e:  # noqa: BLE001
            logger.exception('scan file open failed for %s', pk)
            raise Http404(f'Scan file is not retrievable: {e}')


class ScanTypeOptionView(APIView):
    """List + add the operator-editable Scan-Inbox dropdown options, saved on the
    SERVER so every user sees the same list (the Purchase-type and the item-line
    Charge-type "+"). Reading is open to any Scan-Inbox user (module is a lookup);
    ADDING needs the 'Scan Categories' module's create permission."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Categories'

    KINDS = {'PURCHASE_TYPE', 'CHARGE_TYPE'}

    def get(self, request):
        from .scan_models import ScanTypeOption
        qs = ScanTypeOption.objects.filter(is_active=True)
        kind = (request.query_params.get('kind') or '').upper()
        if kind in self.KINDS:
            qs = qs.filter(kind=kind)
        return Response([{'id': str(o.id), 'kind': o.kind, 'label': o.label}
                         for o in qs.order_by('kind', 'label')])

    def post(self, request):
        from .scan_models import ScanTypeOption
        kind = (request.data.get('kind') or '').upper()
        label = (request.data.get('label') or '').strip()
        if kind not in self.KINDS:
            return Response({'detail': 'kind must be PURCHASE_TYPE or CHARGE_TYPE.'},
                            status=http.HTTP_400_BAD_REQUEST)
        if not label:
            return Response({'detail': 'A name is required.'}, status=http.HTTP_400_BAD_REQUEST)
        # Case-insensitive de-dup: reuse the existing option instead of a second row.
        existing = ScanTypeOption.objects.filter(
            kind=kind, label__iexact=label, is_active=True).first()
        if existing:
            return Response({'id': str(existing.id), 'kind': existing.kind,
                             'label': existing.label}, status=http.HTTP_200_OK)
        o = ScanTypeOption.objects.create(kind=kind, label=label[:100], created_by=request.user)
        return Response({'id': str(o.id), 'kind': o.kind, 'label': o.label},
                        status=http.HTTP_201_CREATED)


class ScanTypeOptionDetailView(APIView):
    """Remove (soft-delete) an operator-added option — 'Scan Categories' delete."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Categories'

    def delete(self, request, pk):
        from .scan_models import ScanTypeOption
        o = get_object_or_404(ScanTypeOption, pk=pk)
        o.is_active = False
        o.save(update_fields=['is_active'])
        return Response(status=http.HTTP_204_NO_CONTENT)


def _map_row(m):
    return {
        'id': str(m.id), 'tally_name': m.tally_name,
        'company': str(m.company_id) if m.company_id else None,
        'company_name': m.company.legal_name if m.company_id else None,
        'vendor': str(m.vendor_id) if m.vendor_id else None,
        'vendor_name': m.vendor.vendor_name if m.vendor_id else None,
        'product': str(m.product_id) if m.product_id else None,
        'product_name': m.product.product_name if m.product_id else None,
        'customer_name': m.customer.customer_name if m.customer_id else None,
        'skip': m.skip,
    }


class MappingListView(APIView):
    """List saved Tally/invoice name → ERP-master mappings (TallyPartyMap)."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def get(self, request):
        from sales.models import TallyPartyMap
        qs = TallyPartyMap.objects.select_related('vendor', 'product', 'customer', 'company')
        company = request.query_params.get('company')
        if company:
            qs = qs.filter(company_id=company)
        q = (request.query_params.get('q') or '').strip()
        if q:
            qs = qs.filter(tally_name__icontains=q)
        kind = request.query_params.get('kind')
        if kind == 'vendor':
            qs = qs.filter(vendor__isnull=False)
        elif kind == 'product':
            qs = qs.filter(product__isnull=False)
        return Response([_map_row(m) for m in qs.order_by('tally_name')[:1000]])


class MappingDetailView(APIView):
    """Edit (remap) or delete a single mapping."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Scan Inbox'

    def patch(self, request, pk):
        from sales.models import TallyPartyMap
        m = get_object_or_404(TallyPartyMap, pk=pk)
        if 'vendor' in request.data:
            from master.models import Vendor
            m.vendor = Vendor.objects.filter(pk=request.data['vendor']).first() if request.data['vendor'] else None
        if 'product' in request.data:
            from master.models import Product
            m.product = Product.objects.filter(pk=request.data['product']).first() if request.data['product'] else None
        if 'skip' in request.data:
            m.skip = str(request.data['skip']).lower() in ('1', 'true', 'yes')
        m.save()
        return Response(_map_row(m))

    def delete(self, request, pk):
        from sales.models import TallyPartyMap
        get_object_or_404(TallyPartyMap, pk=pk).delete()
        return Response(status=http.HTTP_204_NO_CONTENT)


def _batch_payload(batch, request):
    bills = batch.bills.select_related('document', 'matched_bill', 'matched_vendor', 'created_bill')
    docs = batch.documents.all()
    return {
        'batch': ScanBatchSerializer(batch, context={'request': request}).data,
        'bills': ScanBillSerializer(bills, many=True, context={'request': request}).data,
        # Include documents so the UI can surface FAILED reads (with a Retry).
        'documents': ScanDocumentSerializer(docs, many=True, context={'request': request}).data,
    }

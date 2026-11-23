"""Serializers for the invoice-scan inbox."""
from rest_framework import serializers

from .scan_models import InvoiceScanBatch, InvoiceScanDocument, InvoiceScanBill


class ScanDocumentSerializer(serializers.ModelSerializer):
    file_url = serializers.SerializerMethodField()

    class Meta:
        model = InvoiceScanDocument
        fields = ['id', 'original_name', 'content_type', 'page_count',
                  'status', 'error_message', 'file_url']

    def get_file_url(self, obj):
        # Always our OWN, same-origin endpoint — never the storage URL.
        #
        # In prod the file sits on R2, whose URL is absolute and cross-origin;
        # R2 sends no `Access-Control-Allow-Origin`, so the browser refuses to
        # let the preview read it and the fetch fails as an opaque "network
        # error". Serving the bytes through Django sidesteps CORS entirely (and
        # keeps the presigned R2 link out of the browser). In dev this path
        # rides the Vite proxy, so it stays same-origin there too.
        if not obj.file:
            return None
        return f'/api/purchase/scan/documents/{obj.id}/file/'


class ScanBillSerializer(serializers.ModelSerializer):
    """Row/detail for one detected invoice."""
    document = ScanDocumentSerializer(read_only=True)
    matched_bill_no = serializers.CharField(source='matched_bill.bill_no', read_only=True, default=None)
    company_gstin = serializers.CharField(source='batch.company.gstin', read_only=True, default='')
    # Per-bill company (override) + the batch default so the review can show a
    # company dropdown that defaults to the batch's company.
    company_name = serializers.SerializerMethodField()
    batch_company = serializers.CharField(source='batch.company_id', read_only=True, default=None)
    batch_company_name = serializers.CharField(source='batch.company.legal_name', read_only=True, default='')

    def get_company_name(self, obj):
        c = obj.company or (obj.batch.company if obj.batch_id else None)
        return (getattr(c, 'legal_name', '') or '') if c else ''
    matched_vendor_name = serializers.CharField(source='matched_vendor.vendor_name', read_only=True, default=None)
    created_bill_no = serializers.CharField(source='created_bill.bill_no', read_only=True, default=None)
    items_total = serializers.SerializerMethodField()
    vendor_candidates = serializers.SerializerMethodField()
    transporter_master_name = serializers.CharField(source='transporter.name', read_only=True, default=None)
    transporter_candidates = serializers.SerializerMethodField()
    duplicate = serializers.SerializerMethodField()
    matched_bill_info = serializers.SerializerMethodField()
    candidate_bills = serializers.SerializerMethodField()
    warehouse_name = serializers.CharField(source='warehouse.name', read_only=True, default=None)
    godown_name = serializers.CharField(source='godown.godown_name', read_only=True, default=None)
    # Existing shared freight this bill will be linked to on confirm (one slip,
    # many bills). `link_freight` writable FK; the rest read-only display.
    link_freight_no = serializers.CharField(source='link_freight.advice_no', read_only=True, default='')
    link_freight_transporter = serializers.CharField(source='link_freight.transporter.name', read_only=True, default='')
    freight_linked_bill_no = serializers.CharField(source='freight_linked_bill.bill_no', read_only=True, default='')

    class Meta:
        model = InvoiceScanBill
        fields = [
            'id', 'batch', 'document', 'page_start', 'page_end',
            'company', 'company_name', 'batch_company', 'batch_company_name',
            'vendor_name', 'vendor_gstin', 'company_gstin', 'invoice_no', 'invoice_date', 'due_date', 'voucher_type',
            'subtotal', 'tax_amount', 'total_amount', 'tds_amount', 'lines', 'confidence',
            'matched_bill', 'matched_bill_no', 'matched_vendor', 'matched_vendor_name',
            'created_bill', 'created_bill_no', 'reconciled', 'status',
            'update_stock', 'warehouse', 'warehouse_name', 'godown', 'godown_name',
            'bill_type', 'freight_target', 'transporter', 'transporter_name',
            'transporter_master_name', 'lorry_no', 'freight_amount', 'category',
            'freight_tds', 'freight_roundoff', 'freight_weight_charge',
            'is_dc', 'dc_no', 'dc_from', 'dc_to', 'dc_material', 'dc_value',
            'freight_invoice_no', 'freight_invoice_date', 'freight_ref_no', 'freight_linked_bill_no',
            'transporter_candidates', 'created_local_freight', 'created_freight_advice',
            'link_freight', 'link_freight_no', 'link_freight_transporter',
            'items_total', 'vendor_candidates', 'duplicate', 'matched_bill_info',
            'candidate_bills', 'committed_at', 'error_message',
        ]
        read_only_fields = ['batch', 'status', 'reconciled', 'matched_bill',
                            'created_bill', 'committed_at']

    def get_items_total(self, obj):
        from decimal import Decimal
        # Scanned line amounts arrive as free text ("750/-", "1,250.00", "Rs.750",
        # "-" …), so a bare Decimal() raises InvalidOperation and 500s the whole
        # review response. Reuse the service's tolerant parser (same one the commit
        # path's _sum_lines uses) so a non-numeric amount counts as 0, never crashes.
        from .scan_service import _to_dec
        return str(sum((_to_dec(l.get('amount')) for l in (obj.lines or [])
                        if isinstance(l, dict)), Decimal('0')))

    def get_matched_bill_info(self, obj):
        """The existing bill this scan will MERGE INTO (Option A: keep this bill —
        which holds the payment — and stamp the scan's invoice-no / date /
        products onto it). Surfaced so the operator reviews its Paid status
        before confirming. Detail view only (avoids an N+1 on the list)."""
        if not self.context.get('detail') or not obj.matched_bill_id:
            return None
        b = obj.matched_bill
        from decimal import Decimal
        paid = Decimal(str(b.amount_paid or 0))
        last = b.payments.order_by('-payment_date').first()
        return {
            'bill_no': b.bill_no,
            'invoice_no': b.vendor_invoice_no or None,
            'bill_date': b.bill_date.isoformat() if b.bill_date else None,
            'total': str(Decimal(str(b.total_amount or 0))),
            'paid': str(paid),
            'is_paid': paid > 0 or b.status == 'PAID',
            'status': b.status,
            'from_tally': bool(b.tally_guid),
            'payment_date': last.payment_date.isoformat() if last and last.payment_date else None,
        }

    def get_candidate_bills(self, obj):
        """The vendor's bills the operator can match this scan to — so they can
        verify the auto-match or pick the RIGHT one by hand (matched or not).
        Amount-matches are flagged and floated to the top. Detail view only."""
        if not self.context.get('detail') or not obj.matched_vendor_id:
            return None
        from decimal import Decimal
        from django.db.models import Q
        from purchase.models import VendorBill

        # Which bills were created BY a scan — used only to RANK (real accounting
        # bills first), NOT to hide them. Hiding scan copies meant re-scanning a
        # bill that so far exists only as an earlier scan showed "no related bill"
        # and forced a duplicate — the exact problem we are fixing.
        scan_created = set(InvoiceScanBill.objects.filter(
            created_bill__isnull=False).values_list('created_bill', flat=True))

        bills, seen = [], set()
        inv = (obj.invoice_no or '').strip()
        if inv:
            # The vendor's bill(s) with the SAME invoice number (opening-balance
            # carriers excluded). Real bills (Tally/Zoho/manual) are floated ABOVE
            # scan copies so "recommended" prefers a real bill when one exists, but
            # a prior scan's copy is STILL offered so you can merge, not duplicate.
            exact = list(VendorBill.objects.filter(
                    vendor_id=obj.matched_vendor_id, is_active=True)
                    .filter(Q(vendor_invoice_no__iexact=inv) | Q(bill_no__iexact=inv))
                    .exclude(status='CANCELLED')    # never merge into a cancelled bill
                    .exclude(tally_guid__startswith='OPENING')
                    .exclude(vendor_invoice_no__iexact='OPENING')
                    .exclude(bill_no__iexact='OPENING')
                    .order_by('-bill_date')[:10])
            exact.sort(key=lambda b: b.id in scan_created)   # real (False) before scan (True)
            for b in exact:
                bills.append((b, True))     # True = invoice number matches
                seen.add(b.id)

        # ALSO offer the bill the shared duplicate detector would flag — the SAME
        # purchase found even when the invoice number DIFFERS (a Tally-imported
        # bill often stores a different / blank number, or a rounded amount or a
        # day-shifted date). Without this the picker showed nothing, so scanning a
        # bill already in Tally forced "create a new bill" -> a duplicate. It is
        # only OFFERED (flagged "same amount + date"), never auto-selected, so the
        # operator still confirms the merge.
        try:
            from purchase.zoho_mismatch import find_existing_bill
            dup = find_existing_bill(obj.matched_vendor, inv,
                                     obj.total_amount, obj.invoice_date)
            if (dup is not None and dup.is_active and dup.id not in seen
                    and not (dup.tally_guid or '').startswith('OPENING')):
                bills.insert(0, (dup, False))   # False = matched by amount+date
                seen.add(dup.id)
        except Exception:                       # never let the detector break the picker
            pass

        # ALSO offer the vendor's bills with the SAME amount within a few days,
        # even when the invoice number does not line up. A Blow Packaging invoice
        # OCR-read as "2710/..." never matched its Tally "271U/..." original — a
        # different number AND a day-shifted date (dup 05-May vs keeper 06-May) —
        # so find_existing_bill (exact-date arm) missed it, the picker stayed
        # empty, and a duplicate got written. Same firm + same amount within a
        # 5-day window is almost certainly the same bill; still only OFFERED
        # (flagged "same amount"), never auto-written. CANCELLED bills are
        # excluded, so a cancelled twin is skipped and the live Tally keeper is
        # what surfaces to merge into.
        try:
            from datetime import timedelta
            amt = Decimal(str(obj.total_amount or 0))
            if amt and obj.matched_vendor_id and obj.invoice_date:
                near = (VendorBill.objects.filter(vendor_id=obj.matched_vendor_id, is_active=True)
                        .exclude(status='CANCELLED')
                        .exclude(tally_guid__startswith='OPENING')
                        .filter(bill_date__range=(obj.invoice_date - timedelta(days=5),
                                                  obj.invoice_date + timedelta(days=5)))
                        .order_by('-bill_date'))
                tol = max(Decimal('1'), amt * Decimal('0.005'))
                for b in near[:25]:
                    if b.id in seen:
                        continue
                    if abs(Decimal(str(b.total_amount or 0)) - amt) <= tol:
                        bills.append((b, False))     # False = matched by amount (+near date)
                        seen.add(b.id)
        except Exception:
            pass

        out = []
        for idx, (b, inv_match) in enumerate(bills):
            out.append({
                'id': str(b.id),
                'bill_no': b.bill_no,
                'invoice_no': b.vendor_invoice_no or None,
                'bill_date': b.bill_date.isoformat() if b.bill_date else None,
                'total': str(Decimal(str(b.total_amount or 0))),
                'amount_paid': str(Decimal(str(b.amount_paid or 0))),
                'status': b.status,
                'from_tally': bool(b.tally_guid),
                'invoice_match': inv_match,      # True = same invoice no; False = amount+date
                'amount_match': not inv_match,   # flagged so the UI badges it honestly
                'recommended': idx == 0,         # the strongest match is THE match
            })
        return out

    def get_duplicate(self, obj):
        """Warn if this invoice would create a duplicate — a bill already exists
        for its number, or another scan already converted it. Detail-only."""
        if not self.context.get('detail'):
            return None
        if obj.matched_bill_id or obj.status == 'CONFIRMED':
            return None   # matching an existing bill is intended, not a dup
        inv = (obj.invoice_no or '').strip()
        if not inv:
            return None
        from purchase.models import VendorBill
        # Only the SAME vendor billing the same number twice is a duplicate.
        # Two different vendors sharing an invoice number ("3/2026-2027") is
        # ordinary and must not be flagged — matches the confirm-time guard.
        if obj.matched_vendor_id:
            b = VendorBill.objects.filter(
                vendor_id=obj.matched_vendor_id, vendor_invoice_no__iexact=inv).first()
            if b:
                return f'A bill for invoice "{inv}" already exists for this vendor ({b.bill_no}).'
        from .scan_models import InvoiceScanBill
        # Same reasoning: scope to the vendor, not just the company, or every
        # vendor that happens to reuse an invoice number trips this.
        if obj.matched_vendor_id:
            company = obj.batch.company if obj.batch_id else None
            prior = (InvoiceScanBill.objects.filter(status='CONFIRMED', invoice_no__iexact=inv,
                                                    batch__company=company,
                                                    matched_vendor_id=obj.matched_vendor_id)
                     .exclude(pk=obj.pk).first())
            if prior:
                return f'Invoice "{inv}" was already converted from an earlier scan for this vendor.'
        return None

    def get_transporter_candidates(self, obj):
        if not self.context.get('detail') or obj.transporter_id:
            return None
        from master.models import Transporter
        import difflib
        carrier = (obj.transporter_name or '').strip()
        name = carrier or (obj.vendor_name or '').strip()
        gstin = (obj.vendor_gstin or '').strip()
        if not carrier and len(gstin) == 15:
            t = Transporter.objects.filter(gstin__iexact=gstin).first()
            if t:
                return [{'id': str(t.id), 'name': t.name}]
        if not name:
            return []
        pool = list(Transporter.objects.filter(is_active=True).only('id', 'name')[:600])
        scored = []
        for t in pool:
            r = difflib.SequenceMatcher(None, name.lower(), (t.name or '').lower()).ratio()
            if r >= 0.5:
                scored.append((r, t))
        scored.sort(key=lambda x: -x[0])
        return [{'id': str(t.id), 'name': t.name} for _, t in scored[:4]]

    def get_vendor_candidates(self, obj):
        # Only on detail (single-object) to avoid fuzzy-scanning per row in lists.
        if not self.context.get('detail'):
            return None
        if obj.matched_vendor_id:
            return []
        from sales.tally_import_run import suggest_party_candidates
        company = obj.batch.company if obj.batch_id else None
        # Pass the OCR'd seller GSTIN so an exact tax-ID match surfaces first,
        # even when the printed name differs from the ERP spelling.
        return suggest_party_candidates(obj.vendor_name, 'vendor', company,
                                        gstin=getattr(obj, 'vendor_gstin', ''))


class ScanBatchSerializer(serializers.ModelSerializer):
    company_name = serializers.CharField(source='company.legal_name', read_only=True, default=None)
    counts = serializers.SerializerMethodField()
    type_stats = serializers.SerializerMethodField()
    file_name = serializers.SerializerMethodField()

    class Meta:
        model = InvoiceScanBatch
        fields = ['id', 'company', 'company_name', 'status', 'note',
                  'doc_count', 'bill_count', 'counts', 'type_stats', 'file_name',
                  'error_message', 'created_at']

    def get_file_name(self, obj):
        """The uploaded PDF/image name, so the operator can tell at a glance which
        file a scan came from. Most batches are one file; when a batch bundled
        several, return the first and let doc_count signal the rest."""
        first = next(iter(obj.documents.all()), None)
        return (getattr(first, 'original_name', '') or '') if first else ''

    def get_counts(self, obj):
        from django.db.models import Count
        rows = obj.bills.values('status').annotate(n=Count('id'))
        return {r['status']: r['n'] for r in rows}

    def get_type_stats(self, obj):
        """Per-type counts so the Recent-scans list can honour the Purchase vs
        Freight filter: total goods/freight bills in the batch, and how many of
        each are still pending (not yet confirmed or skipped). The Purchase view
        shows batches that have goods bills and counts only goods as "bills left";
        freight-only batches drop out of the Purchase view entirely."""
        from django.db.models import Count, Q
        done = ['CONFIRMED', 'SKIPPED']
        rows = obj.bills.values('bill_type').annotate(
            total=Count('id'),
            pending=Count('id', filter=~Q(status__in=done)),
        )
        g = next((r for r in rows if r['bill_type'] == 'GOODS'), None)
        fr = next((r for r in rows if r['bill_type'] == 'FREIGHT'), None)
        return {
            'goods_total': g['total'] if g else 0,
            'goods_pending': g['pending'] if g else 0,
            'freight_total': fr['total'] if fr else 0,
            'freight_pending': fr['pending'] if fr else 0,
        }

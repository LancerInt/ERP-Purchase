from django.apps import AppConfig


class PurchaseConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'purchase'
    verbose_name = 'Purchase Management'

    def ready(self):
        # Wire signals (PO → ProductMismatchLog backfill).
        from . import signals  # noqa: F401
        # Audit trail — parent-document Purchase models. The 14 manual
        # AuditLog calls scattered through views.py cover workflow verbs
        # (approve, cancel, split, convert-held, etc.); these auto-logs
        # add the missing CRUD events (record created, edited, deleted)
        # so the per-record activity tab has a full timeline. Line rows
        # are deliberately excluded.
        from common.audit import register_audited_model
        from .models import (
            PurchaseRequest,
            RFQHeader,
            QuoteResponse,
            QuoteEvaluation,
            PurchaseOrder,
            ReceiptAdvice,
            VendorBill,
            PaymentMade,
            VendorCredit,
            FreightAdviceInbound,
            VendorPaymentAdvice,
        )
        register_audited_model(PurchaseRequest, 'Purchase Request')
        register_audited_model(RFQHeader, 'RFQ')
        register_audited_model(QuoteResponse, 'Quote')
        register_audited_model(QuoteEvaluation, 'Quote Evaluation')
        register_audited_model(PurchaseOrder, 'Purchase Order')
        register_audited_model(ReceiptAdvice, 'Receipt Advice')
        register_audited_model(VendorBill, 'Vendor Bill')
        register_audited_model(PaymentMade, 'Payment Made')
        register_audited_model(VendorCredit, 'Vendor Credit')
        register_audited_model(FreightAdviceInbound, 'Freight Advice')
        register_audited_model(VendorPaymentAdvice, 'Vendor Payment')

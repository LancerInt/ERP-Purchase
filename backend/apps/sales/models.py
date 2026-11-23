"""Minimal sales stubs so the Purchase app can boot standalone.

The full ERP couples purchase <-> sales. For this Purchase-only, no-Tally
carve-out we keep just the two models that purchase holds foreign keys to
(all SET_NULL / nullable), with the handful of fields purchase reads. No
sales business logic is included.
"""
from django.db import models

from common.models import BaseModel


class SalesOrder(BaseModel):
    """Stub: referenced by PurchaseRequest.sales_order (justification ref)."""
    so_number = models.CharField(max_length=50, blank=True, default='')
    company = models.ForeignKey('core.Company', on_delete=models.CASCADE, null=True, blank=True)

    class Meta:
        app_label = 'sales'

    def __str__(self):
        return self.so_number or f'SO-{self.pk}'


class DispatchChallan(BaseModel):
    """Stub: referenced by freight advice rows in purchase (dispatch_challan)."""
    dc_no = models.CharField(max_length=50, blank=True, default='')
    dispatch_date = models.DateField(null=True, blank=True)
    warehouse = models.ForeignKey('core.Warehouse', on_delete=models.SET_NULL, null=True, blank=True)

    class Meta:
        app_label = 'sales'

    def __str__(self):
        return self.dc_no or f'DC-{self.pk}'


# --- Stubs purchase queries in reconcile / vendor-ledger paths. Empty in a
# purchase-only build, so these queries correctly return nothing. Fields kept
# only where purchase filters on them. ---

class DebitNote(BaseModel):
    """Stub: purchase debit/credit notes live here in the full ERP."""
    note_type = models.CharField(max_length=20, blank=True, default='')
    side = models.CharField(max_length=20, blank=True, default='')
    amount = models.DecimalField(max_digits=15, decimal_places=2, default=0)
    taxable = models.DecimalField(max_digits=15, decimal_places=2, default=0)
    note_date = models.DateField(null=True, blank=True)
    tally_group = models.CharField(max_length=100, blank=True, default='')
    vendor = models.ForeignKey('master.Vendor', on_delete=models.SET_NULL, null=True, blank=True)
    company = models.ForeignKey('core.Company', on_delete=models.SET_NULL, null=True, blank=True)
    tally_guid = models.CharField(max_length=100, blank=True, default='')

    class Meta:
        app_label = 'sales'


class FreightAdviceOutbound(BaseModel):
    """Stub: outward freight advice (sales side)."""
    advice_no = models.CharField(max_length=50, blank=True, default='')
    amount = models.DecimalField(max_digits=15, decimal_places=2, default=0)
    tally_guid = models.CharField(max_length=100, blank=True, default='')

    class Meta:
        app_label = 'sales'


class SalesInvoiceCheck(BaseModel):
    """Stub: sales invoice reconciliation rows."""
    customer = models.ForeignKey('master.Customer', on_delete=models.SET_NULL, null=True, blank=True)
    amount = models.DecimalField(max_digits=15, decimal_places=2, default=0)

    class Meta:
        app_label = 'sales'


class ReceivablePayment(BaseModel):
    """Stub: receipts against sales invoices."""
    amount = models.DecimalField(max_digits=15, decimal_places=2, default=0)

    class Meta:
        app_label = 'sales'


class ReceivableAdjustment(BaseModel):
    """Stub: receivable adjustments."""
    amount = models.DecimalField(max_digits=15, decimal_places=2, default=0)

    class Meta:
        app_label = 'sales'


class TallyPartyMap(BaseModel):
    """Maps an invoice/party NAME to an ERP master. Used by the Scan Inbox to
    remember "this printed vendor name = this vendor" so a re-scan auto-resolves.
    """
    company = models.ForeignKey('core.Company', on_delete=models.CASCADE,
                                null=True, blank=True, related_name='tally_party_maps')
    tally_name = models.CharField(max_length=255)
    customer = models.ForeignKey('master.Customer', null=True, blank=True,
                                 on_delete=models.CASCADE, related_name='tally_maps')
    vendor = models.ForeignKey('master.Vendor', null=True, blank=True,
                               on_delete=models.CASCADE, related_name='tally_maps')
    product = models.ForeignKey('master.Product', null=True, blank=True,
                                on_delete=models.CASCADE, related_name='tally_maps')
    transporter = models.ForeignKey('master.Transporter', null=True, blank=True,
                                    on_delete=models.CASCADE, related_name='tally_maps')
    skip = models.BooleanField(default=False)

    class Meta:
        app_label = 'sales'
        indexes = [models.Index(fields=['company', 'tally_name'])]

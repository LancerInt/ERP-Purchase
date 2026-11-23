"""Minimal inventory stubs — purchase freight-advice rows FK to these
(SET_NULL/nullable) to tag a stock-transfer/shifting source. No stock
tracking logic in this Purchase-only build.
"""
from django.db import models

from common.models import BaseModel


class StockTransferDC(BaseModel):
    """Stub: inter-warehouse stock transfer DC a freight row may reference."""
    dc_no = models.CharField(max_length=50, blank=True, default='')
    transfer_date = models.DateField(null=True, blank=True)

    class Meta:
        app_label = 'inventory'

    def __str__(self):
        return self.dc_no or f'STDC-{self.pk}'


class WarehouseShifting(BaseModel):
    """Stub: warehouse-shifting record a freight row may reference."""
    reference_no = models.CharField(max_length=50, blank=True, default='')
    shift_date = models.DateField(null=True, blank=True)

    class Meta:
        app_label = 'inventory'

    def __str__(self):
        return self.reference_no or f'WHS-{self.pk}'


class InventoryLedger(BaseModel):
    """Stub: on-hand stock ledger. Empty here (purchase-only build), so the
    Purchase Items page shows blank current_stock rather than crashing.
    """
    product = models.ForeignKey('master.Product', on_delete=models.CASCADE, null=True, blank=True)
    warehouse = models.ForeignKey('core.Warehouse', on_delete=models.SET_NULL, null=True, blank=True)
    godown = models.ForeignKey('core.Godown', on_delete=models.SET_NULL, null=True, blank=True)
    quantity_in = models.DecimalField(max_digits=15, decimal_places=3, default=0)
    quantity_out = models.DecimalField(max_digits=15, decimal_places=3, default=0)

    class Meta:
        app_label = 'inventory'

"""GSTR-2B reconciliation models.

The 2B (downloaded from the GST portal) is the government's record of every
purchase our suppliers reported. We READ it and CHECK it against our Purchase
Bills — nothing is created or filed. Kept isolated in ai_parser.

    Gst2BUpload   one uploaded 2B file (a period, e.g. Jun 2026)
      └─ Gst2BRow   one supplier invoice inside it, with its match result
"""
from django.db import models

from common.models import BaseModel


class Gst2BUpload(BaseModel):
    KIND_CHOICES = (('2B', 'GSTR-2B'), ('2A', 'GSTR-2A'))
    company = models.ForeignKey(
        'core.Company', on_delete=models.CASCADE, related_name='gst2b_uploads',
        null=True, blank=True)
    kind = models.CharField(max_length=2, choices=KIND_CHOICES, default='2B', db_index=True)
    period = models.CharField(max_length=20, blank=True, default='')       # e.g. "Jun 2026"
    period_start = models.DateField(null=True, blank=True)                 # month range for
    period_end = models.DateField(null=True, blank=True)                   # "only in books"
    file = models.FileField(upload_to='gst2b/%Y/%m/')
    file_name = models.CharField(max_length=255, blank=True, default='')

    total_rows = models.IntegerField(default=0)
    matched = models.IntegerField(default=0)
    mismatch = models.IntegerField(default=0)
    only_in_2b = models.IntegerField(default=0)
    only_in_books = models.IntegerField(default=0)
    error_message = models.TextField(blank=True, default='')

    class Meta:
        app_label = 'ai_parser'
        ordering = ['-created_at']

    def __str__(self):
        return f'2B {self.period} ({self.file_name})'


class Gst2BRow(BaseModel):
    STATUS_CHOICES = (
        ('MATCHED', 'Matched'),
        ('MISMATCH', 'Amount mismatch'),
        ('ONLY_2B', 'In 2B, not in books'),
        ('ONLY_BOOKS', 'In books, not in 2B'),
    )
    upload = models.ForeignKey(Gst2BUpload, on_delete=models.CASCADE, related_name='rows')
    section = models.CharField(max_length=12, default='B2B')   # B2B / CDNR

    supplier_gstin = models.CharField(max_length=20, blank=True, default='', db_index=True)
    supplier_name = models.CharField(max_length=255, blank=True, default='')
    invoice_no = models.CharField(max_length=100, blank=True, default='')
    invoice_date = models.DateField(null=True, blank=True)
    invoice_value = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    taxable = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    igst = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    cgst = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    sgst = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    cess = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    total_tax = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    itc_available = models.CharField(max_length=8, blank=True, default='')

    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default='ONLY_2B', db_index=True)
    matched_bill = models.ForeignKey(
        'purchase.VendorBill', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='gst2b_rows')
    note = models.CharField(max_length=255, blank=True, default='')

    class Meta:
        app_label = 'ai_parser'
        ordering = ['supplier_name', 'invoice_no']
        indexes = [models.Index(fields=['upload', 'status'])]

    def __str__(self):
        return f'{self.supplier_name} / {self.invoice_no} ({self.status})'

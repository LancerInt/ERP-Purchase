"""Minimal bank stub — purchase PaymentMade.bank_account FKs to BankAccount
(SET_NULL/nullable). Keeps the fields purchase reads (code, nickname,
bank_name) so a payment can optionally name its bank account.
"""
from django.db import models

from common.models import BaseModel


class BankAccount(BaseModel):
    """Stub: a bank account a payment can be drawn from."""
    code = models.CharField(max_length=50, blank=True, default='')
    nickname = models.CharField(max_length=100, blank=True, default='')
    bank_name = models.CharField(max_length=150, blank=True, default='')
    account_number = models.CharField(max_length=50, blank=True, default='')
    company = models.ForeignKey('core.Company', on_delete=models.CASCADE, null=True, blank=True)

    class Meta:
        app_label = 'bank'

    def __str__(self):
        return self.nickname or self.code or self.bank_name or f'BANK-{self.pk}'


class BankStatementUpload(BaseModel):
    """A bank statement file (CSV/Excel/PDF) uploaded and parsed into lines.

    Standalone: parses the statement so its debit rows can be turned into
    vendor payments. No Tally reconciliation.
    """
    PARSE_STATUS = (
        ('PENDING', 'Pending'),
        ('PARSED', 'Parsed'),
        ('FAILED', 'Failed'),
    )
    bank_account = models.ForeignKey(
        'bank.BankAccount', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='statement_uploads')
    company = models.ForeignKey('core.Company', on_delete=models.CASCADE, null=True, blank=True)
    statement_file = models.FileField(upload_to='bank_statements/%Y/%m/')
    file_name = models.CharField(max_length=255, blank=True, default='')
    parsing_status = models.CharField(max_length=10, choices=PARSE_STATUS, default='PENDING', db_index=True)
    parse_error = models.TextField(blank=True, default='')
    line_count = models.IntegerField(default=0)
    remarks = models.TextField(blank=True, default='')

    class Meta:
        app_label = 'bank'
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.file_name or "statement"} ({self.parsing_status})'


class BankStatementLine(BaseModel):
    """One transaction row parsed from a bank statement."""
    upload = models.ForeignKey(BankStatementUpload, on_delete=models.CASCADE, related_name='lines')
    line_no = models.PositiveIntegerField(default=0)
    txn_date = models.DateField(null=True, blank=True, db_index=True)
    narration = models.TextField(blank=True, default='')
    reference_no = models.CharField(max_length=60, blank=True, default='')
    debit = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    credit = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    balance = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)
    # When a debit row has been turned into a vendor payment, link it here so
    # the row shows as "recorded" and isn't double-booked.
    matched_vendor_payment = models.ForeignKey(
        'purchase.PaymentMade', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='statement_lines')

    class Meta:
        app_label = 'bank'
        ordering = ['upload', 'line_no']

    def __str__(self):
        return f'{self.txn_date} {self.narration[:30]} ({self.debit or self.credit})'

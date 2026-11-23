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

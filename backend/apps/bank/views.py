"""Minimal bank views (standalone) — read/write bank accounts for the
payment forms' "paid from" picker."""
from rest_framework import viewsets, serializers
from rest_framework.permissions import IsAuthenticated
from django_filters.rest_framework import DjangoFilterBackend

from .models import BankAccount


class BankAccountSerializer(serializers.ModelSerializer):
    class Meta:
        model = BankAccount
        fields = ['id', 'code', 'nickname', 'bank_name', 'account_number', 'company', 'is_active']
        read_only_fields = ['id']


class BankAccountViewSet(viewsets.ModelViewSet):
    queryset = BankAccount.objects.filter(is_active=True)
    serializer_class = BankAccountSerializer
    permission_classes = [IsAuthenticated]
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['company']

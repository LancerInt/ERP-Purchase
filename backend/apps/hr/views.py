"""HR views (standalone) — Staff CRUD + child records."""
from rest_framework import viewsets, filters
from rest_framework.permissions import IsAuthenticated
from django_filters.rest_framework import DjangoFilterBackend

from .models import Staff, StaffBankAccount, StaffIDProof
from .serializers import (
    StaffSerializer, StaffBankAccountSerializer, StaffIDProofSerializer,
)


class StaffViewSet(viewsets.ModelViewSet):
    queryset = Staff.objects.all().select_related(
        'company', 'primary_location', 'default_godown', 'contractor_vendor',
    ).prefetch_related('id_proofs', 'bank_account')
    serializer_class = StaffSerializer
    permission_classes = [IsAuthenticated]
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['company', 'primary_location', 'employment_status', 'staff_type', 'is_active']
    search_fields = ['staff_id', 'first_name', 'last_name', 'designation', 'department', 'contact_number', 'email']
    ordering_fields = ['staff_id', 'first_name', 'last_name', 'employment_start_date']


class StaffBankAccountViewSet(viewsets.ModelViewSet):
    queryset = StaffBankAccount.objects.select_related('staff').all()
    serializer_class = StaffBankAccountSerializer
    permission_classes = [IsAuthenticated]
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['staff']


class StaffIDProofViewSet(viewsets.ModelViewSet):
    queryset = StaffIDProof.objects.select_related('staff').all()
    serializer_class = StaffIDProofSerializer
    permission_classes = [IsAuthenticated]
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['staff', 'document_type']

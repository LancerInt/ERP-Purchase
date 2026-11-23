"""HR Models (standalone carve-out) — Staff only.

This is a trimmed version of the full ERP hr app: it keeps the Staff entity
and its direct child records (bank account, ID proofs) so the Staff page
works, and drops attendance / payroll / leave / shifts and the
``shift_assignment`` FK that pointed at the dropped ShiftDefinition model.
"""
from decimal import Decimal
from django.db import models
from django.core.validators import MinValueValidator

from common.models import BaseModel


class Staff(BaseModel):
    """Employee/Staff Records with comprehensive details."""

    STAFF_TYPE_CHOICES = [
        ('EMPLOYEE', 'Employee'),
        ('STAFF', 'Staff'),
    ]

    GENDER_CHOICES = [
        ('M', 'Male'),
        ('F', 'Female'),
        ('O', 'Other'),
    ]

    EMPLOYMENT_STATUS_CHOICES = [
        ('ACTIVE', 'Active'),
        ('ON_LEAVE', 'On Leave'),
        ('RESIGNED', 'Resigned'),
    ]

    staff_id = models.CharField(max_length=50, unique=True, db_index=True)
    staff_type = models.CharField(max_length=20, choices=STAFF_TYPE_CHOICES)
    first_name = models.CharField(max_length=100)
    last_name = models.CharField(max_length=100)
    gender = models.CharField(max_length=10, choices=GENDER_CHOICES, null=True, blank=True)
    date_of_birth = models.DateField(null=True, blank=True)

    company = models.ForeignKey('core.Company', on_delete=models.PROTECT)
    company_ids = models.JSONField(default=list, blank=True)
    primary_location = models.ForeignKey('core.Warehouse', on_delete=models.PROTECT)
    location_ids = models.JSONField(default=list, blank=True)
    default_godown = models.ForeignKey(
        'core.Godown',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='default_staff',
    )
    godown_ids = models.JSONField(default=list, blank=True)
    department = models.CharField(max_length=100, blank=True, default='')
    designation = models.CharField(max_length=100, blank=True, default='')
    employment_start_date = models.DateField(null=True, blank=True)
    employment_end_date = models.DateField(null=True, blank=True)
    employment_status = models.CharField(max_length=20, choices=EMPLOYMENT_STATUS_CHOICES)

    hr_owner = models.ForeignKey('core.StakeholderUser', on_delete=models.SET_NULL, null=True, blank=True)

    overtime_eligible = models.BooleanField(default=True)
    contractor_flag = models.BooleanField(default=False)
    contractor_vendor = models.ForeignKey('master.Vendor', on_delete=models.SET_NULL, null=True, blank=True)

    salary_per_day = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        null=True,
        blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text='Base daily wage. Multiplied by present-days in payroll.',
    )

    photo_reference = models.ImageField(upload_to='staff/photos/', null=True, blank=True)

    contact_number = models.CharField(max_length=20, blank=True, default='')
    email = models.EmailField(blank=True, default='')
    emergency_contact = models.CharField(max_length=255, null=True, blank=True)
    address = models.JSONField(null=True, blank=True)
    remarks = models.TextField(blank=True, default='')

    class Meta:
        app_label = 'hr'
        ordering = ['staff_id']
        indexes = [
            models.Index(fields=['company', 'employment_status']),
            models.Index(fields=['primary_location', 'employment_status']),
            models.Index(fields=['staff_id', 'is_active']),
        ]

    def __str__(self):
        return f"{self.staff_id} - {self.first_name} {self.last_name}"

    @property
    def full_name(self):
        return f"{self.first_name} {self.last_name}"


class StaffBankAccount(BaseModel):
    """Bank account details for staff."""

    ACCOUNT_TYPE_CHOICES = [
        ('SAVINGS', 'Savings'),
        ('CURRENT', 'Current'),
        ('SALARY', 'Salary'),
    ]

    staff = models.OneToOneField(Staff, on_delete=models.CASCADE, related_name='bank_account')
    account_holder = models.CharField(max_length=100)
    bank_name = models.CharField(max_length=100)
    ifsc_code = models.CharField(max_length=11)
    account_number = models.CharField(max_length=50)
    account_type = models.CharField(max_length=20, choices=ACCOUNT_TYPE_CHOICES)

    class Meta:
        app_label = 'hr'

    def __str__(self):
        return f"{self.staff.staff_id} - {self.bank_name} ({self.account_number[-4:]})"


class StaffIDProof(BaseModel):
    """ID proof documents for staff."""

    DOCUMENT_TYPE_CHOICES = [
        ('AADHAAR', 'Aadhaar'),
        ('PAN', 'PAN'),
        ('LICENSE', 'Driving License'),
        ('PASSPORT', 'Passport'),
        ('OTHER', 'Other'),
    ]

    staff = models.ForeignKey(Staff, on_delete=models.CASCADE, related_name='id_proofs')
    document_type = models.CharField(max_length=20, choices=DOCUMENT_TYPE_CHOICES)
    document_number = models.CharField(max_length=100)
    expiry_date = models.DateField(null=True, blank=True)
    attachment = models.FileField(upload_to='staff/id_proofs/')

    class Meta:
        app_label = 'hr'
        unique_together = ('staff', 'document_type')

    def __str__(self):
        return f"{self.staff.staff_id} - {self.get_document_type_display()}"

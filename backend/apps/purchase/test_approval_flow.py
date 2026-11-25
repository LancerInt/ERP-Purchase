"""Approval-flow rules:

  1. A receipt MUST be entered against a Purchase Order — an ordinary
     (AGAINST_PO) receipt with no PO link is rejected; one with a po_line
     passes. (A DIRECT receipt is the privileged no-PO exception, gated
     elsewhere by its own permission.)
  2. The three-stage PR approval roles carry the right permission flags so
     the submit -> proceed -> approve chain can be driven by
     Warehouse Coordinator -> Warehouse Manager -> Purchase Coordinator.
"""
import datetime
from decimal import Decimal

from django.test import TestCase
from rest_framework import serializers as drf_serializers

from core.models import Company, Warehouse
from master.models import Vendor, Product
from purchase.models import PurchaseOrder, POLine
from purchase.serializers import ReceiptAdviceSerializer

TODAY = datetime.date.today()
D = Decimal


class ReceiptRequiresPOTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.company = Company.objects.create(company_code='C1', legal_name='Co', trade_name='Co')
        cls.wh = Warehouse.objects.create(warehouse_code='W1', name='WH', company=cls.company)
        cls.vendor = Vendor.objects.create(vendor_name='V', vendor_code='V1', company=cls.company)
        cls.product = Product.objects.create(product_name='Maize', sku_code='MZ', product_type='GOODS')
        cls.po = PurchaseOrder.objects.create(
            vendor=cls.vendor, warehouse=cls.wh, company=cls.company, status='APPROVED')
        cls.po_line = POLine.objects.create(
            po=cls.po, line_no=1, product_service=cls.product,
            quantity_ordered=D('100'), unit_price=D('10'), uom='KG')

    def _validate(self, data):
        s = ReceiptAdviceSerializer()
        return s.validate(data)

    def test_against_po_receipt_without_po_is_blocked(self):
        """AGAINST_PO receipt, lines carry no po_line and no header PO -> reject."""
        data = {
            'receipt_source': 'AGAINST_PO',
            'receipt_lines': [{'product': self.product, 'quantity_received': D('50'), 'uom': 'KG'}],
        }
        with self.assertRaises(drf_serializers.ValidationError) as cm:
            self._validate(data)
        self.assertIn('Purchase Order', str(cm.exception))

    def test_receipt_with_po_line_passes(self):
        """A line carrying a po_line satisfies the PO-link requirement."""
        data = {
            'receipt_source': 'AGAINST_PO',
            'receipt_lines': [{
                'product': self.product, 'po_line': self.po_line,
                'quantity_received': D('50'), 'uom': 'KG',
            }],
        }
        # Should not raise for the PO-link rule (over-receipt is separate and 50<100).
        self._validate(data)

    def test_empty_receipt_is_not_blocked_for_missing_po(self):
        """A header-only save (no lines yet) isn't blocked by this rule."""
        self._validate({'receipt_source': 'AGAINST_PO', 'receipt_lines': []})


class PRRolePermissionTests(TestCase):
    """The seeded roles carry the stage-specific flags that gate the PR chain."""

    def test_roles_have_stage_permissions(self):
        from django.core.management import call_command
        from rbac.models import ERPRole, RolePermission, ERPModule
        # Seed modules/roles (setup_admin) then the approval grid.
        call_command('setup_admin')
        call_command('seed_approval_roles')
        pr_mod = ERPModule.objects.get(name='Purchase Request')

        def flag(role_name, attr):
            role = ERPRole.objects.get(name=role_name)
            rp = RolePermission.objects.filter(role=role, module=pr_mod).first()
            return bool(rp and getattr(rp, attr))

        # Stage 1 — Warehouse Coordinator submits.
        self.assertTrue(flag('Warehouse Coordinator', 'can_submit'))
        self.assertTrue(flag('Warehouse Coordinator', 'can_create'))
        # Stage 2 — Warehouse Manager proceeds (-> Factory Approved).
        self.assertTrue(flag('Warehouse Manager', 'can_proceed_approval'))
        # Stage 3 — Purchase Coordinator approves/rejects.
        self.assertTrue(flag('Purchase Coordinator', 'can_approve'))
        self.assertTrue(flag('Purchase Coordinator', 'can_reject'))
        # PC does NOT submit PRs (not the raiser).
        self.assertFalse(flag('Purchase Coordinator', 'can_submit'))

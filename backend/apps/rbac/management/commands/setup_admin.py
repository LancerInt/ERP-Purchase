"""
Management command to set up Admin user with IT Admin role and full permissions.

Steps:
1. Seed all ERP roles and modules
2. Ensure Company and Warehouse exist
3. Create Admin staff record
4. Create Django User (admin / Admin@123)
5. Link via StakeholderUser
6. Assign IT Admin role
7. Grant full RolePermission on ALL modules for IT Admin
"""
from django.core.management.base import BaseCommand
from django.contrib.auth.models import User
from django.db import transaction

from core.models import Company, Warehouse, StakeholderUser
from hr.models import Staff
from rbac.models import ERPRole, ERPModule, UserRoleAssignment, RolePermission


# All predefined roles
ROLES = [
    ('Office Manager', 'Overall office administration and management'),
    ('Purchase Manager', 'Manages purchase operations and approvals'),
    ('Purchase Coordinator', 'Coordinates purchase activities and follow-ups'),
    ('Sales Manager', 'Manages sales operations and approvals'),
    ('Sales Coordinator', 'Coordinates sales activities and follow-ups'),
    ('Finance Manager', 'Manages finance operations and approvals'),
    ('Accounts Manager', 'Manages accounting operations'),
    ('Freight Coordinator', 'Coordinates freight and logistics'),
    ('QC Manager', 'Manages quality control operations'),
    ('QC Coordinator', 'Coordinates quality control activities'),
    ('QC Analyst', 'Performs quality control analysis and testing'),
    ('Warehouse Manager', 'Manages warehouse operations'),
    ('Warehouse Coordinator', 'Coordinates warehouse activities'),
    ('Warehouse Supervisor', 'Supervises warehouse floor operations'),
    ('Warehouse Coordinator (Office)', 'Warehouse coordination from office side'),
    ('HR Coordinator (Office)', 'HR coordination from office side'),
    ('Warehouse HR Coordinator', 'HR coordination for warehouse staff'),
    ('IT Admin', 'IT administration and system management'),
    ('Production Manager', 'Manages production operations'),
    ('Production Coordinator', 'Coordinates production activities'),
    # Extraction (Azadirachtin submodule)
    ('Production Operator',   'Records extraction process entries — kernel, washes, transfers, outputs'),
    ('Production Supervisor', 'Reviews and signs off extraction batches; records reasons for losses'),
    ('Lab User',              'Records Azadirachtin, moisture, admixture, SG results for pending samples'),
    ('Stores User',           'Records S2/S3 receipts, issues, recoveries, and final-product receipts'),
]

# All modules: (name, slug, description, icon, order, category)
MODULES = [
    # Masters
    ('Company', 'company', 'Company master data', 'building', 10, 'MASTERS'),
    ('Warehouse', 'warehouse', 'Warehouse management', 'warehouse', 11, 'MASTERS'),
    ('Godown', 'godown', 'Godown management', 'store', 12, 'MASTERS'),
    ('Machinery Division', 'machinery-division', 'Departments / production lines attached to a machinery location', 'git-branch', 134, 'MASTERS'),
    ('Machinery Expense',  'machinery-expense',  'Expense buckets charged against godowns',                          'receipt',    135, 'MASTERS'),
    ('Expense Category',   'expense-category',   'Curated categories tag-able onto Machinery Expenses (admin-only)', 'tag',        136, 'MASTERS'),
    ('Product', 'product', 'Product master', 'package', 14, 'MASTERS'),
    ('Service Catalogue', 'service-catalogue', 'Service catalogue management', 'list', 15, 'MASTERS'),
    ('Vendor', 'vendor', 'Vendor master', 'users', 16, 'MASTERS'),
    ('Customer', 'customer', 'Customer master', 'user-check', 17, 'MASTERS'),
    ('Transporter', 'transporter', 'Transporter master', 'truck', 18, 'MASTERS'),
    ('Broker', 'broker', 'Broker / commission agent master', 'briefcase', 22, 'MASTERS'),
    ('Price List', 'price-list', 'Price list management', 'dollar-sign', 19, 'MASTERS'),
    ('State Group', 'state-group', 'State clusters for state-wise pricing', 'map', 195, 'MASTERS'),
    ('Tax Master', 'tax-master', 'Tax configuration', 'percent', 20, 'MASTERS'),
    ('Template', 'template', 'Template library', 'file-text', 21, 'MASTERS'),
    # Purchase
    ('Purchase Request', 'purchase-request', 'Purchase requisitions', 'shopping-cart', 100, 'PURCHASE'),
    ('RFQ', 'rfq', 'Request for quotation', 'file-plus', 101, 'PURCHASE'),
    ('Quote', 'quote', 'Vendor quotes', 'file', 102, 'PURCHASE'),
    ('Quote Evaluation', 'quote-evaluation', 'Quote comparison and evaluation', 'bar-chart-2', 103, 'PURCHASE'),
    ('Purchase Order', 'purchase-order', 'Purchase orders', 'clipboard', 104, 'PURCHASE'),
    ('Receipt Advice', 'receipt-advice', 'Goods receipt', 'download', 105, 'PURCHASE'),
    ('Vendor Bill', 'vendor-bill', 'Vendor bills and invoices', 'file-text', 106, 'PURCHASE'),
    ('Scan Inbox', 'scan-inbox', 'Bulk-scan purchase invoices → item lines on vendor bills (with stock intake)', 'scan-line', 112, 'PURCHASE'),
    ('Payment Made', 'payment-made', 'Payments made to vendors', 'credit-card', 107, 'PURCHASE'),
    # Vendor Notes & Advances and Vendor Dues live under the Finance sidebar
    # section, so their permission toggles belong in the Finance grid.
    ('Vendor Credit', 'vendor-credit', 'Vendor credit notes', 'file-minus', 108, 'FINANCE'),
    ('Vendor Dues', 'vendor-dues', 'Vendor dues tracking', 'alert-circle', 109, 'FINANCE'),
    ('Vendor Payment', 'vendor-payment', 'Vendor payment vouchers', 'credit-card', 110, 'PURCHASE'),
    ('Material Rejection', 'material-rejection', 'Material rejection notes', 'x-circle', 111, 'PURCHASE'),
    ('GST 2B Match', 'gst-2b-match', 'GSTR-2B/2A reconciliation against vendor bills', 'file-check', 113, 'PURCHASE'),
    ('TDS Payable', 'tds-payable', 'TDS deducted from vendors, owed to govt (194C/194Q/194J/194I) — mirrors Tally TDS Payable group', 'percent', 210, 'PURCHASE'),
    ('Creditors', 'creditors', 'What we owe suppliers — mirrors Tally’s Sundry Creditors Group Summary', 'users', 211, 'PURCHASE'),
    # Freight / Wage Billing
    ('Freight Advice', 'freight-advice', 'Freight management', 'navigation', 150, 'FREIGHT'),
    ('Freight Payment', 'freight-payment', 'Freight payment processing', 'credit-card', 151, 'FREIGHT'),
    ('Wage Entry', 'wage-entry', 'Loading/unloading wage entries', 'hard-hat', 152, 'FREIGHT'),
    ('Wage Payment', 'wage-payment', 'Periodic contractor wage settlements', 'credit-card', 153, 'FREIGHT'),
    # Sales
    ('Customer PO', 'customer-po', 'Customer purchase orders', 'file-minus', 200, 'SALES'),
    ('Sales Order', 'sales-order', 'Sales orders', 'trending-up', 201, 'SALES'),
    ('Dispatch Challan', 'dispatch-challan', 'Dispatch challans', 'send', 202, 'SALES'),
    ('Sales Invoice', 'sales-invoice', 'Sales invoices', 'file-text', 203, 'SALES'),
    ('Receivable', 'receivable', 'Accounts receivable', 'inbox', 204, 'SALES'),
    ('Sales Freight', 'sales-freight', 'Outward freight (warehouse → customer)', 'arrow-up-right', 205, 'SALES'),
    ('GSTR-1 Match', 'gstr1-match', 'GSTR-1 reconciliation against sales invoices', 'file-check', 206, 'SALES'),
    ('Sales Ledger', 'sales-ledger', 'Customer / debtors ledger for the sales team', 'book-open', 207, 'SALES'),
    ('TDS 194Q', 'sales-tds', 'TDS receivable under section 194Q', 'percent', 208, 'SALES'),
    ('Customer Advances', 'customer-advances', 'Advances received from customers', 'wallet', 209, 'SALES'),
    ('E-Way Bill Check', 'ewb-einvoice-check', 'E-way bills reconciled against e-invoices', 'truck', 210, 'SALES'),
    # Production
    ('BOM Request', 'bom-request', 'Bill of materials requests', 'layers', 300, 'PRODUCTION'),
    ('Work Order', 'work-order', 'Production work orders', 'tool', 301, 'PRODUCTION'),
    ('Wage Voucher', 'wage-voucher', 'Wage vouchers', 'file-text', 302, 'PRODUCTION'),
    ('Material Issue', 'material-issue', 'Material issue notes', 'arrow-right', 303, 'PRODUCTION'),
    ('Yield Log', 'yield-log', 'Production yield logs', 'activity', 304, 'PRODUCTION'),
    ('Production Damage', 'production-damage', 'Damaged products during production / packing', 'alert-triangle', 305, 'PRODUCTION'),
    ('Process', 'process', 'Production process master', 'git-merge', 306, 'PRODUCTION'),
    ('Packing Process', 'packing-process', 'Packing process work orders', 'box', 307, 'PRODUCTION'),
    ('Gate Register', 'gate-register', 'Factory gate loading / unloading log', 'truck', 308, 'PRODUCTION'),
    ('Shift Labor', 'shift-labor', 'Daily shift-level labor headcount by category', 'users', 309, 'PRODUCTION'),
    ('Production Stock', 'production-stock', 'Parallel stock ledger driving the new production-entry workflow', 'boxes', 210, 'INVENTORY'),
    ('Production Entry', 'production-entry', 'Shop-floor production entry — inputs consumed + outputs produced per godown per day', 'workflow', 211, 'INVENTORY'),
    # Quality
    ('QC Parameter', 'qc-parameter', 'Quality control parameters', 'sliders', 400, 'QUALITY'),
    ('QC Request', 'qc-request', 'Quality control requests', 'check-circle', 401, 'QUALITY'),
    ('QC Lab Job', 'qc-lab-job', 'QC laboratory jobs', 'thermometer', 402, 'QUALITY'),
    ('QC Report', 'qc-report', 'Quality control reports', 'clipboard', 403, 'QUALITY'),
    ('Counter Sample', 'counter-sample', 'Counter sample register', 'archive', 404, 'QUALITY'),
    # Inventory
    ('Inventory Ledger', 'inventory-ledger', 'Stock ledger view', 'book', 500, 'INVENTORY'),
    ('Stock Movement Request', 'stock-movement-request', 'Stock movement requests (shifting/transfer) with approval', 'repeat', 500, 'INVENTORY'),
    ('Stock Transfer', 'stock-transfer', 'Stock transfer challans', 'repeat', 501, 'INVENTORY'),
    ('Transfer Receipt', 'transfer-receipt', 'Stock transfer receipts', 'download', 502, 'INVENTORY'),
    ('Shifting', 'shifting', 'Warehouse shifting', 'move', 503, 'INVENTORY'),
    ('Job Work Order', 'job-work-order', 'Job work orders', 'briefcase', 504, 'INVENTORY'),
    ('Job Work DC', 'job-work-dc', 'Job work dispatch challans', 'external-link', 505, 'INVENTORY'),
    ('Job Work Receipt', 'job-work-receipt', 'Job work receipts', 'corner-down-left', 506, 'INVENTORY'),
    ('Sales Return', 'sales-return', 'Sales return advice', 'corner-up-left', 507, 'INVENTORY'),
    ('Stock Adjustment', 'stock-adjustment', 'Stock adjustments', 'edit-3', 508, 'INVENTORY'),
    # Finance
    ('Ledgers', 'ledgers', 'Unified party ledgers (creditors + debtors)', 'book-open', 599, 'FINANCE'),
    ('Vendor Ledger', 'vendor-ledger', 'Vendor ledger', 'book', 600, 'FINANCE'),
    ('Customer Ledger', 'customer-ledger', 'Customer ledger', 'book-open', 601, 'FINANCE'),
    ('Payment Advice', 'payment-advice', 'Payment advice workflow', 'credit-card', 602, 'FINANCE'),
    ('Credit/Debit Note', 'credit-debit-note', 'Credit and debit notes', 'file-minus', 604, 'FINANCE'),
    ('GST Report', 'gst-report', 'GST reconciliation and reports', 'pie-chart', 605, 'FINANCE'),
    ('Petty Cash', 'petty-cash', 'Petty cash register', 'dollar-sign', 606, 'FINANCE'),
    ('Freight Ledger', 'freight-ledger', 'Freight ledger', 'map', 607, 'FINANCE'),
    ('Wage Ledger', 'wage-ledger', 'Wage ledger', 'book', 608, 'FINANCE'),
    ('Expense Ledger', 'expense-ledger', 'Expense ledger', 'book', 609, 'FINANCE'),
    ('Petty Cash Ledger', 'petty-cash-ledger', 'Petty cash / imprest cash book', 'book-open', 610, 'FINANCE'),
    # Bank (the /bank/* module)
    ('Bank Dashboard', 'bank-dashboard', 'Bank module dashboard — balances and cash position', 'layout-dashboard', 620, 'BANK'),
    ('Bank Account', 'bank-account', 'Bank accounts master', 'building', 621, 'BANK'),
    ('Bank Receipt', 'bank-receipt', 'Bank receipts — money in (sales)', 'arrow-down-left', 622, 'BANK'),
    ('Bank Payment', 'bank-payment', 'Bank payments — money out (purchase)', 'arrow-up-right', 623, 'BANK'),
    ('Reconcile Statement', 'reconcile-statement', 'Reconcile a real bank statement against Tally-sourced receipts/payments', 'file-check', 624, 'BANK'),
    # Expenses
    ('Imprest', 'imprest', 'Petty-cash imprest funds and top-ups', 'wallet', 650, 'EXPENSES'),
    ('Voucher', 'voucher', 'Imprest/voucher fund dashboard', 'receipt', 651, 'EXPENSES'),
    ('Expense Register', 'expense-register', 'Credit and voucher expense register', 'book-open', 652, 'EXPENSES'),
    ('Consumables', 'consumables', 'Consumable stock and usage', 'package', 653, 'EXPENSES'),
    # HR
    ('Staff', 'staff', 'Staff management', 'users', 700, 'HR'),
    ('Shift', 'shift', 'Shift definitions', 'clock', 701, 'HR'),
    ('Attendance', 'attendance', 'Attendance capture', 'check-square', 702, 'HR'),
    ('Leave', 'leave', 'Leave requests', 'calendar', 703, 'HR'),
    ('Overtime', 'overtime', 'Overtime requests', 'clock', 704, 'HR'),
    ('Payroll', 'payroll', 'Payroll export', 'dollar-sign', 705, 'HR'),
    ('Holiday Calendar', 'holiday-calendar', 'Company holiday calendar', 'calendar', 706, 'HR'),
    # Admin
    ('Dashboard', 'dashboard', 'Main dashboard', 'layout', 1, 'ADMIN'),
    ('Audit Log', 'audit-log', 'System audit logs', 'eye', 900, 'ADMIN'),
    ('User Management', 'user-management', 'User administration', 'user-plus', 901, 'ADMIN'),
    ('Role Management', 'role-management', 'Role administration', 'shield', 902, 'ADMIN'),
    ('Permission Management', 'permission-management', 'Permission administration', 'lock', 903, 'ADMIN'),
    ('Email Template', 'email-template', 'Email template management', 'mail', 904, 'ADMIN'),
    # Extraction (Azadirachtin production submodule under Production)
    ('Manufacturing Batch',    'manufacturing-batch',    'Azadirachtin extraction batches — kernel, SLE, LLE, transfers, FFE, ATFE', 'flask',      350, 'PRODUCTION'),
    ('Extraction Lab',         'extraction-lab',         'Sample requests + lab results for extraction batches',                     'thermometer', 351, 'PRODUCTION'),
    ('Solvent Stock',          'solvent-stock',          'S2 and S3 solvent lots + issue/recovery/reuse transactions',              'droplet',    352, 'PRODUCTION'),
    ('Cleaning Record',        'cleaning-record',        'Equipment cleaning + recovery streams',                                    'spray-can',  353, 'PRODUCTION'),
    ('Final Product (Extraction)', 'extraction-final-product', 'Liquid concentrate and dry-powder final-product lots',              'package',    354, 'PRODUCTION'),
]

# All boolean permission fields on RolePermission
FULL_PERM = {
    'can_view': True, 'can_create': True, 'can_edit': True, 'can_delete': True,
    'can_approve': True, 'can_reject': True, 'can_send_email': True,
    'can_export': True, 'can_print': True,
    'can_confirm': True, 'can_close': True, 'can_cancel': True,
    'can_issue': True, 'can_convert': True,
}


class Command(BaseCommand):
    help = 'Create Admin staff, user with IT Admin role, and full permissions'

    @transaction.atomic
    def handle(self, *args, **options):
        # --- 1. Seed Roles ---
        roles_created = 0
        for name, description in ROLES:
            _, created = ERPRole.objects.get_or_create(
                name=name,
                defaults={'description': description, 'is_active': True}
            )
            if created:
                roles_created += 1
        self.stdout.write(self.style.SUCCESS(
            f'Roles: {roles_created} created, {len(ROLES) - roles_created} existing'
        ))

        # --- 2. Seed Modules ---
        modules_created = 0
        for name, slug, description, icon, order, category in MODULES:
            obj, created = ERPModule.objects.get_or_create(
                slug=slug,
                defaults={
                    'name': name, 'description': description,
                    'icon': icon, 'order': order, 'category': category,
                    'is_active': True,
                }
            )
            if not created:
                changed = False
                for attr, val in [('name', name), ('order', order), ('category', category)]:
                    if getattr(obj, attr) != val:
                        setattr(obj, attr, val)
                        changed = True
                if changed:
                    obj.save()
            else:
                modules_created += 1
        self.stdout.write(self.style.SUCCESS(
            f'Modules: {modules_created} created, {len(MODULES) - modules_created} existing'
        ))

        # --- 3. Ensure Company ---
        company, created = Company.objects.get_or_create(
            company_code='COMP01',
            defaults={
                'legal_name': 'Main Company',
                'trade_name': 'Main Company',
                'default_currency': 'INR',
            }
        )
        if created:
            self.stdout.write(self.style.SUCCESS(f'Created Company: {company}'))

        # --- 4. Ensure Warehouse ---
        warehouse, created = Warehouse.objects.get_or_create(
            warehouse_code='WH01',
            defaults={
                'company': company,
                'name': 'Head Office',
                'warehouse_type': 'HEAD_OFFICE',
                'city': 'Head Office',
                'country': 'India',
            }
        )
        if created:
            self.stdout.write(self.style.SUCCESS(f'Created Warehouse: {warehouse}'))

        # --- 5. Create Admin Staff ---
        staff, created = Staff.objects.get_or_create(
            staff_id='ADM-001',
            defaults={
                'staff_type': 'STAFF',
                'first_name': 'Admin',
                'last_name': 'User',
                'company': company,
                'primary_location': warehouse,
                'department': 'IT',
                'designation': 'IT Administrator',
                'employment_status': 'ACTIVE',
            }
        )
        if created:
            self.stdout.write(self.style.SUCCESS(f'Created Staff: {staff}'))

        # --- 6. Create Django User ---
        if User.objects.filter(username='admin').exists():
            user = User.objects.get(username='admin')
        else:
            user = User.objects.create_user(
                username='admin',
                password='Admin@123',
                first_name='Admin',
                last_name='User',
                email='admin@company.com',
                is_staff=True,
                is_superuser=True,
            )
            self.stdout.write(self.style.SUCCESS(
                f'Created Django User: {user.username} (password: Admin@123)'
            ))

        # --- 7. StakeholderUser ---
        StakeholderUser.objects.get_or_create(
            user=user,
            defaults={
                'employee_record': staff,
                'primary_email': 'admin@company.com',
                'default_warehouse': warehouse,
                'status': 'ACTIVE',
            }
        )

        # --- 8. Assign IT Admin role ---
        it_admin_role = ERPRole.objects.get(name='IT Admin')
        UserRoleAssignment.objects.get_or_create(
            user=user,
            defaults={'role': it_admin_role, 'assigned_by': user}
        )

        # --- 9. Full permissions for IT Admin on ALL modules ---
        all_modules = ERPModule.objects.filter(is_active=True)
        perm_created = 0
        perm_updated = 0
        for module in all_modules:
            perm, created = RolePermission.objects.get_or_create(
                role=it_admin_role,
                module=module,
                defaults=FULL_PERM,
            )
            if created:
                perm_created += 1
            else:
                changed = False
                for field, value in FULL_PERM.items():
                    if not getattr(perm, field):
                        setattr(perm, field, value)
                        changed = True
                if changed:
                    perm.save()
                    perm_updated += 1

        self.stdout.write(self.style.SUCCESS(
            f'IT Admin permissions: {perm_created} created, {perm_updated} updated '
            f'(full access on {all_modules.count()} modules)'
        ))

        # --- Summary ---
        self.stdout.write('')
        self.stdout.write(self.style.SUCCESS('=' * 50))
        self.stdout.write(self.style.SUCCESS('ADMIN SETUP COMPLETE'))
        self.stdout.write(self.style.SUCCESS('=' * 50))
        self.stdout.write(f'  Username    : admin')
        self.stdout.write(f'  Password    : Admin@123')
        self.stdout.write(f'  Role        : IT Admin')
        self.stdout.write(f'  Permissions : Full access on {all_modules.count()} modules')
        self.stdout.write(f'  Perm fields : 14 (CRUD + Workflow + Utility)')
        self.stdout.write(self.style.SUCCESS('=' * 50))

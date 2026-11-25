"""Seed the three-stage Purchase-Request approval roles, their module
permissions, and one demo login per role.

The PR approval chain is already built in the views (submit →
proceed_to_approve → approve, each gated by its own RolePermission flag).
This command just wires the three roles to the right flags and creates a
login for each so the chain can be driven end to end:

    Warehouse Coordinator  — creates + SUBMITS a PR        (can_submit)
    Warehouse Manager      — approves to "Factory Approved" (can_proceed_approval)
    Purchase Coordinator   — FINAL approve / reject          (can_approve/can_reject)

Both warehouse roles may create a PR. The Purchase Coordinator owns the
downstream purchase docs (RFQ → Quote → Evaluation → PO → Bills); the PO
has no submit step — the Coordinator approves/rejects it directly.

Idempotent: re-running only fills missing permissions / users.

    python manage.py seed_approval_roles
"""
from django.core.management.base import BaseCommand
from django.contrib.auth.models import User
from django.db import transaction

from core.models import Company, Warehouse, StakeholderUser
from hr.models import Staff
from rbac.models import ERPRole, ERPModule, UserRoleAssignment, RolePermission


# Permission presets ---------------------------------------------------------
def perm(**flags):
    """A RolePermission defaults dict with every flag off except those named."""
    base = {
        'can_view': False, 'can_create': False, 'can_edit': False, 'can_delete': False,
        'can_approve': False, 'can_reject': False, 'can_submit': False,
        'can_proceed_approval': False, 'can_send_email': False, 'can_export': False,
        'can_print': False, 'can_import': False, 'can_confirm': False,
        'can_close': False, 'can_cancel': False, 'can_issue': False, 'can_convert': False,
    }
    base.update(flags)
    return base


VIEW = perm(can_view=True)
FULL = perm(can_view=True, can_create=True, can_edit=True, can_delete=True,
            can_approve=True, can_reject=True, can_send_email=True,
            can_export=True, can_print=True, can_confirm=True)

# Per-role module → permission grid. Module names match setup_admin's MODULES.
ROLE_GRID = {
    'Warehouse Coordinator': {
        # Raises PRs and submits them (stage 1). Enters goods receipts, so it
        # needs to SEE the Purchase Orders it receives against (view-only).
        'Purchase Request': perm(can_view=True, can_create=True, can_edit=True, can_submit=True),
        'Purchase Order':   VIEW,
        'Receipt Advice':   perm(can_view=True, can_create=True, can_edit=True),
        'Inventory Ledger': VIEW,
        'Dashboard':        VIEW,
    },
    'Warehouse Manager': {
        # Can also raise a PR; advances a submitted PR to the final approver
        # (stage 2 → "Factory Approved"). Oversees receipts + stock, and sees
        # the Purchase Orders the receipts are entered against (view-only).
        'Purchase Request': perm(can_view=True, can_create=True, can_edit=True,
                                 can_proceed_approval=True),
        'Purchase Order':   VIEW,
        'Receipt Advice':   perm(can_view=True, can_create=True, can_edit=True,
                                 can_approve=True),
        'Inventory Ledger': VIEW,
        'Dashboard':        VIEW,
    },
    'Purchase Coordinator': {
        # Final PR decision (stage 3). Can edit the PR before deciding. Owns
        # the downstream purchase pipeline.
        'Purchase Request':  perm(can_view=True, can_edit=True,
                                  can_approve=True, can_reject=True),
        'RFQ':               FULL,
        'Quote':             FULL,
        'Quote Evaluation':  FULL,
        # PO: approve/reject directly — no submit stage.
        'Purchase Order':    perm(can_view=True, can_create=True, can_edit=True,
                                  can_approve=True, can_reject=True, can_send_email=True,
                                  can_export=True, can_print=True),
        'Vendor Bill':       FULL,
        'Payment Made':      FULL,
        'Vendor Credit':     FULL,
        'Vendor':            VIEW,
        'Product':           VIEW,
        'Dashboard':         VIEW,
    },
}

# Demo logins: (username, password, role, first, last).
USERS = [
    ('wc', 'Pass@123', 'Warehouse Coordinator', 'Warehouse', 'Coordinator'),
    ('wm', 'Pass@123', 'Warehouse Manager',     'Warehouse', 'Manager'),
    ('pc', 'Pass@123', 'Purchase Coordinator',  'Purchase',  'Coordinator'),
]


class Command(BaseCommand):
    help = 'Seed the WC/WM/PC approval roles, their permissions, and one login each.'

    @transaction.atomic
    def handle(self, *args, **options):
        w = self.stdout.write
        company = Company.objects.first()
        warehouse = Warehouse.objects.first()
        if not company or not warehouse:
            w(self.style.ERROR('No Company/Warehouse — run setup_admin first.'))
            return

        # --- Roles + permission grid ---
        for role_name, grid in ROLE_GRID.items():
            role, _ = ERPRole.objects.get_or_create(
                name=role_name, defaults={'is_active': True})
            set_count = 0
            for module_name, flags in grid.items():
                module = ERPModule.objects.filter(name=module_name).first()
                if not module:
                    w(self.style.WARNING(f'  [{role_name}] module not found: {module_name}'))
                    continue
                rp, created = RolePermission.objects.get_or_create(
                    role=role, module=module, defaults=flags)
                if not created:
                    # Turn ON any flag this grid grants; never revoke others.
                    changed = False
                    for f, v in flags.items():
                        if v and not getattr(rp, f):
                            setattr(rp, f, v)
                            changed = True
                    if changed:
                        rp.save()
                set_count += 1
            w(self.style.SUCCESS(f'  {role_name}: {set_count} module permission(s)'))

        # --- One login per role ---
        for username, password, role_name, first, last in USERS:
            role = ERPRole.objects.get(name=role_name)
            user = User.objects.filter(username=username).first()
            if not user:
                user = User.objects.create_user(
                    username=username, password=password,
                    first_name=first, last_name=last,
                    email=f'{username}@company.com', is_staff=True)
                w(self.style.SUCCESS(f'  user {username} created (password: {password})'))
            else:
                w(f'  user {username} already exists')
            staff, _ = Staff.objects.get_or_create(
                staff_id=f'{username.upper()}-001',
                defaults={'staff_type': 'STAFF', 'first_name': first, 'last_name': last,
                          'company': company, 'primary_location': warehouse,
                          'employment_status': 'ACTIVE'})
            StakeholderUser.objects.get_or_create(
                user=user,
                defaults={'employee_record': staff, 'primary_email': f'{username}@company.com',
                          'default_warehouse': warehouse, 'status': 'ACTIVE'})
            UserRoleAssignment.objects.get_or_create(
                user=user, defaults={'role': role, 'assigned_by': user})

        w('')
        w(self.style.SUCCESS('=' * 52))
        w(self.style.SUCCESS('APPROVAL ROLES SEEDED'))
        w(self.style.SUCCESS('=' * 52))
        w('  wc / Pass@123  - Warehouse Coordinator (create + submit PR)')
        w('  wm / Pass@123  - Warehouse Manager   (proceed -> Factory Approved)')
        w('  pc / Pass@123  - Purchase Coordinator (final approve/reject; owns PO)')
        w(self.style.SUCCESS('=' * 52))

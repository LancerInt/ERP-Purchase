"""Domain-specific permission helpers for the purchase module."""

# Roles permitted to enable / use RFQ Skip on a Purchase Request.
# Stored lowercase, trimmed — matched case-insensitively against the user's role name.
RFQ_SKIP_ALLOWED_ROLES = {
    'admin',
    'administrator',
    'it admin',
    'office manager',
    'purchase coordinator',
    'purchase manager',
}


def user_can_skip_rfq(user):
    """Return True if the given user is authorized to enable / trigger RFQ Skip.

    Authorized when ANY of these holds:
      * Django superuser, OR
      * The user's role has the dedicated ``can_skip_rfq`` permission
        bit set on the Purchase Request module (RolePermission), OR
      * The user's role name is in ``RFQ_SKIP_ALLOWED_ROLES`` (legacy
        hard-coded list, kept for installations that haven't ticked the
        new RBAC flag yet).

    Falls back to the legacy core.StakeholderUser.assigned_roles M2M if no
    rbac assignment exists, so installations that haven't migrated yet still
    work.
    """
    if user is None or not getattr(user, 'is_authenticated', False):
        return False
    if getattr(user, 'is_superuser', False):
        return True

    # Primary: rbac UserRoleAssignment + RolePermission can_skip_rfq flag.
    # If the admin ticked the new "Skip RFQ" button toggle on the
    # Purchase Request row, that's enough — no role-name check needed.
    try:
        from rbac.models import UserRoleAssignment, RolePermission
        assignment = UserRoleAssignment.objects.select_related('role').filter(user=user).first()
        if assignment and assignment.role:
            has_flag = RolePermission.objects.filter(
                role=assignment.role,
                module__name__iexact='Purchase Request',
                can_skip_rfq=True,
            ).exists()
            if has_flag:
                return True
            name = (assignment.role.name or '').strip().lower()
            if name in RFQ_SKIP_ALLOWED_ROLES:
                return True
    except Exception:
        pass

    # Fallback: legacy core.StakeholderUser.assigned_roles
    stakeholder = getattr(user, 'stakeholder_profile', None)
    if stakeholder:
        try:
            role_names = stakeholder.assigned_roles.values_list('role_name', flat=True)
            if any((n or '').strip().lower() in RFQ_SKIP_ALLOWED_ROLES for n in role_names):
                return True
        except Exception:
            pass

    return False


def user_can_direct_receipt(user):
    """Return True if the user may create a Direct Receipt (stock IN with no
    upstream PO). Authorized when the user is a Django superuser OR their role
    has the dedicated ``can_direct_receipt`` flag on the Receipt Advice module.

    This mirrors the frontend "Direct Receipt" source-toggle gate so the
    privileged path can't be reached by crafting a request directly.
    """
    if user is None or not getattr(user, 'is_authenticated', False):
        return False
    if getattr(user, 'is_superuser', False):
        return True
    try:
        from rbac.models import UserRoleAssignment, RolePermission
        assignment = UserRoleAssignment.objects.select_related('role').filter(user=user).first()
        if assignment and assignment.role:
            return RolePermission.objects.filter(
                role=assignment.role,
                module__name__iexact='Receipt Advice',
                can_direct_receipt=True,
            ).exists()
    except Exception:
        pass
    return False

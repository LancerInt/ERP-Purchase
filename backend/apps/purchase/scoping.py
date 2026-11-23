"""Requirement-type row scoping for the purchase chain.

Parallel to the warehouse row-scoping in ``core.mixins``: instead of scoping
by the user's warehouses, this scopes the purchase entities by the
``PurchaseRequest.requirement_type`` (GOODS / SERVICES / MACHINERY) a role is
allowed to handle. A PR-derived entity (RFQ / Quote / Evaluation / PO) is
visible when it traces back to a PR of an allowed requirement_type.

The allowed types are ADMIN-CONFIGURABLE per role, via the three
``req_scope_*`` flags on the role's **'Purchase Request'** RolePermission row
(set on the Purchase permissions page). Leaving all three unticked means "no
restriction" — the role sees every type. Superusers always see everything.
"""
from django.db.models import Q

REQ_TYPE_FLAGS = {
    'GOODS': 'req_scope_goods',
    'SERVICES': 'req_scope_services',
    'MACHINERY': 'req_scope_machinery',
}


def user_allowed_requirement_types(user):
    """Set of requirement_type values the user may see, or ``None`` = no limit.

    ``None``  → superuser, no role, no PR permission row, or none of the
                req_scope flags ticked → sees every type.
    ``{...}`` → restricted to exactly the ticked requirement types.
    """
    if not getattr(user, 'is_authenticated', False) or user.is_superuser:
        return None
    from rbac.models import RolePermission, UserRoleAssignment
    try:
        role = user.erp_role_assignment.role
    except (AttributeError, UserRoleAssignment.DoesNotExist):
        return None
    rp = RolePermission.objects.filter(
        role=role, module__name='Purchase Request',
    ).values('req_scope_goods', 'req_scope_services', 'req_scope_machinery').first()
    if not rp:
        return None
    allowed = {rt for rt, flag in REQ_TYPE_FLAGS.items() if rp.get(flag)}
    return allowed or None  # nothing ticked → unrestricted


def scope_by_requirement_type(qs, user, path='requirement_type'):
    """Filter ``qs`` to the user's allowed requirement types.

    ``path`` is the ORM lookup from the queryset's model to the PR's
    ``requirement_type`` — e.g. ``'requirement_type'`` on PurchaseRequest,
    ``'linked_prs__requirement_type'`` on RFQ/PO, or
    ``'rfq__linked_prs__requirement_type'`` on Quote/Evaluation. Cross-relation
    paths are de-duplicated (a join over an M2M can multiply rows).

    A relational path also lets through rows with NO linked PR at all (a PO
    created directly, without going through a PR — a normal flow). Those
    aren't "of a disallowed type", they're simply not PR-derived, so this
    rule doesn't apply to them. Without this, a plain ``__in`` filter's
    implicit inner join drops every PR-less row for any scoped role — e.g. a
    role with `req_scope_goods` ticked would see zero directly-created POs.
    """
    allowed = user_allowed_requirement_types(user)
    if allowed is None:
        return qs
    if '__' in path:
        base = path.rsplit('__', 1)[0]
        qs = qs.filter(Q(**{f'{path}__in': list(allowed)}) | Q(**{f'{base}__isnull': True}))
        qs = qs.distinct()
    else:
        qs = qs.filter(**{f'{path}__in': list(allowed)})
    return qs

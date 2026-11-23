"""Shared row-level access-control mixins (warehouse scoping).

Originally Sales-only (apps/sales/mixins.py); promoted here so any module
can opt in. Sales now re-exports these names for backward compatibility.

Policy (unchanged from the Sales original — fail-OPEN by design):
  * Users WITHOUT a StakeholderUser profile see everything (legacy admins).
  * Users WITH a profile but EMPTY warehouse_scope AND no default_warehouse
    also see everything — empty scope means "no restriction configured".
    An admin opts a user INTO scoping by adding warehouses to their
    `warehouse_scope` M2M.
  * Once warehouse_scope is non-empty (or only default_warehouse is set for
    a non-bypass user), filtering kicks in.
  * Superusers always see everything; a configurable per-role bypass list
    gives managers cross-warehouse visibility.

Enabling the mixin therefore does NOT lock anything down until an admin
assigns scopes. Set `WAREHOUSE_SCOPE_STRICT = True` for fail-closed
(unconfigured user sees nothing). Settings are read under the generic
names first, falling back to the legacy `SALES_*` names for parity.
"""
from __future__ import annotations

from django.conf import settings
from django.db.models import Q
from rest_framework.exceptions import PermissionDenied

# Default role names that bypass warehouse scoping entirely. Override via
# Django settings `WAREHOUSE_SCOPE_BYPASS_ROLES` (list/set/tuple) — set to
# `[]` so EVERY non-superuser is subject to their assigned warehouse_scope.
DEFAULT_WAREHOUSE_SCOPE_BYPASS_ROLES = {
    'Sales Manager',
    'Office Manager',
    # 'Office Management' is the role that actually exists in this
    # deployment — created by hand in Admin > Roles rather than from
    # PREDEFINED_ROLES, which only has the singular 'Office Manager'.
    # The two are matched by EXACT NAME here, so the hand-made one
    # silently got none of this list's effect: office staff were scoped
    # to their own sites while looking, on the Roles page, identical to
    # the role that is not. Both names are listed rather than renaming
    # the row, because renaming it to 'Office Manager' would ALSO make
    # those users admins (rbac.views._is_office_manager_or_admin matches
    # the same string) — a privilege nobody asked for. Office staff are
    # company-wide for DATA; that is all this grants.
    'Office Management',
    'IT Admin',
    'Finance Manager',
    'Accounts Manager',
    # Cross-branch approval managers also see every warehouse — they
    # approve work spanning branches. WAREHOUSE-level roles (Warehouse
    # Manager / Supervisor / Coordinator) are deliberately NOT here so
    # they stay scoped to their site.
    'Purchase Manager',
    # Purchase Coordinator is a PROCUREMENT role (not a warehouse-level
    # coordinator): it processes PRs / RFQs / POs company-wide, so it must
    # see requests from every warehouse — otherwise a PR raised at another
    # site never reaches the coordinator's list even though it's routed to
    # them for approval.
    'Purchase Coordinator',
    'Production Manager',
    'QC Manager',
}


def _setting(*names, default=None):
    """First defined setting among `names`, else `default`."""
    for name in names:
        val = getattr(settings, name, None)
        if val is not None:
            return val
    return default


def _bypass_role_names():
    """Resolve the effective bypass-role list, honoring Django settings."""
    override = _setting('WAREHOUSE_SCOPE_BYPASS_ROLES', 'SALES_WAREHOUSE_SCOPE_BYPASS_ROLES')
    if override is None:
        return DEFAULT_WAREHOUSE_SCOPE_BYPASS_ROLES
    return set(override)


# Module-level alias kept for callers/tests that imported it directly.
WAREHOUSE_SCOPE_BYPASS_ROLES = DEFAULT_WAREHOUSE_SCOPE_BYPASS_ROLES


def _user_allowed_warehouse_ids(user):
    """Resolve the set of warehouse PKs this user may access.

    Returns one of:
      * `None`  → no restriction (superuser, profile-less legacy admin, or
        an unscoped bypass-role user). Callers MUST check `is None` first.
      * `set()` → user sees nothing (only under STRICT for a profiled but
        unscoped user, or for an unauthenticated user).
      * `{id, ...}` → restricted to these specific warehouses.

    Resolution: superuser → None; explicit non-empty warehouse_scope wins
    (even for bypass roles); else bypass role → None; else a lone
    default_warehouse caps a non-bypass user; else fail-open unless STRICT.
    """
    if not getattr(user, 'is_authenticated', False):
        return set()
    if user.is_superuser:
        return None

    # An EXPLICIT per-user warehouse assignment always wins (including over
    # the bypass-role list). A bare default_warehouse is NOT a restriction
    # here — it's a 'home' marker, honoured for non-bypass users below.
    profile = getattr(user, 'stakeholder_profile', None)
    if profile is not None:
        scope_ids = set(profile.warehouse_scope.values_list('id', flat=True))
        if scope_ids:
            return scope_ids

    # Role-based bypass (configurable; empty list disables it).
    bypass_roles = _bypass_role_names()
    if bypass_roles:
        try:
            assignment = user.erp_role_assignment
            if assignment and assignment.role and assignment.role.name in bypass_roles:
                return None
        except Exception:  # noqa: BLE001 — missing related object → no bypass
            pass

    # PRIMARY scoping source: the warehouses this non-bypass staff member is
    # posted at, per the Staff form's `location_ids`. The explicit
    # warehouse_scope M2M above is a manual per-user override that wins over
    # this; managers (bypass roles) already returned None above. Stored as
    # Warehouse UUID *strings* — validate_warehouse_for_write normalises the
    # write-side compare so a UUID instance still matches.
    staff = getattr(profile, 'employee_record', None) if profile is not None else None
    if staff is not None:
        loc_ids = {str(x) for x in (staff.location_ids or []) if x}
        if loc_ids:
            return loc_ids

    # A lone default_warehouse restricts a NON-bypass user to that branch.
    if profile is not None and profile.default_warehouse_id:
        return {profile.default_warehouse_id}

    # Profile missing or scope empty → fail-open unless STRICT.
    if _setting('WAREHOUSE_SCOPE_STRICT', 'SALES_WAREHOUSE_SCOPE_STRICT', default=False):
        return set()
    return None


class WarehouseScopedQuerysetMixin:
    """Restrict list/detail queries to the user's allowed warehouses.

    Subclasses set `warehouse_field` — the ORM path from the model to its
    Warehouse FK (`warehouse` default, a renamed direct FK, an indirect
    `a__b__warehouse` path, or `None` to opt out / no-op).

    IMPORTANT: a subclass overriding get_queryset MUST call
    super().get_queryset() or the scoping silently no-ops. Direct-FK
    viewsets also get write-side enforcement (perform_create/update);
    indirect paths rely on read-side scoping (the user can't reach the
    out-of-scope parent to attach to).
    """

    # ORM path(s) to the Warehouse FK. A str for a single field, or a
    # list/tuple to match if ANY of several fields is in scope (e.g. a
    # stock transfer's from/to). None opts out (no-op).
    warehouse_field = 'warehouse'
    # When True, rows whose warehouse path is NULL stay visible to everyone
    # (for models with a nullable / legacy warehouse FK).
    warehouse_scope_include_null: bool = False

    def _warehouse_fields(self):
        wf = self.warehouse_field
        if not wf:
            return []
        return list(wf) if isinstance(wf, (list, tuple)) else [wf]

    def _scope_q(self, allowed):
        q = Q()
        fields = self._warehouse_fields()
        if allowed:
            for f in fields:
                q |= Q(**{f'{f}__in': allowed})
        if self.warehouse_scope_include_null:
            # EVERY path must be null, not any of them. With a single
            # field the two readings are identical, but a multi-field
            # scope makes the difference a data leak: SalesInvoiceCheck
            # scopes on both `dc_reference__warehouse` (legacy FK) and
            # `dc_references__warehouse` (M2M), and an invoice linked
            # through only one of them has the OTHER path NULL. OR-ing
            # the isnull clauses would therefore match that invoice and
            # show it to every scoped user — an invoice whose DC sits at
            # warehouse A leaking to a user scoped to warehouse B, which
            # is precisely the isolation this mixin exists to provide.
            #
            # AND-ing keeps the intended meaning: "this row reaches no
            # warehouse at all, so there is nothing to scope it by."
            null_q = Q()
            for f in fields:
                null_q &= Q(**{f'{f}__isnull': True})
            q |= null_q
        return q

    def get_queryset(self):
        qs = super().get_queryset()
        fields = self._warehouse_fields()
        if not fields:
            return qs
        allowed = _user_allowed_warehouse_ids(self.request.user)
        if allowed is None:
            return qs  # No restriction — superuser, bypass role, fail-open.
        q = self._scope_q(allowed)
        if not q:
            return qs.none()  # empty scope, no null opt-in → see nothing.
        qs = qs.filter(q)
        if any('__' in f for f in fields):
            qs = qs.distinct()  # indirect joins can duplicate rows.
        return qs

    def validate_warehouse_for_write(self, warehouse):
        """Refuse a write whose target warehouse is outside the user's
        scope. Accepts a Warehouse instance or a PK; raises 403."""
        if self.warehouse_field is None or warehouse is None:
            return
        allowed = _user_allowed_warehouse_ids(self.request.user)
        if allowed is None:
            return
        wh_id = getattr(warehouse, 'pk', warehouse)
        # Normalise both sides to strings: `allowed` may hold UUID instances
        # (warehouse_scope M2M) or UUID strings (Staff.location_ids).
        if str(wh_id) not in {str(a) for a in allowed}:
            raise PermissionDenied(
                'You do not have access to the selected warehouse for this record.'
            )

    def _direct_warehouse_field(self):
        wf = self.warehouse_field
        if not wf or isinstance(wf, (list, tuple)) or '__' in wf:
            return None
        return wf

    def perform_create(self, serializer):
        field = self._direct_warehouse_field()
        if field is not None:
            self.validate_warehouse_for_write(serializer.validated_data.get(field))
        super().perform_create(serializer)

    def perform_update(self, serializer):
        field = self._direct_warehouse_field()
        if field is not None:
            warehouse = (
                serializer.validated_data.get(field)
                or getattr(serializer.instance, field, None)
            )
            self.validate_warehouse_for_write(warehouse)
        super().perform_update(serializer)

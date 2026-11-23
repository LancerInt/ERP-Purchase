"""Central helper for writing to rbac.AuditLog.

The AuditLog table is the "who changed what and when" trail — every
document state change, master edit, and mutating action across the ERP
should call ``audit_event()`` here rather than instantiating AuditLog
directly. Two wins vs the older ``AuditLog.objects.create(...)`` pattern:

  1. Consistent capture of user + role + IP + record reference in one
     call, so per-record activity tabs on detail pages have data to
     show without every caller remembering to set record_id.

  2. One place to add async / batching / off-DB sink if the trail grows
     enough to hurt write latency later.

The helper is defensive — an audit failure MUST NOT roll back the
underlying business action. Every log call is wrapped in try/except
that swallows all exceptions (logged for grep, not raised).

Auto-registration:
    Call ``register_audited_model(MyModel, module_name='X')`` in an
    app's ``apps.py::ready()`` to auto-log post_save (CREATE / EDIT)
    and post_delete (DELETE) events for that model. Uses thread-local
    request state (see ``AuditRequestMiddleware``) to attach the actor.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from django.db import DatabaseError
from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver


logger = logging.getLogger(__name__)

# Thread-local slot for the current HTTP request. Set by
# AuditRequestMiddleware on every request; None on background /
# management-command / signal-out-of-request contexts.
_local = threading.local()


def _current_request():
    return getattr(_local, 'request', None)


class AuditRequestMiddleware:
    """Stashes the current request on a thread-local so signal handlers
    (which don't get a request arg) can still capture the actor + IP."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        _local.request = request
        try:
            return self.get_response(request)
        finally:
            _local.request = None


def _client_ip(request) -> Optional[str]:
    """Prefer X-Forwarded-For (behind Render's proxy), fall back to
    REMOTE_ADDR. Returns None when there's no request context (shell
    actions, management commands, background tasks)."""
    if request is None:
        return None
    meta = getattr(request, 'META', {}) or {}
    xff = meta.get('HTTP_X_FORWARDED_FOR')
    if xff:
        # first hop is the actual client, rest are proxies
        return xff.split(',')[0].strip()
    return meta.get('REMOTE_ADDR')


def _role_name_for(user) -> str:
    """Try common role-holder shapes without hard-depending on the
    stakeholder/RBAC model tree — keeps this helper importable from
    anywhere."""
    if user is None:
        return ''
    try:
        from django.apps import apps as django_apps  # noqa: WPS433
        UserRoleAssignment = django_apps.get_model('rbac', 'UserRoleAssignment')
        ura = UserRoleAssignment.objects.select_related('role').filter(user=user).first()
        if ura and ura.role:
            return ura.role.name or ''
    except Exception:  # noqa: BLE001
        pass
    # Fallback shapes
    role = getattr(user, 'role', None)
    if role:
        name = getattr(role, 'name', None) or str(role)
        return name or ''
    return ''


def audit_event(
    *,
    user=None,
    request=None,
    module: str,
    action: str,
    record=None,
    record_id: str = '',
    record_repr: str = '',
    details: str = '',
) -> None:
    """Write one AuditLog row.

    Args:
        user: The actor. If omitted and ``request`` is provided, uses
            ``request.user``. Anonymous / system actions can pass user=None.
        request: DRF/Django request — used to grab the actor and IP when
            omitted individually.
        module: Human module label ("Purchase Order", "Sales Invoice",
            "Vendor", "Stock Adjustment", …). Kept as a string so a
            module rename doesn't break historical rows.
        action: One of AuditLog.ACTION_CHOICES codes
            (CREATE / VIEW / EDIT / DELETE / LOGIN / LOGOUT / PASSWORD).
            Callers can pass higher-level workflow verbs by mapping them
            to EDIT and putting the specifics in ``details``.
        record: Model instance whose id/repr to capture. Optional — if
            unset, ``record_id`` / ``record_repr`` can be passed
            explicitly (bulk actions, cross-record events).
        record_id: Explicit override when there's no single ``record``.
        record_repr: Explicit override for the display label.
        details: Free-text description of what happened. Include the
            document number / vendor name / status transition so an
            auditor reading the row makes sense of it without opening
            the referenced record.

    Returns None. Never raises — an audit failure won't roll back the
    caller's transaction.
    """
    try:
        # apps.get_model routes through the Django app registry, which
        # uses the SHORT app label ('rbac') that INSTALLED_APPS declares.
        # A direct `from apps.rbac.models import AuditLog` triggers
        # "Model class doesn't declare app_label" from within signals
        # because the module path doesn't match the app registry.
        from django.apps import apps as django_apps  # noqa: WPS433
        AuditLog = django_apps.get_model('rbac', 'AuditLog')

        # Fall back to the thread-local request captured by
        # AuditRequestMiddleware so signal-driven callers (which don't
        # get a request arg) still record the actor.
        if request is None:
            request = _current_request()

        actor = user
        if actor is None and request is not None:
            actor = getattr(request, 'user', None)
            if actor is not None and not getattr(actor, 'is_authenticated', False):
                actor = None

        rid = record_id
        rrepr = record_repr
        if record is not None:
            if not rid:
                rid = str(getattr(record, 'pk', '') or '')
            if not rrepr:
                # Try common label attrs, fall back to __str__.
                for attr in ('display_name', 'name', 'vendor_name',
                             'product_name', 'so_no', 'po_no', 'pr_no',
                             'receipt_advice_no', 'invoice_no',
                             'bill_no', 'dc_no', 'quote_no', 'rfq_no',
                             'title', 'code'):
                    val = getattr(record, attr, None)
                    if val:
                        rrepr = str(val)
                        break
                if not rrepr:
                    rrepr = str(record)

        AuditLog.objects.create(
            user=actor,
            role_name=_role_name_for(actor),
            module_name=module or '',
            action=action or 'EDIT',
            details=details or '',
            record_id=rid or '',
            record_repr=(rrepr or '')[:255],
            ip_address=_client_ip(request),
        )
    except (DatabaseError, ImportError):
        # Never propagate DB / import errors — the business action
        # succeeded, the trail is best-effort.
        logger.exception('audit_event failed silently')
    except Exception:  # noqa: BLE001
        logger.exception('audit_event failed silently')


class AuditedViewSetMixin:
    """Drop-in mixin for DRF ModelViewSets that auto-logs CRUD.

    Usage::

        class VendorViewSet(AuditedViewSetMixin, viewsets.ModelViewSet):
            module_name = 'Vendor'
            ...

    Behaviour:
        * ``perform_create``  → CREATE event with the new record.
        * ``perform_update``  → EDIT event with the updated record.
        * ``perform_destroy`` → DELETE event captured BEFORE the row is
          gone (so we still have its repr).

    Reads ``self.module_name`` for the module label (already set by
    most viewsets for the HasModulePermission check). Falls back to
    the model's ``verbose_name`` if not set.

    Custom ``@action`` methods still need explicit ``audit_event(...)``
    calls — the mixin only covers the standard CRUD verbs.
    """

    def _audit_module(self):
        m = getattr(self, 'module_name', None)
        if m:
            return m
        try:
            return str(self.get_queryset().model._meta.verbose_name).title()
        except Exception:  # noqa: BLE001
            return self.__class__.__name__.replace('ViewSet', '')

    def perform_create(self, serializer):
        super().perform_create(serializer)
        try:
            audit_event(
                request=self.request,
                module=self._audit_module(),
                action='CREATE',
                record=serializer.instance,
                details=f'{self._audit_module()} created.',
            )
        except Exception:  # noqa: BLE001
            logger.exception('AuditedViewSetMixin.perform_create audit failed')

    def perform_update(self, serializer):
        super().perform_update(serializer)
        try:
            audit_event(
                request=self.request,
                module=self._audit_module(),
                action='EDIT',
                record=serializer.instance,
                details=f'{self._audit_module()} updated.',
            )
        except Exception:  # noqa: BLE001
            logger.exception('AuditedViewSetMixin.perform_update audit failed')

    def perform_destroy(self, instance):
        # Capture BEFORE delete so the repr and pk are still readable.
        try:
            snapshot_pk = str(getattr(instance, 'pk', '') or '')
            snapshot_repr = ''
            for attr in ('display_name', 'name', 'vendor_name',
                         'product_name', 'so_no', 'po_no', 'pr_no',
                         'receipt_advice_no', 'invoice_no', 'bill_no',
                         'dc_no', 'quote_no', 'rfq_no', 'title', 'code'):
                val = getattr(instance, attr, None)
                if val:
                    snapshot_repr = str(val)
                    break
            if not snapshot_repr:
                snapshot_repr = str(instance)
        except Exception:  # noqa: BLE001
            snapshot_pk, snapshot_repr = '', ''
        super().perform_destroy(instance)
        try:
            audit_event(
                request=self.request,
                module=self._audit_module(),
                action='DELETE',
                record_id=snapshot_pk,
                record_repr=snapshot_repr,
                details=f'{self._audit_module()} deleted: {snapshot_repr}.',
            )
        except Exception:  # noqa: BLE001
            logger.exception('AuditedViewSetMixin.perform_destroy audit failed')


# Track which model classes have been auto-registered so a repeated
# registration (e.g., double-registered in two ready() calls) doesn't
# hook duplicate signal handlers.
_REGISTERED: set = set()


def register_audited_model(model_cls, module_name: str, *, log_edit: bool = True) -> None:
    """Hook post_save / post_delete on `model_cls` to emit AuditLog rows.

    Call from an app's ``apps.py::ready()``::

        from common.audit import register_audited_model
        from .models import PurchaseOrder
        register_audited_model(PurchaseOrder, 'Purchase Order')

    Behaviour:
        * post_save with created=True   → CREATE event
        * post_save with created=False  → EDIT event (skip if log_edit=False)
        * post_delete                   → DELETE event

    Skips fixture loads (raw=True). Uses the thread-local request from
    AuditRequestMiddleware for the actor + IP. Custom @action methods
    that don't touch the ORM (or want richer context) should still
    call ``audit_event()`` directly.
    """
    if model_cls in _REGISTERED:
        return
    _REGISTERED.add(model_cls)

    dispatch_uid_save = f'audit_post_save_{model_cls._meta.label_lower}'
    dispatch_uid_del = f'audit_post_delete_{model_cls._meta.label_lower}'

    @receiver(post_save, sender=model_cls, dispatch_uid=dispatch_uid_save, weak=False)
    def _on_save(sender, instance, created, raw=False, **kwargs):  # noqa: WPS430
        if raw:
            return  # fixture loads shouldn't produce audit noise
        if not created and not log_edit:
            return
        try:
            audit_event(
                module=module_name,
                action='CREATE' if created else 'EDIT',
                record=instance,
                details=f'{module_name} {"created" if created else "updated"}.',
            )
        except Exception:  # noqa: BLE001
            logger.exception('auto-audit post_save failed for %s', module_name)

    @receiver(post_delete, sender=model_cls, dispatch_uid=dispatch_uid_del, weak=False)
    def _on_delete(sender, instance, **kwargs):  # noqa: WPS430
        try:
            audit_event(
                module=module_name,
                action='DELETE',
                record=instance,
                details=f'{module_name} deleted.',
            )
        except Exception:  # noqa: BLE001
            logger.exception('auto-audit post_delete failed for %s', module_name)

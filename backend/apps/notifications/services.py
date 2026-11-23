"""Notification creation helpers.

This is the single entry point for raising in-app notifications. Business
code (approval actions, scheduled overdue scans, …) calls these helpers
rather than touching the model directly, so role resolution and the
defensive try/except live in one place.

Every helper is fail-soft: a notification must never break the business
transaction that raised it. On any error we log and return None/[] so the
caller's primary work (approving a PR, etc.) still succeeds.
"""
import logging

logger = logging.getLogger(__name__)


def notify_user(user, title, message='', link='', category='', level='info', actor=None):
    """Create one notification for a single Django user. Returns it or None.

    Also fires a native Web Push to the user's registered devices (best-effort,
    in a background thread) so the alert reaches them even when the app is
    closed. Push never blocks or breaks the in-app notification.
    """
    if user is None:
        return None
    try:
        from .models import Notification
        notification = Notification.objects.create(
            recipient=user,
            actor=actor,
            title=title,
            message=message or '',
            link=link or '',
            category=category or '',
            level=level or 'info',
        )
    except Exception:
        logger.exception('notify_user failed for user=%s', getattr(user, 'pk', user))
        return None
    # Fire the native push ONLY after the request-level transaction commits
    # (ATOMIC_REQUESTS=True in prod). A native push is irreversible — if the
    # business action later rolls back, we must not have already pushed an
    # event that never happened. on_commit runs immediately under autocommit
    # (dev), so this is correct in both modes; it also means the push thread
    # reads committed subscription rows, not a stale pre-commit view.
    from django.db import transaction
    transaction.on_commit(
        lambda: _dispatch_push(user, title=title, body=message or '', url=link or '/',
                               tag=category or '', level=level or 'info')
    )
    return notification


def _dispatch_push(user, **kwargs):
    """Fire the Web Push off the request thread so a slow push service can't
    delay the response (or a fan-out to many approvers). Fully fail-soft."""
    import threading

    def _run():
        from django.db import connection
        try:
            from .push import send_web_push
            send_web_push(user, **kwargs)
        except Exception:
            logger.exception('web push dispatch failed')
        finally:
            connection.close()  # the thread opened its own connection

    try:
        threading.Thread(target=_run, daemon=True).start()
    except Exception:
        logger.exception('could not start push thread')


def notify_users(users, title, **kwargs):
    """Create a notification for each user (de-duplicated). Returns the list."""
    created = []
    seen = set()
    for u in users:
        if u is None:
            continue
        uid = getattr(u, 'pk', None)
        if uid is not None and uid in seen:
            continue
        seen.add(uid)
        n = notify_user(u, title, **kwargs)
        if n is not None:
            created.append(n)
    return created


def users_with_module_permission(module_name, action='can_approve'):
    """Active users whose ERP role grants ``action`` on ``module_name``.

    Mirrors ``rbac.permissions.check_permission`` (matches ERPModule by
    name), so "who can approve Purchase Request" resolves identically to
    the permission gate on the approve endpoint.
    """
    try:
        from django.contrib.auth import get_user_model
        from rbac.models import RolePermission, UserRoleAssignment

        User = get_user_model()
        role_ids = list(
            RolePermission.objects
            .filter(module__name=module_name, **{action: True})
            .values_list('role_id', flat=True)
        )
        if not role_ids:
            return User.objects.none()
        user_ids = list(
            UserRoleAssignment.objects
            .filter(role_id__in=role_ids)
            .values_list('user_id', flat=True)
        )
        return User.objects.filter(id__in=user_ids, is_active=True)
    except Exception:
        logger.exception('users_with_module_permission failed for module=%s', module_name)
        from django.contrib.auth import get_user_model
        return get_user_model().objects.none()


def notify_approvers(module_name, title, message='', link='', exclude_user=None,
                     actor=None, level='info', category='approval'):
    """Notify everyone who can approve ``module_name`` (e.g. on submit).

    ``exclude_user`` (usually the submitter) is dropped so people aren't
    pinged about their own action.
    """
    users = users_with_module_permission(module_name, 'can_approve')
    if exclude_user is not None:
        try:
            users = users.exclude(pk=exclude_user.pk)
        except Exception:
            pass
    return notify_users(
        list(users), title, message=message, link=link,
        category=category, level=level, actor=actor,
    )

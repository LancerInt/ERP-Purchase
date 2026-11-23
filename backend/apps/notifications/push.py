"""Web Push (VAPID) delivery for native notifications.

Native push fires even when the PWA is closed — the "like other apps"
behaviour. It is layered ON TOP of the in-app bell: every notification still
becomes a ``Notification`` row; this module additionally pushes it to the
recipient's registered devices.

Fail-soft by design: a push send must never break the business transaction
or the in-app notification that raised it. We log and move on. Dead
subscriptions (404 / 410 from the push service) are pruned.

Configuration (env vars):
    VAPID_PUBLIC_KEY   base64url public key (also handed to the browser)
    VAPID_PRIVATE_KEY  base64url raw 32-byte EC key (what our keygen prints),
                       or a base64-wrapped PEM
    VAPID_SUBJECT      'mailto:...' contact for the push service
When the keys are absent, every function no-ops, so the app runs fine
without push configured.
"""
import base64
import json
import logging
import os

from django.conf import settings

logger = logging.getLogger(__name__)


def _b64pad(s):
    return s + '=' * (-len(s) % 4)


def _cfg(name, default=''):
    return getattr(settings, name, '') or os.environ.get(name, '') or default


def vapid_public_key():
    """The base64url public key the browser needs to subscribe."""
    return _cfg('VAPID_PUBLIC_KEY')


def push_configured():
    return bool(vapid_public_key()) and bool(_vapid_private_pem())


def _vapid_private_pem():
    """Return the VAPID private key as a PKCS8 PEM string, or None.

    Accepts the env value as either a raw base64url 32-byte EC key (what our
    keygen prints) or a base64-wrapped PEM. pywebpush wants a PEM string.
    """
    raw = _cfg('VAPID_PRIVATE_KEY')
    if not raw:
        return None
    try:
        data = base64.urlsafe_b64decode(_b64pad(raw))
        if b'BEGIN' in data:
            return data.decode()
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        priv = ec.derive_private_key(int.from_bytes(data, 'big'), ec.SECP256R1())
        return priv.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode()
    except Exception:
        logger.exception('VAPID private key could not be parsed')
        return None


def _vapid_object():
    """Return a py_vapid ``Vapid01`` object for signing pushes, or None.

    pywebpush is handed THIS object directly — never a PEM string. py_vapid's
    ``from_string`` cannot parse a PEM (it raises "Could not deserialize key
    data" and only accepts the raw base64url key), so passing a PEM is the bug
    that made every send fail. Building the object here loads the raw key the
    way py_vapid expects, and still supports a PEM-in-env value.
    """
    raw = _cfg('VAPID_PRIVATE_KEY')
    if not raw:
        return None
    try:
        from py_vapid import Vapid01
    except Exception:
        logger.warning('py_vapid not installed; cannot sign web push')
        return None
    try:
        data = base64.urlsafe_b64decode(_b64pad(raw))
        if b'BEGIN' in data:
            return Vapid01.from_pem(data)
        return Vapid01.from_raw(raw.encode())
    except Exception:
        logger.exception('VAPID private key could not be loaded for signing')
        return None


def send_web_push(user, *, title, body='', url='/', tag='', level='info'):
    """Send a Web Push to every registered device of ``user``. Fail-soft."""
    vapid = _vapid_object()
    if vapid is None or user is None:
        return  # push not configured — the in-app bell still works
    try:
        from pywebpush import WebPushException, webpush
    except Exception:
        logger.warning('pywebpush not installed; skipping web push')
        return

    from .models import PushSubscription

    payload = json.dumps({
        'title': title or 'Lancer ERP',
        'body': body or '',
        'url': url or '/',
        'tag': tag or '',
        'level': level or 'info',
    })
    subject = _cfg('VAPID_SUBJECT', 'mailto:it@lancers.in')

    for sub in PushSubscription.objects.filter(user=user):
        try:
            webpush(
                subscription_info={
                    'endpoint': sub.endpoint,
                    'keys': {'p256dh': sub.p256dh, 'auth': sub.auth},
                },
                data=payload,
                vapid_private_key=vapid,
                vapid_claims={'sub': subject},
                timeout=10,
            )
        except WebPushException as exc:
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            # 404 / 410 → subscription gone for good. 401 / 403 → it was created
            # with a DIFFERENT VAPID key (e.g. before the keys were finalised) and
            # can never be delivered to with the current keys. Either way it's
            # dead → prune so a re-enable on the device creates a fresh, valid one.
            if status in (401, 403, 404, 410):
                PushSubscription.objects.filter(pk=sub.pk).delete()
            else:
                logger.warning('web push failed (status=%s) sub=%s', status, sub.pk)
        except Exception:
            logger.exception('web push error sub=%s', sub.pk)


def send_test_push(user):
    """Send a test push to ``user`` and return a diagnostic dict explaining the
    outcome — used by the 'Send test notification' button so misconfiguration is
    visible instead of silently swallowed."""
    result = {'ok': False, 'configured': push_configured(), 'subscriptions': 0,
              'sent': 0, 'failed': 0, 'errors': []}
    if not vapid_public_key():
        result['error'] = 'VAPID_PUBLIC_KEY is not set on the server.'
        return result
    vapid = _vapid_object()
    if vapid is None:
        result['error'] = 'VAPID_PRIVATE_KEY is not set (or could not be loaded) on the server.'
        return result
    try:
        from pywebpush import WebPushException, webpush
    except Exception:
        result['error'] = 'pywebpush is not installed on the server.'
        return result

    from .models import PushSubscription
    subs = list(PushSubscription.objects.filter(user=user))
    result['subscriptions'] = len(subs)
    if not subs:
        result['error'] = 'No device is subscribed for you — tap Enable on the device first.'
        return result

    payload = json.dumps({
        'title': 'Lancer ERP — test',
        'body': 'If you can see this in your notification tray, push works.',
        'url': '/notifications', 'tag': 'test', 'level': 'info',
    })
    subject = _cfg('VAPID_SUBJECT', 'mailto:it@lancers.in')
    pruned = 0
    for sub in subs:
        try:
            webpush(
                subscription_info={'endpoint': sub.endpoint, 'keys': {'p256dh': sub.p256dh, 'auth': sub.auth}},
                data=payload, vapid_private_key=vapid, vapid_claims={'sub': subject}, timeout=10,
            )
            result['sent'] += 1
        except WebPushException as exc:
            result['failed'] += 1
            sc = getattr(getattr(exc, 'response', None), 'status_code', None)
            result['errors'].append(f'status={sc}: {str(exc)[:160]}')
            # 401/403 = subscription made with a different/older VAPID key;
            # 404/410 = gone. All dead → remove so a re-enable makes a fresh one.
            if sc in (401, 403, 404, 410):
                PushSubscription.objects.filter(pk=sub.pk).delete()
                pruned += 1
        except Exception as exc:  # noqa: BLE001
            result['failed'] += 1
            result['errors'].append(str(exc)[:160])
    result['ok'] = result['sent'] > 0
    result['pruned'] = pruned
    if not result['ok'] and not result.get('error'):
        if pruned:
            # The keys themselves are fine (check_vapid confirms the pair) — the
            # device just subscribed under an older key. Pruned; re-enable fixes it.
            result['error'] = ('This device’s subscription was rejected and has been removed — it '
                               'was created with an earlier key. On the device tap Turn off, then '
                               'Enable again to re-subscribe, then Send test.')
        else:
            result['error'] = ('Push service rejected the message (' + '; '.join(result['errors'][:2])
                               + '). Run `python manage.py check_vapid` to verify the keys.')
    return result

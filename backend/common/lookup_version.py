"""Tell a browser whether a dropdown list has changed, without sending the list.

THE PROBLEM
-----------
useLookup caches each dropdown list in a module-level object, keyed by endpoint,
and never revalidates it. That cache lives as long as the browser tab. So a
vendor created at 10:00 does not appear in anybody else's Vendor dropdown until
they reload the page - which, in a tab left open all day, may be never. The
owner's words: "if new vendor created it should automatically in the next minute
without refreshing show".

Re-fetching the list on a timer would fix freshness and cost a fortune: the
vendor list is 132 KB and the product list 531 KB, on 28 and 21 pages
respectively.

WHAT THIS DOES
--------------
Answers one small question instead:

    GET /api/lookups/version/?e=/api/vendors/&e=/api/products/
    -> {"interval": 10,
        "versions": {"/api/vendors/": "3f91c0a8", "/api/products/": "11b4e5d2"}}

The browser keeps the token it last saw. Same token means nothing changed and
nothing is sent. A different token means refetch - and that happens within one
poll of the change, so a new vendor appears in seconds with no refresh.

GENERIC ON PURPOSE
------------------
There is no list of endpoint names in here. The path is resolved through the
project's own URLconf to the view that serves it, and the model is read off that
view. Add a new dropdown anywhere and this works for it on day one, with no edit
here - which is the standing instruction for this codebase: no hardcoding, keep
it dynamic.

WHAT A TOKEN IS, AND WHY IT IS HASHED
-------------------------------------
Row count plus the newest updated_at, hashed. Both halves are needed: an edit
moves the timestamp but not the count, and a delete-plus-create moves the count
back to where it started. Hashing means the reply leaks nothing - not how many
vendors exist, not when anything was touched - which matters because this
deliberately does NOT apply the per-company scoping the real list endpoint does.
It cannot: it is answering "has anything changed", not "what may this user see".
No rows are returned either way.

COST
----
One `count` and one `max(updated_at)` per model, memoised in the process for a
few seconds, so a hundred browsers polling together still cost one pair of
queries. The memo is per worker and deliberately short: a stale token would
delay a new vendor by at most that long.

Tuning, as environment variables, no deploy needed:
    LOOKUP_VERSION_INTERVAL=10   seconds between polls (the browser is told)
    LOOKUP_VERSION_TTL=5         seconds to reuse a computed token
"""
import hashlib
import logging
import os
import time

from django.urls import resolve
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

logger = logging.getLogger('perf')

_memo = {}          # model label -> (expires_at, token)
_MAX_ENDPOINTS = 24  # one page asks about a handful; this is a sanity bound


def _int_env(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _model_for(path):
    """The model behind a list endpoint, or None when it cannot be worked out.

    Only this project's own URLconf is consulted, and only the model class is
    taken from it - nothing is called, so resolving a path can neither run a
    view nor touch a row.
    """
    if not path.startswith('/api/'):
        return None
    try:
        match = resolve(path)
    except Exception:           # noqa: BLE001 - not one of ours, nothing to do
        return None
    cls = getattr(match.func, 'cls', None) or getattr(match.func, 'view_class', None)
    if cls is None:
        return None
    qs = getattr(cls, 'queryset', None)
    if qs is not None:
        return qs.model
    # Viewsets that build their queryset in get_queryset() leave `queryset`
    # unset; the serializer usually still names the model.
    ser = getattr(cls, 'serializer_class', None)
    model = getattr(getattr(ser, 'Meta', None), 'model', None)
    if model is not None:
        return model
    # And some set neither, choosing the serializer per request instead -
    # VendorViewSet does, which is why the most important dropdown of all was
    # the one this could not place. Ask it, with a request stub carrying an
    # empty query_params, which is all those methods read. Nothing is called
    # that touches the database.
    try:
        view = cls()
        view.action = 'list'
        view.format_kwarg = None
        view.request = type('_Stub', (), {'query_params': {}, 'user': None})()
        ser = view.get_serializer_class()
        return getattr(getattr(ser, 'Meta', None), 'model', None)
    except Exception:           # noqa: BLE001 - a viewset we cannot place is
        return None             # left alone, not guessed at


def _token(model, ttl):
    """A short token that changes whenever the table does."""
    label = model._meta.label
    now = time.time()
    hit = _memo.get(label)
    if hit and hit[0] > now:
        return hit[1]

    from django.db.models import Max
    try:
        qs = model._default_manager.all()
        count = qs.count()
        stamp = ''
        for field in ('updated_at', 'modified_at', 'created_at'):
            if any(f.name == field for f in model._meta.fields):
                stamp = str(qs.aggregate(m=Max(field))['m'] or '')
                break
        raw = '%s:%s:%s' % (label, count, stamp)
    except Exception:           # noqa: BLE001 - never break a poll over one list
        logger.warning('lookup version: could not read %s', label, exc_info=True)
        return None

    token = hashlib.sha256(raw.encode('utf-8')).hexdigest()[:8]
    _memo[label] = (now + ttl, token)
    return token


class LookupVersionView(APIView):
    """GET /api/lookups/version/?e=<path>&e=<path>…"""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        interval = _int_env('LOOKUP_VERSION_INTERVAL', 10)
        ttl = _int_env('LOOKUP_VERSION_TTL', 5)
        # Accept both spellings. The browser sends e=…&e=…, but several
        # HTTP clients (axios among them, by default) send e[]=…&e[]=…, and a
        # version poll that silently matched nothing would look exactly like a
        # list that never changes - the hardest kind of bug to notice.
        paths = (request.query_params.getlist('e')
                 + request.query_params.getlist('e[]'))[:_MAX_ENDPOINTS]

        versions = {}
        for path in paths:
            path = (path or '').strip()
            if not path or path in versions:
                continue
            model = _model_for(path)
            if model is None:
                # Unknown endpoint: say so with null rather than inventing a
                # token, so the browser keeps its current behaviour for it.
                versions[path] = None
                continue
            versions[path] = _token(model, ttl)

        return Response({'interval': interval, 'versions': versions})

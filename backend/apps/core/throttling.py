"""Throttling that degrades instead of collapsing when the cache is gone.

DRF's rate throttles keep their counters in Django's cache. In production
that cache is Redis (settings.CACHES), so when Redis stops answering,
`cache.get()` raises — and because throttling runs inside APIView.initial(),
BEFORE the handler and even before method routing, the exception surfaces as
a bare HTML 500 on every request to any view that carries a throttle scope.

Measured live on 2026-09-30: with Redis unreachable, POST /api/token/ (the
only endpoint with a scope set) returned 500 for every payload including a
GET, while /api/token/refresh/ — same throttle class, no scope, so it never
touches the cache — answered a clean JSON 401. Nobody could sign in: not the
staff, not the Tally connector.

That trade is backwards. A rate limiter exists to protect a working service;
it must never be the reason the service stops working. When its own storage
is unavailable it cannot count, so the honest options are "deny everything"
or "allow and say so loudly" — and for the login endpoint, denying everything
is a self-inflicted outage.

The per-account lockout in core.jwt_auth is the real brute-force defence and
it is cache-backed too, so it fails open alongside this. During a cache
outage the front door is therefore unthrottled: a smaller, louder, temporary
exposure than a total authentication failure, and the ERROR line below is
what makes it temporary.
"""
import logging

from rest_framework.throttling import ScopedRateThrottle

logger = logging.getLogger(__name__)


class ResilientScopedRateThrottle(ScopedRateThrottle):
    """ScopedRateThrottle that allows the request if the cache is unreachable.

    Only the cache failure is swallowed. A throttle that successfully counts
    and decides "too many" still returns False, so real rate limiting is
    unchanged whenever the cache is healthy.
    """

    def allow_request(self, request, view):
        try:
            return super().allow_request(request, view)
        except Exception:
            # Logged at ERROR, with the scope named, because this is a
            # degraded mode somebody has to fix — not a condition to live in.
            logger.error(
                "Rate-limit cache unavailable; allowing request to '%s' UNTHROTTLED. "
                "Check REDIS_URL / the cache service.",
                getattr(view, self.scope_attr, None) or request.path,
                exc_info=True,
            )
            return True

    def throttle_success(self):
        try:
            return super().throttle_success()
        except Exception:
            return True

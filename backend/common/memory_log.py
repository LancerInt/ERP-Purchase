"""Say in the Render logs WHY the instance is about to die.

THE PROBLEM THIS SOLVES
-----------------------
26-Sep-2026 the backend restarted every couple of minutes. Render's logs showed
only the effect - `Instance failed`, then gunicorn booting again - never the
cause. Diagnosing it meant guessing from the request just before the gap, and
two of those guesses were wrong. The logs have to name the culprit themselves.

WHAT IT DOES
------------
Reads the process's resident memory before and after every request and writes a
line when it matters:

    MEM baseline worker pid=45 rss=402MB            (once, at worker start)
    MEM HIGH  GET /api/purchase/scan/documents/x/file/  rss 410MB -> 1583MB
              (+1173MB) 2.10s  user=admin
    MEM WARN  rss 1712MB of 2048MB (83%) - close to the limit

So the last line before a restart says what the worker was doing and how much
memory it was holding. That is the difference between knowing and guessing.

WHY NOT psutil
--------------
It is not in requirements.txt, and adding a dependency to diagnose a memory
problem is the wrong trade. Linux (which Render runs) exposes the same number
in /proc/self/statm - one small read, no package, no build step.

COST
----
One file read and a subtraction per request, microseconds. Nothing is logged
for ordinary requests, so the log stays readable. If the read ever fails - a
platform without /proc, a permissions oddity - it disables itself for the rest
of the process and never touches the request path again.

TUNING (environment variables, no redeploy of code needed)
    MEM_LOG=off              switch it off entirely
    MEM_LOG_GROWTH_MB=50     log a request that grows memory by this much
    MEM_LOG_HIGH_MB=800      log any request while already above this
    MEM_LOG_LIMIT_MB=2048    the instance's memory limit, for the % warning
"""
import logging
import os
import time

logger = logging.getLogger('memory')

_PAGE = os.sysconf('SC_PAGE_SIZE') if hasattr(os, 'sysconf') else 4096
_BROKEN = False          # set once if /proc is unreadable; never retried


def rss_mb():
    """Resident memory of this process in MB, or None where unavailable."""
    global _BROKEN
    if _BROKEN:
        return None
    try:
        with open('/proc/self/statm', 'rb') as fh:
            resident = int(fh.read().split()[1])
        return resident * _PAGE / 1048576.0
    except Exception:
        # Windows/macOS dev boxes have no /proc. Fail quietly, once.
        _BROKEN = True
        return None


def _int_env(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class MemoryLogMiddleware:
    """Logs the requests that actually move memory, and warns near the limit."""

    def __init__(self, get_response):
        self.get_response = get_response
        self.enabled = os.environ.get('MEM_LOG', 'on').lower() not in ('off', '0', 'false')
        self.growth_mb = _int_env('MEM_LOG_GROWTH_MB', 50)
        self.high_mb = _int_env('MEM_LOG_HIGH_MB', 800)
        self.limit_mb = _int_env('MEM_LOG_LIMIT_MB', 2048)
        self._warned_pct = 0

        # One line per worker at boot: the baseline. If THIS is already large,
        # the app itself is too heavy and no amount of request tuning helps.
        if self.enabled:
            now = rss_mb()
            if now is None:
                self.enabled = False      # not Linux - stay out of the way
            else:
                logger.warning('MEM baseline worker pid=%s rss=%.0fMB limit=%sMB',
                               os.getpid(), now, self.limit_mb)

    def __call__(self, request):
        if not self.enabled:
            return self.get_response(request)

        before = rss_mb()
        started = time.time()
        response = self.get_response(request)
        after = rss_mb()
        if before is None or after is None:
            return response

        grew = after - before
        took = time.time() - started

        # Only the interesting ones: a request that GREW memory, or any request
        # served while already high. Everything else stays out of the log.
        if grew >= self.growth_mb or after >= self.high_mb:
            who = getattr(getattr(request, 'user', None), 'username', '-')
            logger.warning(
                'MEM HIGH %s %s rss %.0fMB -> %.0fMB (%+.0fMB) %.2fs user=%s status=%s',
                request.method, request.get_full_path()[:120],
                before, after, grew, took, who,
                getattr(response, 'status_code', '?'),
            )

        # Separate warning as the instance approaches its ceiling, at 80% and
        # 90%. Logged once per band so a struggling worker does not flood the
        # log with the same line - the point is to be readable at the moment
        # someone goes looking.
        if self.limit_mb:
            pct = after / self.limit_mb * 100
            band = 90 if pct >= 90 else (80 if pct >= 80 else 0)
            if band > self._warned_pct:
                self._warned_pct = band
                logger.warning(
                    'MEM WARN rss %.0fMB of %sMB (%.0f%%) - close to the limit; '
                    'next big request may be killed', after, self.limit_mb, pct)
            elif band == 0:
                self._warned_pct = 0      # recovered - allow warning again

        return response

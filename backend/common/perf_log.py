"""Name, in the Render logs, any response that is heavy — and say WHY.

WHY THIS EXISTS
---------------
Every performance problem in this codebase so far has been found the same slow
way: build a profiler, package it as a paste for the Render Shell, run it, read
it, build a second one that traces where the queries come from, run that too.
That is two or three round trips before anyone knows what is wrong, and twice it
sent us looking in the wrong place — the Receipts list traced clean on its first
page while its LAST page cost 388 queries, and a Freight join looked free until a
before/after comparison showed it reordering a list.

A heavy endpoint should say so by itself. After this, the first question is
answered by searching the logs:

    PERF /api/purchase/receipts/ 433q 4435KB 6.73s user=Kesav status=200
    PERF /api/purchase/requests/ 1074q 614KB 3.28s user=admin status=200

That is the page, the number of trips to the database, the size of what was
sent, and how long it took. Enough to know whether the next move is a query fix
or a payload decision — which is exactly the distinction that matters here, and
the one that is easy to get wrong: a page can be slow with hardly any queries
(it is shipping too much), or make 1,000 queries and still feel fast on a local
database with no rows in it.

WHAT IT COSTS
-------------
One counter increment per query and one length check per response. The query
counter is installed with connection.execute_wrapper, which works whether or not
DEBUG is on — django.db.connection.queries only records anything under DEBUG, and
DEBUG is off in production, which is precisely where this is needed.

Nothing is logged for ordinary responses, so the log stays readable. Thresholds
are environment variables, so they can be tightened on a live service without a
deploy.

    PERF_LOG=off              switch it off entirely
    PERF_LOG_QUERIES=100      log a response that made this many queries
    PERF_LOG_KB=512           log a response body this large
    PERF_LOG_SECONDS=2.0      log a response that took this long

Streaming responses (file downloads, previews) are skipped: reading .content on
one would load the whole file into memory to measure it, which is the opposite
of what common/file_stream.py exists to avoid.
"""
import logging
import os
import time

from django.db import connection

logger = logging.getLogger('perf')


def _env_num(name, default, cast=int):
    try:
        return cast(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class _QueryCounter:
    """Counts queries for one request. Deliberately does no formatting or
    string work per query - this sits in the path of every database call."""

    __slots__ = ('n',)

    def __init__(self):
        self.n = 0

    def __call__(self, execute, sql, params, many, context):
        self.n += 1
        return execute(sql, params, many, context)


class PerfLogMiddleware:
    """Logs the responses worth looking at, and stays silent for the rest."""

    def __init__(self, get_response):
        self.get_response = get_response
        self.enabled = os.environ.get('PERF_LOG', 'on').lower() not in (
            'off', '0', 'false', 'no')
        self.max_queries = _env_num('PERF_LOG_QUERIES', 100)
        self.max_kb = _env_num('PERF_LOG_KB', 512)
        self.max_seconds = _env_num('PERF_LOG_SECONDS', 2.0, float)

    def __call__(self, request):
        if not self.enabled:
            return self.get_response(request)

        counter = _QueryCounter()
        started = time.time()
        with connection.execute_wrapper(counter):
            response = self.get_response(request)
        took = time.time() - started

        # A streaming response has no .content - and asking for it would pull
        # the whole file into memory. Report what is known and leave it alone.
        if getattr(response, 'streaming', False):
            kb = -1
        else:
            try:
                kb = len(response.content) / 1024.0
            except Exception:          # noqa: BLE001 - never break a response
                kb = -1

        if (counter.n >= self.max_queries
                or kb >= self.max_kb
                or took >= self.max_seconds):
            who = getattr(getattr(request, 'user', None), 'username', '-')
            logger.warning(
                'PERF %s %s %dq %s %.2fs user=%s status=%s',
                request.method, request.get_full_path()[:160], counter.n,
                ('%.0fKB' % kb) if kb >= 0 else 'streamed', took, who,
                getattr(response, 'status_code', '?'),
            )
        return response

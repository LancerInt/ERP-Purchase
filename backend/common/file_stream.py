"""Serve a stored file to the browser WITHOUT loading it into memory.

THE PROBLEM
-----------
Scanned bills live on Cloudflare R2. The views that show them did:

    FileResponse(doc.file.open('rb'), content_type=...)

FileResponse streams, so that reads as safe - but `.open('rb')` on a REMOTE
file does not. django-storages buffers the whole object into a
SpooledTemporaryFile first, so the entire file existed in the process before a
single byte reached the browser. 26-Sep-2026 one preview logged

    GET /api/purchase/scan/documents/.../file/  200  14,212,260

- 14.2 MB held to show a preview, on a 2 GB box, and the instance restarted a
minute later.

Raising max_memory_size (settings) fixed the memory by spooling to disk, but
the server still downloads the whole file, writes it, reads it back, and only
then starts sending. This does it properly: bytes flow R2 -> Django -> browser
in 64 KB chunks and nothing is held.

WHY NOT REDIRECT TO A SIGNED R2 URL
-----------------------------------
That would be better still - zero memory AND zero bandwidth - but it cannot be
done without breaking the two pages that use these views. Both the Scan Inbox
and the Email Bill Inbox fetch the file as a BLOB over XHR:

    apiClient.get(fileUrl, { responseType: 'blob' })

because Django sends X-Frame-Options: DENY, so a direct <iframe src> is
refused and a blob: URL is used instead. Redirect that XHR to R2 and it becomes
a cross-origin request, which R2 rejects unless a CORS policy is configured on
the bucket. Same-origin streaming keeps both previews working exactly as they
do today, with no CORS and no frontend change.

SAFETY
------
If ANYTHING about the streaming path fails - a storage backend without boto3, a
key that does not resolve, an unexpected django-storages version - it falls
back to the original FileResponse. The worst case is today's behaviour, never a
broken preview.
"""
import logging

from django.http import FileResponse, StreamingHttpResponse

logger = logging.getLogger(__name__)

CHUNK = 64 * 1024


def _s3_streaming_body(fieldfile):
    """(body, size) straight off S3/R2, or None when that isn't possible.

    `body` is a boto3 StreamingBody - a live socket, not a buffer.
    """
    storage = getattr(fieldfile, 'storage', None)
    bucket = getattr(storage, 'bucket', None)
    if bucket is None:                      # FileSystemStorage (local dev) etc.
        return None

    name = fieldfile.name
    # django-storages prefixes keys with `location`; use its own normaliser when
    # present so a configured prefix is honoured, and fall back to the raw name.
    try:
        name = storage._normalize_name(storage._clean_name(name))
    except Exception:                       # noqa: BLE001 - private API, may move
        pass

    obj = bucket.Object(name).get()
    return obj['Body'], obj.get('ContentLength')


def stream_stored_file(fieldfile, content_type, filename=None, max_age=3600):
    """Stream a stored file to the browser, holding one chunk at a time.

    Returns a response with the same content type, disposition and caching the
    callers set before, so nothing downstream sees a difference.
    """
    try:
        found = _s3_streaming_body(fieldfile)
    except Exception:                       # noqa: BLE001
        logger.warning('stream: falling back to buffered read for %s',
                       getattr(fieldfile, 'name', '?'), exc_info=True)
        found = None

    if found is None:
        # Local storage, or the streaming path was unavailable. Behaves exactly
        # as this code did before.
        resp = FileResponse(fieldfile.open('rb'), content_type=content_type)
    else:
        body, size = found

        def chunks():
            try:
                while True:
                    data = body.read(CHUNK)
                    if not data:
                        return
                    yield data
            finally:
                body.close()        # release the socket even if the client aborts

        resp = StreamingHttpResponse(chunks(), content_type=content_type)
        if size:
            # Keep Content-Length so the browser can show progress and the blob
            # fetch knows when it is complete, exactly as FileResponse did.
            resp['Content-Length'] = str(size)

    if filename:
        # Inline so the <iframe>/<img> preview renders it rather than downloading.
        resp['Content-Disposition'] = 'inline; filename="%s"' % filename.replace('"', '')
    if max_age:
        resp['Cache-Control'] = 'private, max-age=%d' % max_age
    return resp

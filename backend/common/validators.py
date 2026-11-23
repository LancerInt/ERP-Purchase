"""Shared file-upload validation helpers."""
import os

# 25 MB — generous for invoices / scans / photos, but blocks abuse.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

# Extensions that can execute or carry active content if a browser is ever
# pointed at them inline. Attachments are business documents / images, so
# none of these are legitimate uploads.
BLOCKED_UPLOAD_EXTENSIONS = {
    '.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.jar', '.sh',
    '.ps1', '.vbs', '.js', '.mjs', '.html', '.htm', '.svg', '.php',
    '.phtml', '.dll', '.app', '.deb', '.rpm',
}


def upload_error(f, max_bytes=MAX_UPLOAD_BYTES):
    """Return a human error string if the upload is invalid, else None.

    Kept return-based (rather than raising) so it can be reused from DRF
    serializers (raise serializers.ValidationError) and plain code alike.
    """
    if f is None:
        return None
    size = getattr(f, 'size', 0) or 0
    if size > max_bytes:
        return (
            f'File is too large ({size // (1024 * 1024)} MB). '
            f'Maximum allowed is {max_bytes // (1024 * 1024)} MB.'
        )
    ext = os.path.splitext(getattr(f, 'name', '') or '')[1].lower()
    if ext in BLOCKED_UPLOAD_EXTENSIONS:
        return f'Files of type "{ext}" are not allowed.'
    return None

"""Shared GST helpers used across the masters (Vendor / Customer) and core
(Company)."""
import re

# A PAN is 5 letters + 4 digits + 1 letter, e.g. AAAAA0000A.
PAN_RE = re.compile(r'^[A-Z]{5}[0-9]{4}[A-Z]$')


def pan_from_gstin(gstin):
    """Extract the embedded PAN from a GSTIN.

    An Indian GSTIN is 15 chars: ``<2-digit state><10-char PAN><entity-no><Z>
    <checksum>`` — so the PAN is characters 3–12. Returns '' when the GSTIN is
    missing or the extracted value isn't a valid PAN (i.e. the GSTIN is
    malformed), so callers can safely skip filling in that case.
    """
    g = (gstin or '').strip().upper()
    if len(g) < 12:
        return ''
    candidate = g[2:12]
    return candidate if PAN_RE.match(candidate) else ''

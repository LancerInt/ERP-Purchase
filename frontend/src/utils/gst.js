// Extract the PAN embedded in a GSTIN. A 15-char GSTIN is
// <2-digit state><10-char PAN><entity><Z><checksum>, so the PAN is
// characters 3–12. Returns '' when the GSTIN is too short or the extracted
// value isn't a valid PAN. Mirrors backend common/gst.py.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
// Full GSTIN shape: <2-digit state><10-char PAN><entity code 1-9/A-Z><Z><checksum>.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function panFromGstin(gstin) {
  const g = String(gstin || '').trim().toUpperCase();
  if (g.length < 12) return '';
  const candidate = g.slice(2, 12);
  return PAN_RE.test(candidate) ? candidate : '';
}

export function isValidPan(pan) {
  return PAN_RE.test(String(pan || '').trim().toUpperCase());
}

export function isValidGstin(gstin) {
  return GSTIN_RE.test(String(gstin || '').trim().toUpperCase());
}

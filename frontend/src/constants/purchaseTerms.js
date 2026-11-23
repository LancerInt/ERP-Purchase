// Shared Purchase Order term options.
//
// Used by the PO create form (orders/new.jsx), the PO detail edit form
// (orders/[id].jsx) and the printable PO document (orders/document.jsx) so
// all three offer exactly the same choices. The values are stored verbatim
// on PurchaseOrder.freight_terms / payment_terms (plain CharFields), so the
// visible label IS the stored value — no code↔label mapping to keep in sync.

export const PAYMENT_TERM_OPTIONS = [
  '90 days',
  '60 days',
  '45 days',
  '30 days',
  '15 days',
  '10 days',
  '5 days',
  'as agreed',
];

export const FREIGHT_TERM_OPTIONS = [
  'TO PAY',
  'FOL SALEM',
  'FOL NAMAKKAL',
  'AS AGREED',
];

// Include a legacy/off-list current value (e.g. an older PO saved as
// "NET_30" or "PAID") at the front of the list, so editing an existing PO
// still shows its saved value instead of silently blanking the dropdown.
export function withCurrent(options, current) {
  const c = (current || '').trim();
  if (c && !options.includes(c)) return [c, ...options];
  return options;
}

// Day count implied by a payment term, or null when unbounded ('as agreed').
export function termDays(term) {
  const m = String(term || '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

// MSME payment-term options under MSMED Act §15. Micro & Small suppliers are
// capped — 45 days WITH a written agreement (document uploaded), else 15 days.
// Medium (and non-MSME) vendors get the full list. Mirrors the server-side
// rule in VendorSerializer._validate_msme so the UI can't offer a term the
// save would reject.
export function msmeAllowedTerms(category, hasAgreementDoc) {
  const cat = String(category || '').toUpperCase();
  const isProtected = cat === 'MICRO' || cat === 'SMALL';
  if (!isProtected) return PAYMENT_TERM_OPTIONS;
  const cap = hasAgreementDoc ? 45 : 15;
  return PAYMENT_TERM_OPTIONS.filter((t) => {
    const d = termDays(t);
    return d !== null && d <= cap;
  });
}

// Human sentence describing a payment term — drives the amber reminder
// banner on the PO detail page. Handles the new labels ("30 DAYS",
// "1 WEEK", "IMMEDIATE", "ADVANCE") plus legacy "NET_30" / "COD".
export function paymentTermMessage(terms) {
  const t = String(terms || '').trim().toUpperCase();
  if (!t) return '';
  if (t === 'IMMEDIATE') return 'Payment is due immediately.';
  if (t === 'ADVANCE') return 'Payment is required in advance.';
  if (t === 'AS AGREED') return 'Payment terms are as mutually agreed with the vendor.';
  if (t === 'COD') return 'Payment is due on delivery (Cash on Delivery).';
  let m = t.match(/^NET_?(\d+)$/);        // legacy "NET_30"
  if (m) return `Payment should be made within ${m[1]} days from the billing date.`;
  m = t.match(/^(\d+)\s*DAYS?$/);         // "30 DAYS"
  if (m) return `Payment should be made within ${m[1]} days from the billing date.`;
  m = t.match(/^(\d+)\s*WEEKS?$/);        // "1 WEEK"
  if (m) return `Payment should be made within ${Number(m[1]) * 7} days from the billing date.`;
  return '';
}

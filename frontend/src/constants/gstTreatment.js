// Customer GST treatment options — mirrors Customer.GST_TREATMENT_CHOICES on
// the backend (master/models.py). Keep the values in sync with the model.
export const GST_TREATMENT_OPTIONS = [
  { value: 'REGISTERED_REGULAR', label: 'Registered Business - Regular' },
  { value: 'REGISTERED_COMPOSITION', label: 'Registered Business - Composition' },
  { value: 'UNREGISTERED', label: 'Unregistered Business' },
  { value: 'CONSUMER', label: 'Consumer' },
  { value: 'OVERSEAS', label: 'Overseas' },
  { value: 'SEZ', label: 'Special Economic Zone (SEZ)' },
  { value: 'DEEMED_EXPORT', label: 'Deemed Export' },
];

export const gstTreatmentLabel = (v) =>
  GST_TREATMENT_OPTIONS.find(o => o.value === v)?.label || (v || '');

// Export-type treatments whose supplies are zero-rated — used to default the
// line GST to 0% on quotes/orders (still editable, for "with payment" cases).
export const ZERO_RATED_TREATMENTS = ['SEZ', 'OVERSEAS', 'DEEMED_EXPORT'];
export const isZeroRatedTreatment = (t) => ZERO_RATED_TREATMENTS.includes(t);

// Supplier-relevant subset for vendors (Consumer / SEZ / Deemed-Export are
// buyer-side concepts). Mirrors Vendor.GST_TREATMENT_CHOICES on the backend.
export const VENDOR_GST_TREATMENT_OPTIONS = GST_TREATMENT_OPTIONS.filter(
  o => ['REGISTERED_REGULAR', 'REGISTERED_COMPOSITION', 'UNREGISTERED', 'OVERSEAS'].includes(o.value)
);
// GST-registered treatments (a GSTIN is expected/required for these).
export const isRegisteredTreatment = (t) =>
  !t || t === 'REGISTERED_REGULAR' || t === 'REGISTERED_COMPOSITION';

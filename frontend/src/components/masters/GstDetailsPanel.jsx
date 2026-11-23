// Read-only panel that shows what the GST portal returned after a successful
// "Verify GSTIN" (A5). Rendered on the vendor new/edit forms beneath the Tax &
// Compliance grid. It displays only the fields the provider actually returned
// (gstinapi.in and most GSPs don't expose contact mobile/email — those rows
// simply don't appear when absent). `details` is the verify-gstin response
// (normalised record minus the raw snapshot).
const fmtAddress = (addr) => {
  if (!addr || typeof addr !== 'object') return '';
  return [addr.line1, addr.city, addr.state, addr.pincode]
    .map(v => (v == null ? '' : String(v).trim()))
    .filter(Boolean)
    .join(', ');
};

export default function GstDetailsPanel({ details }) {
  if (!details) return null;
  const d = details;
  const active = d.status === 'ACTIVE';
  const nob = Array.isArray(d.nature_of_business)
    ? d.nature_of_business.join(', ')
    : (d.nature_of_business || '');

  // [label, value] — only non-empty rows render, so the card stays tight.
  const rows = [
    ['Legal name', d.legal_name],
    ['Trade name', d.trade_name],
    ['GSTIN', d.gstin],
    ['Taxpayer type', d.taxpayer_type],
    ['Constitution', d.constitution],
    ['Registered on', d.registration_date],
    ['Cancelled on', d.cancellation_date],
    ['Jurisdiction', d.jurisdiction],
    ['Nature of business', nob],
    ['Mobile', d.mobile],
    ['Email', d.email],
    ['Address', fmtAddress(d.address)],
  ].filter(([, v]) => v && String(v).trim());

  return (
    <div className={`mt-4 rounded-lg border p-3 sm:p-4 ${active ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-200 bg-amber-50/60'}`}>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-slate-800">GST portal details</h4>
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap ${active ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
          {d.status || 'UNKNOWN'}
        </span>
      </div>
      {d.warning && <p className="mb-2 text-xs text-amber-700">{d.warning}</p>}
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-2">
            <dt className="text-xs text-slate-500 sm:w-36 sm:shrink-0">{label}</dt>
            <dd className="text-sm text-slate-800 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-slate-400">Fetched live from the GST portal. Fields the portal doesn&apos;t publish (e.g. contact details) are omitted.</p>
    </div>
  );
}

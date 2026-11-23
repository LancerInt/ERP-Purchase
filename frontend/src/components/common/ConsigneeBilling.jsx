import { formatAddressDisplay } from './AddressField';

/**
 * Generic "Consignee & Billing" block used across sales detail pages
 * (Customer PO, Sales Order, DC, Invoice).
 *
 * Design (locked):
 *  - ONE container card titled "Consignee & Billing" (like Sales Order)
 *  - Customer-PO field orientation: uppercase tiny labels, Name + GST No
 *    on a 2-up row, Address full width below (State / State Code only when
 *    the caller supplies them)
 *  - VERTICAL: Consignee on top, Billing below — two full-width rows, so
 *    long addresses get the whole width and never overflow on mobile.
 *
 * Each `consignee` / `billing` prop is a plain object:
 *   { name, gstin, address, state, stateCode }
 * `address` may be a raw address value (object/string) — it's run through
 * formatAddressDisplay here so callers don't repeat that.
 */
function Field({ label, children, className = '' }) {
  return (
    <div className={className}>
      <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</p>
      <p className="text-xs sm:text-sm text-slate-900 font-medium mt-0.5 break-words">{children || '-'}</p>
    </div>
  );
}

function Party({ title, data = {}, tone }) {
  const tones = {
    blue: { box: 'bg-blue-50 border-blue-200', title: 'text-blue-800' },
    green: { box: 'bg-emerald-50 border-emerald-200', title: 'text-emerald-800' },
  }[tone] || { box: 'bg-slate-50 border-slate-200', title: 'text-slate-700' };

  const hasState = data.state != null || data.stateCode != null;
  // Field-permission gating: callers may pass `hidden: { name, gstin,
  // address, state, stateCode }` (booleans). A hidden field's whole
  // label+value block is not rendered at all (instead of showing "-").
  const hidden = data.hidden || {};

  return (
    <div className={`p-3 sm:p-4 rounded-lg border min-w-0 ${tones.box}`}>
      <h4 className={`text-xs sm:text-sm font-semibold mb-2.5 ${tones.title}`}>{title}</h4>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        {!hidden.name && <Field label="Name">{data.name}</Field>}
        {!hidden.gstin && <Field label="GST No">{data.gstin}</Field>}
        {hasState && !hidden.state && <Field label="State">{data.state}</Field>}
        {hasState && !hidden.stateCode && <Field label="State Code">{data.stateCode}</Field>}
        {!hidden.address && (
          <Field label="Address" className="col-span-2">
            {data.address ? formatAddressDisplay(data.address) : '-'}
          </Field>
        )}
      </div>
    </div>
  );
}

export default function ConsigneeBilling({
  consignee = {},
  billing = {},
  consigneeTitle = 'Consignee (Ship To)',
  billingTitle = 'Billing Address',
  className = '',
}) {
  return (
    <div className={`bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5 ${className}`}>
      <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Consignee &amp; Billing</h2>
      <div className="space-y-3 sm:space-y-4">
        <Party title={consigneeTitle} data={consignee} tone="blue" />
        <Party title={billingTitle} data={billing} tone="green" />
      </div>
    </div>
  );
}

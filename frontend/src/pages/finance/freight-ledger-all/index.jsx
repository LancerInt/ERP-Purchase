import { useState } from 'react';
import { UploadCloud, X } from 'lucide-react';
import toast from 'react-hot-toast';
import GeneralLedger from '../components/GeneralLedger';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { formatCurrency } from '@/utils/formatters';

// Freight ledger — every freight money event, inbound (purchase) and
// outbound (sales) combined: freight bills and freight payments as
// debit/credit with a running payable balance.
//
// Each "Freight Bill" row gets an inline "Import to Tally" button (payment
// rows don't). Clicking it opens a review popup showing the exact Journal;
// only on Confirm is it created in the local Tally. Direct/local push.
export default function FreightLedgerAll() {
  const { canEdit } = usePermissions();
  const [tallyModal, setTallyModal] = useState(null); // { row, api, id, preview }
  const [tallyBusy, setTallyBusy] = useState(false);

  // A Freight Bill row links to /freight/purchase/:id or /freight/sales/:id —
  // derive the direction, id and push API base from that.
  const parseFreight = (link) => {
    const m = /^\/freight\/(purchase|sales)\/(.+)$/.exec(link || '');
    if (!m) return null;
    return {
      direction_key: m[1],
      id: m[2],
      api: m[1] === 'purchase' ? '/api/purchase/freight' : '/api/sales/freight',
      module: m[1] === 'purchase' ? 'Freight Advice' : 'Sales Freight',
    };
  };

  const openTallyModal = async (row) => {
    const f = parseFreight(row.link);
    if (!f) return;
    setTallyModal({ ...f, row, preview: null });
    try {
      const res = await apiClient.get(`${f.api}/${f.id}/tally-preview/`);
      setTallyModal({ ...f, row, preview: res.data });
    } catch {
      toast.error('Could not load the Tally preview.');
      setTallyModal(null);
    }
  };

  const confirmTallyPush = async () => {
    if (!tallyModal) return;
    setTallyBusy(true);
    try {
      const res = await apiClient.post(`${tallyModal.api}/${tallyModal.id}/tally-push/`);
      if (res.data?.ok) {
        toast.success(res.data.message || 'Journal created in Tally.');
        setTallyModal(null);
      } else {
        toast.error(res.data?.error || 'Tally rejected the voucher.');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not reach Tally. Is TallyPrime open?');
    } finally {
      setTallyBusy(false);
    }
  };

  // Trailing-column button — only on Freight Bill rows (not payments), and
  // only when the user can edit that freight (matches the backend push perm).
  const rowAction = (row) => {
    if (row.doc_type !== 'Freight Bill') return null;
    const f = parseFreight(row.link);
    if (!f || !canEdit(f.module)) return null;
    return (
      <button onClick={(e) => { e.stopPropagation(); openTallyModal(row); }}
        className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700 transition whitespace-nowrap" title="Import to Tally">
        <UploadCloud size={13} /> Import to Tally
      </button>
    );
  };

  const fmt = (v) => formatCurrency(v);

  return (
    <>
      <GeneralLedger
        endpoint="/api/finance/freight-ledger-all/"
        title="Freight Ledger"
        subtitle="Inbound & outbound freight bills and payments with a running balance"
        breadcrumbLabel="Freight Ledger"
        partyLabel="Transporter"
        moduleName="Freight Ledger"
        exportName="freight-ledger"
        showDirection
        showBank
        rowAction={rowAction}
      />

      {/* "Import to Tally" review popup — shows the exact Journal voucher;
          nothing is written to Tally until Confirm is clicked. */}
      {tallyModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => !tallyBusy && setTallyModal(null)}>
          <div role="dialog" aria-modal="true" aria-label="Import freight to Tally" className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[85dvh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-base font-semibold text-slate-800">Import to Tally — review</h3>
              <button onClick={() => !tallyBusy && setTallyModal(null)} aria-label="Close" title="Close" className="p-1 hover:bg-slate-100 rounded"><X size={18} /></button>
            </div>
            <div className="p-4">
              {!tallyModal.preview ? (
                <p className="text-slate-500">Loading preview…</p>
              ) : (
                <>
                  {tallyModal.preview.already_synced && (
                    <p className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                      This freight was already pushed to Tally. Confirming again will create a duplicate voucher.
                    </p>
                  )}
                  <dl className="grid grid-cols-3 gap-y-1.5 text-sm mb-3">
                    <dt className="text-slate-500">Voucher</dt><dd className="col-span-2 font-medium">{tallyModal.preview.voucher_type}</dd>
                    <dt className="text-slate-500">Number</dt><dd className="col-span-2 font-medium">{tallyModal.preview.voucher_number}</dd>
                    <dt className="text-slate-500">Date</dt><dd className="col-span-2 font-medium">{tallyModal.preview.date || '-'}</dd>
                    <dt className="text-slate-500">Transporter</dt><dd className="col-span-2 font-medium">{tallyModal.preview.party}</dd>
                    <dt className="text-slate-500">Direction</dt><dd className="col-span-2 font-medium">{tallyModal.preview.direction}</dd>
                    {tallyModal.preview.company && (<><dt className="text-slate-500">Company</dt><dd className="col-span-2 font-medium">{tallyModal.preview.company}</dd></>)}
                  </dl>
                  <table className="w-full text-sm border-t border-slate-200">
                    <thead>
                      <tr className="text-left text-slate-500">
                        <th className="py-1.5 font-medium">Ledger</th>
                        <th className="py-1.5 font-medium text-center">Dr/Cr</th>
                        <th className="py-1.5 font-medium text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tallyModal.preview.entries.map((en, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="py-1.5">{en.ledger}</td>
                          <td className="py-1.5 text-center"><span className={en.dc === 'Dr' ? 'text-blue-700' : 'text-emerald-700'}>{en.dc}</span></td>
                          <td className="py-1.5 text-right font-medium">{fmt(en.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-xs text-slate-400 mt-3">
                    Ledgers auto-created if missing: {tallyModal.preview.ledgers_to_create.join(', ')}.
                  </p>
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 p-4 border-t">
              <button onClick={() => setTallyModal(null)} disabled={tallyBusy} className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium disabled:opacity-50">Cancel</button>
              <button onClick={confirmTallyPush} disabled={tallyBusy || !tallyModal.preview} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 text-sm font-medium disabled:opacity-50">
                <UploadCloud size={16} /> {tallyBusy ? 'Creating…' : 'Confirm & Create in Tally'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { CheckCircle2, XCircle, Lock } from 'lucide-react';

import apiClient from '../../../../utils/api.js';
import { getApiErrorMessage } from '../../../../utils/formHelpers.js';
import { confirm } from '../../../../components/common/confirm';
import usePermissions from '../../../../hooks/usePermissions.js';
import { formatDate } from '../../../../utils/formatters.js';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const num = (v, digits = 4) => v == null ? '—' : Number(v).toFixed(digits);

/**
 * SignOffButton — surfaces on the batch header.
 *
 * Not signed off yet: shows a "Sign Off Batch" button that opens a
 *   confirm modal displaying the current balance and a notes field.
 *   Submitting POSTs a BatchSignOff and flips batch status to COMPLETED.
 * Already signed off: shows "Signed off by X on Y" + a "Revoke" action
 *   (deletes the sign-off, walking status back to IN_PROGRESS).
 */
export default function SignOffButton({ batch, onChanged }) {
  const { canEdit, canApprove } = usePermissions();
  const canSign = canEdit('Manufacturing Batch') || canApprove('Manufacturing Batch');
  const so = batch?.sign_off;

  const [modalOpen, setModalOpen] = useState(false);
  const [balance, setBalance] = useState(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Fetch balance snapshot only when the modal opens.
  useEffect(() => {
    if (!modalOpen) return;
    apiClient.get(`/api/production/manufacturing-batches/${batch.id}/balance/`)
      .then((res) => setBalance(res.data))
      .catch((err) => {
        toast.error(getApiErrorMessage(err) || 'Failed to load balance.');
        setModalOpen(false);
      });
  }, [modalOpen, batch?.id]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await apiClient.post('/api/production/extraction-batch-signoffs/', {
        batch: batch.id,
        material_balance_diff_kg: balance?.summary?.unaccounted_material_kg ?? null,
        aza_balance_diff_kg: balance?.summary?.unaccounted_aza_kg ?? null,
        notes: notes.trim(),
      });
      toast.success('Batch signed off.');
      setModalOpen(false);
      setNotes('');
      onChanged?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to sign off.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async () => {
    if (!(await confirm({
      message: `Revoke sign-off for ${batch.batch_no}? This will unlock the batch for further edits.`,
    }))) return;
    try {
      await apiClient.delete(`/api/production/extraction-batch-signoffs/${so.id}/`);
      toast.success('Sign-off revoked.');
      onChanged?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to revoke sign-off.');
    }
  };

  if (!batch) return null;

  // Already signed off — show the badge + revoke action.
  if (so) {
    return (
      <div className="inline-flex items-center gap-3 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg">
        <Lock className="w-4 h-4 text-emerald-700 shrink-0" />
        <div className="text-xs text-emerald-800 leading-tight">
          <div className="font-semibold">Signed off</div>
          <div>
            by <strong>{so.signed_off_by_full_name || so.signed_off_by}</strong>
            {' · '}{so.signed_off_at ? formatDate(so.signed_off_at) : ''}
          </div>
        </div>
        {canSign && (
          <button
            type="button"
            onClick={handleRevoke}
            className="text-xs text-slate-500 hover:text-red-600 underline"
            title="Revoke sign-off"
          >
            Revoke
          </button>
        )}
      </div>
    );
  }

  // Not signed off — show the button (only for permitted users).
  if (!canSign) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg"
      >
        <CheckCircle2 className="w-4 h-4" />
        Sign Off Batch
      </button>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={() => setModalOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Sign off {batch.batch_no}</h3>
              <button onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <XCircle size={20} />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <p className="text-sm text-slate-600">
                Confirming will lock this batch to further edits and mark its status as <strong>Completed</strong>.
                A snapshot of the current balance-diff numbers below is stored with the sign-off,
                so later corrections won't silently rewrite what was approved.
              </p>

              {balance ? (
                <div className="bg-slate-50 border border-slate-200 rounded p-3 text-sm">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs text-slate-500">Kernel initial aza</div>
                      <div className="font-mono">{num(balance.kernel.initial_aza_kg)} kg</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">LLE total aza</div>
                      <div className="font-mono">{num(balance.lle.total_aza_kg)} kg</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Spent kernel aza</div>
                      <div className="font-mono">{num(balance.spent_kernel.aza_kg, 6)} kg</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Yield kernel → LLE</div>
                      <div className="font-mono">
                        {balance.summary.yield_kernel_to_lle_pct != null
                          ? Number(balance.summary.yield_kernel_to_lle_pct).toFixed(2) + '%'
                          : '—'}
                      </div>
                    </div>
                    <div className="col-span-2 pt-2 mt-2 border-t border-slate-200">
                      <div className="text-xs text-slate-500">Unaccounted (will snapshot)</div>
                      <div className="font-mono text-sm">
                        {num(balance.summary.unaccounted_material_kg, 3)} kg material
                        {' · '}
                        {num(balance.summary.unaccounted_aza_kg, 4)} kg aza
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-slate-500 p-3">Loading balance…</div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Notes <span className="text-slate-400">(optional)</span>
                </label>
                <textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className={inputClass}
                  placeholder="E.g. reviewed with the plant head; balance within acceptable range."
                />
              </div>
            </div>

            <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || !balance}
                className="px-3 py-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-50"
              >
                {submitting ? 'Signing off…' : 'Confirm Sign-Off'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

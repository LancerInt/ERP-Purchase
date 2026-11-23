import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Pencil, Trash2, CheckCircle, BadgeIndianRupee, Send } from 'lucide-react';

import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
// Visual treatment for a field locked READ_ONLY by field permissions.
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;
const inputClassRO = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-700';
const num = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));
const fmtMoney = (v) =>
  `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (v) =>
  v ? formatDate(v) : '-';

export default function WageVoucherDetail() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { canEdit, canDelete, canApprove, canConfirm, canIssue } = usePermissions();
  const editable = canEdit('Wage Voucher');
  // Field-level permissions for the Wage Voucher — hide HIDDEN fields and
  // lock READ_ONLY ones for the current user's role.
  const { isHidden, isReadOnly } = useFieldPermissions('Wage Voucher');
  const { options: vendors } = useLookup('/api/vendors/', {
    labelField: 'vendor_name',
    valueField: 'id',
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [original, setOriginal] = useState(null);
  const [formData, setFormData] = useState(null);

  const hydrate = (d) => ({
    amount: d.amount != null ? String(d.amount) : '',
    tds: d.tds != null ? String(d.tds) : '',
    contractor_vendor: d.contractor_vendor || '',
    remarks: d.remarks || '',
  });

  const load = () =>
    apiClient.get(`/api/production/wage-vouchers/${id}/`).then((res) => {
      setOriginal(res.data);
      setFormData(hydrate(res.data));
      return res.data;
    });

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    load()
      .catch((err) => {
        if (!cancelled) toast.error(getApiErrorMessage(err) || 'Failed to load wage voucher.');
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Net payable = gross wage − TDS withheld. Never shown below zero.
  const netPayable = useMemo(
    () => Math.max(0, num(formData?.amount) - num(formData?.tds)),
    [formData?.amount, formData?.tds],
  );

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSave = async (e) => {
    e?.preventDefault?.();
    if (num(formData.amount) < 0) { toast.error('Total Amount cannot be negative.'); return; }
    setIsSaving(true);
    try {
      await apiClient.patch(`/api/production/wage-vouchers/${id}/`, {
        amount: num(formData.amount).toFixed(2),
        tds: formData.tds === '' ? null : num(formData.tds).toFixed(2),
        contractor_vendor: formData.contractor_vendor || null,
        remarks: formData.remarks || '',
      });
      await load();
      toast.success('Wage voucher saved.');
      setIsEditing(false);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to save.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (original) setFormData(hydrate(original));
    setIsEditing(false);
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete wage voucher "${original?.voucher_no}"? This cannot be undone.`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/production/wage-vouchers/${id}/`);
      toast.success('Wage voucher deleted.');
      navigate('/production/wage-vouchers');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  const advanceStatus = async (kind) => {
    setBusy(true);
    try {
      if (kind === 'submit') {
        await apiClient.post(`/api/production/wage-vouchers/${id}/submit/`);
      } else if (kind === 'approve') {
        await apiClient.post(`/api/production/wage-vouchers/${id}/approve/`);
      } else if (kind === 'mark_paid') {
        await apiClient.post(`/api/production/wage-vouchers/${id}/mark_paid/`);
      }
      await load();
      toast.success('Status updated.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to update status.');
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="space-y-4">
          <div className="h-12 bg-slate-200 rounded animate-pulse" />
          <div className="h-64 bg-slate-200 rounded animate-pulse" />
        </div>
      </MainLayout>
    );
  }

  if (!original || !formData) return null;

  const ro = !isEditing;
  const status = original.status || 'DRAFT';
  const isPacking = original.voucher_kind === 'PACKING';
  const reference = isPacking
    ? (original.packing_no || '-')
    : (original.work_order_no || original.work_order_batch || '-');
  const hoursTasks = original.hours_tasks || [];

  return (
    <MainLayout>
      <PageHeader
        title={original.voucher_no || 'Wage Voucher'}
        subtitle={<span className="text-xs text-slate-500">{isPacking ? 'Packing' : 'Production'} wage voucher</span>}
        breadcrumbs={[
          { label: 'Production', href: '/production' },
          { label: 'Wage Vouchers', href: '/production/wage-vouchers' },
          { label: original.voucher_no },
        ]}
      />

      <div className="flex flex-wrap items-center justify-end gap-2 mb-4">
        <StatusBadge status={status} />
        {/* Status workflow: DRAFT → PENDING → APPROVED → PAID */}
        {!isEditing && status === 'DRAFT' && canConfirm('Wage Voucher') && (
          <button type="button" onClick={() => advanceStatus('submit')} disabled={busy}
            className="inline-flex items-center gap-1 px-4 py-2 bg-amber-50 text-amber-700 rounded-lg text-sm font-medium hover:bg-amber-100 border border-amber-200 disabled:opacity-50">
            <Send size={14} /> Submit for Approval
          </button>
        )}
        {!isEditing && status === 'PENDING' && canApprove('Wage Voucher') && (
          <button type="button" onClick={() => advanceStatus('approve')} disabled={busy}
            className="inline-flex items-center gap-1 px-4 py-2 bg-emerald-50 text-emerald-700 rounded-lg text-sm font-medium hover:bg-emerald-100 border border-emerald-200 disabled:opacity-50">
            <CheckCircle size={14} /> Approve
          </button>
        )}
        {!isEditing && status === 'APPROVED' && canIssue('Wage Voucher') && (
          <button type="button" onClick={() => advanceStatus('mark_paid')} disabled={busy}
            className="inline-flex items-center gap-1 px-4 py-2 bg-indigo-50 text-indigo-700 rounded-lg text-sm font-medium hover:bg-indigo-100 border border-indigo-200 disabled:opacity-50">
            <BadgeIndianRupee size={14} /> Mark Paid
          </button>
        )}
        {!isEditing && status !== 'PAID' && canEdit('Wage Voucher') && (
          <button type="button" onClick={() => setIsEditing(true)}
            className="inline-flex items-center gap-1 px-4 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100 border border-blue-200">
            <Pencil size={14} /> Edit
          </button>
        )}
        {!isEditing && canDelete('Wage Voucher') && (
          <button type="button" onClick={handleDelete}
            className="inline-flex items-center gap-1 px-4 py-2 bg-red-50 text-red-700 rounded-lg text-sm font-medium hover:bg-red-100 border border-red-200">
            <Trash2 size={14} /> Delete
          </button>
        )}
      </div>

      <form onSubmit={handleSave}>
        <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
        {/* ── Voucher context (read-only) ─────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Voucher Details</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Voucher No</label>
              <input type="text" value={original.voucher_no || ''} readOnly className={inputClassRO} />
            </div>
            {!isHidden('voucher_kind') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Voucher For</label>
              <input type="text" value={isPacking ? 'Packing' : 'Production'} readOnly className={inputClassRO} />
            </div>
            )}
            {!isHidden(isPacking ? 'packing_process' : 'work_order') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{isPacking ? 'Packing No' : 'Work Order'}</label>
              <input type="text" value={reference} readOnly className={inputClassRO} />
            </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Prepared By</label>
              <input type="text" value={original.prepared_by_name || '-'} readOnly className={inputClassRO} />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Prepared Date</label>
              <input type="text" value={fmtDate(original.prepared_date)} readOnly className={inputClassRO} />
            </div>
            {!isHidden('contractor_vendor') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Contractor</label>
              {ro ? (
                <input type="text" value={original.contractor_name || '—'} readOnly className={inputClassRO} />
              ) : (
                <CustomSelect name="contractor_vendor" value={formData.contractor_vendor} onChange={handleChange}
                  disabled={isReadOnly('contractor_vendor')}
                  className={isReadOnly('contractor_vendor') ? lockedInputClass : inputClass}>
                  <option value="">No contractor</option>
                  {vendors.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                </CustomSelect>
              )}
            </div>
            )}
          </div>
        </div>

        {/* ── Per Headcount Wages breakdown (read-only, if any) ───────── */}
        {(original.headcount_lines || []).length > 0 && (
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Per Headcount Wages</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b text-left text-slate-600">
                    <th className="px-3 py-2 font-semibold w-10">#</th>
                    <th className="px-3 py-2 font-semibold text-right">Number of Persons</th>
                    <th className="px-3 py-2 font-semibold text-right">Wage per Person</th>
                    <th className="px-3 py-2 font-semibold text-right">Row Total</th>
                    <th className="px-3 py-2 font-semibold">Work Done</th>
                  </tr>
                </thead>
                <tbody>
                  {original.headcount_lines.map((line, i) => (
                    <tr key={i} className="border-b">
                      <td className="px-3 py-2 font-mono text-slate-400">{i + 1}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{line.persons}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{fmtMoney(line.wage_per_person)}</td>
                      <td className="px-3 py-2 text-right font-medium text-slate-800">{fmtMoney(line.row_total)}</td>
                      <td className="px-3 py-2 text-slate-700">{line.reason || '—'}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} className="px-3 py-2 text-right font-semibold text-slate-600">Grand Total</td>
                    <td className="px-3 py-2 text-right font-bold text-emerald-700">
                      {fmtMoney(original.headcount_lines.reduce((acc, l) => acc + Number(l.row_total || 0), 0))}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Amounts ─────────────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Amounts</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {!isHidden('amount') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Total Amount</label>
              {ro ? (
                <div className="w-full px-3 py-2 border border-emerald-200 rounded-lg text-sm bg-emerald-50 font-semibold text-emerald-700 text-right">
                  {fmtMoney(original.amount)}
                </div>
              ) : (
                <input type="number" step="0.01" min="0" name="amount" value={formData.amount}
                  onChange={handleChange} disabled={isReadOnly('amount')}
                  className={`${isReadOnly('amount') ? lockedInputClass : inputClass} text-right`} />
              )}
            </div>
            )}
            {!isHidden('tds') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">TDS</label>
              {ro ? (
                <input type="text" value={original.tds != null && Number(original.tds) ? fmtMoney(original.tds) : '—'} readOnly className={`${inputClassRO} text-right`} />
              ) : (
                <input type="number" step="0.01" min="0" name="tds" value={formData.tds}
                  onChange={handleChange} disabled={isReadOnly('tds')}
                  className={`${isReadOnly('tds') ? lockedInputClass : inputClass} text-right`} />
              )}
            </div>
            )}
            {!isHidden('net_amount') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Net Payable (After TDS)</label>
              <div className="w-full px-3 py-2 border border-indigo-200 rounded-lg text-sm bg-indigo-50 font-semibold text-indigo-700 text-right">
                {fmtMoney(ro ? original.net_amount : netPayable)}
              </div>
              <p className="mt-1 text-xs text-slate-500">Total Amount − TDS.</p>
            </div>
            )}
            {!isHidden('remarks') && (
            <div className="col-span-2 md:col-span-3">
              <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
              <textarea name="remarks" value={formData.remarks} onChange={handleChange}
                readOnly={ro || isReadOnly('remarks')} rows={3}
                className={ro ? inputClassRO : (isReadOnly('remarks') ? lockedInputClass : inputClass)} />
            </div>
            )}
          </div>
        </div>

        {/* ── Hours / task breakdown (read-only, if any) ──────────────── */}
        {hoursTasks.length > 0 && (
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Task Breakdown</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b text-left text-slate-600">
                    <th className="px-3 py-2 font-semibold">Task</th>
                    <th className="px-3 py-2 font-semibold text-right">Hours</th>
                    <th className="px-3 py-2 font-semibold text-right">Qty Produced</th>
                    <th className="px-3 py-2 font-semibold text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {hoursTasks.map((t, i) => (
                    <tr key={t.id || i} className="border-b">
                      <td className="px-3 py-2 text-slate-700">{t.task_description || '-'}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{t.hours ?? '-'}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{t.quantity_produced ?? '-'}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{t.amount != null ? fmtMoney(t.amount) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {isEditing && (
          <div className="flex justify-end gap-3">
            <button type="button" onClick={handleCancel}
              className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
            <button type="submit" disabled={isSaving}
              className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
              {isSaving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        )}
        </EditGate>
      </form>
    </MainLayout>
  );
}

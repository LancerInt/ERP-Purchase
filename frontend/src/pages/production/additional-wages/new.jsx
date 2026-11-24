import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Save, Loader2, ArrowLeft, Trash2, CheckCircle2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '../../../utils/formatters.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import { confirm } from '@/components/common/confirm';

const labelClass = 'block text-xs font-medium text-slate-600 mb-1';
const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const numClass = `${inputClass} tabular-nums text-right`;
const isoToday = () => new Date().toISOString().slice(0, 10);

const ACTIVITY_OPTIONS = [
  { value: 'LOTTING',         label: 'Lotting' },
  { value: 'BUNDLING',        label: 'Bundling' },
  { value: 'INTER_SHIFTING',  label: 'Inter-shifting (within warehouse)' },
  { value: 'INTER_TRANSFER',  label: 'Inter-transfer (between warehouses)' },
  { value: 'CLEANING',        label: 'Cleaning' },
  { value: 'OTHER',           label: 'Other' },
];

// Activity types that surface the Quantity + UOM fields. Others
// (Cleaning, Inter-shifting/-transfer at header level, Other) are
// usually just a wage + narrative — the qty inputs stay hidden to
// keep the form uncluttered but the field remains persistable.
const QTY_APPLICABLE = new Set(['LOTTING', 'BUNDLING']);

// Reference-field placeholder per activity — nudges the operator
// toward the right kind of identifier (batch no vs vessel name vs
// transfer no) without hard-wiring the schema to any one source doc.
const REFERENCE_PLACEHOLDER = {
  LOTTING:        'Batch no / product being lotted',
  BUNDLING:       'Batch no / carton spec',
  INTER_SHIFTING: 'Godown or zone within the warehouse',
  INTER_TRANSFER: 'Transfer / shifting doc no',
  CLEANING:       'Vessel / tank / godown cleaned',
  OTHER:          'Free-text — what identifies this job',
};

export default function AdditionalWageForm() {
  const { id } = useParams();
  const isEdit = !!id;
  const navigate = useNavigate();
  const { canEdit, canCreate, canDelete } = usePermissions();
  const editable = isEdit ? canEdit('Wage Voucher') : canCreate('Wage Voucher');

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [entryNo, setEntryNo] = useState('');
  // Payment lifecycle fields are set only via the /mark-paid bulk
  // action on the list page — surfaced here read-only as context.
  const [paymentStatus, setPaymentStatus] = useState('UNPAID');
  const [paidAt, setPaidAt] = useState('');
  const [paidReference, setPaidReference] = useState('');
  const [paidByName, setPaidByName] = useState('');
  const [form, setForm] = useState({
    entry_date: isoToday(),
    company: '',
    warehouse: '',
    activity_type: 'LOTTING',
    reference: '',
    production_entry_batch: '',
    quantity: '',
    quantity_uom: '',
    wage_mode: 'HEAD',
    persons_count: '',
    rate_per_person: '',
    group_total: '',
    contractor: '',
    remarks: '',
    status: 'DRAFT',
  });
  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  // Lookups
  const { raw: companiesRaw } = useLookup('/api/companies/');
  const companies = useMemo(
    () => (companiesRaw || []).map((c) => ({
      value: c.id,
      label: c.legal_name || c.trade_name || c.name || '',
    })).filter((o) => o.label),
    [companiesRaw],
  );
  const { raw: warehousesRaw } = useLookup('/api/warehouses/');
  const warehouses = useMemo(() => {
    const seen = new Set();
    return (warehousesRaw || [])
      .filter((w) => !form.company || String(w.company) === String(form.company))
      .filter((w) => {
        const k = (w.name || '').trim().toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((w) => ({ value: w.id, label: w.name }));
  }, [warehousesRaw, form.company]);
  const { raw: vendorsRaw } = useLookup('/api/vendors/');
  const vendors = useMemo(
    () => (vendorsRaw || [])
      .map((v) => ({ value: v.id, label: v.vendor_name || v.name || v.legal_name || '' }))
      .filter((o) => o.label)
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase())),
    [vendorsRaw],
  );

  // Prefill company + warehouse from operator's profile — same pattern
  // as the Production Entry form so the primary location is one less pick.
  useEffect(() => {
    if (isEdit) return;
    let cancelled = false;
    apiClient.get('/api/users/me/')
      .then((res) => {
        if (cancelled) return;
        const { default_company, default_warehouse } = res.data || {};
        if (!default_company && !default_warehouse) return;
        setForm((prev) => ({
          ...prev,
          company: prev.company || (default_company ? String(default_company) : ''),
          warehouse: prev.warehouse || (default_warehouse ? String(default_warehouse) : ''),
        }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isEdit]);

  // Load existing entry for edit mode.
  useEffect(() => {
    if (!isEdit) return;
    let cancelled = false;
    setLoading(true);
    apiClient.get(`/api/production/additional-wages/${id}/`)
      .then((res) => {
        if (cancelled) return;
        const d = res.data || {};
        setEntryNo(d.entry_no || '');
        setPaymentStatus(d.payment_status || 'UNPAID');
        setPaidAt(d.paid_at || '');
        setPaidReference(d.paid_reference || '');
        setPaidByName(d.paid_by_name || '');
        setForm({
          entry_date: d.entry_date || isoToday(),
          company: d.company || '',
          warehouse: d.warehouse || '',
          activity_type: d.activity_type || 'LOTTING',
          reference: d.reference || '',
          production_entry_batch: d.production_entry_batch || '',
          quantity: d.quantity || '',
          quantity_uom: d.quantity_uom || '',
          wage_mode: d.wage_mode || 'HEAD',
          persons_count: d.persons_count || '',
          rate_per_person: d.rate_per_person || '',
          group_total: d.group_total || '',
          contractor: d.contractor || '',
          remarks: d.remarks || '',
          status: d.status || 'DRAFT',
        });
      })
      .catch((err) => toast.error(getApiErrorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [id, isEdit]);

  const qtyApplicable = QTY_APPLICABLE.has(form.activity_type);
  const isGroup = (form.wage_mode || 'HEAD').toUpperCase() === 'GROUP';

  const wageTotal = useMemo(() => {
    if (isGroup) return Number(form.group_total) || 0;
    return (Number(form.persons_count) || 0) * (Number(form.rate_per_person) || 0);
  }, [isGroup, form.persons_count, form.rate_per_person, form.group_total]);

  const validate = () => {
    if (!form.company) return 'Pick a Company.';
    if (!form.warehouse) return 'Pick a Warehouse.';
    if (!form.activity_type) return 'Pick an Activity type.';
    if (isGroup) {
      if (!(Number(form.group_total) > 0)) return 'Enter the group total wage.';
      if (!form.contractor) return 'Contractor is required for a Group-mode wage entry.';
    } else {
      if (!(Number(form.persons_count) > 0)) return 'Enter the headcount (Persons).';
      if (!(Number(form.rate_per_person) > 0)) return 'Enter the rate per person.';
    }
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const payload = {
        entry_date: form.entry_date,
        company: form.company,
        warehouse: form.warehouse,
        activity_type: form.activity_type,
        reference: (form.reference || '').trim(),
        production_entry_batch: (form.production_entry_batch || '').trim(),
        quantity: qtyApplicable ? (Number(form.quantity) || 0) : 0,
        quantity_uom: qtyApplicable ? (form.quantity_uom || '') : '',
        wage_mode: isGroup ? 'GROUP' : 'HEAD',
        persons_count: Number(form.persons_count) || 0,
        rate_per_person: isGroup ? 0 : (Number(form.rate_per_person) || 0),
        group_total: isGroup ? (Number(form.group_total) || 0) : 0,
        contractor: form.contractor || null,
        remarks: form.remarks || '',
        status: form.status || 'DRAFT',
      };
      if (isEdit) {
        await apiClient.patch(`/api/production/additional-wages/${id}/`, payload);
        toast.success('Wage entry updated.');
      } else {
        const res = await apiClient.post('/api/production/additional-wages/', payload);
        toast.success(`Saved as ${res.data?.entry_no || 'wage entry'}.`);
      }
      navigate('/production/additional-wages');
    } catch (er) {
      toast.error(getApiErrorMessage(er));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Remove ${entryNo}?` }))) return;
    try {
      await apiClient.delete(`/api/production/additional-wages/${id}/`);
      toast.success('Removed.');
      navigate('/production/additional-wages');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title={isEdit ? `Additional Wage ${entryNo || ''}` : 'New Additional Wage'}
        subtitle="Lotting, bundling, cleaning, inter-shifting / inter-transfer — one entry per activity per day"
        breadcrumbs={[
          { label: 'Shifting Purpose' },
          { label: 'Additional Wages', href: '/production/additional-wages' },
          { label: isEdit ? (entryNo || 'Edit') : 'New' },
        ]}
      />

      {loading ? (
        <div className="text-center py-12"><Loader2 className="inline animate-spin" size={22} /></div>
      ) : (
        <>
          {/* Paid banner — surfaces payment state so an operator
              opening a settled entry knows edits will need a revert
              on the list page first. Payment fields flip only via
              /mark-paid; the form itself doesn't set them. */}
          {isEdit && paymentStatus === 'PAID' && (
            <div className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 p-3 flex flex-wrap items-center gap-3">
              <CheckCircle2 size={18} className="text-emerald-700 shrink-0" />
              <div className="flex-1 min-w-[240px] text-sm text-emerald-900">
                <span className="font-semibold">Paid</span>
                {paidAt ? <> on <span className="tabular-nums">{formatDate(paidAt)}</span></> : null}
                {paidReference && (
                  <> · Ref <span className="tabular-nums font-medium">{paidReference}</span></>
                )}
                {paidByName && <> · by {paidByName}</>}
              </div>
              <span className="text-[11px] text-emerald-700">
                To edit wage details, revert to Unpaid from the list page first.
              </span>
            </div>
          )}
          {/* Header */}
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6 mb-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Where &amp; when</h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="min-w-0">
                <label className={labelClass}>Date <span className="text-red-500">*</span></label>
                <CustomDatePicker
                  value={form.entry_date}
                  onChange={(e) => set('entry_date', e?.target?.value ?? '')}
                  disabled={!editable}
                />
              </div>
              <div className="min-w-0">
                <label className={labelClass}>Company <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={form.company}
                  onChange={(e) => { set('company', e.target.value); set('warehouse', ''); }}
                  disabled={!editable}
                >
                  <option value="">Pick company…</option>
                  {companies.map((c) => (<option key={c.value} value={c.value}>{c.label}</option>))}
                </CustomSelect>
              </div>
              <div className="min-w-0">
                <label className={labelClass}>Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={form.warehouse}
                  onChange={(e) => set('warehouse', e.target.value)}
                  disabled={!editable || !form.company}
                >
                  <option value="">{form.company ? 'Pick warehouse…' : 'Pick company first'}</option>
                  {warehouses.map((w) => (<option key={w.value} value={w.value}>{w.label}</option>))}
                </CustomSelect>
              </div>
              <div className="min-w-0">
                <label className={labelClass}>Status</label>
                <CustomSelect
                  value={form.status}
                  onChange={(e) => set('status', e.target.value)}
                  disabled={!editable}
                >
                  <option value="DRAFT">Draft</option>
                  <option value="CONFIRMED">Confirmed</option>
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Activity + reference */}
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6 mb-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Activity</h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="min-w-0 lg:col-span-1">
                <label className={labelClass}>Type <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={form.activity_type}
                  onChange={(e) => set('activity_type', e.target.value)}
                  disabled={!editable}
                >
                  {ACTIVITY_OPTIONS.map((a) => (<option key={a.value} value={a.value}>{a.label}</option>))}
                </CustomSelect>
              </div>
              <div className="min-w-0 lg:col-span-2 col-span-2">
                <label className={labelClass}>Reference</label>
                <input
                  type="text" className={inputClass}
                  value={form.reference}
                  onChange={(e) => set('reference', e.target.value)}
                  placeholder={REFERENCE_PLACEHOLDER[form.activity_type] || 'Optional identifier'}
                  disabled={!editable}
                />
              </div>
              <div className="min-w-0">
                <label className={labelClass}>Batch (optional)</label>
                <input
                  type="text" className={inputClass}
                  value={form.production_entry_batch}
                  onChange={(e) => set('production_entry_batch', e.target.value)}
                  placeholder="e.g. PB-2026-00002"
                  disabled={!editable}
                />
              </div>
              {qtyApplicable && (
                <>
                  <div className="min-w-0">
                    <label className={labelClass}>Quantity</label>
                    <input
                      type="number" min="0" step="0.001" className={numClass}
                      value={form.quantity}
                      onChange={(e) => set('quantity', e.target.value)}
                      placeholder="0.000" disabled={!editable}
                    />
                  </div>
                  <div className="min-w-0">
                    <label className={labelClass}>UOM</label>
                    <input
                      type="text" className={inputClass}
                      value={form.quantity_uom}
                      onChange={(e) => set('quantity_uom', e.target.value.toUpperCase())}
                      placeholder="e.g. PCS, BAG, KG"
                      disabled={!editable}
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Wage */}
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6 mb-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Wage</h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="min-w-0">
                <label className={labelClass}>Mode <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={form.wage_mode}
                  onChange={(e) => set('wage_mode', e.target.value)}
                  disabled={!editable}
                >
                  <option value="HEAD">Per head</option>
                  <option value="GROUP">Group</option>
                </CustomSelect>
              </div>
              <div className="min-w-0">
                <label className={labelClass}>Persons {isGroup ? '' : <span className="text-red-500">*</span>}</label>
                <input
                  type="number" min="0" step="1" className={numClass}
                  value={form.persons_count}
                  onChange={(e) => set('persons_count', e.target.value)}
                  placeholder="0"
                  title={isGroup ? 'Headcount for reporting; wage still paid as the group total' : 'Persons in this group'}
                  disabled={!editable}
                />
              </div>
              {isGroup ? (
                <div className="min-w-0">
                  <label className={labelClass}>Group total (₹) <span className="text-red-500">*</span></label>
                  <input
                    type="number" min="0" step="0.01" className={numClass}
                    value={form.group_total}
                    onChange={(e) => set('group_total', e.target.value)}
                    placeholder="0.00"
                    disabled={!editable}
                  />
                </div>
              ) : (
                <div className="min-w-0">
                  <label className={labelClass}>Rate (₹/person) <span className="text-red-500">*</span></label>
                  <input
                    type="number" min="0" step="0.01" className={numClass}
                    value={form.rate_per_person}
                    onChange={(e) => set('rate_per_person', e.target.value)}
                    placeholder="0.00"
                    disabled={!editable}
                  />
                </div>
              )}
              <div className="min-w-0">
                <label className={labelClass}>
                  Contractor{isGroup && <span className="text-red-500"> *</span>}
                </label>
                <CustomSelect
                  value={form.contractor}
                  onChange={(e) => set('contractor', e.target.value)}
                  disabled={!editable}
                >
                  <option value="">
                    {isGroup ? 'Required — pick contractor…' : 'Optional'}
                  </option>
                  {vendors.map((v) => (<option key={v.value} value={v.value}>{v.label}</option>))}
                </CustomSelect>
              </div>
              <div className="min-w-0 col-span-2 lg:col-span-4">
                <div className="rounded-md border border-slate-200 bg-slate-50 p-2 flex items-center justify-between">
                  <span className="text-xs text-slate-500 font-medium">Total wage</span>
                  <span className="text-lg tabular-nums font-semibold text-slate-800">
                    ₹{wageTotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
              <div className="min-w-0 col-span-2 lg:col-span-4">
                <label className={labelClass}>Remarks</label>
                <input
                  type="text" className={inputClass}
                  value={form.remarks}
                  onChange={(e) => set('remarks', e.target.value)}
                  placeholder="Optional note"
                  disabled={!editable}
                />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4 pb-24 sm:pb-4">
            <button
              onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/production/additional-wages')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
            >
              <ArrowLeft size={14} /> Back
            </button>
            {editable && (
              <button
                onClick={handleSave} disabled={saving}
                className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-60"
              >
                {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
                {isEdit ? 'Save changes' : 'Save entry'}
              </button>
            )}
            {isEdit && canDelete('Wage Voucher') && (
              <button
                onClick={handleDelete}
                className="w-full sm:w-auto sm:ml-auto inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg"
              >
                <Trash2 size={14} /> Remove
              </button>
            )}
          </div>
        </>
      )}
    </MainLayout>
  );
}

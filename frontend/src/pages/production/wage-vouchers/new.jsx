import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Package, FileText, Plus, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useApiData from '../../../hooks/useApiData.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { promptText } from '@/components/common/prompt';
import { formatDate } from '@/utils/formatters';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
// Visual treatment for a field locked READ_ONLY by field permissions.
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

const fmtQty = (v) =>
  Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtDate = (v) =>
  v ? formatDate(v) : '-';
const fmtMoney = (v) =>
  `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));

export default function CreateWageVoucher() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Wage Voucher');
  // Field-level permissions for the Wage Voucher header — hide HIDDEN
  // inputs and lock READ_ONLY ones for the current user's role.
  const { isHidden, isReadOnly } = useFieldPermissions('Wage Voucher');
  // PRODUCTION = billing against a Work Order; PACKING = billing against
  // a Packing Process. Switching kind clears the picked record so the
  // user can't accidentally submit a stale WO/Packing FK.
  const [voucherKind, setVoucherKind] = useState('PRODUCTION');
  const [selectedCompany, setSelectedCompany] = useState('');
  const { options: companyOptions } = useLookup('/api/companies/');
  // Pull full WO records so we can auto-fill Company + Warehouse when one
  // is picked. useLookup only returns {value,label} options — not enough.
  const { data: allWorkOrdersRaw } = useApiData('/api/production/work-orders/');
  // Same for packing processes — needed when voucherKind === 'PACKING'.
  const { data: allPackingsRaw } = useApiData('/api/production/packing-processes/');
  // Pull all existing wage vouchers so we can hide any record that's
  // already been billed (one voucher per WO or per Packing Process).
  const { data: existingVouchers } = useApiData('/api/production/wage-vouchers/');
  const usedWorkOrderIds = useMemo(() => {
    const s = new Set();
    (existingVouchers || []).forEach((v) => { if (v.work_order) s.add(v.work_order); });
    return s;
  }, [existingVouchers]);
  const usedPackingIds = useMemo(() => {
    const s = new Set();
    (existingVouchers || []).forEach((v) => { if (v.packing_process) s.add(v.packing_process); });
    return s;
  }, [existingVouchers]);
  // Filter out already-billed WOs / Packings and shape into {value,label}
  // for the select. Counts are kept separately so the empty-state message
  // can distinguish "no records at all" from "all of them are vouchered".
  const totalWorkOrderCount = (allWorkOrdersRaw || []).length;
  const totalPackingCount = (allPackingsRaw || []).length;
  const workOrders = useMemo(() => (
    (allWorkOrdersRaw || [])
      .filter((wo) => !usedWorkOrderIds.has(wo.id))
      .map((wo) => ({ value: wo.id, label: wo.work_order_no || wo.batch_id || wo.id }))
  ), [allWorkOrdersRaw, usedWorkOrderIds]);
  const packings = useMemo(() => (
    (allPackingsRaw || [])
      .filter((p) => !usedPackingIds.has(p.id))
      .map((p) => ({ value: p.id, label: p.packing_no || p.id }))
  ), [allPackingsRaw, usedPackingIds]);
  // Index by id so the change handler can pull the full record.
  const workOrdersById = useMemo(() => {
    const m = {};
    (allWorkOrdersRaw || []).forEach((wo) => { m[wo.id] = wo; });
    return m;
  }, [allWorkOrdersRaw]);
  const packingsById = useMemo(() => {
    const m = {};
    (allPackingsRaw || []).forEach((p) => { m[p.id] = p; });
    return m;
  }, [allPackingsRaw]);
  // Vendor master uses `vendor_name`, not `name`. Without overriding the
  // labelField the dropdown shows blank options.
  const { options: vendors } = useLookup('/api/vendors/', {
    labelField: 'vendor_name',
    valueField: 'id',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    work_order: '',
    packing_process: '',
    warehouse: '',
    voucher_date: '',
    total_amount: '',
    contractor_vendor: '',
    remarks: '',
    tds: '',
  });

  // Full WO detail (header + output_products) for the picked Work Order.
  // List serializer doesn't include output_products, so fetch on demand.
  const [woDetail, setWoDetail] = useState(null);
  const [loadingWoDetail, setLoadingWoDetail] = useState(false);
  // Same idea for packing process detail.
  const [packingDetail, setPackingDetail] = useState(null);
  const [loadingPackingDetail, setLoadingPackingDetail] = useState(false);
  // Free-form wage amount when in PACKING mode — packing vouchers don't
  // multiply by output qty or persons, the user just types a total.
  const [packingWageAmount, setPackingWageAmount] = useState('');

  // Wage amount per output line, keyed by output_product.id. Reset whenever
  // the user picks a different WO so amounts don't bleed across orders.
  const [outputWages, setOutputWages] = useState({});
  // Headcount-mode wage entry: one row per wage category (e.g. 10 persons
  // @ 500, 5 @ 700). Used only when the picked WO's wage_method is
  // HEADCOUNT (output-products table is hidden in that case).
  const emptyHeadcountRow = { reason: '', persons: '', wage_per_person: '' };
  const [headcountRows, setHeadcountRows] = useState([{ ...emptyHeadcountRow }]);

  useEffect(() => {
    if (!formData.work_order) {
      setWoDetail(null);
      setOutputWages({});
      setHeadcountRows([{ ...emptyHeadcountRow }]);
      return undefined;
    }
    let cancelled = false;
    setLoadingWoDetail(true);
    apiClient.get(`/api/production/work-orders/${formData.work_order}/`)
      .then((res) => {
        if (cancelled) return;
        setWoDetail(res.data);
        setOutputWages({});
        setHeadcountRows([{ ...emptyHeadcountRow }]);
      })
      .catch(() => { if (!cancelled) setWoDetail(null); })
      .finally(() => { if (!cancelled) setLoadingWoDetail(false); });
    return () => { cancelled = true; };
  }, [formData.work_order]);

  useEffect(() => {
    if (!formData.packing_process) {
      setPackingDetail(null);
      setPackingWageAmount('');
      return undefined;
    }
    let cancelled = false;
    setLoadingPackingDetail(true);
    apiClient.get(`/api/production/packing-processes/${formData.packing_process}/`)
      .then((res) => {
        if (cancelled) return;
        setPackingDetail(res.data);
        setPackingWageAmount('');
      })
      .catch(() => { if (!cancelled) setPackingDetail(null); })
      .finally(() => { if (!cancelled) setLoadingPackingDetail(false); });
    return () => { cancelled = true; };
  }, [formData.packing_process]);

  const isPacking = voucherKind === 'PACKING';

  // Packing runs carry their own wage basis (wage_type) that mirrors the
  // WorkOrder.wage_method mechanism: HEAD_COUNT → per-person wage rows
  // (no contractor); PACKING_GROUP → a contractor is paid a single amount.
  const packingWageType = isPacking ? (packingDetail?.wage_type || '') : '';
  const isPackingHeadcount = isPacking && packingWageType === 'HEAD_COUNT';

  // Effective wage method for the picked WO. Prefer the freshly-loaded
  // detail (definitive), fall back to the list cache so the UI swaps
  // immediately on click without waiting for the detail fetch.
  const selectedWageMethod =
    woDetail?.wage_method
    || workOrdersById[formData.work_order]?.wage_method
    || '';
  // Per-headcount entry applies to a HEADCOUNT work order OR a HEAD_COUNT
  // packing run — both render the same Per Headcount Wages table.
  const isHeadcount = (!isPacking && selectedWageMethod === 'HEADCOUNT') || isPackingHeadcount;

  // Total wage amount. PACKING: free-form amount the user types.
  // PRODUCTION + HEADCOUNT: Σ (persons × wage-per-person) across rows.
  // PRODUCTION default: sum of (output qty × per-row wage).
  const headcountRowTotal = (row) => num(row.persons) * num(row.wage_per_person);
  const totalWageAmount = useMemo(() => {
    // Headcount (production HEADCOUNT or packing HEAD_COUNT): sum the rows.
    if (isHeadcount) {
      return headcountRows.reduce((acc, row) => acc + headcountRowTotal(row), 0);
    }
    // Packing Group: the free-form amount the user types.
    if (isPacking) {
      return num(packingWageAmount);
    }
    if (!woDetail?.output_products) return 0;
    return woDetail.output_products.reduce((acc, row) => {
      const wage = num(outputWages[row.id]);
      const qty = num(row.expected_output_qty || row.planned_output_qty || 0);
      return acc + qty * wage;
    }, 0);
  }, [isPacking, packingWageAmount, isHeadcount, headcountRows, woDetail, outputWages]);

  const updateHeadcountRow = (idx, field, value) => {
    setHeadcountRows((prev) => prev.map((row, i) => (i === idx ? { ...row, [field]: value } : row)));
  };
  const addHeadcountRow = () => setHeadcountRows((prev) => [...prev, { ...emptyHeadcountRow }]);
  const removeHeadcountRow = (idx) => {
    setHeadcountRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));
  };

  // Shared "Work Done" options — stored server-side so an option added by
  // one user shows up for everyone. The dropdown carries an inline
  // "+ Add new…" entry that creates the option on the spot.
  // (API + JSON still use the original `reason` naming.)
  const { data: wageReasons, refetch: refetchReasons } = useApiData('/api/production/wage-reasons/');
  const ADD_REASON = '__add_new_reason__';
  const handleReasonChange = async (idx, value) => {
    if (value !== ADD_REASON) {
      updateHeadcountRow(idx, 'reason', value);
      return;
    }
    const input = await promptText({ title: 'Add "Work Done" option', label: 'New option (visible to all users)', placeholder: 'e.g. Loading, Stitching', required: true, confirmLabel: 'Add' });
    const name = (input || '').trim();
    if (!name) return;
    try {
      const res = await apiClient.post('/api/production/wage-reasons/', { name });
      await refetchReasons();
      updateHeadcountRow(idx, 'reason', res.data?.name || name);
      toast.success(`Work done option "${res.data?.name || name}" added.`);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to add option');
    }
  };

  // Keep the form's Total Amount in sync with the computed total so the
  // value that gets POSTed matches what the user sees.
  useEffect(() => {
    setFormData((prev) => ({ ...prev, total_amount: totalWageAmount.toFixed(2) }));
  }, [totalWageAmount]);

  // Net payable = gross wage − TDS withheld. Never shown below zero.
  const netPayable = useMemo(
    () => Math.max(0, totalWageAmount - num(formData.tds)),
    [totalWageAmount, formData.tds],
  );

  const { options: warehouses } = useLookup(
    selectedCompany ? `/api/warehouses/?company=${selectedCompany}&scope=true` : null
  );

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  // Picking a Work Order auto-fills Company + Warehouse from the WO record.
  // The Wage Voucher belongs to the WO's scope, so it makes no sense to ask
  // the user to re-pick those.
  const handleWorkOrderChange = (e) => {
    const woId = e.target.value;
    const wo = workOrdersById[woId];
    setFormData((prev) => ({
      ...prev,
      work_order: woId,
      warehouse: wo?.warehouse || '',
      // If the new WO is HEADCOUNT, drop any previously picked contractor —
      // headcount-based wages aren't paid through a contractor.
      contractor_vendor: wo?.wage_method === 'HEADCOUNT' ? '' : prev.contractor_vendor,
    }));
    setSelectedCompany(wo?.company || '');
  };

  // Picking a Packing Process auto-fills Company + Warehouse. Same idea
  // as work-order change handler.
  const handlePackingChange = (e) => {
    const pid = e.target.value;
    const p = packingsById[pid];
    setFormData((prev) => ({
      ...prev,
      packing_process: pid,
      warehouse: p?.warehouse || '',
      // Clear contractor — the new packing's wage_type decides whether it
      // applies (loaded via the packing detail effect).
      contractor_vendor: '',
    }));
    setSelectedCompany(p?.company || '');
    setHeadcountRows([{ ...emptyHeadcountRow }]);
    setPackingWageAmount('');
  };

  // Switching voucher kind clears the picked record + computed totals so
  // a half-filled production voucher doesn't leak into packing mode.
  const handleKindChange = (nextKind) => {
    if (nextKind === voucherKind) return;
    setVoucherKind(nextKind);
    setFormData((prev) => ({
      ...prev,
      work_order: '',
      packing_process: '',
      warehouse: '',
      contractor_vendor: '',
      total_amount: '',
    }));
    setSelectedCompany('');
    setWoDetail(null);
    setPackingDetail(null);
    setOutputWages({});
    setHeadcountRows([{ ...emptyHeadcountRow }]);
    setPackingWageAmount('');
  };

  // Contractor only applies when the wage basis pays a contractor:
  //  - PRODUCTION: any wage_method other than HEADCOUNT (Template Rate /
  //    Production Group → contractor paid; HEADCOUNT → staff directly).
  //  - PACKING: only PACKING_GROUP (HEAD_COUNT pays per-person, no
  //    contractor). Mandatory when shown for a packing voucher.
  const showContractor = isPacking
    ? (!!packingDetail && packingWageType === 'PACKING_GROUP')
    : (formData.work_order && !isHeadcount);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isHeadcount) {
      const bad = headcountRows.findIndex(
        (row) => !(num(row.persons) > 0) || !(num(row.wage_per_person) > 0),
      );
      if (bad !== -1) {
        toast.error(`Headcount row ${bad + 1}: enter persons and wage per person (both above 0).`);
        return;
      }
    }
    // Packing Group packing vouchers pay a contractor — it's mandatory.
    if (isPacking && packingWageType === 'PACKING_GROUP' && !formData.contractor_vendor) {
      toast.error('Contractor is required for a Packing Group wage voucher.');
      return;
    }
    setIsLoading(true);
    try {
      // Backend's WageVoucherCreateSerializer expects exactly one of
      // {work_order, packing_process} per voucher_kind. Strip the irrelevant
      // FK so a stale empty string doesn't trip serializer validation.
      const payload = {
        ...formData,
        voucher_kind: voucherKind,
        amount: totalWageAmount.toFixed(2),
      };
      if (isHeadcount) {
        payload.headcount_lines = headcountRows.map((row) => ({
          reason: (row.reason || '').trim(),
          persons: num(row.persons),
          wage_per_person: num(row.wage_per_person).toFixed(2),
          row_total: headcountRowTotal(row).toFixed(2),
        }));
      }
      if (isPacking) {
        delete payload.work_order;
      } else {
        delete payload.packing_process;
      }
      await apiClient.post('/api/production/wage-vouchers/', cleanFormData(payload));
      toast.success('Wage Voucher created successfully!');
      navigate('/production/wage-vouchers');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to create Wage Voucher');
    } finally {
      setIsLoading(false);
    }
  };

  // Per-headcount wage entry card — shared by the production HEADCOUNT
  // branch and the packing HEAD_COUNT branch so both stay in lockstep.
  const renderHeadcountWagesCard = () => (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-2 mb-3 pb-2 border-b">
        <div className="flex items-center gap-2">
          <Package size={16} className="text-emerald-600" />
          <h4 className="font-semibold text-slate-800">Per Headcount Wages</h4>
          <span className="text-xs text-slate-400">{headcountRows.length} row(s)</span>
        </div>
        <button
          type="button"
          onClick={addHeadcountRow}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary-700 border border-primary-300 rounded-lg hover:bg-primary-50 transition"
        >
          <Plus size={14} /> Add Row
        </button>
      </div>
      <div className="space-y-3">
        {headcountRows.map((row, idx) => (
          <div key={idx} className="grid grid-cols-[auto,1fr,1fr,1fr,1.4fr,auto] gap-3 items-end">
            <div className="pb-2 w-6 text-sm font-mono text-slate-400 text-right">{idx + 1}</div>
            <div>
              {idx === 0 && (
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Number of Persons <span className="text-red-500">*</span>
                </label>
              )}
              <input
                type="number"
                min="0"
                step="1"
                value={row.persons}
                onChange={(e) => updateHeadcountRow(idx, 'persons', e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-right focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <div>
              {idx === 0 && (
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Wage per Person <span className="text-red-500">*</span>
                </label>
              )}
              <input
                type="number"
                min="0"
                step="0.01"
                value={row.wage_per_person}
                onChange={(e) => updateHeadcountRow(idx, 'wage_per_person', e.target.value)}
                placeholder="0.00"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-right focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <div>
              {idx === 0 && (
                <label className="block text-sm font-medium text-slate-700 mb-1">Row Total</label>
              )}
              <div className="w-full px-3 py-2 border border-emerald-200 rounded-lg text-sm bg-emerald-50 font-semibold text-emerald-700 text-right">
                {fmtMoney(headcountRowTotal(row))}
              </div>
            </div>
            <div>
              {idx === 0 && (
                <label className="block text-sm font-medium text-slate-700 mb-1">Work Done</label>
              )}
              <CustomSelect
                value={row.reason}
                onChange={(e) => handleReasonChange(idx, e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="">Select work done</option>
                {row.reason && !(wageReasons || []).some((r) => r.name === row.reason) && (
                  <option value={row.reason}>{row.reason}</option>
                )}
                {(wageReasons || []).map((r) => (
                  <option key={r.id} value={r.name}>{r.name}</option>
                ))}
                <option value={ADD_REASON}>+ Add new work done…</option>
              </CustomSelect>
            </div>
            <button
              type="button"
              onClick={() => removeHeadcountRow(idx)}
              disabled={headcountRows.length === 1}
              title={headcountRows.length === 1 ? 'At least one row is required' : 'Remove row'}
              className="mb-0.5 p-2 rounded-lg text-red-500 hover:bg-red-50 disabled:text-slate-300 disabled:hover:bg-transparent transition"
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-4 pt-3 border-t flex items-center justify-between">
        <p className="text-xs text-slate-500">
          Row Total = Number of Persons × Wage per Person. Add a row per wage category.
        </p>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-slate-600">Grand Total</span>
          <div className="px-4 py-2 border border-emerald-300 rounded-lg text-sm bg-emerald-50 font-bold text-emerald-800 text-right min-w-[120px]">
            {fmtMoney(totalWageAmount)}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <MainLayout>
      <PageHeader
        title="Create Wage Voucher"
        breadcrumbs={[
          { label: 'Production', path: '/production' },
          { label: 'Wage Vouchers', path: '/production/wage-vouchers' },
          { label: 'New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Wage Voucher Details</h3>

            {/* Voucher kind selector — Production = bill a Work Order,
                Packing = bill a Packing Process. */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-700 mb-2">Voucher For</label>
              <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
                <button
                  type="button"
                  onClick={() => handleKindChange('PRODUCTION')}
                  className={`px-4 py-2 text-sm font-medium ${
                    voucherKind === 'PRODUCTION'
                      ? 'bg-primary-600 text-white'
                      : 'bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Production
                </button>
                <button
                  type="button"
                  onClick={() => handleKindChange('PACKING')}
                  className={`px-4 py-2 text-sm font-medium border-l border-slate-300 ${
                    voucherKind === 'PACKING'
                      ? 'bg-primary-600 text-white'
                      : 'bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Packing
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {isPacking ? (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Packing No <span className="text-red-500">*</span></label>
                  <CustomSelect name="packing_process" value={formData.packing_process} onChange={handlePackingChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                    <option value="">
                      {packings.length === 0
                        ? (totalPackingCount === 0
                            ? 'No packing processes found — create one first'
                            : 'All packing processes already have a voucher')
                        : 'Select Packing No...'}
                    </option>
                    {packings.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </CustomSelect>
                  <p className="mt-1 text-xs text-slate-500">
                    Picking a Packing No auto-fills Company &amp; Warehouse. Only packings without a voucher are shown.
                  </p>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Work Order <span className="text-red-500">*</span></label>
                  <CustomSelect name="work_order" value={formData.work_order} onChange={handleWorkOrderChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                    <option value="">
                      {workOrders.length === 0
                        ? (totalWorkOrderCount === 0
                            ? 'No work orders found — create one first'
                            : 'All work orders already have a voucher')
                        : 'Select Work Order...'}
                    </option>
                    {workOrders.map(wo => <option key={wo.value} value={wo.value}>{wo.label}</option>)}
                  </CustomSelect>
                  <p className="mt-1 text-xs text-slate-500">
                    Picking a Work Order auto-fills Company &amp; Warehouse. Only WOs without a voucher are shown.
                  </p>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect value={selectedCompany} onChange={(e) => { setSelectedCompany(e.target.value); setFormData(prev => ({ ...prev, warehouse: '' })); }} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select Company...</option>
                  {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleChange} required disabled={!selectedCompany} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed">
                  <option value="">{selectedCompany ? 'Select Warehouse...' : 'Select company first...'}</option>
                  {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Voucher Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="voucher_date" value={formData.voucher_date} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Total Amount <span className="text-red-500">*</span></label>
                <div className="w-full px-3 py-2 border border-emerald-200 rounded-lg text-sm bg-emerald-50 font-semibold text-emerald-700 text-right">
                  {fmtMoney(totalWageAmount)}
                </div>
                {/* Hidden mirror so the value still ships with the form payload. */}
                <input type="hidden" name="total_amount" value={formData.total_amount} />
                <p className="mt-1 text-xs text-slate-500">
                  {isHeadcount
                    ? 'Number of Persons × Wage per Person.'
                    : isPacking
                      ? 'Wage amount entered in the Packing section below.'
                      : 'Sum of Row Total (Wage Amount × Output Qty) across all rows.'}
                </p>
              </div>
              {showContractor && !isHidden('contractor_vendor') && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Contractor {isPacking && <span className="text-red-500">*</span>}
                  </label>
                  <CustomSelect name="contractor_vendor" value={formData.contractor_vendor} onChange={handleChange} required={isPacking} disabled={isReadOnly('contractor_vendor')} className={isReadOnly('contractor_vendor') ? lockedInputClass : inputClass}>
                    <option value="">Select Contractor...</option>
                    {vendors.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                  </CustomSelect>
                </div>
              )}
              {!isHidden('tds') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">TDS</label>
                <input type="number" name="tds" value={formData.tds} onChange={handleChange} disabled={isReadOnly('tds')} className={isReadOnly('tds') ? lockedInputClass : inputClass} />
              </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Net Payable (After TDS)</label>
                <div className="w-full px-3 py-2 border border-indigo-200 rounded-lg text-sm bg-indigo-50 font-semibold text-indigo-700 text-right">
                  {fmtMoney(netPayable)}
                </div>
                <p className="mt-1 text-xs text-slate-500">Total Amount − TDS.</p>
              </div>
              {!isHidden('remarks') && (
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} rows={3} disabled={isReadOnly('remarks')} className={isReadOnly('remarks') ? lockedInputClass : inputClass} />
              </div>
              )}
            </div>
          </div>

          {/* ── Related Work Order (read-only context) ─────────────────── */}
          {!isPacking && formData.work_order && (
            <div className="border-t pt-6">
              <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">
                Related Work Order
                {loadingWoDetail && <span className="ml-2 text-xs text-slate-400 font-normal">loading…</span>}
              </h3>

              {woDetail ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 text-sm mb-4">
                    <div>
                      <p className="text-xs text-slate-500">WO Number</p>
                      <p className="font-mono font-medium text-slate-800">{woDetail.work_order_no || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Batch ID</p>
                      <p className="font-mono text-slate-800">{woDetail.batch_id || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Process</p>
                      <p className="text-slate-800">{woDetail.process_name || woDetail.process_name_snapshot || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Finished Product</p>
                      <p className="text-slate-800">{woDetail.finished_product_name || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Date</p>
                      <p className="text-slate-800">{fmtDate(woDetail.date)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Production Date</p>
                      <p className="text-slate-800">{fmtDate(woDetail.production_date)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Machine</p>
                      <p className="text-slate-800">{woDetail.machine_name_label || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Wage Method</p>
                      <p className="text-slate-800">{woDetail.wage_method || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Stage</p>
                      <div className="mt-0.5"><StatusBadge status={woDetail.stage_status || 'MATERIAL_ISSUE'} /></div>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Approval</p>
                      <div className="mt-0.5"><StatusBadge status={woDetail.approval_status || 'PENDING'} /></div>
                    </div>
                  </div>

                  {isHeadcount ? (
                    /* HEADCOUNT mode: wage is paid per person, not per
                       output product. Show output products as read-only
                       context, plus a simple persons × rate input UI. */
                    <div className="space-y-4">
                      <div className="bg-white rounded-lg border border-slate-200 p-4">
                        <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                          <Package size={16} className="text-emerald-600" />
                          <h4 className="font-semibold text-slate-800">Output Products</h4>
                          <span className="text-xs text-slate-400">
                            {(woDetail.output_products || []).length} item(s)
                          </span>
                        </div>
                        {(woDetail.output_products || []).length === 0 ? (
                          <p className="text-sm text-slate-400 italic">No output rows on this Work Order.</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm" style={{ minWidth: '600px' }}>
                              <thead>
                                <tr className="bg-slate-50 border-b">
                                  <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                                  <th className="px-2 py-2 text-left font-semibold text-slate-600">Output Product</th>
                                  <th className="px-2 py-2 text-left font-semibold text-slate-600">UOM</th>
                                  <th className="px-2 py-2 text-right font-semibold text-slate-600">Output Qty</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(woDetail.output_products || []).map((row, idx) => {
                                  const qty = num(row.expected_output_qty || row.planned_output_qty || 0);
                                  return (
                                    <tr key={row.id || idx} className="border-b">
                                      <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                                      <td className="px-2 py-2 text-slate-800 font-medium">{row.product_name || '-'}</td>
                                      <td className="px-2 py-2 text-slate-700">{row.uom || '-'}</td>
                                      <td className="px-2 py-2 text-right text-slate-700">{fmtQty(qty)}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                      {renderHeadcountWagesCard()}
                    </div>
                  ) : (
                    /* Default: per-output-product wage entry */
                    <div className="bg-white rounded-lg border border-slate-200 p-4">
                      <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                        <Package size={16} className="text-emerald-600" />
                        <h4 className="font-semibold text-slate-800">Output Products</h4>
                        <span className="text-xs text-slate-400">
                          {(woDetail.output_products || []).length} item(s)
                        </span>
                      </div>
                      {(woDetail.output_products || []).length === 0 ? (
                        <p className="text-sm text-slate-400 italic">No output rows on this Work Order.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm" style={{ minWidth: '800px' }}>
                            <thead>
                              <tr className="bg-slate-50 border-b">
                                <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                                <th className="px-2 py-2 text-left font-semibold text-slate-600">Output Product</th>
                                <th className="px-2 py-2 text-left font-semibold text-slate-600">UOM</th>
                                <th className="px-2 py-2 text-right font-semibold text-slate-600">Output Qty</th>
                                <th className="px-2 py-2 text-right font-semibold text-slate-600">Wage Amount</th>
                                <th className="px-2 py-2 text-right font-semibold text-emerald-700">Row Total</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(woDetail.output_products || []).map((row, idx) => {
                                const qty = num(row.expected_output_qty || row.planned_output_qty || 0);
                                const wage = num(outputWages[row.id]);
                                const rowTotal = qty * wage;
                                return (
                                  <tr key={row.id || idx} className="border-b">
                                    <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                                    <td className="px-2 py-2 text-slate-800 font-medium">{row.product_name || '-'}</td>
                                    <td className="px-2 py-2 text-slate-700">{row.uom || '-'}</td>
                                    <td className="px-2 py-2 text-right text-slate-700">{fmtQty(qty)}</td>
                                    <td className="px-2 py-2">
                                      <input
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        value={outputWages[row.id] ?? ''}
                                        onChange={(e) => setOutputWages((prev) => ({ ...prev, [row.id]: e.target.value }))}
                                        placeholder="0.00"
                                        className="w-full px-2 py-1 border border-slate-300 rounded text-sm text-right focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                                        style={{ minWidth: '90px' }}
                                      />
                                    </td>
                                    <td className="px-2 py-2 text-right font-semibold text-emerald-700">
                                      {fmtMoney(rowTotal)}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                            <tfoot>
                              <tr className="bg-emerald-50 border-t-2 border-emerald-200">
                                <td colSpan={5} className="px-2 py-2 text-right font-semibold text-slate-700">
                                  Total Wage Amount
                                </td>
                                <td className="px-2 py-2 text-right font-bold text-emerald-700">
                                  {fmtMoney(totalWageAmount)}
                                </td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : !loadingWoDetail && (
                <p className="text-sm text-slate-400 italic">Could not load Work Order details.</p>
              )}
            </div>
          )}

          {/* ── Related Packing Process (read-only context) ────────────── */}
          {isPacking && formData.packing_process && (
            <div className="border-t pt-6">
              <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">
                Related Packing Process
                {loadingPackingDetail && <span className="ml-2 text-xs text-slate-400 font-normal">loading…</span>}
              </h3>

              {packingDetail ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 text-sm mb-4">
                    <div>
                      <p className="text-xs text-slate-500">Packing No</p>
                      <p className="font-mono font-medium text-slate-800">{packingDetail.packing_no || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Batch No</p>
                      <p className="font-mono text-slate-800">{packingDetail.batch_no || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Process</p>
                      <p className="text-slate-800">{packingDetail.process_name || packingDetail.process_name_snapshot || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Warehouse</p>
                      <p className="text-slate-800">{packingDetail.warehouse_name || packingDetail.warehouse_code || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Date</p>
                      <p className="text-slate-800">{fmtDate(packingDetail.date)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Packing Date</p>
                      <p className="text-slate-800">{fmtDate(packingDetail.production_date)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Total Packing Material Qty</p>
                      <p className="text-slate-800">{fmtQty(packingDetail.total_packing_material_qty)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Approval</p>
                      <div className="mt-0.5"><StatusBadge status={packingDetail.approval_status || 'PENDING'} /></div>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Wage Type</p>
                      <p className="text-slate-800">
                        {packingWageType === 'HEAD_COUNT'
                          ? 'Head Count'
                          : packingWageType === 'PACKING_GROUP'
                            ? 'Packing Group'
                            : '-'}
                      </p>
                    </div>
                  </div>

                  {/* Input Products — read-only context */}
                  <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                      <FileText size={16} className="text-orange-600" />
                      <h4 className="font-semibold text-slate-800">Input Products</h4>
                      <span className="text-xs text-slate-400">
                        {(packingDetail.input_products || []).length} item(s)
                      </span>
                    </div>
                    {(packingDetail.input_products || []).length === 0 ? (
                      <p className="text-sm text-slate-400 italic">No input rows on this Packing Process.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm" style={{ minWidth: '600px' }}>
                          <thead>
                            <tr className="bg-slate-50 border-b">
                              <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                              <th className="px-2 py-2 text-left font-semibold text-slate-600">Input Product</th>
                              <th className="px-2 py-2 text-left font-semibold text-slate-600">UOM</th>
                              <th className="px-2 py-2 text-right font-semibold text-slate-600">Stock Available</th>
                              <th className="px-2 py-2 text-right font-semibold text-orange-700">Input Qty</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(packingDetail.input_products || []).map((row, idx) => (
                              <tr key={row.id || idx} className="border-b">
                                <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                                <td className="px-2 py-2 text-slate-800 font-medium">{row.product_name || '-'}</td>
                                <td className="px-2 py-2 text-slate-700">{row.uom || '-'}</td>
                                <td className="px-2 py-2 text-right text-slate-700">{fmtQty(row.stock_available)}</td>
                                <td className="px-2 py-2 text-right font-semibold text-orange-700">{fmtQty(row.input_qty)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Output Products — read-only context */}
                  <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                      <Package size={16} className="text-emerald-600" />
                      <h4 className="font-semibold text-slate-800">Output Products</h4>
                      <span className="text-xs text-slate-400">
                        {(packingDetail.output_products || []).length} item(s)
                      </span>
                    </div>
                    {(packingDetail.output_products || []).length === 0 ? (
                      <p className="text-sm text-slate-400 italic">No output rows on this Packing Process.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm" style={{ minWidth: '600px' }}>
                          <thead>
                            <tr className="bg-slate-50 border-b">
                              <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                              <th className="px-2 py-2 text-left font-semibold text-slate-600">Output Product</th>
                              <th className="px-2 py-2 text-left font-semibold text-slate-600">UOM</th>
                              <th className="px-2 py-2 text-right font-semibold text-slate-600">Stock Available</th>
                              <th className="px-2 py-2 text-right font-semibold text-emerald-700">Output Qty</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(packingDetail.output_products || []).map((row, idx) => (
                              <tr key={row.id || idx} className="border-b">
                                <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                                <td className="px-2 py-2 text-slate-800 font-medium">{row.product_name || '-'}</td>
                                <td className="px-2 py-2 text-slate-700">{row.uom || '-'}</td>
                                <td className="px-2 py-2 text-right text-slate-700">{fmtQty(row.stock_available)}</td>
                                <td className="px-2 py-2 text-right font-semibold text-emerald-700">{fmtQty(row.output_qty)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* HEAD_COUNT packing → per-person wage rows; PACKING_GROUP
                      packing → single contractor amount. */}
                  {isPackingHeadcount ? (
                    renderHeadcountWagesCard()
                  ) : (
                  <div className="bg-white rounded-lg border border-slate-200 p-4">
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                      <Package size={16} className="text-emerald-600" />
                      <h4 className="font-semibold text-slate-800">Packing Wage</h4>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 items-end">
                      <div>
                        <p className="text-xs text-slate-500 mb-1">Packing No</p>
                        <div className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 font-mono text-slate-700">
                          {packingDetail.packing_no || '-'}
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">
                          Wage Amount <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={packingWageAmount}
                          onChange={(e) => setPackingWageAmount(e.target.value)}
                          placeholder="0.00"
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-right focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">Row Total</label>
                        <div className="w-full px-3 py-2 border border-emerald-200 rounded-lg text-sm bg-emerald-50 font-semibold text-emerald-700 text-right">
                          {fmtMoney(totalWageAmount)}
                        </div>
                      </div>
                    </div>
                    <p className="mt-3 text-xs text-slate-500">
                      Wage amount entered here flows into Total Amount above.
                    </p>
                  </div>
                  )}
                </>
              ) : !loadingPackingDetail && (
                <p className="text-sm text-slate-400 italic">Could not load Packing Process details.</p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}

import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Pencil, Trash2, Paperclip, Download, Check, X as XIcon, CheckCircle2, RefreshCcw, Package, FileText, Plus, Printer } from 'lucide-react';

import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import useApiData from '../../../hooks/useApiData.js';
import { confirm } from '@/components/common/confirm';
import { promptText } from '@/components/common/prompt';
import { formatDate } from '@/utils/formatters';

const PACKING_STEPS = [
  { value: 'ONLY_FILLING', label: 'Only Filling' },
  { value: 'LABELS', label: 'Labels' },
  { value: 'SLEEVES', label: 'Sleeves' },
  { value: 'LEAFLET', label: 'Leaflet' },
  { value: 'CARTON_BOX', label: 'Carton Box' },
  { value: 'COMPLETED', label: 'Completed' },
];

// Mirrors master.Product.GOODS_SUB_TYPE_CHOICES — used to render readable
// labels in the daily-entry materials table.
const PRODUCT_CATEGORY_LABEL = {
  RAW_MATERIAL: 'Raw Material',
  PACKING_MATERIAL: 'Packing Material',
  FINISHED_GOOD: 'Finished Good',
  SEMI_FINISHED: 'Semi Finished',
  TRADED_PRODUCTS: 'Traded Products',
  CAPITAL_GOOD: 'Capital Good',
  MACHINE_SPARES: 'Machine Spares',
  CONSUMABLES: 'Consumables',
};
const catLabel = (v) => PRODUCT_CATEGORY_LABEL[v] || v || '-';

const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtDate = (v) =>
  v ? formatDate(v) : '-';

const fmtBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const num = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));
const todayISO = () => new Date().toISOString().slice(0, 10);

// ── Printable "Packing Process Sheet" ────────────────────────────────
// Bespoke formatted document — hidden on screen (`hidden print:block`),
// shown only when the browser print dialog runs. Mirrors the record's
// structured data in a clean A4 letterhead layout. Gated upstream by
// canPrint('Packing Process') on the Print button. This is the template
// pattern to replicate on the other modules' detail pages.
function SheetTable({ title, rows, cols }) {
  return (
    <div className="mb-4">
      <div className="text-sm font-semibold border-b border-black mb-1 pb-0.5">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-1">None.</div>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-black/50">
              <th className="text-left font-semibold py-1 w-8">#</th>
              {cols.map(([h, , align]) => (
                <th key={h} className={`py-1 font-semibold ${align === 'right' ? 'text-right' : 'text-left'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id || i} className="border-b border-black/20">
                <td className="py-1 text-slate-500">{i + 1}</td>
                {cols.map(([h, fn, align]) => (
                  <td key={h} className={`py-1 ${align === 'right' ? 'text-right' : 'text-left'}`}>{fn(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PackingProcessSheet({ data }) {
  const tp = data.target_progress || {};
  const targetQty = num(tp.target ?? data.target_output_quantity);
  const totalPacked = num(tp.total_packed);
  const pending = num(tp.pending);
  const wageTypeLabel = data.wage_type === 'HEAD_COUNT'
    ? 'Head Count'
    : data.wage_type === 'PACKING_GROUP' ? 'Packing Group' : '-';
  const meta = [
    ['Process', data.process_name || '-'],
    ['Batch No', data.batch_no || '-'],
    ['Company', data.company_name || '-'],
    ['Warehouse', data.warehouse_name || data.warehouse_code || '-'],
    ['Date', fmtDate(data.date)],
    ['Packing Date', fmtDate(data.production_date)],
    ['Wage Type', wageTypeLabel],
    ['Work Order', data.work_order_no || '-'],
    ['Approval', data.approval_status || '-'],
    ['Progress', data.progress_status || 'IN_PROGRESS'],
  ];
  return (
    <div className="hidden print:block text-black">
      {/* Letterhead */}
      <div className="flex items-start justify-between border-b-2 border-black pb-3 mb-4">
        <div>
          <div className="text-2xl font-bold tracking-tight">{data.company_name || 'Company'}</div>
          <div className="text-xs uppercase tracking-[0.2em] text-slate-700 mt-1">Packing Process Sheet</div>
        </div>
        <div className="text-right text-sm">
          <div><span className="text-slate-600">No: </span><span className="font-semibold">{data.packing_no}</span></div>
          <div><span className="text-slate-600">Date: </span>{fmtDate(data.date)}</div>
        </div>
      </div>

      {/* Meta grid */}
      <table className="w-full text-sm mb-4">
        <tbody>
          {[0, 2, 4, 6, 8].map((i) => (
            <tr key={i}>
              <td className="py-1 pr-2 text-slate-600 align-top w-[14%]">{meta[i][0]}</td>
              <td className="py-1 pr-6 font-medium align-top w-[36%]">{meta[i][1]}</td>
              <td className="py-1 pr-2 text-slate-600 align-top w-[14%]">{meta[i + 1][0]}</td>
              <td className="py-1 font-medium align-top w-[36%]">{meta[i + 1][1]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Target summary */}
      <div className="flex gap-8 text-sm mb-5 border border-black/40 rounded px-3 py-2">
        <div><span className="text-slate-600">Target Qty: </span><span className="font-semibold">{fmtQty(targetQty)}</span></div>
        <div><span className="text-slate-600">Total Packed: </span><span className="font-semibold">{fmtQty(totalPacked)}</span></div>
        <div><span className="text-slate-600">Pending: </span><span className="font-semibold">{fmtQty(pending)}</span></div>
      </div>

      <SheetTable
        title="Input Products (Materials Consumed)"
        rows={data.input_products || []}
        cols={[
          ['Product', (r) => r.product_name || '-', 'left'],
          ['Unit', (r) => r.uom || '-', 'left'],
          ['Input Qty', (r) => fmtQty(r.input_qty), 'right'],
        ]}
      />

      <SheetTable
        title="Output Products"
        rows={data.output_products || []}
        cols={[
          ['Product', (r) => r.product_name || '-', 'left'],
          ['Unit', (r) => r.uom || '-', 'left'],
          ['Output Qty', (r) => fmtQty(r.output_qty), 'right'],
        ]}
      />

      {/* Signatures */}
      <div className="grid grid-cols-3 gap-8 mt-16 text-sm">
        {['Prepared By', 'Checked By', 'Approved By'].map((label) => (
          <div key={label} className="text-center">
            <div className="border-t border-black pt-1">{label}</div>
            {label === 'Approved By' && data.approved_by_name && (
              <div className="text-xs text-slate-600 mt-0.5">{data.approved_by_name}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PackingProcessDetail() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { canEdit, canDelete, canApprove, canReject, canClose, canPrint } = usePermissions();
  // Field-level permissions for the Packing Process header. This is a
  // read-only detail page, so HIDDEN fields hide their display row; there
  // are no editable header inputs here to lock READ_ONLY (editing happens
  // on the separate /edit page).
  const { isHidden } = useFieldPermissions('Packing Process');
  // Line-item field permissions for the read-only Input/Output tables.
  const { isHidden: isInHidden } = useFieldPermissions('Packing Input');
  const { isHidden: isOutHidden } = useFieldPermissions('Packing Output');
  const [isApproving, setIsApproving] = useState(false);

  const [data, setData] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Product master — needed when the user adds an ad-hoc material that
  // wasn't on the original packing-process planning.
  const { data: allProducts } = useApiData('/api/products/');

  // One combined "daily entry" — output + inputs are recorded together.
  // The server creates a single PackingOutputEntry and N PackingInputEntry
  // rows in one transaction so neither side is ever recorded without the
  // other.
  //
  // `inputs` is intentionally NOT a free-pick list — it mirrors the
  // packing process's planned input products. Each row's input_product
  // is fixed at load time; the user only types today's qty for the
  // materials actually drawn. Empty/zero rows are filtered out on submit.
  const [dailyForm, setDailyForm] = useState({
    entry_date: todayISO(),
    stage: '',
    remarks: '',
    output_product: '',
    output_quantity: '',
    inputs: [],
    // Ad-hoc materials the user adds at daily-entry time that weren't
    // on the original planning. Backend will create a new
    // PackingInputProduct row (input_qty=0) for each before booking the
    // PackingInputEntry.
    new_inputs: [],
  });
  const [isSavingEntry, setIsSavingEntry] = useState(false);
  const [deletingOutputId, setDeletingOutputId] = useState(null);
  const [deletingInputId, setDeletingInputId] = useState(null);
  const [isToggling, setIsToggling] = useState(false);
  // Additive per-step progress entry: date + remarks + a qty per step.
  const [entryForm, setEntryForm] = useState({ entry_date: new Date().toISOString().slice(0, 10), remarks: '', qty: {} });
  const [savingEntry, setSavingEntry] = useState(false);
  const [deletingEntryId, setDeletingEntryId] = useState(null);

  const refetchDetail = useCallback(async () => {
    const res = await apiClient.get(`/api/production/packing-processes/${id}/`);
    setData(res.data);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiClient.get(`/api/production/packing-processes/${id}/`),
      apiClient.get('/api/production/attachments/', {
        params: { module: 'PACKING_PROCESS', record_id: id },
      }),
    ])
      .then(([wo, atts]) => {
        if (cancelled) return;
        setData(wo.data);
        setAttachments(atts.data?.results || atts.data || []);
      })
      .catch((err) => {
        toast.error(getApiErrorMessage(err) || 'Failed to load.');
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const stepLabels = useMemo(() => {
    if (!data?.packing_steps) return [];
    return PACKING_STEPS.filter((s) => data.packing_steps.includes(s.value)).map((s) => s.label);
  }, [data]);

  // TVP-only feature: multi-day packing progress. Same case-insensitive
  // match the create page uses, so TVP detection stays consistent.
  const isTvpWarehouse = useMemo(() => {
    const label = String(data?.warehouse_name || data?.warehouse_code || '').trim().toUpperCase();
    return label === 'TVP';
  }, [data]);

  const isCompleted = data?.progress_status === 'COMPLETED';
  const outputProducts = data?.output_products || [];
  const inputProducts = data?.input_products || [];

  // Keep the daily-entry materials rows in lockstep with the packing
  // process's planned input products. Each row's input_product is fixed
  // and not user-selectable — only the qty is editable. When the planning
  // set changes (e.g. after edit), rebuild while preserving any qty the
  // user has already typed for the same product.
  useEffect(() => {
    if (!data) return;
    setDailyForm((prev) => {
      const existingByProduct = new Map(
        (prev.inputs || []).map((r) => [r.input_product, r.quantity]),
      );
      const next = inputProducts.map((ip) => ({
        input_product: ip.id,
        product_name: ip.product_name,
        product_category: ip.product_category || '',
        uom: ip.uom,
        planned_qty: ip.input_qty,
        quantity: existingByProduct.get(ip.id) ?? '',
      }));
      // Auto-pick the single output product when only one exists, so the
      // user doesn't have to confirm an obvious choice.
      const autoOutput = outputProducts.length === 1
        ? outputProducts[0].id
        : prev.output_product;
      return { ...prev, inputs: next, output_product: autoOutput };
    });
    // We deliberately key the effect off the *ids* (and only the ids) of
    // the planning rows — re-running on every detail refetch would wipe
    // a half-typed qty the user is in the middle of entering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    data?.id,
    inputProducts.map((r) => r.id).join('|'),
    outputProducts.map((r) => r.id).join('|'),
  ]);

  // Flatten per-product daily_entries so we can render a single combined
  // timeline view alongside the per-row totals.
  const allOutputEntries = useMemo(() => (
    outputProducts.flatMap((op) => (op.daily_entries || []).map((e) => ({
      ...e,
      _product_name: op.product_name,
      _product_uom: op.uom,
      _required: op.output_qty,
    })))
  ), [outputProducts]);
  const allInputEntries = useMemo(() => (
    inputProducts.flatMap((ip) => (ip.daily_entries || []).map((e) => ({
      ...e,
      _product_name: ip.product_name,
      _product_uom: ip.uom,
      _required: ip.input_qty,
    })))
  ), [inputProducts]);

  // Header-level target progress — planning output_qty already counts
  // as packed at creation time; daily entries accumulate on top.
  // See `get_target_progress` in the backend serializer.
  const targetProgress = data?.target_progress || {};
  const targetOutputQty = num(targetProgress.target ?? data?.target_output_quantity);
  const totalPacked = num(targetProgress.total_packed);
  const headerPending = num(targetProgress.pending);

  // Completion guard:
  //   - target set → totalPacked (planning + daily) must meet/exceed it
  //   - target unset (legacy) → each output row must be fully packed via entries
  const fullyPacked = useMemo(() => {
    if (outputProducts.length === 0) return false;
    if (targetOutputQty > 0) return headerPending <= 0;
    return outputProducts.every((op) => num(op.total_packed) >= num(op.output_qty));
  }, [outputProducts, targetOutputQty, headerPending]);

  // Per-step progress (TVP step tracking). When a run has step rows the
  // completion gate is per-step (every step at 0 balance); otherwise it
  // falls back to the packed-total check above.
  const stepProgress = data?.step_progress || [];
  const hasStepProgress = stepProgress.length > 0;
  const stepsAllComplete = !!data?.steps_all_complete;
  const canComplete = hasStepProgress ? stepsAllComplete : fullyPacked;
  const stepEntries = data?.step_entries || [];

  // Record one additive entry across multiple steps at once (e.g. Filling
  // +20, Labels +25, Sleeves +25). Each qty ADDS to that step's running
  // total (server-clamped at the target).
  const addStepEntry = async () => {
    const lines = stepProgress
      .filter((sp) => !sp.complete)
      .map((sp) => ({ step: sp.step, quantity: entryForm.qty[sp.step] }))
      .filter((l) => l.quantity !== '' && l.quantity != null && Number(l.quantity) > 0);
    if (lines.length === 0) {
      toast.error('Enter a quantity for at least one step.');
      return;
    }
    setSavingEntry(true);
    try {
      const res = await apiClient.post(
        `/api/production/packing-processes/${id}/step-entry/`,
        { entry_date: entryForm.entry_date, remarks: entryForm.remarks, lines },
      );
      setData(res.data.detail);
      setEntryForm({ entry_date: new Date().toISOString().slice(0, 10), remarks: '', qty: {} });
      if (res.data.capped?.length) {
        const txt = res.data.capped.map((c) => `${c.step}: ${c.entered}→${c.applied}`).join(', ');
        toast(`Some steps were capped at their target — ${txt}`, { icon: '⚠️' });
      } else {
        toast.success('Progress entry added.');
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to add entry.');
    } finally {
      setSavingEntry(false);
    }
  };

  const deleteStepEntry = async (entryId) => {
    if (!(await confirm({ message: 'Undo this progress entry? Its quantities will be removed from the step totals.', isDangerous: true, confirmLabel: 'Undo' }))) return;
    setDeletingEntryId(entryId);
    try {
      const res = await apiClient.delete(`/api/production/packing-processes/${id}/step-entry/${entryId}/`);
      setData(res.data);
      toast.success('Entry removed.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to remove entry.');
    } finally {
      setDeletingEntryId(null);
    }
  };

  // Only the qty is editable — input_product is locked to the planning row.
  const updateInputQty = (idx, quantity) => {
    setDailyForm((p) => ({
      ...p,
      inputs: p.inputs.map((row, i) => (i === idx ? { ...row, quantity } : row)),
    }));
  };

  // Ad-hoc material row helpers — these are not planning-locked.
  // Each ad-hoc row also carries a per-row `category` filter that
  // narrows the product picker; it's not sent in the payload (server
  // resolves category from the product master).
  const addNewInputRow = () => setDailyForm((p) => ({
    ...p,
    new_inputs: [...p.new_inputs, { product: '', category: '', quantity: '' }],
  }));
  const updateNewInputRow = (idx, patch) => setDailyForm((p) => ({
    ...p,
    new_inputs: p.new_inputs.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
  }));
  const removeNewInputRow = (idx) => setDailyForm((p) => ({
    ...p,
    new_inputs: p.new_inputs.filter((_, i) => i !== idx),
  }));

  // Products NOT already on the packing process planning — these are the
  // candidates for ad-hoc addition. Picking one that's already planned
  // would just duplicate the row, so we hide them from the picker.
  const adhocProductOptions = useMemo(() => {
    const planned = new Set(inputProducts.map((ip) => ip.product));
    return (allProducts || []).filter((p) => !planned.has(p.id));
  }, [allProducts, inputProducts]);

  const handleAddDailyEntry = async (e) => {
    e.preventDefault();
    if (!dailyForm.entry_date) { toast.error('Date is required.'); return; }
    if (!dailyForm.output_product) { toast.error('Pick the output product packed.'); return; }
    if (num(dailyForm.output_quantity) <= 0) { toast.error('Output qty must be greater than zero.'); return; }

    const cleanInputs = dailyForm.inputs.filter((r) => r.input_product && num(r.quantity) > 0);
    const cleanNewInputs = dailyForm.new_inputs.filter((r) => r.product && num(r.quantity) > 0);
    if (cleanInputs.length === 0 && cleanNewInputs.length === 0) {
      toast.error('Add at least one material with quantity.');
      return;
    }
    // Reject duplicate input products in the same submission — the user
    // can edit the existing row instead.
    const seen = new Set();
    for (const r of cleanInputs) {
      if (seen.has(r.input_product)) {
        toast.error('Duplicate input product in the entry. Combine them into one row.');
        return;
      }
      seen.add(r.input_product);
    }
    // Ad-hoc rows: reject duplicates and reject picks that are already
    // on the planning (the user should fill the existing row instead).
    const plannedProductIds = new Set(inputProducts.map((ip) => ip.product));
    const seenNew = new Set();
    for (const r of cleanNewInputs) {
      if (plannedProductIds.has(r.product)) {
        toast.error('That product is already on the planning — fill its existing row instead.');
        return;
      }
      if (seenNew.has(r.product)) {
        toast.error('Duplicate ad-hoc material in the entry.');
        return;
      }
      seenNew.add(r.product);
    }

    setIsSavingEntry(true);
    try {
      const res = await apiClient.post(
        `/api/production/packing-processes/${id}/add-daily-entry/`,
        {
          entry_date: dailyForm.entry_date,
          stage: dailyForm.stage || '',
          remarks: dailyForm.remarks || '',
          output_product: dailyForm.output_product,
          output_quantity: num(dailyForm.output_quantity),
          inputs: cleanInputs.map((r) => ({
            input_product: r.input_product,
            quantity: num(r.quantity),
          })),
          new_inputs: cleanNewInputs.map((r) => ({
            product: r.product,
            quantity: num(r.quantity),
          })),
        },
      );
      setData(res.data);
      // Reset qtys but keep the input-product rows in place — they stay
      // tied to the packing-process planning regardless of the submit.
      setDailyForm((p) => ({
        ...p,
        entry_date: todayISO(),
        stage: '',
        remarks: '',
        output_quantity: '',
        output_product: outputProducts.length === 1 ? outputProducts[0].id : '',
        inputs: p.inputs.map((r) => ({ ...r, quantity: '' })),
        new_inputs: [],
      }));
      toast.success('Daily entry added.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to add daily entry.');
    } finally {
      setIsSavingEntry(false);
    }
  };

  const handleDeleteOutputEntry = async (entry) => {
    if (!(await confirm({ message: `Delete output entry of ${fmtQty(entry.quantity)} on ${fmtDate(entry.entry_date)}?`, isDangerous: true }))) return;
    setDeletingOutputId(entry.id);
    try {
      await apiClient.delete(`/api/production/packing-output-entries/${entry.id}/`);
      await refetchDetail();
      toast.success('Entry deleted.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete entry.');
    } finally {
      setDeletingOutputId(null);
    }
  };

  const handleDeleteInputEntry = async (entry) => {
    if (!(await confirm({ message: `Delete input entry of ${fmtQty(entry.quantity)} on ${fmtDate(entry.entry_date)}?`, isDangerous: true }))) return;
    setDeletingInputId(entry.id);
    try {
      await apiClient.delete(`/api/production/packing-input-entries/${entry.id}/`);
      await refetchDetail();
      toast.success('Entry deleted.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete entry.');
    } finally {
      setDeletingInputId(null);
    }
  };

  const handleMarkCompleted = async () => {
    if (!(await confirm({ message: 'Mark this Packing Process as Completed? You can reopen it later if needed.' }))) return;
    setIsToggling(true);
    try {
      const res = await apiClient.post(`/api/production/packing-processes/${id}/complete/`);
      setData(res.data);
      toast.success('Packing Process marked Completed.');
    } catch (err) {
      const body = err.response?.data;
      if (body?.target_output_quantity != null && body?.packed_total != null) {
        toast.error(
          `Required ${fmtQty(body.target_output_quantity)} — packed ${fmtQty(body.packed_total)} (pending ${fmtQty(body.pending)}).`,
        );
      } else if (body?.shortfall?.length) {
        const lines = body.shortfall.map((s) => `• ${s.product_name}: ${s.packed}/${s.required} (pending ${s.pending})`).join('\n');
        toast.error(`Required qty not yet packed:\n${lines}`);
      } else if (body?.pending_steps?.length) {
        const lines = body.pending_steps.map((s) => `• ${s.step}: ${s.done}/${s.target} (${s.balance} left)`).join('\n');
        toast.error(`Every step must be completed first:\n${lines}`);
      } else {
        toast.error(getApiErrorMessage(err) || 'Failed to mark Completed.');
      }
    } finally {
      setIsToggling(false);
    }
  };

  const handleReopen = async () => {
    if (!(await confirm({ message: 'Reopen this Packing Process so more daily entries can be added?' }))) return;
    setIsToggling(true);
    try {
      const res = await apiClient.post(`/api/production/packing-processes/${id}/reopen/`);
      setData(res.data);
      toast.success('Packing Process reopened.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to reopen.');
    } finally {
      setIsToggling(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete "${data.packing_no}"? This cannot be undone.`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/production/packing-processes/${id}/`);
      toast.success('Packing Process deleted.');
      navigate('/production/packing-processes');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  const handleApprove = async () => {
    if (!(await confirm({ message: `Approve "${data.packing_no}"?` }))) return;
    setIsApproving(true);
    try {
      const res = await apiClient.post(`/api/production/packing-processes/${id}/approve/`);
      setData(res.data);
      toast.success('Packing Process approved.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to approve.');
    } finally {
      setIsApproving(false);
    }
  };

  const handleReject = async () => {
    const remarks = await promptText({ title: 'Reject Packing Process', label: 'Reason for rejection', placeholder: 'Optional', multiline: true, confirmLabel: 'Reject', isDangerous: true });
    if (remarks === null) return; // user cancelled
    setIsApproving(true);
    try {
      const res = await apiClient.post(`/api/production/packing-processes/${id}/reject/`, {
        approval_remarks: remarks,
      });
      setData(res.data);
      toast.success('Packing Process rejected.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to reject.');
    } finally {
      setIsApproving(false);
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

  if (!data) return null;

  return (
    <MainLayout>
      {/* Print-only formatted document; on-screen UI below is hidden in print. */}
      <PackingProcessSheet data={data} />
      <div className="print:hidden">
      <PageHeader
        title={data.packing_no}
        subtitle={`${data.process_name || '-'}${data.batch_no ? ` · Batch ${data.batch_no}` : ''}`}
        breadcrumbs={[
          { label: 'Production', href: '/production' },
          { label: 'Packing Process', href: '/production/packing-processes' },
          { label: data.packing_no },
        ]}
      />

      <div className="flex flex-wrap justify-end items-center gap-2 mb-4">
        <span className="mr-auto inline-flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">Approval:</span>
          <StatusBadge status={data.approval_status} />
          {data.approved_by_name && data.approval_status !== 'PENDING' && (
            <span className="text-xs text-slate-400">
              by {data.approved_by_name}
            </span>
          )}
          {isTvpWarehouse && (
            <>
              <span className="text-slate-300 mx-1">|</span>
              <span className="text-slate-500">Progress:</span>
              <StatusBadge status={data.progress_status || 'IN_PROGRESS'} />
              {isCompleted && data.completed_at && (
                <span className="text-xs text-slate-400">on {fmtDate(data.completed_at)}</span>
              )}
            </>
          )}
        </span>
        {canPrint('Packing Process') && (
          <button type="button" onClick={() => window.print()} title="Print" aria-label="Print"
            className="inline-flex items-center gap-1 px-4 py-2 bg-violet-50 text-violet-700 rounded-lg text-sm font-medium hover:bg-violet-100 border border-violet-200">
            <Printer size={14} /> Print
          </button>
        )}
        {canApprove('Packing Process') && data.approval_status !== 'APPROVED' && (
          <button type="button" onClick={handleApprove} disabled={isApproving}
            className="inline-flex items-center gap-1 px-4 py-2 bg-emerald-50 text-emerald-700 rounded-lg text-sm font-medium hover:bg-emerald-100 border border-emerald-200 disabled:opacity-50">
            <Check size={14} /> {isApproving ? 'Approving…' : 'Approve'}
          </button>
        )}
        {/* Reject is only meaningful while the record is still PENDING.
            Once it's APPROVED it's locked; once REJECTED there's nothing
            more to reject. */}
        {canReject('Packing Process') && data.approval_status === 'PENDING' && (
          <button type="button" onClick={handleReject} disabled={isApproving}
            className="inline-flex items-center gap-1 px-4 py-2 bg-amber-50 text-amber-700 rounded-lg text-sm font-medium hover:bg-amber-100 border border-amber-200 disabled:opacity-50">
            <XIcon size={14} /> Reject
          </button>
        )}
        {/* Edit disappears the moment the record is APPROVED — it's been
            signed off and shouldn't drift. Rejected records stay editable
            so the user can correct them and resubmit. */}
        {canEdit('Packing Process') && data.approval_status !== 'APPROVED' && (
          <button type="button" onClick={() => navigate(`/production/packing-processes/${id}/edit`)}
            className="inline-flex items-center gap-1 px-4 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100 border border-blue-200">
            <Pencil size={14} /> Edit
          </button>
        )}
        {canDelete('Packing Process') && (
          <button type="button" onClick={handleDelete}
            className="inline-flex items-center gap-1 px-4 py-2 bg-red-50 text-red-700 rounded-lg text-sm font-medium hover:bg-red-100 border border-red-200">
            <Trash2 size={14} /> Delete
          </button>
        )}
      </div>

      {/* Header summary */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 mb-4">
        <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Details</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          {!isHidden('date') && (
          <div>
            <p className="text-xs text-slate-500">Date</p>
            <p className="font-medium text-slate-800">{fmtDate(data.date)}</p>
          </div>
          )}
          {!isHidden('production_date') && (
          <div>
            <p className="text-xs text-slate-500">Packing Date</p>
            <p className="font-medium text-slate-800">{fmtDate(data.production_date)}</p>
          </div>
          )}
          {!isHidden('company') && (
          <div>
            <p className="text-xs text-slate-500">Company</p>
            <p className="font-medium text-slate-800">{data.company_name || '-'}</p>
          </div>
          )}
          {!isHidden('warehouse') && (
          <div>
            <p className="text-xs text-slate-500">Warehouse</p>
            <p className="font-medium text-slate-800">{data.warehouse_name || data.warehouse_code || '-'}</p>
          </div>
          )}
          {!isHidden('process') && (
          <div>
            <p className="text-xs text-slate-500">Process</p>
            <p className="font-medium text-slate-800">{data.process_name || '-'}</p>
          </div>
          )}
          {!isHidden('batch_no') && (
          <div>
            <p className="text-xs text-slate-500">Batch No</p>
            <p className="font-medium text-slate-800">{data.batch_no || '-'}</p>
          </div>
          )}
          <div>
            <p className="text-xs text-slate-500">Wage Type</p>
            <p className="font-medium text-slate-800">
              {data.wage_type === 'HEAD_COUNT'
                ? 'Head Count'
                : data.wage_type === 'PACKING_GROUP' ? 'Packing Group' : '-'}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Total Packing Material Qty</p>
            <p className="font-medium text-emerald-700">{fmtQty(data.total_packing_material_qty)}</p>
          </div>
          {targetOutputQty > 0 && !isHidden('target_output_quantity') && (
            <div>
              <p className="text-xs text-slate-500">Target Output Qty</p>
              <p className="font-medium text-indigo-700">{fmtQty(targetOutputQty)}</p>
            </div>
          )}
          {!isHidden('damage_or_process_loss') && (
          <div>
            <p className="text-xs text-slate-500">Damage / Process Loss</p>
            <p className="font-medium text-slate-800">{data.damage_or_process_loss ? 'Yes' : 'No'}</p>
          </div>
          )}
        </div>

        {/* Header-level packing progress strip (only when a target is set) */}
        {targetOutputQty > 0 && (
          <div className="mt-4 pt-4 border-t">
            <div className="flex items-baseline justify-between mb-1 text-sm">
              <span className="text-slate-500">Packed so far</span>
              <span className={`font-semibold ${totalPacked >= targetOutputQty ? 'text-emerald-700' : 'text-indigo-700'}`}>
                {fmtQty(totalPacked)} / {fmtQty(targetOutputQty)}
              </span>
            </div>
            <div className="h-2 bg-slate-200 rounded">
              <div
                className={`h-2 rounded ${totalPacked >= targetOutputQty ? 'bg-emerald-500' : 'bg-indigo-500'}`}
                style={{ width: `${Math.min(100, (totalPacked / targetOutputQty) * 100)}%` }}
              />
            </div>
            {totalPacked < targetOutputQty && (
              <p className="mt-1 text-xs text-slate-500">
                Pending: {fmtQty(targetOutputQty - totalPacked)}
              </p>
            )}
          </div>
        )}

        {stepLabels.length > 0 && !isHidden('packing_steps') && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-xs text-slate-500 mb-2">Selected Process Steps</p>
            <div className="flex flex-wrap gap-2">
              {stepLabels.map((s) => (
                <span key={s} className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium">{s}</span>
              ))}
            </div>
          </div>
        )}

        {data.remarks && !isHidden('remarks') && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-xs text-slate-500 mb-1">Remarks</p>
            <p className="text-sm text-slate-700 whitespace-pre-wrap">{data.remarks}</p>
          </div>
        )}
      </div>

      {/* Process Step Progress — TVP per-step tracking. Each step targets the
          run's Target Output Quantity. Progress is recorded as additive
          entries (several steps at once); each qty adds to the running total.
          The run can only be Completed once every step hits 0 balance. */}
      {isTvpWarehouse && hasStepProgress && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 mb-4">
          <div className="flex flex-wrap items-center gap-2 mb-4 pb-2 border-b">
            <CheckCircle2 size={18} className="text-indigo-600" />
            <h3 className="text-lg font-semibold text-slate-800">Process Step Progress</h3>
            <span className="text-xs text-slate-400">target {fmtQty(targetOutputQty)} each</span>
            {stepsAllComplete && (
              <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-1 rounded">
                <CheckCircle2 size={13} /> All steps complete
              </span>
            )}
          </div>

          {/* Per-step running totals */}
          <div className="space-y-2 mb-5">
            {stepProgress.map((sp) => {
              const done = num(sp.done);
              const target = num(sp.target);
              const balance = num(sp.balance);
              const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
              return (
                <div key={sp.step} className="flex flex-wrap items-center gap-3">
                  <div className="min-w-[130px]">
                    <p className="text-sm font-medium text-slate-800">{sp.label}</p>
                    <p className="text-xs text-slate-500">{fmtQty(done)}/{fmtQty(target)} done{balance > 0 ? ` · ${fmtQty(balance)} left` : ''}</p>
                  </div>
                  <div className="flex-1 min-w-[120px] h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className={`h-full ${sp.complete ? 'bg-emerald-500' : 'bg-indigo-500'}`} style={{ width: `${pct}%` }} />
                  </div>
                  {sp.complete && <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><CheckCircle2 size={13} /> Done</span>}
                </div>
              );
            })}
          </div>

          {/* Add a progress entry — several steps at once, additive */}
          {!isCompleted && canEdit('Packing Process') && !stepsAllComplete && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-4">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Entry date</label>
                  <input type="date" value={entryForm.entry_date}
                    onChange={(e) => setEntryForm((p) => ({ ...p, entry_date: e.target.value }))}
                    className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm" />
                </div>
                {stepProgress.filter((sp) => !sp.complete).map((sp) => (
                  <div key={sp.step}>
                    <label className="block text-xs font-medium text-slate-600 mb-1">{sp.label} <span className="text-slate-400">({fmtQty(num(sp.balance))} left)</span></label>
                    <input type="number" min="0" max={num(sp.balance)} step="0.0001"
                      value={entryForm.qty[sp.step] ?? ''}
                      onChange={(e) => setEntryForm((p) => ({ ...p, qty: { ...p.qty, [sp.step]: e.target.value } }))}
                      placeholder="0"
                      className="w-24 px-2 py-1.5 border border-slate-300 rounded-lg text-sm text-right" />
                  </div>
                ))}
                <div className="flex-1 min-w-[140px]">
                  <label className="block text-xs font-medium text-slate-600 mb-1">Remarks</label>
                  <input type="text" value={entryForm.remarks}
                    onChange={(e) => setEntryForm((p) => ({ ...p, remarks: e.target.value }))}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-lg text-sm" />
                </div>
                <button type="button" onClick={addStepEntry} disabled={savingEntry}
                  className="px-4 py-1.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                  {savingEntry ? 'Saving…' : 'Add Entry'}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-2">Enter what was done this time for each step — quantities add to the running totals (capped at the target). “Mark Completed” unlocks once every step reaches its target.</p>
            </div>
          )}
          {!isCompleted && stepsAllComplete && (
            <p className="text-sm text-emerald-700 font-medium">All steps complete — you can now mark this run Completed below.</p>
          )}

          {/* Entry history (undo) */}
          {stepEntries.length > 0 && (
            <div className="mt-5">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Progress entries ({stepEntries.length})</p>
              <div className="space-y-1.5">
                {stepEntries.map((en) => (
                  <div key={en.id} className="flex flex-wrap items-center gap-2 text-sm border border-slate-100 rounded-lg px-3 py-2">
                    <span className="text-slate-500 min-w-[92px]">{fmtDate(en.entry_date)}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {en.lines.map((ln) => (
                        <span key={ln.id} className="px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded text-xs font-medium">{ln.label} +{fmtQty(ln.quantity)}</span>
                      ))}
                    </div>
                    {en.remarks && <span className="text-xs text-slate-400 italic">“{en.remarks}”</span>}
                    {en.recorded_by_name && <span className="text-xs text-slate-400 ml-auto">{en.recorded_by_name}</span>}
                    {!isCompleted && canEdit('Packing Process') && (
                      <button type="button" onClick={() => deleteStepEntry(en.id)} disabled={deletingEntryId === en.id}
                        title="Undo this entry" className={`p-1 text-red-400 hover:text-red-600 disabled:opacity-40 ${en.recorded_by_name ? '' : 'ml-auto'}`}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Input Products */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 mb-4">
        <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">
          Input Products <span className="text-xs text-slate-400 font-normal">{(data.input_products || []).length} item(s)</span>
        </h3>
        {(data.input_products || []).length === 0 ? (
          <p className="text-sm text-slate-400 italic">No input rows.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: '700px' }}>
              <thead>
                <tr className="bg-slate-50 border-b">
                  <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                  {!isInHidden('product') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Product</th>}
                  {!isInHidden('uom') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Unit</th>}
                  {!isInHidden('stock_available') && <th className="px-2 py-2 text-right font-semibold text-slate-600">Stock</th>}
                  {!isInHidden('input_qty') && <th className="px-2 py-2 text-right font-semibold text-emerald-700">Input Qty</th>}
                </tr>
              </thead>
              <tbody>
                {data.input_products.map((row, idx) => (
                  <tr key={row.id || idx} className="border-b">
                    <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                    {!isInHidden('product') && <td className="px-2 py-2 text-slate-800 font-medium">{row.product_name || '-'}</td>}
                    {!isInHidden('uom') && <td className="px-2 py-2 text-slate-700">{row.uom || '-'}</td>}
                    {!isInHidden('stock_available') && <td className="px-2 py-2 text-right text-slate-700">{fmtQty(row.stock_available)}</td>}
                    {!isInHidden('input_qty') && <td className="px-2 py-2 text-right font-semibold text-emerald-700">{fmtQty(row.input_qty)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Output Products */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 mb-4">
        <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">
          Output Products <span className="text-xs text-slate-400 font-normal">{(data.output_products || []).length} item(s)</span>
        </h3>
        {(data.output_products || []).length === 0 ? (
          <p className="text-sm text-slate-400 italic">No output rows.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: '700px' }}>
              <thead>
                <tr className="bg-slate-50 border-b">
                  <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                  {!isOutHidden('product') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Output Product</th>}
                  {!isOutHidden('uom') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Unit</th>}
                  {!isOutHidden('stock_available') && <th className="px-2 py-2 text-right font-semibold text-slate-600">Stock</th>}
                  {!isOutHidden('output_qty') && <th className="px-2 py-2 text-right font-semibold text-emerald-700">Output Qty</th>}
                </tr>
              </thead>
              <tbody>
                {data.output_products.map((row, idx) => (
                  <tr key={row.id || idx} className="border-b">
                    <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                    {!isOutHidden('product') && <td className="px-2 py-2 text-slate-800 font-medium">{row.product_name || '-'}</td>}
                    {!isOutHidden('uom') && <td className="px-2 py-2 text-slate-700">{row.uom || '-'}</td>}
                    {!isOutHidden('stock_available') && <td className="px-2 py-2 text-right text-slate-700">{fmtQty(row.stock_available)}</td>}
                    {!isOutHidden('output_qty') && <td className="px-2 py-2 text-right font-semibold text-emerald-700">{fmtQty(row.output_qty)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Multi-day packing — call-to-action when the target is reached
          but the run hasn't been marked Completed yet. */}
      {isTvpWarehouse && !isCompleted && !hasStepProgress && fullyPacked && canClose('Packing Process')
        && outputProducts.length > 0 && inputProducts.length > 0 && (
        <div className="bg-emerald-50 border-2 border-emerald-200 rounded-lg p-4 mb-4 flex flex-wrap items-center gap-3">
          <CheckCircle2 size={18} className="text-emerald-700" />
          <p className="text-sm text-emerald-800 font-medium">
            Target output quantity reached — no more daily entries needed.
            Click <span className="font-semibold">Mark Completed</span> below to finalize this run.
          </p>
          <button type="button" onClick={handleMarkCompleted} disabled={isToggling}
            className="ml-auto inline-flex items-center gap-1 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
            <CheckCircle2 size={14} /> {isToggling ? 'Saving…' : 'Mark Completed'}
          </button>
        </div>
      )}

      {/* Multi-day packing — Add Daily Entry (combined output + inputs).
          Hidden once the run is Completed OR once the target output qty
          is reached (no more daily entries should be added). */}
      {isTvpWarehouse && !isCompleted && !fullyPacked && canEdit('Packing Process')
        && outputProducts.length > 0 && inputProducts.length > 0 && (
        <div className="bg-white rounded-lg border-2 border-indigo-200 p-4 sm:p-5 mb-4">
          <div className="flex items-center gap-2 mb-4 pb-2 border-b">
            <Plus size={18} className="text-indigo-600" />
            <h3 className="text-lg font-semibold text-slate-800">Add Daily Entry</h3>
            <span className="text-xs text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-full">
              Output + materials are recorded together
            </span>
          </div>

          <form onSubmit={handleAddDailyEntry} className="space-y-4">
            {/* Top row: shared Date + Stage + Remarks */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Date <span className="text-red-500">*</span></label>
                <CustomDatePicker
                  value={dailyForm.entry_date}
                  onChange={(e) => setDailyForm((p) => ({ ...p, entry_date: e.target.value }))}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Stage</label>
                <CustomSelect
                  value={dailyForm.stage}
                  onChange={(e) => setDailyForm((p) => ({ ...p, stage: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="">—</option>
                  {PACKING_STEPS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </CustomSelect>
              </div>
              <div className="col-span-2 md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">Remarks</label>
                <input
                  type="text"
                  value={dailyForm.remarks}
                  onChange={(e) => setDailyForm((p) => ({ ...p, remarks: e.target.value }))}
                  placeholder="optional"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
            </div>

            {/* Output picked today */}
            <div className="bg-emerald-50/50 border border-emerald-100 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <Package size={14} className="text-emerald-700" />
                <span className="text-sm font-semibold text-emerald-800">Output Packed Today</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div className="col-span-2 md:col-span-2">
                  <label className="block text-xs font-medium text-slate-600 mb-1">Output Product <span className="text-red-500">*</span></label>
                  <CustomSelect
                    value={dailyForm.output_product}
                    onChange={(e) => setDailyForm((p) => ({ ...p, output_product: e.target.value }))}
                    required
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="">Select…</option>
                    {outputProducts.map((op) => {
                      // Prefer header target progress when a target is set —
                      // the planning output_qty already counts toward it,
                      // so per-product "pending" against output_qty is the
                      // wrong number for the user to chase.
                      const label = targetOutputQty > 0
                        ? `${op.product_name} (initial ${fmtQty(op.output_qty)} ${op.uom}, pending ${fmtQty(headerPending)} toward target ${fmtQty(targetOutputQty)})`
                        : `${op.product_name} (target ${fmtQty(op.output_qty)} ${op.uom}, pending ${fmtQty(op.pending)})`;
                      return (
                        <option key={op.id} value={op.id}>{label}</option>
                      );
                    })}
                  </CustomSelect>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Qty Packed <span className="text-red-500">*</span></label>
                  <input
                    type="number" min="0" step="0.0001"
                    value={dailyForm.output_quantity}
                    onChange={(e) => setDailyForm((p) => ({ ...p, output_quantity: e.target.value }))}
                    required
                    placeholder="0.00"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-right focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
              </div>
            </div>

            {/* Materials drawn today — one fixed row per planned input
                product. Product names aren't selectable; the user just
                types today's qty for whichever materials were actually
                drawn. Leave a row blank/zero to skip it. */}
            <div className="bg-orange-50/50 border border-orange-100 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <FileText size={14} className="text-orange-700" />
                <span className="text-sm font-semibold text-orange-800">Materials Used Today <span className="text-red-500">*</span></span>
                <span className="text-xs text-orange-600">enter qty for each material drawn — leave blank to skip</span>
              </div>
              {dailyForm.inputs.length === 0 && dailyForm.new_inputs.length === 0 ? (
                <p className="text-sm text-slate-500 italic">No planned input products on this packing process.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" style={{ minWidth: '720px' }}>
                    <thead>
                      <tr className="bg-orange-100/40 border-b border-orange-200">
                        <th className="px-2 py-2 text-left font-semibold text-orange-900 w-10">#</th>
                        <th className="px-2 py-2 text-left font-semibold text-orange-900">Category</th>
                        <th className="px-2 py-2 text-left font-semibold text-orange-900">Input Product</th>
                        <th className="px-2 py-2 text-left font-semibold text-orange-900">Unit</th>
                        <th className="px-2 py-2 text-right font-semibold text-orange-900" title="Planned quantity of this material to use">Used</th>
                        <th className="px-2 py-2 text-right font-semibold text-orange-900">Qty Used Today</th>
                        <th className="px-2 py-2 w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Planning-locked rows */}
                      {dailyForm.inputs.map((row, idx) => (
                        <tr key={row.input_product || idx} className="border-b border-orange-100">
                          <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                          <td className="px-2 py-2 text-slate-700">{catLabel(row.product_category)}</td>
                          <td className="px-2 py-2 text-slate-800 font-medium">{row.product_name || '-'}</td>
                          <td className="px-2 py-2 text-slate-700">{row.uom || '-'}</td>
                          <td className="px-2 py-2 text-right text-slate-700">{fmtQty(row.planned_qty)}</td>
                          <td className="px-2 py-2">
                            <input
                              type="number" min="0" step="0.0001"
                              value={row.quantity}
                              onChange={(e) => updateInputQty(idx, e.target.value)}
                              placeholder="0.00"
                              className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-right focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                              style={{ minWidth: '110px' }}
                            />
                          </td>
                          <td className="px-2 py-2"></td>
                        </tr>
                      ))}
                      {/* Ad-hoc additions — product is user-selectable */}
                      {dailyForm.new_inputs.map((row, idx) => {
                        const product = (allProducts || []).find((p) => p.id === row.product);
                        // Hide already-picked ad-hoc products from this
                        // row's dropdown so the user can't double-select.
                        const otherPickedIds = new Set(
                          dailyForm.new_inputs.map((r, j) => (j !== idx ? r.product : null)).filter(Boolean),
                        );
                        // Narrow the picker by the per-row category filter.
                        // Comparison is trim + uppercase to absorb any
                        // case/whitespace drift in the master's
                        // `goods_sub_type` values.
                        const normalize = (v) => String(v ?? '').trim().toUpperCase();
                        const rowCat = normalize(row.category);
                        const visibleProducts = adhocProductOptions
                          .filter((p) => !otherPickedIds.has(p.id))
                          .filter((p) => !rowCat || normalize(p.goods_sub_type) === rowCat);
                        return (
                          <tr key={`new-${idx}`} className="border-b border-orange-100 bg-orange-50/40">
                            <td className="px-2 py-2 font-mono text-slate-400">
                              {dailyForm.inputs.length + idx + 1}
                            </td>
                            <td className="px-2 py-2">
                              <CustomSelect
                                value={row.category || ''}
                                onChange={(e) => {
                                  const cat = e.target.value;
                                  // If the currently-picked product no longer
                                  // matches the new category, drop the pick so
                                  // the user can re-select.
                                  const stillValid = !cat || (product && product.goods_sub_type === cat);
                                  updateNewInputRow(idx, {
                                    category: cat,
                                    product: stillValid ? row.product : '',
                                  });
                                }}
                                className="w-full px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                                style={{ minWidth: '140px' }}
                              >
                                <option value="">Pick category…</option>
                                {Object.entries(PRODUCT_CATEGORY_LABEL).map(([v, lbl]) => (
                                  <option key={v} value={v}>{lbl}</option>
                                ))}
                              </CustomSelect>
                            </td>
                            <td className="px-2 py-2">
                              <CustomSelect
                                value={row.product}
                                onChange={(e) => {
                                  const productId = e.target.value;
                                  const picked = (allProducts || []).find((p) => p.id === productId);
                                  // Stamp the category from the picked
                                  // product when the row hasn't set one
                                  // yet, so the strict filter below has
                                  // something to narrow against on the
                                  // next render. Without this, the picker
                                  // would keep showing every product.
                                  updateNewInputRow(idx, {
                                    product: productId,
                                    category: row.category || picked?.goods_sub_type || '',
                                  });
                                }}
                                disabled={!row.category}
                                className="w-full px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
                                style={{ minWidth: '200px' }}
                              >
                                <option value="">
                                  {!row.category
                                    ? 'Pick a category first…'
                                    : visibleProducts.length === 0
                                      ? 'No products in this category'
                                      : 'Pick a product…'}
                                </option>
                                {row.category && visibleProducts.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {(p.product_name || p.sku_code || p.id)}
                                    {p.goods_sub_type ? ` — ${catLabel(p.goods_sub_type)}` : ''}
                                  </option>
                                ))}
                              </CustomSelect>
                            </td>
                            <td className="px-2 py-2 text-slate-700">{product?.uom || '-'}</td>
                            <td className="px-2 py-2 text-right text-slate-400 italic">ad-hoc</td>
                            <td className="px-2 py-2">
                              <input
                                type="number" min="0" step="0.0001"
                                value={row.quantity}
                                onChange={(e) => updateNewInputRow(idx, { quantity: e.target.value })}
                                placeholder="0.00"
                                className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-right focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                                style={{ minWidth: '110px' }}
                              />
                            </td>
                            <td className="px-2 py-2">
                              <button type="button" onClick={() => removeNewInputRow(idx)}
                                aria-label="Remove"
                                className="p-1.5 text-red-500 hover:bg-red-50 rounded"
                                title="Remove">
                                <Trash2 size={14} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Add another material — for products outside the original plan */}
              <div className="mt-3 flex items-center justify-between">
                <p className="text-xs text-slate-500 italic">
                  Need a material that wasn't on the original plan? Add it here — a new planning row is created automatically.
                </p>
                <button
                  type="button"
                  onClick={addNewInputRow}
                  disabled={adhocProductOptions.length === 0}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-orange-100 text-orange-700 rounded text-xs font-medium hover:bg-orange-200 border border-orange-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={adhocProductOptions.length === 0 ? 'No other products available' : 'Add a product not on the plan'}
                >
                  <Plus size={12} /> Add Material
                </button>
              </div>
            </div>

            <div className="flex justify-end">
              <button type="submit" disabled={isSavingEntry}
                className="px-4 sm:px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                {isSavingEntry ? 'Saving…' : 'Save Daily Entry'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Multi-day packing — Output Entries (TVP-only) */}
      {isTvpWarehouse && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 mb-4">
          <div className="flex flex-wrap items-center gap-2 mb-4 pb-2 border-b">
            <Package size={18} className="text-emerald-600" />
            <h3 className="text-lg font-semibold text-slate-800">Output Entries (Date-wise)</h3>
            <span className="text-xs text-slate-400">{allOutputEntries.length} entry(ies)</span>
            {canClose('Packing Process') && (
              <div className="ml-auto flex flex-wrap gap-2">
                {!isCompleted && (
                  <button type="button" onClick={handleMarkCompleted}
                    disabled={isToggling || !canComplete}
                    title={canComplete ? 'Mark Completed' : (hasStepProgress ? 'Every process step must reach its target first.' : 'Total packed qty has not yet matched the required qty.')}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg text-sm font-medium hover:bg-emerald-100 border border-emerald-200 disabled:opacity-50 disabled:cursor-not-allowed">
                    <CheckCircle2 size={14} /> {isToggling ? 'Saving…' : 'Mark Completed'}
                  </button>
                )}
                {isCompleted && (
                  <button type="button" onClick={handleReopen} disabled={isToggling}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-amber-50 text-amber-700 rounded-lg text-sm font-medium hover:bg-amber-100 border border-amber-200 disabled:opacity-50">
                    <RefreshCcw size={14} /> {isToggling ? 'Saving…' : 'Reopen'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Per-product progress strip — shows the row's contribution to
              the header target. The planning output_qty already counts
              as packed; daily entries add more. */}
          {outputProducts.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-2 gap-3 mb-4 text-sm">
              {outputProducts.map((op) => {
                const initial = num(op.output_qty);
                const daily = num(op.total_packed); // sum of entries
                const productTotal = initial + daily;
                return (
                  <div key={op.id} className="px-3 py-2 rounded-lg border border-slate-200 bg-slate-50">
                    <div className="flex items-baseline justify-between">
                      <span className="font-medium text-slate-800">{op.product_name || '-'}</span>
                      <span className="text-xs font-semibold text-slate-700">
                        {fmtQty(productTotal)} {op.uom || ''} contributed
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      Initial {fmtQty(initial)} + Daily {fmtQty(daily)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {isCompleted && (
            <p className="text-xs text-slate-500 italic mb-3">
              Packing Completed. Reopen to add or remove entries.
            </p>
          )}

          {allOutputEntries.length === 0 ? (
            <p className="text-sm text-slate-400 italic">No output entries yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '800px' }}>
                <thead>
                  <tr className="bg-slate-50 border-b">
                    <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Date</th>
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Output Product</th>
                    <th className="px-2 py-2 text-right font-semibold text-emerald-700">Qty Packed</th>
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Unit</th>
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Stage</th>
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Remarks</th>
                    {!isCompleted && canEdit('Packing Process') && <th className="px-2 py-2 w-10"></th>}
                  </tr>
                </thead>
                <tbody>
                  {allOutputEntries.map((entry, idx) => (
                    <tr key={entry.id} className="border-b">
                      <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                      <td className="px-2 py-2 text-slate-800">{fmtDate(entry.entry_date)}</td>
                      <td className="px-2 py-2 text-slate-800 font-medium">{entry._product_name || '-'}</td>
                      <td className="px-2 py-2 text-right font-semibold text-emerald-700">{fmtQty(entry.quantity)}</td>
                      <td className="px-2 py-2 text-slate-700">{entry._product_uom || '-'}</td>
                      <td className="px-2 py-2 text-slate-700">
                        {PACKING_STEPS.find((s) => s.value === entry.stage)?.label || '-'}
                      </td>
                      <td className="px-2 py-2 text-slate-700">{entry.remarks || '-'}</td>
                      {!isCompleted && canEdit('Packing Process') && (
                        <td className="px-2 py-2">
                          <button type="button" onClick={() => handleDeleteOutputEntry(entry)}
                            disabled={deletingOutputId === entry.id}
                            aria-label="Delete entry" title="Delete entry"
                            className="p-1.5 text-red-500 hover:bg-red-50 rounded disabled:opacity-50">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Multi-day packing — Input Entries (TVP-only) */}
      {isTvpWarehouse && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 mb-4">
          <div className="flex flex-wrap items-center gap-2 mb-4 pb-2 border-b">
            <FileText size={18} className="text-orange-600" />
            <h3 className="text-lg font-semibold text-slate-800">Input Entries (Material Draws)</h3>
            <span className="text-xs text-slate-400">{allInputEntries.length} entry(ies)</span>
          </div>

          <p className="text-xs text-slate-500 mb-3 italic">
            Each row is a discrete material draw — when inventory integration goes live, each entry will deduct its own quantity from stock (no re-summing).
          </p>

          {allInputEntries.length === 0 ? (
            <p className="text-sm text-slate-400 italic">No input entries yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '800px' }}>
                <thead>
                  <tr className="bg-slate-50 border-b">
                    <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Date</th>
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Input Product</th>
                    <th className="px-2 py-2 text-right font-semibold text-orange-700">Qty Used</th>
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Unit</th>
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Stage</th>
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Remarks</th>
                    {!isCompleted && canEdit('Packing Process') && <th className="px-2 py-2 w-10"></th>}
                  </tr>
                </thead>
                <tbody>
                  {allInputEntries.map((entry, idx) => (
                    <tr key={entry.id} className="border-b">
                      <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                      <td className="px-2 py-2 text-slate-800">{fmtDate(entry.entry_date)}</td>
                      <td className="px-2 py-2 text-slate-800 font-medium">{entry._product_name || '-'}</td>
                      <td className="px-2 py-2 text-right font-semibold text-orange-700">{fmtQty(entry.quantity)}</td>
                      <td className="px-2 py-2 text-slate-700">{entry._product_uom || '-'}</td>
                      <td className="px-2 py-2 text-slate-700">
                        {PACKING_STEPS.find((s) => s.value === entry.stage)?.label || '-'}
                      </td>
                      <td className="px-2 py-2 text-slate-700">{entry.remarks || '-'}</td>
                      {!isCompleted && canEdit('Packing Process') && (
                        <td className="px-2 py-2">
                          <button type="button" onClick={() => handleDeleteInputEntry(entry)}
                            disabled={deletingInputId === entry.id}
                            aria-label="Delete entry" title="Delete entry"
                            className="p-1.5 text-red-500 hover:bg-red-50 rounded disabled:opacity-50">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Attachments */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 mb-4">
        <div className="flex items-center gap-2 mb-4 pb-2 border-b">
          <Paperclip size={18} className="text-slate-600" />
          <h3 className="text-lg font-semibold text-slate-800">Attachments</h3>
          <span className="text-xs text-slate-400">{attachments.length} file(s)</span>
        </div>
        {attachments.length === 0 ? (
          <p className="text-sm text-slate-400 italic">No files attached.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <Paperclip size={14} className="text-slate-400 flex-shrink-0" />
                <span className="flex-1 truncate text-slate-700">{a.file_name}</span>
                <span className="text-xs text-slate-400">{fmtBytes(a.file_size)}</span>
                <a href={a.file} target="_blank" rel="noreferrer"
                  className="p-1 text-blue-600 hover:bg-blue-50 rounded" title="Download">
                  <Download size={14} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      </div>
    </MainLayout>
  );
}

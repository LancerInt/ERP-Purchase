import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const inputDisabled = 'disabled:bg-slate-100 disabled:cursor-not-allowed';
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

const emptyLine = {
  category: '',
  godown: '',
  division: '',     // machine-spares filter only (not persisted — the product carries it)
  product: '',
  batch: '',
  available_stock: '',
  uom: '',
  issue_qty: '',
  expected_return_qty: '',
  rate: '',
  amount: '',
  remarks: '',
};

// Product goods sub-types (mirrors master.Product.GOODS_SUB_TYPE_CHOICES) —
// used to filter the per-line Product dropdown by category.
const GOODS_CATEGORIES = [
  ['RAW_MATERIAL', 'Raw Material'],
  ['PACKING_MATERIAL', 'Packing Material'],
  ['FINISHED_GOOD', 'Finished Good'],
  ['SEMI_FINISHED', 'Semi Finished'],
  ['TRADED_PRODUCTS', 'Traded Products'],
  ['CAPITAL_GOOD', 'Capital Good'],
  ['MACHINE_SPARES', 'Machine Spares'],
  ['CONSUMABLES', 'Consumables'],
];

export default function CreateJobWork() {
  const navigate = useNavigate();
  const { isHidden, isReadOnly } = useFieldPermissions('Job Work Order');
  const { canCreate } = usePermissions();
  const editable = canCreate('Job Work Order');
  const todayIso = new Date().toISOString().split('T')[0];
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: vendors } = useLookup('/api/vendors/');
  const { options: transporters } = useLookup('/api/transporters/');
  const { raw: productsRaw } = useLookup('/api/products/');

  const [isLoading, setIsLoading] = useState(false);
  // Preview-only Job Work No — backend returns the next sequence it
  // would use if the form were saved right now. Purely a UI affordance;
  // the real number is assigned by the model's save().
  const [nextOrderNo, setNextOrderNo] = useState('');
  useEffect(() => {
    apiClient.get('/api/inventory/job-work/next-no/')
      .then(r => setNextOrderNo(r.data?.next_no || ''))
      .catch(() => {});
  }, []);

  const [formData, setFormData] = useState({
    // Header
    company: '',
    vendor: '',
    warehouse: '',
    job_work_date: todayIso,
    start_date: todayIso,           // backend's "Issue Date" field
    expected_completion_date: '',
    job_work_type: '',
    reference_no: '',
    priority: 'MEDIUM',
    status: 'DRAFT',
    qc_requirement: 'REQUIRED',
    // Logistics
    transporter: '',
    vehicle_no: '',
    lr_no: '',
    // Costs
    freight_charges: '',
    loading_charges: '',
    vendor_processing_charges: '',
    // Notes
    remarks: '',
  });
  const [lines, setLines] = useState([{ ...emptyLine }]);
  const [stockProducts, setStockProducts] = useState([]);   // products with stock in the chosen warehouse

  const { options: warehouses } = useLookup(
    formData.company ? `/api/warehouses/?company=${formData.company}&scope=true` : null
  );
  const { options: godownOptions } = useLookup(
    formData.warehouse ? `/api/godowns/?warehouse=${formData.warehouse}` : null
  );

  // The Product picker lists products that actually HAVE STOCK in the chosen
  // warehouse (from product-summary) — not the master's warehouse tag, which
  // doesn't reflect where stock physically sits. Joined with the product master
  // (productsRaw) so each in-stock row carries its category + machinery
  // classification (godown / division). Machine spares are catalogued under a
  // godown + division; goods carry neither.
  const productMasterById = useMemo(() => {
    const m = {};
    (productsRaw || []).forEach(p => { m[String(p.id)] = p; });
    return m;
  }, [productsRaw]);

  const stockWithMaster = useMemo(() => (
    (stockProducts || [])
      .filter(sp => Number(sp.total_qty) > 0)
      .map(sp => {
        const pm = productMasterById[String(sp.product)] || {};
        return {
          product: String(sp.product),
          sku: sp.product_sku || '',
          name: sp.product_name || '',
          category: pm.goods_sub_type || '',
          godown: pm.godown ? String(pm.godown) : '',
          godown_name: pm.godown_name || '',
          division: pm.division ? String(pm.division) : '',
          division_name: pm.division_name || '',
        };
      })
  ), [stockProducts, productMasterById]);

  const isMachineSpares = (cat) => cat === 'MACHINE_SPARES';

  // Machine spares come from the master CATALOGUE, not the stock rollup: they're
  // issued for machine service and legitimately carry zero tracked stock, so a
  // stock gate would hide them all. They're catalogued under a godown +
  // division, which drives the cascade. (Everything else stays stock-gated —
  // you can only issue goods you actually hold.)
  const spareMaster = useMemo(() => (
    (productsRaw || [])
      .filter(p => p.goods_sub_type === 'MACHINE_SPARES')
      .map(p => ({
        product: String(p.id),
        sku: p.sku_code || '',
        name: p.product_name || '',
        godown: p.godown ? String(p.godown) : '',
        godown_name: p.godown_name || '',
        division: p.division ? String(p.division) : '',
        division_name: p.division_name || '',
      }))
  ), [productsRaw]);

  const dedupeOptions = (rows, valueKey, labelKey) => {
    const seen = new Map();
    rows.forEach(r => { if (r[valueKey] && !seen.has(r[valueKey])) seen.set(r[valueKey], r[labelKey] || r[valueKey]); });
    return [...seen].map(([value, label]) => ({ value, label }));
  };

  // For a Machine-Spares line: Godown → Division → Product all come off the
  // spare catalogue. For any other category the master has no godown, so the
  // line keeps the plain warehouse-godown picker (a stock-location pick) and
  // Division is not applicable.
  const lineGodownOptions = (line) => (
    isMachineSpares(line.category)
      ? dedupeOptions(spareMaster, 'godown', 'godown_name')
      : godownOptions
  );

  const lineDivisionOptions = (line) => (
    isMachineSpares(line.category)
      ? dedupeOptions(
          spareMaster.filter(sp => !line.godown || sp.godown === line.godown),
          'division', 'division_name')
      : []
  );

  const lineProductOptions = (line) => {
    const rows = isMachineSpares(line.category)
      ? spareMaster
          .filter(sp => !line.godown || sp.godown === line.godown)
          .filter(sp => !line.division || sp.division === line.division)
      : stockWithMaster.filter(sp => !line.category || sp.category === line.category);
    return rows.map(sp => ({ value: sp.product, label: `${sp.sku ? sp.sku + ' — ' : ''}${sp.name}` }));
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const updateLine = (idx, field, value) => {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const next = { ...l, [field]: value };
      if (field === 'issue_qty' || field === 'rate') {
        const qty = parseFloat(field === 'issue_qty' ? value : next.issue_qty) || 0;
        const rate = parseFloat(field === 'rate' ? value : next.rate) || 0;
        const amt = qty * rate;
        next.amount = amt ? amt.toFixed(2) : '';
      }
      return next;
    }));
  };

  const onProductChange = (idx, productId) => {
    const product = productsRaw.find(p => String(p.id) === String(productId));
    setLines(prev => prev.map((l, i) => i === idx ? {
      ...l,
      product: productId,
      uom: product?.uom || l.uom || '',
      available_stock: '',
    } : l));
  };

  // Changing a line's Category rebuilds its Godown/Division/Product cascade —
  // clear all three so a now-invalid pick can't linger.
  const onCategoryChange = (idx, category) => {
    setLines(prev => prev.map((l, i) => i === idx
      ? { ...l, category, godown: '', division: '', product: '', available_stock: '' }
      : l));
  };

  // Godown drives Division + Product for machine spares (both are godown-scoped);
  // for other categories it's only the stock-location, so the product stays put.
  const onGodownChange = (idx, godownId) => {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      return isMachineSpares(l.category)
        ? { ...l, godown: godownId, division: '', product: '', available_stock: '' }
        : { ...l, godown: godownId, available_stock: '' };
    }));
  };

  const onDivisionChange = (idx, divisionId) => {
    setLines(prev => prev.map((l, i) => i === idx
      ? { ...l, division: divisionId, product: '', available_stock: '' }
      : l));
  };

  // Products available to issue = those that have stock in the chosen
  // warehouse. Refetched whenever the warehouse changes.
  useEffect(() => {
    if (!formData.warehouse) { setStockProducts([]); return; }
    apiClient.get('/api/inventory/stock-ledger/product-summary/', { params: { warehouse: formData.warehouse } })
      .then(res => setStockProducts(Array.isArray(res.data) ? res.data : (res.data?.results || [])))
      .catch(() => setStockProducts([]));
  }, [formData.warehouse]);

  // Fetch available stock per line whenever (warehouse, per-line godown,
  // product, batch) changes. Reads from the existing stock-balance
  // endpoint; doesn't post anything to the ledger.
  useEffect(() => {
    const wh = formData.warehouse;
    if (!wh) return;
    lines.forEach((l, idx) => {
      if (!l.product) return;
      const params = new URLSearchParams({ warehouse: wh, product: l.product });
      if (l.godown) params.set('godown', l.godown);
      params.set('batch', l.batch || '');
      apiClient.get(`/api/inventory/stock-ledger/stock-balance/?${params.toString()}`)
        .then(res => {
          const balance = res.data?.balance ?? '0';
          setLines(prev => prev.map((row, i) => (
            i === idx && row.product === l.product && (row.batch || '') === (l.batch || '')
              ? { ...row, available_stock: balance }
              : row
          )));
        })
        .catch((err) => {
          console.error('[stock-balance]', err?.response?.status, err?.response?.data || err.message);
          setLines(prev => prev.map((row, i) => (
            i === idx && row.product === l.product && (row.batch || '') === (l.batch || '')
              ? { ...row, available_stock: 'ERR' }
              : row
          )));
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    formData.warehouse,
    lines.map(l => `${l.product}|${l.batch}|${l.godown}`).join(','),
  ]);

  const addLine = () => setLines(prev => [...prev, { ...emptyLine }]);
  const removeLine = (idx) => setLines(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);

  const totalLinesAmount = useMemo(() => {
    return lines.reduce((sum, l) => sum + (parseFloat(l.amount || 0) || 0), 0);
  }, [lines]);

  const totalCost = useMemo(() => {
    return [
      formData.freight_charges,
      formData.loading_charges,
      formData.vendor_processing_charges,
    ].reduce((s, v) => s + (parseFloat(v || 0) || 0), totalLinesAmount);
  }, [formData.freight_charges, formData.loading_charges, formData.vendor_processing_charges, totalLinesAmount]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const payloadLines = lines
      .filter(l => l.product && parseFloat(l.issue_qty || 0) > 0)
      .map(l => ({
        product: l.product,
        godown: l.godown || null,
        batch: l.batch || '',
        uom: l.uom || '',
        issue_qty: l.issue_qty || 0,
        expected_return_qty: l.expected_return_qty || 0,
        rate: l.rate || 0,
        amount: l.amount || 0,
        remarks: l.remarks || '',
      }));
    if (payloadLines.length === 0) {
      toast.error('Add at least one line item with a product and Issue Qty.');
      return;
    }

    setIsLoading(true);
    try {
      const payload = {
        ...cleanFormData(formData),
        status: 'DRAFT',   // new orders always start as DRAFT regardless of form state
        lines: payloadLines,
      };
      await apiClient.post('/api/inventory/job-work/', payload);
      toast.success('Job Work created — click Approve from the detail page to move the stock.');
      navigate('/inventory/job-work');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Job Work"
        breadcrumbs={[
          { label: 'Inventory', path: '/inventory' },
          { label: 'Job Work', path: '/inventory/job-work' },
          { label: 'New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          {/* Header */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Job Work Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Job Work No</label>
                <input type="text" value={nextOrderNo || 'Auto Generated'} readOnly className={`${inputClass} bg-slate-50 text-slate-500`} />
              </div>
              {!isHidden('company') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={formData.company}
                  onChange={(e) => setFormData(prev => ({ ...prev, company: e.target.value, warehouse: '' }))}
                  required
                  disabled={isReadOnly('company')}
                  className={isReadOnly('company') ? lockedInputClass : inputClass}
                >
                  <option value="">Select Company</option>
                  {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('vendor') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Vendor <span className="text-red-500">*</span></label>
                <CustomSelect name="vendor" value={formData.vendor} onChange={handleChange} required disabled={isReadOnly('vendor')} className={isReadOnly('vendor') ? lockedInputClass : inputClass}>
                  <option value="">Select Vendor</option>
                  {vendors.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('warehouse') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect
                  name="warehouse"
                  value={formData.warehouse}
                  onChange={(e) => {
                    // Reset per-line product picks when the warehouse
                    // changes — a stale FK from a different warehouse
                    // would break the line-level filter.
                    handleChange(e);
                    setLines(prev => prev.map(l => ({ ...l, product: '', available_stock: '' })));
                  }}
                  required
                  disabled={!formData.company || isReadOnly('warehouse')}
                  className={`${isReadOnly('warehouse') ? lockedInputClass : inputClass} ${inputDisabled}`}
                >
                  <option value="">{formData.company ? 'Select Warehouse' : 'Select company first...'}</option>
                  {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('job_work_date') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Job Work Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="job_work_date" value={formData.job_work_date} onChange={handleChange} required disabled={isReadOnly('job_work_date')} className={isReadOnly('job_work_date') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('start_date') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Issue Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="start_date" value={formData.start_date} onChange={handleChange} required disabled={isReadOnly('start_date')} className={isReadOnly('start_date') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('expected_completion_date') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Expected Completion Date</label>
                <CustomDatePicker name="expected_completion_date" value={formData.expected_completion_date} onChange={handleChange} disabled={isReadOnly('expected_completion_date')} className={isReadOnly('expected_completion_date') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('job_work_type') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Job Work Type</label>
                <CustomSelect name="job_work_type" value={formData.job_work_type} onChange={handleChange} disabled={isReadOnly('job_work_type')} className={isReadOnly('job_work_type') ? lockedInputClass : inputClass}>
                  <option value="">Select Type</option>
                  <option value="PROCESSING">Processing</option>
                  <option value="BLENDING">Blending</option>
                  <option value="GRINDING">Grinding</option>
                  <option value="PACKING">Packing</option>
                  <option value="REPACKING">Repacking</option>
                  <option value="MANUFACTURING">Manufacturing</option>
                  <option value="CUSTOM">Custom</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('reference_no') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Reference No</label>
                <input type="text" name="reference_no" value={formData.reference_no} onChange={handleChange} disabled={isReadOnly('reference_no')} className={isReadOnly('reference_no') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('priority') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Priority</label>
                <CustomSelect name="priority" value={formData.priority} onChange={handleChange} disabled={isReadOnly('priority')} className={isReadOnly('priority') ? lockedInputClass : inputClass}>
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('qc_requirement') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">QC Requirement</label>
                <CustomSelect name="qc_requirement" value={formData.qc_requirement} onChange={handleChange} disabled={isReadOnly('qc_requirement')} className={isReadOnly('qc_requirement') ? lockedInputClass : inputClass}>
                  <option value="REQUIRED">Required</option>
                  <option value="OPTIONAL">Optional</option>
                  <option value="NOT_REQUIRED">Not Required</option>
                </CustomSelect>
              </div>
              )}
            </div>
          </div>

          {/* Logistics */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Logistics</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {!isHidden('transporter') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Transporter</label>
                <CustomSelect name="transporter" value={formData.transporter} onChange={handleChange} disabled={isReadOnly('transporter')} className={isReadOnly('transporter') ? lockedInputClass : inputClass}>
                  <option value="">Select Transporter</option>
                  {transporters.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('vehicle_no') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Vehicle No</label>
                <input type="text" name="vehicle_no" value={formData.vehicle_no} onChange={handleChange} disabled={isReadOnly('vehicle_no')} className={isReadOnly('vehicle_no') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('lr_no') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">LR No</label>
                <input type="text" name="lr_no" value={formData.lr_no} onChange={handleChange} disabled={isReadOnly('lr_no')} className={isReadOnly('lr_no') ? lockedInputClass : inputClass} />
              </div>
              )}
            </div>
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Line Items</h3>
              <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                <Plus size={16} /> Add Line
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b">
                    <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Category</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Godown</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Division</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Product <span className="text-red-500">*</span></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Batch No</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Available Stock</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Issue Qty <span className="text-red-500">*</span></th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Exp. Return Qty</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Rate</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Amount</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Remarks</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => (
                    <tr key={idx} className="border-b">
                      <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <CustomSelect
                          value={line.category || ''}
                          onChange={(e) => onCategoryChange(idx, e.target.value)}
                          className={inputClass}
                          style={{ minWidth: '150px' }}
                        >
                          <option value="">All Categories</option>
                          {GOODS_CATEGORIES.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        <CustomSelect value={line.godown} onChange={(e) => onGodownChange(idx, e.target.value)} disabled={!formData.warehouse} className={`${inputClass} ${inputDisabled}`} style={{ minWidth: '150px' }}>
                          <option value="">{!formData.warehouse ? 'Pick warehouse...' : isMachineSpares(line.category) ? 'All Godowns' : 'Select Godown'}</option>
                          {lineGodownOptions(line).map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        {/* Division narrows machine spares only; goods carry none. */}
                        {isMachineSpares(line.category) ? (
                          <CustomSelect value={line.division} onChange={(e) => onDivisionChange(idx, e.target.value)} disabled={!formData.warehouse} className={`${inputClass} ${inputDisabled}`} style={{ minWidth: '150px' }}>
                            <option value="">All Divisions</option>
                            {lineDivisionOptions(line).map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                          </CustomSelect>
                        ) : (
                          <span className="text-slate-300 text-xs pl-2" title="Only machine spares are classified by division">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <CustomSelect
                          value={line.product}
                          onChange={(e) => onProductChange(idx, e.target.value)}
                          required
                          disabled={!formData.warehouse}
                          className={`${inputClass} ${inputDisabled}`}
                          style={{ minWidth: '200px' }}
                        >
                          <option value="">{formData.warehouse ? 'Select Product' : 'Pick warehouse first…'}</option>
                          {lineProductOptions(line).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        <input type="text" value={line.batch} onChange={(e) => updateLine(idx, 'batch', e.target.value)} placeholder="Batch No" className={inputClass} style={{ minWidth: '120px' }} />
                      </td>
                      <td className="px-3 py-2 text-right" style={{ minWidth: '90px' }}>
                        {line.available_stock === 'ERR' ? (
                          <span className="text-red-500 text-xs" title="Failed to fetch — check console">err</span>
                        ) : line.available_stock !== '' && line.available_stock !== undefined ? (
                          <span className="font-medium text-slate-700">
                            {Number(line.available_stock).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <input type="text" value={line.uom} onChange={(e) => updateLine(idx, 'uom', e.target.value)} placeholder="UOM" className={inputClass} style={{ minWidth: '70px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" step="0.0001" min="0" value={line.issue_qty} onChange={(e) => updateLine(idx, 'issue_qty', e.target.value)} required className={`${inputClass} text-right`} style={{ minWidth: '100px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" step="0.0001" min="0" value={line.expected_return_qty} onChange={(e) => updateLine(idx, 'expected_return_qty', e.target.value)} className={`${inputClass} text-right`} style={{ minWidth: '100px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" step="0.01" min="0" value={line.rate} onChange={(e) => updateLine(idx, 'rate', e.target.value)} className={`${inputClass} text-right`} style={{ minWidth: '90px' }} />
                      </td>
                      <td className="px-3 py-2 text-right text-slate-700 font-medium" style={{ minWidth: '100px' }}>{line.amount || '—'}</td>
                      <td className="px-3 py-2">
                        <input type="text" value={line.remarks} onChange={(e) => updateLine(idx, 'remarks', e.target.value)} className={inputClass} style={{ minWidth: '140px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => removeLine(idx)} disabled={lines.length <= 1} aria-label="Remove line" title="Remove line" className="text-red-500 hover:text-red-700 disabled:opacity-30">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Costs */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Costs</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {!isHidden('freight_charges') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Freight Charges</label>
                <input type="number" step="0.01" min="0" name="freight_charges" value={formData.freight_charges} onChange={handleChange} disabled={isReadOnly('freight_charges')} className={isReadOnly('freight_charges') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('loading_charges') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Loading Charges</label>
                <input type="number" step="0.01" min="0" name="loading_charges" value={formData.loading_charges} onChange={handleChange} disabled={isReadOnly('loading_charges')} className={isReadOnly('loading_charges') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('vendor_processing_charges') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Vendor Processing Charges</label>
                <input type="number" step="0.01" min="0" name="vendor_processing_charges" value={formData.vendor_processing_charges} onChange={handleChange} disabled={isReadOnly('vendor_processing_charges')} className={isReadOnly('vendor_processing_charges') ? lockedInputClass : inputClass} />
              </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Total Cost</label>
                <input type="text" value={totalCost ? totalCost.toFixed(2) : '0.00'} readOnly className={`${inputClass} bg-slate-50 font-semibold text-slate-800`} />
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Notes</h3>
            {!isHidden('remarks') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Remarks / Notes</label>
              <textarea name="remarks" value={formData.remarks} onChange={handleChange} rows={3} disabled={isReadOnly('remarks')} className={isReadOnly('remarks') ? lockedInputClass : inputClass} />
            </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save as Draft'}</button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}

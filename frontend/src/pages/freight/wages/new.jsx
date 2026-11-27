import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';
import FileAttachments, { uploadPendingFiles } from '../../purchase/components/FileAttachments';
import AdditionalCharges, { sumAddToTotal, chargesHaveValue } from '../../../components/common/AdditionalCharges';
import { Paperclip, FileText } from 'lucide-react';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const labelClass = 'block text-sm font-medium text-slate-700 mb-1';
const readOnlyClass = `${inputClass} bg-slate-50 cursor-not-allowed`;
const fmt = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const emptyLine = { wage_type: 'UNLOADING', contractor: '', work_date: '', tons: '', cost_per_ton: '', amount: '', advance_paid: '0', remarks: '' };
const emptyTransport = {
  company_name: '',
  warehouse_name: '',
  from_warehouse_name: '',
  to_warehouse_name: '',
  from_godown_name: '',
  to_godown_name: '',
  vendor_or_customer: '',
  transporter_name: '',
  lorry_no: '',
  driver_name: '',
  driver_contact: '',
  transport_document_no: '',
  source_date: '',
};

export default function WageEntryCreate() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Wage Entry');
  const [searchParams] = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const pendingAttachmentsRef = useRef([]);

  // ─── Source-doc lookups ─────────────────────────────────────────────────
  const { raw: receiptRaw } = useLookup('/api/purchase/receipts/');
  const { raw: transferRaw } = useLookup('/api/inventory/transfers/');
  const { raw: shiftingRaw } = useLookup('/api/inventory/shifting/');
  const { raw: dispatchChallanRaw } = useLookup('/api/sales/dc/');
  const { raw: wageRaw } = useLookup('/api/purchase/wage-entries/');
  // Contractor / Labour Vendor dropdown — restricted to vendors flagged
  // as CONTRACTOR or WAGES in Vendor Master (vendor_type JSONField).
  // Plain material/freight/service vendors are excluded; the wage-
  // payment cycle settles only with labour contractors.
  const { options: vendorOptions } = useLookup(
    '/api/vendors/?vendor_type=CONTRACTOR,WAGES',
    { labelField: 'vendor_name' },
  );

  // Dedupe source docs already wage-billed by a live wage entry.
  const liveWages = (wageRaw || []).filter(w => w.status !== 'CANCELLED');
  const usedReceiptIds = new Set(liveWages.filter(w => w.source_type === 'PURCHASE_RECEIPT' && w.receipt).map(w => w.receipt));
  const usedTransferIds = new Set(liveWages.filter(w => w.source_type === 'INVENTORY_TRANSFER' && w.transfer_source).map(w => w.transfer_source));
  const usedShiftingIds = new Set(liveWages.filter(w => w.source_type === 'INVENTORY_SHIFTING' && w.shifting_source).map(w => w.shifting_source));
  const usedDCIds = new Set(liveWages.filter(w => w.source_type === 'SALES_DISPATCH_CHALLAN' && w.dispatch_challan_source).map(w => w.dispatch_challan_source));

  const receiptOptions = (receiptRaw || [])
    .filter(r => !usedReceiptIds.has(r.id))
    .map(r => ({ value: r.id, label: `${r.receipt_advice_no}${r.vendor_name ? ' · ' + r.vendor_name : ''}` }));
  const transferOptions = (transferRaw || [])
    .filter(t => !usedTransferIds.has(t.id))
    .map(t => ({ value: t.id, label: `${t.transfer_no}${t.from_warehouse_name ? ' · ' + t.from_warehouse_name : ''}${t.to_warehouse_name ? ' → ' + t.to_warehouse_name : ''}` }));
  const shiftingOptions = (shiftingRaw || [])
    .filter(s => !usedShiftingIds.has(s.id))
    .map(s => ({ value: s.id, label: `${s.shifting_no}${s.warehouse_name ? ' · ' + s.warehouse_name : ''}${s.from_godown_name ? ' · ' + s.from_godown_name + ' → ' + (s.to_godown_name || '?') : ''}` }));
  const dispatchChallanOptions = (dispatchChallanRaw || [])
    .filter(d => !usedDCIds.has(d.id))
    .map(d => ({ value: d.id, label: `${d.dc_no}${d.customer_name ? ' · ' + d.customer_name : ''}${d.destination ? ' → ' + d.destination : ''}` }));

  // ─── Form state ─────────────────────────────────────────────────────────
  const [sourceType, setSourceType] = useState('PURCHASE_RECEIPT');
  // Locked when the user arrived from a specific source document (a *_id in
  // the URL) — only that source card is shown and the picker is read-only.
  const [sourceLocked, setSourceLocked] = useState(false);
  const [formData, setFormData] = useState({
    date: new Date().toISOString().split('T')[0],
    receipt: '',
    transfer_source: '',
    shifting_source: '',
    dispatch_challan_source: '',
    overall_remarks: '',
  });
  const [transportInfo, setTransportInfo] = useState({ ...emptyTransport });
  const [productLines, setProductLines] = useState([]);
  const [sourceMeta, setSourceMeta] = useState(null); // raw source doc for the Linked Info card
  const [receiptAttachments, setReceiptAttachments] = useState([]);
  const [lines, setLines] = useState([{ ...emptyLine, work_date: new Date().toISOString().split('T')[0] }]);
  const [additionalCharges, setAdditionalCharges] = useState([]);
  const [chargesRemarks, setChargesRemarks] = useState('');

  // ─── Auto-fill + lock from query params (any source entry point) ────────
  // Whichever *_id the caller passed decides the source type and locks it, so
  // a wage created from a receipt only offers "Purchase Receipt", etc. Direct
  // visits (no id) keep all four options.
  useEffect(() => {
    const receiptId  = searchParams.get('receipt_id');
    const transferId = searchParams.get('transfer_id');
    const shiftingId = searchParams.get('shifting_id');
    const dcId       = searchParams.get('dc_id') || searchParams.get('challan_id');
    if (receiptId) {
      setSourceType('PURCHASE_RECEIPT'); setSourceLocked(true);
      setFormData(prev => ({ ...prev, receipt: receiptId }));
      loadReceipt(receiptId);
    } else if (transferId) {
      setSourceType('INVENTORY_TRANSFER'); setSourceLocked(true);
      setFormData(prev => ({ ...prev, transfer_source: transferId }));
      loadTransfer(transferId);
    } else if (shiftingId) {
      setSourceType('INVENTORY_SHIFTING'); setSourceLocked(true);
      setFormData(prev => ({ ...prev, shifting_source: shiftingId }));
      loadShifting(shiftingId);
    } else if (dcId) {
      setSourceType('SALES_DISPATCH_CHALLAN'); setSourceLocked(true);
      setFormData(prev => ({ ...prev, dispatch_challan_source: dcId }));
      loadDC(dcId);
    }
  }, [searchParams]);

  // ─── Loaders ────────────────────────────────────────────────────────────
  const resetSourceState = () => {
    setTransportInfo({ ...emptyTransport });
    setProductLines([]);
    setSourceMeta(null);
    setReceiptAttachments([]);
  };

  const loadReceipt = async (receiptId) => {
    try {
      const r = (await apiClient.get(`/api/purchase/receipts/${receiptId}/`)).data;
      setSourceMeta({ ...r, _source: 'PURCHASE_RECEIPT' });
      const firstFd = (r.freight_details || [])[0] || {};
      // The transporter / driver / vehicle / LR fields usually aren't
      // captured on the Receipt itself — they live on the linked Inward
      // Freight Advice. Fall back to the first non-cancelled freight
      // advice's summary so the wages form arrives pre-filled when the
      // user clicks "Wages" from the receipts list.
      const linkedFreight = (r.freight_advices || []).find(f => f.status !== 'CANCELLED') || {};
      setTransportInfo({
        company_name: r.company_name || '',
        warehouse_name: r.warehouse_name || '',
        from_warehouse_name: '',
        to_warehouse_name: r.warehouse_name || '',
        from_godown_name: '',
        to_godown_name: r.godown_name || '',
        vendor_or_customer: r.vendor_name || '',
        transporter_name: r.transporter_name || firstFd.transporter_name || linkedFreight.transporter_name || '',
        lorry_no: r.vehicle_number || linkedFreight.lorry_no || '',
        driver_name: r.driver_name || linkedFreight.driver_name || '',
        // The Receipt model stores the driver's number as `driver_phone`;
        // only the Freight Advice calls it `driver_contact`. Read the
        // receipt's field first, then fall back to the linked freight.
        driver_contact: r.driver_phone || r.driver_contact || linkedFreight.driver_contact || '',
        transport_document_no: r.transport_document_no || linkedFreight.transport_document_no || '',
        source_date: r.receipt_date ? String(r.receipt_date).split('T')[0] : '',
      });
      const rcptProductLines = (r.receipt_lines || []).map(l => ({
        product_name: l.product_name || '',
        quantity: l.quantity_received || 0,
        uom: l.uom || '',
        batch_no: l.batch_no || '',
      }));
      setProductLines(rcptProductLines);
      // Auto-fill the first wage line's Ton with the total received
      // quantity so the user doesn't have to re-type what the receipt
      // already knows. Mirrors the DC flow above. Leaves cost_per_ton
      // / amount for the user to fill — those are wage-specific.
      const rcptTotalQty = rcptProductLines.reduce((s, p) => s + (parseFloat(p.quantity) || 0), 0);
      if (rcptTotalQty > 0) {
        setLines(prev => prev.map((l, idx) => {
          if (idx !== 0) return l;
          const cpt = parseFloat(l.cost_per_ton) || 0;
          return {
            ...l,
            tons: rcptTotalQty.toString(),
            amount: (Math.round(rcptTotalQty * cpt * 100) / 100).toString(),
          };
        }));
      }
      apiClient.get(`/api/purchase/attachments/?module=RECEIPT&record_id=${receiptId}`)
        .then(a => setReceiptAttachments(a.data?.results || a.data || []))
        .catch(() => setReceiptAttachments([]));
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load receipt');
      resetSourceState();
    }
  };

  const loadTransfer = async (transferId) => {
    try {
      const t = (await apiClient.get(`/api/inventory/transfers/${transferId}/`)).data;
      setSourceMeta({ ...t, _source: 'INVENTORY_TRANSFER' });
      setTransportInfo({
        company_name: t.company_name || '',
        warehouse_name: '',
        from_warehouse_name: t.from_warehouse_name || '',
        to_warehouse_name: t.to_warehouse_name || '',
        from_godown_name: t.from_godown_name || '',
        to_godown_name: t.to_godown_name || '',
        vendor_or_customer: t.transporter_name || '',
        transporter_name: t.transporter_name || '',
        lorry_no: t.vehicle_no || '',
        driver_name: '',
        driver_contact: '',
        transport_document_no: t.lr_no || '',
        source_date: t.dispatch_date || t.transfer_date || '',
      });
      const tProductLines = (t.lines || []).map(l => ({
        product_name: l.product_name || '',
        quantity: l.quantity || 0,
        uom: l.uom || '',
        batch_no: l.batch || '',
      }));
      setProductLines(tProductLines);
      const tTotalQty = tProductLines.reduce((s, p) => s + (parseFloat(p.quantity) || 0), 0);
      if (tTotalQty > 0) {
        setLines(prev => prev.map((l, idx) => {
          if (idx !== 0) return l;
          const cpt = parseFloat(l.cost_per_ton) || 0;
          return {
            ...l,
            tons: tTotalQty.toString(),
            amount: (Math.round(tTotalQty * cpt * 100) / 100).toString(),
          };
        }));
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load transfer');
      resetSourceState();
    }
  };

  const loadShifting = async (shiftingId) => {
    try {
      const s = (await apiClient.get(`/api/inventory/shifting/${shiftingId}/`)).data;
      setSourceMeta({ ...s, _source: 'INVENTORY_SHIFTING' });
      setTransportInfo({
        company_name: s.company_name || '',
        warehouse_name: s.warehouse_name || '',
        from_warehouse_name: '',
        to_warehouse_name: '',
        from_godown_name: s.from_godown_name || '',
        to_godown_name: s.to_godown_name || '',
        vendor_or_customer: '',
        transporter_name: '',
        lorry_no: '',
        driver_name: '',
        driver_contact: '',
        transport_document_no: '',
        source_date: s.request_date || '',
      });
      const sProductLines = (s.products || []).map(p => ({
        product_name: p.product_name || '',
        quantity: p.quantity || 0,
        uom: p.uom || '',
        batch_no: p.batch || '',
      }));
      setProductLines(sProductLines);
      const sTotalQty = sProductLines.reduce((sum, p) => sum + (parseFloat(p.quantity) || 0), 0);
      if (sTotalQty > 0) {
        setLines(prev => prev.map((l, idx) => {
          if (idx !== 0) return l;
          const cpt = parseFloat(l.cost_per_ton) || 0;
          return {
            ...l,
            tons: sTotalQty.toString(),
            amount: (Math.round(sTotalQty * cpt * 100) / 100).toString(),
          };
        }));
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load shifting');
      resetSourceState();
    }
  };

  const loadDC = async (dcId) => {
    try {
      const d = (await apiClient.get(`/api/sales/dc/${dcId}/`)).data;
      setSourceMeta({ ...d, _source: 'SALES_DISPATCH_CHALLAN' });
      setTransportInfo({
        company_name: d.company_name || '',
        warehouse_name: d.warehouse_name || '',
        from_warehouse_name: d.warehouse_name || '',
        to_warehouse_name: '',
        from_godown_name: '',
        to_godown_name: '',
        vendor_or_customer: d.customer_name || '',
        transporter_name: d.transporter_name || '',
        lorry_no: d.lorry_no || '',
        driver_name: '',
        driver_contact: d.driver_contact || '',
        transport_document_no: d.invoice_no || '',
        source_date: d.dispatch_date ? String(d.dispatch_date).split('T')[0] : '',
      });
      const dcProductLines = (d.dc_lines || []).map(l => ({
        product_name: l.product_name || l.product_sku || '',
        quantity: l.quantity_dispatched || 0,
        uom: l.uom || '',
        batch_no: l.batch_no || '',
      }));
      setProductLines(dcProductLines);
      // DC-only: auto-fill the first wage line's Ton with the total
      // dispatched quantity so the user doesn't have to re-type what
      // the DC already knows. Also flip the line's type to LOADING —
      // a DC is goods going OUT of the warehouse, so the wage being
      // booked is for loading the truck (not unloading, which is the
      // Purchase-Receipt default). Other source types stay manual.
      const dcTotalQty = dcProductLines.reduce((s, p) => s + (parseFloat(p.quantity) || 0), 0);
      setLines(prev => prev.map((l, idx) => {
        if (idx !== 0) return l;
        const tons = dcTotalQty > 0 ? dcTotalQty : (parseFloat(l.tons) || 0);
        const cpt = parseFloat(l.cost_per_ton) || 0;
        return {
          ...l,
          wage_type: 'LOADING',
          tons: dcTotalQty > 0 ? tons.toString() : l.tons,
          amount: (Math.round(tons * cpt * 100) / 100).toString(),
        };
      }));
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load dispatch challan');
      resetSourceState();
    }
  };

  // ─── Handlers ───────────────────────────────────────────────────────────
  const handleSourceTypeChange = (newType) => {
    setSourceType(newType);
    setFormData(prev => ({
      ...prev,
      receipt: '', transfer_source: '', shifting_source: '', dispatch_challan_source: '',
    }));
    resetSourceState();
  };

  const handleReceiptChange = (e) => {
    const val = e.target.value;
    setFormData(prev => ({ ...prev, receipt: val, transfer_source: '', shifting_source: '', dispatch_challan_source: '' }));
    if (val) loadReceipt(val); else resetSourceState();
  };
  const handleTransferChange = (e) => {
    const val = e.target.value;
    setFormData(prev => ({ ...prev, receipt: '', transfer_source: val, shifting_source: '', dispatch_challan_source: '' }));
    if (val) loadTransfer(val); else resetSourceState();
  };
  const handleShiftingChange = (e) => {
    const val = e.target.value;
    setFormData(prev => ({ ...prev, receipt: '', transfer_source: '', shifting_source: val, dispatch_challan_source: '' }));
    if (val) loadShifting(val); else resetSourceState();
  };
  const handleDCChange = (e) => {
    const val = e.target.value;
    setFormData(prev => ({ ...prev, receipt: '', transfer_source: '', shifting_source: '', dispatch_challan_source: val }));
    if (val) loadDC(val); else resetSourceState();
  };

  const handleChange = (e) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };
  const handleTransportChange = (e) => {
    setTransportInfo(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  // Line management. Dispatch Challan = goods leaving the warehouse,
  // so wage lines added in that context default to LOADING (the labour
  // is loading the truck for customer delivery). All other source types
  // — receipts, transfers, shifting — default to UNLOADING (the legacy
  // behaviour: goods coming into a warehouse / godown).
  const defaultWageType = sourceType === 'SALES_DISPATCH_CHALLAN' ? 'LOADING' : 'UNLOADING';
  const addLine = () => setLines(prev => [...prev, { ...emptyLine, wage_type: defaultWageType, work_date: formData.date }]);
  const removeLine = (i) => { if (lines.length > 1) setLines(prev => prev.filter((_, idx) => idx !== i)); };
  const handleLineChange = (i, field, value) => {
    setLines(prev => prev.map((l, idx) => {
      if (idx !== i) return l;
      const updated = { ...l, [field]: value };
      if (field === 'tons' || field === 'cost_per_ton') {
        const tons = parseFloat(field === 'tons' ? value : updated.tons) || 0;
        const cpt = parseFloat(field === 'cost_per_ton' ? value : updated.cost_per_ton) || 0;
        updated.amount = (Math.round(tons * cpt * 100) / 100).toString();
      }
      return updated;
    }));
  };

  // Totals
  const loadingAmount = lines.filter(l => l.wage_type === 'LOADING').reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
  const unloadingAmount = lines.filter(l => l.wage_type === 'UNLOADING').reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
  const chargesTotal = sumAddToTotal(additionalCharges);
  const totalAmount = loadingAmount + unloadingAmount + chargesTotal;
  const totalAdvance = lines.reduce((s, l) => s + (parseFloat(l.advance_paid) || 0), 0);
  const totalBalance = totalAmount - totalAdvance;

  // Quantity-basis reference from product lines
  const totalSourceQty = productLines.reduce((s, p) => s + (parseFloat(p.quantity) || 0), 0);

  // DC-only: per-UOM totals so the footer shows e.g. "1,300.00 LTR"
  // or "500 LTR · 200 MTS" when the DC mixes units. Other source
  // types keep the single-number total.
  const totalSourceQtyByUom = useMemo(() => {
    if (sourceType !== 'SALES_DISPATCH_CHALLAN') return null;
    const map = {};
    for (const p of productLines) {
      const uom = (p.uom || '').toUpperCase() || '—';
      map[uom] = (map[uom] || 0) + (parseFloat(p.quantity) || 0);
    }
    return map;
  }, [productLines, sourceType]);

  const formatUomBreakdown = (map) =>
    Object.entries(map)
      .map(([u, q]) => `${q.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${u}`)
      .join(' · ');

  // DC-only: the wage rate basis follows the DC's UOM (LTR, MTS, KG…)
  // instead of the hard-coded "Ton" label. When the DC mixes UOMs we
  // fall back to "Unit" since a single wage line covers the whole load.
  // Other source types keep the legacy "Ton" / "Cost / Ton" labels.
  const wageQtyLabel = useMemo(() => {
    if (sourceType !== 'SALES_DISPATCH_CHALLAN' || !totalSourceQtyByUom) return 'Ton';
    const uoms = Object.keys(totalSourceQtyByUom).filter(u => u && u !== '—');
    if (uoms.length === 0) return 'Ton';
    if (uoms.length === 1) return uoms[0];
    return 'Unit';
  }, [sourceType, totalSourceQtyByUom]);
  const wageCostLabel = `Cost / ${wageQtyLabel}`;

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Source validation
    if (sourceType === 'PURCHASE_RECEIPT' && !formData.receipt) { toast.error('Please select a Purchase Receipt.'); return; }
    if (sourceType === 'INVENTORY_TRANSFER' && !formData.transfer_source) { toast.error('Please select a Transfer.'); return; }
    if (sourceType === 'INVENTORY_SHIFTING' && !formData.shifting_source) { toast.error('Please select a Shifting.'); return; }
    if (sourceType === 'SALES_DISPATCH_CHALLAN' && !formData.dispatch_challan_source) { toast.error('Please select a Dispatch Challan.'); return; }
    if (lines.length === 0 || !lines.some(l => l.wage_type)) { toast.error('Add at least one wage entry.'); return; }

    // Contractor / Labour Vendor is mandatory on every wage line so
    // the Wage Payment cycle has a contractor to group by — without
    // it the line is unsettleable. Surface the row number to help
    // the user find the offending line quickly.
    const missingIdx = lines.findIndex(l => l.wage_type && !l.contractor);
    if (missingIdx >= 0) {
      toast.error(`Contractor / Labour Vendor is required (row ${missingIdx + 1}).`);
      return;
    }
    if (chargesHaveValue(additionalCharges) && !chargesRemarks.trim()) {
      toast.error('Remarks are required when additional charges are added.');
      return;
    }

    setIsLoading(true);
    try {
      const payload = {
        date: formData.date,
        source_type: sourceType,
        receipt: sourceType === 'PURCHASE_RECEIPT' ? formData.receipt : null,
        transfer_source: sourceType === 'INVENTORY_TRANSFER' ? formData.transfer_source : null,
        shifting_source: sourceType === 'INVENTORY_SHIFTING' ? formData.shifting_source : null,
        dispatch_challan_source: sourceType === 'SALES_DISPATCH_CHALLAN' ? formData.dispatch_challan_source : null,
        overall_remarks: formData.overall_remarks,
        additional_charges: additionalCharges.filter(c => parseFloat(c.amount) > 0),
        additional_charges_remarks: chargesRemarks.trim(),
        wage_lines: lines.filter(l => l.wage_type).map(l => {
          const line = {
            wage_type: l.wage_type,
            work_date: l.work_date || null,
            tons: parseFloat(l.tons) || null,
            cost_per_ton: parseFloat(l.cost_per_ton) || null,
            amount: parseFloat(l.amount) || 0,
            advance_paid: parseFloat(l.advance_paid) || 0,
            remarks: l.remarks || '',
          };
          if (l.contractor) line.contractor = l.contractor;
          return line;
        }),
      };
      const res = await apiClient.post('/api/purchase/wage-entries/', payload);
      const newId = res.data?.id;
      if (pendingAttachments.length > 0 && newId) {
        await uploadPendingFiles('WAGE_ENTRY', newId, pendingAttachmentsRef.current);
      }
      toast.success('Wage Entry created!');
      navigate(newId ? `/freight/wages/${newId}` : '/freight/wages');
    } catch (error) {
      console.error('[WageEntry] Error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────
  const sourceTypeOptions = [
    { v: 'PURCHASE_RECEIPT', label: 'Purchase Receipt', desc: 'Vendor → Warehouse' },
    { v: 'INVENTORY_TRANSFER', label: 'Inventory Transfer', desc: 'Warehouse → Warehouse' },
    { v: 'INVENTORY_SHIFTING', label: 'Inventory Shifting', desc: 'Godown → Godown' },
    { v: 'SALES_DISPATCH_CHALLAN', label: 'Dispatch Challan', desc: 'Warehouse → Customer' },
  ];

  return (
    <MainLayout>
      <PageHeader
        title="New Loading / Unloading Wages"
        breadcrumbs={[{ label: 'Freight & Billing', path: '/freight/inward' }, { label: 'Wages', path: '/freight/wages' }, { label: 'New' }]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit} noValidate>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">

          {/* ── Source Document ─────────────────────────────────────────── */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Wages For / Source Type</h3>
            {sourceLocked && (
              <p className="mb-3 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded px-2 py-1.5 inline-block">
                Source locked — these wages are for the document you came from.
              </p>
            )}
            <div className="mb-4 flex flex-wrap gap-2">
              {(sourceLocked ? sourceTypeOptions.filter(o => o.v === sourceType) : sourceTypeOptions).map(opt => (
                <label
                  key={opt.v}
                  className={`flex-1 min-w-[180px] flex items-start gap-2 rounded-lg border-2 px-3 py-2 transition ${sourceLocked ? 'cursor-default' : 'cursor-pointer'} ${sourceType === opt.v ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}
                >
                  <input
                    type="radio"
                    name="source_type"
                    checked={sourceType === opt.v}
                    onChange={() => handleSourceTypeChange(opt.v)}
                    disabled={sourceLocked}
                    className="accent-blue-600 mt-0.5"
                  />
                  <div>
                    <div className={`text-sm font-semibold ${sourceType === opt.v ? 'text-blue-700' : 'text-slate-700'}`}>{opt.label}</div>
                    <div className="text-xs text-slate-500">{opt.desc}</div>
                  </div>
                </label>
              ))}
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {sourceType === 'PURCHASE_RECEIPT' && (
                <div>
                  <label className={labelClass}>Receipt Advice <span className="text-red-500">*</span></label>
                  {searchParams.get('receipt_id') && formData.receipt ? (
                    <input type="text" readOnly value={sourceMeta?.receipt_advice_no || formData.receipt} className={readOnlyClass} />
                  ) : (
                    <CustomSelect name="receipt" value={formData.receipt} onChange={handleReceiptChange} required className={inputClass}>
                      <option value="">Select Receipt</option>
                      {receiptOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  )}
                </div>
              )}
              {sourceType === 'INVENTORY_TRANSFER' && (
                <div>
                  <label className={labelClass}>Transfer No <span className="text-red-500">*</span></label>
                  <CustomSelect name="transfer_source" value={formData.transfer_source} onChange={handleTransferChange} required className={inputClass}>
                    <option value="">Select Transfer</option>
                    {transferOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                </div>
              )}
              {sourceType === 'INVENTORY_SHIFTING' && (
                <div>
                  <label className={labelClass}>Shifting No <span className="text-red-500">*</span></label>
                  <CustomSelect name="shifting_source" value={formData.shifting_source} onChange={handleShiftingChange} required className={inputClass}>
                    <option value="">Select Shifting</option>
                    {shiftingOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                </div>
              )}
              {sourceType === 'SALES_DISPATCH_CHALLAN' && (
                <div>
                  <label className={labelClass}>Dispatch Challan No <span className="text-red-500">*</span></label>
                  <CustomSelect name="dispatch_challan_source" value={formData.dispatch_challan_source} onChange={handleDCChange} required className={inputClass}>
                    <option value="">Select Dispatch Challan</option>
                    {dispatchChallanOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                </div>
              )}
              <div>
                <label className={labelClass}>Wage Entry Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="date" value={formData.date} onChange={handleChange} required className={inputClass} />
              </div>
            </div>

            {/* Linked Info card */}
            {sourceMeta && (
              <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                <h4 className="text-sm font-semibold text-blue-800 mb-2">
                  Linked {sourceMeta._source === 'PURCHASE_RECEIPT' ? 'Receipt' :
                          sourceMeta._source === 'INVENTORY_TRANSFER' ? 'Transfer' :
                          sourceMeta._source === 'INVENTORY_SHIFTING' ? 'Shifting' : 'Dispatch Challan'} Info
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  {sourceMeta._source === 'PURCHASE_RECEIPT' && (
                    <>
                      <div><span className="text-blue-600">Vendor:</span> <span className="ml-1 font-medium">{sourceMeta.vendor_name || '-'}</span></div>
                      <div><span className="text-blue-600">Warehouse:</span> <span className="ml-1 font-medium">{sourceMeta.warehouse_name || '-'}</span></div>
                      <div><span className="text-blue-600">PO Numbers:</span> <span className="ml-1 font-medium">{(sourceMeta.linked_po_numbers || []).join(', ') || '-'}</span></div>
                      <div><span className="text-blue-600">Receipt Date:</span> <span className="ml-1 font-medium">{transportInfo.source_date || '-'}</span></div>
                    </>
                  )}
                  {sourceMeta._source === 'INVENTORY_TRANSFER' && (
                    <>
                      <div><span className="text-blue-600">From WH:</span> <span className="ml-1 font-medium">{sourceMeta.from_warehouse_name || '-'}</span></div>
                      <div><span className="text-blue-600">To WH:</span> <span className="ml-1 font-medium">{sourceMeta.to_warehouse_name || '-'}</span></div>
                      <div><span className="text-blue-600">Transporter:</span> <span className="ml-1 font-medium">{sourceMeta.transporter_name || '-'}</span></div>
                      <div><span className="text-blue-600">Transfer Date:</span> <span className="ml-1 font-medium">{transportInfo.source_date || '-'}</span></div>
                    </>
                  )}
                  {sourceMeta._source === 'INVENTORY_SHIFTING' && (
                    <>
                      <div><span className="text-blue-600">Warehouse:</span> <span className="ml-1 font-medium">{sourceMeta.warehouse_name || '-'}</span></div>
                      <div><span className="text-blue-600">From Godown:</span> <span className="ml-1 font-medium">{sourceMeta.from_godown_name || '-'}</span></div>
                      <div><span className="text-blue-600">To Godown:</span> <span className="ml-1 font-medium">{sourceMeta.to_godown_name || '-'}</span></div>
                      <div><span className="text-blue-600">Request Date:</span> <span className="ml-1 font-medium">{transportInfo.source_date || '-'}</span></div>
                    </>
                  )}
                  {sourceMeta._source === 'SALES_DISPATCH_CHALLAN' && (
                    <>
                      <div><span className="text-blue-600">Customer:</span> <span className="ml-1 font-medium">{sourceMeta.customer_name || '-'}</span></div>
                      <div><span className="text-blue-600">Warehouse:</span> <span className="ml-1 font-medium">{sourceMeta.warehouse_name || '-'}</span></div>
                      <div><span className="text-blue-600">Destination:</span> <span className="ml-1 font-medium">{sourceMeta.destination || '-'}</span></div>
                      <div><span className="text-blue-600">Dispatch Date:</span> <span className="ml-1 font-medium">{transportInfo.source_date || '-'}</span></div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── Auto-filled Transport / Counter-party (editable) ─────────── */}
          {sourceMeta && (
            <div>
              <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Transport & Counter-party (editable)</h3>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className={labelClass}>Company</label>
                  <input type="text" name="company_name" value={transportInfo.company_name} onChange={handleTransportChange} className={inputClass} />
                </div>
                {sourceType !== 'INVENTORY_TRANSFER' && (
                  <div>
                    <label className={labelClass}>Warehouse</label>
                    <input type="text" name="warehouse_name" value={transportInfo.warehouse_name} onChange={handleTransportChange} className={inputClass} />
                  </div>
                )}
                {sourceType === 'INVENTORY_TRANSFER' && (
                  <>
                    <div>
                      <label className={labelClass}>From Warehouse</label>
                      <input type="text" name="from_warehouse_name" value={transportInfo.from_warehouse_name} onChange={handleTransportChange} className={inputClass} />
                    </div>
                    <div>
                      <label className={labelClass}>To Warehouse</label>
                      <input type="text" name="to_warehouse_name" value={transportInfo.to_warehouse_name} onChange={handleTransportChange} className={inputClass} />
                    </div>
                  </>
                )}
                {(sourceType === 'INVENTORY_TRANSFER' || sourceType === 'INVENTORY_SHIFTING') && (
                  <>
                    <div>
                      <label className={labelClass}>From Godown</label>
                      <input type="text" name="from_godown_name" value={transportInfo.from_godown_name} onChange={handleTransportChange} className={inputClass} />
                    </div>
                    <div>
                      <label className={labelClass}>To Godown</label>
                      <input type="text" name="to_godown_name" value={transportInfo.to_godown_name} onChange={handleTransportChange} className={inputClass} />
                    </div>
                  </>
                )}
                <div>
                  <label className={labelClass}>
                    {sourceType === 'PURCHASE_RECEIPT' ? 'Vendor' :
                     sourceType === 'SALES_DISPATCH_CHALLAN' ? 'Customer' : 'Counter-party'}
                  </label>
                  <input type="text" name="vendor_or_customer" value={transportInfo.vendor_or_customer} onChange={handleTransportChange} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Transporter</label>
                  <input type="text" name="transporter_name" value={transportInfo.transporter_name} onChange={handleTransportChange} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Lorry / Vehicle No</label>
                  <input type="text" name="lorry_no" value={transportInfo.lorry_no} onChange={handleTransportChange} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Driver Name</label>
                  <input type="text" name="driver_name" value={transportInfo.driver_name} onChange={handleTransportChange} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Driver Contact</label>
                  <input type="text" name="driver_contact" value={transportInfo.driver_contact} onChange={handleTransportChange} className={inputClass} placeholder="Phone number" />
                </div>
                <div>
                  <label className={labelClass}>LR / Transport Doc No</label>
                  <input type="text" name="transport_document_no" value={transportInfo.transport_document_no} onChange={handleTransportChange} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Dispatch / Receipt Date</label>
                  <CustomDatePicker name="source_date" value={transportInfo.source_date} onChange={handleTransportChange} className={inputClass} />
                </div>
              </div>
              <p className="text-xs text-slate-400 mt-2">
                These details are reference-only (auto-filled from the source document, editable here for the wage bill). They are not persisted on the wage entry — edit the source document if you need the change to be authoritative.
              </p>
            </div>
          )}

          {/* ── Product line items (read-only reference) ─────────────────── */}
          {productLines.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">
                Product Line Items ({productLines.length}) <span className="text-xs font-normal text-slate-500 ml-2">— reference only, for quantity basis</span>
              </h3>
              {/* Mobile-stacked card layout */}
              <div className="sm:hidden space-y-2 mb-3">
                {productLines.map((p, idx) => (
                  <div key={`m-${idx}`} className="border border-slate-200 rounded-lg bg-white p-3">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="text-sm font-semibold text-slate-800">#{idx + 1} {p.product_name || '-'}</div>
                      <div className="text-sm font-bold text-slate-700 whitespace-nowrap">{Number(p.quantity || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} {p.uom || ''}</div>
                    </div>
                    <div className="text-xs text-slate-500"><span className="uppercase tracking-wide">Batch:</span> <span className="text-slate-700">{p.batch_no || '-'}</span></div>
                  </div>
                ))}
                <div className="border-t-2 border-slate-300 pt-2 px-3 flex items-center justify-between text-sm font-semibold">
                  <span className="text-slate-600">Total Source Qty</span>
                  <span className="text-slate-800">
                    {totalSourceQtyByUom
                      ? formatUomBreakdown(totalSourceQtyByUom)
                      : Number(totalSourceQty).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                  </span>
                </div>
              </div>
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-primary-50 border-b-2 border-slate-300">
                      <th className="text-left px-3 py-2 font-medium text-slate-600 w-10">#</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Product</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Batch</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Quantity</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productLines.map((p, idx) => (
                      <tr key={idx} className="border-b border-slate-50">
                        <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                        <td className="px-3 py-2">{p.product_name || '-'}</td>
                        <td className="px-3 py-2">{p.batch_no || '-'}</td>
                        <td className="px-3 py-2 text-right">{Number(p.quantity || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                        <td className="px-3 py-2">{p.uom || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {totalSourceQtyByUom ? (
                      // DC source: show per-UOM breakdown in the UOM
                      // column so MTS/LTR/etc. lines roll up cleanly.
                      <tr className="bg-slate-50 font-semibold border-t-2">
                        <td colSpan="3" className="px-3 py-2 text-right text-slate-700">Total Source Qty:</td>
                        <td colSpan="2" className="px-3 py-2 text-right text-slate-800">
                          {formatUomBreakdown(totalSourceQtyByUom)}
                        </td>
                      </tr>
                    ) : (
                      <tr className="bg-slate-50 font-semibold border-t-2">
                        <td colSpan="3" className="px-3 py-2 text-right text-slate-700">Total Source Qty:</td>
                        <td className="px-3 py-2 text-right">{Number(totalSourceQty).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                        <td></td>
                      </tr>
                    )}
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* ── Loading/Unloading Wages Table ───────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Loading / Unloading Wages ({lines.length})</h3>
              <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                <Plus size={16} /> Add Wage Entry
              </button>
            </div>
            {/* Mobile-stacked editable cards */}
            <div className="sm:hidden space-y-3">
              {lines.map((line, idx) => (
                <div key={`m-${idx}`} className="border border-slate-200 rounded-lg bg-white p-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="text-sm font-semibold text-slate-700">Row #{idx + 1}</div>
                    <button type="button" onClick={() => removeLine(idx)} disabled={lines.length <= 1} className="text-red-500 hover:text-red-700 disabled:opacity-30 p-1"><Trash2 size={16} /></button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Type *</label>
                      <CustomSelect value={line.wage_type} onChange={e => handleLineChange(idx, 'wage_type', e.target.value)} className={inputClass}>
                        <option value="LOADING">Loading</option>
                        <option value="UNLOADING">Unloading</option>
                      </CustomSelect>
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Work Date</label>
                      <CustomDatePicker value={line.work_date} onChange={e => handleLineChange(idx, 'work_date', e.target.value)} className={inputClass} />
                    </div>
                  </div>
                  <div className="mb-2">
                    <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Contractor / Labour Vendor <span className="text-red-500">*</span></label>
                    <CustomSelect required value={line.contractor} onChange={e => handleLineChange(idx, 'contractor', e.target.value)} className={inputClass}>
                      <option value="">Select Contractor / Labour Vendor</option>
                      {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">{wageQtyLabel}</label>
                      <input type="number" step="0.01" min="0" value={line.tons} onChange={e => handleLineChange(idx, 'tons', e.target.value)} className={inputClass} placeholder="0.00" />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">{wageCostLabel}</label>
                      <input type="number" step="0.01" min="0" value={line.cost_per_ton} onChange={e => handleLineChange(idx, 'cost_per_ton', e.target.value)} className={inputClass} placeholder="0.00" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Amount</label>
                      <input type="text" readOnly value={fmt(parseFloat(line.amount) || 0)} className={`${readOnlyClass} text-right font-medium`} />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Advance</label>
                      <input type="number" step="0.01" min="0" value={line.advance_paid} onChange={e => handleLineChange(idx, 'advance_paid', e.target.value)} className={inputClass} placeholder="0.00" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Remarks</label>
                    <input type="text" value={line.remarks} onChange={e => handleLineChange(idx, 'remarks', e.target.value)} className={inputClass} placeholder="Notes..." />
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-primary-50 border-b-2 border-slate-300">
                    <th className="text-left px-3 py-2 font-medium text-slate-600 w-10">#</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Type <span className="text-red-500">*</span></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Contractor / Labour Vendor <span className="text-red-500">*</span></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Work Date</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">{wageQtyLabel}</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">{wageCostLabel}</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Amount</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Advance</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Remarks</th>
                    <th className="px-3 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => (
                    <tr key={idx} className="border-b">
                      <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <CustomSelect value={line.wage_type} onChange={e => handleLineChange(idx, 'wage_type', e.target.value)} className={inputClass} style={{ minWidth: '120px' }}>
                          <option value="LOADING">Loading</option>
                          <option value="UNLOADING">Unloading</option>
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        <CustomSelect required value={line.contractor} onChange={e => handleLineChange(idx, 'contractor', e.target.value)} className={inputClass} style={{ minWidth: '160px' }}>
                          <option value="">Select Contractor / Labour Vendor</option>
                          {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        <CustomDatePicker value={line.work_date} onChange={e => handleLineChange(idx, 'work_date', e.target.value)} className={inputClass} style={{ minWidth: '130px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" step="0.01" min="0" value={line.tons} onChange={e => handleLineChange(idx, 'tons', e.target.value)} className={inputClass} style={{ minWidth: '90px' }} placeholder="0.00" />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" step="0.01" min="0" value={line.cost_per_ton} onChange={e => handleLineChange(idx, 'cost_per_ton', e.target.value)} className={inputClass} style={{ minWidth: '90px' }} placeholder="0.00" />
                      </td>
                      <td className="px-3 py-2">
                        <input type="text" readOnly value={fmt(parseFloat(line.amount) || 0)} className={`${readOnlyClass} text-right font-medium`} style={{ minWidth: '110px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" step="0.01" min="0" value={line.advance_paid} onChange={e => handleLineChange(idx, 'advance_paid', e.target.value)} className={inputClass} style={{ minWidth: '90px' }} placeholder="0.00" />
                      </td>
                      <td className="px-3 py-2">
                        <input type="text" value={line.remarks} onChange={e => handleLineChange(idx, 'remarks', e.target.value)} className={inputClass} style={{ minWidth: '120px' }} placeholder="Notes..." />
                      </td>
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => removeLine(idx)} disabled={lines.length <= 1} className="text-red-500 hover:text-red-700 disabled:opacity-30"><Trash2 size={16} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals block */}
            <div className="mt-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                <p className="text-xs uppercase tracking-wide text-slate-500">Loading Amount</p>
                <p className="text-lg font-bold text-slate-800 mt-1">{fmt(loadingAmount)}</p>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                <p className="text-xs uppercase tracking-wide text-slate-500">Unloading Amount</p>
                <p className="text-lg font-bold text-slate-800 mt-1">{fmt(unloadingAmount)}</p>
              </div>
              <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
                <p className="text-xs uppercase tracking-wide text-blue-600">Total Wages</p>
                <p className="text-lg font-bold text-blue-800 mt-1">{fmt(totalAmount)}</p>
              </div>
              <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
                <p className="text-xs uppercase tracking-wide text-amber-700">Advance Paid</p>
                <p className="text-lg font-bold text-amber-800 mt-1">{fmt(totalAdvance)}</p>
              </div>
              <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-200">
                <p className="text-xs uppercase tracking-wide text-emerald-700">Balance / Payable</p>
                <p className="text-lg font-bold text-emerald-800 mt-1">{fmt(totalBalance)}</p>
              </div>
            </div>
          </div>

          {/* Additional charges (shipping / courier / custom) */}
          <AdditionalCharges
            charges={additionalCharges}
            remarks={chargesRemarks}
            onChange={({ charges, remarks }) => { setAdditionalCharges(charges); setChargesRemarks(remarks); }}
          />

          {/* Remarks */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Additional Information</h3>
            <div>
              <label className={labelClass}>Overall Remarks</label>
              <textarea name="overall_remarks" value={formData.overall_remarks} onChange={handleChange} rows={4} className={inputClass} placeholder="General notes about this wage entry..." />
            </div>
          </div>

          {/* Receipt Attachments (inherited, only for PURCHASE_RECEIPT) */}
          {receiptAttachments.length > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <Paperclip size={16} className="text-blue-700" />
                <h3 className="text-sm font-semibold text-blue-900">
                  Receipt Advice Attachments ({receiptAttachments.length})
                </h3>
                <span className="text-xs text-blue-600">— inherited from linked GRN</span>
              </div>
              <div className="space-y-2">
                {receiptAttachments.map(f => {
                  const sizeKB = f.file_size ? (Number(f.file_size) / 1024).toFixed(1) : null;
                  return (
                    <div key={f.id} className="flex items-center gap-3 p-2.5 bg-white border border-blue-200 rounded">
                      <div className="w-8 h-8 rounded bg-blue-100 flex items-center justify-center flex-shrink-0">
                        <FileText size={14} className="text-blue-700" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate" title={f.file_name}>{f.file_name}</p>
                        <p className="text-xs text-slate-500">
                          Receipt{f.file_type ? ` • ${f.file_type}` : ''}{sizeKB ? ` • ${sizeKB} KB` : ''}
                        </p>
                      </div>
                      <a href={f.file} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 bg-primary-600 text-white text-xs font-medium rounded hover:bg-primary-700">View</a>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <FileAttachments module="WAGE_ENTRY" recordId={null} onPendingChange={(files) => { pendingAttachmentsRef.current = files; setPendingAttachments(files); }} />

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/freight/wages')} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
              {isLoading ? 'Saving...' : 'Save Wage Entry'}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}

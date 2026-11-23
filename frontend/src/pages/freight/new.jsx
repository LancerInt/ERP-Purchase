import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import MainLayout from '../../components/layout/MainLayout';
import PageHeader from '../../components/common/PageHeader';
import apiClient from '../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../utils/formHelpers.js';
import useLookup from '../../hooks/useLookup.js';
import usePermissions from '../../hooks/usePermissions.js';
import EditGate from '../../components/common/EditGate.jsx';
import FileAttachments, { uploadPendingFiles } from '../purchase/components/FileAttachments';
import AdditionalCharges, { sumAddToTotal, chargesHaveValue } from '../../components/common/AdditionalCharges';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const labelClass = 'block text-sm font-medium text-slate-700 mb-1';
const readOnlyClass = `${inputClass} bg-slate-50 cursor-not-allowed`;

// The DC model stores freight_type as LOCAL / LINEHAUL, but the sales-freight
// model only accepts LOCAL_DRAYAGE / LINEHAUL. Map a DC's value onto a valid
// sales-freight choice so an autofilled "LOCAL" isn't rejected on save.
const toSalesFreightType = (v) => (v === 'LINEHAUL' ? 'LINEHAUL' : 'LOCAL_DRAYAGE');

export default function UnifiedFreightCreate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const pendingAttachmentsRef = useRef([]);
  const [receiptAttachments, setReceiptAttachments] = useState([]);

  // Mode is locked by the URL pathname — there is no in-page toggle:
  //   /freight/inward/new  → Inward  Freight (purchase / vendor → wh)
  //   /freight/outward/new → Outward Freight (sales    / wh → customer)
  // Legacy paths /freight/sales/new and /freight/new (with ?type=...) are
  // still honoured so older bookmarks keep working until callers migrate.
  const isOutwardRoute = location.pathname.startsWith('/freight/outward')
    || location.pathname.startsWith('/freight/sales');
  const legacyType = searchParams.get('type');
  const freightType = isOutwardRoute
    ? 'sales'
    : (legacyType === 'sales' ? 'sales' : 'purchase');
  const { canCreate } = usePermissions();
  const editable = canCreate(freightType === 'sales' ? 'Sales Freight' : 'Freight Advice');

  // ============ COMMON LOOKUPS ============
  // `fresh` so bank details just saved onto a transporter (per-transporter
  // saved bank details) are reflected immediately — the module cache would
  // otherwise serve a stale record without the new bank fields. The label
  // shows the beneficiary name next to the transporter, so the operator can
  // see who actually gets paid when picking a transporter.
  const { options: transporterOptions, raw: transporterRaw } = useLookup('/api/transporters/', {
    fresh: true,
    labelField: (t) => {
      const base = t.name || t.transporter_code || '';
      return t.beneficiary_name ? `${base} — ${t.beneficiary_name}` : base;
    },
  });
  const { options: companyOptions } = useLookup('/api/companies/');

  // ============ COMMON FORM DATA ============
  const [commonData, setCommonData] = useState({
    lorry_no: '',
    driver_name: '',
    driver_contact: '',
    transport_document_no: '',
    dispatch_date: '',
    expected_arrival_date: '',
    destination_state: '',
    remarks: '',
    delivery_remarks: '',
  });

  const handleCommonChange = (e) => {
    const { name, value } = e.target;
    setCommonData(prev => ({ ...prev, [name]: value }));
  };

  // Beneficiary bank details (common to inward & outward) — where the
  // transporter is paid. Kept in its own state so switching source documents,
  // which resets commonData, doesn't wipe what the user typed here.
  const [bankData, setBankData] = useState({ bank_name: '', ifsc_code: '', beneficiary_name: '', account_no: '' });
  const handleBankChange = (e) => {
    const { name, value } = e.target;
    setBankData(prev => ({ ...prev, [name]: value }));
  };
  // Per-transporter saved bank details: reuse the transporter master's saved
  // details (checkbox) or save freshly-entered ones back to it for next time.
  const [useSavedBank, setUseSavedBank] = useState(false);
  const [saveBankToTransporter, setSaveBankToTransporter] = useState(false);

  // ============ PURCHASE-SPECIFIC ============
  const { raw: receiptRaw, options: receiptLookupOptions } = useLookup('/api/purchase/receipts/');
  const { options: productOptions, raw: productRaw } = useLookup('/api/products/');

  // ============ SOURCE TYPE (within Purchase Inbound) ============
  // PURCHASE_RECEIPT (default, existing flow) | INVENTORY_TRANSFER | INVENTORY_SHIFTING | SALES_DISPATCH_CHALLAN
  const [sourceType, setSourceType] = useState('PURCHASE_RECEIPT');
  const { raw: transferRaw } = useLookup('/api/inventory/transfers/');
  const { raw: shiftingRaw } = useLookup('/api/inventory/shifting/');
  const { raw: dispatchChallanRaw } = useLookup('/api/sales/dc/');

  // Receipts / transfers / shifting / DCs already used by existing freights →
  // hide them so one source can't accidentally be double-billed.
  const [usedTransferIds, setUsedTransferIds] = useState(new Set());
  const [usedShiftingIds, setUsedShiftingIds] = useState(new Set());
  const [usedDispatchChallanIds, setUsedDispatchChallanIds] = useState(new Set());
  useEffect(() => {
    apiClient.get('/api/purchase/freight/', { params: { page_size: 500 } })
      .then(res => {
        const freights = res.data?.results || res.data || [];
        const liveFreights = freights.filter(f => f.status !== 'CANCELLED');
        setUsedTransferIds(new Set(liveFreights.filter(f => f.transfer_source).map(f => f.transfer_source)));
        setUsedShiftingIds(new Set(liveFreights.filter(f => f.shifting_source).map(f => f.shifting_source)));
        setUsedDispatchChallanIds(new Set(liveFreights.filter(f => f.dispatch_challan_source).map(f => f.dispatch_challan_source)));
      })
      .catch(() => {});
  }, []);

  const transferOptions = (transferRaw || [])
    .filter(t => !usedTransferIds.has(t.id))
    .map(t => ({ value: t.id, label: `${t.transfer_no}${t.from_warehouse_name ? ' · ' + t.from_warehouse_name : ''}${t.to_warehouse_name ? ' → ' + t.to_warehouse_name : ''}` }));
  const shiftingOptions = (shiftingRaw || [])
    .filter(s => !usedShiftingIds.has(s.id))
    .map(s => ({ value: s.id, label: `${s.shifting_no}${s.warehouse_name ? ' · ' + s.warehouse_name : ''}${s.from_godown_name ? ' · ' + s.from_godown_name + ' → ' + (s.to_godown_name || '?') : ''}` }));
  const dispatchChallanOptions = (dispatchChallanRaw || [])
    .filter(d => !usedDispatchChallanIds.has(d.id))
    .map(d => ({ value: d.id, label: `${d.dc_no}${d.customer_name ? ' · ' + d.customer_name : ''}${d.destination ? ' → ' + d.destination : ''}` }));

  // Track receipts already used by existing freights — exclude them from dropdown
  const [usedReceiptIds, setUsedReceiptIds] = useState(new Set());
  useEffect(() => {
    apiClient.get('/api/purchase/freight/', { params: { page_size: 500 } })
      .then(res => {
        const freights = res.data?.results || res.data || [];
        // Exclude receipts whose freight is in any state OTHER than CANCELLED
        const used = new Set(
          freights
            .filter(f => f.receipt_advice && f.status !== 'CANCELLED')
            .map(f => f.receipt_advice)
        );
        setUsedReceiptIds(used);
      })
      .catch(() => {});
  }, []);

  const receiptOptions = receiptRaw
    .filter(r => !usedReceiptIds.has(r.id))
    .map(r => ({ value: r.id, label: r.receipt_advice_no }));

  const [purchaseData, setPurchaseData] = useState({
    receipt_advice: '',
    transfer_source: '',
    shifting_source: '',
    dispatch_challan_source: '',
    status: 'DRAFT',
    discount: '0',
    mmul_less: '0',
    mmul_sign: 'LESS',
    tds_less: '0',
    less_amount: '0',
    less_amount_sign: 'LESS',
    quantity_basis: '',
    quantity_uom: '',
    // Header-level freight date — defaults to today; user can override.
    freight_date: new Date().toISOString().split('T')[0],
  });
  // Additional charges shared across purchase/sales modes (only one is active).
  const [additionalCharges, setAdditionalCharges] = useState([]);
  const [chargesRemarks, setChargesRemarks] = useState('');
  const [receiptInfo, setReceiptInfo] = useState(null);
  const [freightRows, setFreightRows] = useState([]);
  const [lineItems, setLineItems] = useState([]);
  // Quantity limits from receipt and PO
  const [receiptTotalQty, setReceiptTotalQty] = useState(0);
  const [poTotalQty, setPoTotalQty] = useState(0);
  const allowedQty = poTotalQty > 0 ? Math.min(receiptTotalQty, poTotalQty) : receiptTotalQty;

  const emptyFreightRow = {
    freight_type: 'LOCAL_DRAYAGE', transporter: '', freight_terms: 'TO_PAY',
    calc_type: 'QTY_WISE',
    quantity: '', charge: '',
    num_lorries: '', charge_per_lorry: '', lorry_nos: [],
    manual_amount: '',
    payable_by: 'COMPANY', origin: '', uom: 'KG', remarks: '',
  };

  // Auto-fill from receipt_id query param
  useEffect(() => {
    const receiptId = searchParams.get('receipt_id');
    if (receiptId && freightType === 'purchase') {
      setPurchaseData(prev => ({ ...prev, receipt_advice: receiptId }));
      loadReceiptData(receiptId);
    }
  }, [searchParams]);

  // Keep Quantity Basis (Cost Details) and the first Freight Row's quantity in sync
  // with the sum of line item quantities. This ensures changing the line qty propagates
  // to all dependent fields so amounts compute correctly.
  useEffect(() => {
    if (!lineItems || lineItems.length === 0) return;
    const totalQty = lineItems.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0);
    if (totalQty <= 0) return;
    const totalQtyStr = String(totalQty);
    setPurchaseData(prev => prev.quantity_basis === totalQtyStr ? prev : { ...prev, quantity_basis: totalQtyStr });
    setFreightRows(prev => {
      if (prev.length === 0) return prev;
      const first = prev[0];
      if (String(first.quantity || '') === totalQtyStr) return prev;
      return prev.map((r, i) => i === 0 ? { ...r, quantity: totalQtyStr } : r);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineItems]);

  // Rate field is always mirrored from the first Freight Row's Charge/Unit.
  // Whenever Charge/Unit changes (including being cleared/zeroed), every line item's
  // Rate snaps to that value. Users can still manually edit Rate after, but the next
  // Charge/Unit change will override it again. This keeps cost calculations consistent.
  const firstFreightCharge = freightRows[0]?.charge;
  useEffect(() => {
    const chargeStr = (firstFreightCharge === undefined || firstFreightCharge === null)
      ? ''
      : String(firstFreightCharge);
    setLineItems(prev => {
      if (!prev || prev.length === 0) return prev;
      let changed = false;
      const next = prev.map(l => {
        if (String(l.rate ?? '') !== chargeStr) {
          changed = true;
          return { ...l, rate: chargeStr };
        }
        return l;
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstFreightCharge]);

  const loadReceiptData = async (receiptId) => {
    try {
      const res = await apiClient.get(`/api/purchase/receipts/${receiptId}/`);
      const r = res.data;
      setReceiptInfo(r);
      const allFreight = r.freight_details || [];
      const firstFreight = allFreight[0] || {};
      // Auto-fill Transport Details from the receipt (header) + first freight row
      // where available. Leave blanks when the source has no value rather than
      // forcing empty strings — but for receipt the header is authoritative so
      // we overwrite. Fields the receipt doesn't carry are reset to '' so a
      // prior source's data does not leak across selections.
      setCommonData({
        lorry_no: r.vehicle_number || firstFreight.lorry_no || '',
        driver_name: r.driver_name || '',
        // Receipt stores the driver's number as `driver_phone`; the freight
        // detail row calls it `driver_contact`. Read the receipt field first.
        driver_contact: r.driver_phone || r.driver_contact || firstFreight.driver_contact || '',
        transport_document_no: r.transport_document_no || firstFreight.transport_document_no || '',
        destination_state: firstFreight.destination_state || r.destination_state || '',
        dispatch_date: r.dispatch_date || firstFreight.dispatch_date || '',
        expected_arrival_date: r.expected_arrival_date || firstFreight.expected_arrival_date || '',
        delivery_remarks: r.delivery_remarks || firstFreight.delivery_remarks || '',
        remarks: r.remarks || '',
      });

      // Calculate receipt total qty
      const totalReceivedQty = (r.receipt_lines || []).reduce((s, l) => s + (parseFloat(l.quantity_received) || 0), 0);
      setReceiptTotalQty(totalReceivedQty);

      // Calculate PO total qty from linked POs
      const linkedPoIds = r.linked_pos || [];
      let totalPoQty = 0;
      for (const poId of linkedPoIds) {
        try {
          const poRes = await apiClient.get(`/api/purchase/orders/${poId}/`);
          const poData = poRes.data;
          totalPoQty += (poData.po_lines || []).reduce((s, l) => s + (parseFloat(l.quantity_ordered) || 0), 0);
        } catch { /* ignore */ }
      }
      setPoTotalQty(totalPoQty);

      setPurchaseData(prev => ({
        ...prev,
        receipt_advice: receiptId,
        quantity_basis: r.total_received || '',
        quantity_uom: (r.receipt_lines || [])[0]?.uom || '',
      }));
      if (allFreight.length > 0) {
        setFreightRows(allFreight.map(fd => ({
          ...emptyFreightRow,
          freight_type: fd.freight_type || 'LOCAL_DRAYAGE',
          transporter: fd.transporter || '',
          freight_terms: fd.freight_terms || 'TO_PAY',
          calc_type: 'QTY_WISE',
          quantity: fd.quantity_basis || totalReceivedQty || '',
          charge: fd.tentative_charge || '',
          payable_by: fd.payable_by || 'COMPANY',
          origin: fd.destination_state || '',
          uom: fd.quantity_uom || (r.receipt_lines || [])[0]?.uom || 'KG',
          remarks: '',
        })));
      } else {
        setFreightRows([{
          ...emptyFreightRow,
          quantity: totalReceivedQty || '',
          uom: (r.receipt_lines || [])[0]?.uom || 'KG',
        }]);
      }
      const receiptLines = r.receipt_lines || [];
      if (receiptLines.length > 0) {
        setLineItems(receiptLines.map(l => ({
          product: l.product || '', product_name: l.product_name || '',
          quantity: l.quantity_received || '', uom: l.uom || 'KG',
          batch_no: l.batch_no || '', rate: '', freight_amount: '', remarks: '',
        })));
      }
      // Fetch receipt attachments
      apiClient.get(`/api/purchase/attachments/?module=RECEIPT&record_id=${receiptId}`)
        .then(aRes => setReceiptAttachments(aRes.data?.results || aRes.data || []))
        .catch(() => setReceiptAttachments([]));
    } catch { setReceiptInfo(null); setFreightRows([]); setLineItems([]); setReceiptAttachments([]); }
  };

  const handleReceiptChange = (e) => {
    const val = e.target.value;
    setPurchaseData(prev => ({ ...prev, receipt_advice: val }));
    if (val) loadReceiptData(val);
    else { setReceiptInfo(null); setLineItems([]); setFreightRows([]); setReceiptTotalQty(0); setPoTotalQty(0); }
  };

  // ── Load Transfer source ─────────────────────────────────────────────
  const loadTransferData = async (transferId) => {
    try {
      const res = await apiClient.get(`/api/inventory/transfers/${transferId}/`);
      const t = res.data;
      // Auto-fill Transport Details from the transfer header. The transfer model
      // currently only carries dispatch_date (no lorry/driver/LR/state/etc.), so
      // reset the rest to '' to avoid leaking values from a prior source pick.
      setCommonData({
        lorry_no: t.vehicle_no || t.lorry_no || '',
        driver_name: t.driver_name || '',
        driver_contact: t.driver_contact || '',
        transport_document_no: t.lr_no || t.transport_document_no || '',
        destination_state: t.destination_state || '',
        dispatch_date: t.dispatch_date || t.transfer_date || '',
        expected_arrival_date: t.expected_arrival_date || '',
        delivery_remarks: t.delivery_remarks || '',
        remarks: t.remarks || '',
      });
      // Seed line items from transfer lines for quantity-basis reference.
      const lines = (t.lines || []).map((l) => {
        const productName = l.product_name || productRaw?.find?.(p => String(p.id) === String(l.product))?.product_name || '';
        return {
          product: l.product || '',
          product_name: productName,
          quantity: l.quantity || 0,
          uom: l.uom || 'KG',
          batch_no: l.batch || '',
          rate: '',
          remarks: '',
        };
      });
      setLineItems(lines);
      setReceiptInfo({ _source: 'TRANSFER', source_doc: t });
      // Quantity basis: sum of dispatched line qty.
      const totalQty = lines.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0);
      setPurchaseData(prev => ({ ...prev, quantity_basis: String(totalQty), quantity_uom: lines[0]?.uom || 'KG' }));
      // If transfer header carries a transporter / wages, surface as a default freight row.
      if (t.transporter || t.loading_wages || t.freight_amount) {
        const qty = totalQty || 0;
        const headerAmount = parseFloat(t.freight_amount) || 0;
        const charge = qty > 0 && headerAmount > 0 ? (headerAmount / qty).toFixed(4) : '';
        setFreightRows([{
          ...emptyFreightRow,
          transporter: t.transporter || '',
          freight_type: 'LOCAL_DRAYAGE',
          freight_terms: t.freight_terms || 'TO_PAY',
          calc_type: 'QTY_WISE',
          quantity: String(qty || ''),
          charge,
          uom: lines[0]?.uom || 'KG',
          payable_by: 'COMPANY',
        }]);
      }
      setReceiptTotalQty(totalQty);
      setPoTotalQty(0);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load transfer');
      setReceiptInfo(null);
      setLineItems([]);
    }
  };

  // ── Load Shifting source ─────────────────────────────────────────────
  const loadShiftingData = async (shiftingId) => {
    try {
      const res = await apiClient.get(`/api/inventory/shifting/${shiftingId}/`);
      const s = res.data;
      // Shifting is intra-warehouse and doesn't carry transport fields, so
      // reset Transport Details — defensively pull anything the API may expose,
      // otherwise blank. dispatch_date falls back to the shifting request date.
      setCommonData({
        lorry_no: s.vehicle_no || s.lorry_no || '',
        driver_name: s.driver_name || '',
        driver_contact: s.driver_contact || '',
        transport_document_no: s.lr_no || s.transport_document_no || '',
        destination_state: s.destination_state || '',
        dispatch_date: s.dispatch_date || s.request_date || '',
        expected_arrival_date: s.expected_arrival_date || '',
        delivery_remarks: s.delivery_remarks || '',
        remarks: s.remarks || '',
      });
      const lines = (s.products || []).map((p) => {
        const productName = p.product_name || productRaw?.find?.(x => String(x.id) === String(p.product))?.product_name || '';
        return {
          product: p.product || '',
          product_name: productName,
          quantity: p.quantity || 0,
          uom: p.uom || 'KG',
          batch_no: p.batch || '',
          rate: '',
          remarks: '',
        };
      });
      setLineItems(lines);
      setReceiptInfo({ _source: 'SHIFTING', source_doc: s });
      const totalQty = lines.reduce((sum, l) => sum + (parseFloat(l.quantity) || 0), 0);
      setPurchaseData(prev => ({ ...prev, quantity_basis: String(totalQty), quantity_uom: lines[0]?.uom || 'KG' }));
      // Shifting has no freight info on the source doc — seed one blank freight
      // row pre-filled with quantity & uom so the user can type the charge.
      setFreightRows([{
        ...emptyFreightRow,
        calc_type: 'QTY_WISE',
        quantity: String(totalQty || ''),
        uom: lines[0]?.uom || 'KG',
        payable_by: 'COMPANY',
        freight_terms: 'TO_PAY',
      }]);
      setReceiptTotalQty(totalQty);
      setPoTotalQty(0);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load shifting');
      setReceiptInfo(null);
      setLineItems([]);
    }
  };

  // ── Load Dispatch Challan source ─────────────────────────────────────
  const loadDispatchChallanData = async (dcId) => {
    try {
      const res = await apiClient.get(`/api/sales/dc/${dcId}/`);
      const d = res.data;
      // Auto-fill Transport Details from the DC header.
      setCommonData({
        lorry_no: d.lorry_no || d.vehicle_no || '',
        driver_name: d.driver_name || '',
        driver_contact: d.driver_contact || '',
        transport_document_no: d.lr_no || d.transport_document_no || d.invoice_no || '',
        destination_state: (d.destination || '').split(',').pop().trim() || '',
        dispatch_date: d.dispatch_date ? String(d.dispatch_date).split('T')[0] : '',
        expected_arrival_date: d.expected_arrival_date || '',
        delivery_remarks: d.delivery_remarks || '',
        remarks: d.remarks || '',
      });
      const lines = (d.dc_lines || []).map((l) => {
        const productName = l.product_name || l.product_sku || productRaw?.find?.(p => String(p.id) === String(l.product))?.product_name || '';
        return {
          product: l.product || '',
          product_name: productName,
          quantity: l.quantity_dispatched || 0,
          uom: l.uom || 'KG',
          batch_no: l.batch_no || '',
          rate: '',
          remarks: '',
        };
      });
      setLineItems(lines);
      setReceiptInfo({ _source: 'DISPATCH_CHALLAN', source_doc: d });
      const totalQty = lines.reduce((sum, l) => sum + (parseFloat(l.quantity) || 0), 0);
      setPurchaseData(prev => ({ ...prev, quantity_basis: String(totalQty), quantity_uom: lines[0]?.uom || 'KG' }));
      // Seed one freight row pre-filled with DC's freight info if any.
      const headerFreight = parseFloat(d.freight_amount_total) || 0;
      const headerRate = parseFloat(d.freight_rate_value) || 0;
      setFreightRows([{
        ...emptyFreightRow,
        transporter: d.transporter || '',
        freight_type: d.freight_type === 'LINEHAUL' ? 'LINEHAUL' : 'LOCAL_DRAYAGE',
        freight_terms: d.freight_terms || 'TO_PAY',
        calc_type: headerRate > 0 ? 'QTY_WISE' : (headerFreight > 0 ? 'MANUAL' : 'QTY_WISE'),
        quantity: String(totalQty || ''),
        charge: headerRate > 0 ? String(headerRate) : '',
        manual_amount: headerFreight > 0 && headerRate <= 0 ? String(headerFreight) : '',
        uom: lines[0]?.uom || 'KG',
        payable_by: 'COMPANY',
      }]);
      setReceiptTotalQty(totalQty);
      setPoTotalQty(0);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load dispatch challan');
      setReceiptInfo(null);
      setLineItems([]);
    }
  };

  const handleTransferChange = (e) => {
    const val = e.target.value;
    setPurchaseData(prev => ({ ...prev, transfer_source: val, receipt_advice: '', shifting_source: '', dispatch_challan_source: '' }));
    if (val) loadTransferData(val);
    else { setReceiptInfo(null); setLineItems([]); setFreightRows([]); setReceiptTotalQty(0); setPoTotalQty(0); }
  };

  const handleShiftingChange = (e) => {
    const val = e.target.value;
    setPurchaseData(prev => ({ ...prev, shifting_source: val, receipt_advice: '', transfer_source: '', dispatch_challan_source: '' }));
    if (val) loadShiftingData(val);
    else { setReceiptInfo(null); setLineItems([]); setFreightRows([]); setReceiptTotalQty(0); setPoTotalQty(0); }
  };

  const handleDispatchChallanChange = (e) => {
    const val = e.target.value;
    setPurchaseData(prev => ({ ...prev, dispatch_challan_source: val, receipt_advice: '', transfer_source: '', shifting_source: '' }));
    if (val) loadDispatchChallanData(val);
    else { setReceiptInfo(null); setLineItems([]); setFreightRows([]); setReceiptTotalQty(0); setPoTotalQty(0); }
  };

  // Clear the other-source FKs whenever Source Type switches. Also reset
  // Transport Details so stale fields from the previous source don't linger.
  const handleSourceTypeChange = (newType) => {
    setSourceType(newType);
    setPurchaseData(prev => ({ ...prev, receipt_advice: '', transfer_source: '', shifting_source: '', dispatch_challan_source: '' }));
    setReceiptInfo(null);
    setLineItems([]);
    setFreightRows([]);
    setReceiptAttachments([]);
    setReceiptTotalQty(0);
    setPoTotalQty(0);
    setCommonData({
      lorry_no: '',
      driver_name: '',
      driver_contact: '',
      transport_document_no: '',
      destination_state: '',
      dispatch_date: '',
      expected_arrival_date: '',
      delivery_remarks: '',
      remarks: '',
    });
  };

  const addFreightRow = () => {
    const uom = lineItems[0]?.uom || 'KG';
    setFreightRows(prev => [...prev, { ...emptyFreightRow, uom }]);
  };
  const removeFreightRow = (i) => { if (freightRows.length > 1) setFreightRows(prev => prev.filter((_, idx) => idx !== i)); };
  const handleFreightRowChange = (i, field, value) => {
    // Validate quantity against receipt/PO limits
    if (field === 'quantity' && allowedQty > 0) {
      const enteredQty = parseFloat(value) || 0;
      if (enteredQty > allowedQty) {
        toast.error(
          `Freight quantity (${enteredQty}) exceeds allowed quantity (${allowedQty}). ` +
          `Freight quantity cannot be greater than the Receipt or Purchase Order quantity.`
        );
        return;
      }
      if (enteredQty < 0) {
        toast.error('Quantity must be greater than 0.');
        return;
      }
    }
    setFreightRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r));
  };

  const addLineItem = () => {
    setLineItems(prev => [...prev, { product: '', product_name: '', quantity: '', uom: 'KG', batch_no: '', rate: '', freight_amount: '', remarks: '' }]);
  };
  const removeLineItem = (i) => { if (lineItems.length > 1) setLineItems(prev => prev.filter((_, idx) => idx !== i)); };
  const handleLineChange = (i, field, value) => {
    // Validate line item quantity against receipt line quantity
    if (field === 'quantity') {
      const enteredQty = parseFloat(value) || 0;
      if (enteredQty < 0) {
        toast.error('Quantity must be greater than 0.');
        return;
      }
      // Check against the original receipt line quantity for this product
      if (receiptInfo && receiptInfo.receipt_lines) {
        const receiptLine = receiptInfo.receipt_lines[i];
        if (receiptLine) {
          const maxQty = parseFloat(receiptLine.quantity_received) || 0;
          if (maxQty > 0 && enteredQty > maxQty) {
            toast.error(
              `Line quantity (${enteredQty}) exceeds receipt quantity (${maxQty}). ` +
              `Freight quantity cannot be greater than the Receipt or Purchase Order quantity.`
            );
            return;
          }
        }
      }
    }
    // When the product changes, auto-fill the UOM from the Product master
    // so the operator doesn't have to type the unit for every added line.
    if (field === 'product') {
      const prod = productRaw?.find?.(p => String(p.id) === String(value));
      setLineItems(prev => prev.map((l, idx) => idx === i
        ? { ...l, product: value, uom: prod?.uom || l.uom || 'KG' }
        : l));
      return;
    }
    setLineItems(prev => prev.map((l, idx) => idx === i ? { ...l, [field]: value } : l));
  };

  // Calculate freight amount per row based on calc_type
  const getRowAmount = (r) => {
    const ct = r.calc_type || 'QTY_WISE';
    if (ct === 'QTY_WISE') return (parseFloat(r.quantity) || 0) * (parseFloat(r.charge) || 0);
    if (ct === 'LORRY_WISE') return (parseFloat(r.num_lorries) || 0) * (parseFloat(r.charge_per_lorry) || 0);
    if (ct === 'MANUAL') return parseFloat(r.manual_amount) || 0;
    return 0;
  };

  // Purchase calculations.
  // The freight Base Amount is the sum of the freight rows — these come
  // pre-filled from the linked receipt's freight_details (tentative charges),
  // so "freight value autofilled from the receipt" happens automatically. Only
  // when there are no freight-row charges do we fall back to the line items'
  // (qty * rate) for manual entry.
  const lineItemsBaseAmt = lineItems.reduce((s, l) => {
    const qty = parseFloat(l.quantity) || 0;
    const rate = parseFloat(l.rate) || 0;
    return s + (qty * rate);
  }, 0);
  const freightRowsBaseAmt = freightRows.reduce((s, r) => s + getRowAmount(r), 0);
  const purchaseBaseAmt = freightRowsBaseAmt > 0 ? freightRowsBaseAmt : lineItemsBaseAmt;
  const purchaseDiscountPct = parseFloat(purchaseData.discount) || 0;
  const purchaseDiscountedBase = purchaseBaseAmt - (purchaseBaseAmt * purchaseDiscountPct / 100);
  // Mamul & "less" apply with their sign (PLUS adds, LESS subtracts); TDS
  // always subtracts; add-to-total extra charges add.
  const purchaseMamul = (parseFloat(purchaseData.mmul_less) || 0) * (purchaseData.mmul_sign === 'PLUS' ? 1 : -1);
  const purchaseLess = (parseFloat(purchaseData.less_amount) || 0) * (purchaseData.less_amount_sign === 'PLUS' ? 1 : -1);
  const purchaseChargesTotal = sumAddToTotal(additionalCharges);
  const purchasePayable = purchaseDiscountedBase + purchaseMamul + purchaseLess - (parseFloat(purchaseData.tds_less) || 0) + purchaseChargesTotal;
  // Net amount deducted (informational breakdown note); positive = net less.
  const purchaseTotalDeductions = (parseFloat(purchaseData.tds_less) || 0) - purchaseMamul - purchaseLess;

  // ============ SALES-SPECIFIC ============
  const [salesData, setSalesData] = useState({
    freight_detail: '',
    transporter: '',
    freight_date: new Date().toISOString().split('T')[0],
    customer_name: '',
    base_amount: '',
    discount: '0',
    mmul_less: '0',
    mmul_sign: 'LESS',
    tds_less: '0',
    less_amount: '0',
    less_amount_sign: 'LESS',
    // Sales-order fields (from Freight Details)
    company: '',
    factory: '',
    customer: '',
    freight_type: '',
    additional_freight: '0',
    destination: '',
  });
  const [freightDetailOptions, setFreightDetailOptions] = useState([]);
  const [dcLinks, setDcLinks] = useState([{ dc: '', invoice_no: '', destination: '', products: [] }]);
  const [allDCs, setAllDCs] = useState([]);
  const [allDCsRaw, setAllDCsRaw] = useState([]);
  const [salesFreightNo, setSalesFreightNo] = useState('');
  const [salesFilteredCustomers, setSalesFilteredCustomers] = useState([]);
  const { options: salesWarehouseOptions } = useLookup(salesData.company ? `/api/warehouses/?company=${salesData.company}&scope=true` : null);

  // ── Per-transporter saved bank details ───────────────────────────────
  // The chosen transporter is the sales transporter (outward) or the first
  // freight row's transporter (inward). When it has bank details saved on its
  // master record, offer a checkbox to reuse them; otherwise offer to save the
  // entered details back to the transporter for next time.
  const selectedTransporterId = freightType === 'sales'
    ? salesData.transporter
    : (freightRows[0]?.transporter || '');
  const transporterRecord = (transporterRaw || []).find(t => String(t.id) === String(selectedTransporterId)) || null;
  // Plain transporter name (not the option label, which now also carries the
  // beneficiary) for the "Use … / Save …" helper text below.
  const selectedTransporterName = transporterRecord?.name || transporterRecord?.transporter_code || 'this transporter';
  const savedBankHasData = !!(transporterRecord && (transporterRecord.bank_name || transporterRecord.ifsc_code || transporterRecord.beneficiary_name || transporterRecord.account_no));

  const fillBankFromTransporter = () => setBankData({
    bank_name: transporterRecord?.bank_name || '',
    ifsc_code: transporterRecord?.ifsc_code || '',
    beneficiary_name: transporterRecord?.beneficiary_name || '',
    account_no: transporterRecord?.account_no || '',
  });

  // When the chosen transporter (or its loaded record) changes: if it has
  // saved bank details, tick "use saved" and preload them; else default to
  // "save to transporter".
  useEffect(() => {
    if (!selectedTransporterId) { setUseSavedBank(false); setSaveBankToTransporter(false); return; }
    if (savedBankHasData) {
      setUseSavedBank(true);
      setSaveBankToTransporter(false);
      fillBankFromTransporter();
    } else {
      setUseSavedBank(false);
      setSaveBankToTransporter(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTransporterId, savedBankHasData]);

  const toggleUseSavedBank = (checked) => {
    setUseSavedBank(checked);
    if (checked) {
      fillBankFromTransporter();
      setSaveBankToTransporter(false);
    } else {
      // Switch to manual entry: clear the fields and offer to save the new ones.
      setBankData({ bank_name: '', ifsc_code: '', beneficiary_name: '', account_no: '' });
      setSaveBankToTransporter(true);
    }
  };

  // Best-effort: persist the entered bank details onto the transporter master
  // so they're remembered next time (never blocks freight creation).
  const persistBankToTransporter = async () => {
    const hasData = bankData.bank_name || bankData.ifsc_code || bankData.beneficiary_name || bankData.account_no;
    if (!saveBankToTransporter || !selectedTransporterId || !hasData) return;
    try { await apiClient.patch(`/api/transporters/${selectedTransporterId}/`, { ...bankData }); } catch { /* non-blocking */ }
  };

  // Load DC list — always via /available-dcs so DCs already linked to an
  // outward freight are excluded (no double-billing), whether or not a
  // customer is chosen. The endpoint excludes Ex-Factory and freighted DCs
  // server-side; customer_id just narrows it further. (Previously the
  // no-customer case fell back to the unfiltered /api/sales/dc/ list, which
  // kept showing already-freighted DCs.)
  const loadSalesDCs = (customerId) => {
    const url = customerId
      ? `/api/sales/freight-details/available-dcs/?customer_id=${customerId}`
      : '/api/sales/freight-details/available-dcs/';
    apiClient.get(url)
      .then(r => {
        const rawList = r.data?.results || r.data || [];
        const dcList = rawList.filter(d => d.delivery_terms !== 'EX_FACTORY');
        setAllDCsRaw(dcList);
        setAllDCs(dcList.map(d => ({ value: d.id, label: d.dc_no })));
        setFreightDetailOptions(
          dcList.filter(d => ['RELEASED', 'DELIVERED'].includes(d.status)).map(d => ({
            value: d.id,
            label: [d.dc_no, d.customer_name || d.customer_display, d.destination].filter(Boolean).join(' - '),
            company: d.company || null,
            warehouse: d.warehouse || null,
            transporter: d.transporter || null,
            lorry_no: (d.lorry_no || '').trim().toUpperCase() || null,
          }))
        );
      })
      .catch(() => { setAllDCs([]); setFreightDetailOptions([]); });
  };

  useEffect(() => {
    if (freightType === 'sales') {
      loadSalesDCs(salesData.customer);
      // Auto-generate next freight number
      apiClient.get('/api/sales/freight-details/next-number/')
        .then(r => setSalesFreightNo(r.data?.number || ''))
        .catch(() => setSalesFreightNo(''));
    }
  }, [freightType]);

  // Auto-fill from dc_id query param (sales outbound)
  useEffect(() => {
    const dcId = searchParams.get('dc_id');
    if (dcId && freightType === 'sales') {
      autofillFromDC(dcId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, freightType]);

  const autofillFromDC = async (dcId) => {
    try {
      const dcRes = await apiClient.get(`/api/sales/dc/${dcId}/`);
      const dc = dcRes.data;

      let so = null;
      if (dc.linked_so_id) {
        try {
          const soRes = await apiClient.get(`/api/sales/orders/${dc.linked_so_id}/`);
          so = soRes.data;
        } catch { /* ignore */ }
      }

      const companyId = so?.company || '';
      const customerId = so?.customer || '';
      const factoryId = so?.warehouse || dc.warehouse || '';
      const uom = (dc.dc_lines || [])[0]?.uom || 'MTS';

      const prods = (dc.dc_lines || []).map(l => ({
        name: l.product_name || l.product_sku || '',
        qty: l.quantity_dispatched || 0,
        uom: l.uom || '',
      }));

      const destStateOnly = (dc.destination || '').split(',').pop().trim();

      setSalesData(prev => ({
        ...prev,
        company: companyId,
        factory: factoryId,
        customer: customerId,
        customer_name: dc.customer_name || so?.customer_name || prev.customer_name,
        transporter: dc.transporter || prev.transporter,
        freight_date: prev.freight_date || new Date().toISOString().split('T')[0],
        destination: dc.destination || '',
        freight_type: dc.freight_type ? toSalesFreightType(dc.freight_type) : prev.freight_type,
      }));

      setCommonData(prev => ({
        ...prev,
        lorry_no: dc.lorry_no || '',
        driver_contact: dc.driver_contact || '',
        destination_state: destStateOnly,
      }));

      if (companyId) {
        apiClient.get(`/api/customers/?company=${companyId}`)
          .then(r => {
            const list = r.data?.results || r.data || [];
            setSalesFilteredCustomers(list.map(c => ({
              value: c.id,
              label: c.customer_name || c.name || c.customer_code || c.id,
            })));
          }).catch(() => {});
      }

      loadSalesDCs(customerId);

      setSelectedDCIds([dcId]);
      const dcQty = (dc.dc_lines || []).reduce((s, l) => s + (parseFloat(l.quantity_dispatched) || 0), 0);
      setDcLinks([{
        dc: dcId,
        invoice_no: dc.invoice_no || '',
        invoice_date: dc.invoice_date || '',
        destination: dc.destination || '',
        products: prods,
        freight_rate: dc.freight_rate_value ? String(dc.freight_rate_value) : '0',
        uom: uom,
        quantity: dcQty,
      }]);
    } catch {
      toast.error('Failed to load DC details');
    }
  };

  const handleSalesChange = (e) => {
    const { name, value, type, checked } = e.target;
    const val = type === 'checkbox' ? checked : value;
    setSalesData(prev => ({ ...prev, [name]: val }));

    // Company cascade: fetch customers for selected company, reset factory/customer
    if (name === 'company') {
      setSalesData(prev => ({ ...prev, company: value, factory: '', customer: '', customer_name: '' }));
      setSalesFilteredCustomers([]);
      setSelectedDCIds([]);
      setDcLinks([{ dc: '', invoice_no: '', destination: '', products: [] }]);
      if (value) {
        apiClient.get(`/api/customers/?company=${value}`)
          .then(r => {
            const list = r.data?.results || r.data || [];
            setSalesFilteredCustomers(list.map(c => ({ value: c.id, label: c.customer_name || c.name || c.customer_code || c.id })));
          }).catch(() => setSalesFilteredCustomers([]));
      }
    }
    // Customer change: filter available DCs to this customer
    if (name === 'customer') {
      setSelectedDCIds([]);
      setDcLinks([{ dc: '', invoice_no: '', destination: '', products: [] }]);
      loadSalesDCs(value);
      // Auto-fill customer_name display from selected option
      const selected = salesFilteredCustomers.find(c => String(c.value) === String(value));
      if (selected) setSalesData(prev => ({ ...prev, customer: value, customer_name: selected.label }));
    }
  };

  // Multi-DC selection (use array instead of Set for React compatibility)
  const [selectedDCIds, setSelectedDCIds] = useState([]);

  // Filter the DC dropdown so subsequent selections must share the first DC's
  // company, warehouse, transporter AND lorry/vehicle number. Before any DC
  // is picked, every option is shown.
  const firstSelectedDcId = selectedDCIds[0];
  const firstDcMeta = firstSelectedDcId ? freightDetailOptions.find(o => o.value === firstSelectedDcId) : null;
  const visibleDcOptions = firstDcMeta
    ? freightDetailOptions.filter(o =>
        (o.company || null) === (firstDcMeta.company || null)
        && (o.warehouse || null) === (firstDcMeta.warehouse || null)
        && (o.transporter || null) === (firstDcMeta.transporter || null)
        && (o.lorry_no || null) === (firstDcMeta.lorry_no || null)
      )
    : freightDetailOptions;

  // Apply parent-level autofill (Sales Order Details + Transport) from a DC.
  // Called both when the very first DC is selected AND when removing the first
  // DC promotes another to "first".
  const applyFirstDcAutofill = async (dcId) => {
    if (!dcId) return;
    try {
      const res = await apiClient.get(`/api/sales/dc/${dcId}/`);
      const dc = res.data;
      let so = null;
      if (dc.linked_so_id) {
        try {
          const soRes = await apiClient.get(`/api/sales/orders/${dc.linked_so_id}/`);
          so = soRes.data;
        } catch { /* ignore */ }
      }
      const companyId = so?.company || '';
      const customerId = so?.customer || '';
      const factoryId = so?.warehouse || dc.warehouse || '';
      const destStateOnly = (dc.destination || '').split(',').pop().trim();

      setSalesData(prev => ({
        ...prev,
        company: companyId || prev.company,
        factory: factoryId || prev.factory,
        customer: customerId || prev.customer,
        customer_name: dc.customer_name || so?.customer_name || dc.customer_display || prev.customer_name,
        transporter: dc.transporter || prev.transporter,
        freight_date: prev.freight_date || new Date().toISOString().split('T')[0],
        destination: dc.destination || '',
        freight_type: dc.freight_type ? toSalesFreightType(dc.freight_type) : prev.freight_type,
      }));

      setCommonData(prev => ({
        ...prev,
        lorry_no: dc.lorry_no || '',
        driver_contact: dc.driver_contact || '',
        destination_state: destStateOnly,
      }));

      if (companyId) {
        apiClient.get(`/api/customers/?company=${companyId}`)
          .then(r => {
            const list = r.data?.results || r.data || [];
            setSalesFilteredCustomers(list.map(c => ({
              value: c.id,
              label: c.customer_name || c.name || c.customer_code || c.id,
            })));
          }).catch(() => {});
      }
    } catch { /* ignore */ }
  };

  const handleDCToggle = async (dcId) => {
    const isSelected = selectedDCIds.includes(dcId);
    if (isSelected) {
      const wasFirst = selectedDCIds[0] === dcId;
      const remainingIds = selectedDCIds.filter(id => id !== dcId);
      setSelectedDCIds(remainingIds);
      setDcLinks(prev => prev.filter(l => l.dc !== dcId));
      // If we removed the first DC, promote the next one and re-autofill from it.
      if (wasFirst && remainingIds.length > 0) {
        applyFirstDcAutofill(remainingIds[0]);
      }
    } else {
      const newIds = [...selectedDCIds, dcId];
      setSelectedDCIds(newIds);
      try {
        const res = await apiClient.get(`/api/sales/dc/${dcId}/`);
        const dc = res.data;
        const prods = (dc.dc_lines || []).map(l => ({
          name: l.product_name || l.product_sku || '', qty: l.quantity_dispatched || 0, uom: l.uom || '',
        }));
        const dcQty = (dc.dc_lines || []).reduce((s, l) => s + (parseFloat(l.quantity_dispatched) || 0), 0);
        const dcUom = (dc.dc_lines || [])[0]?.uom || 'MTS';
        setDcLinks(prev => [...prev.filter(l => l.dc), {
          dc: dcId, invoice_no: dc.invoice_no || '', invoice_date: dc.invoice_date || '', destination: dc.destination || '', products: prods,
          freight_rate: dc.freight_rate_value ? String(dc.freight_rate_value) : '0',
          uom: dcUom,
          quantity: dcQty,
        }]);
        if (newIds.length === 1) {
          let so = null;
          if (dc.linked_so_id) {
            try {
              const soRes = await apiClient.get(`/api/sales/orders/${dc.linked_so_id}/`);
              so = soRes.data;
            } catch { /* ignore */ }
          }

          const companyId = so?.company || '';
          const customerId = so?.customer || '';
          const factoryId = so?.warehouse || dc.warehouse || '';
          const uom = (dc.dc_lines || [])[0]?.uom || 'MTS';
          const destStateOnly = (dc.destination || '').split(',').pop().trim();

          setSalesData(prev => ({
            ...prev,
            company: companyId || prev.company,
            factory: factoryId || prev.factory,
            customer: customerId || prev.customer,
            customer_name: dc.customer_name || so?.customer_name || dc.customer_display || prev.customer_name,
            transporter: dc.transporter || prev.transporter,
            freight_date: prev.freight_date || new Date().toISOString().split('T')[0],
            destination: dc.destination || '',
            freight_type: dc.freight_type ? toSalesFreightType(dc.freight_type) : prev.freight_type,
          }));

          setCommonData(prev => ({
            ...prev,
            lorry_no: dc.lorry_no || '',
            driver_contact: dc.driver_contact || '',
            destination_state: destStateOnly,
          }));

          if (companyId) {
            apiClient.get(`/api/customers/?company=${companyId}`)
              .then(r => {
                const list = r.data?.results || r.data || [];
                setSalesFilteredCustomers(list.map(c => ({
                  value: c.id,
                  label: c.customer_name || c.name || c.customer_code || c.id,
                })));
              }).catch(() => {});
          }
        }
      } catch { /* ignore */ }
    }
  };

  // Auto-calc total quantity from selected DCs (numeric, used for legacy single-rate calc)
  const dcTotalQty = dcLinks.reduce((s, l) => s + (l.products || []).reduce((ps, p) => ps + (parseFloat(p.qty) || 0), 0), 0);

  // Per-DC freight: each link has its own qty + rate, so sum (qty * rate) per link.
  const activeDcLinks = dcLinks.filter(l => l.dc);
  const dcTotalsByUom = activeDcLinks.reduce((acc, l) => {
    const qty = parseFloat(l.quantity) || (l.products || []).reduce((ps, p) => ps + (parseFloat(p.qty) || 0), 0);
    const u = l.uom || (l.products || [])[0]?.uom || 'MTS';
    acc[u] = (acc[u] || 0) + qty;
    return acc;
  }, {});
  const dcTotalQtyDisplay = Object.entries(dcTotalsByUom)
    .map(([u, q]) => `${q.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${u}`)
    .join(' + ') || '0';
  const dcLinkAmount = (l) => {
    const qty = parseFloat(l.quantity) || (l.products || []).reduce((ps, p) => ps + (parseFloat(p.qty) || 0), 0);
    const rate = parseFloat(l.freight_rate) || 0;
    return qty * rate;
  };
  const perDcBaseAmt = activeDcLinks.reduce((s, l) => s + dcLinkAmount(l), 0);

  // Base amount = sum of (qty × rate) per DC.
  const salesBaseAmt = perDcBaseAmt;
  const salesDiscountPct = parseFloat(salesData.discount) || 0;
  const salesDiscountedBase = salesBaseAmt - (salesBaseAmt * salesDiscountPct / 100);
  const salesAdditional = parseFloat(salesData.additional_freight) || 0;
  // Mamul & "less" apply with their sign; TDS subtracts; add-to-total charges add.
  const salesMamul = (parseFloat(salesData.mmul_less) || 0) * (salesData.mmul_sign === 'PLUS' ? 1 : -1);
  const salesLess = (parseFloat(salesData.less_amount) || 0) * (salesData.less_amount_sign === 'PLUS' ? 1 : -1);
  const salesChargesTotal = sumAddToTotal(additionalCharges);
  const salesPayable = salesDiscountedBase + salesAdditional + salesMamul + salesLess - (parseFloat(salesData.tds_less) || 0) + salesChargesTotal;
  // Net amount deducted (informational breakdown note); positive = net less.
  const salesTotalDeductions = (parseFloat(salesData.tds_less) || 0) - salesMamul - salesLess;

  // ============ SUBMIT ============
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (chargesHaveValue(additionalCharges) && !chargesRemarks.trim()) {
      toast.error('Remarks are required when additional charges are added.');
      return;
    }
    if (freightType === 'purchase') {
      if (sourceType === 'PURCHASE_RECEIPT' && !purchaseData.receipt_advice) {
        toast.error('Please select a Receipt Advice.');
        return;
      }
      if (sourceType === 'INVENTORY_TRANSFER' && !purchaseData.transfer_source) {
        toast.error('Please select a Transfer.');
        return;
      }
      if (sourceType === 'INVENTORY_SHIFTING' && !purchaseData.shifting_source) {
        toast.error('Please select a Shifting.');
        return;
      }
      if (sourceType === 'SALES_DISPATCH_CHALLAN' && !purchaseData.dispatch_challan_source) {
        toast.error('Please select a Dispatch Challan.');
        return;
      }
    }
    // Validate freight quantity against receipt/PO limits — only meaningful
    // for PURCHASE_RECEIPT source; transfers/shifting don't have a PO ceiling.
    if (freightType === 'purchase' && sourceType === 'PURCHASE_RECEIPT' && allowedQty > 0) {
      const qtyBasis = parseFloat(purchaseData.quantity_basis) || 0;
      if (qtyBasis > allowedQty) {
        toast.error(
          `Freight quantity basis (${qtyBasis}) exceeds allowed quantity (${allowedQty}). ` +
          `Freight quantity cannot be greater than the Receipt or Purchase Order quantity.`
        );
        return;
      }
      // Also validate individual freight row quantities
      for (const row of freightRows) {
        if (row.calc_type === 'QTY_WISE') {
          const rowQty = parseFloat(row.quantity) || 0;
          if (rowQty > allowedQty) {
            toast.error(
              `Freight row quantity (${rowQty}) exceeds allowed quantity (${allowedQty}). ` +
              `Freight quantity cannot be greater than the Receipt or Purchase Order quantity.`
            );
            return;
          }
        }
      }
      // Validate line item quantities against receipt quantities
      for (let i = 0; i < lineItems.length; i++) {
        const line = lineItems[i];
        const qty = parseFloat(line.quantity) || 0;
        if (qty < 0) {
          toast.error('Line item quantity must be greater than 0.');
          return;
        }
        if (receiptInfo && receiptInfo.receipt_lines && receiptInfo.receipt_lines[i]) {
          const maxQty = parseFloat(receiptInfo.receipt_lines[i].quantity_received) || 0;
          if (maxQty > 0 && qty > maxQty) {
            toast.error(
              `Line quantity (${qty}) for ${line.product_name || 'item'} exceeds receipt quantity (${maxQty}).`
            );
            return;
          }
        }
      }
    }
    if (freightType === 'sales' && dcTotalQty <= 0) {
      toast.error('Please select at least one Dispatch Challan.');
      return;
    }
    if (freightType === 'sales' && perDcBaseAmt <= 0) {
      toast.error('Enter a freight rate for at least one DC.');
      return;
    }
    setIsLoading(true);
    try {
      if (freightType === 'purchase') {
        const firstRow = freightRows[0] || {};
        const totalQty = lineItems.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0);
        const autoRate = totalQty > 0 ? purchasePayable / totalQty : 0;
        // Send only the one source FK that matches sourceType — the others
        // go up as empty strings so cleanFormData strips them.
        const sourceFKs = {
          receipt_advice: sourceType === 'PURCHASE_RECEIPT' ? purchaseData.receipt_advice : '',
          transfer_source: sourceType === 'INVENTORY_TRANSFER' ? purchaseData.transfer_source : '',
          shifting_source: sourceType === 'INVENTORY_SHIFTING' ? purchaseData.shifting_source : '',
          dispatch_challan_source: sourceType === 'SALES_DISPATCH_CHALLAN' ? purchaseData.dispatch_challan_source : '',
        };
        // Transporter is a nullable FK on the backend. Send `null`
        // (not '') when no master match — happens when the operator
        // typed a free-text name that doesn't exist in the
        // Transporter master. cleanFormData would drop '' for some
        // fields but explicit null is safer here.
        const resolvedTransporter = firstRow.transporter && firstRow.transporter.length > 0
          ? firstRow.transporter
          : null;
        const payload = cleanFormData({
          ...purchaseData,
          ...sourceFKs,
          source_type: sourceType,
          ...commonData,
          ...bankData,
          transporter: resolvedTransporter,
          freight_type: firstRow.freight_type || 'LOCAL_DRAYAGE',
          freight_terms: firstRow.freight_terms || '',
          base_amount: purchaseBaseAmt.toFixed(2),
          payable_amount: purchasePayable.toFixed(2),
          mamul_amount: parseFloat(purchaseData.mmul_less) || 0,
          mamul_sign: purchaseData.mmul_sign,
          less_amount_sign: purchaseData.less_amount_sign,
          additional_charges: additionalCharges.filter(c => parseFloat(c.amount) > 0),
          additional_charges_remarks: chargesRemarks.trim(),
          line_items: lineItems.filter(l => l.product || l.product_name).map((l, i) => ({
            line_no: i + 1,
            product: l.product || null,
            product_name: l.product_name || '',
            quantity: l.quantity || 0,
            uom: l.uom || 'KG',
            batch_no: l.batch_no || '',
            rate: l.rate !== '' ? l.rate : autoRate.toFixed(2),
            freight_amount: ((l.rate !== '' ? parseFloat(l.rate) || 0 : autoRate) * (parseFloat(l.quantity) || 0)).toFixed(2),
            remarks: l.remarks || '',
          })),
        });
        const res = await apiClient.post('/api/purchase/freight/', payload);
        const newId = res.data?.id || res.data?.pk;
        if (pendingAttachments.length > 0 && newId) {
          await uploadPendingFiles('FREIGHT', newId, pendingAttachmentsRef.current);
        }
        await persistBankToTransporter();
        toast.success('Inward Freight created!');
        navigate(newId ? `/freight/purchase/${newId}` : '/freight/inward');
      } else {
        const payload = {
          freight_detail: salesData.freight_detail || null,
          transporter: salesData.transporter || null,
          freight_type: toSalesFreightType(salesData.freight_type),
          freight_date: salesData.freight_date || null,
          customer: salesData.customer || null,
          customer_name: salesData.customer_name || '',
          company: salesData.company || null,
          factory: salesData.factory || null,
          lorry_no: commonData.lorry_no || '',
          destination: salesData.destination || commonData.destination_state || '',
          base_amount: salesBaseAmt || 0,
          payable_amount: salesPayable || 0,
          discount: salesData.discount || 0,
          additional_freight: salesData.additional_freight || 0,
          mamul_amount: parseFloat(salesData.mmul_less) || 0,
          mamul_sign: salesData.mmul_sign,
          tds_less: salesData.tds_less || 0,
          less_amount: salesData.less_amount || 0,
          less_amount_sign: salesData.less_amount_sign,
          additional_charges: additionalCharges.filter(c => parseFloat(c.amount) > 0),
          additional_charges_remarks: chargesRemarks.trim(),
          unloading_wages_amount: 0,
          unloading_charges: 0,
          remarks: commonData.remarks || '',
          bank_name: bankData.bank_name || '',
          ifsc_code: bankData.ifsc_code || '',
          beneficiary_name: bankData.beneficiary_name || '',
          account_no: bankData.account_no || '',
          dc_links: dcLinks.filter(l => l.dc).map(l => {
            const qty = parseFloat(l.quantity) || (l.products || []).reduce((ps, p) => ps + (parseFloat(p.qty) || 0), 0);
            const rate = parseFloat(l.freight_rate) || 0;
            return {
              dc: l.dc,
              invoice_no: l.invoice_no || '',
              invoice_date: l.invoice_date || null,
              destination: l.destination || '',
              quantity: qty,
              uom: l.uom || (l.products || [])[0]?.uom || '',
              freight_rate: rate,
              freight_amount: qty * rate,
            };
          }),
        };
        const res = await apiClient.post('/api/sales/freight/', payload);
        const newSalesId = res.data?.id || res.data?.pk;
        if (pendingAttachments.length > 0 && newSalesId) {
          await uploadPendingFiles('FREIGHT', newSalesId, pendingAttachmentsRef.current);
        }
        await persistBankToTransporter();
        toast.success('Outward Freight created!');
        navigate(newSalesId ? `/freight/sales/${newSalesId}` : '/freight/outward');
      }
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handlePurchaseChange = (e) => {
    const { name, value } = e.target;
    setPurchaseData(prev => ({ ...prev, [name]: value }));
  };

  // Page-level labels: each route gets its own title / breadcrumb.
  // "Inward" = purchase-side freight (vendor → warehouse), "Outward"
  // = sales-side freight (warehouse → customer).
  const pageTitle = freightType === 'sales' ? 'Create Outward Freight' : 'Create Inward Freight';

  return (
    <MainLayout>
      <PageHeader
        title={pageTitle}
        breadcrumbs={[
          { label: freightType === 'sales' ? 'Outward Freight' : 'Inward Freight',
            path: freightType === 'sales' ? '/freight/outward' : '/freight/inward' },
          { label: pageTitle },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit} noValidate>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">

          {/* Mode banner — labels which kind of freight this page
              creates. Sales (Outward) and Purchase (Inward) live on
              their own URLs / sidebar entries, so there's no in-form
              switcher anymore; the banner is purely informational. */}
          <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${freightType === 'sales' ? 'border-emerald-200 bg-emerald-50' : 'border-blue-200 bg-blue-50'}`}>
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${freightType === 'sales' ? 'bg-emerald-500 text-white' : 'bg-blue-500 text-white'}`}>
              {freightType === 'sales' ? <ArrowUpRight size={20} /> : <ArrowDownLeft size={20} />}
            </div>
            <div>
              <p className={`font-semibold ${freightType === 'sales' ? 'text-emerald-800' : 'text-blue-800'}`}>
                {freightType === 'sales' ? 'Outward Freight' : 'Inward Freight'}
              </p>
              <p className="text-xs text-slate-600">
                {freightType === 'sales' ? 'Freight from warehouse to customer' : 'Freight from vendor to warehouse'}
              </p>
            </div>
          </div>

          {/* ============ PURCHASE FORM ============ */}
          {freightType === 'purchase' && (
            <>
              {/* Source Document Reference */}
              <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Source Document</h3>

                {/* Source Type radio toggle */}
                <div className="mb-4 flex flex-wrap gap-2">
                  {[
                    { v: 'PURCHASE_RECEIPT', label: 'Purchase Receipt', desc: 'Vendor → Warehouse' },
                    { v: 'INVENTORY_TRANSFER', label: 'Transfer', desc: 'Warehouse → Warehouse' },
                    { v: 'INVENTORY_SHIFTING', label: 'Shifting', desc: 'Godown → Godown' },
                  ].map(opt => (
                    <label
                      key={opt.v}
                      className={`flex-1 min-w-[180px] flex items-start gap-2 rounded-lg border-2 px-3 py-2 cursor-pointer transition ${sourceType === opt.v ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}
                    >
                      <input
                        type="radio"
                        name="source_type"
                        checked={sourceType === opt.v}
                        onChange={() => handleSourceTypeChange(opt.v)}
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
                      {searchParams.get('receipt_id') && purchaseData.receipt_advice ? (
                        <input type="text" readOnly value={receiptInfo?.receipt_advice_no || purchaseData.receipt_advice} className={readOnlyClass} />
                      ) : (
                        <CustomSelect name="receipt_advice" value={purchaseData.receipt_advice} onChange={handleReceiptChange} required className={inputClass}>
                          <option value="">Select Receipt Advice</option>
                          {receiptOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </CustomSelect>
                      )}
                    </div>
                  )}
                  {sourceType === 'INVENTORY_TRANSFER' && (
                    <div>
                      <label className={labelClass}>Transfer No <span className="text-red-500">*</span></label>
                      <CustomSelect name="transfer_source" value={purchaseData.transfer_source} onChange={handleTransferChange} required className={inputClass}>
                        <option value="">Select Transfer</option>
                        {transferOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </CustomSelect>
                    </div>
                  )}
                  {sourceType === 'INVENTORY_SHIFTING' && (
                    <div>
                      <label className={labelClass}>Shifting No <span className="text-red-500">*</span></label>
                      <CustomSelect name="shifting_source" value={purchaseData.shifting_source} onChange={handleShiftingChange} required className={inputClass}>
                        <option value="">Select Shifting</option>
                        {shiftingOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </CustomSelect>
                    </div>
                  )}
                  {/* Freight Date — defaults to today. Header-level for
                      the purchase form; sales side has its own copy in
                      salesData (rendered separately). */}
                  <div>
                    <label className={labelClass}>Freight Date <span className="text-red-500">*</span></label>
                    <CustomDatePicker
                      name="freight_date"
                      value={purchaseData.freight_date || ''}
                      onChange={(e) => setPurchaseData(prev => ({ ...prev, freight_date: e.target.value }))}
                      required
                      className={inputClass}
                    />
                  </div>
                </div>
                {receiptInfo && receiptInfo._source === 'TRANSFER' && (
                  <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <h4 className="text-sm font-semibold text-blue-800 mb-2">Linked Transfer Info</h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      <div><span className="text-blue-600">Transfer No:</span> <span className="ml-1 font-medium">{receiptInfo.source_doc?.transfer_no || '-'}</span></div>
                      <div><span className="text-blue-600">From WH:</span> <span className="ml-1 font-medium">{receiptInfo.source_doc?.from_warehouse_name || '-'}</span></div>
                      <div><span className="text-blue-600">To WH:</span> <span className="ml-1 font-medium">{receiptInfo.source_doc?.to_warehouse_name || '-'}</span></div>
                      <div><span className="text-blue-600">Transporter:</span> <span className="ml-1 font-medium">{receiptInfo.source_doc?.transporter_name || '-'}</span></div>
                    </div>
                  </div>
                )}
                {receiptInfo && receiptInfo._source === 'SHIFTING' && (
                  <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <h4 className="text-sm font-semibold text-blue-800 mb-2">Linked Shifting Info</h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      <div><span className="text-blue-600">Shifting No:</span> <span className="ml-1 font-medium">{receiptInfo.source_doc?.shifting_no || '-'}</span></div>
                      <div><span className="text-blue-600">Warehouse:</span> <span className="ml-1 font-medium">{receiptInfo.source_doc?.warehouse_name || '-'}</span></div>
                      <div><span className="text-blue-600">From Godown:</span> <span className="ml-1 font-medium">{receiptInfo.source_doc?.from_godown_name || '-'}</span></div>
                      <div><span className="text-blue-600">To Godown:</span> <span className="ml-1 font-medium">{receiptInfo.source_doc?.to_godown_name || '-'}</span></div>
                    </div>
                  </div>
                )}
                {receiptInfo && !receiptInfo._source && (
                  <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <h4 className="text-sm font-semibold text-blue-800 mb-2">Linked Receipt Info</h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      <div><span className="text-blue-600">Vendor:</span> <span className="ml-1 font-medium">{receiptInfo.vendor_name || '-'}</span></div>
                      <div><span className="text-blue-600">Warehouse:</span> <span className="ml-1 font-medium">{receiptInfo.warehouse_name || '-'}</span></div>
                      <div><span className="text-blue-600">PO Numbers:</span> <span className="ml-1 font-medium">{(receiptInfo.linked_po_numbers || []).join(', ') || '-'}</span></div>
                      <div><span className="text-blue-600">Receipt No:</span> <span className="ml-1 font-medium">{receiptInfo.receipt_advice_no || '-'}</span></div>
                    </div>
                  </div>
                )}
              </div>

              {/* Quantity Limits Info */}
              {receiptInfo && allowedQty > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-center gap-4 text-sm">
                  <span className="font-medium text-blue-800">Quantity Limits:</span>
                  <span className="text-blue-700">Receipt Qty: <strong>{receiptTotalQty}</strong></span>
                  {poTotalQty > 0 && <span className="text-blue-700">PO Qty: <strong>{poTotalQty}</strong></span>}
                  <span className="text-blue-900 font-semibold">Max Allowed: {allowedQty}</span>
                </div>
              )}

              {/* Freight Detail Rows */}
              <div>
                <div className="flex items-center justify-between mb-4 pb-2 border-b">
                  <h3 className="text-lg font-semibold text-slate-800">Freight Details ({freightRows.length})</h3>
                  <button type="button" onClick={addFreightRow} className="inline-flex items-center gap-1 px-3 py-1.5 bg-orange-50 text-orange-700 rounded-lg text-sm font-medium hover:bg-orange-100">
                    <Plus size={16} /> Add Freight
                  </button>
                </div>
                {freightRows.length === 0 ? (
                  <p className="text-sm text-slate-400 italic">No freight details. Click "Add Freight" to add.</p>
                ) : (
                  <div className="space-y-4">
                    {freightRows.map((row, idx) => {
                      const rowAmt = getRowAmount(row);
                      const ct = row.calc_type || 'QTY_WISE';
                      return (
                        <div key={idx} className="border border-slate-200 rounded-lg p-4 bg-slate-50">
                          <div className="flex items-center justify-between mb-3">
                            <span className="text-sm font-semibold text-slate-700">#{idx + 1}</span>
                            <div className="flex items-center gap-3">
                              <span className="text-sm font-bold text-primary-700">Amount: ₹{rowAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                              <button type="button" onClick={() => removeFreightRow(idx)} disabled={freightRows.length <= 1} className="text-red-500 hover:text-red-700 disabled:opacity-30"><Trash2 size={16} /></button>
                            </div>
                          </div>
                          {/* Row 1: Type, Transporter, Terms, Calc Type */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                            <div>
                              <label className="block text-xs font-medium text-slate-500 mb-1">Freight Type</label>
                              <CustomSelect value={row.freight_type} onChange={e => handleFreightRowChange(idx, 'freight_type', e.target.value)} className={inputClass}>
                                <option value="LOCAL_DRAYAGE">Local Drayage</option>
                                <option value="LINEHAUL">Linehaul</option>
                              </CustomSelect>
                            </div>
                            <div>
                              {/* Transporter — on-brand CustomSelect from the
                                  Transporter master (searchable when the list
                                  is long), replacing the OS-styled native
                                  datalist. Picking a row stores its UUID. */}
                              <label className="block text-xs font-medium text-slate-500 mb-1">Transporter</label>
                              <CustomSelect
                                value={row.transporter || ''}
                                onChange={e => {
                                  handleFreightRowChange(idx, 'transporter', e.target.value);
                                  handleFreightRowChange(idx, '_transporterText', undefined);
                                }}
                                className={inputClass}
                              >
                                <option value="">Select transporter…</option>
                                {transporterOptions.map(o => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                              </CustomSelect>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-500 mb-1">Terms</label>
                              <CustomSelect value={row.freight_terms} onChange={e => handleFreightRowChange(idx, 'freight_terms', e.target.value)} className={inputClass}>
                                <option value="TO_PAY">To Pay</option>
                                <option value="PAID">Paid</option>
                              </CustomSelect>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-500 mb-1">Calculation Type</label>
                              <CustomSelect value={ct} onChange={e => handleFreightRowChange(idx, 'calc_type', e.target.value)} className={inputClass}>
                                <option value="QTY_WISE">Quantity Wise</option>
                                <option value="LORRY_WISE">Lorry Wise</option>
                                <option value="MANUAL">Manual / Lump Sum</option>
                              </CustomSelect>
                            </div>
                          </div>
                          {/* Row 2: Calculation fields based on type */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            {ct === 'QTY_WISE' && (
                              <>
                                <div>
                                  <label className="block text-xs font-medium text-slate-500 mb-1">Quantity {allowedQty > 0 && <span className="text-blue-500 font-normal">(Max: {allowedQty})</span>}</label>
                                  <input type="number" step="0.01" min="0" max={allowedQty > 0 ? allowedQty : undefined} value={row.quantity} onChange={e => handleFreightRowChange(idx, 'quantity', e.target.value)} className={inputClass} placeholder="0" title={allowedQty > 0 ? `Max allowed: ${allowedQty}` : ''} />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-slate-500 mb-1">Charge / Unit</label>
                                  <input type="number" step="0.01" min="0" value={row.charge} onChange={e => handleFreightRowChange(idx, 'charge', e.target.value)} className={inputClass} placeholder="0.00" />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-slate-500 mb-1">UOM</label>
                                  <CustomSelect value={row.uom} onChange={e => handleFreightRowChange(idx, 'uom', e.target.value)} className={inputClass}>
                                    <option value="KG">KG</option><option value="MT">MT</option><option value="TONS">Tons</option><option value="PCS">Pcs</option>
                                  </CustomSelect>
                                </div>
                              </>
                            )}
                            {ct === 'LORRY_WISE' && (
                              <>
                                <div>
                                  <label className="block text-xs font-medium text-slate-500 mb-1">No. of Lorries</label>
                                  <input type="number" step="1" min="0" max="20" value={row.num_lorries} onChange={e => {
                                    const val = e.target.value;
                                    const num = parseInt(val);
                                    if (!isNaN(num) && num > 20) return;
                                    handleFreightRowChange(idx, 'num_lorries', val);
                                    if (!isNaN(num) && num >= 0 && num <= 20) {
                                      const existing = row.lorry_nos || [];
                                      const updated = Array.from({ length: num }, (_, i) => existing[i] || '');
                                      handleFreightRowChange(idx, 'lorry_nos', updated);
                                    }
                                    if (val === '') handleFreightRowChange(idx, 'lorry_nos', []);
                                  }} className={inputClass} placeholder="1" />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-slate-500 mb-1">Charge / Lorry</label>
                                  <input type="number" step="0.01" min="0" value={row.charge_per_lorry} onChange={e => handleFreightRowChange(idx, 'charge_per_lorry', e.target.value)} className={inputClass} placeholder="0.00" />
                                </div>
                              </>
                            )}
                            {ct === 'MANUAL' && (
                              <div>
                                <label className="block text-xs font-medium text-slate-500 mb-1">Freight Amount</label>
                                <input type="number" step="0.01" min="0" value={row.manual_amount} onChange={e => handleFreightRowChange(idx, 'manual_amount', e.target.value)} className={inputClass} placeholder="0.00" />
                              </div>
                            )}
                            <div>
                              <label className="block text-xs font-medium text-slate-500 mb-1">Payable By</label>
                              <CustomSelect value={row.payable_by} onChange={e => handleFreightRowChange(idx, 'payable_by', e.target.value)} className={inputClass}>
                                <option value="COMPANY">Company</option>
                                <option value="VENDOR">Vendor</option>
                              </CustomSelect>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-500 mb-1">Origin</label>
                              <input type="text" value={row.origin} onChange={e => handleFreightRowChange(idx, 'origin', e.target.value)} className={inputClass} placeholder="Location" />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-500 mb-1">Remarks</label>
                              <input type="text" value={row.remarks || ''} onChange={e => handleFreightRowChange(idx, 'remarks', e.target.value)} className={inputClass} placeholder="Notes..." />
                            </div>
                          </div>
                          {/* Lorry Vehicle Numbers */}
                          {ct === 'LORRY_WISE' && (row.lorry_nos || []).length > 0 && (
                            <div className="mt-3 pt-3 border-t border-slate-200">
                              <label className="block text-xs font-medium text-slate-500 mb-2">Vehicle Numbers</label>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                                {(row.lorry_nos || []).map((vno, vi) => (
                                  <div key={vi} className="relative">
                                    <span className="absolute left-2 top-2 text-[10px] text-slate-400 font-medium">L{vi + 1}</span>
                                    <input
                                      type="text"
                                      value={vno}
                                      onChange={e => {
                                        const updated = [...(row.lorry_nos || [])];
                                        updated[vi] = e.target.value;
                                        handleFreightRowChange(idx, 'lorry_nos', updated);
                                      }}
                                      className={`${inputClass} pl-8`}
                                      placeholder={`Vehicle ${vi + 1}`}
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Product Line Items */}
              <div>
                <div className="flex items-center justify-between mb-4 pb-2 border-b">
                  <h3 className="text-lg font-semibold text-slate-800">Product Line Items</h3>
                  <button type="button" onClick={addLineItem} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                    <Plus size={16} /> Add Line
                  </button>
                </div>
                {lineItems.length === 0 ? (
                  <p className="text-sm text-slate-400 italic">Select a Receipt Advice to auto-populate product lines.</p>
                ) : (
                  <>
                  {/* Mobile-stacked product lines for purchase freight. */}
                  <div className="sm:hidden space-y-3 mb-3">
                    {lineItems.map((line, i) => {
                      const qty = parseFloat(line.quantity) || 0;
                      const totalQty = lineItems.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0);
                      const autoRate = totalQty > 0 ? purchasePayable / totalQty : 0;
                      const rate = line.rate !== '' ? parseFloat(line.rate) || 0 : autoRate;
                      const freightAmt = rate * qty;
                      return (
                        <div key={`m-${i}`} className="border border-slate-200 rounded-lg bg-white overflow-hidden">
                          <div className="flex items-start justify-between px-3 py-2 bg-slate-50 border-b border-slate-100 gap-2">
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-slate-500">Line #{i + 1}</p>
                              {line.product_name && <p className="text-sm font-semibold text-slate-800 break-words">{line.product_name}</p>}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <p className="text-sm font-bold text-slate-900 whitespace-nowrap">₹{freightAmt.toFixed(2)}</p>
                              <button type="button" onClick={() => removeLineItem(i)} disabled={lineItems.length <= 1} className="text-red-500 p-1 disabled:opacity-30"><Trash2 size={14} /></button>
                            </div>
                          </div>
                          <div className="px-3 py-2 space-y-2 text-xs">
                            {!line.product_name && (
                              <div>
                                <p className="text-[10px] uppercase text-slate-500 mb-0.5">Product</p>
                                <CustomSelect value={line.product} onChange={e => handleLineChange(i, 'product', e.target.value)} className={`${inputClass} w-full`}>
                                  <option value="">Select</option>
                                  {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </CustomSelect>
                              </div>
                            )}
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <p className="text-[10px] uppercase text-slate-500 mb-0.5">Qty</p>
                                <input type="number" step="0.01" value={line.quantity} onChange={e => handleLineChange(i, 'quantity', e.target.value)} className={`${inputClass} w-full`} />
                              </div>
                              <div>
                                <p className="text-[10px] uppercase text-slate-500 mb-0.5">UOM</p>
                                <input type="text" value={line.uom} onChange={e => handleLineChange(i, 'uom', e.target.value)} className={`${inputClass} w-full`} />
                              </div>
                              <div>
                                <p className="text-[10px] uppercase text-slate-500 mb-0.5">Rate</p>
                                <input type="number" step="0.01" value={line.rate ?? ''} onChange={e => handleLineChange(i, 'rate', e.target.value)} className={`${inputClass} w-full`} />
                              </div>
                            </div>
                            <div>
                              <p className="text-[10px] uppercase text-slate-500 mb-0.5">Remarks</p>
                              <input type="text" value={line.remarks} onChange={e => handleLineChange(i, 'remarks', e.target.value)} className={`${inputClass} w-full`} />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="hidden sm:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50 border-b">
                          <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                          <th className="text-left px-3 py-2 font-medium text-slate-600">Product</th>
                          <th className="text-left px-3 py-2 font-medium text-slate-600">Qty</th>
                          <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                          <th className="text-left px-3 py-2 font-medium text-slate-600">Rate</th>
                          <th className="text-left px-3 py-2 font-medium text-slate-600">Freight Amt</th>
                          <th className="text-left px-3 py-2 font-medium text-slate-600">Remarks</th>
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {lineItems.map((line, i) => {
                          const qty = parseFloat(line.quantity) || 0;
                          const totalQty = lineItems.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0);
                          const autoRate = totalQty > 0 ? purchasePayable / totalQty : 0;
                          const rate = line.rate !== '' ? parseFloat(line.rate) || 0 : autoRate;
                          const freightAmt = rate * qty;
                          return (
                            <tr key={i} className="border-b">
                              <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                              <td className="px-3 py-2">
                                {line.product_name ? (
                                  <span className="font-medium text-slate-800 text-xs bg-slate-100 px-2 py-1 rounded truncate max-w-[160px]" title={line.product_name}>{line.product_name}</span>
                                ) : (
                                  <CustomSelect value={line.product} onChange={e => handleLineChange(i, 'product', e.target.value)} className={inputClass} style={{ minWidth: '160px' }}>
                                    <option value="">Select</option>
                                    {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </CustomSelect>
                                )}
                              </td>
                              <td className="px-3 py-2"><input type="number" step="0.01" value={line.quantity} onChange={e => handleLineChange(i, 'quantity', e.target.value)} className={inputClass} style={{ minWidth: '80px' }} /></td>
                              <td className="px-3 py-2"><input type="text" value={line.uom} onChange={e => handleLineChange(i, 'uom', e.target.value)} className={inputClass} style={{ minWidth: '60px' }} /></td>
                              <td className="px-3 py-2"><input type="number" step="0.01" value={line.rate ?? ''} onChange={e => handleLineChange(i, 'rate', e.target.value)} className={inputClass} style={{ minWidth: '80px' }} /></td>
                              <td className="px-3 py-2"><input type="number" readOnly value={freightAmt.toFixed(2)} className={readOnlyClass} style={{ minWidth: '90px' }} /></td>
                              <td className="px-3 py-2"><input type="text" value={line.remarks} onChange={e => handleLineChange(i, 'remarks', e.target.value)} className={inputClass} style={{ minWidth: '90px' }} /></td>
                              <td className="px-3 py-2"><button type="button" onClick={() => removeLineItem(i)} disabled={lineItems.length <= 1} className="text-red-500 hover:text-red-700 disabled:opacity-30"><Trash2 size={16} /></button></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  </>
                )}
              </div>

              {/* Purchase Cost Details */}
              <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Cost Details</h3>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className={labelClass}>Freight Amount (Base)</label>
                    <input type="text" readOnly value={`₹${purchaseBaseAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} className={`${readOnlyClass} font-semibold`} />
                  </div>
                  <div>
                    <label className={labelClass}>Discount (%)</label>
                    <input type="number" step="0.01" min="0" max="100" name="discount" value={purchaseData.discount} onChange={handlePurchaseChange} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Discounted Amount</label>
                    <input type="text" readOnly value={purchaseDiscountPct > 0 ? `₹${purchaseDiscountedBase.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'} className={readOnlyClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Mamul ({purchaseData.mmul_sign === 'PLUS' ? 'Plus' : 'Less'})</label>
                    <div className="flex gap-1">
                      <CustomSelect value={purchaseData.mmul_sign} onChange={(e) => setPurchaseData(prev => ({ ...prev, mmul_sign: e.target.value }))} className={inputClass} style={{ maxWidth: '95px' }}>
                        <option value="LESS">Less</option>
                        <option value="PLUS">Plus</option>
                      </CustomSelect>
                      <input type="number" step="0.01" name="mmul_less" value={purchaseData.mmul_less} onChange={handlePurchaseChange} className={inputClass} />
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>TDS Less</label>
                    <input type="number" step="0.01" name="tds_less" value={purchaseData.tds_less} onChange={handlePurchaseChange} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Less Amount ({purchaseData.less_amount_sign === 'PLUS' ? 'Plus' : 'Less'})</label>
                    <div className="flex gap-1">
                      <CustomSelect value={purchaseData.less_amount_sign} onChange={(e) => setPurchaseData(prev => ({ ...prev, less_amount_sign: e.target.value }))} className={inputClass} style={{ maxWidth: '95px' }}>
                        <option value="LESS">Less</option>
                        <option value="PLUS">Plus</option>
                      </CustomSelect>
                      <input type="number" step="0.01" name="less_amount" value={purchaseData.less_amount} onChange={handlePurchaseChange} className={inputClass} />
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>Quantity Basis {allowedQty > 0 && <span className="text-blue-500 font-normal text-xs">(Max: {allowedQty})</span>}</label>
                    <input type="number" step="0.0001" name="quantity_basis" max={allowedQty > 0 ? allowedQty : undefined} value={purchaseData.quantity_basis} onChange={(e) => {
                      const val = e.target.value;
                      if (allowedQty > 0 && parseFloat(val) > allowedQty) {
                        toast.error(`Quantity basis (${val}) exceeds allowed quantity (${allowedQty}). Freight quantity cannot be greater than the Receipt or Purchase Order quantity.`);
                        return;
                      }
                      handlePurchaseChange(e);
                    }} className={inputClass} title={allowedQty > 0 ? `Max allowed: ${allowedQty}` : ''} />
                  </div>
                  <div>
                    <label className={labelClass}>Quantity UOM</label>
                    <input type="text" name="quantity_uom" value={purchaseData.quantity_uom} onChange={handlePurchaseChange} className={inputClass} placeholder="MT, KG, etc." />
                  </div>
                  <div className="flex items-end">
                    <div className="w-full p-4 bg-primary-50 rounded-lg border-2 border-primary-200">
                      <span className="text-xs text-primary-600 uppercase block font-semibold">Payable Amount</span>
                      <span className="text-xl font-bold text-primary-800">{`₹${purchasePayable.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}</span>
                      {purchaseTotalDeductions > 0 && <span className="text-xs text-slate-500 block mt-1">Deductions: ₹{purchaseTotalDeductions.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ============ SALES FORM ============ */}
          {freightType === 'sales' && (
            <>
              {/* Sales Order Details (Company / Factory / Customer cascade) */}
              <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Sales Order Details</h3>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className={labelClass}>Freight No</label>
                    <input type="text" value={salesFreightNo} readOnly className={`${readOnlyClass} font-medium`} placeholder="Auto-generating..." />
                  </div>
                  <div>
                    <label className={labelClass}>Company <span className="text-red-500">*</span></label>
                    <CustomSelect name="company" value={salesData.company} onChange={handleSalesChange} className={inputClass}>
                      <option value="">Select Company</option>
                      {companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  </div>
                  <div>
                    <label className={labelClass}>Warehouse</label>
                    <CustomSelect name="factory" value={salesData.factory} onChange={handleSalesChange} disabled={!salesData.company} className={`${inputClass} disabled:bg-slate-100`}>
                      <option value="">{salesData.company ? 'Select Warehouse' : 'Select Company first'}</option>
                      {salesWarehouseOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  </div>
                  <div>
                    <label className={labelClass}>Customer</label>
                    <CustomSelect name="customer" value={salesData.customer} onChange={handleSalesChange} disabled={!salesData.company} className={`${inputClass} disabled:bg-slate-100`}>
                      <option value="">{salesData.company ? 'Select Customer' : 'Select Company first'}</option>
                      {salesFilteredCustomers.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                    <p className="text-xs text-slate-400 mt-0.5">Filters DC list below to this customer</p>
                  </div>
                  <div>
                    <label className={labelClass}>Freight Type</label>
                    <CustomSelect name="freight_type" value={salesData.freight_type} onChange={handleSalesChange} className={inputClass}>
                      <option value="">Select</option>
                      <option value="LOCAL">Local</option>
                      <option value="LINEHAUL">Linehaul</option>
                    </CustomSelect>
                  </div>
                </div>
              </div>

              {/* Sales Reference */}
              <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Sales Reference</h3>
                <div className="mb-4 p-4 bg-emerald-50 rounded-lg border border-emerald-200">
                  <label className="block text-sm font-medium text-emerald-800 mb-1">
                    Select Dispatch Challans {salesData.customer && <span className="text-xs font-normal text-emerald-600">(filtered by selected customer)</span>}
                    {firstDcMeta && <span className="text-xs font-normal text-emerald-600"> • additional DCs must match the first DC&apos;s company, warehouse, transporter &amp; vehicle no</span>}
                  </label>
                  {/* Selected DC tags */}
                  {selectedDCIds.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {selectedDCIds.map(dcId => {
                        const opt = freightDetailOptions.find(o => o.value === dcId);
                        return (
                          <span key={dcId} className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-100 text-emerald-800 rounded text-xs font-medium">
                            {opt?.label || dcId}
                            <button type="button" onClick={() => handleDCToggle(dcId)} aria-label="Remove DC" title="Remove DC" className="text-emerald-600 hover:text-red-500 ml-0.5">&times;</button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {/* Dropdown to add DCs */}
                  <CustomSelect
                    value=""
                    onChange={(e) => { if (e.target.value) handleDCToggle(e.target.value); }}
                    className={`${inputClass} border-emerald-300`}
                  >
                    <option value="">{selectedDCIds.length > 0 ? `${selectedDCIds.length} DC(s) selected — add more` : '-- Select DC No --'}</option>
                    {visibleDcOptions.filter(o => !selectedDCIds.includes(o.value)).map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </CustomSelect>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className={labelClass}>Date <span className="text-red-500">*</span></label>
                    <CustomDatePicker name="freight_date" value={salesData.freight_date} onChange={handleSalesChange} required className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Customer Name</label>
                    <input type="text" name="customer_name" value={salesData.customer_name} onChange={handleSalesChange} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Transporter</label>
                    <CustomSelect name="transporter" value={salesData.transporter} onChange={handleSalesChange} className={inputClass}>
                      <option value="">Select Transporter</option>
                      {transporterOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  </div>
                </div>
              </div>

              {/* DC Mapping (auto-populated from selected DCs) */}
              {dcLinks.filter(l => l.dc).length > 0 && (
              <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">DC Mapping ({dcLinks.filter(l => l.dc).length})</h3>
                {/* Mobile-stacked card layout */}
                <div className="sm:hidden space-y-3 mb-3">
                  {dcLinks.filter(l => l.dc).map((link, idx) => {
                    const dcOption = allDCs.find(d => d.value === link.dc);
                    const linkQty = parseFloat(link.quantity) || (link.products || []).reduce((ps, p) => ps + (parseFloat(p.qty) || 0), 0);
                    const linkUom = link.uom || (link.products || [])[0]?.uom || 'MTS';
                    const linkAmt = dcLinkAmount(link);
                    const realIdx = dcLinks.findIndex(l => l.dc === link.dc);
                    return (
                      <div key={`m-${idx}`} className="border border-slate-200 rounded-lg bg-white p-3">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="font-semibold text-slate-800 text-sm">{dcOption?.label || link.dc}</div>
                          <div className="text-right font-bold text-emerald-700 whitespace-nowrap">₹{linkAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                        </div>
                        {(link.products || []).length > 0 && (
                          <div className="mb-2">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Product</div>
                            <div className="text-xs text-slate-700 space-y-0.5">
                              {link.products.map((p, pi) => <div key={pi}>{p.name}</div>)}
                            </div>
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-2 mb-2">
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">Qty</div>
                            <div className="text-sm">{linkQty.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} {linkUom}</div>
                          </div>
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">Rate (₹/unit)</div>
                            <input type="number" step="0.01" min="0"
                              value={link.freight_rate ?? ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                setDcLinks(prev => prev.map((l, i) => i === realIdx ? { ...l, freight_rate: val } : l));
                              }}
                              className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-emerald-500"
                              placeholder="0.00" />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 mb-2">
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">Invoice No</div>
                            <div className="text-xs text-slate-700">{link.invoice_no || '-'}</div>
                          </div>
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">Invoice Date</div>
                            <CustomDatePicker
                              value={link.invoice_date || ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                setDcLinks(prev => prev.map((l, i) => i === realIdx ? { ...l, invoice_date: val } : l));
                              }}
                              className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-emerald-500" />
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-slate-500">Destination</div>
                          <div className="text-xs text-slate-700">{link.destination || '-'}</div>
                        </div>
                      </div>
                    );
                  })}
                  <div className="border-t-2 border-slate-300 pt-2 px-3 flex items-center justify-between text-sm font-semibold">
                    <span className="text-slate-600">Total {dcTotalQtyDisplay}</span>
                    <span className="text-emerald-700">₹{perDcBaseAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                </div>
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-sm" style={{ minWidth: '900px' }}>
                    <thead>
                      <tr className="bg-slate-50 border-b">
                        <th className="text-left px-3 py-2 font-medium text-slate-600 whitespace-nowrap">DC No</th>
                        <th className="text-left px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Product</th>
                        <th className="text-right px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Qty</th>
                        <th className="text-left px-3 py-2 font-medium text-slate-600 whitespace-nowrap">UOM</th>
                        <th className="text-right px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Rate (₹/unit)</th>
                        <th className="text-right px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Amount</th>
                        <th className="text-left px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Invoice No</th>
                        <th className="text-left px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Invoice Date</th>
                        <th className="text-left px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Destination</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dcLinks.filter(l => l.dc).map((link, idx) => {
                        const dcOption = allDCs.find(d => d.value === link.dc);
                        const linkQty = parseFloat(link.quantity) || (link.products || []).reduce((ps, p) => ps + (parseFloat(p.qty) || 0), 0);
                        const linkUom = link.uom || (link.products || [])[0]?.uom || 'MTS';
                        const linkAmt = dcLinkAmount(link);
                        const realIdx = dcLinks.findIndex(l => l.dc === link.dc);
                        return (
                          <tr key={idx} className="border-b">
                            <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">{dcOption?.label || link.dc}</td>
                            <td className="px-3 py-2 text-xs text-slate-700">
                              {(link.products || []).length > 0 ? link.products.map((p, pi) => <div key={pi} className="whitespace-nowrap">{p.name}</div>) : '-'}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">{linkQty.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{linkUom}</td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              <input type="number" step="0.01" min="0"
                                value={link.freight_rate ?? ''}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setDcLinks(prev => prev.map((l, i) => i === realIdx ? { ...l, freight_rate: val } : l));
                                }}
                                className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-right focus:ring-2 focus:ring-emerald-500"
                                style={{ width: '110px' }}
                                placeholder="0.00" />
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-slate-800 whitespace-nowrap">₹{linkAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{link.invoice_no || '-'}</td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              <CustomDatePicker
                                value={link.invoice_date || ''}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setDcLinks(prev => prev.map((l, i) => i === realIdx ? { ...l, invoice_date: val } : l));
                                }}
                                className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-emerald-500"
                                style={{ width: '150px' }} />
                            </td>
                            <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{link.destination || '-'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-50 font-semibold border-t-2 border-slate-300">
                        <td colSpan="2" className="px-3 py-2 text-right text-slate-600">Totals:</td>
                        <td colSpan="3" className="px-3 py-2 text-right text-slate-700">{dcTotalQtyDisplay}</td>
                        <td className="px-3 py-2 text-right text-emerald-700">₹{perDcBaseAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                        <td colSpan="3"></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
              )}

              {/* Sales Costs */}
              <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Cost Details</h3>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className={labelClass}>Total Quantity</label>
                    <input type="text" readOnly value={dcTotalQtyDisplay} className={readOnlyClass + ' font-semibold'} />
                    {Object.keys(dcTotalsByUom).length > 1 && <p className="text-xs text-slate-400 mt-0.5">Mixed UOMs — sum of each DC&apos;s quantity</p>}
                  </div>
                  <div>
                    <label className={labelClass}>Freight Amount (Base)</label>
                    <input type="text" readOnly value={`₹${salesBaseAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} className={readOnlyClass + ' font-semibold'} />
                    <p className="text-xs text-slate-400 mt-0.5">Sum of (Qty × Rate) across all DCs</p>
                  </div>
                  <div>
                    <label className={labelClass}>Discount (%)</label>
                    <input type="number" step="0.01" min="0" max="100" name="discount" value={salesData.discount} onChange={handleSalesChange} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Discounted Amount</label>
                    <input type="text" readOnly value={salesDiscountPct > 0 ? `₹${salesDiscountedBase.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'} className={readOnlyClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Mamul ({salesData.mmul_sign === 'PLUS' ? 'Plus' : 'Less'})</label>
                    <div className="flex gap-1">
                      <CustomSelect value={salesData.mmul_sign} onChange={(e) => setSalesData(prev => ({ ...prev, mmul_sign: e.target.value }))} className={inputClass} style={{ maxWidth: '95px' }}>
                        <option value="LESS">Less</option>
                        <option value="PLUS">Plus</option>
                      </CustomSelect>
                      <input type="number" step="0.01" name="mmul_less" value={salesData.mmul_less} onChange={handleSalesChange} className={inputClass} />
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>TDS Less</label>
                    <input type="number" step="0.01" name="tds_less" value={salesData.tds_less} onChange={handleSalesChange} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Less Amount ({salesData.less_amount_sign === 'PLUS' ? 'Plus' : 'Less'})</label>
                    <div className="flex gap-1">
                      <CustomSelect value={salesData.less_amount_sign} onChange={(e) => setSalesData(prev => ({ ...prev, less_amount_sign: e.target.value }))} className={inputClass} style={{ maxWidth: '95px' }}>
                        <option value="LESS">Less</option>
                        <option value="PLUS">Plus</option>
                      </CustomSelect>
                      <input type="number" step="0.01" name="less_amount" value={salesData.less_amount} onChange={handleSalesChange} className={inputClass} />
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>Additional Freight (₹)</label>
                    <input type="number" step="0.01" min="0" name="additional_freight" value={salesData.additional_freight} onChange={handleSalesChange} className={inputClass} />
                  </div>
                  <div className="flex items-end">
                    <div className="w-full p-4 bg-primary-50 rounded-lg border-2 border-primary-200">
                      <span className="text-xs text-primary-600 uppercase block font-semibold">Payable Amount</span>
                      <span className="text-xl font-bold text-primary-800">{`₹${salesPayable.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}</span>
                      {(salesTotalDeductions > 0 || salesAdditional > 0) && (
                        <span className="text-xs text-slate-500 block mt-1">
                          {salesAdditional > 0 && `+ Additional: ₹${salesAdditional.toLocaleString('en-IN', { minimumFractionDigits: 2 })} `}
                          {salesTotalDeductions > 0 && `- Deductions: ₹${salesTotalDeductions.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Sales Delivery & Decision */}
              <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Delivery Details</h3>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className={labelClass}>Destination</label>
                    <input type="text" name="destination" value={salesData.destination} onChange={handleSalesChange} className={inputClass} />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ============ COMMON: Additional Charges ============ */}
          <AdditionalCharges
            charges={additionalCharges}
            remarks={chargesRemarks}
            onChange={({ charges, remarks }) => { setAdditionalCharges(charges); setChargesRemarks(remarks); }}
          />

          {/* ============ COMMON: Transport Details ============ */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Transport Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>Lorry / Vehicle No</label>
                <input type="text" name="lorry_no" value={commonData.lorry_no} onChange={handleCommonChange} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Driver Name</label>
                <input type="text" name="driver_name" value={commonData.driver_name} onChange={handleCommonChange} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Driver Contact</label>
                <input type="text" name="driver_contact" value={commonData.driver_contact} onChange={handleCommonChange} className={inputClass} placeholder="Phone number" />
              </div>
              <div>
                <label className={labelClass}>Transport Document No</label>
                <input type="text" name="transport_document_no" value={commonData.transport_document_no} onChange={handleCommonChange} className={inputClass} placeholder="LR / Bilty / E-way bill no" />
              </div>
              <div>
                <label className={labelClass}>{freightType === 'purchase' ? 'Destination State' : 'Destination'}</label>
                <input type="text" name="destination_state" value={commonData.destination_state} onChange={handleCommonChange} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Dispatch Date</label>
                <CustomDatePicker name="dispatch_date" value={commonData.dispatch_date} onChange={handleCommonChange} className={inputClass} />
              </div>
              {freightType === 'purchase' && (
                <div>
                  <label className={labelClass}>Expected Delivery Date</label>
                  <CustomDatePicker name="expected_arrival_date" value={commonData.expected_arrival_date} onChange={handleCommonChange} className={inputClass} />
                </div>
              )}
            </div>
          </div>

          {/* ============ COMMON: Payment / Bank Details ============ */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Payment / Bank Details</h3>
            <p className="text-xs text-slate-500 -mt-2 mb-4">Beneficiary bank details for paying the transporter — also shown in the Freight Ledger.</p>

            {/* Per-transporter saved details: reuse the transporter's saved
                bank details, or save freshly-entered ones back to it. */}
            {selectedTransporterId && savedBankHasData && (
              <label className="flex items-center gap-2 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-3 w-fit cursor-pointer">
                <input type="checkbox" checked={useSavedBank} onChange={(e) => toggleUseSavedBank(e.target.checked)} className="cursor-pointer" />
                Use <span className="font-semibold">{selectedTransporterName}</span>'s saved bank details
              </label>
            )}
            {selectedTransporterId && !useSavedBank && (
              <label className="flex items-center gap-2 text-sm text-slate-700 mb-3 w-fit cursor-pointer">
                <input type="checkbox" checked={saveBankToTransporter} onChange={(e) => setSaveBankToTransporter(e.target.checked)} className="cursor-pointer" />
                Save these bank details to <span className="font-medium">{selectedTransporterName}</span> for next time
              </label>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className={labelClass}>Beneficiary Name</label>
                <input type="text" name="beneficiary_name" value={bankData.beneficiary_name} onChange={handleBankChange} disabled={useSavedBank} className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`} placeholder="Account holder name" />
              </div>
              <div>
                <label className={labelClass}>Bank Name</label>
                <input type="text" name="bank_name" value={bankData.bank_name} onChange={handleBankChange} disabled={useSavedBank} className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`} placeholder="e.g. ICICI Bank" />
              </div>
              <div>
                <label className={labelClass}>Account No</label>
                <input type="text" name="account_no" value={bankData.account_no} onChange={handleBankChange} disabled={useSavedBank} className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`} placeholder="Account number" />
              </div>
              <div>
                <label className={labelClass}>IFSC Code</label>
                <input type="text" name="ifsc_code" value={bankData.ifsc_code} onChange={handleBankChange} disabled={useSavedBank} className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`} placeholder="e.g. ICIC0001234" />
              </div>
            </div>
          </div>

          {/* ============ COMMON: Remarks ============ */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Remarks</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              {freightType === 'purchase' && (
                <div>
                  <label className={labelClass}>Delivery Remarks</label>
                  <textarea name="delivery_remarks" value={commonData.delivery_remarks} onChange={handleCommonChange} rows={3} className={inputClass} placeholder="Notes about delivery..." />
                </div>
              )}
              <div>
                <label className={labelClass}>Remarks</label>
                <textarea name="remarks" value={commonData.remarks} onChange={handleCommonChange} rows={3} className={inputClass} placeholder="General notes..." />
              </div>
            </div>
          </div>

          {/* 1. Receipt Attachments (auto-loaded from selected receipt) */}
          <div className="bg-white rounded-lg border border-blue-200 p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b border-blue-200 flex items-center gap-2">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-600"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
              Receipt Attachments ({receiptAttachments.length})
            </h3>
            {receiptAttachments.length > 0 ? (
              <div className="space-y-2">
                {receiptAttachments.map(att => (
                  <div key={att.id} className="flex items-center justify-between p-3 bg-blue-50 rounded-lg border border-blue-200">
                    <div className="flex items-center gap-3 min-w-0">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400 shrink-0"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{att.file_name}</p>
                        <p className="text-xs text-slate-500">{att.file_type} {att.file_size ? `• ${(att.file_size / 1024).toFixed(1)} KB` : ''}</p>
                      </div>
                    </div>
                    <a href={att.file} target="_blank" rel="noopener noreferrer" className="shrink-0 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700">View</a>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-400">{purchaseData.receipt_advice ? 'No attachments in this receipt' : 'Select a receipt advice to see attachments'}</p>
            )}
          </div>

          {/* 2. Attachments (manual upload) */}
          <FileAttachments module="FREIGHT" recordId={null} onPendingChange={(files) => { pendingAttachmentsRef.current = files; setPendingAttachments(files); }} />

          {freightType === 'sales' && (
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 text-sm text-blue-800">
              Payments can be added after creating the freight record from the detail page.
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(freightType === 'sales' ? '/freight/outward' : '/freight/inward')} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading}
              className={`px-4 sm:px-5 py-2 text-white rounded-lg text-sm font-medium disabled:opacity-50 ${freightType === 'purchase' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
              {isLoading ? 'Creating...' : `Create ${freightType === 'purchase' ? 'Inward' : 'Outward'} Freight`}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}

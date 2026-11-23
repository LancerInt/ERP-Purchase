import CustomDatePicker from "@/components/ui/CustomDatePicker";
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FileText, X, Check, Printer, AlertTriangle } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import { stringifyAddress, formatAddressDisplay } from '../../../components/common/AddressField';
import { formatCurrency, formatDate } from '@/utils/formatters';

// ─────────────────────────────────────────────────────────────────────
// Page: Create Sales Invoice
//
// DC-driven invoice generation. The page is read-only by design:
//   1. User picks one (or more) Dispatch Challan(s) that haven't been
//      invoiced yet — the dropdown is fed by
//      /api/sales/dc/available-for-invoice/ which excludes DCs already
//      linked to an active SalesInvoiceCheck.
//   2. The page POSTs `dc_ids` to /api/sales/invoices/invoice-data/
//      and assembles the invoice from the linked SO + customer +
//      company records.
//   3. The T-442 preview renders with computed CGST / SGST / IGST,
//      grand total, and amount-in-words.
//   4. Buttons: Save (commits to /api/sales/invoices/), Print
//      (window.print() against the preview node — print styles strip
//      the action bars), or Cancel (back to picker).
//
// There is NO manual-entry editable form on this page. Every field on
// the preview is derived from the linked records; if a value is wrong,
// the fix is in the underlying DC / SO / Customer master, not here.
// ─────────────────────────────────────────────────────────────────────

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

const PAYMENT_TERMS_OPTIONS = [
  { value: '', label: 'Select Payment Terms' },
  { value: 'IMMEDIATE', label: 'Immediate' },
  { value: 'NET15', label: 'Net 15 Days' },
  { value: 'NET30', label: 'Net 30 Days' },
  { value: 'NET45', label: 'Net 45 Days' },
  { value: 'NET60', label: 'Net 60 Days' },
  { value: 'CUSTOM', label: 'Custom' },
];

// Normalize SO payment terms (NET_15) to invoice format (NET15)
const normalizePaymentTerms = (val) => {
  if (!val) return '';
  const normalized = val.replace(/_/g, '').toUpperCase();
  const valid = PAYMENT_TERMS_OPTIONS.map(o => o.value);
  if (valid.includes(normalized)) return normalized;
  if (valid.includes(val)) return val;
  return val;
};

const emptyLine = {
  product: '',
  description: '',
  batch_no: '',
  hsn_sac: '',
  gst_rate: '',
  quantity: '',
  uom: '',
  rate: '',
  discount_percent: '',
};

// Convert number to Indian currency words
const numberToWordsINR = (num) => {
  if (num === 0) return 'Zero Only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const convert = (n) => {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' and ' + convert(n % 100) : '');
    if (n < 100000) return convert(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + convert(n % 1000) : '');
    if (n < 10000000) return convert(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + convert(n % 100000) : '');
    return convert(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + convert(n % 10000000) : '');
  };
  const rupees = Math.floor(Math.abs(num));
  const paise = Math.round((Math.abs(num) - rupees) * 100);
  let result = 'INR ' + convert(rupees);
  if (paise > 0) result += ' and ' + convert(paise) + ' Paise';
  return result + ' Only';
};

const calcLineAmount = (line) => {
  const qty = parseFloat(line.quantity) || 0;
  const rate = parseFloat(line.rate) || 0;
  const disc = parseFloat(line.discount_percent) || 0;
  return qty * rate - (qty * rate * disc / 100);
};

// T-442-style invoice date format: 26-Mar-2026
const formatInvoiceDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return formatDate(d);
};

// Indian-format currency without the ₹ symbol (for compact cells)
const inrNumber = (val) => {
  const num = Number(val);
  if (isNaN(num)) return '0.00';
  return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const GSTIN_STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '28': 'Andhra Pradesh',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh (New)',
};

const getStateFromGstin = (gstin) => {
  if (!gstin || gstin.length < 2) return { state: '', stateCode: '' };
  const code = gstin.substring(0, 2);
  return { state: GSTIN_STATE_CODES[code] || '', stateCode: code };
};

// Reverse of GSTIN_STATE_CODES — given a state name, return the 2-digit
// state code. Used as the fallback for the inter-state check when the
// buyer/company has no GSTIN (and therefore no code on the form), so
// we don't silently default to CGST+SGST and ship a wrong tax invoice.
const STATE_NAME_TO_CODE = Object.entries(GSTIN_STATE_CODES).reduce((m, [code, name]) => {
  m[name.toLowerCase()] = code;
  return m;
}, {});
const codeFromStateName = (state) => STATE_NAME_TO_CODE[(state || '').trim().toLowerCase()] || '';

// Robust inter-state determination. Prefers the explicit state codes
// (derived from GSTIN), but falls back to looking up codes from the
// full state names when GSTIN is missing. Returns:
//   { inter: bool, confident: bool }
// `confident=false` means we couldn't resolve one or both sides — the
// UI surfaces a warning so the user double-checks before saving.
const computeInterState = (companyCode, companyState, buyerCode, buyerState) => {
  const cCode = (companyCode || '').trim() || codeFromStateName(companyState);
  const bCode = (buyerCode || '').trim() || codeFromStateName(buyerState);
  if (!cCode || !bCode) return { inter: false, confident: false };
  return { inter: cCode !== bCode, confident: true };
};

export default function CreateSalesInvoice() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { options: companyOptions } = useLookup('/api/companies/');

  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const [selectedDcIds, setSelectedDcIds] = useState([]);
  // DCs available for invoicing — fetched from the backend, NOT
  // useLookup, because we need the per-DC enriched fields (customer
  // name, total amount, line count) that aren't on the standard DC
  // list serializer. Empty array while loading.
  const [availableDcs, setAvailableDcs] = useState([]);
  const [isLoadingDcs, setIsLoadingDcs] = useState(true);
  const [dcSearch, setDcSearch] = useState('');

  // 'form'    → empty state: shows the Invoice No (from DC) dropdown
  // 'invoice' → read-only T-442 preview of the picked invoice's data
  const [previewMode, setPreviewMode] = useState('form');

  // Ref to the rendered T-442 invoice node so we can capture its HTML
  // at save time and persist a frozen snapshot to the backend.
  const previewRef = useRef(null);

  const [formData, setFormData] = useState({
    invoice_no: '',
    invoice_date: new Date().toISOString().slice(0, 10),
    status: 'DRAFT',
    company: '',
    company_gstin: '',
    company_pan: '',
    company_msme_no: '',
    company_state: '',
    company_state_code: '',
    consignee_name: '',
    consignee_address: '',
    consignee_gstin: '',
    consignee_state: '',
    consignee_state_code: '',
    buyer_name: '',
    buyer_address: '',
    buyer_gstin: '',
    buyer_state: '',
    buyer_state_code: '',
    dc_reference: '',
    so_reference: '',
    buyers_order_no: '',
    buyers_order_date: '',
    delivery_note: '',
    delivery_note_date: '',
    other_references: '',
    dispatch_doc_no: '',
    dispatch_doc_date: '',
    dispatched_through: '',
    destination: '',
    terms_of_delivery: '',
    payment_terms: '',
    // Manual due date for the receivable. When blank the backend
    // derives the date from (1) SO.payment_due_date, (2) payment_terms
    // +N days, or (3) a 30-day fallback. When the user types or picks
    // a value here it wins over all of those.
    due_date: '',
    tally_invoice_no: '',
    customer: '',
    amount_in_words: '',
    remarks: '',
    declaration: '',
  });

  const [lines, setLines] = useState([{ ...emptyLine }]);

  // Open customer advances. When the user picks a DC (which sets the
  // customer), we fetch any OPEN/PARTIALLY_APPLIED advances for that
  // customer and surface them as a banner above the invoice preview.
  // The user can't apply advances from THIS page (apply happens on the
  // advance detail page once the invoice is saved + its receivable
  // ledger exists), but the banner makes sure they don't forget the
  // money's sitting there.
  const [openAdvances, setOpenAdvances] = useState([]);
  useEffect(() => {
    if (!formData.customer) { setOpenAdvances([]); return; }
    let cancelled = false;
    apiClient.get('/api/sales/advances/', {
      params: { customer: formData.customer, open: 1, page_size: 50 },
    }).then(r => {
      if (cancelled) return;
      const rows = (r.data?.results || r.data || []).filter(
        a => Number(a.balance_unused) > 0 && a.status !== 'CLOSED' && a.status !== 'FULLY_APPLIED',
      );
      setOpenAdvances(rows);
    }).catch(() => { if (!cancelled) setOpenAdvances([]); });
    return () => { cancelled = true; };
  }, [formData.customer]);

  // Fetch the DCs that are eligible for invoicing — anything already
  // linked to an active SalesInvoiceCheck is excluded server-side.
  // Re-fetched once on mount; if the user creates an invoice the page
  // navigates away so we don't need a refresh button here.
  useEffect(() => {
    setIsLoadingDcs(true);
    apiClient.get('/api/sales/dc/available-for-invoice/')
      .then(res => {
        setAvailableDcs(res.data || []);
      })
      .catch(() => setAvailableDcs([]))
      .finally(() => setIsLoadingDcs(false));
  }, []);

  // Pre-fill the next auto-generated invoice number so the payload is
  // never missing it on save (the dropdown's choice overwrites this).
  useEffect(() => {
    apiClient.get('/api/sales/invoices/next-number/')
      .then(r => setFormData(prev => ({ ...prev, invoice_no: r.data?.number || '' })))
      .catch(() => {});
  }, []);

  // Helper used inside fetchInvoiceData to enrich buyer/billing data
  // from the customer master (the SO might only carry the customer FK).
  const fetchCustomerAddresses = async (custId) => {
    if (!custId) return null;
    try {
      const res = await apiClient.get(`/api/customers/${custId}/`);
      return res.data;
    } catch {
      return null;
    }
  };

  // Pull SO/DC data behind a picked Invoice No so we have everything
  // needed to render the preview. Returns when the autofill finishes
  // (the dropdown's onChange awaits this before flipping to preview).
  // `soIdHint` lets the caller pass the SO id when it's already known
  // (the DC picker row carries it via available-for-invoice), so the
  // backend doesn't need to walk DCLine → linked_so_line to find it.
  const fetchInvoiceData = async (dcIds, soIdHint) => {
    if (dcIds.length === 0) return;
    try {
      const params = { dc_ids: dcIds.join(',') };
      const soId = soIdHint || formData.so_reference;
      if (soId) params.so_id = soId;
      const res = await apiClient.get('/api/sales/invoices/invoice-data/', { params });
      const data = res.data;

      if (data.so_ids && data.so_ids.length > 0) {
        setFormData(prev => ({ ...prev, so_reference: data.so_ids[0] }));
      }

      // Top-level buyers_order_no — populated whenever the picked DCs
      // can be traced (even partially) back to one or more Customer POs.
      // Set this BEFORE the SO block so the nested SO autofill still
      // runs through and refines individual fields if the SO resolves.
      if (data.buyers_order_no) {
        setFormData(prev => ({
          ...prev,
          buyers_order_no: prev.buyers_order_no || data.buyers_order_no,
        }));
      }

      if (data.so) {
        const so = data.so;
        let custBillingAddr = '';
        let custGstin = '';
        let custBillingState = '';
        let custStateCode = '';
        if (so.customer) {
          const cust = await fetchCustomerAddresses(so.customer);
          if (cust) {
            custGstin = cust.gstin || '';
            const gstinInfo = getStateFromGstin(custGstin);
            custStateCode = gstinInfo.stateCode;
            if (cust.billing_address && Object.keys(cust.billing_address).length > 0) {
              custBillingAddr = stringifyAddress(cust.billing_address);
              custBillingState = cust.billing_address.state || gstinInfo.state || '';
            } else {
              custBillingState = gstinInfo.state || '';
            }
          }
        }
        setFormData(prev => ({
          ...prev,
          so_reference: data.so_ids?.[0] || prev.so_reference,
          customer: so.customer || prev.customer,
          company: so.company || prev.company,
          company_gstin: so.company_gstin || prev.company_gstin,
          company_pan: so.company_pan || prev.company_pan,
          company_msme_no: so.company_msme_no || prev.company_msme_no,
          company_state: so.company_state || prev.company_state,
          company_state_code: so.company_state_code || prev.company_state_code,
          consignee_name: so.consignee_name || prev.consignee_name,
          consignee_address: so.consignee_address
            ? (typeof so.consignee_address === 'object' ? stringifyAddress(so.consignee_address) : so.consignee_address)
            : prev.consignee_address,
          consignee_gstin: so.consignee_gstin || prev.consignee_gstin,
          consignee_state: so.consignee_state || prev.consignee_state,
          consignee_state_code: so.consignee_state_code || prev.consignee_state_code,
          buyer_name: so.customer_name || prev.buyer_name,
          buyer_address: custBillingAddr || prev.buyer_address,
          buyer_gstin: custGstin || so.billing_gstin || prev.buyer_gstin,
          buyer_state: custBillingState || prev.buyer_state,
          buyer_state_code: custStateCode || prev.buyer_state_code,
          destination: so.destination || prev.destination,
          payment_terms: normalizePaymentTerms(so.payment_terms) || prev.payment_terms,
          terms_of_delivery: so.delivery_terms || prev.terms_of_delivery,
          dispatched_through: so.dispatched_through || prev.dispatched_through,
          // Buyer's Order No on the printed invoice = the customer's
          // own PO number(s) linked to the SO. The backend joins
          // multiple POs with " / "; we only auto-fill when the user
          // hasn't typed something manually.
          buyers_order_no: prev.buyers_order_no || so.buyers_order_no || '',
        }));
      }

      if (data.lines && data.lines.length > 0) {
        // Merge lines with the same product: sum quantities, keep rate/gst/hsn
        const merged = {};
        data.lines.forEach((l) => {
          const key = l.product || l.product_name;
          if (merged[key]) {
            merged[key].quantity = String(parseFloat(merged[key].quantity || 0) + parseFloat(l.quantity || 0));
          } else {
            merged[key] = {
              product: l.product || '', description: l.product_name || '',
              batch_no: l.batch_no || '',
              hsn_sac: l.hsn_sac || '', quantity: l.quantity || '',
              uom: l.uom || '', rate: l.rate || '',
              discount_percent: l.discount_percent || '0',
              gst_rate: l.gst_rate || '0',
            };
          }
        });
        const mergedLines = Object.values(merged);
        setLines(mergedLines);
      }
    } catch (err) {
      // Don't swallow the error — if autofill fails the user is staring
      // at an empty preview with no clue why. Surface it to the toast
      // and log the full payload to the console for diagnosis.
      console.error('fetchInvoiceData failed', err?.response?.status, err?.response?.data || err);
      toast.error(
        err?.response?.data?.detail
        || `Failed to load DC/SO data (${err?.response?.status || 'network'}). Check console for details.`
      );
    }
  };

  // Deep-link: ?dc_id=<uuid> auto-picks that DC and flips into
  // preview mode as if the user had used the dropdown. Triggered by
  // the "Create Invoice" button on a DC's detail page.
  useEffect(() => {
    const urlDcId = searchParams.get('dc_id');
    if (!urlDcId || availableDcs.length === 0) return;
    const match = availableDcs.find(d => d.id === urlDcId);
    if (match && selectedDcIds.length === 0) {
      pickDc(match);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableDcs]);

  // Wraps the "user picked this DC" interaction. Used both by the
  // dropdown onChange and the deep-link useEffect above.
  const pickDc = async (dc) => {
    setSelectedDcIds([dc.id]);
    // Seed everything we already know from the DC list row before the
    // network call — the available-for-invoice endpoint hands us
    // so_id, customer_id, and customer_name, so when the SO lookup
    // path inside invoice-data is unhappy (e.g. the DC has no
    // linked_so_line on any line), we still get a populated preview
    // instead of a blank canvas.
    setFormData(prev => ({
      ...prev,
      dc_reference: dc.id,
      dispatch_doc_no: dc.dc_no,
      // DC's dispatch_date is a DateTimeField on the backend (full ISO
      // with time component), but the invoice's dispatch_doc_date is a
      // DateField — slice to YYYY-MM-DD before assigning so the
      // serializer's strict date parser doesn't 400 on save.
      dispatch_doc_date: dc.dispatch_date
        ? String(dc.dispatch_date).slice(0, 10)
        : prev.dispatch_doc_date,
      destination: dc.destination || prev.destination,
      so_reference: dc.so_id || prev.so_reference,
      customer: dc.customer_id || prev.customer,
      buyer_name: dc.customer_name || prev.buyer_name,
    }));

    // If invoice-data can't find an SO (DC has no linked_so_line),
    // we still want buyer/billing info — pull it directly from the
    // customer master using the customer_id from the DC row.
    if (dc.customer_id) {
      try {
        const cust = await fetchCustomerAddresses(dc.customer_id);
        if (cust) {
          const gstinInfo = getStateFromGstin(cust.gstin || '');
          setFormData(prev => ({
            ...prev,
            buyer_name: prev.buyer_name || cust.customer_name || dc.customer_name || '',
            buyer_address: prev.buyer_address || (cust.billing_address ? stringifyAddress(cust.billing_address) : ''),
            buyer_gstin: prev.buyer_gstin || cust.gstin || '',
            buyer_state: prev.buyer_state || cust.billing_address?.state || gstinInfo.state || '',
            buyer_state_code: prev.buyer_state_code || gstinInfo.stateCode || '',
          }));
        }
      } catch { /* non-fatal — invoice-data may still fill these */ }
    }

    await fetchInvoiceData([dc.id], dc.so_id);
    toast.success(`DC ${dc.dc_no} loaded — review and save the invoice.`);
    setPreviewMode('invoice');
  };

  // Filtered DC list for the picker dropdown — matches against
  // dc_no, customer, destination so the user can find a DC by typing
  // any identifying string. Capped at 200 to keep the dropdown snappy.
  const filteredAvailableDcs = (() => {
    const term = dcSearch.trim().toLowerCase();
    if (!term) return availableDcs.slice(0, 200);
    return availableDcs.filter(d =>
      (d.dc_no || '').toLowerCase().includes(term)
      || (d.customer_name || '').toLowerCase().includes(term)
      || (d.destination || '').toLowerCase().includes(term)
      || (d.so_no || '').toLowerCase().includes(term)
    ).slice(0, 200);
  })();

  // Tax calculations — drive the preview's tax-summary rows.
  // We compute inter-state by first checking the 2-digit state codes
  // (derived from GSTIN), then falling back to a reverse lookup on
  // the full state name. This is the bug fix for "buyer has no GSTIN"
  // POs that previously silently fell through to CGST+SGST — for an
  // unregistered out-of-state buyer that's a wrong tax invoice. The
  // `taxConfident` flag drives a banner so the user can verify when
  // we genuinely can't tell.
  const { inter: isInterState, confident: taxConfident } = computeInterState(
    formData.company_state_code,
    formData.company_state,
    formData.buyer_state_code,
    formData.buyer_state,
  );

  const subtotal = lines.reduce((sum, l) => sum + calcLineAmount(l), 0);

  const taxDetails = lines.map(line => {
    const amount = calcLineAmount(line);
    const gstRate = parseFloat(line.gst_rate) || 0;
    const taxAmount = amount * gstRate / 100;
    if (isInterState) {
      return { cgst: 0, sgst: 0, igst: taxAmount, cgst_rate: 0, sgst_rate: 0, igst_rate: gstRate };
    }
    return { cgst: taxAmount / 2, sgst: taxAmount / 2, igst: 0, cgst_rate: gstRate / 2, sgst_rate: gstRate / 2, igst_rate: 0 };
  });

  const totalCGST = taxDetails.reduce((s, t) => s + t.cgst, 0);
  const totalSGST = taxDetails.reduce((s, t) => s + t.sgst, 0);
  const totalIGST = taxDetails.reduce((s, t) => s + t.igst, 0);
  const totalBeforeRound = subtotal + totalCGST + totalSGST + totalIGST;
  const grandTotal = Math.round(totalBeforeRound);

  // Auto-update amount in words when the grand total changes
  useEffect(() => {
    if (grandTotal > 0) {
      setFormData(prev => ({ ...prev, amount_in_words: numberToWordsINR(grandTotal) }));
    }
  }, [grandTotal]);

  // Commit. Same payload shape the editable form used; the Save
  // button on the preview's action bar is the only caller.
  const handleSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    setIsLoading(true);
    setErrors({});

    // Resolve the Payment Due Date we PERSIST on the invoice. We save the
    // exact date shown in the Payment Due Date banner so the receivable
    // created from this invoice inherits precisely that value (backend
    // priority 1: invoice.due_date wins). Priority: a manual date the user
    // picked, else the payment_terms-derived date (NET15/30/45/60). With
    // neither, we leave it null so the backend can still fall back to
    // SO.payment_due_date / its +30 default.
    const persistDueDate = (() => {
      if (formData.due_date) return String(formData.due_date).slice(0, 10);
      const PT_DAYS = { IMMEDIATE: 0, NET15: 15, NET30: 30, NET45: 45, NET60: 60 };
      const days = PT_DAYS[(formData.payment_terms || '').toUpperCase()];
      if (days == null || !formData.invoice_date) return null;
      const dt = new Date(String(formData.invoice_date).slice(0, 10));
      if (Number.isNaN(dt.getTime())) return null;
      dt.setDate(dt.getDate() + days);
      return dt.toISOString().slice(0, 10);
    })();

    const payload = {
      // All Date fields go through a YYYY-MM-DD slice so backend's
      // DateField strict parser doesn't 400 if anything upstream
      // accidentally set a full ISO datetime.
      invoice_date: formData.invoice_date
        ? String(formData.invoice_date).slice(0, 10)
        : null,
      company: formData.company || null,
      customer: formData.customer || null,
      consignee_name: formData.consignee_name,
      consignee_address: formData.consignee_address,
      consignee_gstin: formData.consignee_gstin,
      consignee_state: formData.consignee_state,
      consignee_state_code: formData.consignee_state_code,
      buyer_name: formData.buyer_name,
      buyer_address: formData.buyer_address,
      buyer_gstin: formData.buyer_gstin,
      buyer_state: formData.buyer_state,
      buyer_state_code: formData.buyer_state_code,
      dc_reference: formData.dc_reference || null,
      dc_reference_ids: selectedDcIds.length > 0 ? selectedDcIds : undefined,
      so_reference: formData.so_reference || null,
      buyers_order_no: formData.buyers_order_no,
      buyers_order_date: formData.buyers_order_date
        ? String(formData.buyers_order_date).slice(0, 10)
        : null,
      delivery_note: formData.delivery_note,
      delivery_note_date: formData.delivery_note_date
        ? String(formData.delivery_note_date).slice(0, 10)
        : null,
      other_references: formData.other_references,
      dispatch_doc_no: formData.dispatch_doc_no,
      // Belt-and-braces: trim any accidental time component before
      // POST. The backend serializer expects YYYY-MM-DD strictly.
      dispatch_doc_date: formData.dispatch_doc_date
        ? String(formData.dispatch_doc_date).slice(0, 10)
        : null,
      dispatched_through: formData.dispatched_through,
      destination: formData.destination,
      terms_of_delivery: formData.terms_of_delivery,
      payment_terms: formData.payment_terms || null,
      // Persist the effective Payment Due Date shown in the banner (manual
      // pick, else the payment_terms-derived date) so the receivable
      // inherits exactly that. Null only when there's no concrete basis,
      // letting the backend fall back to SO.payment_due_date / +30.
      due_date: persistDueDate,
      tally_invoice_no: (formData.tally_invoice_no || '').trim(),
      amount_in_words: formData.amount_in_words,
      remarks: formData.remarks,
      declaration: formData.declaration,
      invoice_lines: lines.map((line, idx) => ({
        product: line.product || null,
        description: line.description,
        batch_no: line.batch_no || '',
        hsn_sac: line.hsn_sac,
        gst_rate: parseFloat(line.gst_rate) || 0,
        quantity: parseFloat(line.quantity) || 0,
        uom: line.uom,
        rate: parseFloat(line.rate) || 0,
        discount_percent: parseFloat(line.discount_percent) || 0,
        cgst_rate: taxDetails[idx]?.cgst_rate || 0,
        sgst_rate: taxDetails[idx]?.sgst_rate || 0,
        igst_rate: taxDetails[idx]?.igst_rate || 0,
      })),
      // ── Frozen render snapshot ───────────────────────────────────
      // Capture the T-442 preview's HTML and the structured JSON the
      // renderer was working from. Stored verbatim on the invoice so
      // the detail page can reproduce the EXACT printed document even
      // after the source DC/SO/Customer/Company master is later edited.
      template_html: previewRef.current?.outerHTML || '',
      template_snapshot: {
        form: formData,
        lines,
        taxDetails,
        subtotal,
        totalCGST,
        totalSGST,
        totalIGST,
        totalBeforeRound,
        grandTotal,
        isInterState,
        captured_at: new Date().toISOString(),
      },
    };

    try {
      await apiClient.post('/api/sales/invoices/', payload);
      toast.success('Invoice created and saved with printable template.');
      navigate('/sales/invoices');
    } catch (err) {
      const msg = getApiErrorMessage(err);
      toast.error(msg || 'Failed to create invoice');
      if (err.response?.data) setErrors(err.response.data);
    } finally {
      setIsLoading(false);
    }
  };

  // Cancel from preview → fresh empty form + new auto-number.
  const handleCancel = () => {
    setPreviewMode('form');
    setSelectedDcIds([]);
    setLines([{ ...emptyLine }]);
    setFormData(prev => ({
      ...prev,
      invoice_no: '', dc_reference: '', so_reference: '',
      buyers_order_no: '', buyers_order_date: '',
      delivery_note: '', delivery_note_date: '',
      dispatch_doc_no: '', dispatch_doc_date: '',
      dispatched_through: '', destination: '',
      terms_of_delivery: '',
      consignee_name: '', consignee_address: '',
      consignee_gstin: '', consignee_state: '',
      consignee_state_code: '',
      buyer_name: '', buyer_address: '', buyer_gstin: '',
      buyer_state: '', buyer_state_code: '',
      amount_in_words: '',
    }));
    apiClient.get('/api/sales/invoices/next-number/')
      .then(r => setFormData(prev => ({ ...prev, invoice_no: r.data?.number || '' })))
      .catch(() => {});
  };


  return (
    <MainLayout>
      <PageHeader
        title={previewMode === 'invoice' ? 'Invoice Preview' : 'Create Sales Invoice'}
        breadcrumbs={[
          { label: 'Sales', path: '/sales' },
          { label: 'Invoices', path: '/sales/invoices' },
          { label: previewMode === 'invoice' ? 'Preview' : 'Create Invoice' },
        ]}
      />

      {/* ── Empty state — DC picker ─────────────────────────────── */}
      {previewMode === 'form' && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 max-w-4xl mx-auto">
          <div className="flex items-start gap-3 mb-4">
            <div className="rounded-lg bg-indigo-100 p-2 text-indigo-700">
              <FileText size={18} />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-800">Generate Invoice from a Dispatch Challan</h3>
              <p className="text-sm text-slate-500 mt-0.5">
                Pick a DC below. The invoice number is auto-generated, and every other field
                (line items, quantities, rates, GST, totals, buyer / consignee, ship-to) is
                assembled from the linked Sales Order and Customer master. The result is a
                read-only T-442 document you can save, print, or cancel from.
              </p>
            </div>
          </div>

          {isLoadingDcs ? (
            <div className="h-32 bg-slate-100 rounded animate-pulse" />
          ) : availableDcs.length === 0 ? (
            <div className="p-4 sm:p-6 bg-amber-50 border border-amber-200 rounded-lg text-center">
              <AlertTriangle size={20} className="text-amber-600 mx-auto mb-2" />
              <p className="text-sm text-amber-800 font-medium mb-1">No DCs available for invoicing</p>
              <p className="text-xs text-amber-700">
                Every active Dispatch Challan already has an invoice. Create a new DC from a Sales Order to invoice fresh dispatches.
              </p>
            </div>
          ) : (
            <>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Search Dispatch Challan
              </label>
              <input
                type="text"
                value={dcSearch}
                onChange={(e) => setDcSearch(e.target.value)}
                placeholder="Type DC number, customer, destination, or SO no…"
                className={inputClass + ' mb-3'}
              />

              <div className="border border-slate-200 rounded-lg max-h-96 overflow-y-auto bg-white divide-y">
                {filteredAvailableDcs.length === 0 ? (
                  <p className="px-3 py-4 sm:py-6 text-center text-sm text-slate-400">
                    No DCs match your search.
                  </p>
                ) : (
                  filteredAvailableDcs.map(dc => (
                    <button
                      type="button"
                      key={dc.id}
                      onClick={() => pickDc(dc)}
                      className="w-full text-left px-4 py-3 hover:bg-indigo-50 transition flex items-start gap-3"
                    >
                      <div className="flex-shrink-0 mt-0.5 w-10 h-10 rounded-lg bg-indigo-50 text-indigo-700 flex items-center justify-center font-semibold text-xs">
                        DC
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-semibold text-slate-900">{dc.dc_no}</span>
                          <span className="text-xs text-slate-500 whitespace-nowrap">
                            {dc.dispatch_date ? formatDate(dc.dispatch_date) : '—'}
                          </span>
                        </div>
                        <div className="text-sm text-slate-700 mt-0.5 truncate">
                          {dc.customer_name || <span className="text-slate-400 italic">No customer</span>}
                          {dc.so_no && <span className="text-slate-400"> · SO {dc.so_no}</span>}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs text-slate-500">
                          <span>{dc.line_count} line{dc.line_count !== 1 ? 's' : ''}</span>
                          <span>·</span>
                          <span>{Number(dc.total_qty || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} qty</span>
                          <span>·</span>
                          <span className="font-medium text-emerald-700">
                            {formatCurrency(dc.total_amount || 0)}
                          </span>
                          {dc.destination && (
                            <>
                              <span>·</span>
                              <span className="truncate">{dc.destination}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
              <p className="text-xs text-slate-500 mt-3">
                <strong>{availableDcs.length}</strong> DC{availableDcs.length !== 1 ? 's' : ''} ready to invoice.
                Click a row to generate the invoice document.
              </p>
            </>
          )}

          {errors && Object.keys(errors).length > 0 && (
            <pre className="mt-4 text-xs text-red-600 whitespace-pre-wrap">{JSON.stringify(errors, null, 2)}</pre>
          )}
        </div>
      )}

      {/* ── Read-only T-442 preview ─────────────────────────────── */}
      {previewMode === 'invoice' && (() => {
        // Aggregate the line items by HSN/SAC for the tax summary table.
        const hsnSummary = {};
        lines.forEach((line, idx) => {
          const hsn = line.hsn_sac || '-';
          const amount = calcLineAmount(line);
          const td = taxDetails[idx] || { cgst: 0, sgst: 0, igst: 0, cgst_rate: 0, sgst_rate: 0, igst_rate: 0 };
          if (!hsnSummary[hsn]) {
            hsnSummary[hsn] = {
              hsn, taxable: 0,
              cgst_rate: td.cgst_rate, cgst_amount: 0,
              sgst_rate: td.sgst_rate, sgst_amount: 0,
              igst_rate: td.igst_rate, igst_amount: 0,
              total_tax: 0,
            };
          }
          hsnSummary[hsn].taxable += amount;
          hsnSummary[hsn].cgst_amount += td.cgst;
          hsnSummary[hsn].sgst_amount += td.sgst;
          hsnSummary[hsn].igst_amount += td.igst;
          hsnSummary[hsn].total_tax += (td.cgst + td.sgst + td.igst);
        });
        const hsnRows = Object.values(hsnSummary);
        const totalQty = lines.reduce((sum, l) => sum + (parseFloat(l.quantity) || 0), 0);
        const totalTax = totalCGST + totalSGST + totalIGST;
        const primaryUom = (lines.find(l => l.uom)?.uom) || '';
        const buyerStateName = formData.buyer_state || '';
        const consigneeStateName = formData.consignee_state || '';

        return (
          <>
            {/* Action bar — hidden when printing. No "Edit" affordance:
                preview values come straight from the linked DC/SO and
                aren't editable here. */}
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 print:hidden">
              <div className="text-sm text-slate-600 flex items-start gap-2">
                <FileText size={14} className="text-primary-600 mt-0.5 shrink-0" />
                <span>
                  Reviewing <strong>{formData.invoice_no || 'new invoice'}</strong>
                  {' '}— read-only preview of the linked DC/SO data.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleCancel}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                >
                  <X size={14} /> Cancel & Pick Different DC
                </button>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                >
                  <Printer size={14} /> Print
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 whitespace-nowrap"
                >
                  <Check size={14} /> {isLoading ? 'Saving…' : 'Save Invoice'}
                </button>
              </div>
            </div>

            {/* Inter-state confidence banner. Sits OUTSIDE the
                previewRef so it doesn't get captured into the frozen
                template_html. Shows when we can't determine company
                vs buyer state from either the GSTIN-derived state code
                or the full state name — in that case the GST split
                defaults to CGST+SGST, which is wrong for an
                unregistered out-of-state buyer. Asking the user to
                fill the buyer state is far better than silently
                shipping a wrong tax invoice. */}
            {!taxConfident && (
              <div className="max-w-5xl mx-auto mb-3 px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-xs print:hidden">
                <strong>Heads up:</strong> Could not determine whether this is an inter-state or intra-state sale —
                {!formData.company_state_code && !formData.company_state && ' the company state is missing,'}
                {!formData.buyer_state_code && !formData.buyer_state && ' the buyer state is missing,'}
                {' '}so the invoice currently shows <strong>CGST + SGST</strong>. Fill in the buyer / company state (or GSTIN) before saving if this is actually an inter-state sale (IGST).
              </div>
            )}

            {/* Payment Due Date — editable. Always computes a default
                value from the payment_terms +N rule (or 30-day
                fallback) so the user sees the date that WOULD apply,
                but the input is editable: typing or picking a date
                here overrides everything (matches backend priority 1
                in InvoiceService._create_receivable_entry).
                Hidden in print so the printable T-442 stays clean. */}
            {formData.invoice_date && (() => {
              const PT_DAYS = { IMMEDIATE: 0, NET15: 15, NET30: 30, NET45: 45, NET60: 60 };
              const days = PT_DAYS[(formData.payment_terms || '').toUpperCase()];
              const dt = new Date(String(formData.invoice_date).slice(0, 10));
              if (Number.isNaN(dt.getTime())) return null;
              const offset = days != null ? days : 30;
              dt.setDate(dt.getDate() + offset);
              const computedIso = dt.toISOString().slice(0, 10);
              const hasManual = !!formData.due_date;
              const effectiveIso = hasManual ? String(formData.due_date).slice(0, 10) : computedIso;
              const sourceLabel = hasManual
                ? 'Manual override — wins over all derived values'
                : (days != null
                    ? `Derived from payment terms (${formData.payment_terms} → +${days} day${days === 1 ? '' : 's'})`
                    : 'Default +30 days (no payment terms picked) — pick a date below to override.');
              return (
                <div className="max-w-5xl mx-auto mb-3 px-3 py-2.5 rounded-lg border border-sky-200 bg-sky-50 text-sky-900 text-xs print:hidden">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold">Payment Due Date</p>
                      <p className="text-[11px] text-sky-700 mt-0.5">{sourceLabel}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <CustomDatePicker
                        value={effectiveIso}
                        min={String(formData.invoice_date).slice(0, 10)}
                        onChange={(e) => setFormData(prev => ({ ...prev, due_date: e.target.value }))}
                        className="border border-sky-300 rounded px-2 py-1 text-sm bg-white text-sky-900"
                      />
                      {hasManual && (
                        <button
                          type="button"
                          onClick={() => setFormData(prev => ({ ...prev, due_date: '' }))}
                          className="px-2 py-1 text-[11px] font-medium text-sky-700 border border-sky-300 rounded hover:bg-sky-100"
                          title="Clear the manual date and fall back to the payment-terms / SO derivation"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Tally Invoice No — optional. When filled and saved it's stored
                on the invoice and mirrored onto the linked DC(s). */}
            <div className="max-w-5xl mx-auto mb-3 px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-700 text-xs print:hidden">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold">Tally Invoice No <span className="font-normal text-slate-400">(optional)</span></p>
                  <p className="text-[11px] text-slate-500 mt-0.5">If filled, it's saved on the invoice and mirrored to the linked DC(s).</p>
                </div>
                <input
                  type="text"
                  value={formData.tally_invoice_no || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, tally_invoice_no: e.target.value }))}
                  placeholder="e.g. T-442"
                  className="border border-slate-300 rounded px-2 py-1 text-sm bg-white w-48 shrink-0"
                />
              </div>
            </div>

            {/* Open Customer Advances banner. This customer has paid us
                money in advance — fired purely informationally so the
                user can't forget to apply it after the invoice saves.
                Application itself happens on the advance detail page
                because we need the saved invoice's ReceivableLedger
                row to exist first. */}
            {openAdvances.length > 0 && (() => {
              const totalOpen = openAdvances.reduce((s, a) => s + Number(a.balance_unused || 0), 0);
              const inrFmt = (v) => formatCurrency(v);
              return (
                <div className="max-w-5xl mx-auto mb-3 px-3 py-2.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-900 text-xs print:hidden">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <strong>{openAdvances.length} open advance{openAdvances.length === 1 ? '' : 's'}</strong>
                      {' '}from this customer totalling <strong className="tabular-nums">{inrFmt(totalOpen)}</strong>.
                      <span className="text-emerald-700 ml-1">Save the invoice first, then open the advance to apply it.</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {openAdvances.slice(0, 3).map(a => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => window.open(`/sales/advances/${a.id}`, '_blank')}
                          className="px-2 py-0.5 rounded border border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-100 tabular-nums whitespace-nowrap"
                          title={`${a.advance_no} — Balance ${inrFmt(a.balance_unused)}`}
                        >
                          {a.advance_no} · {inrFmt(a.balance_unused)}
                        </button>
                      ))}
                      {openAdvances.length > 3 && (
                        <span className="px-2 py-0.5 text-emerald-700">+{openAdvances.length - 3} more</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* The invoice document */}
            <div ref={previewRef} className="bg-white border-2 border-slate-800 max-w-5xl mx-auto text-[12px] text-slate-900 print:border-black print:max-w-none">
              {/* Title */}
              <div className="grid grid-cols-3 border-b-2 border-slate-800">
                <div></div>
                <div className="text-center font-bold text-base py-2">Tax Invoice</div>
                <div className="text-right pr-3 py-2 text-[11px] italic">e-Invoice</div>
              </div>

              {/* Company block (left) + Invoice metadata block (right) */}
              <div className="grid grid-cols-2 border-b-2 border-slate-800">
                <div className="border-r-2 border-slate-800 p-3">
                  <div className="font-bold text-sm">
                    {(companyOptions.find(o => o.value === formData.company)?.label) || '—'}
                  </div>
                  <div className="mt-1"><span className="font-medium">GSTIN/UIN:</span> {formData.company_gstin || '—'}</div>
                  <div><span className="font-medium">State Name:</span> {formData.company_state || '—'}{formData.company_state_code ? `, Code: ${formData.company_state_code}` : ''}</div>
                  {formData.company_pan && <div><span className="font-medium">PAN:</span> {formData.company_pan}</div>}
                  {formData.company_msme_no && <div><span className="font-medium">Udyam/MSME No:</span> {formData.company_msme_no}</div>}
                </div>
                <div className="grid grid-cols-2">
                  <div className="border-r border-b border-slate-800 p-2">
                    <div className="text-[10px] text-slate-500">Invoice No.</div>
                    <div className="font-bold">{formData.invoice_no || '—'}</div>
                  </div>
                  <div className="border-b border-slate-800 p-2">
                    <div className="text-[10px] text-slate-500">Dated</div>
                    <div className="font-bold">{formatInvoiceDate(formData.invoice_date)}</div>
                  </div>
                  <div className="border-r border-b border-slate-800 p-2">
                    <div className="text-[10px] text-slate-500">Delivery Note</div>
                    <div>{formData.delivery_note || ''}</div>
                  </div>
                  <div className="border-b border-slate-800 p-2">
                    <div className="text-[10px] text-slate-500">Mode/Terms of Payment</div>
                    <div>{formData.payment_terms || ''}</div>
                  </div>
                  <div className="border-r border-b border-slate-800 p-2">
                    <div className="text-[10px] text-slate-500">Reference No. &amp; Date.</div>
                    <div>{formData.other_references || ''}</div>
                  </div>
                  <div className="border-b border-slate-800 p-2">
                    <div className="text-[10px] text-slate-500">Other References</div>
                    <div></div>
                  </div>
                  <div className="border-r border-b border-slate-800 p-2">
                    <div className="text-[10px] text-slate-500">Buyer&apos;s Order No.</div>
                    <div className="font-bold">{formData.buyers_order_no || ''}</div>
                  </div>
                  <div className="border-b border-slate-800 p-2">
                    <div className="text-[10px] text-slate-500">Dated</div>
                    <div className="font-bold">{formatInvoiceDate(formData.buyers_order_date)}</div>
                  </div>
                  <div className="border-r border-b border-slate-800 p-2">
                    <div className="text-[10px] text-slate-500">Dispatch Doc No.</div>
                    <div>{formData.dispatch_doc_no || ''}</div>
                  </div>
                  <div className="border-b border-slate-800 p-2">
                    <div className="text-[10px] text-slate-500">Delivery Note Date</div>
                    <div>{formatInvoiceDate(formData.delivery_note_date)}</div>
                  </div>
                  <div className="border-r border-slate-800 p-2">
                    <div className="text-[10px] text-slate-500">Dispatched through</div>
                    <div className="font-bold">{formData.dispatched_through || ''}</div>
                  </div>
                  <div className="p-2">
                    <div className="text-[10px] text-slate-500">Destination</div>
                    <div className="font-bold">{formData.destination || ''}</div>
                  </div>
                </div>
              </div>

              {/* Consignee block (full width) */}
              <div className="grid grid-cols-2 border-b-2 border-slate-800">
                <div className="border-r-2 border-slate-800 p-3">
                  <div className="text-[10px] text-slate-500">Consignee (Ship to)</div>
                  <div className="font-bold">{formData.consignee_name || '—'}</div>
                  <div className="whitespace-pre-line">{formatAddressDisplay(formData.consignee_address) || ''}</div>
                  <div className="mt-1"><span className="font-medium">GSTIN/UIN:</span> {formData.consignee_gstin || '—'}</div>
                  <div><span className="font-medium">State Name:</span> {consigneeStateName || '—'}{formData.consignee_state_code ? `, Code: ${formData.consignee_state_code}` : ''}</div>
                </div>
                <div className="p-3">
                  <div className="text-[10px] text-slate-500">Terms of Delivery</div>
                  <div className="font-bold">{formData.terms_of_delivery || ''}</div>
                </div>
              </div>

              {/* Buyer block */}
              <div className="border-b-2 border-slate-800 p-3">
                <div className="text-[10px] text-slate-500">Buyer (Bill to)</div>
                <div className="font-bold">{formData.buyer_name || '—'}</div>
                <div className="whitespace-pre-line">{formatAddressDisplay(formData.buyer_address) || ''}</div>
                <div className="mt-1"><span className="font-medium">GSTIN/UIN:</span> {formData.buyer_gstin || '—'}</div>
                <div><span className="font-medium">State Name:</span> {buyerStateName || '—'}{formData.buyer_state_code ? `, Code: ${formData.buyer_state_code}` : ''}</div>
              </div>

              {/* Line items table */}
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b-2 border-slate-800 font-bold text-center">
                    <th className="border-r border-slate-800 py-1 px-1 w-10">Sl No.</th>
                    <th className="border-r border-slate-800 py-1 px-2 text-left">Description of Goods</th>
                    <th className="border-r border-slate-800 py-1 px-1 w-20">Batch No</th>
                    <th className="border-r border-slate-800 py-1 px-1 w-20">HSN/SAC</th>
                    <th className="border-r border-slate-800 py-1 px-1 w-24">Quantity</th>
                    <th className="border-r border-slate-800 py-1 px-1 w-24">Rate</th>
                    <th className="border-r border-slate-800 py-1 px-1 w-10">per</th>
                    <th className="py-1 px-1 w-28 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => (
                    <tr key={i} className="align-top">
                      <td className="border-r border-slate-300 py-1 px-1 text-center">{i + 1}</td>
                      <td className="border-r border-slate-300 py-1 px-2 font-medium">{line.description || '—'}</td>
                      <td className="border-r border-slate-300 py-1 px-1 text-center">{line.batch_no || ''}</td>
                      <td className="border-r border-slate-300 py-1 px-1 text-center">{line.hsn_sac || ''}</td>
                      <td className="border-r border-slate-300 py-1 px-1 text-right font-medium">
                        {line.quantity ? `${inrNumber(line.quantity)} ${line.uom || ''}` : ''}
                      </td>
                      <td className="border-r border-slate-300 py-1 px-1 text-right">{inrNumber(line.rate)}</td>
                      <td className="border-r border-slate-300 py-1 px-1 text-center">{line.uom || ''}</td>
                      <td className="py-1 px-1 text-right font-medium">{inrNumber(calcLineAmount(line))}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={7} className="border-r border-slate-300"></td>
                    <td className="py-1 px-1 text-right border-t border-slate-400">{inrNumber(subtotal)}</td>
                  </tr>
                  {totalCGST > 0 && (
                    <tr className="italic">
                      <td colSpan={5} className="border-r border-slate-300"></td>
                      <td colSpan={2} className="border-r border-slate-300 py-1 px-1 text-right font-medium">CGST OUTPUT</td>
                      <td className="py-1 px-1 text-right">{inrNumber(totalCGST)}</td>
                    </tr>
                  )}
                  {totalSGST > 0 && (
                    <tr className="italic">
                      <td colSpan={5} className="border-r border-slate-300"></td>
                      <td colSpan={2} className="border-r border-slate-300 py-1 px-1 text-right font-medium">SGST OUTPUT</td>
                      <td className="py-1 px-1 text-right">{inrNumber(totalSGST)}</td>
                    </tr>
                  )}
                  {totalIGST > 0 && (
                    <tr className="italic">
                      <td colSpan={5} className="border-r border-slate-300"></td>
                      <td colSpan={2} className="border-r border-slate-300 py-1 px-1 text-right font-medium">IGST OUTPUT</td>
                      <td className="py-1 px-1 text-right">{inrNumber(totalIGST)}</td>
                    </tr>
                  )}
                  <tr className="font-bold border-t-2 border-slate-800">
                    <td colSpan={4} className="border-r border-slate-800 py-1 px-2 text-right">Total</td>
                    <td className="border-r border-slate-800 py-1 px-1 text-right">
                      {totalQty ? `${inrNumber(totalQty)} ${primaryUom}` : ''}
                    </td>
                    <td colSpan={2} className="border-r border-slate-800"></td>
                    <td className="py-1 px-1 text-right">₹ {inrNumber(grandTotal)}</td>
                  </tr>
                </tbody>
              </table>

              {/* Amount in words */}
              <div className="border-t-2 border-slate-800 p-2">
                <div className="text-[10px] text-slate-500">Amount Chargeable (in words)</div>
                <div className="font-bold">{formData.amount_in_words || '—'}</div>
                <div className="text-right text-[10px] italic -mt-4">E. &amp; O.E</div>
              </div>

              {/* HSN/SAC tax breakdown */}
              <table className="w-full border-collapse border-t-2 border-slate-800">
                <thead>
                  <tr className="border-b border-slate-800 font-bold text-center text-[11px]">
                    <th rowSpan={2} className="border-r border-slate-800 py-1 px-1">HSN/SAC</th>
                    <th rowSpan={2} className="border-r border-slate-800 py-1 px-1">Taxable<br />Value</th>
                    <th colSpan={2} className="border-r border-slate-800 py-1 px-1">CGST</th>
                    <th colSpan={2} className="border-r border-slate-800 py-1 px-1">SGST/UTGST</th>
                    <th rowSpan={2} className="py-1 px-1">Total<br />Tax Amount</th>
                  </tr>
                  <tr className="border-b border-slate-800 font-bold text-center text-[11px]">
                    <th className="border-r border-slate-800 py-1 px-1">Rate</th>
                    <th className="border-r border-slate-800 py-1 px-1">Amount</th>
                    <th className="border-r border-slate-800 py-1 px-1">Rate</th>
                    <th className="border-r border-slate-800 py-1 px-1">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {hsnRows.map(r => (
                    <tr key={r.hsn}>
                      <td className="border-r border-slate-300 py-1 px-1">{r.hsn}</td>
                      <td className="border-r border-slate-300 py-1 px-1 text-right">{inrNumber(r.taxable)}</td>
                      <td className="border-r border-slate-300 py-1 px-1 text-center">{r.cgst_rate ? `${r.cgst_rate}%` : ''}</td>
                      <td className="border-r border-slate-300 py-1 px-1 text-right">{inrNumber(r.cgst_amount)}</td>
                      <td className="border-r border-slate-300 py-1 px-1 text-center">{r.sgst_rate ? `${r.sgst_rate}%` : ''}</td>
                      <td className="border-r border-slate-300 py-1 px-1 text-right">{inrNumber(r.sgst_amount)}</td>
                      <td className="py-1 px-1 text-right">{inrNumber(r.total_tax)}</td>
                    </tr>
                  ))}
                  <tr className="font-bold border-t border-slate-800">
                    <td className="border-r border-slate-800 py-1 px-1 text-right">Total</td>
                    <td className="border-r border-slate-800 py-1 px-1 text-right">{inrNumber(subtotal)}</td>
                    <td className="border-r border-slate-800"></td>
                    <td className="border-r border-slate-800 py-1 px-1 text-right">{inrNumber(totalCGST)}</td>
                    <td className="border-r border-slate-800"></td>
                    <td className="border-r border-slate-800 py-1 px-1 text-right">{inrNumber(totalSGST)}</td>
                    <td className="py-1 px-1 text-right">{inrNumber(totalTax)}</td>
                  </tr>
                </tbody>
              </table>

              {/* Declaration + bank-details placeholder */}
              <div className="grid grid-cols-2 border-t-2 border-slate-800">
                <div className="border-r-2 border-slate-800 p-3">
                  <div className="text-[10px] text-slate-500">Declaration</div>
                  <div className="text-[11px] mt-1">
                    {formData.declaration || 'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.'}
                  </div>
                  {formData.company_pan && (
                    <div className="mt-2"><span className="font-medium">Company&apos;s PAN:</span> {formData.company_pan}</div>
                  )}
                </div>
                <div className="p-3">
                  <div className="text-[10px] text-slate-500">Company&apos;s Bank Details</div>
                  <div className="mt-1 text-[11px] text-slate-500 italic">
                    (Bank details will be applied from the selected Company master when the invoice is saved.)
                  </div>
                </div>
              </div>

              {/* Signatories */}
              <div className="grid grid-cols-3 border-t-2 border-slate-800 text-center text-[11px] py-4 sm:py-6">
                <div>Prepared by</div>
                <div>Verified by</div>
                <div className="font-bold">
                  for {(companyOptions.find(o => o.value === formData.company)?.label) || '—'}<br />
                  <span className="font-normal italic mt-4 sm:mt-6 inline-block">Authorised Signatory</span>
                </div>
              </div>

              <div className="text-center text-[11px] py-1 border-t border-slate-400">
                SUBJECT TO {(formData.destination || 'SALEM').toUpperCase()} JURISDICTION
              </div>
              <div className="text-center text-[11px] py-1 italic">
                This is a Computer Generated Invoice
              </div>
            </div>

            {/* External-invoice comparison removed in favour of the
                DC-anchored single-source-of-truth flow. */}
          </>
        );
      })()}
    </MainLayout>
  );
}

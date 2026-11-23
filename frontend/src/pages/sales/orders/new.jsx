import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2, Paperclip, FileText, Download, Eye, Link as LinkIcon } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import AddressField, { parseAddress, getDistrictState, formatAddressDisplay } from '../../../components/common/AddressField';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import { SALES_UOM_OPTIONS } from '../utils/uomOptions';
import { formatCurrency } from '@/utils/formatters';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

const DISPATCHED_THROUGH_OPTIONS = [
  { value: '', label: 'Select' },
  { value: 'BY_ROAD', label: 'By Road' },
  { value: 'BY_RAIL', label: 'By Rail' },
  { value: 'BY_AIR', label: 'By Air' },
  { value: 'BY_SEA', label: 'By Sea' },
  { value: 'BY_COURIER', label: 'By Courier' },
  { value: 'HAND_DELIVERY', label: 'Hand Delivery' },
  { value: 'SELF_PICKUP', label: 'Self Pickup' },
  { value: 'TRANSPORTER', label: 'Transporter' },
  { value: 'OTHER', label: 'Other' },
];

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const errorInputClass = 'w-full border border-red-400 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500';
const lockedInputClass = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-100 text-slate-600 cursor-not-allowed';

const GOODS_SUB_TYPE_OPTIONS = [
  { value: '', label: 'Select Category' },
  { value: 'RAW_MATERIAL', label: 'Raw Material' },
  { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'FINISHED_GOOD', label: 'Finished Good' },
  { value: 'SEMI_FINISHED', label: 'Semi Finished' },
  { value: 'TRADED_PRODUCTS', label: 'Traded Products' },
  { value: 'CAPITAL_GOOD', label: 'Capital Good' },
  { value: 'MACHINE_SPARES', label: 'Machine Spares' },
  { value: 'CONSUMABLES', label: 'Consumables' },
];

const emptySOLine = {
  product_category: 'FINISHED_GOOD',
  product: '',
  quantity_ordered: '',
  uom: 'KG',
  unit_price: '',
  discount: '0',
  gst: '0',
  remarks: '',
};

// Payment terms like "NET_45" → 45 days of credit. Returns 0 for terms
// without a day count (so the due date isn't touched).
const netDaysFromTerms = (terms) => {
  const m = String(terms || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
};
// Add N days to a YYYY-MM-DD date string; returns '' on bad input.
const addDaysISO = (isoDate, days) => {
  if (!isoDate || !days) return '';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
};

export default function CreateSalesOrder() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { canCreate } = usePermissions();
  const editable = canCreate('Sales Order');
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: productOptions, raw: rawProducts } = useLookup('/api/products/');
  // Header-level field permissions. Inputs whose key is HIDDEN are
  // skipped entirely on the form; READ_ONLY inputs render disabled.
  // Line-level perms (unit_price / discount / gst …) are scoped to the
  // 'Sales Order Line' module — they're applied where the line table
  // is rendered, not here.
  const { isHidden: isHeaderHidden, isReadOnly: isHeaderReadOnly } = useFieldPermissions('Sales Order');
  const { isHidden: isLineHidden, isReadOnly: isLineReadOnly } = useFieldPermissions('Sales Order Line');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  // Files attached to the Customer PO(s) selected on this SO. Fetched
  // whenever `selectedPOIds` changes so the user can see — before
  // saving — which documents will travel along to the new SO. The
  // backend handles the actual copy on save (see
  // SalesOrderCreateSerializer.create()), so this panel is read-only.
  const [linkedCpoAttachments, setLinkedCpoAttachments] = useState([]);
  const [errors, setErrors] = useState({});

  // Cascading dropdown states
  const [filteredCustomers, setFilteredCustomers] = useState([]);

  // Customer PO states — all confirmed, unlinked POs loaded on mount
  const [allAvailablePOs, setAllAvailablePOs] = useState([]);
  const [selectedPOIds, setSelectedPOIds] = useState([]);
  // All shipping addresses from CPO for user to choose
  const [cpoShippingAddresses, setCpoShippingAddresses] = useState([]);
  const [cpoAllBillingAddresses, setCpoAllBillingAddresses] = useState([]);

  const [formData, setFormData] = useState({
    so_no: '',
    customer: '',
    company: '',
    warehouse: '',
    so_date: new Date().toISOString().split('T')[0],
    price_list: '',
    freight_terms: 'TO_PAY',
    payment_terms: 'NET_15',
    currency: 'INR',
    required_ship_date: '',
    destination: '',
    delivery_terms: '',
    payment_due_date: '',
    dispatched_through: '',
    consignee_name: '',
    consignee_address: '',
    consignee_gstin: '',
    billing_name: '',
    billing_address: '',
    billing_gstin: '',
    special_instructions: '',
    remarks: '',
  });
  const [soLines, setSoLines] = useState([{ ...emptySOLine }]);
  // CPO line limits — stores max values from CPO parsed_lines (keyed by index)
  const [cpoLineLimits, setCpoLineLimits] = useState([]);

  // Warehouse picker: force the dropdown label to be just the
  // warehouse `name`. useLookup's default label-resolution chain
  // could otherwise fall through to warehouse_code on masters that
  // accidentally left `name` blank — the user wants only the name
  // to show.
  // `sales_scope=true` asks the Warehouse endpoint to restrict the
  // list to the current user's allowed warehouses (StakeholderUser
  // .warehouse_scope, with Sales Manager / Office Manager / IT Admin /
  // Finance / Accounts bypassing). Backend resolution lives in
  // sales.mixins._user_allowed_warehouse_ids.
  const { options: warehouseOptions } = useLookup(
    formData.company ? `/api/warehouses/?company=${formData.company}&sales_scope=true` : null,
    { labelField: 'name' },
  );

  // Fetch next SO number on mount
  useEffect(() => {
    apiClient.get('/api/sales/orders/next_so_number/')
      .then(res => {
        if (res.data?.so_no) {
          setFormData(prev => ({ ...prev, so_no: res.data.so_no }));
        }
      })
      .catch(() => {});
  }, []);

  // Fetch ALL available Customer POs on mount (confirmed, unlinked)
  useEffect(() => {
    const fetchAllPOs = async () => {
      try {
        const res = await apiClient.get('/api/sales/customer-po/?page_size=500');
        const list = res.data?.results || res.data || [];
        setAllAvailablePOs(list.filter(p =>
          p.status === 'CONFIRMED' &&
          (!p.linked_sos || p.linked_sos.length === 0) &&
          !p.linked_so_number
        ).map(p => ({
          value: p.id,
          label: `${p.upload_id}${p.po_number ? ` (${p.po_number})` : ''} — ${p.customer_name || ''}`,
          raw: p,
        })));
      } catch {
        setAllAvailablePOs([]);
      }
    };
    fetchAllPOs();
  }, []);

  // Auto-fill from URL params (when navigating from CPO list "Create SO" button)
  const [urlAutoFillDone, setUrlAutoFillDone] = useState(false);
  useEffect(() => {
    const cpoId = searchParams.get('cpo_id');
    if (!cpoId || urlAutoFillDone) return;
    setUrlAutoFillDone(true);
    handlePOSelect(cpoId);
  }, [allAvailablePOs]);

  // Linked Customer PO attachments — fetched whenever the SO links to
  // a different set of POs. The list is shown read-only above the SO's
  // own attachment panel so the user knows which files will be carried
  // forward to the new Sales Order when they save.
  useEffect(() => {
    let cancelled = false;
    if (selectedPOIds.length === 0) { setLinkedCpoAttachments([]); return; }
    Promise.all(selectedPOIds.map(id => apiClient.get(
      '/api/sales/attachments/', { params: { module: 'CUSTOMER_PO', record_id: id } },
    ).then(r => (r.data?.results || r.data || []).map(a => ({ ...a, _cpo_id: id })))
     .catch(() => [])))
      .then(perPo => {
        if (cancelled) return;
        const flat = perPo.flat();
        // Dedupe by file_name+file_size in case the same physical file
        // appears on multiple linked POs.
        const seen = new Set();
        const unique = flat.filter(f => {
          const k = `${f.file_name}::${f.file_size}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        setLinkedCpoAttachments(unique);
      });
    return () => { cancelled = true; };
  }, [selectedPOIds]);

  // Company changed → fetch customers for dropdown (for display only)
  useEffect(() => {
    if (!formData.company) {
      setFilteredCustomers([]);
      return;
    }
    apiClient.get(`/api/customers/?company=${formData.company}`)
      .then(res => {
        const list = res.data?.results || res.data || [];
        setFilteredCustomers(list.map(c => ({ value: c.id, label: c.customer_name || c.name || c.customer_code || c.id })));
      })
      .catch(() => setFilteredCustomers([]));
  }, [formData.company]);

  // Auto-fill Payment Due Date from the Payment Terms: Net X → SO Date + X
  // days. Re-runs whenever the terms or SO date change so the due date
  // always reflects the selected credit period (the user can still override
  // it manually afterwards until the terms / SO date change again).
  useEffect(() => {
    const days = netDaysFromTerms(formData.payment_terms);
    if (!days || !formData.so_date) return;
    const due = addDaysISO(formData.so_date, days);
    if (due && due !== formData.payment_due_date) {
      setFormData(prev => ({ ...prev, payment_due_date: due }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.payment_terms, formData.so_date]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => {
      const next = { ...prev, [name]: value };
      // Delivery-terms → Freight-terms auto-fill. Mirrors the
      // commercial reality:
      //   • EX_FACTORY  — customer collects at our gate and arranges
      //                   their own transport. WE never raise a
      //                   freight bill, so the field is blanked and
      //                   the dropdown is disabled (see UI below).
      //   • CIF / FOB / DOOR_DELIVERY  — we engage the transporter
      //                   and recover the cost from the customer. We
      //                   default freight_terms to "To Pay" so the
      //                   freight bill flows through correctly. The
      //                   user can still flip it to "Paid" if the
      //                   freight is bundled into the goods price.
      if (name === 'delivery_terms') {
        if (value === 'EX_FACTORY') {
          next.freight_terms = '';
        } else if (value) {
          // Only auto-fill when the field is currently empty OR was
          // the previous EX_FACTORY blank. Don't overwrite a manual
          // PAID pick the user already made for the same delivery
          // type.
          if (!prev.freight_terms) {
            next.freight_terms = 'TO_PAY';
          }
        }
      }
      return next;
    });
    if (errors[name]) setErrors(prev => ({ ...prev, [name]: '' }));
  };

  // Get product options filtered by category for a given line
  const getFilteredProducts = (category) => {
    if (!category) return productOptions;
    return rawProducts
      .filter(p => p.goods_sub_type === category)
      .map(p => ({
        value: p.id,
        label: p.product_name || p.name || p.sku_code || p.id,
      }));
  };

  // Handle PO selection → auto-fill ALL SO fields from PO
  const handlePOSelect = async (poId) => {
    if (!poId) return;
    if (selectedPOIds.includes(poId)) return;
    try {
      const res = await apiClient.get(`/api/sales/customer-po/${poId}/`);
      const po = res.data;

      setSelectedPOIds([poId]);

      // Fetch customers for dropdown so the customer field displays correctly
      if (po.company) {
        try {
          const custRes = await apiClient.get(`/api/customers/?company=${po.company}`);
          const custList = custRes.data?.results || custRes.data || [];
          setFilteredCustomers(custList.map(c => ({ value: c.id, label: c.customer_name || c.name || c.id })));
        } catch {}
      }

      // Auto-fill ALL header fields from PO (including company, customer, warehouse)
      {
        // Parse all shipping addresses from CPO
        const shipNames = (po.consignee_name || '').split(' | ').filter(Boolean);
        const shipAddrs = (po.consignee_address || '').split(' | ').filter(Boolean);
        const shipGstins = (po.consignee_gstin || '').split(' | ').filter(Boolean);
        const maxShip = Math.max(shipNames.length, shipAddrs.length, shipGstins.length, 1);
        const allShip = Array.from({ length: maxShip }, (_, i) => ({
          name: shipNames[i] || '', address: shipAddrs[i] || '', gstin: shipGstins[i] || '',
        }));
        setCpoShippingAddresses(allShip);

        // Parse all billing addresses. Carry the billing NAME across too —
        // the extractor captures it (buyer_billing_name) and the SO stores it
        // as billing_name; without this the bill-to party name is lost on
        // every SO created from a PO.
        const billNames = (po.billing_name || '').split(' | ').filter(Boolean);
        const billAddrs = (po.billing_address || '').split(' | ').filter(Boolean);
        const billGstins = (po.billing_gstin || '').split(' | ').filter(Boolean);
        const maxBill = Math.max(billNames.length, billAddrs.length, billGstins.length, 1);
        const allBill = Array.from({ length: maxBill }, (_, i) => ({
          name: billNames[i] || '', address: billAddrs[i] || '', gstin: billGstins[i] || '',
        }));
        setCpoAllBillingAddresses(allBill);

        // Default to first address
        const firstShip = allShip[0] || {};
        const firstBill = allBill[0] || {};
        setFormData(prev => {
          // Resolve effective delivery_terms first so freight_terms
          // can mirror it. EX_FACTORY → blank (we don't raise
          // freight); anything else → keep PO's value, otherwise
          // fall back to "To Pay" (the same default the auto-fill
          // rule in handleChange would have chosen).
          const effectiveDelivery = po.delivery_type || prev.delivery_terms;
          const isExFactory = effectiveDelivery === 'EX_FACTORY';
          const incomingFreight = isExFactory
            ? ''
            : (po.freight_terms || prev.freight_terms || 'TO_PAY');
          return {
          ...prev,
          company: po.company || prev.company,
          customer: po.customer || prev.customer,
          warehouse: po.warehouse || prev.warehouse,
          price_list: po.price_list || prev.price_list,
          freight_terms: incomingFreight,
          payment_terms: po.payment_terms || prev.payment_terms,
          currency: po.currency || prev.currency,
          required_ship_date: po.required_ship_date || prev.required_ship_date,
          delivery_terms: effectiveDelivery,
          payment_due_date: po.payment_due_date || prev.payment_due_date,
          dispatched_through: po.dispatched_through || prev.dispatched_through,
          consignee_name: firstShip.name || prev.consignee_name,
          consignee_address: firstShip.address || prev.consignee_address,
          consignee_gstin: firstShip.gstin || prev.consignee_gstin,
          billing_name: firstBill.name || prev.billing_name,
          billing_address: firstBill.address || prev.billing_address,
          billing_gstin: firstBill.gstin || prev.billing_gstin,
          special_instructions: po.special_instructions || prev.special_instructions,
          destination: getDistrictState(firstShip.address) || po.destination || prev.destination,
          };
        });
      }

      // Set PO lines as SO lines (replace, not merge) and store CPO limits
      const poLines = po.parsed_lines || [];
      if (poLines.length > 0) {
        const newSOLines = poLines.map(l => ({
          product_category: l.product_category || '',
          product: l.parsed_sku || '',
          quantity_ordered: l.quantity || '',
          uom: l.uom || 'KG',
          unit_price: l.price || '',
          discount: l.discount || '0',
          gst: l.gst || '0',
          remarks: l.line_remarks || '',
        }));
        setSoLines(newSOLines);
        // Store CPO line limits — SO values must not exceed these
        setCpoLineLimits(poLines.map(l => ({
          product: l.parsed_sku || '',
          quantity: parseFloat(l.quantity) || 0,
          unit_price: parseFloat(l.price) || 0,
          discount: parseFloat(l.discount) || 0,
          gst: parseFloat(l.gst) || 0,
          uom: l.uom || 'KG',
        })));
        toast.success(`${poLines.length} item(s) loaded from ${po.upload_id}`);
      }
    } catch {
      toast.error('Failed to load PO details');
    }
  };

  // Calculate line total: (qty * price) - discount + GST on after-discount amount
  const calcLineTotal = (line) => {
    const qty = parseFloat(line.quantity_ordered) || 0;
    const price = parseFloat(line.unit_price) || 0;
    const disc = parseFloat(line.discount) || 0;
    const gst = parseFloat(line.gst) || 0;
    const subtotal = qty * price;
    const afterDisc = subtotal - disc;
    const total = afterDisc + (afterDisc * gst / 100);
    return total;
  };

  // Product selected in line → auto-fill price, GST, discount from price list
  const hasCpoLimits = cpoLineLimits.length > 0;

  const handleLineChange = (index, field, value) => {
    const limit = cpoLineLimits[index];

    // When CPO is linked, block changes to locked fields
    if (limit && ['product', 'product_category', 'unit_price', 'discount', 'gst', 'uom'].includes(field)) {
      return; // These fields are locked to CPO values
    }

    // Cap quantity to CPO max
    if (limit && field === 'quantity_ordered') {
      const num = parseFloat(value);
      if (num > limit.quantity) {
        toast.error(`Quantity cannot exceed CPO limit: ${limit.quantity}`);
        return;
      }
    }

    setSoLines(prev => prev.map((line, i) => {
      if (i !== index) return line;
      const newLine = { ...line, [field]: value };

      // When category changes, reset product selection (only when no CPO)
      if (field === 'product_category') {
        newLine.product = '';
        newLine.unit_price = '';
        newLine.discount = '0';
        newLine.gst = '0';
      }

      if (field === 'product' && value) {
        const prod = rawProducts.find(p => p.id === value);
        if (prod) {
          if (!newLine.product_category && prod.goods_sub_type) {
            newLine.product_category = prod.goods_sub_type;
          }
          newLine.uom = prod.uom || newLine.uom;
        }
      }

      return newLine;
    }));
    if (errors.lines) setErrors(prev => ({ ...prev, lines: '' }));
  };

  const addLine = () => setSoLines(prev => [...prev, { ...emptySOLine }]);
  const removeLine = (index) => {
    if (soLines.length > 1) setSoLines(prev => prev.filter((_, i) => i !== index));
  };

  // Totals
  const grandTotal = soLines.reduce((sum, line) => sum + calcLineTotal(line), 0);
  const totalQty = soLines.reduce((sum, line) => sum + (parseFloat(line.quantity_ordered) || 0), 0);

  // Validation
  const validate = () => {
    const newErrors = {};

    if (!formData.company) newErrors.company = 'Company is required';
    if (!formData.customer) newErrors.customer = 'Customer is required';
    if (!formData.warehouse) newErrors.warehouse = 'Warehouse is required';
    if (selectedPOIds.length === 0) newErrors.customer_po = 'At least one Customer PO must be linked';
    if (!formData.so_date) newErrors.so_date = 'SO Date is required';
    // Freight Terms is only required when the seller is the party
    // arranging freight. EX_FACTORY = customer collects at our gate,
    // we never raise a freight bill, so the field is blanked + the
    // dropdown is disabled. Matches the auto-fill rule in handleChange.
    if (formData.delivery_terms !== 'EX_FACTORY' && !formData.freight_terms) {
      newErrors.freight_terms = 'Freight Terms is required';
    }
    if (!formData.payment_terms) newErrors.payment_terms = 'Payment Terms is required';
    if (!formData.currency) newErrors.currency = 'Currency is required';

    // Required Ship Date must be today or future
    if (formData.required_ship_date) {
      const today = new Date().toISOString().split('T')[0];
      if (formData.required_ship_date < today) {
        newErrors.required_ship_date = 'Ship date cannot be in the past';
      }
    }

    // Product lines validation
    const validLines = soLines.filter(l => l.product || l.quantity_ordered);
    if (validLines.length === 0) {
      newErrors.lines = 'At least one product line is required';
    } else {
      const lineErrors = [];
      soLines.forEach((line, i) => {
        const le = {};
        if (!line.product && (line.quantity_ordered || line.unit_price)) {
          le.product = 'Product is required';
        }
        if (line.product && (!line.quantity_ordered || parseFloat(line.quantity_ordered) <= 0)) {
          le.quantity = 'Qty must be greater than 0';
        }
        if (line.product && (!line.unit_price || parseFloat(line.unit_price) < 0)) {
          le.price = 'Unit price must be 0 or more';
        }
        if (line.product && line.discount && parseFloat(line.discount) < 0) {
          le.discount = 'Discount cannot be negative';
        }
        if (line.product && line.gst && (parseFloat(line.gst) < 0 || parseFloat(line.gst) > 100)) {
          le.gst = 'GST must be 0-100%';
        }
        // Discount should not exceed subtotal
        if (line.product && line.quantity_ordered && line.unit_price) {
          const subtotal = parseFloat(line.quantity_ordered) * parseFloat(line.unit_price);
          if (parseFloat(line.discount) > subtotal) {
            le.discount = 'Discount exceeds subtotal';
          }
        }
        // CPO limit checks
        const limit = cpoLineLimits[i];
        if (limit && line.product) {
          if (parseFloat(line.quantity_ordered) > limit.quantity) {
            le.quantity = `Cannot exceed CPO qty: ${limit.quantity}`;
          }
          if (parseFloat(line.unit_price) > limit.unit_price) {
            le.price = `Cannot exceed CPO price: ${limit.unit_price}`;
          }
          if (parseFloat(line.gst) > limit.gst) {
            le.gst = `Cannot exceed CPO GST: ${limit.gst}%`;
          }
        }
        if (Object.keys(le).length > 0) lineErrors[i] = le;
      });
      if (lineErrors.length > 0 || Object.keys(lineErrors).length > 0) {
        newErrors.lineErrors = lineErrors;
      }
    }

    // Check for duplicate products
    const productIds = soLines.filter(l => l.product).map(l => l.product);
    const duplicates = productIds.filter((id, idx) => productIds.indexOf(id) !== idx);
    if (duplicates.length > 0) {
      newErrors.lines = (newErrors.lines || '') + ' Duplicate products found.';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) {
      toast.error('Please fix the validation errors before saving.');
      return;
    }
    setIsLoading(true);
    try {
      const payload = {
        customer: formData.customer,
        company: formData.company,
        warehouse: formData.warehouse,
        price_list: formData.price_list || null,
        freight_terms: formData.freight_terms || '',
        payment_terms: formData.payment_terms || '',
        currency: formData.currency || 'INR',
        delivery_terms: formData.delivery_terms || '',
        required_ship_date: formData.required_ship_date || undefined,
        destination: formData.destination || '',
        payment_due_date: formData.payment_due_date || null,
        dispatched_through: formData.dispatched_through || '',
        consignee_name: formData.consignee_name || '',
        consignee_address: formData.consignee_address || '',
        consignee_gstin: formData.consignee_gstin || '',
        billing_name: formData.billing_name || '',
        billing_address: formData.billing_address || '',
        billing_gstin: formData.billing_gstin || '',
        special_instructions: formData.special_instructions || '',
        customer_po_ids: selectedPOIds.length > 0 ? selectedPOIds : undefined,
        remarks: formData.remarks || '',
        so_lines: soLines
          .filter(l => l.product && l.quantity_ordered)
          .map((l, i) => {
            const { product_category, ...lineData } = l;
            return {
              ...cleanFormData(lineData),
              line_no: i + 1,
              delivery_schedule_date: formData.delivery_date || null,
            };
          }),
      };
      if (formData.so_no) payload.so_no = formData.so_no;
      if (import.meta.env.DEV) console.log('[CreateSalesOrder] payload:', payload);
      const res = await apiClient.post('/api/sales/orders/', payload);
      const newId = res.data?.id;
      toast.success('Sales Order created successfully!');
      if (pendingAttachments.length > 0 && newId) { await uploadPendingFiles('SALES_ORDER', newId, pendingAttachments); }
      navigate(newId ? `/sales/orders/${newId}` : '/sales/orders');
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateSalesOrder] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const fmt = (v) => formatCurrency(v);
  const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

  const FieldError = ({ msg }) => msg ? <p className="text-xs text-red-500 mt-1">{msg}</p> : null;

  return (
    <MainLayout>
      <PageHeader
        title="Create Sales Order"
        breadcrumbs={[
          { label: 'Sales', path: '/sales' },
          { label: 'Orders', path: '/sales/orders' },
          { label: 'Create Sales Order' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
        <form onSubmit={handleSubmit} noValidate>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Customer PO — Select first, auto-fills everything */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Customer PO <span className="text-red-500">*</span> <span className="text-xs font-normal text-slate-500">(select to auto-fill all fields below)</span></h3>
            <div>
              <CustomSelect value={selectedPOIds[0] || ''} onChange={(e) => {
                const val = e.target.value;
                if (val) {
                  handlePOSelect(val);
                } else {
                  setSelectedPOIds([]);
                  setSoLines([{ ...emptySOLine }]);
                }
              }} className={`${errors.customer_po ? errorInputClass : inputClass} border-blue-300 bg-blue-50 text-base py-3`}>
                <option value="">-- Select Customer PO --</option>
                {allAvailablePOs.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </CustomSelect>
              <FieldError msg={errors.customer_po} />
              {allAvailablePOs.length === 0 && (
                <p className="text-xs text-slate-400 mt-1">No confirmed, unlinked Customer POs available.</p>
              )}
            </div>
          </div>

          {/* Order Details — auto-filled from CPO */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Order Details</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">SO No</label>
                <input type="text" name="so_no" value={formData.so_no} readOnly className={`${inputClass} bg-slate-50 text-slate-600`} placeholder="Auto-generating..." />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} className={errors.company ? errorInputClass : inputClass}>
                  <option value="">Select Company</option>
                  {companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                <FieldError msg={errors.company} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Customer <span className="text-red-500">*</span></label>
                <CustomSelect name="customer" value={formData.customer} onChange={handleChange} className={errors.customer ? errorInputClass : inputClass} disabled={!formData.company}>
                  <option value="">{formData.company ? 'Select Customer' : 'Select Company first'}</option>
                  {filteredCustomers.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                <FieldError msg={errors.customer} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleChange} disabled={!formData.company} className={`${errors.warehouse ? errorInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}>
                  <option value="">{formData.company ? 'Select Warehouse' : 'Select company first...'}</option>
                  {warehouseOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                <FieldError msg={errors.warehouse} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">SO Date <span className="text-red-500">*</span></label>
                <CustomDatePicker  name="so_date" value={formData.so_date} onChange={handleChange} className={errors.so_date ? errorInputClass : inputClass} />
                <FieldError msg={errors.so_date} />
              </div>
            </div>
          </div>

          {/* Terms & Currency */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Terms & Currency</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Freight Terms
                  {/* Asterisk only when the field is actually required.
                      EX_FACTORY skips freight entirely, so showing a
                      required-star there is misleading. */}
                  {formData.delivery_terms !== 'EX_FACTORY' && <span className="text-red-500"> *</span>}
                </label>
                <CustomSelect
                  name="freight_terms"
                  value={formData.freight_terms}
                  onChange={handleChange}
                  disabled={formData.delivery_terms === 'EX_FACTORY'}
                  className={`${errors.freight_terms ? errorInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}
                >
                  <option value="">
                    {formData.delivery_terms === 'EX_FACTORY'
                      ? 'Not applicable — customer arranges'
                      : 'Select Freight Terms'}
                  </option>
                  <option value="PAID">Paid</option>
                  <option value="TO_PAY">To Pay</option>
                </CustomSelect>
                {formData.delivery_terms === 'EX_FACTORY' && (
                  <p className="text-xs text-slate-500 mt-1">
                    Ex-Factory — customer collects at our gate, no freight raised by us.
                  </p>
                )}
                {formData.delivery_terms && formData.delivery_terms !== 'EX_FACTORY' && formData.freight_terms === 'TO_PAY' && (
                  <p className="text-xs text-emerald-600 mt-1">
                    Auto-filled "To Pay" — we engage the transporter, customer pays on delivery.
                  </p>
                )}
                <FieldError msg={errors.freight_terms} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Payment Terms <span className="text-red-500">*</span></label>
                <CustomSelect name="payment_terms" value={formData.payment_terms} onChange={handleChange} className={errors.payment_terms ? errorInputClass : inputClass}>
                  <option value="">Select Payment Terms</option>
                  <option value="NET_15">Net 15</option>
                  <option value="NET_30">Net 30</option>
                  <option value="NET_45">Net 45</option>
                </CustomSelect>
                <FieldError msg={errors.payment_terms} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Currency <span className="text-red-500">*</span></label>
                <CustomSelect name="currency" value={formData.currency} onChange={handleChange} className={errors.currency ? errorInputClass : inputClass}>
                  <option value="">Select Currency</option>
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                </CustomSelect>
                <FieldError msg={errors.currency} />
              </div>
            </div>
          </div>

          {/* Shipping & Reference */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Shipping & Reference</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Delivery Terms</label>
                <CustomSelect name="delivery_terms" value={formData.delivery_terms} onChange={handleChange} className={inputClass}>
                  <option value="">Select</option><option value="EX_FACTORY">Ex-Factory</option><option value="DOOR_DELIVERY">Door Delivery</option><option value="CIF">CIF</option><option value="FOB">FOB</option>
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Required Ship Date</label>
                <CustomDatePicker  name="required_ship_date" value={formData.required_ship_date} onChange={handleChange} min={new Date().toISOString().split('T')[0]} className={errors.required_ship_date ? errorInputClass : inputClass} />
                <FieldError msg={errors.required_ship_date} /></div>
              {/* Payment Due Date — propagates to the receivable created
                  from any invoice raised against this SO. Drives aging
                  in Receivables → Ledger. The earlier `Delivery Due Date`
                  and `Delivery Date` fields were removed: delivery
                  scheduling lives on the DC; the SO only carries the
                  Required Ship Date as a soft target. */}
              {!isHeaderHidden('payment_due_date') && (
                <div><label className="block text-sm font-medium text-slate-700 mb-1">Payment Due Date</label>
                  <CustomDatePicker
                    
                    name="payment_due_date"
                    value={formData.payment_due_date}
                    onChange={handleChange}
                    disabled={isHeaderReadOnly('payment_due_date')}
                    className={isHeaderReadOnly('payment_due_date') ? lockedInputClass : inputClass}
                  />
                  <p className="text-xs text-slate-400 mt-0.5">Flows to the receivable when the invoice is generated.</p>
                </div>
              )}
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Destination</label>
                <input type="text" name="destination" value={formData.destination} readOnly className={`${inputClass} bg-slate-50 text-slate-600`} />
                <p className="text-xs text-slate-400 mt-0.5">Auto-filled from shipping address (District, State)</p></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Dispatched Through</label>
                <CustomSelect name="dispatched_through" value={formData.dispatched_through} onChange={handleChange} className={inputClass}>
                  {DISPATCHED_THROUGH_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect></div>
            </div>
          </div>

          {/* Consignee & Billing */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Consignee & Billing</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
              {/* Shipping Address Selection */}
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                <h4 className="text-sm font-semibold text-blue-800 mb-3">Consignee (Ship To)</h4>

                {/* Show all CPO shipping addresses as selectable options */}
                {cpoShippingAddresses.length > 1 && (
                  <div className="mb-4">
                    <p className="text-xs font-medium text-blue-700 mb-2">Select shipping address from Customer PO:</p>
                    <div className="space-y-2">
                      {cpoShippingAddresses.map((sa, idx) => {
                        const isSelected = formData.consignee_name === sa.name && formData.consignee_address === sa.address;
                        return (
                          <label key={idx} className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition ${isSelected ? 'bg-blue-100 border-blue-400 ring-1 ring-blue-400' : 'bg-white border-slate-200 hover:border-blue-300'}`}>
                            <input type="radio" name="ship_addr_select" checked={isSelected}
                              onChange={() => setFormData(prev => ({
                                ...prev, consignee_name: sa.name, consignee_address: sa.address,
                                consignee_gstin: sa.gstin, destination: getDistrictState(sa.address),
                              }))}
                              className="mt-0.5 w-3.5 h-3.5 text-blue-600 border-slate-300 focus:ring-blue-500" />
                            <div className="text-xs">
                              <p className="font-semibold text-slate-800">{sa.name || `Address #${idx + 1}`}</p>
                              <p className="text-slate-600 mt-0.5">{formatAddressDisplay(sa.address) || 'No address'}</p>
                              {sa.gstin && <p className="text-slate-500 mt-0.5">GSTIN: {sa.gstin}</p>}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Editable selected address */}
                <div className="space-y-3">
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
                    <input type="text" name="consignee_name" value={formData.consignee_name} onChange={handleChange} className={inputClass} /></div>
                  <AddressField label="Address" value={formData.consignee_address} onChange={(v) => {
                    setFormData(prev => ({ ...prev, consignee_address: v, destination: getDistrictState(v) }));
                  }} />
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">GST No</label>
                    <input type="text" name="consignee_gstin" value={formData.consignee_gstin} onChange={handleChange} className={inputClass} /></div>
                </div>
              </div>

              {/* Billing Address Selection */}
              <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                <h4 className="text-sm font-semibold text-green-800 mb-3">Billing Address</h4>

                {/* Show all CPO billing addresses as selectable options */}
                {cpoAllBillingAddresses.length > 1 && (
                  <div className="mb-4">
                    <p className="text-xs font-medium text-green-700 mb-2">Select billing address from Customer PO:</p>
                    <div className="space-y-2">
                      {cpoAllBillingAddresses.map((ba, idx) => {
                        const isSelected = formData.billing_address === ba.address;
                        return (
                          <label key={idx} className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition ${isSelected ? 'bg-green-100 border-green-400 ring-1 ring-green-400' : 'bg-white border-slate-200 hover:border-green-300'}`}>
                            <input type="radio" name="bill_addr_select" checked={isSelected}
                              onChange={() => setFormData(prev => ({
                                ...prev, billing_name: ba.name || prev.billing_name,
                                billing_address: ba.address, billing_gstin: ba.gstin,
                              }))}
                              className="mt-0.5 w-3.5 h-3.5 text-green-600 border-slate-300 focus:ring-green-500" />
                            <div className="text-xs">
                              <p className="font-semibold text-slate-800">Billing #{idx + 1}</p>
                              <p className="text-slate-600 mt-0.5">{formatAddressDisplay(ba.address) || 'No address'}</p>
                              {ba.gstin && <p className="text-slate-500 mt-0.5">GSTIN: {ba.gstin}</p>}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Editable selected address */}
                <div className="space-y-3">
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
                    <input type="text" name="billing_name" value={formData.billing_name} onChange={handleChange} className={inputClass} /></div>
                  <AddressField label="Address" value={formData.billing_address} onChange={(v) => setFormData(prev => ({ ...prev, billing_address: v }))} />
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">GST No</label>
                    <input type="text" name="billing_gstin" value={formData.billing_gstin} onChange={handleChange} className={inputClass} /></div>
                </div>
              </div>
            </div>
          </div>

          {/* Product Lines */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Product Lines</h3>
              {!hasCpoLimits && (
                <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                  <Plus size={16} /> Add Product
                </button>
              )}
            </div>
            {errors.lines && (
              <div className="mb-3 p-3 bg-red-50 rounded-lg text-sm text-red-700">{errors.lines}</div>
            )}

            {/* Mobile-only stacked editor — one card per SO line.
                Shares state + handlers with the desktop table below. */}
            <div className="sm:hidden space-y-3">
              {soLines.map((line, index) => {
                const lineTotal = calcLineTotal(line);
                const qty = parseFloat(line.quantity_ordered) || 0;
                const le = errors.lineErrors?.[index] || {};
                const limit = cpoLineLimits[index];
                const locked = !!limit;
                return (
                  <div key={index} className="border border-slate-200 rounded-lg p-3 space-y-2 bg-white">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Line #{index + 1}</span>
                      {!locked && (
                        <button type="button" onClick={() => removeLine(index)} disabled={soLines.length <= 1} className="inline-flex items-center gap-1 text-red-500 disabled:opacity-30 text-xs">
                          <Trash2 size={14} /> Remove
                        </button>
                      )}
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Product Category</label>
                      <CustomSelect value={line.product_category || ''} onChange={(e) => handleLineChange(index, 'product_category', e.target.value)} disabled={locked} className={`${locked ? lockedInputClass : inputClass} w-full`}>
                        {GOODS_SUB_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </CustomSelect>
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Product <span className="text-red-500">*</span></label>
                      <CustomSelect value={line.product} onChange={(e) => handleLineChange(index, 'product', e.target.value)} disabled={locked || !line.product_category} className={`${locked ? lockedInputClass : le.product ? errorInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed w-full`}>
                        <option value="">{line.product_category ? 'Select Product' : 'Select Category first'}</option>
                        {getFilteredProducts(line.product_category).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </CustomSelect>
                      {le.product && <p className="text-xs text-red-500 mt-0.5">{le.product}</p>}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Qty <span className="text-red-500">*</span></label>
                        <input type="number" step="0.001" min="0.001" max={limit ? limit.quantity : undefined} value={line.quantity_ordered} onChange={(e) => handleLineChange(index, 'quantity_ordered', e.target.value)} disabled={locked} className={`${locked ? lockedInputClass : le.quantity ? errorInputClass : inputClass} w-full text-right`} placeholder="0" />
                        {limit && <p className="text-[10px] text-blue-500 mt-0.5">Max: {limit.quantity}</p>}
                        {le.quantity && <p className="text-xs text-red-500 mt-0.5">{le.quantity}</p>}
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">UOM</label>
                        <CustomSelect value={line.uom} onChange={(e) => handleLineChange(index, 'uom', e.target.value)} disabled={locked} className={`${locked ? lockedInputClass : inputClass} w-full`}>
                          {SALES_UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
                        </CustomSelect>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Unit Price</label>
                        <input type="number" step="0.01" min="0" value={line.unit_price} onChange={(e) => handleLineChange(index, 'unit_price', e.target.value)} readOnly={locked} className={`${locked ? lockedInputClass : le.price ? errorInputClass : inputClass} w-full text-right`} placeholder="0.00" />
                        {le.price && <p className="text-xs text-red-500 mt-0.5">{le.price}</p>}
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Discount</label>
                        <input type="number" step="0.01" min="0" value={line.discount} onChange={(e) => handleLineChange(index, 'discount', e.target.value)} readOnly={locked} className={`${locked ? lockedInputClass : le.discount ? errorInputClass : inputClass} w-full text-right`} />
                        {le.discount && <p className="text-xs text-red-500 mt-0.5">{le.discount}</p>}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">GST %</label>
                        <input type="number" step="0.01" min="0" max="100" value={line.gst} onChange={(e) => handleLineChange(index, 'gst', e.target.value)} readOnly={locked} className={`${locked ? lockedInputClass : le.gst ? errorInputClass : inputClass} w-full text-right`} />
                        {le.gst && <p className="text-xs text-red-500 mt-0.5">{le.gst}</p>}
                      </div>
                      <div className="flex flex-col justify-end">
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Total</label>
                        <div className="px-3 py-2 bg-slate-100 border border-slate-300 rounded text-right text-sm font-bold text-slate-900">{lineTotal > 0 ? fmt(lineTotal) : '-'}</div>
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Remarks</label>
                      <input type="text" value={line.remarks || ''} onChange={(e) => handleLineChange(index, 'remarks', e.target.value)} className={`${inputClass} w-full`} />
                    </div>
                  </div>
                );
              })}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-slate-500">Total Qty</span><span className="font-medium text-slate-800">{fmtQty(totalQty)}</span></div>
                <div className="flex justify-between pt-2 mt-1 border-t border-slate-300">
                  <span className="text-slate-700 font-semibold">Grand Total</span>
                  <span className="text-base font-bold text-slate-900">{fmt(grandTotal)}</span>
                </div>
              </div>
            </div>

            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                    <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Product Category</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Product <span className="text-red-500">*</span></th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Qty <span className="text-red-500">*</span></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Unit Price</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Discount</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">GST %</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Total</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Need to Dispatch</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Remarks</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {soLines.map((line, index) => {
                    const lineTotal = calcLineTotal(line);
                    const qty = parseFloat(line.quantity_ordered) || 0;
                    const le = errors.lineErrors?.[index] || {};
                    const limit = cpoLineLimits[index];
                    const locked = !!limit;
                    return (
                      <tr key={index} className="border-b">
                        <td className="px-3 py-2 text-slate-500">{index + 1}</td>
                        <td className="px-3 py-2">
                          <CustomSelect value={line.product_category || ''} onChange={(e) => handleLineChange(index, 'product_category', e.target.value)} disabled={locked} className={locked ? lockedInputClass : inputClass} style={{ minWidth: '150px' }}>
                            {GOODS_SUB_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </CustomSelect>
                        </td>
                        <td className="px-3 py-2">
                          <CustomSelect value={line.product} onChange={(e) => handleLineChange(index, 'product', e.target.value)} disabled={locked || !line.product_category} className={`${locked ? lockedInputClass : le.product ? errorInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`} style={{ minWidth: '180px' }}>
                            <option value="">{line.product_category ? 'Select Product' : 'Select Category first'}</option>
                            {getFilteredProducts(line.product_category).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </CustomSelect>
                          {le.product && <p className="text-xs text-red-500 mt-0.5">{le.product}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="0.001" min="0.001" max={limit ? limit.quantity : undefined} value={line.quantity_ordered} onChange={(e) => handleLineChange(index, 'quantity_ordered', e.target.value)} disabled={locked} className={locked ? lockedInputClass : le.quantity ? errorInputClass : inputClass} style={{ minWidth: '90px' }} placeholder="0" />
                          {limit && <p className="text-xs text-blue-500 mt-0.5">Max: {limit.quantity}</p>}
                          {le.quantity && <p className="text-xs text-red-500 mt-0.5">{le.quantity}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <CustomSelect value={line.uom} onChange={(e) => handleLineChange(index, 'uom', e.target.value)} disabled={locked} className={locked ? lockedInputClass : inputClass} style={{ minWidth: '80px' }}>
                            {SALES_UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
                          </CustomSelect>
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="0.01" min="0" value={line.unit_price} onChange={(e) => handleLineChange(index, 'unit_price', e.target.value)} readOnly={locked} className={locked ? lockedInputClass : le.price ? errorInputClass : inputClass} style={{ minWidth: '100px' }} placeholder="0.00" />
                          {le.price && <p className="text-xs text-red-500 mt-0.5">{le.price}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="0.01" min="0" value={line.discount} onChange={(e) => handleLineChange(index, 'discount', e.target.value)} readOnly={locked} className={locked ? lockedInputClass : le.discount ? errorInputClass : inputClass} style={{ minWidth: '80px' }} />
                          {le.discount && <p className="text-xs text-red-500 mt-0.5">{le.discount}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="0.01" min="0" max="100" value={line.gst} onChange={(e) => handleLineChange(index, 'gst', e.target.value)} readOnly={locked} className={locked ? lockedInputClass : le.gst ? errorInputClass : inputClass} style={{ minWidth: '70px' }} />
                          {le.gst && <p className="text-xs text-red-500 mt-0.5">{le.gst}</p>}
                        </td>
                        <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                          {lineTotal > 0 ? fmt(lineTotal) : '-'}
                        </td>
                        <td className="px-3 py-2 text-right font-medium whitespace-nowrap text-orange-600">
                          {qty > 0 ? fmtQty(qty) : '-'}
                        </td>
                        <td className="px-3 py-2">
                          <input type="text" value={line.remarks || ''} onChange={(e) => handleLineChange(index, 'remarks', e.target.value)} className={inputClass} style={{ minWidth: '120px' }} />
                        </td>
                        <td className="px-3 py-2">
                          {!locked && (
                            <button type="button" onClick={() => removeLine(index)} disabled={soLines.length <= 1} className="text-red-500 hover:text-red-700 disabled:opacity-30">
                              <Trash2 size={16} />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-semibold border-t-2 border-slate-300">
                    <td colSpan="3" className="px-3 py-2 text-right text-slate-600">Totals:</td>
                    <td className="px-3 py-2 text-right text-slate-800">{fmtQty(totalQty)}</td>
                    <td colSpan="4"></td>
                    <td className="px-3 py-2 text-right text-base text-slate-800">{fmt(grandTotal)}</td>
                    <td className="px-3 py-2 text-right font-semibold text-orange-600">{fmtQty(totalQty)}</td>
                    <td colSpan="2"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Additional Information */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Additional Information</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Special Instructions</label>
                <textarea name="special_instructions" value={formData.special_instructions} onChange={handleChange} rows={3} className={inputClass} placeholder="e.g. GOODS WILL BE ACCEPTED ONLY AFTER SATISFACTORY COMPLETION OF QUALITY PARAMETERS" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} rows={3} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Customer PO attachments that will travel with this Sales
              Order. Read-only — the backend copies these into the new
              SO record on save (see SalesOrderCreateSerializer.create).
              Hidden when no Customer PO is linked yet. */}
          {linkedCpoAttachments.length > 0 && (
            <div className="bg-blue-50 rounded-lg border border-blue-200 p-5 mt-4 sm:mt-6">
              <div className="flex items-center gap-2 mb-3">
                <LinkIcon size={16} className="text-blue-700" />
                <h3 className="text-base font-semibold text-blue-900">
                  Attachments from linked Customer PO
                  <span className="text-blue-600 font-normal text-sm ml-1">({linkedCpoAttachments.length})</span>
                </h3>
              </div>
              <p className="text-xs text-blue-700 mb-3">
                These files are attached to the Customer PO you linked above. They&apos;ll be automatically carried into this Sales Order when you save — no need to re-upload.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {linkedCpoAttachments.map(f => (
                  <div
                    key={f.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border border-blue-200 bg-white transition ${f.file ? 'cursor-pointer hover:shadow-sm' : ''}`}
                    onClick={() => f.file && window.open(f.file, '_blank')}
                    title={f.file ? 'Click to view' : ''}
                  >
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 border border-blue-200 bg-blue-50 text-blue-700">
                      <FileText size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate" title={f.file_name}>{f.file_name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {((f.file_size || 0) / 1024).toFixed(1)} KB
                      </p>
                    </div>
                    {/* View + Download — both always visible so the
                        user knows the file can be previewed without
                        downloading. Click the row OR the eye icon to
                        open in a new tab; click Download to save. The
                        section is read-only (no Delete) — the original
                        attachment lives on the source Customer PO. */}
                    {f.file && (
                      <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => window.open(f.file, '_blank')}
                          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
                          title="View"
                        >
                          <Eye size={15} />
                        </button>
                        <a
                          href={f.file}
                          download={f.file_name}
                          className="p-1.5 text-slate-600 hover:bg-slate-100 rounded transition"
                          title="Download"
                        >
                          <Download size={15} />
                        </a>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <FileAttachments module="SALES_ORDER" recordId={null} onPendingChange={setPendingAttachments} />

          {/* Actions */}
          <div className="flex flex-row justify-end gap-2 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="w-full sm:w-auto px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="w-full sm:w-auto px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}

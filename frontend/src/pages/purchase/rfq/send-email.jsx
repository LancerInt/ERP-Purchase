import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import EmailAutocomplete from '../../../components/common/EmailAutocomplete.jsx';
import { DEFAULT_PURCHASE_CC } from '../../../constants/emailDefaults.js';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup, { clearLookupCache } from '../../../hooks/useLookup.js';
import { formatDate, formatDateTime } from '@/utils/formatters';
import { VENDOR_TYPE_OPTIONS } from '../../../constants/vendorTypes.js';
import { VENDOR_GST_TREATMENT_OPTIONS, isRegisteredTreatment } from '../../../constants/gstTreatment.js';
import { panFromGstin, isValidGstin } from '../../../utils/gst.js';

function QuickCreateVendorModal({ open, onClose, onCreated, companyId }) {
  const { options: companies } = useLookup('/api/companies/');
  const [form, setForm] = useState({
    vendor_name: '', vendor_type: '', company: companyId || '',
    gst_treatment: '', gstin: '', pan: '', contact_email: '', contact_phone: '',
    is_msme: 'no',
  });
  const [vendorDoc, setVendorDoc] = useState(null);   // required vendor document
  const [msmeDoc, setMsmeDoc] = useState(null);       // required only when is_msme=yes
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (companyId && !form.company) setForm(p => ({ ...p, company: companyId }));
  }, [companyId]);

  // Reset form when modal opens (F1-016)
  useEffect(() => {
    if (open) {
      setForm({ vendor_name: '', vendor_type: '', company: companyId || '', gst_treatment: '', gstin: '', pan: '', contact_email: '', contact_phone: '', is_msme: 'no' });
      setVendorDoc(null);
      setMsmeDoc(null);
      setErrors({});
    }
  }, [open]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    const v = (name === 'gstin' || name === 'pan') ? value.toUpperCase() : value;
    setErrors(p => { const n = { ...p }; delete n[name]; return n; });
    setForm(p => {
      const next = { ...p, [name]: v };
      if (name === 'gstin' && !p.pan?.trim()) {
        const derived = panFromGstin(value);
        if (derived) next.pan = derived;
      }
      return next;
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.vendor_name.trim()) errs.vendor_name = 'Required';
    if (!form.vendor_type) errs.vendor_type = 'Required';
    if (!form.company) errs.company = 'Required';
    if (!form.gst_treatment) errs.gst_treatment = 'Required';
    if (isRegisteredTreatment(form.gst_treatment) && !form.gstin.trim()) errs.gstin = 'GSTIN required for registered vendor';
    if (form.gstin.trim() && !isValidGstin(form.gstin.trim())) errs.gstin = errs.gstin || 'Invalid GSTIN format (e.g. 22AAAAA0000A1Z5)';
    if (isRegisteredTreatment(form.gst_treatment) && !form.pan.trim()) errs.pan = 'PAN required for registered vendor';
    if (!form.contact_email.trim()) errs.contact_email = 'Required';
    // A vendor document is compulsory. And if the vendor is MSME, the MSME
    // certificate is compulsory too.
    if (!vendorDoc) errs.vendor_doc = 'A vendor document is required';
    if (form.is_msme === 'yes' && !msmeDoc) errs.msme_doc = 'MSME certificate is required';
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSaving(true);
    try {
      const { is_msme, ...rest } = form;
      const payload = cleanFormData({ ...rest });
      payload.vendor_type = form.vendor_type ? [form.vendor_type] : [];
      payload.is_msme = form.is_msme === 'yes';
      const NUMERIC = ['gst', 'sgst_rate', 'cgst_rate', 'igst_rate', 'tds_rate', 'tcs_rate', 'credit_limit', 'credit_days'];
      NUMERIC.forEach(k => { if (payload[k] === '' || payload[k] == null) delete payload[k]; });

      const fd = new FormData();
      Object.entries(payload).forEach(([k, v]) => {
        if (v === undefined || v === null) return;
        if (typeof v === 'object') fd.append(k, JSON.stringify(v));
        else if (typeof v === 'boolean') fd.append(k, v ? 'true' : 'false');
        else fd.append(k, v);
      });
      // Documents: the compulsory vendor doc, and the MSME certificate when
      // the vendor is MSME. The Vendor model has FileFields for both.
      if (vendorDoc) fd.append('written_agreement_doc', vendorDoc);
      if (form.is_msme === 'yes' && msmeDoc) fd.append('msme_certificate', msmeDoc);

      const res = await apiClient.post('/api/vendors/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(`Vendor "${res.data.vendor_name}" created!`);
      clearLookupCache('/api/vendors/');
      onCreated(res.data);
      onClose();
      setForm({ vendor_name: '', vendor_type: '', company: companyId || '', gst_treatment: '', gstin: '', pan: '', contact_email: '', contact_phone: '', is_msme: 'no' });
      setVendorDoc(null); setMsmeDoc(null);
      setErrors({});
    } catch (err) {
      const d = err.response?.data || {};
      const pick = (x) => Array.isArray(x) ? x[0] : typeof x === 'string' ? x : '';
      const srvErrs = {};
      for (const [k, v] of Object.entries(d)) { const m = pick(v); if (m) srvErrs[k] = m; }
      setErrors(srvErrs);
      toast.error(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const fieldClass = (name) => `w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 ${errors[name] ? 'border-red-400 bg-red-50' : 'border-slate-300'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-lg font-semibold text-slate-800">Quick Create Vendor</h2>
          <button type="button" onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-700">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {Object.keys(errors).length > 0 && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-xs font-medium text-red-700">Please fix the highlighted fields.</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-0.5">Vendor Name <span className="text-red-500">*</span></label>
              <input type="text" name="vendor_name" value={form.vendor_name} onChange={handleChange} maxLength={255} className={fieldClass('vendor_name')} placeholder="Enter vendor name" autoFocus />
              {errors.vendor_name && <p className="mt-1 text-xs text-red-600">{errors.vendor_name}</p>}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-0.5">Vendor Type <span className="text-red-500">*</span></label>
              <CustomSelect name="vendor_type" value={form.vendor_type} onChange={handleChange} className={fieldClass('vendor_type')}>
                <option value="">Select...</option>
                {VENDOR_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
              {errors.vendor_type && <p className="mt-1 text-xs text-red-600">{errors.vendor_type}</p>}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-0.5">Company <span className="text-red-500">*</span></label>
              <CustomSelect name="company" value={form.company} onChange={handleChange} className={fieldClass('company')}>
                <option value="">Select...</option>
                {companies.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </CustomSelect>
              {errors.company && <p className="mt-1 text-xs text-red-600">{errors.company}</p>}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-0.5">GST Treatment <span className="text-red-500">*</span></label>
              <CustomSelect name="gst_treatment" value={form.gst_treatment} onChange={handleChange} className={fieldClass('gst_treatment')}>
                <option value="">Select...</option>
                {VENDOR_GST_TREATMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
              {errors.gst_treatment && <p className="mt-1 text-xs text-red-600">{errors.gst_treatment}</p>}
              {!form.gst_treatment && <p className="mt-1 text-xs text-slate-500">Select &quot;Unregistered Business&quot; if no GSTIN</p>}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-0.5">GSTIN {isRegisteredTreatment(form.gst_treatment) && <span className="text-red-500">*</span>}</label>
              <input type="text" name="gstin" value={form.gstin} onChange={handleChange} maxLength={15} className={fieldClass('gstin')} placeholder="Enter GSTIN" />
              {errors.gstin && <p className="mt-1 text-xs text-red-600">{errors.gstin}</p>}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-0.5">PAN {isRegisteredTreatment(form.gst_treatment) && <span className="text-red-500">*</span>}</label>
              <input type="text" name="pan" value={form.pan} onChange={handleChange} maxLength={10} className={fieldClass('pan')} placeholder="Enter PAN" />
              {errors.pan && <p className="mt-1 text-xs text-red-600">{errors.pan}</p>}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-0.5">Contact Email <span className="text-red-500">*</span></label>
              <input type="email" name="contact_email" value={form.contact_email} onChange={handleChange} className={fieldClass('contact_email')} placeholder="Enter email" />
              {errors.contact_email && <p className="mt-1 text-xs text-red-600">{errors.contact_email}</p>}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-0.5">Contact Phone</label>
              <input type="text" name="contact_phone" value={form.contact_phone} onChange={handleChange} className={fieldClass('contact_phone')} placeholder="Enter phone" />
            </div>
          </div>

          {/* MSME — Yes/No. When Yes, the MSME certificate is required. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-0.5">MSME? <span className="text-red-500">*</span></label>
              <div className="flex items-center gap-4 h-[38px]">
                <label className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                  <input type="radio" name="is_msme" value="yes" checked={form.is_msme === 'yes'} onChange={handleChange} /> Yes
                </label>
                <label className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                  <input type="radio" name="is_msme" value="no" checked={form.is_msme === 'no'} onChange={handleChange} /> No
                </label>
              </div>
            </div>
            {form.is_msme === 'yes' && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">MSME Certificate <span className="text-red-500">*</span></label>
                <label className={`flex items-center gap-1.5 px-3 h-[38px] text-sm border rounded-lg cursor-pointer hover:bg-slate-50 ${errors.msme_doc ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}>
                  <span className="truncate text-slate-600">{msmeDoc ? msmeDoc.name : 'Attach MSME certificate'}</span>
                  <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { setMsmeDoc(e.target.files?.[0] || null); setErrors(p => { const n = { ...p }; delete n.msme_doc; return n; }); }} />
                </label>
                {errors.msme_doc && <p className="mt-1 text-xs text-red-600">{errors.msme_doc}</p>}
              </div>
            )}
          </div>

          {/* Compulsory vendor document. */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-0.5">Vendor Document <span className="text-red-500">*</span></label>
            <label className={`flex items-center gap-1.5 px-3 h-[38px] text-sm border rounded-lg cursor-pointer hover:bg-slate-50 ${errors.vendor_doc ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}>
              <span className="truncate text-slate-600">{vendorDoc ? vendorDoc.name : 'Attach a document (GST cert / agreement / ID)'}</span>
              <input type="file" accept="image/*,.pdf,.docx" className="hidden" onChange={(e) => { setVendorDoc(e.target.files?.[0] || null); setErrors(p => { const n = { ...p }; delete n.vendor_doc; return n; }); }} />
            </label>
            {errors.vendor_doc && <p className="mt-1 text-xs text-red-600">{errors.vendor_doc}</p>}
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50">
              {saving ? 'Creating...' : 'Create Vendor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function SendRFQEmail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canSendEmail, isLoading: isLoadingPerms } = usePermissions();

  // Data states
  const [rfq, setRfq] = useState(null);
  const [fromEmail, setFromEmail] = useState('');  // real sending mailbox (per-company purchase box)
  const [linkedPRs, setLinkedPRs] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [emailLogs, setEmailLogs] = useState([]);

  // Smart vendor routing states
  const [autoVendors, setAutoVendors] = useState([]);
  const [autoVendorIds, setAutoVendorIds] = useState(new Set());
  // Map vendor_id → [product_name, ...] — comes from the
  // /rfq/{id}/vendors/ endpoint's `vendor_products` block. Used to
  // suffix vendor labels with `(Product A, Product B)` in every
  // vendor render site below. Empty list for manually-added vendors
  // (vendors that aren't a preferred supplier for any RFQ product).
  const [vendorProductsMap, setVendorProductsMap] = useState({});

  // Per-line-item routing: the buyer chooses which line items go to which
  // vendors. rfqProducts = the RFQ's line items (from /rfq/{id}/products/);
  // lineVendors maps each line's key → the vendor ids chosen for it. The set
  // of vendors who actually receive emails (selectedVendorIds) is derived
  // from this as the union of every line's chosen vendors.
  const [rfqProducts, setRfqProducts] = useState([]);
  const [lineVendors, setLineVendors] = useState({});
  const [lineVendorsInit, setLineVendorsInit] = useState(false);
  const [activeAddLine, setActiveAddLine] = useState(null); // productKey whose add-vendor box is open
  const savedRoutingRef = useRef(null);
  const saveTimerRef = useRef(null);
  const [addQuery, setAddQuery] = useState('');

  // UI states
  const [selectedVendorIds, setSelectedVendorIds] = useState([]);
  const [showManualVendors, setShowManualVendors] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [sendResults, setSendResults] = useState(null);
  const [showCreateVendor, setShowCreateVendor] = useState(false);
  const [createVendorForLine, setCreateVendorForLine] = useState(null);

  // Keep backward-compatible alias for existing code (confirmation dialog, send handler, etc.)
  const selectedVendors = selectedVendorIds;

  // Resolve the actual From mailbox — the per-company purchase box (env
  // <COMPANY>_PURCHASE_EMAIL_HOST_USER…) for this RFQ's buying company when
  // configured, else the shared purchase box — so the preview's From matches
  // the address the send will really use. Re-runs once the RFQ (and its
  // company_code) has loaded.
  useEffect(() => {
    apiClient.get('/api/communications/resolved-sender/', { params: { purpose: 'purchase', company: rfq?.company_code || '' } })
      .then(r => setFromEmail(r.data?.from_email || ''))
      .catch(() => {});
  }, [rfq?.company_code]);

  // Fetch all data on mount
  useEffect(() => {
    const fetchAll = async () => {
      setIsLoadingData(true);
      try {
        const [rfqRes, vendorsRes, templatesRes, logsRes, autoVendorsRes, productsRes, routingRes] = await Promise.allSettled([
          apiClient.get(`/api/purchase/rfq/${id}/`),
          apiClient.get('/api/vendors/', { params: { page_size: 500 } }),
          apiClient.get('/api/communications/templates/'),
          apiClient.get(`/api/communications/email-logs/?rfq=${id}`),
          apiClient.get(`/api/purchase/rfq/${id}/vendors/`),
          apiClient.get(`/api/purchase/rfq/${id}/products/`),
          apiClient.get(`/api/purchase/rfq/${id}/vendor-routing/`),
        ]);

        if (productsRes.status === 'fulfilled') {
          const prods = Array.isArray(productsRes.value.data)
            ? productsRes.value.data
            : (productsRes.value.data?.results || []);
          setRfqProducts(prods);
        }

        if (rfqRes.status === 'fulfilled') {
          const rfqData = rfqRes.value.data;
          setRfq(rfqData);
          // Fetch linked PR details
          const prIds = rfqData.linked_prs || [];
          if (prIds.length > 0) {
            const prPromises = prIds.map(prId => apiClient.get(`/api/purchase/requests/${prId}/`).catch(() => null));
            const prResults = await Promise.all(prPromises);
            // Drop skip-routed lines at load — the vendor routing map and the
            // line-items preview must only cover what this RFQ actually asks.
            setLinkedPRs(prResults.filter(r => r !== null).map(r => ({
              ...r.data,
              lines: (r.data.lines || []).filter(l => !l.allow_rfq_skip),
            })));
          }
        } else {
          toast.error('Failed to load RFQ details');
        }

        if (vendorsRes.status === 'fulfilled') {
          const vendorData = vendorsRes.value.data?.results || vendorsRes.value.data || [];
          setVendors(vendorData);
        }

        if (templatesRes.status === 'fulfilled') {
          const templateData = templatesRes.value.data?.results || templatesRes.value.data || [];
          setTemplates(templateData);
          // Auto-select default template
          const defaultTpl = templateData.find(t => t.is_default);
          if (defaultTpl) setSelectedTemplate(defaultTpl.id);
          else if (templateData.length > 0) setSelectedTemplate(templateData[0].id);
        }

        if (logsRes.status === 'fulfilled') {
          const logData = logsRes.value.data?.results || logsRes.value.data || [];
          setEmailLogs(logData);
        }

        // Process auto vendors from product mapping
        if (autoVendorsRes.status === 'fulfilled') {
          const payload = autoVendorsRes.value.data || {};
          const autoData = payload.auto_vendors || payload.vendors || payload || [];
          const autoList = Array.isArray(autoData) ? autoData : [];
          setAutoVendors(autoList);
          const autoIds = new Set(autoList.map(v => v.id));
          setAutoVendorIds(autoIds);
          // selectedVendorIds is now derived from the per-line routing
          // (see the lineVendors effects below), so we no longer pre-select
          // the flat auto-vendor list here — the per-line seeding does it.
          // Capture the vendor → products lookup. Backend keys it by
          // string vendor id; we keep it as-is and the label helper
          // coerces incoming ids to string for lookup.
          if (payload.vendor_products && typeof payload.vendor_products === 'object') {
            setVendorProductsMap(payload.vendor_products);
          }
        }

        if (routingRes.status === 'fulfilled') {
          const saved = routingRes.value.data?.vendor_routing;
          if (saved && typeof saved === 'object' && Object.keys(saved).length > 0) {
            savedRoutingRef.current = saved;
          }
        }
      } catch (err) {
        toast.error('Failed to load page data');
      } finally {
        setIsLoadingData(false);
      }
    };
    fetchAll();
  }, [id]);

  // Manual vendors = all vendors minus auto vendors
  const manualVendors = useMemo(() => {
    return vendors.filter(v => !autoVendorIds.has(v.id));
  }, [vendors, autoVendorIds]);

  // Search box for the (often long) manual vendor list — matches name,
  // legal name, code or email.
  const [manualVendorQuery, setManualVendorQuery] = useState('');
  const filteredManualVendors = useMemo(() => {
    const q = manualVendorQuery.trim().toLowerCase();
    if (!q) return manualVendors;
    return manualVendors.filter(v =>
      [v.vendor_name, v.legal_name, v.vendor_code, v.contact_email, v.email]
        .some(f => String(f || '').toLowerCase().includes(q)),
    );
  }, [manualVendors, manualVendorQuery]);

  // WhatsApp message body — mirrors the RFQ email content (RFQ no, date,
  // the product list and the request for a quote) in a WhatsApp-friendly
  // plain-text format, personalised per vendor, so WhatsApp carries the
  // same information as the email rather than a generic blurb.
  const buildWhatsAppText = (vendorName) => {
    const items = [];
    (linkedPRs || []).forEach(pr => (pr.lines || []).forEach(l => {
      items.push(`• ${l.product_name || l.product_code || 'Item'} — `
        + `${Number(l.quantity_requested || 0).toLocaleString()} ${l.uom || ''}`.trim());
    }));
    const itemBlock = items.length ? `\nItems:\n${items.join('\n')}\n` : '';
    return (
      `*RFQ: ${rfq?.rfq_no || ''}*\n`
      + `Date: ${rfq?.creation_date ? formatDate(rfq.creation_date) : '-'}\n\n`
      + `Dear ${vendorName},\n\n`
      + `We would like to request your quotation for the following:\n`
      + `${itemBlock}\n`
      + `Please share your best price, delivery timeline, and payment terms.\n\n`
      + `Regards,\n${rfq?.company_name || 'Lancer ERP'}`
    );
  };

  // Combined vendor list for lookups
  const allVendors = useMemo(() => [...autoVendors, ...vendors], [autoVendors, vendors]);

  // Vendors without email
  const vendorsWithoutEmail = useMemo(() => {
    return selectedVendorIds
      .map(vid => {
        const v = autoVendors.find(av => av.id === vid) || vendors.find(vv => vv.id === vid);
        return v;
      })
      .filter(v => v && !(v.contact_email || v.email));
  }, [selectedVendorIds, autoVendors, vendors]);

  // Sendable vendor count (those with email)
  const sendableCount = useMemo(() => {
    return selectedVendorIds.filter(vid => {
      const v = autoVendors.find(av => av.id === vid) || vendors.find(vv => vv.id === vid);
      return v && (v.contact_email || v.email);
    }).length;
  }, [selectedVendorIds, autoVendors, vendors]);

  // Display label for a vendor — `Name` or `Name (Product A, Product B)`
  // when this RFQ has products mapped to that vendor.
  //
  // Source priority: vendor.products (when the backend attached them
  // to the vendor object — auto-vendor case) → vendorProductsMap lookup
  // by id (covers manually-added vendors whose products didn't get
  // attached inline). Falls back to vendor-name only when neither has
  // data, which is normal for manual vendors with no RFQ-product link.
  const formatVendorLabel = (vendor) => {
    if (!vendor) return '';
    const baseName = vendor.vendor_name || vendor.legal_name || vendor.name || vendor.vendor_code || `Vendor ${vendor.id || ''}`;
    let products = [];
    // Prefer the lines actually routed to this vendor (per-line routing);
    // fall back to the backend-attached / preferred-supplier products.
    const assigned = vendor.id ? assignedNamesByVendor[String(vendor.id)] : null;
    if (Array.isArray(assigned) && assigned.length > 0) {
      products = assigned.filter(Boolean);
    } else if (Array.isArray(vendor.products) && vendor.products.length > 0) {
      products = vendor.products;
    } else if (vendor.id && vendorProductsMap && vendorProductsMap[String(vendor.id)]) {
      products = vendorProductsMap[String(vendor.id)] || [];
    }
    if (products.length === 0) return baseName;
    return `${baseName} (${products.join(', ')})`;
  };

  // Refresh email logs
  const refreshLogs = useCallback(async () => {
    try {
      const res = await apiClient.get(`/api/communications/email-logs/?rfq=${id}`);
      const logData = res.data?.results || res.data || [];
      setEmailLogs(logData);
    } catch {
      // silent
    }
  }, [id]);

  // Toggle vendor selection
  const toggleVendor = (vendorId) => {
    setSelectedVendorIds(prev =>
      prev.includes(vendorId)
        ? prev.filter(v => v !== vendorId)
        : [...prev, vendorId]
    );
  };

  const selectAllVendors = () => {
    const allIds = [...new Set([...autoVendors.map(v => v.id), ...vendors.map(v => v.id)])];
    if (selectedVendorIds.length === allIds.length) {
      setSelectedVendorIds([]);
    } else {
      setSelectedVendorIds(allIds);
    }
  };

  // ---- Per-line-item vendor routing ------------------------------------
  // Unique vendor pool (auto + master list), de-duped by id.
  const allVendorsDedup = useMemo(() => {
    const seen = new Set();
    const out = [];
    [...autoVendors, ...vendors].forEach(v => {
      if (v && !seen.has(v.id)) { seen.add(v.id); out.push(v); }
    });
    return out;
  }, [autoVendors, vendors]);

  const vendorById = useMemo(() => {
    const m = {};
    allVendorsDedup.forEach(v => { m[v.id] = v; });
    return m;
  }, [allVendorsDedup]);

  // Is this vendor a preferred supplier for this line's product?
  const isPreferredFor = useCallback((vendorId, productName) => {
    const names = vendorProductsMap?.[String(vendorId)] || [];
    return names.some(n => String(n).trim().toLowerCase() === String(productName || '').trim().toLowerCase());
  }, [vendorProductsMap]);

  // Seed each line with saved routing (if any) or preferred-supplier vendors.
  useEffect(() => {
    if (lineVendorsInit || rfqProducts.length === 0) return;
    const saved = savedRoutingRef.current;
    if (saved) {
      const init = {};
      rfqProducts.forEach(p => {
        const key = String(p.product);
        init[key] = Array.isArray(saved[key]) ? saved[key].map(Number) : [];
      });
      setLineVendors(init);
    } else {
      const init = {};
      rfqProducts.forEach(p => {
        init[p.product] = allVendorsDedup
          .filter(v => isPreferredFor(v.id, p.product_name))
          .map(v => v.id);
      });
      setLineVendors(init);
    }
    setLineVendorsInit(true);
  }, [rfqProducts, allVendorsDedup, isPreferredFor, lineVendorsInit]);

  // selectedVendorIds = union of every line's chosen vendors (the set that
  // actually receives emails). Derived so the rest of the page is unchanged.
  useEffect(() => {
    const union = Array.from(new Set(Object.values(lineVendors).flat()));
    setSelectedVendorIds(prev => {
      if (prev.length === union.length && prev.every(x => union.includes(x))) return prev;
      return union;
    });
  }, [lineVendors]);

  // Persist line-vendor routing to backend (debounced) so it survives refresh.
  useEffect(() => {
    if (!lineVendorsInit) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      apiClient.put(`/api/purchase/rfq/${id}/vendor-routing/`, { vendor_routing: lineVendors })
        .catch(() => {});
    }, 800);
    return () => clearTimeout(saveTimerRef.current);
  }, [lineVendors, lineVendorsInit, id]);

  const toggleLineVendor = (productKey, vendorId) => {
    setLineVendors(prev => {
      const cur = prev[productKey] || [];
      const next = cur.includes(vendorId) ? cur.filter(x => x !== vendorId) : [...cur, vendorId];
      return { ...prev, [productKey]: next };
    });
  };

  const handleVendorCreated = (newVendor) => {
    setVendors(prev => [newVendor, ...prev]);
    if (createVendorForLine) {
      setLineVendors(prev => {
        const cur = prev[createVendorForLine] || [];
        return { ...prev, [createVendorForLine]: [...cur, newVendor.id] };
      });
      setActiveAddLine(null);
    }
    setCreateVendorForLine(null);
  };

  // {vendor_id: [line_key, ...]} — the explicit routing sent to the backend so
  // each vendor's PDF lists only the lines chosen for them.
  const vendorProducts = useMemo(() => {
    const map = {};
    Object.entries(lineVendors).forEach(([pkey, vids]) => {
      (vids || []).forEach(vid => { (map[vid] = map[vid] || []).push(pkey); });
    });
    return map;
  }, [lineVendors]);

  // {vendor_id: [product_name, ...]} — drives accurate per-vendor labels.
  const assignedNamesByVendor = useMemo(() => {
    const nameByKey = {};
    rfqProducts.forEach(p => { nameByKey[p.product] = p.product_name; });
    const map = {};
    Object.entries(lineVendors).forEach(([pkey, vids]) => {
      (vids || []).forEach(vid => { (map[vid] = map[vid] || []).push(nameByKey[pkey] || ''); });
    });
    return map;
  }, [lineVendors, rfqProducts]);

  // An RFQ is for competitive quoting, so every line must go to at least two
  // vendors. Lines with fewer than 2 block the send.
  const underRoutedLines = useMemo(
    () => rfqProducts.filter(p => (lineVendors[p.product] || []).length < 2),
    [rfqProducts, lineVendors],
  );

  // Candidates for the currently-open "add vendor" dropdown.
  const addCandidates = useMemo(() => {
    if (!activeAddLine) return [];
    const assigned = new Set(lineVendors[activeAddLine] || []);
    const q = addQuery.trim().toLowerCase();
    return allVendorsDedup
      .filter(v => !assigned.has(v.id))
      .filter(v => !q || [v.vendor_name, v.legal_name, v.vendor_code, v.contact_email, v.email]
        .some(f => String(f || '').toLowerCase().includes(q)))
      .slice(0, 8);
  }, [activeAddLine, addQuery, lineVendors, allVendorsDedup]);

  // Preview state — per-vendor previews
  const [previewSubject, setPreviewSubject] = useState('');
  const [showFullPreview, setShowFullPreview] = useState(false);
  const [previewContext, setPreviewContext] = useState({});
  const [vendorPreviews, setVendorPreviews] = useState([]); // [{vendor_id, vendor_name, subject, body, pdf_html}]
  const [activePreviewIdx, setActivePreviewIdx] = useState(0);

  // Editable email fields
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editCc, setEditCc] = useState(DEFAULT_PURCHASE_CC);
  const [editBcc, setEditBcc] = useState('');
  const [editingBody, setEditingBody] = useState(false);
  const [showPdfPreview, setShowPdfPreview] = useState(false);
  const [pdfHtml, setPdfHtml] = useState('');

  // "Send Email" button now opens preview — fetch preview for ALL selected vendors
  const handleSendMailClick = async () => {
    if (!selectedTemplate) { toast.error('Please select a template first'); return; }
    if (selectedVendors.length < 2) { toast.error('Select at least 2 vendors for an RFQ.'); return; }
    if (underRoutedLines.length > 0) {
      const names = underRoutedLines.map(p => p.product_name).slice(0, 3).join(', ');
      toast.error(`Each line needs at least 2 vendors for competitive quoting. Add more for: ${names}${underRoutedLines.length > 3 ? '…' : ''}`);
      return;
    }
    setIsPreviewing(true);
    setShowFullPreview(true);
    setPreviewHtml('');
    setVendorPreviews([]);
    setActivePreviewIdx(0);
    try {
      // Fetch preview for each vendor
      const previews = [];
      for (const vendorId of selectedVendors) {
        try {
          const res = await apiClient.post(`/api/communications/templates/${selectedTemplate}/preview/`, {
            rfq_id: id,
            vendor_id: vendorId,
            // Scope this vendor's preview PDF to exactly the lines routed to them.
            product_ids: vendorProducts[vendorId] || [],
          });
          const vendorObj = allVendors.find(v => v.id === vendorId);
          previews.push({
            vendor_id: vendorId,
            vendor_name: res.data.context_data?.vendor_name || vendorObj?.vendor_name || 'Vendor',
            subject: res.data.subject || '',
            body: res.data.body_html || res.data.html || res.data.rendered || res.data.body || '',
            pdf_html: res.data.pdf_html || '',
            context: res.data.context_data || {},
          });
        } catch { /* skip failed vendor */ }
      }
      setVendorPreviews(previews);
      if (previews.length > 0) {
        const first = previews[0];
        setPreviewSubject(first.subject);
        setPreviewHtml(first.body);
        setPreviewContext(first.context);
        setPdfHtml(first.pdf_html);
        setEditSubject(first.subject);
        setEditBody(first.body);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err));
      setShowFullPreview(false);
    } finally {
      setIsPreviewing(false);
    }
  };

  // Switch active vendor preview
  const switchVendorPreview = (idx) => {
    setActivePreviewIdx(idx);
    const vp = vendorPreviews[idx];
    if (vp) {
      setPreviewSubject(vp.subject);
      setPreviewHtml(vp.body);
      setEditSubject(vp.subject);
      setEditBody(vp.body);
      setPdfHtml(vp.pdf_html);
      setPreviewContext(vp.context);
      setEditingBody(false);
    }
  };

  // Confirm send from preview — stays on preview until complete
  const handleConfirmSend = async () => {
    if (isSending) return; // prevent double-click
    setIsSending(true);
    setSendResults(null);
    try {
      if (!editSubject.trim()) { toast.error('Subject is required'); setIsSending(false); return; }
      // Only send custom_body for single vendor; for multiple vendors, let backend render per-vendor
      const payload = {
        rfq_id: id,
        template_id: selectedTemplate,
        vendor_ids: selectedVendors,
        // Per-line-item routing: each vendor's PDF is scoped to their lines.
        vendor_products: vendorProducts,
      };
      if (selectedVendors.length === 1) {
        payload.custom_subject = editSubject;
        payload.custom_body = editBody;
      }
      // CC / BCC apply to every vendor in this bulk send — typically
      // an internal mailbox (accounts@, a manager) that should receive
      // every RFQ that goes out. Send them regardless of single- vs
      // multi-vendor mode; backend's send_bulk_rfq_emails threads them
      // through to each EmailMessage. Empty strings are no-ops.
      if (editCc && editCc.trim()) payload.custom_cc = editCc.trim();
      if (editBcc && editBcc.trim()) payload.custom_bcc = editBcc.trim();
      // Sending N vendor emails (each a PDF render + SMTP round-trip) routinely
      // takes longer than the client's default 30s timeout, so the browser was
      // aborting mid-send and showing a false "Network error" while the server
      // kept sending. Give this request plenty of room (3 min).
      const res = await apiClient.post('/api/communications/rfq-emails/send-emails/', payload, { timeout: 180000 });
      const results = res.data;
      setSendResults(results);

      // The backend now returns `email_backend.delivers_real_mail`. If that
      // flag is false, the server "succeeded" but only because it was using
      // a fake backend (console / dummy / misconfigured SMTP) — vendors
      // received nothing. Treat this as a hard failure so we never tell the
      // user "sent" when nothing actually went out.
      const backend = results.email_backend || {};
      if (backend && backend.delivers_real_mail === false) {
        const reason = backend.is_console
          ? 'Server is using the console email backend — emails were printed to the server log, NOT sent.'
          : backend.smtp_misconfigured
            ? `SMTP backend is missing config: host=${backend.host || '(empty)'} user=${backend.user || '(empty)'} password=${backend.has_password ? '(set)' : '(empty)'}.`
            : `Email backend "${backend.backend}" cannot deliver real mail.`;
        toast.error(`Mail NOT delivered. ${reason} Ask an admin to set EMAIL_HOST / EMAIL_HOST_USER / EMAIL_HOST_PASSWORD on the production server.`, { duration: 14000 });
        console.error('[RFQ Mail] Server email backend cannot deliver:', backend);
        return;
      }

      if (results.results) {
        const successCount = results.results.filter(r => r.success || r.status === 'sent').length;
        const failCount = results.results.length - successCount;

        if (failCount === 0) {
          toast.success(`All ${successCount} email(s) sent to vendors.`);
        } else {
          toast(`Sent: ${successCount}, Failed: ${failCount}`, { icon: '!' });
          // Per-vendor toast for each failure with the categorised hint
          // from the backend (smtp_auth_failed / recipient_refused / etc).
          results.results.filter(r => !r.success).forEach((r) => {
            const detail = r.error_hint
              ? `${r.error_hint} (raw: ${r.error || 'unknown'})`
              : (r.error || 'Unknown error');
            toast.error(`${r.vendor || r.email}: ${detail}`, { duration: 12000 });
          });
        }
      } else {
        toast.success(results.message || 'Emails sent successfully!');
      }

      refreshLogs();
      // Close preview only after success
      setShowFullPreview(false);
    } catch (err) {
      console.error('[RFQ Mail] send failed:', err?.response?.status, err?.response?.data || err?.message);
      // Keep preview open on failure so user can retry
      toast.error(getApiErrorMessage(err), { duration: 10000 });
    } finally {
      setIsSending(false);
    }
  };

  const canSend = selectedVendorIds.length >= 2 && selectedTemplate
    && rfqProducts.length > 0 && underRoutedLines.length === 0;

  if (isLoadingData) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center py-24">
          <div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin"></div>
        </div>
      </MainLayout>
    );
  }

  // Permission gate: deny access if the user lacks Send Email on RFQ.
  // Wait for usePermissions to settle so the cache miss doesn't surface
  // a spurious "no permission" flash on first paint.
  if (!isLoadingPerms && !canSendEmail('RFQ')) {
    return (
      <MainLayout>
        <div className="text-center py-16">
          <h2 className="text-lg font-semibold text-slate-800 mb-2">No permission</h2>
          <p className="text-sm text-slate-500 mb-4">You do not have permission to send RFQ emails.</p>
          <button onClick={() => navigate(`/purchase/rfq/${id}`)} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700">
            Back to RFQ
          </button>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        title={`Send RFQ Email: ${rfq?.rfq_no || `RFQ #${id}`}`}
        subtitle="Select vendors and a template, then preview and send the RFQ email"
        breadcrumbs={[
          { label: 'RFQ', href: '/purchase/rfq' },
          { label: rfq?.rfq_no || `#${id}`, href: `/purchase/rfq/${id}` },
          { label: 'Send Email' },
        ]}
      />

      {/* Top Section: Vendor Selection & Template */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        {/* Per-line-item vendor routing */}
        <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h3 className="text-sm font-semibold text-slate-800">Route Line Items to Vendors</h3>
            <span className="text-xs font-medium text-slate-500 shrink-0">
              {selectedVendorIds.length} vendor{selectedVendorIds.length !== 1 ? 's' : ''} will receive RFQs
            </span>
          </div>
          <p className="text-xs text-slate-500 mb-3">
            Tick the vendors each line should be quoted by — every vendor gets an RFQ
            containing only their lines. <span className="text-amber-600">★</span> = preferred supplier.
          </p>

          {rfqProducts.length === 0 ? (
            <p className="text-xs text-slate-400 py-2 px-3 bg-slate-50 rounded-lg">
              No line items found on this RFQ.
            </p>
          ) : (
            <div className="space-y-2.5 max-h-[26rem] overflow-y-auto pr-1">
              {rfqProducts.map((p, i) => {
                const assigned = lineVendors[p.product] || [];
                return (
                  <div key={p.product} className="border border-slate-200 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800 truncate">{i + 1}. {p.product_name}</p>
                        <p className="text-xs text-slate-500">
                          {Number(p.quantity_requested || 0).toLocaleString()} {p.uom}
                          {p.sku_code ? ` · ${p.sku_code}` : ''}
                        </p>
                      </div>
                      <span className={`shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded ${assigned.length >= 2 ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                        {assigned.length >= 2
                          ? `${assigned.length} vendors`
                          : assigned.length === 1 ? 'add 1 more vendor' : 'needs 2 vendors'}
                      </span>
                    </div>

                    {/* Assigned vendor chips */}
                    <div className="flex flex-wrap gap-1.5">
                      {assigned.map(vid => {
                        const v = vendorById[vid];
                        if (!v) return null;
                        const noEmail = !(v.contact_email || v.email);
                        const name = v.vendor_name || v.legal_name || v.name || v.vendor_code || 'Vendor';
                        return (
                          <span key={vid} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs bg-primary-600 text-white">
                            <span className="truncate max-w-[10rem]">{name}{isPreferredFor(vid, p.product_name) ? ' ★' : ''}</span>
                            {noEmail && <span title="No email on file" className="text-amber-200">⚠</span>}
                            <button type="button" onClick={() => toggleLineVendor(p.product, vid)} className="hover:bg-white/20 rounded-full w-4 h-4 flex items-center justify-center leading-none" title="Remove">×</button>
                          </span>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => { setActiveAddLine(activeAddLine === p.product ? null : p.product); setAddQuery(''); }}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border border-dashed border-slate-300 text-slate-600 hover:bg-slate-50"
                      >
                        + Add vendor
                      </button>
                    </div>

                    {/* Add-vendor searchable dropdown */}
                    {activeAddLine === p.product && (
                      <div className="mt-2 border border-slate-200 rounded-lg p-2 bg-slate-50">
                        <div className="relative mb-1">
                          <input
                            autoFocus
                            type="text"
                            value={addQuery}
                            onChange={(e) => setAddQuery(e.target.value)}
                            placeholder="Search vendors by name, code or email…"
                            className="w-full pl-2 pr-8 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                          />
                          <button
                            type="button"
                            onClick={() => { setActiveAddLine(null); setAddQuery(''); }}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-200"
                            title="Close"
                            aria-label="Close vendor search"
                          >
                            ×
                          </button>
                        </div>
                        <div className="max-h-40 overflow-y-auto space-y-0.5">
                          {addCandidates.length === 0 ? (
                            <p className="text-xs text-slate-400 px-2 py-1.5">No matching vendors.</p>
                          ) : addCandidates.map(v => {
                            const noEmail = !(v.contact_email || v.email);
                            const name = v.vendor_name || v.legal_name || v.name || v.vendor_code || 'Vendor';
                            return (
                              <button
                                key={v.id}
                                type="button"
                                onClick={() => { toggleLineVendor(p.product, v.id); setAddQuery(''); }}
                                className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-white text-sm flex items-center justify-between gap-2"
                              >
                                <span className="truncate">{name}{isPreferredFor(v.id, p.product_name) ? ' ★' : ''}</span>
                                {noEmail
                                  ? <span className="text-[11px] text-amber-600 shrink-0">no email</span>
                                  : <span className="text-[11px] text-slate-400 shrink-0 truncate max-w-[8rem]">{v.contact_email || v.email}</span>}
                              </button>
                            );
                          })}
                        </div>
                        <div className="mt-1.5 pt-1.5 border-t border-slate-200">
                          <button
                            type="button"
                            onClick={() => { setCreateVendorForLine(p.product); setShowCreateVendor(true); setActiveAddLine(null); setAddQuery(''); }}
                            className="w-full text-left px-2 py-2 rounded-lg hover:bg-primary-50 text-sm font-medium text-primary-700 flex items-center gap-1.5"
                          >
                            <span className="w-5 h-5 flex items-center justify-center rounded-full bg-primary-100 text-primary-700 text-xs font-bold">+</span>
                            Create New Vendor
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Summary footer */}
          <div className="mt-4 pt-3 border-t space-y-1">
            <p className="text-xs text-slate-600 font-medium">
              {selectedVendorIds.length} vendor(s) selected across {rfqProducts.length} line item(s)
            </p>
            {underRoutedLines.length > 0 && (
              <p className="text-xs text-rose-600">
                {underRoutedLines.length} line item(s) need at least 2 vendors before you can send.
              </p>
            )}
            {vendorsWithoutEmail.length > 0 && (
              <div className="text-xs text-amber-600">
                {vendorsWithoutEmail.map(v => (
                  <p key={v.id}>
                    {formatVendorLabel(v)} has no email — will be skipped
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Template Selection & Actions */}
        <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <h3 className="text-sm font-semibold text-slate-800 mb-3">Select Template</h3>
          <div className="space-y-4">
            <div>
              <CustomSelect
                value={selectedTemplate}
                onChange={(e) => setSelectedTemplate(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="">Select a template...</option>
                {templates.map(tpl => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}{tpl.is_default ? ' (Default)' : ''}
                  </option>
                ))}
              </CustomSelect>
              {templates.length === 0 && (
                <p className="text-xs text-amber-600 mt-1">
                  No templates found. <button onClick={() => navigate('/admin/email-templates/new')} className="underline">Create one</button>
                </p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleSendMailClick}
                disabled={!canSend || isPreviewing || (sendResults?.results?.some(r => r.success || r.status === 'sent'))}
                className={`flex-1 px-4 py-2 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition ${
                  sendResults?.results?.some(r => r.success || r.status === 'sent') ? 'bg-green-600' : 'bg-primary-600 hover:bg-primary-700'
                }`}
              >
                {isPreviewing ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                    Preparing Preview...
                  </span>
                ) : sendResults?.results?.some(r => r.success || r.status === 'sent') ? (
                  '✓ Email Sent'
                ) : `Send Email to ${sendableCount} Vendor${sendableCount !== 1 ? 's' : ''}`}
              </button>
            </div>

            {!canSend && !isSending && (
              <p className="text-xs text-slate-500">
                {!selectedTemplate && !selectedVendorIds.length
                  ? 'Select at least one vendor and a template to send emails.'
                  : !selectedTemplate
                  ? 'Please select a template.'
                  : 'Please select at least one vendor.'}
              </p>
            )}
          </div>

          {/* RFQ Summary */}
          {rfq && (
            <div className="mt-3 pt-3 border-t">
              <h4 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1.5">RFQ Details</h4>
              <div className="space-y-0.5 text-sm">
                <p><span className="text-slate-500">Number:</span> <span className="font-medium">{rfq.rfq_no}</span></p>
                <p><span className="text-slate-500">Status:</span> <StatusBadge status={rfq.rfq_status || rfq.status} /></p>
                <p><span className="text-slate-500">Mode:</span> <span className="font-medium">{rfq.rfq_mode || '-'}</span></p>
                <p><span className="text-slate-500">Date:</span> <span className="font-medium">{rfq.creation_date ? formatDate(rfq.creation_date) : '-'}</span></p>
              </div>
            </div>
          )}

          {/* Linked Purchase Requests & Line Items */}
          {linkedPRs.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <h4 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Linked Purchase Requests</h4>
              {linkedPRs.map(pr => (
                <div key={pr.id} className="mb-3 bg-slate-50 rounded-lg p-2.5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-primary-700">{pr.pr_no}</span>
                    <StatusBadge status={pr.approval_status} />
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-xs text-slate-600 mb-2">
                    <p>Warehouse: <span className="font-medium text-slate-800">{pr.warehouse_name || '-'}</span></p>
                    <p>Priority: <span className="font-medium text-slate-800">{pr.priority || '-'}</span></p>
                    <p>Type: <span className="font-medium text-slate-800">{pr.requirement_type_display || pr.requirement_type || '-'}</span></p>
                    <p>Date: <span className="font-medium text-slate-800">{pr.request_date ? formatDate(pr.request_date) : '-'}</span></p>
                  </div>
                  {pr.justification && <p className="text-xs text-slate-500 mb-2">Justification: {pr.justification}</p>}

                  {/* Line Items Table */}
                  {pr.lines && pr.lines.length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs font-semibold text-slate-600 mb-1">Line Items ({pr.lines.length})</p>
                      <table className="w-full text-xs border border-slate-200 rounded">
                        <thead>
                          <tr className="bg-slate-100">
                            <th className="text-left px-2 py-1 font-medium">#</th>
                            <th className="text-left px-2 py-1 font-medium">Product</th>
                            <th className="text-left px-2 py-1 font-medium">SKU</th>
                            <th className="text-right px-2 py-1 font-medium">Qty</th>
                            <th className="text-left px-2 py-1 font-medium">UOM</th>
                            <th className="text-left px-2 py-1 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pr.lines.map((line, idx) => (
                            <tr key={line.id || idx} className="border-t border-slate-100">
                              <td className="px-2 py-1 text-slate-500">{line.line_no || idx + 1}</td>
                              <td className="px-2 py-1 font-medium text-slate-800">{line.product_name || '-'}</td>
                              <td className="px-2 py-1 text-slate-500">{line.product_code || '-'}</td>
                              <td className="px-2 py-1 text-right font-medium">{Number(line.quantity_requested || 0).toLocaleString()}</td>
                              <td className="px-2 py-1 text-slate-500">{line.uom || '-'}</td>
                              <td className="px-2 py-1"><StatusBadge status={line.status} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Confirmation Dialog */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-4 sm:p-6" role="dialog" aria-modal="true" aria-label="Confirm Send">
            <h3 className="text-lg font-semibold text-slate-800 mb-2">Confirm Send</h3>
            <p className="text-sm text-slate-600 mb-4">
              You are about to send the RFQ email to <span className="font-semibold">{selectedVendors.length} vendor(s)</span> using the selected template. This action cannot be undone.
            </p>
            <div className="mb-4 bg-slate-50 rounded-lg p-3">
              <p className="text-xs font-medium text-slate-600 mb-1">Recipients:</p>
              <ul className="space-y-0.5">
                {selectedVendors.map(vid => {
                  const v = autoVendors.find(av => av.id === vid) || vendors.find(vv => vv.id === vid);
                  const vName = v ? formatVendorLabel(v) : `ID: ${vid}`;
                  return <li key={vid} className="text-xs text-slate-700">- {vName}</li>;
                })}
              </ul>
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmSend}
                className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700"
              >
                Yes, Send Emails
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Send Results */}
      {sendResults?.results && (
        <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4 mb-3">
          <h3 className="text-sm font-semibold text-slate-800 mb-2">Send Results</h3>
          <div className="space-y-2">
            {sendResults.results.map((result, idx) => {
              // Look up in both vendor pools — auto-vendors carry the
              // inline `products` field, master vendors don't but the
              // formatter falls back to vendorProductsMap.
              const vendor = autoVendors.find(v => String(v.id) === String(result.vendor_id || result.vendor))
                || vendors.find(v => String(v.id) === String(result.vendor_id || result.vendor));
              const vendorName = vendor ? formatVendorLabel(vendor) : `Vendor ${result.vendor_id || result.vendor || idx + 1}`;
              const success = result.success || result.status === 'sent';
              return (
                <div key={idx} className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${success ? 'bg-green-50' : 'bg-red-50'}`}>
                  <span className="font-medium text-slate-800">{vendorName}</span>
                  <span className={`text-xs font-medium ${success ? 'text-green-700' : 'text-red-700'}`}>
                    {success ? 'Email Sent' : result.error || result.message || 'Failed'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Full-Screen Email Preview Modal */}
      {showFullPreview && (
        <>
          <div className="fixed inset-0 bg-black/50 z-50" onClick={() => !isSending && setShowFullPreview(false)} />
          <div className="fixed inset-4 md:inset-6 lg:inset-10 bg-white rounded-2xl shadow-2xl z-50 flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="Email Preview">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-violet-50 to-white flex-shrink-0">
              <div>
                <h2 className="text-lg font-bold text-slate-800">Email Preview</h2>
                {previewSubject && <p className="text-sm text-slate-500 mt-0.5">Subject: {previewSubject}</p>}
                <p className="text-xs text-slate-400 mt-0.5">{rfq?.rfq_no || ''} — Sending to {selectedVendors.length} vendor(s)</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleConfirmSend}
                  disabled={isSending || isPreviewing || !previewHtml}
                  className="flex items-center gap-2 px-5 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 disabled:opacity-50 transition"
                >
                  {isSending ? (
                    <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Sending...</>
                  ) : (
                    <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg> Confirm & Send</>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setShowFullPreview(false)}
                  disabled={isSending}
                  className="px-4 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition"
                >
                  Cancel
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {isPreviewing ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <div className="w-10 h-10 border-4 border-violet-500 border-t-transparent rounded-full animate-spin mb-3" />
                  <p className="text-slate-500 text-sm">Generating email preview for {selectedVendors.length} vendor(s)...</p>
                </div>
              ) : previewHtml ? (
                <div className="p-4 sm:p-6 space-y-4">
                  {/* Vendor Tabs — show when multiple vendors */}
                  {vendorPreviews.length > 1 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-slate-500 uppercase mr-1">Preview for:</span>
                      {vendorPreviews.map((vp, idx) => {
                        // vp.vendor_id is what the preview tab keys
                        // on. Look the vendor up in the same pools as
                        // the rest of the page so we can reuse the
                        // formatter (gets products from the auto-vendor
                        // payload OR vendorProductsMap).
                        const vendorObj = autoVendors.find(v => String(v.id) === String(vp.vendor_id))
                          || vendors.find(v => String(v.id) === String(vp.vendor_id));
                        const tabLabel = vendorObj ? formatVendorLabel(vendorObj) : vp.vendor_name;
                        return (
                          <button
                            key={vp.vendor_id}
                            type="button"
                            onClick={() => switchVendorPreview(idx)}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                              idx === activePreviewIdx
                                ? 'bg-violet-600 text-white shadow-sm'
                                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                            }`}
                          >
                            {tabLabel}
                          </button>
                        );
                      })}
                      <span className="text-xs text-slate-400 ml-2">({activePreviewIdx + 1} of {vendorPreviews.length})</span>
                    </div>
                  )}

                  {/* Editable Email Metadata */}
                  <div className="bg-slate-50 rounded-xl border border-slate-200 p-5 space-y-3">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 uppercase w-16 flex-shrink-0">To <span className="text-red-500">*</span></span>
                      <p className="text-sm text-slate-800 bg-white px-3 py-1.5 rounded-lg border border-slate-200 flex-1">
                        {vendorPreviews.length > 1
                          ? (() => {
                              const activeVid = vendorPreviews[activePreviewIdx]?.vendor_id;
                              const v = autoVendors.find(x => String(x.id) === String(activeVid))
                                || vendors.find(x => String(x.id) === String(activeVid));
                              const label = v ? formatVendorLabel(v) : vendorPreviews[activePreviewIdx]?.vendor_name;
                              return <><strong>{label}</strong> <span className="text-slate-400">— {selectedVendors.length} vendor(s), each gets vendor-specific email</span></>;
                            })()
                          : <>{selectedVendors.length} vendor(s) selected — emails sent per vendor</>
                        }
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 uppercase w-16 flex-shrink-0">CC</span>
                      <EmailAutocomplete value={editCc} onChange={setEditCc} placeholder="CC emails (comma separated)" className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 uppercase w-16 flex-shrink-0">BCC</span>
                      <EmailAutocomplete value={editBcc} onChange={setEditBcc} placeholder="BCC emails (comma separated)" className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
                    </div>
                    <div className="border-t border-slate-200" />
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 uppercase w-16 flex-shrink-0">Subject <span className="text-red-500">*</span></span>
                      <input type="text" value={editSubject} onChange={e => setEditSubject(e.target.value)} placeholder="Email subject" className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
                    </div>
                    <div className="border-t border-slate-200" />
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 uppercase w-16 flex-shrink-0">From</span>
                      <p className="text-sm text-slate-600">{fromEmail || rfq?.company_name || 'System'}</p>
                    </div>
                    <div className="border-t border-slate-200" />
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 uppercase w-16 flex-shrink-0">Attach</span>
                      <button
                        type="button"
                        onClick={() => setShowPdfPreview(true)}
                        className="flex items-center gap-2 text-primary-600 hover:text-primary-800 hover:underline text-sm font-medium"
                      >
                        {rfq?.rfq_no || 'RFQ'}.pdf
                        <span className="text-xs text-slate-400 font-normal">(Click to preview)</span>
                      </button>
                    </div>
                  </div>

                  {/* Document Details */}
                  <div className="bg-blue-50 rounded-xl border border-blue-200 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-semibold text-blue-800 uppercase">Document Details</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      <div><span className="text-blue-600">RFQ:</span> <span className="font-medium text-blue-900">{rfq?.rfq_no || '-'}</span></div>
                      <div><span className="text-blue-600">Mode:</span> <span className="font-medium text-blue-900">{rfq?.rfq_mode || '-'}</span></div>
                      <div><span className="text-blue-600">Date:</span> <span className="font-medium text-blue-900">{rfq?.creation_date ? formatDate(rfq.creation_date) : '-'}</span></div>
                      <div><span className="text-blue-600">Vendors:</span> <span className="font-medium text-blue-900">{selectedVendors.length}</span></div>
                    </div>
                  </div>
                  {/* Email Body — rendered preview with edit toggle */}
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
                    <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 rounded-t-xl flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-500 uppercase">Email Body</span>
                      <button
                        type="button"
                        onClick={() => setEditingBody(!editingBody)}
                        className="text-xs font-medium text-primary-600 hover:text-primary-800 hover:underline"
                      >
                        {editingBody ? 'Preview' : 'Edit HTML'}
                      </button>
                    </div>
                    <div className="p-4 sm:p-6">
                      {editingBody ? (
                        <textarea
                          value={editBody}
                          onChange={e => setEditBody(e.target.value)}
                          rows={20}
                          className="w-full px-4 py-3 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-primary-500 resize-y"
                          placeholder="Email body (HTML)"
                        />
                      ) : (
                        <div
                          className="prose prose-sm max-w-none"
                          dangerouslySetInnerHTML={{ __html: editBody }}
                        />
                      )}
                    </div>
                  </div>

                  {/* PDF Attachment Preview (inline) */}
                  {pdfHtml && (
                    <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
                      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 rounded-t-xl flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-500 uppercase">PDF Attachment — {rfq?.rfq_no || 'RFQ'}.pdf</span>
                      </div>
                      <div className="p-4 bg-slate-100">
                        <div className="max-w-[700px] mx-auto bg-white shadow rounded-lg overflow-hidden">
                          <iframe
                            srcDoc={pdfHtml}
                            title="PDF Preview"
                            className="w-full border-0"
                            style={{ minHeight: '600px' }}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                  <p>Failed to load preview</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* PDF Attachment Preview Modal */}
      {showPdfPreview && pdfHtml && (
        <>
          <div className="fixed inset-0 bg-black/50 z-[60]" onClick={() => setShowPdfPreview(false)} />
          <div className="fixed inset-4 md:inset-8 lg:inset-12 bg-white rounded-2xl shadow-2xl z-[60] flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="PDF Attachment Preview">
            <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-slate-200 bg-slate-50 flex-shrink-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-800">{rfq?.rfq_no || 'RFQ'}.pdf — Attachment Preview</span>
              </div>
              <button onClick={() => setShowPdfPreview(false)} className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-100">
                Close
              </button>
            </div>
            <div className="flex-1 overflow-auto bg-slate-100 p-4">
              <div className="max-w-[800px] mx-auto bg-white shadow-lg rounded-lg overflow-hidden">
                <iframe
                  srcDoc={pdfHtml}
                  title="PDF Preview"
                  className="w-full border-0"
                  style={{ minHeight: '80vh' }}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {/* Email History */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-800">Email History</h3>
          <button
            type="button"
            onClick={refreshLogs}
            className="text-xs text-primary-600 hover:text-primary-700 font-medium"
          >
            Refresh
          </button>
        </div>
        {emailLogs.length === 0 ? (
          <p className="text-sm text-slate-500 py-4 text-center">No emails sent for this RFQ yet</p>
        ) : (

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Vendor</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Status</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Sent At</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {emailLogs.map((log, idx) => {
                  // Look up across both pools so the formatter sees the
                  // auto-vendor's inline `products` field when available.
                  const vendor = autoVendors.find(v => String(v.id) === String(log.vendor_id || log.vendor))
                    || vendors.find(v => String(v.id) === String(log.vendor_id || log.vendor));
                  const vendorName = vendor
                    ? formatVendorLabel(vendor)
                    : (log.vendor_name || log.recipient || `Vendor ${log.vendor_id || log.vendor || '-'}`);
                  const logStatus = log.status || (log.email_sent ? 'Email Sent' : (log.success ? 'Email Sent' : 'Failed'));
                  return (
                    <tr key={log.id || idx} className="hover:bg-primary-50/40 transition-colors">
                      <td className="py-2 px-3 font-medium text-slate-800">{vendorName}</td>
                      <td className="py-2 px-3">
                        <StatusBadge status={logStatus} />
                      </td>
                      <td className="py-2 px-3 text-slate-600">
                        {log.sent_at || log.created_at
                          ? formatDateTime(log.sent_at || log.created_at)
                          : '-'}
                      </td>
                      <td className="py-2 px-3 text-slate-500 text-xs">
                        {log.error || log.error_message || '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <QuickCreateVendorModal
        open={showCreateVendor}
        onClose={() => { setShowCreateVendor(false); setCreateVendorForLine(null); }}
        onCreated={handleVendorCreated}
        companyId={rfq?.company}
      />
    </MainLayout>
  );
}

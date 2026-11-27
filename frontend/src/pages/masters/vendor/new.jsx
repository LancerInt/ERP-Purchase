import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { panFromGstin, isValidGstin, isValidPan } from '../../../utils/gst.js';
import { VENDOR_GST_TREATMENT_OPTIONS, isRegisteredTreatment } from '../../../constants/gstTreatment.js';
import { withCurrent, msmeAllowedTerms } from '../../../constants/purchaseTerms.js';
import { VENDOR_TYPE_OPTIONS } from '../../../constants/vendorTypes.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { pickPartyLink } from '@/components/common/partyLinkPicker';
import GstDetailsPanel from '../../../components/masters/GstDetailsPanel.jsx';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup, { clearLookupCache } from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { INDIAN_STATES, COUNTRIES } from '../../../utils/locationData.js';

export default function CreateVendor() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Vendor');
  const { options: companies } = useLookup('/api/companies/');
  const [isLoading, setIsLoading] = useState(false);
  // Live preview of the code that will be assigned — depends on the chosen
  // company (sequence is per-company). Indicative; the real code is set on save.
  const [nextCode, setNextCode] = useState('');
  // `?name=` lets another screen (the bank-statement import modal, which
  // recognises a payee name in a narration with no matching Vendor at all)
  // land here with the name already typed in, instead of the operator
  // re-typing something already extracted for them.
  const [searchParams] = useSearchParams();
  const [formData, setFormData] = useState({
    vendor_code: '',
    vendor_name: searchParams.get('name') || '',
    vendor_type: '',
    company: '',
    gstin: '',
    pan: '',
    gst_treatment: '',
    address: '',
    city: '',
    state: '',
    country: '',
    pincode: '',
    contact_person: '',
    contact_email: '',
    contact_phone: '',
    payment_terms: '',
    custom_payment_days: '',
    // GST type drives which rate fields render and are saved.
    //   '' (blank) → no GST fields shown
    //   'CGST_SGST' → show single `gst` % field, auto-split into
    //                 sgst_rate + cgst_rate (half each) on every keystroke.
    //   'IGST'     → show single `igst_rate` field only.
    gst_type: '',
    gst: '',
    sgst_rate: '',
    cgst_rate: '',
    igst_rate: '',
    credit_limit: '',
    credit_days: '',
    tds_rate: '',
    tcs_rate: '',
    deductee_category: '',
    // ── Government verification / compliance ──
    is_msme: false,
    msme_category: '',
    msme_udyam_no: '',
    has_written_agreement: false,
    is_rcm: false,
    // This supplier is also a customer — on save the server creates-or-links a
    // Customer master and wires both directions (see party_linking). Gated by a
    // picker that previews an exact match / loose suggestions / create-new.
    is_also_customer: false,
    is_group: false,
    // When the user picks a specific counterpart in the picker, its id goes
    // here and the server links to THAT record instead of auto-matching.
    link_to_customer_id: null,
    active_flag: true,
    freight_split_notes: '',
    notes: '',
  });
  // Uploaded documents are File objects, kept out of formData so the JSON/
  // multipart split in handleSubmit stays clean.
  const [files, setFiles] = useState({
    msme_certificate: null,
    written_agreement_doc: null,
    gstin_certificate: null,
  });
  // Suggested TDS (vendor type + PAN → section/rate). The operator can still
  // override the rate; once they do we stop auto-overwriting it.
  const [tdsHint, setTdsHint] = useState(null);
  const [tdsManual, setTdsManual] = useState(false);
  // Live duplicate suggestions for the typed name within the chosen company.
  const [dupMatches, setDupMatches] = useState([]);
  // Live GSTIN clashes. Same-company hits block the save (one active vendor per
  // GSTIN per company); cross-company hits are informational only.
  const [gstinDup, setGstinDup] = useState([]);
  // Inline format errors for GSTIN / PAN, set on blur (and from server 400s).
  const [fieldErr, setFieldErr] = useState({ gstin: '', pan: '' });
  // GSTIN portal verification (A5) — button hidden until the server says a
  // provider is configured.
  const [gstVerifyEnabled, setGstVerifyEnabled] = useState(false);
  const [gstVerifying, setGstVerifying] = useState(false);
  const [gstStatus, setGstStatus] = useState('');
  // Full portal record from the last successful Verify, shown in a details panel.
  const [gstDetails, setGstDetails] = useState(null);

  useEffect(() => {
    apiClient.get('/api/vendors/gst-verify-status/')
      .then((res) => setGstVerifyEnabled(!!res.data?.enabled))
      .catch(() => setGstVerifyEnabled(false));
  }, []);

  const verifyGstin = async () => {
    const gstin = (formData.gstin || '').trim();
    if (!gstin) { toast.error('Enter a GSTIN first'); return; }
    setGstVerifying(true);
    try {
      const { data } = await apiClient.post('/api/vendors/verify-gstin/', { gstin });
      setGstStatus(data.status || '');
      setGstDetails(data);
      // Prefill only blank fields — never clobber what the operator typed.
      setFormData(prev => ({
        ...prev,
        vendor_name: prev.vendor_name || data.legal_name || '',
        pan: prev.pan || data.pan || panFromGstin(gstin) || '',
        gst_treatment: prev.gst_treatment || data.gst_treatment || '',
        deductee_category: prev.deductee_category || data.deductee_category || '',
        address: prev.address || data.address?.line1 || '',
        city: prev.city || data.address?.city || '',
        state: prev.state || data.address?.state || '',
        pincode: prev.pincode || data.address?.pincode || '',
      }));
      if (data.warning) toast(data.warning, { icon: '⚠️', duration: 6000 });
      else toast.success(`GSTIN verified — ${data.status || 'OK'}`);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setGstVerifying(false);
    }
  };

  useEffect(() => {
    if (!formData.company) { setNextCode(''); return undefined; }
    let cancelled = false;
    apiClient.get(`/api/vendors/next-code/?company=${formData.company}`)
      .then((res) => { if (!cancelled) setNextCode(res.data?.code || ''); })
      .catch(() => { if (!cancelled) setNextCode(''); });
    return () => { cancelled = true; };
  }, [formData.company]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    // Once the operator edits the TDS rate by hand, stop auto-overwriting it
    // with the PAN/type suggestion.
    if (name === 'tds_rate') setTdsManual(true);
    // GSTIN and PAN are always stored upper-case — normalise as the operator
    // types so a lower-case entry never looks like a mismatch or a non-dup.
    const fieldVal = type === 'checkbox' ? checked
      : (name === 'gstin' || name === 'pan') ? value.toUpperCase() : value;
    // Clear a standing format error for this field as soon as it's edited.
    if (name === 'gstin' || name === 'pan') {
      setFieldErr(prev => (prev[name] ? { ...prev, [name]: '' } : prev));
    }
    // Clear the server/client error for this field as the user edits it
    if (serverErrors[name]) setServerErrors(prev => { const n = { ...prev }; delete n[name]; return n; });
    setFormData(prev => {
      const next = { ...prev, [name]: fieldVal };
      // Turning MSME off clears its dependent fields so no stale category /
      // agreement survives on the saved record.
      if (name === 'is_msme' && !checked) {
        next.msme_category = '';
        next.msme_udyam_no = '';
        next.has_written_agreement = false;
      }
      // Auto-fill PAN from the GSTIN (PAN is chars 3–12) while PAN is blank.
      if (name === 'gstin' && !(prev.pan || '').trim()) {
        const derivedPan = panFromGstin(value);
        if (derivedPan) next.pan = derivedPan;
      }
      // GST auto-split: when the combined GST % changes under
      // CGST+SGST mode, mirror exactly half into each component
      // field so the user only types one number. Saves a few keystrokes
      // per vendor and prevents typo-driven mismatches between the
      // two halves.
      if (name === 'gst' && prev.gst_type === 'CGST_SGST') {
        const n = parseFloat(value);
        if (!isNaN(n)) {
          const half = (n / 2).toFixed(2);
          next.sgst_rate = half;
          next.cgst_rate = half;
        } else {
          next.sgst_rate = '';
          next.cgst_rate = '';
        }
      }
      // Switching GST type wipes the inactive-side values so the
      // saved record doesn't carry stale numbers from the other mode.
      if (name === 'gst_type') {
        if (value === 'CGST_SGST') {
          next.igst_rate = '';
        } else if (value === 'IGST') {
          next.gst = '';
          next.sgst_rate = '';
          next.cgst_rate = '';
        } else {
          next.gst = ''; next.sgst_rate = ''; next.cgst_rate = ''; next.igst_rate = '';
        }
      }
      return next;
    });
  };

  // "Also a customer" checkbox. Only unchecked→checked opens the picker: it
  // previews an exact deterministic match, else loose suggestions, else a
  // plain create. Picking a row links to THAT customer (link_to_customer_id);
  // "Create new" leaves the id null and the server auto-matches-or-creates.
  // Cancel reverts to unchecked. Unchecking is silent.
  const handleAlsoCustomerToggle = async (e) => {
    const checked = e.target.checked;
    if (!checked) {
      setFormData(prev => ({ ...prev, is_also_customer: false, link_to_customer_id: null }));
      return;
    }
    const gstin = (formData.gstin || '').trim();
    const pan = (formData.pan || '').trim();
    const name = (formData.vendor_name || '').trim();
    let preview = null;
    try {
      const { data } = await apiClient.get('/api/master/party-match/', {
        params: { role: 'customer', company: formData.company, gstin, pan, name },
      });
      preview = data;
    } catch {
      preview = null; // preview failed — picker offers plain create/cancel
    }
    const res = await pickPartyLink({ counterpart: 'customer', preview, name, gstin, pan });
    if (res.action === 'cancel') return; // keep it unchecked
    setFormData(prev => ({
      ...prev,
      is_also_customer: true,
      link_to_customer_id: res.action === 'link' ? res.id : null,
    }));
  };

  const handleFileChange = (e) => {
    const { name, files: fl } = e.target;
    setFiles(prev => ({ ...prev, [name]: fl && fl[0] ? fl[0] : null }));
  };

  // Validate GSTIN / PAN shape on blur (not on every keystroke) so the error
  // appears once the operator has finished the field, per inline-validation UX.
  const handleBlur = (e) => {
    const { name } = e.target;
    const v = (e.target.value || '').trim();
    if (name === 'gstin') {
      setFieldErr(prev => ({ ...prev, gstin: v && !isValidGstin(v) ? 'Invalid GSTIN — 15 chars, e.g. 27AABCA1234B1Z5.' : '' }));
    } else if (name === 'pan') {
      setFieldErr(prev => ({ ...prev, pan: v && !isValidPan(v) ? 'Invalid PAN — e.g. ABCDE1234F.' : '' }));
    }
  };

  // Whether the 45-day MSME term is unlocked: an agreement is claimed AND its
  // document is attached. Drives both the payment-term options and the clamp.
  const msmeHasAgreementDoc = formData.has_written_agreement && !!files.written_agreement_doc;
  const allowedPaymentTerms = msmeAllowedTerms(
    formData.is_msme ? formData.msme_category : '', msmeHasAgreementDoc);

  // Auto-suggest the TDS rate from vendor type + PAN. Debounced; skipped once
  // the operator has typed their own rate.
  useEffect(() => {
    if (tdsManual) return undefined;
    const vt = formData.vendor_type;
    const pan = (formData.pan || '').trim();
    if (!vt) { setTdsHint(null); return undefined; }
    let cancelled = false;
    const id = setTimeout(() => {
      apiClient.get('/api/vendors/suggest-tds/', { params: { vendor_type: vt, pan } })
        .then((res) => {
          if (cancelled) return;
          setTdsHint(res.data || null);
          if (res.data && res.data.rate != null) {
            setFormData(prev => (tdsManual ? prev : { ...prev, tds_rate: res.data.rate }));
          }
        })
        .catch(() => { if (!cancelled) setTdsHint(null); });
    }, 300);
    return () => { cancelled = true; clearTimeout(id); };
  }, [formData.vendor_type, formData.pan, tdsManual]);

  // Live duplicate suggester — warns before submit when the typed name
  // normalises to an existing vendor in the chosen company, or when the GSTIN
  // is already on another active vendor. The GSTIN check fires as soon as a
  // full 15-char number is present (company optional), so a clash surfaces
  // inline instead of only on submit.
  useEffect(() => {
    const name = (formData.vendor_name || '').trim();
    const gstin = (formData.gstin || '').replace(/\s/g, '').toUpperCase();
    const hasName = name && formData.company;
    const hasGstin = gstin.length === 15;
    if (!hasName && !hasGstin) { setDupMatches([]); setGstinDup([]); return undefined; }
    let cancelled = false;
    const id = setTimeout(() => {
      apiClient.get('/api/vendors/check-duplicate/', {
        params: { name, gstin, company: formData.company },
      })
        .then((res) => {
          if (cancelled) return;
          setDupMatches(res.data?.matches || []);
          setGstinDup(res.data?.gstin_matches || []);
        })
        .catch(() => { if (!cancelled) { setDupMatches([]); setGstinDup([]); } });
    }, 400);
    return () => { cancelled = true; clearTimeout(id); };
  }, [formData.vendor_name, formData.gstin, formData.company]);

  // Same-company GSTIN hits block the save; cross-company hits are informational.
  const gstinClash = gstinDup.filter(m => m.same_company);
  const gstinOtherCompany = gstinDup.filter(m => !m.same_company);
  // The PAN is embedded in the GSTIN (chars 3–12); warn when a separately typed
  // PAN disagrees with it. Only fires once both are present and well-formed.
  const gstinPan = panFromGstin(formData.gstin);
  const panTyped = (formData.pan || '').trim().toUpperCase();
  const panMismatch = !!gstinPan && !!panTyped && gstinPan !== panTyped;

  // Keep the chosen payment term legal: if the MSME cap tightened below the
  // current selection, drop it so the operator must re-pick a compliant term.
  useEffect(() => {
    if (!formData.is_msme) return;
    if (formData.payment_terms && !allowedPaymentTerms.includes(formData.payment_terms)) {
      setFormData(prev => ({ ...prev, payment_terms: '' }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.is_msme, formData.msme_category, msmeHasAgreementDoc]);

  const [serverErrors, setServerErrors] = useState({});

  const handleSubmit = async (e) => {
    e.preventDefault();
    setServerErrors({});
    // Client-side checks before hitting the API
    const clientErrs = {};
    if (!formData.company) clientErrs.company = 'Company is required.';
    if (!formData.vendor_name?.trim()) clientErrs.vendor_name = 'Vendor name is required.';
    if (!formData.vendor_type) clientErrs.vendor_type = 'Vendor type is required.';
    if (!formData.gst_treatment) clientErrs.gst_treatment = 'GST Treatment is required. Select "Unregistered Business" if vendor has no GSTIN.';
    if (isRegisteredTreatment(formData.gst_treatment) && !formData.gstin?.trim()) {
      clientErrs.gstin = 'GSTIN is required for a registered vendor. Select "Unregistered Business" under GST Treatment if the vendor has no GSTIN.';
    }
    if (formData.gstin?.trim() && !isValidGstin(formData.gstin.trim())) {
      clientErrs.gstin = clientErrs.gstin || 'Invalid GSTIN format (e.g. 22AAAAA0000A1Z5).';
    }
    if (!formData.pan?.trim()) clientErrs.pan = 'PAN is required.';
    if (!formData.contact_email?.trim()) clientErrs.contact_email = 'Contact email is required.';
    if (Object.keys(clientErrs).length > 0) {
      setServerErrors(clientErrs);
      toast.error('Please fill all required fields.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (gstinClash.length > 0) {
      toast.error(`This GSTIN already belongs to vendor ${gstinClash[0].vendor_name} (${gstinClash[0].vendor_code}) in this company.`);
      return;
    }
    if (dupMatches.length > 0) {
      toast.error(`A vendor named "${dupMatches[0].vendor_name}" already exists in this company.`);
      return;
    }
    setIsLoading(true);
    try {
      const payload = cleanFormData(formData);
      const NUMERIC_OPTIONAL = [
        'gst', 'sgst_rate', 'cgst_rate', 'igst_rate',
        'tds_rate', 'tcs_rate',
        'credit_limit', 'credit_days',
        'custom_payment_days',
      ];
      for (const key of NUMERIC_OPTIONAL) {
        if (payload[key] === '' || payload[key] == null) {
          delete payload[key];
        }
      }
      payload.vendor_type = formData.vendor_type ? [formData.vendor_type] : [];
      if (formData.address || formData.city || formData.state || formData.pincode) {
        payload.address = {
          line1:   formData.address || '',
          city:    formData.city    || '',
          state:   formData.state   || '',
          pincode: formData.pincode || '',
          country: formData.country || 'IN',
        };
      }
      const fd = new FormData();
      Object.entries(payload).forEach(([k, v]) => {
        if (v === undefined || v === null) return;
        if (typeof v === 'object') fd.append(k, JSON.stringify(v));
        else if (typeof v === 'boolean') fd.append(k, v ? 'true' : 'false');
        else fd.append(k, v);
      });
      Object.entries(files).forEach(([k, f]) => { if (f) fd.append(k, f); });
      await apiClient.post('/api/vendors/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Vendor created successfully!');
      clearLookupCache('/api/vendors/');
      navigate(-1);
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateVendor] error:', error.response?.data);
      const d = error.response?.data || {};
      const pick = (x) => {
        if (Array.isArray(x)) return x[0]?.toString?.() || '';
        if (typeof x === 'string') return x;
        if (typeof x === 'object' && x !== null) return Object.values(x).map(v => pick(v)).filter(Boolean).join('; ');
        return '';
      };
      const errs = {};
      for (const [key, val] of Object.entries(d)) {
        const msg = pick(val);
        if (msg) errs[key] = msg;
      }
      setServerErrors(errs);
      if (d.gstin || d.pan) setFieldErr(prev => ({ ...prev, gstin: pick(d.gstin) || prev.gstin, pan: pick(d.pan) || prev.pan }));
      toast.error(getApiErrorMessage(error));
      // Scroll to the top so the error banner is visible
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Vendor"
        subtitle="Add a new vendor record"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Vendor', href: '/masters/vendor' },
          { label: 'Create New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
        <form onSubmit={handleSubmit}>
          {Object.keys(serverErrors).length > 0 && (
            <div className="mb-4 p-4 bg-red-50 border border-red-300 rounded-lg">
              <p className="text-sm font-semibold text-red-800 mb-2">Please fix the following errors:</p>
              <ul className="list-disc list-inside space-y-1">
                {Object.entries(serverErrors).map(([field, msg]) => (
                  <li key={field} className="text-sm text-red-700">
                    <span className="font-medium">{field.replace(/_/g, ' ')}:</span> {msg}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <EditGate canEdit={editable} className="lg:columns-2 lg:gap-x-6 [&>div]:break-inside-avoid [&>div]:mb-3">
          {/* Section: Basic Information */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-primary-700 mb-1.5 pb-1 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Vendor Code</label>
                {/* Live preview: <company>-VEN-### (sequence per company).
                    Auto-assigned on save — shown here once a company is picked. */}
                <input type="text" value={formData.company ? (nextCode || 'Generating…') : 'Select a company first'} disabled className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-slate-100 text-slate-600 cursor-not-allowed" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Vendor Name <span className="text-red-500">*</span></label>
                <input type="text" name="vendor_name" value={formData.vendor_name} onChange={handleChange} required maxLength={255} className={`w-full px-3 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 ${serverErrors.vendor_name ? 'border-red-400 bg-red-50' : dupMatches.length ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`} placeholder="Enter vendor name" />
                {dupMatches.length > 0 && (
                  <div className="mt-1 text-xs text-amber-700">
                    <span className="font-medium">Possible duplicate — this name matches an existing vendor:</span>
                    <ul className="mt-0.5 list-disc list-inside">
                      {dupMatches.map(m => (
                        <li key={m.id}>{m.vendor_name} <span className="text-amber-500">({m.vendor_code})</span></li>
                      ))}
                    </ul>
                    <span className="text-amber-600">Creating will be blocked unless the name is distinct.</span>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Vendor Type <span className="text-red-500">*</span></label>
                <CustomSelect name="vendor_type" value={formData.vendor_type} onChange={handleChange} required className={`w-full px-3 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 ${serverErrors.vendor_type ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}>
                  <option value="">Select...</option>
                  {VENDOR_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Company <span className="text-red-500">*</span></label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} required className={`w-full px-3 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 ${serverErrors.company ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}>
                  <option value="">Select...</option>
                  {companies.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Section: Tax & Compliance */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-primary-700 mb-1.5 pb-1 border-b">Tax & Compliance</h3>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">GSTIN {isRegisteredTreatment(formData.gst_treatment) && <span className="text-red-500">*</span>}</label>
                <div className="flex items-center gap-2">
                  <input type="text" name="gstin" value={formData.gstin} onChange={handleChange} onBlur={handleBlur} required={isRegisteredTreatment(formData.gst_treatment)} aria-invalid={gstinClash.length > 0 || !!fieldErr.gstin} maxLength={15} className={`w-full px-3 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 ${(gstinClash.length || fieldErr.gstin) ? 'border-red-400 bg-red-50' : gstinOtherCompany.length ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`} placeholder="Enter GSTIN" />
                  {gstVerifyEnabled && (
                    <button type="button" onClick={verifyGstin} disabled={gstVerifying} className="shrink-0 px-3 py-2 text-xs font-medium border border-primary-300 text-primary-700 rounded-lg hover:bg-primary-50 disabled:opacity-50">
                      {gstVerifying ? '…' : 'Verify'}
                    </button>
                  )}
                </div>
                {(fieldErr.gstin || serverErrors.gstin) && (
                  <p role="alert" className="mt-1 text-xs text-red-600">{fieldErr.gstin || serverErrors.gstin}</p>
                )}
                {/* Inline GSTIN clash — same-company is a hard block, another
                    company is informational (the same GSTIN may be reused). */}
                {gstinClash.length > 0 && (
                  <div role="alert" aria-live="polite" className="mt-1 text-xs text-red-700">
                    <span className="font-medium">Already used in this company:</span>
                    <ul className="mt-0.5 list-disc list-inside">
                      {gstinClash.map(m => (
                        <li key={m.id}>{m.vendor_name} <span className="text-red-500">({m.vendor_code})</span></li>
                      ))}
                    </ul>
                    <span>Saving is blocked — one active vendor per GSTIN per company.</span>
                  </div>
                )}
                {gstinClash.length === 0 && gstinOtherCompany.length > 0 && (
                  <div role="alert" aria-live="polite" className="mt-1 text-xs text-amber-700">
                    Also used under {gstinOtherCompany.map(m => `${m.vendor_name} (${m['company__legal_name']})`).join(', ')}. Allowed across companies — check this isn't a duplicate.
                  </div>
                )}
                {gstStatus && (
                  <span className={`mt-1 inline-block text-xs ${gstStatus === 'ACTIVE' ? 'text-emerald-600' : 'text-amber-600'}`}>
                    Portal status: {gstStatus}
                  </span>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">GST Treatment <span className="text-red-500">*</span></label>
                <CustomSelect name="gst_treatment" value={formData.gst_treatment} onChange={handleChange} required className={`w-full px-3 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 ${serverErrors.gst_treatment ? 'border-red-400 bg-red-50' : 'border-slate-300'}`}>
                  <option value="">Select GST treatment</option>
                  {VENDOR_GST_TREATMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                {serverErrors.gst_treatment && <p className="mt-1 text-xs text-red-600">{serverErrors.gst_treatment}</p>}
                {!formData.gst_treatment && <p className="mt-1 text-xs text-slate-500">Select &quot;Unregistered Business&quot; if vendor has no GSTIN</p>}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">PAN <span className="text-red-500">*</span></label>
                <input type="text" name="pan" value={formData.pan} onChange={handleChange} onBlur={handleBlur} required maxLength={10} aria-invalid={!!fieldErr.pan || panMismatch} className={`w-full px-3 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 ${fieldErr.pan ? 'border-red-400 bg-red-50' : panMismatch ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`} placeholder="Enter PAN" />
                {fieldErr.pan && (
                  <p role="alert" className="mt-1 text-xs text-red-600">{fieldErr.pan}</p>
                )}
                {!fieldErr.pan && panMismatch && (
                  <p role="alert" className="mt-1 text-xs text-amber-700">PAN doesn&apos;t match the GSTIN (its PAN is <span className="font-semibold">{gstinPan}</span>).</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">TDS Rate (%)</label>
                <input type="number" step="any" name="tds_rate" value={formData.tds_rate} onChange={handleChange} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter TDS rate" />
                {tdsHint && tdsHint.section_code && (
                  <p className="mt-1 text-xs text-slate-500">
                    Auto: {tdsHint.section_code}
                    {tdsHint.rate != null ? ` @ ${tdsHint.rate}%` : ''}
                    {tdsHint.deductee_category === 'INDIVIDUAL_HUF' ? ' (Individual/HUF)' : ' (Company/Firm/LLP)'}
                    {tdsManual ? ' — overridden' : ''}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">TCS Rate (%)</label>
                <input type="number" step="any" name="tcs_rate" value={formData.tcs_rate} onChange={handleChange} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter TCS rate" />
              </div>
            </div>
            <GstDetailsPanel details={gstDetails} />
          </div>

          {/* Section: Government Verification & Compliance */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-primary-700 mb-1.5 pb-1 border-b">Government Verification &amp; Compliance</h3>
            <div className="space-y-4">
              {/* Toggles row */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" name="is_msme" checked={formData.is_msme} onChange={handleChange} className="rounded border-slate-300" />
                  MSME registered
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" name="is_rcm" checked={formData.is_rcm} onChange={handleChange} className="rounded border-slate-300" />
                  RCM applicable (Reverse Charge)
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" name="is_also_customer" checked={formData.is_also_customer} onChange={handleAlsoCustomerToggle} className="rounded border-slate-300" />
                  Also a customer
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700" title="Show this vendor under the 'Group' filter on the Ledger (Creditors) page.">
                  <input type="checkbox" name="is_group" checked={formData.is_group} onChange={handleChange} className="rounded border-slate-300" />
                  Group
                </label>
              </div>

              {/* MSME details — revealed only when MSME is on */}
              {formData.is_msme && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-4">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-0.5">MSME Category <span className="text-red-500">*</span></label>
                      <CustomSelect name="msme_category" value={formData.msme_category} onChange={handleChange} required className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                        <option value="">Select...</option>
                        <option value="MICRO">Micro</option>
                        <option value="SMALL">Small</option>
                        <option value="MEDIUM">Medium</option>
                      </CustomSelect>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-0.5">Udyam / UAM No. <span className="text-red-500">*</span></label>
                      <input type="text" name="msme_udyam_no" value={formData.msme_udyam_no} onChange={handleChange} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="UDYAM-XX-00-0000000" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-0.5">Udyam Certificate <span className="text-red-500">*</span></label>
                      <input type="file" name="msme_certificate" onChange={handleFileChange} accept=".pdf,.jpg,.jpeg,.png" className="w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:bg-primary-50 file:text-primary-700" />
                    </div>
                  </div>
                  <div className="mt-3">
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" name="has_written_agreement" checked={formData.has_written_agreement} onChange={handleChange} className="rounded border-slate-300" />
                      Written supply agreement exists
                    </label>
                    {formData.has_written_agreement && (
                      <div className="mt-2 max-w-md">
                        <label className="block text-xs font-medium text-slate-600 mb-0.5">Written Agreement Document <span className="text-red-500">*</span></label>
                        <input type="file" name="written_agreement_doc" onChange={handleFileChange} accept=".pdf,.jpg,.jpeg,.png" className="w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:bg-primary-50 file:text-primary-700" />
                      </div>
                    )}
                  </div>
                  {(formData.msme_category === 'MICRO' || formData.msme_category === 'SMALL') && (
                    <p className="mt-3 text-xs text-amber-700">
                      MSMED Act §15: payment terms for this {formData.msme_category.toLowerCase()} vendor are capped at{' '}
                      <span className="font-semibold">{msmeHasAgreementDoc ? '45 days' : '15 days'}</span>
                      {msmeHasAgreementDoc ? ' (written agreement on file).' : ' — upload a written agreement to allow up to 45 days.'}
                    </p>
                  )}
                </div>
              )}

              {/* GSTIN certificate — relevant for registered vendors */}
              {isRegisteredTreatment(formData.gst_treatment) && (
                <div className="max-w-md">
                  <label className="block text-xs font-medium text-slate-600 mb-0.5">GST Registration Certificate</label>
                  <input type="file" name="gstin_certificate" onChange={handleFileChange} accept=".pdf,.jpg,.jpeg,.png" className="w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:bg-primary-50 file:text-primary-700" />
                </div>
              )}
            </div>
          </div>

          {/* Section: Address */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-primary-700 mb-1.5 pb-1 border-b">Address</h3>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Address <span className="text-red-500">*</span></label>
                <textarea name="address" value={formData.address} onChange={handleChange} required rows={2} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter address" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">City <span className="text-red-500">*</span></label>
                <input type="text" name="city" value={formData.city} onChange={handleChange} required className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter city" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">State <span className="text-red-500">*</span></label>
                <CustomSelect name="state" value={formData.state} onChange={handleChange} required className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select State...</option>
                  {INDIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Country <span className="text-red-500">*</span></label>
                <CustomSelect name="country" value={formData.country} onChange={handleChange} required className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select Country...</option>
                  {COUNTRIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Pincode <span className="text-red-500">*</span></label>
                <input type="text" name="pincode" value={formData.pincode} onChange={handleChange} required className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter pincode" />
              </div>
            </div>
          </div>

          {/* Section: Contact Information */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-primary-700 mb-1.5 pb-1 border-b">Contact Information</h3>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Contact Person</label>
                <input type="text" name="contact_person" value={formData.contact_person} onChange={handleChange} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter contact person" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Contact Email <span className="text-red-500">*</span></label>
                <input type="email" name="contact_email" value={formData.contact_email} onChange={handleChange} required className={`w-full px-3 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 ${serverErrors.contact_email ? 'border-red-400 bg-red-50' : 'border-slate-300'}`} placeholder="Enter contact email" />
                {serverErrors.contact_email && <p className="mt-1 text-xs text-red-600">{serverErrors.contact_email}</p>}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Contact Phone</label>
                <input type="text" name="contact_phone" value={formData.contact_phone} onChange={handleChange} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter contact phone" />
              </div>
            </div>
          </div>

          {/* Section: Payment & Credit
              Contractors (loading/unloading labour vendors) settle via
              the periodic Wage Payments cycle — they don't carry
              standard payment terms / credit limits / freight terms /
              freight-split notes, so the whole section is suppressed
              for them. Only the Active toggle stays accessible. */}
          {formData.vendor_type === 'CONTRACTOR' ? (
            <div className="flex items-center gap-2">
              <input type="checkbox" name="active_flag" checked={formData.active_flag} onChange={handleChange} className="rounded border-slate-300" />
              <label className="text-sm text-slate-700">Active</label>
            </div>
          ) : (
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-primary-700 mb-1.5 pb-1 border-b">Payment & Credit</h3>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Payment Terms <span className="text-red-500">*</span></label>
                <CustomSelect name="payment_terms" value={formData.payment_terms} onChange={handleChange} required className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select...</option>
                  {/* MSME Micro/Small suppliers are capped at 15/45 days
                      (MSMED Act §15); allowedPaymentTerms filters the list.
                      withCurrent surfaces any legacy value at the front so a
                      vendor saved before the shortlist rewrite stays editable. */}
                  {withCurrent(allowedPaymentTerms, formData.payment_terms).map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </CustomSelect>
                {formData.is_msme && (formData.msme_category === 'MICRO' || formData.msme_category === 'SMALL') && (
                  <p className="mt-1 text-xs text-slate-500">Capped at {msmeHasAgreementDoc ? '45' : '15'} days (MSME §15).</p>
                )}
              </div>
              {/* Custom Payment Days only renders when Payment Terms ==
                  CUSTOM. Hidden otherwise so the form stays compact and
                  the user can't accidentally save a stray day count
                  against NET_15 / NET_30. */}
              {formData.payment_terms === 'CUSTOM' && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-0.5">Custom Payment Days <span className="text-red-500">*</span></label>
                  <input type="number" name="custom_payment_days" value={formData.custom_payment_days} onChange={handleChange} required className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter custom days" />
                </div>
              )}
              {/* GST Type drives the rate fields below. CGST+SGST mode
                  takes a single GST % and the form auto-splits it 50/50;
                  IGST mode takes a single IGST % only. `freight_terms`
                  used to live in this row — removed per user request
                  (freight is captured at the PO / receipt level now). */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">GST Type</label>
                <CustomSelect name="gst_type" value={formData.gst_type} onChange={handleChange} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select...</option>
                  <option value="CGST_SGST">CGST + SGST (Intra-State)</option>
                  <option value="IGST">IGST (Inter-State)</option>
                </CustomSelect>
              </div>
              {formData.gst_type === 'CGST_SGST' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-0.5">GST %</label>
                    <input type="number" step="any" name="gst" value={formData.gst} onChange={handleChange} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="e.g. 18" />
                  </div>
                  {/* SGST + CGST are auto-filled half-and-half as the
                      user types GST. Rendered read-only so the user
                      can see the split but doesn't have to keep them
                      in sync manually. */}
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-0.5">SGST %</label>
                    <input type="number" step="any" name="sgst_rate" value={formData.sgst_rate} readOnly className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm bg-slate-50" placeholder="Auto" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-0.5">CGST %</label>
                    <input type="number" step="any" name="cgst_rate" value={formData.cgst_rate} readOnly className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm bg-slate-50" placeholder="Auto" />
                  </div>
                </>
              )}
              {formData.gst_type === 'IGST' && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-0.5">IGST %</label>
                  <input type="number" step="any" name="igst_rate" value={formData.igst_rate} onChange={handleChange} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="e.g. 18" />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Credit Limit</label>
                <input type="number" step="any" name="credit_limit" value={formData.credit_limit} onChange={handleChange} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter credit limit" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Credit Days</label>
                <input type="number" name="credit_days" value={formData.credit_days} onChange={handleChange} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter credit days" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" name="active_flag" checked={formData.active_flag} onChange={handleChange} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700">Active</label>
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Freight Split Notes</label>
                <textarea name="freight_split_notes" value={formData.freight_split_notes} onChange={handleChange} rows={2} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter freight split notes" />
              </div>
            </div>
          </div>
          )}

          {/* Section: Additional */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-primary-700 mb-1.5 pb-1 border-b">Additional</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-x-4 gap-y-2">
              <div className="col-span-2 md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-0.5">Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={2} className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
              </div>
            </div>
          </div>

          </EditGate>
          {/* Actions — sticky at the bottom of the viewport so Save/Cancel stay
              reachable on this long form without scrolling to the end. */}
          <div className="flex flex-row justify-end gap-2 pt-3 mt-2 border-t sticky bottom-0 bg-white/95 backdrop-blur -mx-3 sm:-mx-4 px-3 sm:px-4 pb-3 sm:pb-4 z-10">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading || gstinClash.length > 0 || dupMatches.length > 0} title={gstinClash.length > 0 ? 'Resolve the duplicate GSTIN first' : dupMatches.length > 0 ? 'Resolve the duplicate name first' : undefined} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}

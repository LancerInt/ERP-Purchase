import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { panFromGstin, isValidGstin, isValidPan } from '../../../utils/gst.js';
import { VENDOR_GST_TREATMENT_OPTIONS, isRegisteredTreatment } from '../../../constants/gstTreatment.js';
import { withCurrent, msmeAllowedTerms } from '../../../constants/purchaseTerms.js';
import { VENDOR_TYPE_OPTIONS } from '../../../constants/vendorTypes.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { INDIAN_STATES, COUNTRIES } from '../../../utils/locationData.js';
import { confirm } from '@/components/common/confirm';
import { pickPartyLink } from '@/components/common/partyLinkPicker';
import GstDetailsPanel from '../../../components/masters/GstDetailsPanel.jsx';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const inputClassRO = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-500';

// ── Loose-match helpers for legacy / bulk-imported vendor rows ─────
// The vendor master used to accept free-text City/State/Country values,
// so historical rows (and the recent bulk imports) carry strings like
// "TAMILNADU", "INDIA", "INDIA " etc. The dropdowns below expect the
// dropdown's own option values (e.g. State = "Tamil Nadu", Country =
// "IN"); without normalisation the picker silently shows "Select…".

const _slug = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');

function normaliseState(value) {
  if (!value) return '';
  const target = _slug(value);
  // INDIAN_STATES is an array of human-readable names; match either
  // the exact name OR the slug-compared version so "TAMILNADU" lands
  // on "Tamil Nadu" and an already-correct "Tamil Nadu" passes through.
  const hit = INDIAN_STATES.find((s) => _slug(s) === target);
  return hit || '';
}

function normaliseCountry(value) {
  if (!value) return 'IN';
  const target = _slug(value);
  // COUNTRIES uses ISO codes as values ("IN", "US", ...). Match by
  // either the value (already-correct case) or the label (free-text
  // legacy case like "INDIA" or "India").
  const hit = COUNTRIES.find(
    (c) => _slug(c.value) === target || _slug(c.label) === target,
  );
  return hit ? hit.value : 'IN';
}

// Vendor.address is a JSONField. Older rows stored a plain string in
// it; new rows (incl. everything imported via the bulk endpoint) store
// a dict `{line1, city, state, pincode, country}`. The form's address
// textarea wants a single string, so flatten the dict to its line1.
function addressLine1(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return (
      value.line1
      || value.full
      || [value.line1, value.city, value.state, value.pincode, value.country]
        .filter(Boolean)
        .join(', ')
      || ''
    );
  }
  return String(value);
}

export default function EditVendor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, canEdit } = usePermissions();
  const editable = canEdit('Vendor');
  const { options: companies } = useLookup('/api/companies/');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    vendor_code: '',
    vendor_name: '',
    vendor_type: '',
    company: '',
    gstin: '',
    pan: '',
    gst_treatment: '',
    address: '',
    city: '',
    state: '',
    country: 'India',
    pincode: '',
    contact_person: '',
    contact_email: '',
    contact_phone: '',
    payment_terms: '',
    custom_payment_days: '',
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
    is_msme: false,
    msme_category: '',
    msme_udyam_no: '',
    has_written_agreement: false,
    is_rcm: false,
    // Also-a-customer link (server creates-or-links the counterpart on save).
    is_also_customer: false,
    is_group: false,
    linked_customer_name: '',
    // Specific counterpart chosen in the picker (links to THAT record).
    link_to_customer_id: null,
    active_flag: true,
    freight_split_notes: '',
    notes: '',
  });
  // Newly-selected replacement documents (File objects).
  const [files, setFiles] = useState({
    msme_certificate: null, written_agreement_doc: null, gstin_certificate: null,
  });
  // URLs of documents already on the record (so we can show "on file" and know
  // whether the 45-day MSME term is already unlocked without a re-upload).
  const [existingFiles, setExistingFiles] = useState({
    msme_certificate: '', written_agreement_doc: '', gstin_certificate: '',
  });
  const [tdsHint, setTdsHint] = useState(null);
  const [tdsManual, setTdsManual] = useState(false);
  const [dupMatches, setDupMatches] = useState([]);
  // Live GSTIN clashes (same-company blocks; other-company is informational).
  const [gstinDup, setGstinDup] = useState([]);
  const [fieldErr, setFieldErr] = useState({ gstin: '', pan: '' });
  const [gstVerifyEnabled, setGstVerifyEnabled] = useState(false);
  const [gstVerifying, setGstVerifying] = useState(false);
  const [gstStatus, setGstStatus] = useState('');
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
      const { data } = await apiClient.post('/api/vendors/verify-gstin/', { gstin, vendor_id: id });
      setGstStatus(data.status || '');
      setGstDetails(data);
      setFormData(prev => ({
        ...prev,
        vendor_name: prev.vendor_name || data.legal_name || '',
        gst_treatment: prev.gst_treatment || data.gst_treatment || '',
        deductee_category: prev.deductee_category || data.deductee_category || '',
        // PAN isn't in the portal response, but it's the GSTIN's chars 3–12 —
        // backfill a blank PAN from the GSTIN (provider PAN wins if present).
        pan: prev.pan || data.pan || panFromGstin(gstin) || '',
      }));
      if (data.warning) toast(data.warning, { icon: '⚠️', duration: 6000 });
      else toast.success(`GSTIN verified — ${data.status || 'OK'}`);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setGstVerifying(false);
    }
  };

  const handleFileChange = (e) => {
    const { name, files: fl } = e.target;
    setFiles(prev => ({ ...prev, [name]: fl && fl[0] ? fl[0] : null }));
  };

  const handleBlur = (e) => {
    const { name } = e.target;
    const v = (e.target.value || '').trim();
    if (name === 'gstin') {
      setFieldErr(prev => ({ ...prev, gstin: v && !isValidGstin(v) ? 'Invalid GSTIN — 15 chars, e.g. 27AABCA1234B1Z5.' : '' }));
    } else if (name === 'pan') {
      setFieldErr(prev => ({ ...prev, pan: v && !isValidPan(v) ? 'Invalid PAN — e.g. ABCDE1234F.' : '' }));
    }
  };

  const msmeHasAgreementDoc = formData.has_written_agreement
    && (!!files.written_agreement_doc || !!existingFiles.written_agreement_doc);
  const allowedPaymentTerms = msmeAllowedTerms(
    formData.is_msme ? formData.msme_category : '', msmeHasAgreementDoc);

  useEffect(() => {
    apiClient.get(`/api/vendors/${id}/`)
      .then((res) => {
        const v = res.data;
        setExistingFiles({
          msme_certificate: v.msme_certificate || '',
          written_agreement_doc: v.written_agreement_doc || '',
          gstin_certificate: v.gstin_certificate || '',
        });
        setGstStatus(v.gstin_portal_status || '');
        // vendor_type is stored as a JSON list on the backend but the form
        // uses a single-select dropdown — collapse arrays to the first value.
        const vt = Array.isArray(v.vendor_type)
          ? (v.vendor_type[0] || '')
          : (v.vendor_type || '');
        setFormData({
          vendor_code: v.vendor_code || '',
          vendor_name: v.vendor_name || '',
          vendor_type: vt,
          company: v.company || '',
          // Keep the server-side company_name around so we can show it
          // as a sticky fallback option in the dropdown while the
          // companies lookup is still fetching (race condition) OR if
          // the saved UUID is no longer in the list (orphan FK).
          company_name: v.company_name || '',
          gstin: v.gstin || '',
          pan: v.pan || '',
          gst_treatment: v.gst_treatment || '',
          // Address arrives as a JSON dict from the backend; the form
          // textarea wants the line1 string. City/State/Country live
          // both in the dict (for bulk-imported rows) AND on the
          // standalone columns — prefer the standalone, fall back to
          // the dict so legacy rows still populate the fields.
          address: addressLine1(v.address),
          city: v.city || (typeof v.address === 'object' && v.address?.city) || '',
          state: normaliseState(v.state || (typeof v.address === 'object' && v.address?.state) || ''),
          country: normaliseCountry(v.country || (typeof v.address === 'object' && v.address?.country) || 'India'),
          pincode: v.pincode || (typeof v.address === 'object' && v.address?.pincode) || '',
          contact_person: v.contact_person || '',
          contact_email: v.contact_email || '',
          contact_phone: v.contact_phone || '',
          payment_terms: v.payment_terms || '',
          custom_payment_days: v.custom_payment_days ?? '',
          gst_type: v.gst_type || '',
          gst: v.gst ?? '',
          sgst_rate: v.sgst_rate ?? '',
          cgst_rate: v.cgst_rate ?? '',
          igst_rate: v.igst_rate ?? '',
          credit_limit: v.credit_limit ?? '',
          credit_days: v.credit_days ?? '',
          tds_rate: v.tds_rate ?? '',
          tcs_rate: v.tcs_rate ?? '',
          deductee_category: v.deductee_category || '',
          is_msme: !!v.is_msme,
          msme_category: v.msme_category || '',
          msme_udyam_no: v.msme_udyam_no || '',
          has_written_agreement: !!v.has_written_agreement,
          is_rcm: !!v.is_rcm,
          is_also_customer: !!v.is_also_customer,
          is_group: !!v.is_group,
          linked_customer_name: v.linked_customer_name || '',
          link_to_customer_id: null,
          active_flag: v.active_flag !== undefined ? !!v.active_flag : true,
          freight_split_notes: v.freight_split_notes || '',
          notes: v.notes || '',
        });
        // A loaded vendor's TDS rate is authoritative — don't auto-overwrite it.
        setTdsManual(true);
      })
      .catch(() => toast.error('Failed to load vendor'))
      .finally(() => setIsLoading(false));
  }, [id]);

  // Suggested TDS from vendor type + PAN — only if the operator clears the rate
  // and re-derives (tdsManual starts true after load; recomputes on demand).
  useEffect(() => {
    if (tdsManual) return undefined;
    const vt = formData.vendor_type;
    const pan = (formData.pan || '').trim();
    if (!vt) { setTdsHint(null); return undefined; }
    let cancelled = false;
    const t = setTimeout(() => {
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
    return () => { cancelled = true; clearTimeout(t); };
  }, [formData.vendor_type, formData.pan, tdsManual]);

  // Live duplicate suggester — excludes this vendor itself via `exclude=id`
  // (the server drops its own row), with a client-side id filter as a second
  // guard. Also flags a GSTIN already on another active vendor.
  useEffect(() => {
    const name = (formData.vendor_name || '').trim();
    const gstin = (formData.gstin || '').replace(/\s/g, '').toUpperCase();
    const hasName = name && formData.company;
    const hasGstin = gstin.length === 15;
    if (!hasName && !hasGstin) { setDupMatches([]); setGstinDup([]); return undefined; }
    let cancelled = false;
    const t = setTimeout(() => {
      apiClient.get('/api/vendors/check-duplicate/', {
        params: { name, gstin, company: formData.company, exclude: id },
      })
        .then((res) => {
          if (cancelled) return;
          setDupMatches((res.data?.matches || []).filter(m => String(m.id) !== String(id)));
          setGstinDup((res.data?.gstin_matches || []).filter(m => String(m.id) !== String(id)));
        })
        .catch(() => { if (!cancelled) { setDupMatches([]); setGstinDup([]); } });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [formData.vendor_name, formData.gstin, formData.company, id]);

  const gstinClash = gstinDup.filter(m => m.same_company);
  const gstinOtherCompany = gstinDup.filter(m => !m.same_company);
  const gstinPan = panFromGstin(formData.gstin);
  const panTyped = (formData.pan || '').trim().toUpperCase();
  const panMismatch = !!gstinPan && !!panTyped && gstinPan !== panTyped;

  // Clamp an illegal MSME payment term when the cap tightens.
  useEffect(() => {
    if (!formData.is_msme) return;
    if (formData.payment_terms && !allowedPaymentTerms.includes(formData.payment_terms)) {
      setFormData(prev => ({ ...prev, payment_terms: '' }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.is_msme, formData.msme_category, msmeHasAgreementDoc]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    if (name === 'tds_rate') setTdsManual(true);
    const fieldVal = type === 'checkbox' ? checked
      : (name === 'gstin' || name === 'pan') ? value.toUpperCase() : value;
    if (name === 'gstin' || name === 'pan') {
      setFieldErr(prev => (prev[name] ? { ...prev, [name]: '' } : prev));
    }
    setFormData((prev) => {
      const next = { ...prev, [name]: fieldVal };
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
      // GST auto-split: see new.jsx handleChange for the full
      // rationale. Mirror exactly half of the combined GST % into
      // sgst_rate + cgst_rate so the user only types one number.
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
          next.gst = ''; next.sgst_rate = ''; next.cgst_rate = '';
        } else {
          next.gst = ''; next.sgst_rate = ''; next.cgst_rate = ''; next.igst_rate = '';
        }
      }
      return next;
    });
  };

  // "Also a customer" checkbox — same picker flow as new.jsx. Only
  // unchecked→checked opens it; cancel reverts; unchecking is silent. If the
  // vendor is ALREADY linked, skip the picker (re-tick just keeps it on).
  const handleAlsoCustomerToggle = async (e) => {
    const checked = e.target.checked;
    if (!checked) {
      setFormData(prev => ({ ...prev, is_also_customer: false }));
      return;
    }
    if (formData.linked_customer_name) {
      setFormData(prev => ({ ...prev, is_also_customer: true }));
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
      preview = null;
    }
    const res = await pickPartyLink({ counterpart: 'customer', preview, name, gstin, pan });
    if (res.action === 'cancel') return;
    setFormData(prev => ({
      ...prev,
      is_also_customer: true,
      link_to_customer_id: res.action === 'link' ? res.id : null,
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (gstinClash.length > 0) {
      toast.error(`This GSTIN already belongs to vendor ${gstinClash[0].vendor_name} (${gstinClash[0].vendor_code}) in this company.`);
      return;
    }
    if (dupMatches.length > 0) {
      toast.error(`A vendor named "${dupMatches[0].vendor_name}" already exists in this company.`);
      return;
    }
    setIsSaving(true);
    try {
      // Skip vendor_code on update — it's the immutable identifier.
      // linked_customer_name is a read-only display field (never sent back).
      const { vendor_code, linked_customer_name, ...rest } = formData;
      const payload = cleanFormData(rest);
      // GST rate fields are DecimalField(default=0) on the backend; when
      // the operator flips gst_type they get wiped to '' in state, and
      // DRF's DecimalField rejects '' with "a valid number is required".
      // Coerce blanks to 0 so the inactive-side fields save cleanly.
      for (const k of ['gst', 'sgst_rate', 'cgst_rate', 'igst_rate']) {
        if (payload[k] === '' || payload[k] == null) payload[k] = 0;
      }
      // The backend's `address` is a JSONField. Send a structured dict
      // that mirrors the standalone columns so future reads (and the
      // import script's `parse_address`) stay consistent. Without this,
      // `address` would save as a bare string and reads via the edit
      // form would lose the city/state/pincode nesting again.
      payload.address = {
        line1:   formData.address || '',
        city:    formData.city    || '',
        state:   formData.state   || '',
        pincode: formData.pincode || '',
        country: formData.country || 'IN',
      };
      // vendor_type is stored as a JSON list; the serializer also accepts a
      // scalar, but send the canonical shape.
      payload.vendor_type = formData.vendor_type ? [formData.vendor_type] : [];
      // Multipart so any newly-selected compliance document rides along.
      // vendor_type / address go as JSON strings (serializer parses them).
      const fd = new FormData();
      Object.entries(payload).forEach(([k, v]) => {
        if (v === undefined || v === null) return;
        if (typeof v === 'object') fd.append(k, JSON.stringify(v));
        else if (typeof v === 'boolean') fd.append(k, v ? 'true' : 'false');
        else fd.append(k, v);
      });
      Object.entries(files).forEach(([k, f]) => { if (f) fd.append(k, f); });
      await apiClient.patch(`/api/vendors/${id}/`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Vendor updated successfully!');
      navigate(-1);
    } catch (error) {
      const d = error.response?.data || {};
      const pick = (x) => (Array.isArray(x) ? x[0] : (typeof x === 'string' ? x : ''));
      if (d.gstin || d.pan) setFieldErr(prev => ({ ...prev, gstin: pick(d.gstin) || prev.gstin, pan: pick(d.pan) || prev.pan }));
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin" />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        title={`Edit Vendor: ${formData.vendor_name}`}
        subtitle="Update vendor details"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Vendors', href: '/masters/vendor' },
          { label: 'Edit' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Section: Basic Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Vendor Code</label>
                <input type="text" value={formData.vendor_code} disabled className={inputClassRO} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Vendor Name <span className="text-red-500">*</span></label>
                <input type="text" name="vendor_name" value={formData.vendor_name} onChange={handleChange} required className={`${dupMatches.length ? 'w-full px-3 py-2 border border-amber-400 bg-amber-50 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500' : inputClass}`} placeholder="Enter vendor name" />
                {dupMatches.length > 0 && (
                  <div className="mt-1 text-xs text-amber-700">
                    <span className="font-medium">Possible duplicate — matches another vendor:</span>
                    <ul className="mt-0.5 list-disc list-inside">
                      {dupMatches.map(m => (
                        <li key={m.id}>{m.vendor_name} <span className="text-amber-500">({m.vendor_code})</span></li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Vendor Type <span className="text-red-500">*</span></label>
                <CustomSelect name="vendor_type" value={formData.vendor_type} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  {VENDOR_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  {/* Sticky fallback: when the saved company UUID isn't
                      in the loaded options yet (useLookup still fetching
                      OR FK was renamed in master), render it as its own
                      option so the dropdown reflects the real selection
                      instead of resetting to "Select…". */}
                  {formData.company
                    && !companies.find((c) => String(c.value) === String(formData.company)) && (
                      <option value={formData.company}>
                        {formData.company_name || 'Loading…'}
                      </option>
                  )}
                  {companies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Section: Tax & Compliance */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Tax & Compliance</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GSTIN {isRegisteredTreatment(formData.gst_treatment) && <span className="text-red-500">*</span>}</label>
                <div className="flex items-center gap-2">
                  <input type="text" name="gstin" value={formData.gstin} onChange={handleChange} onBlur={handleBlur} required={isRegisteredTreatment(formData.gst_treatment)} aria-invalid={gstinClash.length > 0 || !!fieldErr.gstin} maxLength={15} className={(gstinClash.length || fieldErr.gstin) ? `${inputClass} border-red-400 bg-red-50` : gstinOtherCompany.length ? `${inputClass} border-amber-400 bg-amber-50` : inputClass} placeholder="e.g., 27AABCA1234B1ZX" />
                  {gstVerifyEnabled && (
                    <button type="button" onClick={verifyGstin} disabled={gstVerifying} className="shrink-0 px-3 py-2 text-xs font-medium border border-primary-300 text-primary-700 rounded-lg hover:bg-primary-50 disabled:opacity-50">
                      {gstVerifying ? '…' : 'Verify'}
                    </button>
                  )}
                </div>
                {fieldErr.gstin && (
                  <p role="alert" className="mt-1 text-xs text-red-600">{fieldErr.gstin}</p>
                )}
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
                <label className="block text-sm font-medium text-slate-700 mb-1">GST Treatment</label>
                <CustomSelect name="gst_treatment" value={formData.gst_treatment} onChange={handleChange} className={inputClass}>
                  <option value="">Select GST treatment</option>
                  {VENDOR_GST_TREATMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">PAN <span className="text-red-500">*</span></label>
                <input type="text" name="pan" value={formData.pan} onChange={handleChange} onBlur={handleBlur} required maxLength={10} aria-invalid={!!fieldErr.pan || panMismatch} className={fieldErr.pan ? `${inputClass} border-red-400 bg-red-50` : panMismatch ? `${inputClass} border-amber-400 bg-amber-50` : inputClass} placeholder="e.g., ABCDE1234F" />
                {fieldErr.pan && (
                  <p role="alert" className="mt-1 text-xs text-red-600">{fieldErr.pan}</p>
                )}
                {!fieldErr.pan && panMismatch && (
                  <p role="alert" className="mt-1 text-xs text-amber-700">PAN doesn&apos;t match the GSTIN (its PAN is <span className="font-semibold">{gstinPan}</span>).</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">TDS Rate (%)</label>
                <div className="flex items-center gap-2">
                  <input type="number" step="any" name="tds_rate" value={formData.tds_rate} onChange={handleChange} className={inputClass} placeholder="Enter TDS rate" />
                  <button type="button" onClick={() => { setTdsManual(false); }} title="Re-derive from PAN + vendor type" className="shrink-0 px-2 py-2 text-xs border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50">Auto</button>
                </div>
                {tdsHint && tdsHint.section_code && !tdsManual && (
                  <p className="mt-1 text-xs text-slate-500">
                    {tdsHint.section_code}{tdsHint.rate != null ? ` @ ${tdsHint.rate}%` : ''}
                    {tdsHint.deductee_category === 'INDIVIDUAL_HUF' ? ' (Individual/HUF)' : ' (Company/Firm/LLP)'}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">TCS Rate (%)</label>
                <input type="number" step="any" name="tcs_rate" value={formData.tcs_rate} onChange={handleChange} className={inputClass} placeholder="Enter TCS rate" />
              </div>
            </div>
            <GstDetailsPanel details={gstDetails} />
          </div>

          {/* Section: Government Verification & Compliance */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Government Verification &amp; Compliance</h3>
            <div className="space-y-4">
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
              {formData.linked_customer_name && (
                <p className="text-xs text-slate-500">Linked customer: <span className="font-medium text-slate-700">{formData.linked_customer_name}</span></p>
              )}
              {formData.is_msme && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-4">
                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">MSME Category <span className="text-red-500">*</span></label>
                      <CustomSelect name="msme_category" value={formData.msme_category} onChange={handleChange} required className={inputClass}>
                        <option value="">Select...</option>
                        <option value="MICRO">Micro</option>
                        <option value="SMALL">Small</option>
                        <option value="MEDIUM">Medium</option>
                      </CustomSelect>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Udyam / UAM No. <span className="text-red-500">*</span></label>
                      <input type="text" name="msme_udyam_no" value={formData.msme_udyam_no} onChange={handleChange} className={inputClass} placeholder="UDYAM-XX-00-0000000" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Udyam Certificate {!existingFiles.msme_certificate && <span className="text-red-500">*</span>}</label>
                      <input type="file" name="msme_certificate" onChange={handleFileChange} accept=".pdf,.jpg,.jpeg,.png" className="w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:bg-primary-50 file:text-primary-700" />
                      {existingFiles.msme_certificate && <a href={existingFiles.msme_certificate} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-primary-600 underline">Current file</a>}
                    </div>
                  </div>
                  <div className="mt-3">
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" name="has_written_agreement" checked={formData.has_written_agreement} onChange={handleChange} className="rounded border-slate-300" />
                      Written supply agreement exists
                    </label>
                    {formData.has_written_agreement && (
                      <div className="mt-2 max-w-md">
                        <label className="block text-sm font-medium text-slate-700 mb-1">Written Agreement Document {!existingFiles.written_agreement_doc && <span className="text-red-500">*</span>}</label>
                        <input type="file" name="written_agreement_doc" onChange={handleFileChange} accept=".pdf,.jpg,.jpeg,.png" className="w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:bg-primary-50 file:text-primary-700" />
                        {existingFiles.written_agreement_doc && <a href={existingFiles.written_agreement_doc} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-primary-600 underline">Current file</a>}
                      </div>
                    )}
                  </div>
                  {(formData.msme_category === 'MICRO' || formData.msme_category === 'SMALL') && (
                    <p className="mt-3 text-xs text-amber-700">
                      MSMED Act §15: payment terms capped at{' '}
                      <span className="font-semibold">{msmeHasAgreementDoc ? '45 days' : '15 days'}</span>
                      {msmeHasAgreementDoc ? ' (written agreement on file).' : ' — add a written agreement to allow up to 45 days.'}
                    </p>
                  )}
                </div>
              )}
              {isRegisteredTreatment(formData.gst_treatment) && (
                <div className="max-w-md">
                  <label className="block text-sm font-medium text-slate-700 mb-1">GST Registration Certificate</label>
                  <input type="file" name="gstin_certificate" onChange={handleFileChange} accept=".pdf,.jpg,.jpeg,.png" className="w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:bg-primary-50 file:text-primary-700" />
                  {existingFiles.gstin_certificate && <a href={existingFiles.gstin_certificate} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-primary-600 underline">Current file</a>}
                </div>
              )}
            </div>
          </div>

          {/* Section: Address */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Address</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Address <span className="text-red-500">*</span></label>
                <textarea name="address" value={formData.address} onChange={handleChange} required rows={3} className={inputClass} placeholder="Enter address" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">City <span className="text-red-500">*</span></label>
                <input type="text" name="city" value={formData.city} onChange={handleChange} required className={inputClass} placeholder="Enter city" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">State <span className="text-red-500">*</span></label>
                <CustomSelect name="state" value={formData.state} onChange={handleChange} required className={inputClass}>
                  <option value="">Select State...</option>
                  {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Country <span className="text-red-500">*</span></label>
                <CustomSelect name="country" value={formData.country} onChange={handleChange} required className={inputClass}>
                  <option value="">Select Country...</option>
                  {COUNTRIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Pincode <span className="text-red-500">*</span></label>
                <input type="text" name="pincode" value={formData.pincode} onChange={handleChange} required className={inputClass} placeholder="Enter pincode" />
              </div>
            </div>
          </div>

          {/* Section: Contact Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Contact Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Person</label>
                <input type="text" name="contact_person" value={formData.contact_person} onChange={handleChange} className={inputClass} placeholder="Enter contact person" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Email</label>
                <input type="email" name="contact_email" value={formData.contact_email} onChange={handleChange} className={inputClass} placeholder="Enter contact email" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Phone</label>
                <input type="text" name="contact_phone" value={formData.contact_phone} onChange={handleChange} className={inputClass} placeholder="Enter contact phone" />
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
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Payment & Credit</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Payment Terms <span className="text-red-500">*</span></label>
                <CustomSelect name="payment_terms" value={formData.payment_terms} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  {/* MSME Micro/Small capped at 15/45 days (§15); otherwise the
                      full list. withCurrent keeps a legacy value editable. */}
                  {withCurrent(allowedPaymentTerms, formData.payment_terms).map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </CustomSelect>
                {formData.is_msme && (formData.msme_category === 'MICRO' || formData.msme_category === 'SMALL') && (
                  <p className="mt-1 text-xs text-slate-500">Capped at {msmeHasAgreementDoc ? '45' : '15'} days (MSME §15).</p>
                )}
              </div>
              {/* Custom Payment Days only renders when Payment Terms ==
                  CUSTOM. Hidden otherwise so the form stays compact. */}
              {formData.payment_terms === 'CUSTOM' && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Custom Payment Days <span className="text-red-500">*</span></label>
                  <input type="number" name="custom_payment_days" value={formData.custom_payment_days} onChange={handleChange} required className={inputClass} placeholder="Enter custom days" />
                </div>
              )}
              {/* GST Type drives the rate fields below. `freight_terms`
                  was removed per user request — freight is captured at
                  the PO / receipt level now. */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GST Type</label>
                <CustomSelect name="gst_type" value={formData.gst_type} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option>
                  <option value="CGST_SGST">CGST + SGST (Intra-State)</option>
                  <option value="IGST">IGST (Inter-State)</option>
                </CustomSelect>
              </div>
              {formData.gst_type === 'CGST_SGST' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">GST %</label>
                    <input type="number" step="any" name="gst" value={formData.gst} onChange={handleChange} className={inputClass} placeholder="e.g. 18" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">SGST %</label>
                    <input type="number" step="any" name="sgst_rate" value={formData.sgst_rate} readOnly className={`${inputClass} bg-slate-50`} placeholder="Auto" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">CGST %</label>
                    <input type="number" step="any" name="cgst_rate" value={formData.cgst_rate} readOnly className={`${inputClass} bg-slate-50`} placeholder="Auto" />
                  </div>
                </>
              )}
              {formData.gst_type === 'IGST' && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">IGST %</label>
                  <input type="number" step="any" name="igst_rate" value={formData.igst_rate} onChange={handleChange} className={inputClass} placeholder="e.g. 18" />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Credit Limit</label>
                <input type="number" step="any" name="credit_limit" value={formData.credit_limit} onChange={handleChange} className={inputClass} placeholder="Enter credit limit" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Credit Days</label>
                <input type="number" name="credit_days" value={formData.credit_days} onChange={handleChange} className={inputClass} placeholder="Enter credit days" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" name="active_flag" checked={formData.active_flag} onChange={handleChange} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700">Active</label>
              </div>
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Freight Split Notes</label>
                <textarea name="freight_split_notes" value={formData.freight_split_notes} onChange={handleChange} rows={3} className={inputClass} placeholder="Enter freight split notes" />
              </div>
            </div>
          </div>
          )}

          {/* Section: Additional */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Additional</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Actions — sticky at the bottom so Save/Cancel stay reachable on
              this long form without scrolling to the end. */}
          <div className="flex flex-row items-center justify-between gap-2 pt-4 border-t sticky bottom-0 bg-white/95 backdrop-blur -mx-3 sm:-mx-6 px-3 sm:px-6 pb-3 sm:pb-4 z-10">
            {isAdmin ? (
              <button
                type="button"
                onClick={async () => {
                  if (!(await confirm({ message: `Deactivate vendor "${formData.vendor_name}"?`, isDangerous: true }))) return;
                  try {
                    await apiClient.patch(`/api/vendors/${id}/`, { active_flag: false, is_active: false });
                    toast.success('Vendor deactivated');
                    navigate(-1);
                  } catch (err) {
                    toast.error(getApiErrorMessage(err));
                  }
                }}
                className="px-4 sm:px-6 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700"
              >
                Delete
              </button>
            ) : <div />}
            <div className="flex flex-row gap-2">
              <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
              <button type="submit" disabled={isSaving || gstinClash.length > 0 || dupMatches.length > 0} title={gstinClash.length > 0 ? 'Resolve the duplicate GSTIN first' : dupMatches.length > 0 ? 'Resolve the duplicate name first' : undefined} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isSaving ? 'Saving...' : 'Save Changes'}</button>
            </div>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}

import CustomSelect from "@/components/ui/CustomSelect";
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Handshake, Upload, X } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { INDIAN_STATES, COUNTRIES } from '../../../utils/locationData.js';

/**
 * Broker Master — create form.
 *
 * Mirrors the existing Vendor master form style (full-width sectioned
 * layout, not tabs). Submits multipart/form-data so the GST / PAN /
 * Agreement file inputs can be uploaded in the same request as the
 * JSON fields. Auto-generated broker_code comes back on the response;
 * we don't need to capture it on the client.
 */

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const labelClass = 'block text-sm font-medium text-slate-700 mb-1';

const BROKER_TYPE_CHOICES = [
  { value: 'PURCHASE',   label: 'Purchase Broker' },
  { value: 'SALES',      label: 'Sales Broker' },
  { value: 'FREIGHT',    label: 'Freight Broker' },
  { value: 'EXPORT',     label: 'Export Agent' },
  { value: 'IMPORT',     label: 'Import Agent' },
  { value: 'COMMISSION', label: 'Commission Agent' },
];

// Goods sub-types mirror master.Product.GOODS_SUB_TYPE_CHOICES so the
// broker's preferred categories use the same vocabulary as products.
const CATEGORY_CHOICES = [
  { value: 'RAW_MATERIAL',     label: 'Raw Material' },
  { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'FINISHED_GOOD',    label: 'Finished Good' },
  { value: 'SEMI_FINISHED',    label: 'Semi Finished' },
  { value: 'TRADED_PRODUCTS',  label: 'Traded Products' },
  { value: 'CAPITAL_GOOD',     label: 'Capital Good' },
  { value: 'MACHINE_SPARES',   label: 'Machine Spares' },
  { value: 'CONSUMABLES',      label: 'Consumables' },
];

export default function CreateBroker() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Broker');

  // Source data for multi-selects.
  const { options: vendorOptions } = useLookup('/api/vendors/', { labelField: 'vendor_name' });

  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    // Basic
    broker_name: '',
    broker_type: 'PURCHASE',
    contact_person: '',
    status: 'ACTIVE',
    // Contact
    mobile_number: '',
    alternate_mobile: '',
    whatsapp_number: '',
    email: '',
    website: '',
    // Address
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    country: 'India',
    pincode: '',
    // Commission
    commission_type: 'PERCENTAGE',
    commission_value: '',
    gst_applicable: false,
    gst_number: '',
    pan_number: '',
    tds_applicable: false,
    // Banking
    bank_account_holder: '',
    bank_name: '',
    bank_account_number: '',
    bank_ifsc_code: '',
    bank_branch_name: '',
    upi_id: '',
    // Business linkage
    preferred_vendors: [],          // array of vendor IDs
    preferred_categories: [],       // array of category codes
    assigned_purchase_manager: '',
    operating_regions: '',
    // Notes
    remarks: '',
    internal_notes: '',
  });

  // Attachments — kept separate from formData so we can attach to
  // FormData() at submit time instead of mixing File objects into the
  // JSON-style state object.
  const [files, setFiles] = useState({
    gst_certificate: null,
    pan_copy: null,
    agreement: null,
  });

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleFileChange = (key) => (e) => {
    const file = e.target.files?.[0] || null;
    setFiles(prev => ({ ...prev, [key]: file }));
  };

  const removeFile = (key) => () => {
    setFiles(prev => ({ ...prev, [key]: null }));
  };

  // Toggle a value in/out of a multi-select array stored on formData.
  const toggleMulti = (key) => (value) => {
    setFormData(prev => {
      const set = new Set(prev[key] || []);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      return { ...prev, [key]: Array.from(set) };
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.broker_name.trim()) {
      toast.error('Broker Name is required');
      return;
    }
    if (formData.commission_value !== '' && parseFloat(formData.commission_value) < 0) {
      toast.error('Commission value cannot be negative');
      return;
    }
    setIsLoading(true);
    try {
      // Build multipart form data so file uploads work in the same request.
      const cleaned = cleanFormData(formData);
      const fd = new FormData();
      Object.entries(cleaned).forEach(([k, v]) => {
        if (v === null || v === undefined) return;
        // Multi-value fields → repeat the key (DRF reads .getlist()).
        // Send the joined string for `preferred_categories` (CharField),
        // and individual entries for `preferred_vendors` (M2M).
        if (Array.isArray(v)) {
          if (k === 'preferred_categories') {
            fd.append(k, v.join(','));
          } else {
            v.forEach((item) => fd.append(k, item));
          }
          return;
        }
        if (typeof v === 'boolean') {
          fd.append(k, v ? 'true' : 'false');
          return;
        }
        fd.append(k, v);
      });
      Object.entries(files).forEach(([k, f]) => {
        if (f) fd.append(k, f);
      });

      const res = await apiClient.post('/api/brokers/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(`Broker ${res.data?.broker_code || ''} created successfully!`);
      navigate(-1);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[CreateBroker] error:', err.response?.data);
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Broker"
        subtitle="Add a new broker / agent record"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Broker', href: '/masters/broker' },
          { label: 'Create New' },
        ]}
      />

      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">

          {/* ── Basic Information ─────────────────────────────────── */}
          <Section icon={<Handshake size={18} />} title="Basic Information">
            <Grid>
              <Field label="Broker Name" required>
                <input
                  type="text"
                  name="broker_name"
                  value={formData.broker_name}
                  onChange={handleChange}
                  required
                  className={inputClass}
                  placeholder="e.g. Ravi Kumar Brokers"
                />
              </Field>
              <Field label="Broker Type" required>
                <CustomSelect
                  name="broker_type"
                  value={formData.broker_type}
                  onChange={handleChange}
                  required
                  className={inputClass}
                >
                  {BROKER_TYPE_CHOICES.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </CustomSelect>
              </Field>
              <Field label="Contact Person">
                <input
                  type="text"
                  name="contact_person"
                  value={formData.contact_person}
                  onChange={handleChange}
                  className={inputClass}
                  placeholder="Primary point of contact"
                />
              </Field>
              <Field label="Status">
                <CustomSelect name="status" value={formData.status} onChange={handleChange} className={inputClass}>
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </CustomSelect>
              </Field>
              <Field label="Broker Code">
                <input
                  type="text"
                  value="(auto-generated on save)"
                  readOnly
                  className={`${inputClass} bg-slate-50 text-slate-500`}
                />
              </Field>
            </Grid>
          </Section>

          {/* ── Contact Details ───────────────────────────────────── */}
          <Section title="Contact Details">
            <Grid>
              <Field label="Mobile Number">
                <input
                  type="tel"
                  name="mobile_number"
                  value={formData.mobile_number}
                  onChange={handleChange}
                  className={inputClass}
                  placeholder="+91 98765 43210"
                />
              </Field>
              <Field label="Alternate Mobile">
                <input
                  type="tel"
                  name="alternate_mobile"
                  value={formData.alternate_mobile}
                  onChange={handleChange}
                  className={inputClass}
                />
              </Field>
              <Field label="WhatsApp Number">
                <input
                  type="tel"
                  name="whatsapp_number"
                  value={formData.whatsapp_number}
                  onChange={handleChange}
                  className={inputClass}
                />
              </Field>
              <Field label="Email">
                <input
                  type="email"
                  name="email"
                  value={formData.email}
                  onChange={handleChange}
                  className={inputClass}
                  placeholder="broker@example.com"
                />
              </Field>
              <Field label="Website">
                <input
                  type="url"
                  name="website"
                  value={formData.website}
                  onChange={handleChange}
                  className={inputClass}
                  placeholder="https://"
                />
              </Field>
            </Grid>
          </Section>

          {/* ── Address ───────────────────────────────────────────── */}
          <Section title="Address">
            <Grid>
              <Field label="Address Line 1" colSpan={2}>
                <input
                  type="text"
                  name="address_line1"
                  value={formData.address_line1}
                  onChange={handleChange}
                  className={inputClass}
                />
              </Field>
              <Field label="Address Line 2" colSpan={2}>
                <input
                  type="text"
                  name="address_line2"
                  value={formData.address_line2}
                  onChange={handleChange}
                  className={inputClass}
                />
              </Field>
              <Field label="City">
                <input type="text" name="city" value={formData.city} onChange={handleChange} className={inputClass} />
              </Field>
              <Field label="State">
                <CustomSelect name="state" value={formData.state} onChange={handleChange} className={inputClass}>
                  <option value="">Select state…</option>
                  {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </CustomSelect>
              </Field>
              <Field label="Country">
                <CustomSelect name="country" value={formData.country} onChange={handleChange} className={inputClass}>
                  {/* COUNTRIES is an array of {value, label} objects */}
                  {COUNTRIES.map((c) => <option key={c.value} value={c.label}>{c.label}</option>)}
                </CustomSelect>
              </Field>
              <Field label="Pincode">
                <input type="text" name="pincode" value={formData.pincode} onChange={handleChange} className={inputClass} />
              </Field>
            </Grid>
          </Section>

          {/* ── Commission Details ────────────────────────────────── */}
          <Section title="Commission Details">
            <Grid>
              <Field label="Commission Type">
                <CustomSelect name="commission_type" value={formData.commission_type} onChange={handleChange} className={inputClass}>
                  <option value="PERCENTAGE">Percentage (%)</option>
                  <option value="FIXED">Fixed Amount (₹)</option>
                </CustomSelect>
              </Field>
              <Field label={`Commission Value ${formData.commission_type === 'PERCENTAGE' ? '(%)' : '(₹)'}`}>
                <input
                  type="number"
                  name="commission_value"
                  value={formData.commission_value}
                  onChange={handleChange}
                  min="0"
                  step="0.01"
                  className={inputClass}
                  placeholder="0.00"
                />
              </Field>
              <Field label="GST Number">
                <input
                  type="text"
                  name="gst_number"
                  value={formData.gst_number}
                  onChange={handleChange}
                  className={inputClass}
                  placeholder="15-char GSTIN"
                  maxLength={15}
                />
              </Field>
              <Field label="PAN Number">
                <input
                  type="text"
                  name="pan_number"
                  value={formData.pan_number}
                  onChange={handleChange}
                  className={inputClass}
                  placeholder="ABCDE1234F"
                  maxLength={10}
                  style={{ textTransform: 'uppercase' }}
                />
              </Field>
              <Field label="GST Applicable">
                <label className="inline-flex items-center gap-2 mt-2">
                  <input
                    type="checkbox"
                    name="gst_applicable"
                    checked={formData.gst_applicable}
                    onChange={handleChange}
                    className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  />
                  <span className="text-sm text-slate-700">Yes, charge GST on commission</span>
                </label>
              </Field>
              <Field label="TDS Applicable">
                <label className="inline-flex items-center gap-2 mt-2">
                  <input
                    type="checkbox"
                    name="tds_applicable"
                    checked={formData.tds_applicable}
                    onChange={handleChange}
                    className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  />
                  <span className="text-sm text-slate-700">Yes, deduct TDS</span>
                </label>
              </Field>
            </Grid>
          </Section>

          {/* ── Bank Details ──────────────────────────────────────── */}
          <Section title="Bank Details">
            <Grid>
              <Field label="Account Holder Name">
                <input type="text" name="bank_account_holder" value={formData.bank_account_holder} onChange={handleChange} className={inputClass} />
              </Field>
              <Field label="Bank Name">
                <input type="text" name="bank_name" value={formData.bank_name} onChange={handleChange} className={inputClass} />
              </Field>
              <Field label="Account Number">
                <input type="text" name="bank_account_number" value={formData.bank_account_number} onChange={handleChange} className={inputClass} />
              </Field>
              <Field label="IFSC Code">
                <input
                  type="text"
                  name="bank_ifsc_code"
                  value={formData.bank_ifsc_code}
                  onChange={handleChange}
                  className={inputClass}
                  maxLength={11}
                  style={{ textTransform: 'uppercase' }}
                />
              </Field>
              <Field label="Branch Name">
                <input type="text" name="bank_branch_name" value={formData.bank_branch_name} onChange={handleChange} className={inputClass} />
              </Field>
              <Field label="UPI ID">
                <input type="text" name="upi_id" value={formData.upi_id} onChange={handleChange} className={inputClass} placeholder="name@upi" />
              </Field>
            </Grid>
          </Section>

          {/* ── Business Details ──────────────────────────────────── */}
          <Section title="Business Details">
            <div className="space-y-4">
              <Field label="Preferred Vendors" colSpan={4}>
                <MultiSelectChips
                  options={vendorOptions || []}
                  selectedValues={formData.preferred_vendors}
                  onToggle={toggleMulti('preferred_vendors')}
                  placeholder="No vendors selected — click below to add"
                />
              </Field>
              <Field label="Preferred Categories" colSpan={4}>
                <MultiSelectChips
                  options={CATEGORY_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
                  selectedValues={formData.preferred_categories}
                  onToggle={toggleMulti('preferred_categories')}
                  placeholder="No categories selected"
                />
              </Field>
              <Grid>
                <Field label="Operating Regions">
                  <input
                    type="text"
                    name="operating_regions"
                    value={formData.operating_regions}
                    onChange={handleChange}
                    className={inputClass}
                    placeholder="e.g. Tamil Nadu, Karnataka"
                  />
                </Field>
              </Grid>
            </div>
          </Section>

          {/* ── Attachments ───────────────────────────────────────── */}
          <Section title="Attachments">
            <Grid>
              <FilePicker
                label="GST Certificate"
                file={files.gst_certificate}
                onChange={handleFileChange('gst_certificate')}
                onRemove={removeFile('gst_certificate')}
              />
              <FilePicker
                label="PAN Copy"
                file={files.pan_copy}
                onChange={handleFileChange('pan_copy')}
                onRemove={removeFile('pan_copy')}
              />
              <FilePicker
                label="Broker Agreement"
                file={files.agreement}
                onChange={handleFileChange('agreement')}
                onRemove={removeFile('agreement')}
              />
            </Grid>
          </Section>

          {/* ── Additional ────────────────────────────────────────── */}
          <Section title="Additional">
            <Grid>
              <Field label="Remarks" colSpan={2}>
                <textarea
                  name="remarks"
                  value={formData.remarks}
                  onChange={handleChange}
                  rows={3}
                  className={inputClass}
                  placeholder="Visible on broker reports"
                />
              </Field>
              <Field label="Internal Notes" colSpan={2}>
                <textarea
                  name="internal_notes"
                  value={formData.internal_notes}
                  onChange={handleChange}
                  rows={3}
                  className={inputClass}
                  placeholder="Private notes for internal team only"
                />
              </Field>
            </Grid>
          </Section>

          {/* Form Actions */}
          <div className="flex flex-row justify-end gap-2 pt-4 border-t">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
            >
              {isLoading ? 'Saving…' : 'Create Broker'}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}

// ── Local presentation components ──────────────────────────────────

function Section({ icon, title, children }) {
  return (
    <div>
      <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b flex items-center gap-2">
        {icon}
        {title}
      </h3>
      {children}
    </div>
  );
}

function Grid({ children }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {children}
    </div>
  );
}

// Field column-span needs to be a static Tailwind class so the JIT can
// see it at build time. We pre-define the supported widths instead of
// interpolating into the className string at runtime.
const COL_SPAN_CLASSES = {
  1: '',
  2: 'col-span-2 md:col-span-2 lg:col-span-2',
  4: 'col-span-2 md:col-span-2 lg:col-span-4',
};

function Field({ label, required, colSpan = 1, children }) {
  const span = COL_SPAN_CLASSES[colSpan] || '';
  return (
    <div className={span}>
      <label className={labelClass}>
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}

function MultiSelectChips({ options, selectedValues, onToggle, placeholder }) {
  const selectedSet = new Set((selectedValues || []).map(String));
  const selected = (options || []).filter((o) => selectedSet.has(String(o.value)));
  const available = (options || []).filter((o) => !selectedSet.has(String(o.value)));

  return (
    <div className="border border-slate-300 rounded-lg p-2 min-h-[44px] bg-white">
      {/* Selected chips */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {selected.length === 0 ? (
          <p className="text-xs text-slate-400 italic px-1 py-0.5">{placeholder}</p>
        ) : (
          selected.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onToggle(o.value)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-primary-100 text-primary-700 hover:bg-primary-200"
            >
              {o.label} <X size={11} />
            </button>
          ))
        )}
      </div>
      {/* Available options */}
      {available.length > 0 && (
        <div className="border-t border-slate-200 pt-2 flex flex-wrap gap-1.5 max-h-32 overflow-auto">
          {available.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onToggle(o.value)}
              className="px-2 py-0.5 rounded-full text-xs border border-slate-200 bg-slate-50 text-slate-700 hover:border-primary-300 hover:bg-primary-50"
            >
              + {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FilePicker({ label, file, onChange, onRemove }) {
  return (
    <div>
      <label className={labelClass}>{label}</label>
      {file ? (
        <div className="flex items-center justify-between px-3 py-2 border border-emerald-200 bg-emerald-50/50 rounded-lg">
          <div className="flex items-center gap-2 min-w-0">
            <Upload size={14} className="text-emerald-600 flex-shrink-0" />
            <span className="text-sm text-slate-800 truncate">{file.name}</span>
            <span className="text-xs text-slate-500 flex-shrink-0">
              {(file.size / 1024).toFixed(1)} KB
            </span>
          </div>
          <button
            type="button"
            onClick={onRemove}
            className="text-slate-400 hover:text-red-500"
            title="Remove file"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <label className="flex items-center gap-2 px-3 py-2 border-2 border-dashed border-slate-300 rounded-lg cursor-pointer hover:border-primary-400 hover:bg-primary-50/30 transition">
          <Upload size={14} className="text-slate-400" />
          <span className="text-sm text-slate-500">Click to upload</span>
          <input type="file" className="hidden" onChange={onChange} accept=".pdf,.jpg,.jpeg,.png" />
        </label>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { FormCard, Field, Input, Select, Textarea, Checkbox, Button } from '../../../components/common/forms';

export default function CreateTransporter() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Transporter');
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    transporter_code: '',
    name: '',
    gstin: '',
    contact_person: '',
    contact_email: '',
    contact_phone: '',
    active_flag: true,
    notes: '',
  });

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const payload = cleanFormData(formData);
      if (import.meta.env.DEV) console.log('[CreateTransporter] payload:', payload);
      await apiClient.post('/api/transporters/', payload);
      toast.success('Transporter created successfully!');
      navigate(-1);
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateTransporter] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Transporter"
        subtitle="Add a new transporter record"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Transporter', href: '/masters/transporter' },
          { label: 'Create New' },
        ]}
      />

      <form onSubmit={handleSubmit}>
        <EditGate canEdit={editable} className="pb-4 sm:pb-0">
        <FormCard>
          <FormCard.Section
            title="Basic Information"
            description="Identification and tax details for this transporter."
          >
            <FormCard.Grid cols={3}>
              <Field id="transporter_code" label="Transporter Code" required>
                <Input
                  id="transporter_code"
                  name="transporter_code"
                  value={formData.transporter_code}
                  onChange={handleChange}
                  required
                  placeholder="e.g. TR-001"
                />
              </Field>
              <Field id="name" label="Name" required>
                <Input
                  id="name"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  required
                  placeholder="Legal or trading name"
                />
              </Field>
              <Field id="gstin" label="GSTIN" hint="15-character GST registration number">
                <Input
                  id="gstin"
                  name="gstin"
                  value={formData.gstin}
                  onChange={handleChange}
                  maxLength={15}
                  placeholder="22ABCDE1234F1Z5"
                />
              </Field>
            </FormCard.Grid>
          </FormCard.Section>

          <FormCard.Section
            title="Contact Information"
            description="Who do we reach for bookings and dispatch coordination?"
          >
            <FormCard.Grid cols={3}>
              <Field id="contact_person" label="Contact Person">
                <Input
                  id="contact_person"
                  name="contact_person"
                  value={formData.contact_person}
                  onChange={handleChange}
                  placeholder="Primary point of contact"
                />
              </Field>
              <Field id="contact_email" label="Contact Email">
                <Input
                  id="contact_email"
                  type="email"
                  name="contact_email"
                  value={formData.contact_email}
                  onChange={handleChange}
                  placeholder="ops@transporter.com"
                  inputMode="email"
                />
              </Field>
              <Field id="contact_phone" label="Contact Phone">
                <Input
                  id="contact_phone"
                  name="contact_phone"
                  value={formData.contact_phone}
                  onChange={handleChange}
                  placeholder="+91 98765 43210"
                  inputMode="tel"
                />
              </Field>
            </FormCard.Grid>
          </FormCard.Section>

          <FormCard.Section title="Additional">
            <FormCard.Grid cols={2}>
              <Field id="notes" label="Notes" colSpan={2}>
                <Textarea
                  id="notes"
                  name="notes"
                  value={formData.notes}
                  onChange={handleChange}
                  rows={3}
                  placeholder="Anything else worth recording about this transporter…"
                />
              </Field>
              <Field colSpan={2}>
                <Checkbox
                  id="active_flag"
                  name="active_flag"
                  checked={formData.active_flag}
                  onChange={handleChange}
                  label="Active"
                  hint="Inactive transporters are hidden from booking dropdowns but kept for history."
                />
              </Field>
            </FormCard.Grid>
          </FormCard.Section>

          <div className="flex flex-row justify-end gap-2 px-4 sm:px-6 py-4 bg-slate-50 border-t border-slate-100">
            <button type="button" onClick={() => navigate(-1)} className="flex-1 sm:flex-none px-3 sm:px-6 py-2 bg-white border border-slate-300 rounded-lg text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="flex-1 sm:flex-none px-3 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-xs sm:text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving…' : 'Save Transporter'}</button>
          </div>
        </FormCard>
        </EditGate>
      </form>
    </MainLayout>
  );
}

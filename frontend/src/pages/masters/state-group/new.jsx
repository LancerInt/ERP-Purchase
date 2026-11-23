import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { clearLookupCache } from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import StateGroupForm, { validateStateGroup } from './StateGroupForm.jsx';

const empty = { name: '', member_states: [], region: '', notes: '' };

export default function CreateStateGroup() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('State Group');
  const [formData, setFormData] = useState(empty);
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validateStateGroup(formData)) return;
    setIsSaving(true);
    try {
      await apiClient.post('/api/state-groups/', formData);
      // Bust the lookup cache so the price-list dropdown picks the new
      // group up without a hard refresh.
      clearLookupCache('/api/state-groups/');
      toast.success('State group created');
      navigate(-1);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create State Group"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'State Groups', href: '/masters/state-group' },
          { label: 'Create New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit} noValidate>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          <StateGroupForm value={formData} onChange={setFormData} />
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
              disabled={isSaving}
              className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}

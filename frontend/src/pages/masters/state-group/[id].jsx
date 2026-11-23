import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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

export default function EditStateGroup() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit } = usePermissions();
  const editable = canEdit('State Group');
  const [formData, setFormData] = useState(empty);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const res = await apiClient.get(`/api/state-groups/${id}/`);
        const d = res.data;
        setFormData({
          name: d.name || '',
          member_states: d.member_states || [],
          region: d.region || '',
          notes: d.notes || '',
        });
      } catch {
        toast.error('Failed to load state group');
        navigate(-1);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [id]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validateStateGroup(formData)) return;
    setIsSaving(true);
    try {
      await apiClient.put(`/api/state-groups/${id}/`, formData);
      clearLookupCache('/api/state-groups/');
      toast.success('State group updated');
      navigate(-1);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="space-y-4">{[1, 2].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}</div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        title={`Edit State Group — ${formData.name}`}
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'State Groups', href: '/masters/state-group' },
          { label: formData.name },
          { label: 'Edit' },
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
              {isSaving ? 'Saving...' : 'Update'}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}

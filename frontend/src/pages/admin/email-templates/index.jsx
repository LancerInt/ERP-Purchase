import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Edit, Trash2, RefreshCw } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import useApiData from '../../../hooks/useApiData.js';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import MobileListCards from '../components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

export default function EmailTemplateList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/communications/templates/');
  const [deleting, setDeleting] = useState(null);

  const handleDelete = async (id, name) => {
    if (!(await confirm({ message: `Are you sure you want to delete the template "${name}"?`, isDangerous: true }))) return;
    setDeleting(id);
    try {
      await apiClient.delete(`/api/communications/templates/${id}/`);
      toast.success('Template deleted successfully');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setDeleting(null);
    }
  };

  const columns = [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'subject', label: 'Subject', sortable: true },
    {
      key: 'is_default',
      label: 'Default',
      render: (value) => (
        value ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Yes</span>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">No</span>
        )
      ),
    },
    {
      key: 'created_at',
      label: 'Created',
      sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (_, row) => (
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/admin/email-templates/${row.id}/edit`); }}
            className="px-3 py-1 text-xs font-medium text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100 transition"
          >
            Edit
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleDelete(row.id, row.name); }}
            disabled={deleting === row.id}
            className="px-3 py-1 text-xs font-medium text-red-700 bg-red-50 rounded-lg hover:bg-red-100 transition disabled:opacity-50"
          >
            {deleting === row.id ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      ),
    },
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Email Templates"
        subtitle="Manage email templates for RFQ and communications"
        breadcrumbs={[
          { label: 'Admin' },
          { label: 'Email Templates' },
        ]}
        actions={{
          ...(canCreate('Email Template') ? { createLink: '/admin/email-templates/new', createLabel: 'Create Template' } : {}),
        }}
      />
      <ListState error={error} onRetry={refetch}>
      <MobileListCards
        rows={data || []}
        isLoading={isLoading}
        config={{
          title: (row) => row.name || '—',
          subtitle: (row) => row.subject,
          badge: (row) => row.is_default
            ? { label: 'Default', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
            : null,
          fields: (row) => [
            { label: 'Created', value: row.created_at ? formatDate(row.created_at) : '-' },
          ],
          actions: (row) => [
            canEdit('Email Template') && { icon: Edit,   label: 'Edit',   cls: 'text-primary-700 hover:bg-primary-50', onClick: () => navigate(`/admin/email-templates/${row.id}/edit`) },
            canDelete('Email Template') && { icon: Trash2, label: deleting === row.id ? 'Deleting…' : 'Delete', cls: 'text-red-600 hover:bg-red-50', onClick: () => handleDelete(row.id, row.name) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/admin/email-templates/${row.id}/edit`)}
        emptyMessage="No templates found"
      />
      <div className="hidden sm:block">
        <DataTable persistKey="admin-email-templates"
          exportFileName="email-templates"
          columns={columns}
          data={data || []}
          onRowClick={(row) => navigate(`/admin/email-templates/${row.id}/edit`)}
          isLoading={isLoading}
        />
      </div>
      </ListState>
    </MainLayout>
  );
}

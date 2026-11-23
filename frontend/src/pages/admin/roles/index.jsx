import { useNavigate } from 'react-router-dom';
import { Pencil, Eye, RefreshCw } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import useApiData from '../../../hooks/useApiData.js';
import MobileListCards from '../components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';

export default function AdminRoleList() {
  const navigate = useNavigate();
  const columns = [
    { key: 'name', label: 'Role Name', sortable: true },
    { key: 'code', label: 'Code', sortable: true },
    {
      key: 'description',
      label: 'Description',
      render: (value) => (
        <span className="text-slate-600 text-sm">{value || '-'}</span>
      ),
    },
    {
      key: 'user_count',
      label: 'Users',
      sortable: true,
      render: (value) => (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary-100 text-primary-800">
          {value ?? 0}
        </span>
      ),
    },
    {
      key: 'mfa_required',
      label: '2FA',
      sortable: false,
      // "Required" alone was misleading: MFA_EXEMPT_USERNAMES (an env var)
      // lets named accounts skip the challenge entirely, so a role could
      // read Required while a holder signed in with a password alone and
      // nothing on screen said so. Name the exceptions next to the rule.
      render: (value, row) => {
        const exempt = row.mfa_exempt_count || 0;
        if (!value) return <span className="text-slate-400 text-xs">Optional</span>;
        return (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
              Required
            </span>
            {exempt > 0 && (
              <span
                title={`${exempt} user(s) with this role are listed in MFA_EXEMPT_USERNAMES and sign in `
                  + 'with a password only. Intended for machine accounts such as the Tally connector.'}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200"
              >
                {exempt} exempt
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/admin/roles/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  const { data, isLoading, error, refetch } = useApiData('/api/rbac/roles/');

  return (
    <MainLayout>
      <PageHeader
        title="Roles"
        subtitle="View all system roles and descriptions"
        breadcrumbs={[{ label: 'Admin' }, { label: 'Roles' }]}
        actions={{ createLink: '/admin/roles/new', createLabel: 'Add Role' }}
      />
      <ListState error={error} onRetry={refetch}>
        <MobileListCards
          rows={data}
          isLoading={isLoading}
          config={{
            title: (row) => row.name || row.code || '—',
            subtitle: (row) => row.code,
            badge: (row) => ({
              label: `${row.user_count ?? 0} users`,
              cls: 'bg-primary-50 text-primary-700 border-primary-200',
            }),
            fields: (row) => [
              { label: 'Desc', value: row.description },
              { label: '2FA', value: row.mfa_required
                ? (row.mfa_exempt_count ? `Required - ${row.mfa_exempt_count} exempt` : 'Required')
                : 'Optional' },
            ],
            actions: (row) => [
              { icon: Eye,    label: 'View', cls: 'text-blue-700 hover:bg-blue-50',  onClick: () => navigate(`/admin/roles/${row.id}`) },
              { icon: Pencil, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/admin/roles/${row.id}`) },
            ],
          }}
          onRowClick={(row) => navigate(`/admin/roles/${row.id}`)}
          emptyMessage="No roles found"
        />
        <div className="hidden sm:block">
          <DataTable persistKey="admin-roles"
            exportFileName="admin-roles"
            columns={columns}
            data={data}
            isLoading={isLoading}
            onRowClick={(row) => navigate(`/admin/roles/${row.id}`)}
          />
        </div>
      </ListState>
    </MainLayout>
  );
}

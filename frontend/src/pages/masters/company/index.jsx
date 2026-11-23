import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Eye, Edit, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ActionButtons from '../../../components/common/ActionButtons';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import BulkImportModal from '../../../components/common/BulkImportModal';
import MobileListCards from '../../sales/components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';

export default function CompanyList() {
  const navigate = useNavigate();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ default_currency: '', status: '' });
  const [showImport, setShowImport] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const { canCreate, canEdit, canDelete, canExport, canImport } = usePermissions();

  const filters = [
    {
      key: 'default_currency',
      label: 'Default Currency',
      type: 'select',
      options: [
        { value: 'INR', label: 'INR' },
        { value: 'USD', label: 'USD' },
        { value: 'EUR', label: 'EUR' },
      ],
    },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'Active', label: 'Active' },
        { value: 'Inactive', label: 'Inactive' },
      ],
    },
  ];

  const handleDelete = async (id) => {
    if (!(await confirm({ message: 'Deactivate this company? It will be hidden from the list. Records that reference it stay intact.', isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/companies/${id}/`);
      toast.success('Company deactivated.');
      refetch();
    } catch (err) {
      // Surface the backend's actual reason — usually "referenced by
      // Vendor / Customer / Price List …" so the user knows what's
      // blocking the delete, instead of the old generic toast.
      const msg = err?.response?.data?.error
        || err?.response?.data?.detail
        || 'Failed to delete record';
      toast.error(msg);
    }
  };

  const columns = [
    { key: 'company_code', label: 'Company Code', sortable: true },
    { key: 'legal_name', label: 'Legal Name', sortable: true },
    { key: 'trade_name', label: 'Trade Name', sortable: true },
    { key: 'gstin', label: 'GSTIN', sortable: true },
    { key: 'default_currency', label: 'Default Currency', sortable: true },
    { key: 'active_from', label: 'Active From', sortable: true },
    {
      key: 'is_active',
      label: 'Status',
      render: (value, row) => <StatusBadge status={value ? 'Active' : 'Inactive'} />,
    },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (value, row) => (
        <ActionButtons
          moduleName="Company"
          editPath={`/masters/company/${row.id}/edit`}
          onDelete={(r) => handleDelete(r.id)}
          row={row}
        />
      ),
    },
  ];

  const { data, isLoading, error, refetch } = useApiData('/api/companies/');
  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'company_master_fields', data);

  const filteredData = data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.company_code, row.legal_name, row.trade_name, row.gstin, row.pan, row.default_currency]
        .some(v => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.default_currency, filterValues.default_currency)) {
      return false;
    }
    if (!matchesSelect(row.is_active ? 'Active' : 'Inactive', filterValues.status)) {
      return false;
    }
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Companies"
        subtitle="Manage company master records"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Companies' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Company') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Company') ? { createLink: '/masters/company/new', createLabel: 'Add Company' } : {}),
        }}
      />
      {showFilters && (
        <FilterPanel
          filters={filters}
          values={filterValues}
          onChange={(key, value) => setFilterValue(key, value)}
          onReset={clearFilters}
          onClose={() => setShowFilters(false)}
        />
      )}
      <ListState error={error} onRetry={refetch}>
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search companies…"
        emptyMessage="No companies found"
        config={{
          title: (row) => row.company_code || '—',
          subtitle: (row) => row.legal_name,
          badge: (row) => ({
            label: row.is_active === false ? 'Inactive' : 'Active',
            cls: row.is_active === false
              ? 'bg-slate-100 text-slate-600 border-slate-200'
              : 'bg-emerald-50 text-emerald-700 border-emerald-200',
          }),
          fields: (row) => [
            { label: 'Trade',    value: row.trade_name },
            { label: 'GSTIN',    value: row.gstin },
            { label: 'Currency', value: row.default_currency },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/company/${row.id}`) },
            canEdit('Company') && { icon: Edit, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/company/${row.id}/edit`) },
            canDelete('Company') && { icon: Trash2, label: 'Delete', cls: 'text-red-600 hover:bg-red-50', onClick: () => handleDelete(row.id) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/masters/company/${row.id}`)}
      />

      <div className="hidden sm:block">
        <DataTable
          persistKey="companies"
          exportFileName="companies"
          canExport={canExport('Company')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onSearch={setSearchTerm}
          searchPlaceholder="Search companies…"
          onRowClick={(row) => navigate(`/masters/company/${row.id}`)}
        />
      </div>
      </ListState>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="company_master_fields" />}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Companies"
        endpoint="/api/companies/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}

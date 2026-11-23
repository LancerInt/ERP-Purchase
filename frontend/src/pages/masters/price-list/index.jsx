import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import { Pencil, Trash2, Eye } from 'lucide-react';
import toast from 'react-hot-toast';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { exportServerSide } from '../../../utils/exportExcel.js';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import BulkImportModal from '../../../components/common/BulkImportModal';
import MobileListCards from '../../sales/components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';

export default function PriceListPage() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canExport, canImport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ company: '', status: '', customer: '' });
  const [showImport, setShowImport] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const { options: companiesRaw } = useLookup('/api/companies/', { labelField: 'legal_name' });
  const companyOptions = companiesRaw
    .map(c => ({ value: c.label, label: c.label }))
    .filter(c => c.value);

  const filters = [
    {
      key: 'company',
      label: 'Company',
      type: 'select',
      options: companyOptions,
    },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      // Values MUST be the model's stored status codes (uppercase), not the
      // display labels — the list filters client-side with
      // `row.status !== filterValues.status`, and PriceList.status is
      // 'DRAFT'/'ACTIVE'/'ARCHIVED'. Using 'Active' here matched nothing and
      // made the Active filter wipe the whole list ("No data found").
      options: [
        { value: 'DRAFT', label: 'Draft' },
        { value: 'ACTIVE', label: 'Active' },
        { value: 'ARCHIVED', label: 'Archived' },
      ],
    },
    { key: 'customer', label: 'Customer', type: 'text', placeholder: 'Filter by customer...' },
  ];

  const columns = [
    { key: 'price_list_id', label: 'Price List ID', sortable: true },
    { key: 'company_name', label: 'Company', sortable: true, render: (v, row) => v || row.company_name || '-' },
    { key: 'customer_name', label: 'Customer', sortable: true, render: (v, row) => v || row.customer_name || '-' },
    { key: 'currency', label: 'Currency', sortable: true },
    { key: 'effective_from', label: 'Effective From', sortable: true },
    { key: 'effective_to', label: 'Effective To', sortable: true },
    {
      key: 'status',
      label: 'Status',
      // Show the REAL status field (DRAFT/ACTIVE/ARCHIVED) — this drives
      // whether a price list is usable (for_customer only serves ACTIVE
      // ones). The old badge rendered `is_active`, so a DRAFT list showed
      // a green "Active" pill and looked usable when it wasn't. Only a
      // soft-deleted row (is_active===false, seen with show_all) shows
      // "Inactive".
      render: (value, row) => <StatusBadge status={row.is_active === false ? 'INACTIVE' : (value || 'DRAFT')} />,
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/masters/price-list/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
            title="Edit"
          >
            <Pencil size={15} />
          </button>
          {canDelete('Price List') && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(row.id, row.price_list_id); }}
              className="p-1.5 text-red-500 hover:bg-red-50 rounded transition"
              title="Delete"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  const { data, isLoading, error, refetch } = useApiData('/api/price-lists/');
  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'price_list_master_fields', data);

  // Backend-driven export — flattens each price list's child price_lines
  // into the same sheet (one row per line). Replaces the client-side
  // export that only saw list-row keys and dropped subform rows entirely.
  // `rows` is the DataTable's on-screen (filtered) set; the backend scopes
  // the export to those ids so it matches what the user is looking at.
  const handleExport = async (rows) => {
    try {
      await exportServerSide('/api/price-lists/export/', rows, 'price-lists');
    } catch (err) {
      toast.error('Export failed');
    }
  };

  const handleDelete = async (id, name) => {
    if (!(await confirm({ message: `Delete price list "${name}"? This cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/price-lists/${id}/`);
      toast.success(`Price list "${name}" deleted`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const filteredData = data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.price_list_id, row.company_name, row.customer_name, row.currency, row.status]
        .some(v => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.company_name, filterValues.company)) return false;
    if (!matchesSelect(row.status, filterValues.status)) return false;
    if (filterValues.customer) {
      const customerSearch = filterValues.customer.toLowerCase();
      if (!(row.customer_name || '').toLowerCase().includes(customerSearch)) return false;
    }
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Price Lists"
        subtitle="Manage customer price lists and pricing"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Price Lists' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Price List') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Price List') ? { createLink: '/masters/price-list/new', createLabel: 'Add Price List' } : {}),
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
        searchPlaceholder="Search price lists…"
        emptyMessage="No price lists found"
        config={{
          title: (row) => row.price_list_id || '—',
          subtitle: (row) => row.customer_name || row.company_name || '',
          badge: (row) => {
            const status = row.is_active === undefined ? row.status : (row.is_active ? 'Active' : 'Inactive');
            const cls = status === 'Active'
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : status === 'Draft'
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-slate-100 text-slate-600 border-slate-200';
            return { label: status || '—', cls };
          },
          fields: (row) => [
            { label: 'Company',   value: row.company_name },
            { label: 'Currency',  value: row.currency },
            { label: 'From',      value: row.effective_from },
            { label: 'To',        value: row.effective_to },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/price-list/${row.id}`) },
            canEdit('Price List') && { icon: Pencil, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/price-list/${row.id}`) },
            canDelete('Price List') && { icon: Trash2, label: 'Delete', cls: 'text-red-700 hover:bg-red-50', onClick: () => handleDelete(row.id, row.price_list_id) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/masters/price-list/${row.id}`)}
      />

      <div className="hidden sm:block">
        <DataTable
          persistKey="price-lists"
          exportFileName="price-lists"
          canExport={canExport('Price List')}
          onExport={handleExport}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onSearch={setSearchTerm}
          searchPlaceholder="Search price lists…"
          onRowClick={(row) => navigate(`/masters/price-list/${row.id}`)}
        />
      </div>
      </ListState>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="price_list_master_fields" />}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Price Lists"
        endpoint="/api/price-lists/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}

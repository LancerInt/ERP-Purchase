import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Pencil, Eye, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import BulkImportModal from '../../../components/common/BulkImportModal';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';
import {
  MobileListCard, MobileSearchBar, MobileCardSkeleton,
} from '../../../components/mobile';

export default function MachineryExpenseList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canExport, canImport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ company_name: '', warehouse_name: '', category_name: '', status: '' });
  const [searchTerm, setSearchTerm] = useState('');
  const [showImport, setShowImport] = useState(false);

  const { data, isLoading, error, refetch } = useApiData('/api/machinery-expenses/');

  // Real column filters (the page already has its own search bar, so a
  // "Search by name" filter here was just a duplicate). Options are derived
  // from the loaded rows so they always match what's actually present.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    { key: 'company_name',   label: 'Company',   type: 'select', options: optsFrom('company_name') },
    { key: 'warehouse_name', label: 'Warehouse', type: 'select', options: optsFrom('warehouse_name') },
    { key: 'category_name',  label: 'Category',  type: 'select', options: optsFrom('category_name') },
    { key: 'status', label: 'Status', type: 'select',
      options: [{ value: 'Active', label: 'Active' }, { value: 'Inactive', label: 'Inactive' }] },
  ];

  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Deactivate Expense "${row.name}"?`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/machinery-expenses/${row.id}/`);
      toast.success('Expense deactivated');
      refetch();
    } catch { toast.error('Failed to deactivate'); }
  };

  const columns = [
    { key: 'name', label: 'Expense', sortable: true },
    { key: 'company_name',   label: 'Company',   sortable: true, render: (v) => v || '—' },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true, render: (v) => v || '—' },
    { key: 'category_name', label: 'Category', sortable: true, render: (v) => v || '—' },
    {
      key: 'is_active', label: 'Status',
      render: (v) => <StatusBadge status={v === false ? 'Inactive' : 'Active'} />,
    },
    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/masters/machinery-expense/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } =
    useConfigureFields(columns, 'machinery_expense_master_fields', data);

  const filteredData = useMemo(() => data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.name, row.company_name, row.warehouse_name, row.category_name]
        .some((v) => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.company_name, filterValues.company_name)) return false;
    if (!matchesSelect(row.warehouse_name, filterValues.warehouse_name)) return false;
    if (!matchesSelect(row.category_name, filterValues.category_name)) return false;
    if (!matchesSelect(row.is_active === false ? 'Inactive' : 'Active', filterValues.status)) return false;
    return true;
  }), [data, searchTerm, filterValues.company_name, filterValues.warehouse_name, filterValues.category_name, filterValues.status]);

  const cardConfig = (row) => ({
    title: row.name || '—',
    subtitle: [row.company_name, row.warehouse_name].filter(Boolean).join(' · '),
    badge: { label: 'Expense', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    fields: [
      { label: 'Company',   value: row.company_name },
      { label: 'Warehouse', value: row.warehouse_name },
      { label: 'Category',  value: row.category_name },
    ],
    actions: [
      { icon: Eye,    label: 'View',   cls: 'text-blue-700 active:bg-blue-50',   onClick: () => navigate(`/masters/machinery-expense/${row.id}`) },
      canEdit('Machinery Expense')   && { icon: Pencil, label: 'Edit',   cls: 'text-slate-700 active:bg-slate-100', onClick: () => navigate(`/masters/machinery-expense/${row.id}`) },
      canDelete('Machinery Expense') && { icon: Trash2, label: 'Delete', cls: 'text-red-700 active:bg-red-50',    onClick: () => handleDelete(row) },
    ].filter(Boolean),
  });

  return (
    <MainLayout>
      <PageHeader
        title="Machinery Expense"
        subtitle="Expense buckets rolled up under a single Expense Category"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Machinery Expense' },
        ]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Machinery Expense') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Machinery Expense') ? { createLink: '/masters/machinery-expense/new', createLabel: 'Add Expense' } : {}),
        }}
      />

      {showFilters && (
        <FilterPanel
          filters={filters} values={filterValues}
          onChange={(key, value) => setFilterValue(key, value)}
          onReset={clearFilters}
          onClose={() => setShowFilters(false)}
        />
      )}
      <ListState error={error} onRetry={refetch}>
        <div className="sm:hidden space-y-3 pb-24">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3 sticky top-2 z-10">
            <MobileSearchBar value={searchTerm} onChange={setSearchTerm} placeholder="Search expenses…" />
          </div>
          {isLoading && <MobileCardSkeleton count={4} />}
          {!isLoading && filteredData.length === 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
              <p className="text-[15px] font-medium text-slate-700">No expenses found</p>
              <p className="text-[13px] text-slate-500 mt-1">Add your first Expense to get started.</p>
            </div>
          )}
          {!isLoading && filteredData.map((row) => {
            const cfg = cardConfig(row);
            return (
              <MobileListCard
                key={row.id}
                title={cfg.title} subtitle={cfg.subtitle} badge={cfg.badge}
                fields={cfg.fields} actions={cfg.actions}
                avatarSeed={row.name}
                onClick={() => navigate(`/masters/machinery-expense/${row.id}`)}
              />
            );
          })}
        </div>

        <div className="hidden sm:block">
          <DataTable
            persistKey="machinery-expenses"
            exportFileName="machinery-expenses"
            canExport={canExport('Machinery Expense')}
            columns={visibleColumns} data={filteredData}
            isLoading={isLoading}
            onRowClick={(row) => navigate(`/masters/machinery-expense/${row.id}`)}
          />
        </div>
      </ListState>

      {showConfig && (
        <ConfigureFields
          allColumns={mergedColumns} visibleFields={visibleFieldKeys}
          onApply={handleConfigApply} onClose={() => setShowConfig(false)}
          storageKey="machinery_expense_master_fields"
        />
      )}

      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Machinery Expenses"
        endpoint="/api/machinery-expenses/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}

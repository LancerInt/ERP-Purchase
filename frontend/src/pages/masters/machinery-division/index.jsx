import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Pencil, Eye, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
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

export default function MachineryDivisionList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canExport, canImport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ company_name: '', warehouse_name: '', godown_name: '', status: '' });
  const [searchTerm, setSearchTerm] = useState('');
  const [showImport, setShowImport] = useState(false);

  const { data, isLoading, error, refetch } = useApiData('/api/machinery-divisions/');

  // Real column filters (the page already has its own search bar, so a
  // "Search by name" filter here was just a duplicate). Options are derived
  // from the loaded rows so they always match what's actually present.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    { key: 'company_name',   label: 'Company',   type: 'select', options: optsFrom('company_name') },
    { key: 'warehouse_name', label: 'Warehouse', type: 'select', options: optsFrom('warehouse_name') },
    { key: 'godown_name',    label: 'Godown',    type: 'select', options: optsFrom('godown_name') },
    { key: 'status', label: 'Status', type: 'select',
      options: [{ value: 'Active', label: 'Active' }, { value: 'Inactive', label: 'Inactive' }] },
  ];

  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Deactivate Division "${row.name}"?`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/machinery-divisions/${row.id}/`);
      toast.success('Division deactivated');
      refetch();
    } catch { toast.error('Failed to deactivate'); }
  };

  const columns = [
    { key: 'name', label: 'Division', sortable: true },
    { key: 'company_name',   label: 'Company',   sortable: true, render: (v) => v || '—' },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true, render: (v) => v || '—' },
    { key: 'godown_name',    label: 'Godown',    sortable: true, render: (v) => v || '—' },
    {
      key: 'is_active', label: 'Status',
      render: (v) => <StatusBadge status={v === false ? 'Inactive' : 'Active'} />,
    },
    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/masters/machinery-division/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } =
    useConfigureFields(columns, 'machinery_division_master_fields', data);

  const filteredData = useMemo(() => data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.name, row.company_name, row.warehouse_name, row.godown_name]
        .some((v) => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.company_name, filterValues.company_name)) return false;
    if (!matchesSelect(row.warehouse_name, filterValues.warehouse_name)) return false;
    if (!matchesSelect(row.godown_name, filterValues.godown_name)) return false;
    if (!matchesSelect(row.is_active === false ? 'Inactive' : 'Active', filterValues.status)) return false;
    return true;
  }), [data, searchTerm, filterValues.company_name, filterValues.warehouse_name, filterValues.godown_name, filterValues.status]);

  // Mobile pagination — show 20 cards per page with Prev/Next instead of
  // rendering the whole list (mirrors the desktop table's paging).
  const MOBILE_PAGE_SIZE = 20;
  const [mobilePage, setMobilePage] = useState(1);
  const mobileTotalPages = Math.max(1, Math.ceil(filteredData.length / MOBILE_PAGE_SIZE));
  // Snap back to page 1 whenever the result set changes (search/filter)
  // so we never get stranded on a now-empty page.
  useEffect(() => { setMobilePage(1); }, [searchTerm, filterValues.company_name, filterValues.warehouse_name, filterValues.godown_name, filterValues.status, data]);
  const mobilePageData = filteredData.slice(
    (mobilePage - 1) * MOBILE_PAGE_SIZE,
    mobilePage * MOBILE_PAGE_SIZE,
  );

  const cardConfig = (row) => ({
    title: row.name || '—',
    subtitle: [row.company_name, row.warehouse_name].filter(Boolean).join(' · '),
    badge: { label: 'Division', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
    fields: [
      { label: 'Company',   value: row.company_name },
      { label: 'Warehouse', value: row.warehouse_name },
      { label: 'Godown',    value: row.godown_name },
    ],
    actions: [
      { icon: Eye,    label: 'View',   cls: 'text-blue-700 active:bg-blue-50',   onClick: () => navigate(`/masters/machinery-division/${row.id}`) },
      canEdit('Machinery Division')   && { icon: Pencil, label: 'Edit',   cls: 'text-slate-700 active:bg-slate-100', onClick: () => navigate(`/masters/machinery-division/${row.id}`) },
      canDelete('Machinery Division') && { icon: Trash2, label: 'Delete', cls: 'text-red-700 active:bg-red-50',    onClick: () => handleDelete(row) },
    ].filter(Boolean),
  });

  return (
    <MainLayout>
      <PageHeader
        title="Machinery Division"
        subtitle="Departments / production lines / regions attached to a machinery location"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Machinery Division' },
        ]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Machinery Division') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Machinery Division') ? { createLink: '/masters/machinery-division/new', createLabel: 'Add Division' } : {}),
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
          <MobileSearchBar value={searchTerm} onChange={setSearchTerm} placeholder="Search divisions…" />
        </div>
        {isLoading && <MobileCardSkeleton count={4} />}
        {!isLoading && filteredData.length === 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
            <p className="text-[15px] font-medium text-slate-700">No divisions found</p>
            <p className="text-[13px] text-slate-500 mt-1">Add your first Division to get started.</p>
          </div>
        )}
        {!isLoading && filteredData.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              {mobilePageData.map((row) => {
                const cfg = cardConfig(row);
                return (
                  <MobileListCard
                    key={row.id}
                    title={cfg.title} subtitle={cfg.subtitle} badge={cfg.badge}
                    fields={cfg.fields} actions={cfg.actions}
                    avatarSeed={row.name}
                    onClick={() => navigate(`/masters/machinery-division/${row.id}`)}
                  />
                );
              })}
            </div>
            {mobileTotalPages > 1 && (
              <div className="flex items-center justify-between gap-2 bg-white rounded-2xl border border-slate-200 shadow-sm px-3 py-2">
                <button
                  type="button"
                  onClick={() => setMobilePage((p) => Math.max(1, p - 1))}
                  disabled={mobilePage <= 1}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[13px] font-medium text-slate-700 active:bg-slate-100 disabled:opacity-40 disabled:active:bg-transparent"
                >
                  <ChevronLeft size={16} /> Prev
                </button>
                <span className="text-[12px] text-slate-500">
                  Page {mobilePage} of {mobileTotalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setMobilePage((p) => Math.min(mobileTotalPages, p + 1))}
                  disabled={mobilePage >= mobileTotalPages}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[13px] font-medium text-slate-700 active:bg-slate-100 disabled:opacity-40 disabled:active:bg-transparent"
                >
                  Next <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="hidden sm:block">
        <DataTable
          persistKey="machinery-divisions"
          exportFileName="machinery-divisions"
          canExport={canExport('Machinery Division')}
          columns={visibleColumns} data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/masters/machinery-division/${row.id}`)}
        />
      </div>
      </ListState>

      {showConfig && (
        <ConfigureFields
          allColumns={mergedColumns} visibleFields={visibleFieldKeys}
          onApply={handleConfigApply} onClose={() => setShowConfig(false)}
          storageKey="machinery_division_master_fields"
        />
      )}

      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Machinery Divisions"
        endpoint="/api/machinery-divisions/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}

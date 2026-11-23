import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import { Pencil, Eye } from 'lucide-react';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import BulkImportModal from '../../../components/common/BulkImportModal';
import MobileListCards from '../../sales/components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';

export default function TaxMasterList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canExport, canImport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ tax_type: '', applicable_on: '' });
  const [showImport, setShowImport] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const { data, isLoading, error, refetch } = useApiData('/api/taxes/');

  // `applicable_on` is a JSON LIST on each row — derive the dropdown from the
  // distinct values actually present so the option value matches what's stored
  // (a scalar equality check against a list never matched a thing).
  const applicableOnOptions = (() => {
    const seen = new Set();
    for (const r of (data || [])) {
      const arr = Array.isArray(r.applicable_on) ? r.applicable_on : (r.applicable_on ? [r.applicable_on] : []);
      arr.forEach(v => { const s = String(v).trim(); if (s) seen.add(s); });
    }
    return [...seen].sort().map(v => ({ value: v, label: v }));
  })();

  const filters = [
    {
      key: 'tax_type',
      label: 'Tax Type',
      type: 'select',
      options: [
        { value: 'GST', label: 'GST' },
        { value: 'TDS', label: 'TDS' },
        { value: 'TCS', label: 'TCS' },
      ],
    },
    {
      key: 'applicable_on',
      label: 'Applicable On',
      type: 'select',
      single: true,
      options: applicableOnOptions,
    },
  ];

  const columns = [
    { key: 'tax_type', label: 'Tax Type', sortable: true },
    { key: 'section_reference', label: 'Section Reference', sortable: true },
    { key: 'rate', label: 'Rate (%)', sortable: true },
    { key: 'effective_from', label: 'Effective From', sortable: true },
    { key: 'effective_to', label: 'Effective To', sortable: true },
    { key: 'applicable_on', label: 'Applicable On', sortable: true },
    { key: 'company_scope', label: 'Company Scope', sortable: true },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/masters/tax/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'tax_master_fields', data);

  const filteredData = data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.tax_type, row.section_reference, row.rate, row.applicable_on, row.company_scope]
        .some(v => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.tax_type, filterValues.tax_type)) return false;
    if (filterValues.applicable_on) {
      const arr = Array.isArray(row.applicable_on) ? row.applicable_on : (row.applicable_on ? [row.applicable_on] : []);
      if (!arr.map(String).includes(filterValues.applicable_on)) return false;
    }
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Tax Master"
        subtitle="Manage tax configurations and rates"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Tax Master' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Tax') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Tax') ? { createLink: '/masters/tax/new', createLabel: 'Add Tax Rule' } : {}),
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
        searchPlaceholder="Search taxes…"
        emptyMessage="No tax rules found"
        config={{
          title: (row) => `${row.tax_type || '—'}${row.section_reference ? ` · ${row.section_reference}` : ''}`,
          subtitle: (row) => row.applicable_on || '',
          badge: (row) => ({
            label: row.rate != null ? `${row.rate}%` : '—',
            cls: 'bg-blue-50 text-blue-700 border-blue-200',
          }),
          fields: (row) => [
            { label: 'From',  value: row.effective_from },
            { label: 'To',    value: row.effective_to },
            { label: 'Scope', value: row.company_scope },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/tax/${row.id}`) },
            canEdit('Tax') && { icon: Pencil, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/tax/${row.id}`) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/masters/tax/${row.id}`)}
      />

      <div className="hidden sm:block">
        <DataTable
          persistKey="tax-masters"
          exportFileName="tax-masters"
          canExport={canExport('Tax Master')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onSearch={setSearchTerm}
          searchPlaceholder="Search taxes…"
          onRowClick={(row) => navigate(`/masters/tax/${row.id}`)}
        />
      </div>
      </ListState>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="tax_master_fields" />}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Tax Master"
        endpoint="/api/taxes/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}

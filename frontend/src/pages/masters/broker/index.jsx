import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ActionButtons from '../../../components/common/ActionButtons';
import useApiData from '../../../hooks/useApiData.js';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import MobileListCards from '../../sales/components/MobileListCards';
import { Pencil, Eye, Trash2 } from 'lucide-react';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';

/**
 * Broker Master — list page.
 *
 * Shows every broker created so far with search/filter/export.
 * Row click → detail (currently routes to the form for now — list+edit
 * will be wired up later if you want a separate detail page).
 */

const BROKER_TYPE_OPTIONS = [
  { value: 'PURCHASE',   label: 'Purchase Broker' },
  { value: 'SALES',      label: 'Sales Broker' },
  { value: 'FREIGHT',    label: 'Freight Broker' },
  { value: 'EXPORT',     label: 'Export Agent' },
  { value: 'IMPORT',     label: 'Import Agent' },
  { value: 'COMMISSION', label: 'Commission Agent' },
];

export default function BrokerList() {
  const navigate = useNavigate();
  const { canEdit, canDelete, canExport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ broker_type: '', status: '' });
  const [searchTerm, setSearchTerm] = useState('');

  const { data, isLoading, error, refetch } = useApiData('/api/brokers/');

  const filters = [
    { key: 'broker_type', label: 'Broker Type', type: 'select', options: BROKER_TYPE_OPTIONS },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'ACTIVE', label: 'Active' },
        { value: 'INACTIVE', label: 'Inactive' },
      ],
    },
  ];

  const handleDelete = async (id) => {
    if (!(await confirm({ message: 'Delete this broker? This cannot be undone.', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/brokers/${id}/`);
      toast.success('Broker deleted');
      refetch();
    } catch (err) {
      toast.error('Failed to delete broker');
    }
  };

  const columns = [
    { key: 'broker_code', label: 'Broker Code', sortable: true },
    { key: 'broker_name', label: 'Broker Name', sortable: true },
    { key: 'broker_type_display', label: 'Broker Type', sortable: true },
    { key: 'contact_person', label: 'Contact Person', sortable: true },
    { key: 'mobile_number', label: 'Mobile', sortable: true },
    {
      key: 'commission_type_display',
      label: 'Commission',
      sortable: false,
      render: (_, row) => {
        const sym = row.commission_type === 'PERCENTAGE' ? '%' : '₹';
        const val = row.commission_value || 0;
        return `${sym === '₹' ? '₹' : ''}${val}${sym === '%' ? '%' : ''}`;
      },
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (value) => <StatusBadge status={value === 'INACTIVE' ? 'Inactive' : 'Active'} />,
    },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (_, row) => (
        <ActionButtons
          moduleName="Broker"
          editPath={`/masters/broker/${row.id}/edit`}
          onDelete={(r) => handleDelete(r.id)}
          row={row}
        />
      ),
    },
  ];

  // Client-side filtering — matches how Vendor list does it.
  const filteredData = (data || []).filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const haystack = `${row.broker_code} ${row.broker_name} ${row.contact_person} ${row.mobile_number} ${row.email}`.toLowerCase();
      if (!haystack.includes(s)) return false;
    }
    if (!matchesSelect(row.broker_type, filterValues.broker_type)) return false;
    if (!matchesSelect(row.status, filterValues.status)) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Brokers"
        subtitle="Manage broker / agent records"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Brokers' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          createLink: '/masters/broker/new',
          createLabel: 'Add Broker',
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
        searchPlaceholder="Search brokers…"
        emptyMessage="No brokers yet. Click Add Broker to create one."
        config={{
          title: (row) => row.broker_code || '—',
          subtitle: (row) => row.broker_name,
          badge: (row) => ({
            label: row.status === 'INACTIVE' ? 'Inactive' : 'Active',
            cls: row.status === 'INACTIVE'
              ? 'bg-slate-100 text-slate-600 border-slate-200'
              : 'bg-emerald-50 text-emerald-700 border-emerald-200',
          }),
          fields: (row) => [
            { label: 'Type',       value: row.broker_type_display },
            { label: 'Contact',    value: row.contact_person },
            { label: 'Mobile',     value: row.mobile_number },
            { label: 'Commission', value: row.commission_type === 'PERCENTAGE'
                ? `${row.commission_value || 0}%`
                : `₹${row.commission_value || 0}` },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/broker/${row.id}/edit`) },
            canEdit('Broker') && { icon: Pencil, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/broker/${row.id}/edit`) },
            canDelete('Broker') && { icon: Trash2, label: 'Delete', cls: 'text-red-700 hover:bg-red-50', onClick: () => handleDelete(row.id) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/masters/broker/${row.id}/edit`)}
      />

      <div className="hidden sm:block">
        {!isLoading && !error && filteredData.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            No brokers yet. Click <span className="font-medium text-primary-600">Add Broker</span> to create one.
          </div>
        )}
        {!isLoading && !error && filteredData.length > 0 && (
          <DataTable
            persistKey="brokers"
            exportFileName="brokers"
            canExport={canExport('Broker')}
            columns={columns}
            data={filteredData}
            onSearch={setSearchTerm}
            searchPlaceholder="Search brokers…"
            onRowClick={(row) => navigate(`/masters/broker/${row.id}/edit`)}
          />
        )}
      </div>
      </ListState>
    </MainLayout>
  );
}

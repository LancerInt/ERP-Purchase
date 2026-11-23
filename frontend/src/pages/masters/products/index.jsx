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
import useLookup from '../../../hooks/useLookup.js';
import ListState from '../../../components/common/ListState.jsx';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import BulkImportModal from '../../../components/common/BulkImportModal';
import MobileListCards from '../../sales/components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

// A product's goods_sub_type is only meaningful within its Type, so the Sub
// Type filter must offer only the sub-types that belong to the chosen Type
// (Services have none). Canonical labels + display order; the options actually
// shown are intersected with what occurs in the data.
const SUB_TYPE_LABELS = {
  RAW_MATERIAL: 'Raw Material', PACKING_MATERIAL: 'Packing Material',
  FINISHED_GOOD: 'Finished Good', SEMI_FINISHED: 'Semi Finished',
  TRADED_PRODUCTS: 'Traded Products', CAPITAL_GOOD: 'Capital Good',
  MACHINE_SPARES: 'Machine Spares', CONSUMABLES: 'Consumables',
};
const SUB_TYPE_ORDER = Object.keys(SUB_TYPE_LABELS);

export default function ProductList() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useApiData('/api/products/');
  const { canCreate, canEdit, canDelete, canExport, canImport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ product_type: '', goods_sub_type: '', company: '', warehouse: '', godown: '' });
  const [showImport, setShowImport] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const handleDelete = async (id) => {
    if (!(await confirm({ message: 'Deactivate this product? It will be hidden from the list. Existing POs / DCs / invoices that reference it stay intact.', isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/products/${id}/`);
      toast.success('Product deactivated.');
      refetch();
    } catch (err) {
      // Surface the backend's actual reason (e.g. PROTECT constraint)
      // instead of the old generic toast.
      const msg = err?.response?.data?.error
        || err?.response?.data?.detail
        || 'Failed to delete product';
      toast.error(msg);
    }
  };

  // Location filters — cascade Company → Warehouse → Godown, mirroring the
  // product form's own pickers (same endpoints). With no Company chosen the
  // warehouse list is unscoped; Godown only lists once a Warehouse is picked.
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: warehouseOptions } = useLookup(
    filterValues.company ? `/api/warehouses/?company=${filterValues.company}` : '/api/warehouses/'
  );
  const { options: godownOptions } = useLookup(
    filterValues.warehouse ? `/api/godowns/?warehouse=${filterValues.warehouse}` : null
  );

  // Sub Type options are scoped to the selected Type: goods_sub_type is only
  // meaningful within a Type, so the filter offers only the sub-types that
  // actually occur for the chosen Type (Services have none). Derived from the
  // loaded data — useApiData fetches every page, so this list is complete.
  const subTypeOptions = (() => {
    const present = new Set();
    (data || []).forEach((row) => {
      // Type is multi-select: offer sub-types occurring under ANY chosen Type.
      if (!matchesSelect(row.product_type, filterValues.product_type)) return;
      if (row.goods_sub_type) present.add(row.goods_sub_type);
    });
    return SUB_TYPE_ORDER
      .filter((v) => present.has(v))
      .map((v) => ({ value: v, label: SUB_TYPE_LABELS[v] }));
  })();

  const filters = [
    {
      key: 'product_type', label: 'Type', type: 'select',
      options: [
        { value: 'GOODS', label: 'Goods' },
        { value: 'SERVICES', label: 'Services' },
        { value: 'MACHINERY', label: 'Machinery' },
      ],
    },
    // Sub Type only makes sense where the chosen Type actually has sub-types.
    // Services carry none, so the filter is dropped entirely rather than shown
    // as an empty "All"-only dropdown.
    ...(subTypeOptions.length > 0
      ? [{ key: 'goods_sub_type', label: 'Sub Type', type: 'select', options: subTypeOptions }]
      : []),
    // Cascade parents stay single-select: each value feeds the next dropdown's
    // API request (company → warehouses → godowns), which takes one id.
    { key: 'company', label: 'Company', type: 'select', options: companyOptions, single: true },
    { key: 'warehouse', label: 'Warehouse', type: 'select', options: warehouseOptions, single: true },
    { key: 'godown', label: 'Godown', type: 'select', options: godownOptions, single: true },
  ];

  const columns = [
    { key: 'sku_code', label: 'SKU Code', sortable: true },
    { key: 'product_name', label: 'Product Name', sortable: true },
    { key: 'product_type', label: 'Type', sortable: true },
    { key: 'goods_sub_type', label: 'Sub Type', sortable: true, render: (value) => value || '-' },
    // Location mirrors the create form's cascade: Company → Warehouse → Godown.
    // Machinery/Services carry godown + division; Goods carry neither, so those
    // cells render '-'.
    { key: 'company_name', label: 'Company', sortable: true, render: (v) => v || '-' },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true, render: (v) => v || '-' },
    { key: 'godown_name', label: 'Godown', sortable: true, render: (v) => v || '-' },
    { key: 'division_name', label: 'Division', sortable: true, render: (v) => v || '-' },
    { key: 'uom', label: 'UOM', sortable: true },
    { key: 'created_at', label: 'Created', sortable: true, render: (v) => (v ? formatDate(v) : '-') },
    {
      key: 'is_active', label: 'Status', sortable: true,
      render: (value) => <StatusBadge status={value !== false ? 'Active' : 'Inactive'} />,
    },
    {
      key: 'actions', label: 'Actions', sortable: false,
      render: (value, row) => (
        <ActionButtons moduleName="Product" editPath={`/masters/products/${row.id}/edit`} onDelete={() => handleDelete(row.id)} row={row} />
      ),
    },
  ];

  // Storage key bumped on each new column so it shows for users who already
  // had a saved column preference (which wouldn't include the new columns):
  // _v2 added Warehouse / Godown / Division / Created; _v3 added Company.
  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'product_master_fields_v3', data);

  const filteredData = (data || []).filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.sku_code, row.product_name, row.product_type, row.goods_sub_type, row.uom, row.hsn_code]
        .some(v => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.product_type, filterValues.product_type)) return false;
    if (!matchesSelect(row.goods_sub_type, filterValues.goods_sub_type)) return false;
    // Location filters match on the FK id (the *_name fields render
    // inconsistently across serializers, so names are not a safe key).
    if (!matchesSelect(row.company, filterValues.company)) return false;
    if (!matchesSelect(row.warehouse, filterValues.warehouse)) return false;
    if (!matchesSelect(row.godown, filterValues.godown)) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Products"
        subtitle="Manage product and service master data"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Products' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Product') ? { onImport: () => setShowImport(true) } : {}),
          // Export lives in the DataTable toolbar (green Export, next to Print);
          // the header no longer duplicates it.
          ...(canCreate('Product') ? { createLink: '/masters/products/new', createLabel: 'New Product' } : {}),
        }}
      />
      {showFilters && (
        <FilterPanel
          filters={filters}
          values={filterValues}
          onChange={(key, value) => {
            setFilterValue(key, value);
            // Sub Type is scoped to Type — clear a now-invalid sub-type when
            // the Type changes so a stale value can't hide every row.
            if (key === 'product_type') setFilterValue('goods_sub_type', '');
            // Location cascade: a warehouse/godown from the previous company
            // (or warehouse) can't match anything under the new one.
            if (key === 'company') { setFilterValue('warehouse', ''); setFilterValue('godown', ''); }
            if (key === 'warehouse') setFilterValue('godown', '');
          }}
          onReset={clearFilters}
          onClose={() => setShowFilters(false)}
        />
      )}
      <ListState error={error} onRetry={refetch} errorMessage="We couldn’t load products.">
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search products…"
        emptyMessage="No products found"
        config={{
          title: (row) => row.sku_code || '—',
          subtitle: (row) => row.product_name,
          badge: (row) => ({
            label: row.product_type || 'GOODS',
            cls: row.product_type === 'SERVICES'
              ? 'bg-purple-50 text-purple-700 border-purple-200'
              : row.product_type === 'MACHINERY'
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-blue-50 text-blue-700 border-blue-200',
          }),
          fields: (row) => [
            { label: 'Sub Type',  value: row.goods_sub_type },
            { label: 'Company',   value: row.company_name },
            { label: 'Warehouse', value: row.warehouse_name },
            { label: 'Godown',    value: row.godown_name },
            { label: 'Division',  value: row.division_name },
            { label: 'UOM',       value: row.uom },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/products/${row.id}`) },
            canEdit('Product') && { icon: Edit, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/products/${row.id}`) },
            canDelete('Product') && { icon: Trash2, label: 'Delete', cls: 'text-red-600 hover:bg-red-50', onClick: () => handleDelete(row.id) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/masters/products/${row.id}`)}
      />

      <div className="hidden sm:block">
        <DataTable
          persistKey="products"
          exportFileName="products"
          canExport={canExport('Product')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onSearch={setSearchTerm}
          searchPlaceholder="Search products…"
          onRowClick={(row) => navigate(`/masters/products/${row.id}`)}
        />
      </div>
      </ListState>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="product_master_fields_v3" />}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Products"
        endpoint="/api/products/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}

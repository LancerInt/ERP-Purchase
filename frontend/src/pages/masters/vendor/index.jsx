import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Eye, Edit, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import TallyImportButton from '../../../components/common/TallyImportButton';
import { matchesSelect } from '../../../components/common/FilterPanel';
import CustomSelect from '@/components/ui/CustomSelect';
import { CTRL_ROW, CTRL_FIELD } from '@/components/common/controls';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ActionButtons from '../../../components/common/ActionButtons';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import BulkImportModal from '../../../components/common/BulkImportModal';
import MobileListCards from '../../sales/components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';
import { VENDOR_TYPE_OPTIONS } from '../../../constants/vendorTypes.js';

const VENDOR_TYPE_LABELS = Object.fromEntries(VENDOR_TYPE_OPTIONS.map(o => [o.value, o.label]));
const asTypeList = (vt) => (Array.isArray(vt) ? vt : (vt ? [vt] : []));
const titleCase = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s);

// Small pill for list chips, tone-coded. Kept local to the list — StatusBadge
// is for lifecycle statuses; these are at-a-glance compliance/type flags.
const CHIP_TONES = {
  slate:   'bg-slate-100 text-slate-700 border-slate-200',
  amber:   'bg-amber-50 text-amber-700 border-amber-200',
  indigo:  'bg-indigo-50 text-indigo-700 border-indigo-200',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};
const Chip = ({ children, tone = 'slate' }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap ${CHIP_TONES[tone]}`}>{children}</span>
);

// "All …" placeholder shown as the first option of each inline filter select.
const FILTER_PLACEHOLDERS = {
  vendor_type: 'All Types', msme: 'All MSME', company: 'All Companies',
  state: 'All States', payment_terms: 'All Terms', status: 'All Status',
};

export default function VendorList() {
  const navigate = useNavigate();
  // Filters live in the URL so Back / refresh / sharing restore the filtered
  // view (and a record opened from here returns to it on Back).
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters, anyActive: filtersActive } = useUrlFilters({
    vendor_type: '', msme: '', company: '', state: '', payment_terms: '', status: '',
  });
  const [showImport, setShowImport] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const { canCreate, canEdit, canDelete, canExport, canImport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/vendors/');
  const { options: companiesRaw } = useLookup('/api/companies/', { labelField: 'legal_name' });
  // Options carry the company id — the vendor row's `company` FK is matched on
  // id. (company_name on the row is the company CODE, so filtering by the
  // legal-name label would never match.)
  const companyOptions = companiesRaw.filter(c => c.value);
  // Derive the State filter from values that actually exist on the
  // loaded vendors, so the dropdown never offers a dead choice.
  const stateOptions = (() => {
    const seen = new Set();
    const out = [];
    for (const v of data) {
      const s = (v.state || '').trim();
      if (!s || seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      out.push({ value: s, label: s });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  })();

  // Payment-terms options derived from the loaded vendors, so the dropdown only
  // offers terms that actually exist (ordered by day count, "as agreed" last).
  const paymentTermOptions = (() => {
    const seen = new Set();
    const out = [];
    for (const v of data) {
      const t = (v.payment_terms || '').trim();
      if (!t || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      out.push({ value: t, label: t });
    }
    return out.sort((a, b) => (parseInt(a.value, 10) || 9999) - (parseInt(b.value, 10) || 9999));
  })();

  const filters = [
    {
      key: 'vendor_type',
      label: 'Vendor Type',
      type: 'select',
      single: true,
      options: VENDOR_TYPE_OPTIONS,
    },
    {
      key: 'msme',
      label: 'MSME',
      type: 'select',
      single: true,
      options: [
        { value: 'yes', label: 'MSME registered' },
        { value: 'no', label: 'Not registered' },
        { value: 'MICRO', label: 'Micro' },
        { value: 'SMALL', label: 'Small' },
        { value: 'MEDIUM', label: 'Medium' },
      ],
    },
    {
      key: 'company',
      label: 'Company',
      type: 'select',
      options: companyOptions,
    },
    {
      key: 'state',
      label: 'State',
      type: 'select',
      options: stateOptions,
    },
    {
      key: 'payment_terms',
      label: 'Payment Terms',
      type: 'select',
      options: paymentTermOptions,
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
    if (!(await confirm({ message: 'Are you sure you want to delete this record?', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/vendors/${id}/`);
      toast.success('Record deleted successfully');
      refetch();
    } catch (err) {
      toast.error('Failed to delete record');
    }
  };

  const columns = [
    { key: 'vendor_code', label: 'Vendor Code', sortable: true },
    { key: 'vendor_name', label: 'Vendor Name', sortable: true },
    {
      key: 'vendor_type',
      label: 'Vendor Type',
      sortable: true,
      render: (value) => {
        const list = asTypeList(value);
        if (!list.length) return <span className="text-slate-400">—</span>;
        return <div className="flex flex-wrap gap-1">{list.map(t => <Chip key={t}>{VENDOR_TYPE_LABELS[t] || t}</Chip>)}</div>;
      },
    },
    { key: 'company_name', label: 'Company', sortable: true },
    { key: 'city', label: 'City', sortable: true },
    { key: 'state', label: 'State', sortable: true },
    {
      // Repurposed from the old single "MSME" column (same key so saved field
      // configs keep showing it) — now an at-a-glance compliance strip.
      key: 'msme_category',
      label: 'Compliance',
      sortable: false,
      render: (value, row) => {
        const chips = [];
        if (row.is_msme) chips.push(<Chip key="msme" tone="amber">{value ? `MSME · ${titleCase(value)}` : 'MSME'}</Chip>);
        if (row.is_rcm) chips.push(<Chip key="rcm" tone="indigo">RCM</Chip>);
        if (row.gstin_verified_at) chips.push(<Chip key="gst" tone="emerald">GST ✓</Chip>);
        return chips.length ? <div className="flex flex-wrap gap-1">{chips}</div> : <span className="text-slate-400">—</span>;
      },
    },
    { key: 'payment_terms', label: 'Payment Terms', sortable: true },
    {
      key: 'is_active',
      label: 'Status',
      render: (value, row) => <StatusBadge status={value === false ? 'Inactive' : (value === true ? 'Active' : value)} />,
    },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (value, row) => (
        <ActionButtons
          moduleName="Vendor"
          editPath={`/masters/vendor/${row.id}/edit`}
          onDelete={(r) => handleDelete(r.id)}
          row={row}
        />
      ),
    },
  ];

  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'vendor_master_fields', data);

  const filteredData = data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const matches = [
        row.vendor_code, row.vendor_name, row.company_name, row.gstin,
        row.city, row.state, row.payment_terms, row.contact_person,
        row.contact_email, row.contact_phone,
      ].some(v => v != null && String(v).toLowerCase().includes(s));
      if (!matches) return false;
    }
    if (filterValues.vendor_type) {
      // vendor_type on the row is a JSON list (multi-select), so
      // match if the chosen code appears anywhere in the row's list.
      const types = Array.isArray(row.vendor_type) ? row.vendor_type : [row.vendor_type];
      if (!types.some(t => String(t).toUpperCase() === filterValues.vendor_type.toUpperCase())) return false;
    }
    if (filterValues.msme) {
      const fv = filterValues.msme;
      if (fv === 'yes' && !row.is_msme) return false;
      if (fv === 'no' && row.is_msme) return false;
      if (['MICRO', 'SMALL', 'MEDIUM'].includes(fv)
          && String(row.msme_category || '').toUpperCase() !== fv) return false;
    }
    if (!matchesSelect(row.company, filterValues.company)) return false;
    if (!matchesSelect(row.state, filterValues.state)) return false;
    if (!matchesSelect(row.payment_terms, filterValues.payment_terms)) return false;
    if (!matchesSelect(row.is_active ? 'Active' : 'Inactive', filterValues.status)) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Vendors"
        subtitle="Manage vendor and supplier records"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Vendors' }]}
        actions={{
          ...(canCreate('Vendor') ? { right: <TallyImportButton what="parties" partyKind="vendor" onDone={refetch} /> } : {}),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Vendor') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Vendor') ? { createLink: '/masters/vendor/new', createLabel: 'Add Vendor' } : {}),
        }}
      />
      {/* Explicit inline filters — always visible, one dropdown per field, like
          the other list pages (Payment Entries, Bills, Invoices). Replaces the
          old collapsible Simple/Advanced FilterPanel. */}
      <div className={`${CTRL_ROW} mb-3`}>
        {filters.map((f) => (
          <CustomSelect
            key={f.key}
            value={filterValues[f.key] || ''}
            onChange={(e) => setFilterValue(f.key, e.target.value)}
            title={f.label}
            className={`${CTRL_FIELD} max-w-[180px]`}>
            <option value="">{FILTER_PLACEHOLDERS[f.key] || `All ${f.label}`}</option>
            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </CustomSelect>
        ))}
        {filtersActive && (
          <button type="button" onClick={clearFilters}
            className="text-xs text-slate-500 hover:text-slate-800 underline">Clear</button>
        )}
      </div>
      <ListState error={error} onRetry={refetch}>
      {/* Mobile card list — phones get this; desktop gets the
          DataTable below. Same shape as every Sales-module list. */}
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search vendors…"
        emptyMessage="No vendors found"
        config={{
          title: (row) => row.vendor_code || '—',
          subtitle: (row) => row.vendor_name,
          badge: (row) => ({
            label: row.is_active === false ? 'Inactive' : 'Active',
            cls: row.is_active === false
              ? 'bg-slate-100 text-slate-600 border-slate-200'
              : 'bg-emerald-50 text-emerald-700 border-emerald-200',
          }),
          fields: (row) => [
            { label: 'Company', value: row.company_name },
            { label: 'GSTIN',   value: row.gstin },
            { label: 'City',    value: row.city },
            { label: 'Terms',   value: row.payment_terms },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/vendor/${row.id}`) },
            canEdit('Vendor') && { icon: Edit, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/vendor/${row.id}/edit`) },
            canDelete('Vendor') && { icon: Trash2, label: 'Delete', cls: 'text-red-600 hover:bg-red-50', onClick: () => handleDelete(row.id) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/masters/vendor/${row.id}`)}
      />

      {/* Desktop / tablet table view — hidden on mobile. */}
      <div className="hidden sm:block">
        <DataTable
          persistKey="vendors"
          exportFileName="vendors"
          canExport={canExport('Vendor')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onSearch={setSearchTerm}
          searchPlaceholder="Search vendors…"
          onRowClick={(row) => navigate(`/masters/vendor/${row.id}`)}
        />
      </div>
      </ListState>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="vendor_master_fields" />}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Vendors"
        endpoint="/api/vendors/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}

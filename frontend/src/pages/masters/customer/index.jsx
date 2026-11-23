import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Pencil, Eye, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import TallyImportButton from '../../../components/common/TallyImportButton';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ActionButtons from '../../../components/common/ActionButtons';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import BulkImportModal from '../../../components/common/BulkImportModal';
import {
  MobileBottomSheet,
  MobileFilterChips,
  MobileListCard,
  MobileSearchBar,
  MobileCardSkeleton,
} from '../../../components/mobile';
import { Button, Field, Select } from '../../../components/common/forms';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';

export default function CustomerList() {
  const navigate = useNavigate();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ company: '', credit_terms: '', status: '' });
  const [showImport, setShowImport] = useState(false);
  const { canCreate, canEdit, canDelete, canExport, canImport } = usePermissions();
  // Mobile-specific UI state — sheet + search are kept separate from the
  // desktop FilterPanel so the two stay independently controllable.
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState('');
  // Local-only draft inside the bottom sheet — applied to filterValues
  // on "Apply", discarded on cancel.
  const [draftFilters, setDraftFilters] = useState({});

  const { options: companiesRaw } = useLookup('/api/companies/', { labelField: 'legal_name' });
  // Filter on the company ID, not its name. The customer list serialises
  // `company_name` from company.company_code ("UAI-001") while this lookup
  // labels companies by legal_name ("UNITED AGRO INDUSTRIES"), so matching on
  // the name never hit and the filter returned "No data found".
  const companyOptions = companiesRaw
    .map((c) => ({ value: c.value, label: c.label }))
    .filter((c) => c.value && c.label);

  const filters = [
    { key: 'company', label: 'Company', type: 'select', single: true, options: companyOptions },
    {
      key: 'credit_terms',
      label: 'Credit Terms',
      type: 'select',
      single: true,
      options: [
        { value: 'NET_15', label: 'Net 15' },
        { value: 'NET_30', label: 'Net 30' },
        { value: 'NET_45', label: 'Net 45' },
        { value: 'CUSTOM', label: 'Custom' },
      ],
    },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      single: true,
      options: [
        { value: 'Active', label: 'Active' },
        { value: 'Inactive', label: 'Inactive' },
      ],
    },
  ];

  const handleDelete = async (id) => {
    if (!(await confirm({ message: 'Are you sure you want to delete this record?', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/customers/${id}/`);
      toast.success('Record deleted successfully');
      refetch();
    } catch {
      toast.error('Failed to delete record');
    }
  };

  const columns = [
    { key: 'customer_code', label: 'Customer Code', sortable: true },
    { key: 'customer_name', label: 'Customer Name', sortable: true },
    { key: 'company_name', label: 'Company', sortable: true },
    { key: 'gstin', label: 'GSTIN', sortable: true },
    {
      key: 'credit_terms', label: 'Credit Terms', sortable: true,
      // Show the custom period inline (CUSTOM-7) so a glance tells the days,
      // not just that it is custom. 0 is a real value (due on bill date), so
      // test for null, not falsiness. Unconfigured custom stays plain CUSTOM.
      render: (value, row) => (value === 'CUSTOM' && row.custom_credit_days != null
        ? `CUSTOM-${row.custom_credit_days}` : (value || '-')),
    },
    {
      key: 'is_active',
      label: 'Status',
      // The "eff" pill sits beside the status badge: a credit term only
      // decides due dates once it has an effective date, so this is the
      // at-a-glance "is this customer's term live?" signal, grouped with the
      // other status badges for quick scanning. Hover shows the date.
      render: (value, row) => (
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge status={value === false ? 'Inactive' : value === true ? 'Active' : value} />
          {row.credit_terms_effective_from && (
            <span title={`Credit terms in force from ${row.credit_terms_effective_from}`}
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">eff</span>
          )}
        </span>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (_, row) => (
        <ActionButtons
          moduleName="Customer"
          editPath={`/masters/customer/${row.id}`}
          onDelete={(r) => handleDelete(r.id)}
          row={row}
        />
      ),
    },
  ];

  const { data, isLoading, error, refetch } = useApiData('/api/customers/');
  const {
    visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys,
  } = useConfigureFields(columns, 'customer_master_fields', data);

  // Filter logic merges mobileSearch and filterValues (Status chip on
  // mobile mutates filterValues directly so the desktop FilterPanel
  // stays in sync if both are open).
  const filteredData = useMemo(() => data.filter((row) => {
    if (mobileSearch) {
      const s = mobileSearch.toLowerCase();
      const m = [row.customer_code, row.customer_name, row.company_name, row.gstin, row.contact_person, row.contact_phone]
        .some((v) => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.company, filterValues.company)) return false;
    if (!matchesSelect(row.credit_terms, filterValues.credit_terms)) return false;
    if (!matchesSelect(row.is_active ? 'Active' : 'Inactive', filterValues.status)) return false;
    return true;
  }), [data, mobileSearch, filterValues.company, filterValues.credit_terms, filterValues.status]);

  // Quick-pick status chips — counts come from the full dataset (before
  // status filter) so users can see how many records fall into each.
  const baseForCounts = useMemo(() => data.filter((row) => {
    if (mobileSearch) {
      const s = mobileSearch.toLowerCase();
      const m = [row.customer_code, row.customer_name, row.company_name, row.gstin]
        .some((v) => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.company, filterValues.company)) return false;
    if (!matchesSelect(row.credit_terms, filterValues.credit_terms)) return false;
    return true;
  }), [data, mobileSearch, filterValues.company, filterValues.credit_terms]);

  const activeCount = baseForCounts.filter((r) => r.is_active !== false).length;
  const inactiveCount = baseForCounts.filter((r) => r.is_active === false).length;
  const totalCount = baseForCounts.length;

  const mobileChips = [
    { key: 'all',      label: 'All',      count: totalCount,    active: !filterValues.status },
    { key: 'Active',   label: 'Active',   count: activeCount,   active: filterValues.status === 'Active' },
    { key: 'Inactive', label: 'Inactive', count: inactiveCount, active: filterValues.status === 'Inactive' },
  ];

  const handleChipClick = (key) => {
    setFilterValue('status', key === 'all' ? '' : key);
  };

  const activeFilterCount = ['company', 'credit_terms', 'status'].filter((k) => filterValues[k]).length;

  const openMobileSheet = () => {
    setDraftFilters({
      company: filterValues.company || '',
      credit_terms: filterValues.credit_terms || '',
      status: filterValues.status || '',
    });
    setMobileSheetOpen(true);
  };
  const applyMobileFilters = () => {
    setFilterValue('company', draftFilters.company || '');
    setFilterValue('credit_terms', draftFilters.credit_terms || '');
    setFilterValue('status', draftFilters.status || '');
    setMobileSheetOpen(false);
  };
  const resetMobileFilters = () => {
    clearFilters();
    setDraftFilters({});
  };

  const cardConfig = (row) => ({
    title: row.customer_name || row.customer_code || '—',
    subtitle: [row.customer_code, row.company_name].filter(Boolean).join(' · '),
    badge: {
      label: (row.is_active === false ? 'Inactive' : 'Active') + (row.credit_terms_effective_from ? ' · eff' : ''),
      cls: row.is_active === false
        ? 'bg-slate-100 text-slate-600 border-slate-200'
        : 'bg-emerald-50 text-emerald-700 border-emerald-200',
    },
    fields: [
      { label: 'GSTIN',   value: row.gstin },
      { label: 'Contact', value: row.contact_person },
      { label: 'Phone',   value: row.contact_phone },
      { label: 'Terms',   value: row.credit_terms === 'CUSTOM' && row.custom_credit_days != null ? `CUSTOM-${row.custom_credit_days}` : row.credit_terms },
    ],
    actions: [
      { icon: Eye, label: 'View', cls: 'text-blue-700 active:bg-blue-50', onClick: () => navigate(`/masters/customer/${row.id}`) },
      canEdit('Customer') && { icon: Pencil, label: 'Edit', cls: 'text-slate-700 active:bg-slate-100', onClick: () => navigate(`/masters/customer/${row.id}`) },
      canDelete('Customer') && { icon: Trash2, label: 'Delete', cls: 'text-red-700 active:bg-red-50', onClick: () => handleDelete(row.id) },
    ].filter(Boolean),
  });

  return (
    <MainLayout>
      <PageHeader
        title="Customers"
        subtitle="Manage customer master records"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Customers' }]}
        actions={{
          ...(canCreate('Customer') ? { right: <TallyImportButton what="parties" partyKind="customer" onDone={refetch} /> } : {}),
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Customer') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Customer') ? { createLink: '/masters/customer/new', createLabel: 'Add Customer' } : {}),
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
      {/* ── Mobile experience (sm:hidden) ────────────────────────────
          Sticky search → filter chips → card list → FAB → bottom sheet.
          The chip row and search bar sit inside a soft card so they
          feel like Zoho's filter strip. */}
      <div className="sm:hidden space-y-3 pb-24">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3 space-y-2 sticky top-2 z-10">
          <MobileSearchBar
            value={mobileSearch}
            onChange={setMobileSearch}
            placeholder="Search customers…"
          />
          <MobileFilterChips
            chips={mobileChips}
            onChipClick={handleChipClick}
            activeCount={activeFilterCount}
            onOpenSheet={openMobileSheet}
            onReset={resetMobileFilters}
          />
        </div>

        {isLoading && <MobileCardSkeleton count={4} />}

        {!isLoading && filteredData.length === 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
            <p className="text-[15px] font-medium text-slate-700">No customers found</p>
            <p className="text-[13px] text-slate-500 mt-1">Try clearing filters or adding a new customer.</p>
          </div>
        )}

        {!isLoading && (
          <div className="grid grid-cols-2 gap-3 items-start">
            {filteredData.map((row) => {
              const cfg = cardConfig(row);
              return (
                <MobileListCard
                  key={row.id}
                  title={cfg.title}
                  subtitle={cfg.subtitle}
                  badge={cfg.badge}
                  fields={cfg.fields}
                  actions={cfg.actions}
                  avatarSeed={row.customer_name || row.customer_code}
                  onClick={() => navigate(`/masters/customer/${row.id}`)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── Desktop experience (hidden on mobile) ───────────────────── */}
      <div className="hidden sm:block">
        <DataTable
          persistKey="customers"
          exportFileName="customers"
          canExport={canExport('Customer')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/masters/customer/${row.id}`)}
        />
      </div>
      </ListState>

      {/* Mobile filter sheet */}
      <MobileBottomSheet
        open={mobileSheetOpen}
        onClose={() => setMobileSheetOpen(false)}
        title="Filters"
        footer={(
          <div className="flex gap-2">
            <Button variant="secondary" fullWidth onClick={resetMobileFilters}>
              Reset
            </Button>
            <Button fullWidth onClick={applyMobileFilters}>
              Apply
            </Button>
          </div>
        )}
      >
        <div className="space-y-4">
          <Field label="Company">
            <Select
              value={draftFilters.company || ''}
              onChange={(e) => setDraftFilters((p) => ({ ...p, company: e.target.value }))}
              placeholder="Any company"
            >
              {companyOptions.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Credit Terms">
            <Select
              value={draftFilters.credit_terms || ''}
              onChange={(e) => setDraftFilters((p) => ({ ...p, credit_terms: e.target.value }))}
              placeholder="Any terms"
            >
              <option value="NET_15">Net 15</option>
              <option value="NET_30">Net 30</option>
              <option value="NET_45">Net 45</option>
              <option value="Custom">Custom</option>
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={draftFilters.status || ''}
              onChange={(e) => setDraftFilters((p) => ({ ...p, status: e.target.value }))}
              placeholder="Any status"
            >
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </Select>
          </Field>
        </div>
      </MobileBottomSheet>

      {showConfig && (
        <ConfigureFields
          allColumns={mergedColumns}
          visibleFields={visibleFieldKeys}
          onApply={handleConfigApply}
          onClose={() => setShowConfig(false)}
          storageKey="customer_master_fields"
        />
      )}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Customers"
        endpoint="/api/customers/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}

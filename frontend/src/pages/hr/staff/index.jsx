import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import { Pencil, RefreshCw } from 'lucide-react';
import useApiData from '../../../hooks/useApiData.js';
import useUrlPage from '../../../hooks/useUrlPage.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import usePermissions from '../../../hooks/usePermissions.js';

export default function StaffMasterList() {
  const { canCreate, canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/hr/staff/');
  const navigate = useNavigate();
  const [sortBy, setSortBy] = useState('staff_id');
  const [sortOrder, setSortOrder] = useState('asc');
  const [searchTerm, setSearchTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    staff_type: '', company_name: '', employment_status: '', department: '',
  });
  const [page, setPage] = useUrlPage([searchTerm, filterValues.staff_type, filterValues.company_name, filterValues.employment_status, filterValues.department]);

  const columns = [
    { field: 'staff_id', header: 'Staff ID', sortable: true, width: '100px' },
    { field: 'first_name', header: 'First Name', sortable: true, width: '130px' },
    { field: 'last_name', header: 'Last Name', sortable: true, width: '130px' },
    {
      field: 'staff_type',
      header: 'Staff Type',
      sortable: true,
      width: '110px',
      render: (value) => (
        <span className={`px-2 py-1 rounded text-xs font-medium ${value === 'Employee' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'}`}>
          {value}
        </span>
      ),
    },
    { field: 'company_name', header: 'Company', sortable: true, width: '180px' },
    { field: 'location_name', header: 'Location', sortable: true, width: '150px' },
    { field: 'department', header: 'Department', sortable: true, width: '130px' },
    { field: 'designation', header: 'Designation', sortable: true, width: '150px' },
    {
      field: 'employment_status',
      header: 'Status',
      sortable: true,
      width: '120px',
      render: (value) => <StatusBadge status={value} />,
    },
    {
      field: 'actions',
      header: '',
      sortable: false,
      width: '60px',
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/hr/staff/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  // Options for the structured column filters are derived from the loaded
  // rows so they always match what's actually present. The free-text
  // "Search" filter here was a duplicate of the table's built-in search bar.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));

  const filterConfig = [
    { key: 'staff_type', label: 'Staff Type', type: 'select', options: optsFrom('staff_type') },
    { key: 'company_name', label: 'Company', type: 'select', options: optsFrom('company_name') },
    {
      key: 'employment_status',
      label: 'Employment Status',
      type: 'select',
      options: [
        { value: 'ACTIVE', label: 'Active' },
        { value: 'ON_LEAVE', label: 'On Leave' },
        { value: 'RESIGNED', label: 'Resigned' },
      ],
    },
    { key: 'department', label: 'Department', type: 'select', options: optsFrom('department') },
  ];

  const filteredData = (data || []).filter((item) => {
    const matchesSearch =
      !searchTerm ||
      item.first_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.last_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.staff_id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStaffType = matchesSelect(item.staff_type, filterValues.staff_type);
    const matchesCompany = matchesSelect(item.company_name, filterValues.company_name);
    const matchesStatus = matchesSelect(item.employment_status, filterValues.employment_status);
    const matchesDepartment = matchesSelect(item.department, filterValues.department);
    return matchesSearch && matchesStaffType && matchesCompany && matchesStatus && matchesDepartment;
  });

  const handleSort = (field, order) => {
    setSortBy(field);
    setSortOrder(order);
  };

  const handleFilterChange = (key, value) => {
    setFilterValue(key, value);
  };

  const handleResetFilters = () => {
    clearFilters();
  };

  const breadcrumbs = [
    { label: 'HR', href: '/hr' },
    { label: 'Staff Master' },
  ];

  return (
    <MainLayout>
      <div className="space-y-4 sm:space-y-5">
        <PageHeader
          title="Staff Master"
          subtitle="Manage employees and staff across all companies and locations"
          breadcrumbs={breadcrumbs}
          actions={{
            onFilter: () => setShowFilters(!showFilters),
            ...(canCreate('Staff') ? { createLink: '/hr/staff/new', createLabel: 'Add Staff' } : {}),
          }}
        />

        {showFilters && (
          <FilterPanel
            filters={filterConfig}
            values={filterValues}
            onChange={handleFilterChange}
            onReset={handleResetFilters}
            onClose={() => setShowFilters(false)}
          />
        )}

        <ListState error={error} onRetry={refetch}>
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <DataTable
              exportFileName="staff"
              canExport={canExport('Staff')}
              columns={columns}
              data={filteredData}
              isLoading={isLoading}
              page={page}
              pageSize={10}
              totalRecords={filteredData.length}
              onPageChange={setPage}
              onSort={handleSort}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSearch={setSearchTerm}
              searchPlaceholder="Search by name or staff ID..."
              onRowClick={(row) => navigate(`/hr/staff/${row.id}`)}
              emptyMessage="No staff records found"
            />
          </div>
        </ListState>
      </div>
    </MainLayout>
  );
}

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import Pagination from '../../../components/common/Pagination';
import StatusBadge from '../../../components/common/StatusBadge';
import ProductsCell from '../../../components/common/ProductsCell';
import { Pencil, FileText, Trash2, Eye, Mail, X, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { useGlobalCompany } from '../../../hooks/useGlobalCompany.js';
import MobileListCards from '../components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';
import exportToExcel from '../../../utils/exportExcel.js';

const EXPORT_COLUMNS = [
  { key: 'rfq_no', label: 'RFQ No' },
  { key: 'linked_pr_numbers', label: 'Linked PRs' },
  { key: 'product_names', label: 'Products' },
  { key: 'created_by_name', label: 'Created By' },
  { key: 'creation_date', label: 'Creation Date' },
  { key: 'rfq_mode', label: 'RFQ Mode' },
  { key: 'rfq_status', label: 'RFQ Status' },
  { key: 'quote_count_expected', label: 'Expected Quotes' },
];

export default function RFQList() {
  const navigate = useNavigate();
  const { canSendEmail, canCreate, canEdit, canDelete, canExport, canQuoteResponse } = usePermissions();
  const { isHidden } = useFieldPermissions('RFQ');
  const canRecordQuoteResponse = canQuoteResponse('RFQ');
  const { company: globalCompany } = useGlobalCompany();
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/rfq/');
  const [searchTerm, setSearchTerm] = useState('');
  const [datePeriod, setDatePeriod] = useState('All');
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 17;

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Are you sure you want to delete ${row.rfq_no}? This action cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/rfq/${row.id}/`);
      toast.success(`${row.rfq_no} deleted successfully`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  // Column visibility — never drop rfq_no or actions
  const catalogKeyByColumn = {
    linked_pr_numbers: 'linked_prs',
    rfq_mode: 'rfq_mode',
    rfq_status: 'rfq_status',
    quote_count_expected: 'quote_count_expected',
  };
  const colVisible = (key) => {
    if (key === 'rfq_no' || key === 'actions') return true;
    const ck = catalogKeyByColumn[key];
    return ck ? !isHidden(ck) : true;
  };

  const filteredData = useMemo(() => {
    let result = data || [];
    if (globalCompany) result = result.filter(r => String(r.company || '') === String(globalCompany));
    if (datePeriod !== 'All') {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let from = null, to = null;
      if (datePeriod === 'Today') { from = today; to = today; }
      else if (datePeriod === 'Week') { from = new Date(today); from.setDate(today.getDate() - today.getDay()); to = today; }
      else if (datePeriod === 'Month') { from = new Date(today.getFullYear(), today.getMonth(), 1); to = today; }
      else if (datePeriod === 'FY') {
        const fyStart = today.getMonth() >= 3 ? new Date(today.getFullYear(), 3, 1) : new Date(today.getFullYear() - 1, 3, 1);
        from = fyStart; to = today;
      } else if (datePeriod === 'Custom') {
        if (customRange.from) from = new Date(customRange.from);
        if (customRange.to) to = new Date(customRange.to);
      }
      if (from || to) {
        result = result.filter(row => {
          if (!row.creation_date) return false;
          const d = new Date(row.creation_date);
          if (from && d < from) return false;
          if (to) { const end = new Date(to); end.setDate(end.getDate() + 1); if (d >= end) return false; }
          return true;
        });
      }
    }

    if (statusFilter !== 'ALL') {
      result = result.filter(row => row.rfq_status === statusFilter);
    }

    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter(row =>
        Object.values(row).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    return result;
  }, [data, globalCompany, datePeriod, customRange, statusFilter, searchTerm]);

  const pagedData = filteredData.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [filteredData.length]);

  const handleExport = useCallback(() => {
    const rows = filteredData.map(r => ({
      ...r,
      linked_pr_numbers: (r.linked_pr_numbers || []).join(', '),
      product_names: (r.product_names || []).join(', '),
      creation_date: r.creation_date ? formatDate(r.creation_date) : '',
    }));
    exportToExcel(rows, EXPORT_COLUMNS, 'rfq-list');
  }, [filteredData]);

  return (
    <MainLayout>
      <PageHeader
        title="Request for Quotation"
        subtitle="Manage RFQs sent to vendors"
        breadcrumbs={[{ label: 'Sourcing' }, { label: 'RFQ' }]}
        actions={{
          ...(canCreate('RFQ') ? { createLink: '/purchase/rfq/new', createLabel: 'New RFQ' } : {}),
        }}
      />

      {/* Toolbar: date tabs + search + status + export */}
      <div className="hidden sm:flex items-center gap-2 px-1 py-1.5">
        {['All', 'Today', 'Week', 'Month', 'FY', 'Custom'].map((p) => (
          <button
            key={p}
            onClick={() => setDatePeriod(p)}
            className={`px-3 py-1 text-[12px] font-medium rounded-md border transition ${
              datePeriod === p
                ? 'bg-primary-600 text-white border-primary-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {p}
          </button>
        ))}
        {datePeriod === 'Custom' && (
          <>
            <input type="date" value={customRange.from} onChange={(e) => setCustomRange(r => ({ ...r, from: e.target.value }))} className="h-[30px] text-[11px] border border-slate-200 rounded-md px-2 bg-white" />
            <span className="text-[10px] text-slate-400">to</span>
            <input type="date" value={customRange.to} onChange={(e) => setCustomRange(r => ({ ...r, to: e.target.value }))} className="h-[30px] text-[11px] border border-slate-200 rounded-md px-2 bg-white" />
          </>
        )}
        <div className="flex-1" />
        <div className="relative">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search RFQs…"
            className="h-[30px] w-[160px] text-[12px] border border-slate-200 rounded-md pl-3 pr-7 bg-white focus:ring-1 focus:ring-primary-400 focus:border-primary-400 placeholder-slate-400"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600">
              <X size={10} />
            </button>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-[30px] text-[12px] font-medium text-slate-700 border border-slate-200 rounded-md bg-white cursor-pointer pl-3 pr-8 leading-none appearance-none bg-no-repeat focus:ring-1 focus:ring-primary-400 focus:border-primary-400"
          style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2360594a' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")", backgroundPosition: 'right 8px center', backgroundSize: '12px' }}
        >
          <option value="ALL">Status</option>
          <option value="Open">Open</option>
          <option value="Closed">Closed</option>
          <option value="Cancelled">Cancelled</option>
        </select>
        {canExport('RFQ') && (
          <button onClick={handleExport} className="h-[30px] px-3 text-[11px] font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50">
            Export
          </button>
        )}
      </div>

      <ListState error={error} onRetry={refetch}>
      {/* Mobile cards */}
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search RFQ no, status…"
        emptyMessage="No RFQs found"
        config={{
          title: (row) => row.rfq_no,
          subtitle: (row) => row.created_by_name || '—',
          meta: (row) => formatDate(row.creation_date),
          badge: (row) => {
            const s = row.rfq_status;
            const map = {
              Open:      { label: 'Open',      cls: 'bg-blue-100 text-blue-800 border-blue-300' },
              Closed:    { label: 'Closed',    cls: 'bg-slate-200 text-slate-700 border-slate-300' },
              Cancelled: { label: 'Cancelled', cls: 'bg-red-100 text-red-700 border-red-300' },
            };
            return map[s] || { label: s || '-', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
          },
          fields: (row) => [
            { label: 'Mode',     value: row.rfq_mode },
            { label: 'Quotes',   value: row.quote_count_expected },
            { label: 'PRs',      value: (row.linked_pr_numbers || []).join(', ') || null },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/purchase/rfq/${row.id}`) },
            { icon: Mail, label: 'Email', cls: 'text-primary-700 hover:bg-primary-50', hidden: !(canSendEmail('RFQ') && !row.email_sent), onClick: () => navigate(`/purchase/rfq/${row.id}/send-email`) },
            {
              icon: FileText,
              label: row.is_evaluated ? 'Evaluated' : 'Quote',
              cls: row.is_evaluated
                ? 'text-slate-400 bg-slate-100 cursor-not-allowed'
                : 'text-purple-700 hover:bg-purple-50',
              hidden: !(canRecordQuoteResponse && row.email_sent),
              disabled: !!row.is_evaluated,
              onClick: () => { if (!row.is_evaluated) navigate(`/purchase/quotes/new?rfq=${row.id}`); },
            },
          ],
        }}
        onRowClick={(row) => navigate(`/purchase/rfq/${row.id}`)}
      />

      {/* Desktop: Compact Table */}
      <div className="hidden sm:block">
        <div className="border border-slate-200 rounded-md overflow-hidden bg-white">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-primary-50 border-b-2 border-slate-300">
                <th className="text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">RFQ No</th>
                {colVisible('linked_pr_numbers') && <th className="text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">Linked PRs</th>}
                <th className="text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap" style={{ width: 180 }}>Products</th>
                <th className="text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">Created By</th>
                <th className="text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">Date</th>
                {colVisible('rfq_mode') && <th className="text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">Mode</th>}
                {colVisible('rfq_status') && <th className="text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">Status</th>}
                {colVisible('quote_count_expected') && <th className="text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">Exp. Quotes</th>}
                <th className="text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={9} className="text-center py-8"><Loader2 size={20} className="animate-spin text-primary-500 inline" /></td></tr>
              ) : pagedData.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-8 text-slate-400 text-[12px]">No RFQs found</td></tr>
              ) : pagedData.map(row => (
                <tr
                  key={row.id}
                  onClick={() => navigate(`/purchase/rfq/${row.id}`)}
                  className="odd:bg-white even:bg-primary-50/40 border-b border-slate-100 hover:bg-primary-50/70 cursor-pointer transition-colors"
                >
                  <td className="px-2 py-1.5 font-semibold text-slate-800 whitespace-nowrap">{row.rfq_no}</td>
                  {colVisible('linked_pr_numbers') && (
                    <td className="px-2 py-1.5 text-slate-600">
                      {(() => {
                        const prs = row.linked_pr_numbers;
                        if (!Array.isArray(prs) || prs.length === 0) return '-';
                        const prIds = Array.isArray(row.linked_prs) ? row.linked_prs : [];
                        return prs.map((prNo, i) => (
                          <span key={i}>{i > 0 && ', '}{prIds[i] ? (
                            <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/requests/${prIds[i]}`); }} className="text-primary-600 hover:underline font-medium text-[11px]">{prNo}</button>
                          ) : prNo}</span>
                        ));
                      })()}
                    </td>
                  )}
                  <td className="px-2 py-1.5 text-slate-600 truncate" style={{ maxWidth: 180 }}>
                    <ProductsCell names={row.product_names} />
                  </td>
                  <td className="px-2 py-1.5 text-slate-600">{row.created_by_name || '—'}</td>
                  <td className="px-2 py-1.5 text-slate-500 whitespace-nowrap">{row.creation_date ? formatDate(row.creation_date) : '-'}</td>
                  {colVisible('rfq_mode') && <td className="px-2 py-1.5 text-slate-600">{row.rfq_mode || '-'}</td>}
                  {colVisible('rfq_status') && <td className="px-2 py-1.5"><StatusBadge status={row.rfq_status} /></td>}
                  {colVisible('quote_count_expected') && <td className="px-2 py-1.5 text-slate-600">{row.quote_count_expected || '-'}</td>}
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                      {canEdit('RFQ') && (
                        <button onClick={() => navigate(`/purchase/rfq/${row.id}`)} className="p-1 text-blue-600 hover:bg-blue-50 rounded" title="Edit">
                          <Pencil size={14} />
                        </button>
                      )}
                      {canSendEmail('RFQ') && !row.email_sent && (
                        <button onClick={() => navigate(`/purchase/rfq/${row.id}/send-email`)} className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-primary-700 bg-primary-50 rounded hover:bg-primary-100 transition" title="Send RFQ Email">
                          <Mail size={12} /> Email
                        </button>
                      )}
                      {row.email_sent && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-emerald-700 bg-emerald-50 rounded">
                          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                          Email Sent
                        </span>
                      )}
                      {canRecordQuoteResponse && row.email_sent && (
                        <button
                          onClick={() => { if (!row.is_evaluated) navigate(`/purchase/quotes/new?rfq=${row.id}`); }}
                          disabled={!!row.is_evaluated}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded transition ${
                            row.is_evaluated
                              ? 'text-slate-400 bg-slate-100 cursor-not-allowed'
                              : 'text-purple-700 bg-purple-50 hover:bg-purple-100'
                          }`}
                          title={row.is_evaluated ? 'Already evaluated — locked' : 'Create Quote Response'}
                        >
                          <FileText size={12} />
                          Quote
                        </button>
                      )}
                      {canDelete('RFQ') && (
                        <button onClick={(e) => handleDelete(e, row)} className="p-1 text-red-500 hover:bg-red-50 rounded" title="Delete">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination (shared component) */}
        <Pagination page={page} pageSize={PAGE_SIZE} total={filteredData.length} onChange={setPage} />
      </div>
      </ListState>
    </MainLayout>
  );
}

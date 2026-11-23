import { confirm } from '@/components/common/confirm';
import ImportStatementModal from '@/components/common/ImportStatementModal.jsx';
import CustomDatePicker from "@/components/ui/CustomDatePicker";
import { formatCurrency, formatDate } from '@/utils/formatters';
import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronDown, Plus, Eye, Pencil, Trash2, Settings2, GitBranch, FileText, Layers, X, Search, CheckSquare, Square, RefreshCw, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import exportToExcel from '../../../utils/exportExcel.js';
import MainLayout from '../../../components/layout/MainLayout';
import BackToModule from '../../../components/common/BackToModule';
import CustomSelect from '@/components/ui/CustomSelect';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import { CTRL_H } from '@/components/common/controls';
import StatusBadge from '../../../components/common/StatusBadge';
import { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import { useConfigureFields } from '../../../components/common/ConfigureFields';
import ListState from '@/components/common/ListState.jsx';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import usePagerKeys from '../../../hooks/usePagerKeys.js';
import { useFlowDashboard } from '../../../components/common/FlowDashboardPopup';
import ListAttachments, { useListAttachments } from '../components/ListAttachments';
import MobileListCards from '../components/MobileListCards';

/* ─── Bulk Receivable Modal ─── */
function BulkReceivableModal({ onClose, onSuccess }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState({});      // { invoiceId: true }
  const [dueDates, setDueDates] = useState({});       // { invoiceId: 'yyyy-mm-dd' }
  const [amounts, setAmounts] = useState({});          // { invoiceId: 'amount string' }
  const [paidMap, setPaidMap] = useState({});             // { invoiceId: total amount_paid }
  const [enteredMap, setEnteredMap] = useState({});       // { invoiceId: total receivable amount entered }
  const [receivableIdMap, setReceivableIdMap] = useState({}); // { invoiceId: receivable id (first one) }
  const [globalDueDate, setGlobalDueDate] = useState('');
  const [bulkSearch, setBulkSearch] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const fmt = (v) => formatCurrency(v);

  // Fetch all non-cancelled invoices + existing receivables to compute balance
  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiClient.get('/api/sales/invoices/', { params: { page_size: 500 } }),
      apiClient.get('/api/sales/receivables/', { params: { page_size: 500 } }),
    ]).then(([invRes, recRes]) => {
      const allInvoices = invRes.data?.results || invRes.data || [];
      const receivables = recRes.data?.results || recRes.data || [];
      // Sum up amounts per invoice + track receivable IDs
      const paid = {};    // actual payments received
      const entered = {}; // total receivable entries created
      const recIds = {};  // first receivable id per invoice (for record_payment)
      receivables.forEach(r => {
        const invId = r.invoice_reference;
        if (invId) {
          paid[invId] = (paid[invId] || 0) + Number(r.amount_paid || 0);
          entered[invId] = (entered[invId] || 0) + Number(r.amount || 0);
          if (!recIds[invId]) recIds[invId] = r.id;
        }
      });
      setPaidMap(paid);
      setEnteredMap(entered);
      setReceivableIdMap(recIds);
      setInvoices(allInvoices.filter(i => i.status !== 'CANCELLED'));
    }).catch(() => toast.error('Failed to load invoices'))
      .finally(() => setLoading(false));
  }, []);

  // Filter invoices by search
  const filtered = useMemo(() => {
    if (!bulkSearch.trim()) return invoices;
    const t = bulkSearch.toLowerCase();
    return invoices.filter(i =>
      (i.invoice_no || '').toLowerCase().includes(t) ||
      (i.customer_name || '').toLowerCase().includes(t)
    );
  }, [invoices, bulkSearch]);

  // Group filtered invoices by customer
  const groupedByCustomer = useMemo(() => {
    const map = {};
    filtered.forEach(inv => {
      const name = inv.customer_name || 'Unknown';
      if (!map[name]) map[name] = [];
      map[name].push(inv);
    });
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const selectedCount = Object.values(selected).filter(Boolean).length;
  const allFilteredSelected = filtered.length > 0 && filtered.every(i => selected[i.id]);

  const toggleAll = () => {
    if (allFilteredSelected) {
      const next = { ...selected };
      filtered.forEach(i => { delete next[i.id]; });
      setSelected(next);
    } else {
      const next = { ...selected };
      filtered.forEach(i => { next[i.id] = true; });
      setSelected(next);
    }
  };

  const toggleOne = (id) => {
    setSelected(prev => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  };

  // Select/deselect all in a customer group
  const toggleCustomerGroup = (customerInvoices) => {
    const allSelected = customerInvoices.every(i => selected[i.id]);
    const next = { ...selected };
    customerInvoices.forEach(i => {
      if (allSelected) delete next[i.id];
      else next[i.id] = true;
    });
    setSelected(next);
  };

  // Apply global due date to all selected
  const applyGlobalDueDate = () => {
    if (!globalDueDate) { toast.error('Set a due date first'); return; }
    const next = { ...dueDates };
    Object.keys(selected).forEach(id => { if (selected[id]) next[id] = globalDueDate; });
    setDueDates(next);
    toast.success(`Due date applied to ${selectedCount} invoices`);
  };

  // Submit bulk
  const handleBulkSubmit = async () => {
    const selectedInvoices = invoices.filter(i => selected[i.id]);
    if (selectedInvoices.length === 0) { toast.error('Select at least one invoice'); return; }

    // Validate all have receivable amounts > 0
    const missingAmount = selectedInvoices.filter(i => {
      const amt = parseFloat(amounts[i.id]);
      return !amt || amt <= 0;
    });
    if (missingAmount.length > 0) {
      toast.error(`${missingAmount.length} invoice(s) missing receivable amount. Enter amount for all selected invoices.`);
      return;
    }

    // For NEW invoices (no receivable yet), due date is required
    const newInvoices = selectedInvoices.filter(i => !receivableIdMap[i.id]);
    const missingDueDate = newInvoices.filter(i => !dueDates[i.id]);
    if (missingDueDate.length > 0) {
      toast.error(`${missingDueDate.length} new invoice(s) missing due date. Set due dates for invoices without existing receivables.`);
      return;
    }

    setSubmitting(true);
    setProgress({ done: 0, total: selectedInvoices.length });
    let successCount = 0;
    let failCount = 0;

    for (const inv of selectedInvoices) {
      try {
        const existingRecId = receivableIdMap[inv.id];
        if (existingRecId) {
          // Receivable exists — record payment on it (reduces balance)
          await apiClient.post(`/api/sales/receivables/${existingRecId}/record_payment/`, {
            amount: parseFloat(amounts[inv.id]),
          });
        } else {
          // No receivable yet — create new one with the entered amount as invoice amount
          await apiClient.post('/api/sales/receivables/', {
            invoice_reference: inv.id,
            customer: inv.customer,
            invoice_date: inv.invoice_date || null,
            due_date: dueDates[inv.id] || null,
            amount: inv.grand_total || 0,
            amount_paid: parseFloat(amounts[inv.id]) || 0,
            notes: '',
          });
        }
        successCount++;
      } catch {
        failCount++;
      }
      setProgress(prev => ({ ...prev, done: prev.done + 1 }));
    }

    if (failCount === 0) {
      toast.success(`${successCount} receivable entries created successfully!`);
    } else {
      toast.error(`${successCount} created, ${failCount} failed`);
    }
    setSubmitting(false);
    onSuccess();
    onClose();
  };

  // Compute total receivable amount of selected invoices
  const selectedTotal = invoices.filter(i => selected[i.id]).reduce((s, i) => s + (parseFloat(amounts[i.id]) || 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 overflow-y-auto py-3 sm:py-6">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl mx-2 sm:mx-4 my-auto" role="dialog" aria-modal="true" aria-label="Bulk Receivable Entry">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-4 sm:px-6 py-3 border-b bg-gradient-to-r from-blue-50 to-emerald-50 rounded-t-xl">
          <div>
            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2"><Layers size={22} className="text-blue-600" /> Bulk Receivable Entry</h2>
            <p className="text-sm text-slate-500 mt-0.5">Select multiple invoices and create receivable entries at once</p>
          </div>
          <button onClick={onClose} disabled={submitting} aria-label="Close" title="Close" className="self-end sm:self-auto p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
        </div>

        {/* Toolbar */}
        <div className="px-4 sm:px-6 py-3 border-b bg-slate-50 flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
            <input type="text" value={bulkSearch} onChange={e => setBulkSearch(e.target.value)}
              placeholder="Search invoices by number or customer..."
              className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
          </div>
          {/* Select all */}
          <button onClick={toggleAll}
            className="flex items-center gap-1.5 px-3 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100">
            {allFilteredSelected ? <CheckSquare size={16} className="text-blue-600" /> : <Square size={16} />}
            {allFilteredSelected ? 'Deselect All' : 'Select All'}
          </button>
          {/* Global due date */}
          <div className="flex items-center gap-2">
            <CustomDatePicker value={globalDueDate} onChange={e => setGlobalDueDate(e.target.value)}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
            <button onClick={applyGlobalDueDate} disabled={selectedCount === 0}
              className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap">
              Apply Due Date ({selectedCount})
            </button>
          </div>
        </div>

        {/* Summary bar */}
        {selectedCount > 0 && (
          <div className="px-4 sm:px-6 py-2.5 bg-blue-50 border-b border-blue-200 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-blue-800">
              {selectedCount} invoice{selectedCount > 1 ? 's' : ''} selected &mdash; Total: <span className="font-bold">{fmt(selectedTotal)}</span>
            </p>
            <button onClick={() => setSelected({})} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Clear Selection</button>
          </div>
        )}

        {/* Invoice list */}
        <div className="px-4 sm:px-6 py-4 max-h-[55dvh] overflow-y-auto">
          {loading ? (
            <div className="text-center py-12 text-slate-500">Loading invoices...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12">
              <Layers size={40} className="mx-auto text-slate-300 mb-3" />
              <p className="text-slate-500 font-medium">{invoices.length === 0 ? 'No invoices available for receivable entry' : 'No invoices match your search'}</p>
              <p className="text-xs text-slate-400 mt-1">All invoices may already have receivable entries</p>
            </div>
          ) : (
            <div className="space-y-4">
              {groupedByCustomer.map(([customerName, customerInvoices]) => {
                const allGroupSelected = customerInvoices.every(i => selected[i.id]);
                const someGroupSelected = customerInvoices.some(i => selected[i.id]);
                const groupTotal = customerInvoices.reduce((s, i) => s + Number(i.grand_total || 0), 0);
                const groupPaid = customerInvoices.reduce((s, i) => s + (paidMap[i.id] || 0), 0);
                const groupBalance = Math.max(0, groupTotal - groupPaid);
                return (
                  <div key={customerName} className="border rounded-lg overflow-hidden">
                    {/* Customer group header */}
                    <div className="flex items-center justify-between px-4 py-2.5 bg-slate-100 border-b cursor-pointer hover:bg-slate-150"
                      onClick={() => toggleCustomerGroup(customerInvoices)}>
                      <div className="flex items-center gap-2">
                        {allGroupSelected ? <CheckSquare size={16} className="text-blue-600" /> : someGroupSelected ? <CheckSquare size={16} className="text-blue-400" /> : <Square size={16} className="text-slate-400" />}
                        <span className="font-semibold text-sm text-slate-800">{customerName}</span>
                        <span className="text-xs text-slate-500 bg-slate-200 px-1.5 py-0.5 rounded">{customerInvoices.length} invoice{customerInvoices.length > 1 ? 's' : ''}</span>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <span className="text-slate-600">Total: {fmt(groupTotal)}</span>
                        <span className={groupBalance > 0 ? 'text-orange-600 font-semibold' : 'text-green-600 font-semibold'}>Bal: {fmt(groupBalance)}</span>
                      </div>
                    </div>
                    {/* Invoice rows */}
                    <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[720px]">
                      <thead>
                        <tr className="bg-white border-b text-xs text-slate-500 uppercase">
                          <th className="w-10 px-3 py-2"></th>
                          <th className="text-left px-3 py-2">Invoice No</th>
                          <th className="text-left px-3 py-2">Date</th>
                          <th className="text-right px-3 py-2">Invoice Amt</th>
                          <th className="text-right px-3 py-2">Received</th>
                          <th className="text-right px-3 py-2">Balance</th>
                          <th className="text-left px-3 py-2 w-36">Payment Amt</th>
                          <th className="text-left px-3 py-2 w-36">Due Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {customerInvoices.map(inv => {
                          const invoiceAmt = Number(inv.grand_total || 0);
                          const alreadyPaid = paidMap[inv.id] || 0;
                          const balanceAmt = Math.max(0, invoiceAmt - alreadyPaid);
                          return (
                            <tr key={inv.id}
                              className={`border-b transition cursor-pointer ${selected[inv.id] ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-slate-50'}`}
                              onClick={() => toggleOne(inv.id)}>
                              <td className="px-3 py-2.5 text-center">
                                {selected[inv.id]
                                  ? <CheckSquare size={16} className="text-blue-600" />
                                  : <Square size={16} className="text-slate-400" />}
                              </td>
                              <td className="px-3 py-2.5 font-medium text-slate-800">{inv.invoice_no}</td>
                              <td className="px-3 py-2.5 text-slate-600">
                                {inv.invoice_date ? formatDate(inv.invoice_date) : '-'}
                              </td>
                              <td className="px-3 py-2.5 text-right font-semibold text-slate-900">{fmt(invoiceAmt)}</td>
                              <td className="px-3 py-2.5 text-right text-green-700 font-medium">{alreadyPaid > 0 ? fmt(alreadyPaid) : <span className="text-slate-400">-</span>}</td>
                              <td className="px-3 py-2.5 text-right font-semibold">
                                <span className={balanceAmt > 0 ? 'text-orange-600' : 'text-green-600'}>{fmt(balanceAmt)}</span>
                              </td>
                              <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                                <div className="relative">
                                  <span className="absolute left-2 top-2 text-slate-400 text-xs">₹</span>
                                  <input type="number" step="0.01" min="0" value={amounts[inv.id] ?? ''}
                                    onChange={e => setAmounts(prev => ({ ...prev, [inv.id]: e.target.value }))}
                                    placeholder={balanceAmt.toFixed(2)}
                                    className={`w-full pl-6 pr-2 py-1.5 border rounded-md text-sm focus:ring-2 focus:ring-blue-500 ${selected[inv.id] && !(parseFloat(amounts[inv.id]) > 0) ? 'border-red-300 bg-red-50' : 'border-slate-300'}`} />
                                </div>
                              </td>
                              <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                                <CustomDatePicker value={dueDates[inv.id] || ''}
                                  onChange={e => setDueDates(prev => ({ ...prev, [inv.id]: e.target.value }))}
                                  className={`w-full px-2 py-1.5 border rounded-md text-sm focus:ring-2 focus:ring-blue-500 ${selected[inv.id] && !dueDates[inv.id] ? 'border-red-300 bg-red-50' : 'border-slate-300'}`} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t bg-slate-50 rounded-b-xl">
          <div className="text-sm text-slate-500">
            {invoices.length} invoice{invoices.length !== 1 ? 's' : ''} available
          </div>
          <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
            {submitting && (
              <div className="flex items-center gap-2 text-sm text-blue-700 font-medium">
                <div className="w-32 bg-slate-200 rounded-full h-2">
                  <div className="bg-blue-600 h-2 rounded-full transition-all" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}></div>
                </div>
                {progress.done}/{progress.total}
              </div>
            )}
            <button onClick={onClose} disabled={submitting}
              className="px-5 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">
              Cancel
            </button>
            <button onClick={handleBulkSubmit} disabled={submitting || selectedCount === 0}
              className="px-4 sm:px-6 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2">
              {submitting ? 'Creating...' : `Create ${selectedCount} Receivable${selectedCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Main List Page ─── */
export default function ReceivableLedgerList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canView, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Receivable');
  // Flow header button — reuses Sales Flow Dashboard view permission.
  const canSeeFlow = canView('Sales Flow Dashboard');
  const { data, isLoading, error, refetch } = useApiData('/api/sales/receivables/');
  const [page, setPage] = useState(1);
  // Seeded from the URL alongside the tab and filters, so opening a receipt and
  // coming back leaves the search box as you typed it. Read straight off
  // window.location because this runs before the useSearchParams hook below.
  const [searchTerm, setSearchTerm] = useState(
    () => new URLSearchParams(window.location.search).get('q') || '');
  // Search key: lower-cased, punctuation dropped, and z folded to s. Tally
  // spells one customer group both ways — "Greenstar FertiliSers - North" and
  // "Greenstar FertiliZers - Bihar" — so typing either spelling used to miss
  // half the rows. Folding z->s makes both match without a fuzzy library.
  const skey = (v) => String(v ?? '').toLowerCase()
    .replace(/[,\s₹]/g, '').replace(/z/g, 's');
  // Seeded from the URL so leaving for a receipt and coming BACK restores the
  // same view — the same tab, the same company, the same customer. Held in
  // state as before; the URL is only how it survives the round trip.
  const [rsp, setRsp] = useSearchParams();
  const [activeFilters, setActiveFilters] = useState(() => {
    const f = {};
    if (rsp.get('company_name')) f.company_name = rsp.get('company_name');
    if (rsp.get('customer_name')) f.customer_name = rsp.get('customer_name');
    return f;
  });
  // The period filter this page never had -- there was no way to narrow the
  // ledger by date. Seeded from the URL like everything else on the page, so
  // opening a bill and coming back keeps the window.
  const period = usePeriodFilter(rsp.get('period') || 'all', {
    anchor: rsp.get('anchor'),
    customFrom: rsp.get('cfrom'),
    customTo: rsp.get('cto'),
  });
  const [fieldsOpen, setFieldsOpen] = useState(false);   // Fields dropdown
  // The Bills Outstanding register is a hand-built table, not the shared
  // DataTable, so it had no sorting at all -- not even a header to click.
  const [regSort, setRegSort] = useState(rsp.get('rsort') || 'invoice_date');
  const [regDir, setRegDir] = useState(rsp.get('rdir') || 'asc');
  const toggleRegSort = (field) => {
    if (regSort === field) setRegDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setRegSort(field); setRegDir('asc'); }
  };
  const [advRules, setAdvRules] = useState([]);
  const [advLogic, setAdvLogic] = useState('AND');
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const { openFlow, FlowPopup } = useFlowDashboard();
  const { attachmentMap } = useListAttachments('RECEIVABLE');

  const handleDelete = async (id) => {
    if (!(await confirm({ message: 'Delete this receivable entry?', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/sales/receivables/${id}/`);
      toast.success('Receivable deleted');
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const filterColumns = [
    { field: 'customer_name', header: 'Customer', type: 'text' },
    { field: 'invoice_no', header: 'Invoice No', type: 'text' },
    { field: 'amount', header: 'Amount', type: 'number' },
    { field: 'amount_paid', header: 'Paid', type: 'number' },
    { field: 'balance', header: 'Balance', type: 'number' },
    { field: 'due_date', header: 'Due Date', type: 'date' },
    { field: 'payment_status', header: 'Payment Status', type: 'select', filterOptions: [
      { value: 'NOT_DUE', label: 'Not Due' }, { value: 'PARTIALLY_PAID', label: 'Partially Paid' },
      { value: 'PAID', label: 'Paid' }, { value: 'OVERDUE', label: 'Overdue' },
    ]},
  ];

  const fmt = (v) => formatCurrency(v);
  const fmtDate = (v) => v ? formatDate(v) : '-';

  const columns = [
    { field: 'invoice_no', header: 'Invoice No', sortable: true, width: '150px',
      render: (v, row) => row.invoice_reference ? <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/invoices/${row.invoice_reference}`); }} className="text-blue-700 hover:underline font-medium text-xs">{v}</button> : (v || '-') },
    { field: 'customer_name', header: 'Customer', sortable: true, width: '180px' },
    { field: 'company_name', header: 'Company', sortable: true, width: '140px',
      render: (v) => v || <span className="text-xs text-slate-400">-</span> },
    { field: 'amount', header: 'Amount', sortable: true, width: '120px', render: (v) => fmt(v) },
    { field: 'amount_paid', header: 'Paid', sortable: true, width: '100px',
      render: (v) => <span className="text-green-700">{fmt(v)}</span> },
    { field: 'balance', header: 'Balance', sortable: true, width: '100px',
      render: (v) => <span className={Number(v) > 0 ? 'text-orange-600 font-medium' : 'text-slate-400'}>{fmt(v)}</span> },
    { field: 'due_date', header: 'Due Date', sortable: true, width: '100px', render: (v) => fmtDate(v) },
    { field: 'payment_status', header: 'Status', sortable: true, width: '120px',
      render: (v) => <StatusBadge status={v} /> },
    { field: 'is_overdue', header: 'Overdue', sortable: true, width: '80px',
      render: (v) => v ? <span className="text-red-600 font-medium text-xs">OVERDUE</span> : <span className="text-slate-400">-</span> },
    { field: 'attachments', header: 'Photo Attachments', sortable: false, width: '140px',
      render: (_, row) => <ListAttachments attachments={attachmentMap[row.id]} /> },
    { field: 'actions', header: 'Actions', sortable: false, width: '140px',
      render: (_, row) => (
        <div className="flex items-center gap-1">
          <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/receivables/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="View"><Eye size={15} /></button>
          {/* Row-level Flow shortcut. Only shown when the row carries
              an SO reference (older receivables created before the
              SO-link backfill may lack it) AND the user has Sales
              Flow Dashboard view permission. Deep-links into the
              flow with this receivable's SO pre-selected. */}
          {canSeeFlow && (row.so_id || row.so_no) && (
            <button onClick={(e) => { e.stopPropagation(); openFlow(row.so_id || row.so_no); }}
              className="p-1.5 text-purple-600 hover:bg-purple-50 rounded" title="Flow"><GitBranch size={15} /></button>
          )}
          {/* Edit/Delete only while no payment has been recorded yet.
              Once the receivable is PARTIALLY_PAID or PAID the row is
              read-only (sales-module post-approval lock — a payment is
              the receivable equivalent of "approved"). */}
          {canEdit('Receivable') && !['PAID', 'PARTIALLY_PAID'].includes(row.payment_status) && (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/receivables/${row.id}/edit`); }}
              className="p-1.5 text-amber-600 hover:bg-amber-50 rounded" title="Edit"><Pencil size={15} /></button>
          )}
          {canDelete('Receivable') && !['PAID', 'PARTIALLY_PAID'].includes(row.payment_status) && (
            <button onClick={(e) => { e.stopPropagation(); handleDelete(row.id); }}
              className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Delete"><Trash2 size={15} /></button>
          )}
        </div>
      ),
    },
  ];

  // Strip columns the user's role HIDES via field permissions ('Receivable').
  // keyFor drops a trailing companion suffix (customer_name → customer). Never
  // drop the actions column or the primary identifier link (invoice_no).
  const keyForColumn = (field) => (field || '').replace(/_(name|code|display)$/, '');
  const fieldGatedColumns = columns.filter((c) => {
    if (c.field === 'actions' || c.field === 'invoice_no') return true;
    return !isHidden(keyForColumn(c.field));
  });

  const { mergedColumns, handleConfigApply, visibleFieldKeys } = useConfigureFields(fieldGatedColumns, 'receivables_fields', data);

  // Company options from the loaded rows.
  const companyOptions = useMemo(() => {
    const names = [...new Set((data || []).map(r => r.company_name).filter(Boolean))].sort();
    return names.map(n => ({ value: n, label: n }));
  }, [data]);

  // Customer options cascade to the selected Company filter — pick a company
  // and the Customer filter narrows to that company's customers.
  const customerOptions = useMemo(() => {
    const scoped = activeFilters.company_name
      ? (data || []).filter(r => (r.company_name || '') === activeFilters.company_name)
      : (data || []);
    const names = [...new Set(scoped.map(r => r.customer_name).filter(Boolean))].sort();
    return names.map(n => ({ value: n, label: n }));
  }, [data, activeFilters.company_name]);

  const filterOptions = [
    { key: 'company_name', label: 'Company', type: 'select', single: true, options: companyOptions },
    { key: 'customer_name', label: 'Customer', type: 'select', options: customerOptions },
    { key: 'payment_status', label: 'Payment Status', type: 'select', options: [
      { value: 'NOT_DUE', label: 'Not Due' },
      { value: 'PARTIALLY_PAID', label: 'Partially Paid' },
      { value: 'PAID', label: 'Paid' },
      { value: 'OVERDUE', label: 'Overdue' },
    ]},
    { key: 'due_from', label: 'Due Date From', type: 'date' },
    { key: 'due_to', label: 'Due Date To', type: 'date' },
  ];

  // Group receivables by invoice_reference — merge multiple entries per invoice into one row
  const groupedData = useMemo(() => {
    // `balance` / `payment_status` answer one narrower question: did CASH close
    // this bill? A bill cleared by a credit note, a TDS journal or money on
    // account stayed "Pending" here for ever, and this register disagreed with
    // the invoice's own page, with the Outstanding tile and with Tally. The API
    // already serves the honest pair (settled_balance / settled_status, cut
    // from unsettled_bills — see SettledStatusMixin); this page simply never
    // read them. `amount_paid` is left alone: it means cash received, and that
    // is still true.
    const all = (data || []).map(it => {
      if (it?.settled_balance === undefined || it?.settled_balance === null) return it;
      const bal = Number(it.settled_balance);
      const st = it.settled_status || it.payment_status;
      return {
        ...it,
        balance: bal,
        payment_status: st,
        is_overdue: st !== 'PAID' && bal > 0 && !!it.due_date
          && new Date(it.due_date) < new Date(),
      };
    });
    const invoiceMap = {};
    all.forEach(item => {
      const key = item.invoice_reference || item.id; // fallback to own id if no invoice ref
      if (!invoiceMap[key]) {
        invoiceMap[key] = {
          ...item,
          amount: Number(item.amount || 0),
          amount_paid: Number(item.amount_paid || 0),
          balance: Number(item.balance || 0),
          _entryIds: [item.id],
        };
      } else {
        const existing = invoiceMap[key];
        existing.amount += Number(item.amount || 0);
        existing.amount_paid += Number(item.amount_paid || 0);
        existing.balance += Number(item.balance || 0);
        existing._entryIds.push(item.id);
        // Use earliest due_date
        if (item.due_date && (!existing.due_date || item.due_date < existing.due_date)) {
          existing.due_date = item.due_date;
        }
        // Recalculate status based on merged totals
        if (existing.balance <= 0) existing.payment_status = 'PAID';
        else if (existing.amount_paid > 0) existing.payment_status = 'PARTIALLY_PAID';
        // Check overdue
        if (existing.payment_status !== 'PAID' && existing.due_date && new Date(existing.due_date) < new Date()) {
          existing.is_overdue = true;
          existing.payment_status = 'OVERDUE';
        }
      }
    });
    return Object.values(invoiceMap);
  }, [data]);

  // The window joins the tab and filters already kept in the address, so Back
  // from a bill and a refresh both land on the same view. replace:true: picking
  // a period is not a destination.
  useEffect(() => {
    const pp = new URLSearchParams(rsp);
    const put = (k, v, keep) => { if (keep) pp.set(k, v); else pp.delete(k); };
    const np = period.navProps;
    put('period', np.period, np.period && np.period !== 'all');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    put('rsort', regSort, regSort !== 'invoice_date');
    put('rdir', regDir, regDir !== 'asc');
    const next = pp.toString();
    if (next !== rsp.toString()) setRsp(pp, { replace: true });
  }, [period.navProps, regSort, regDir, rsp, setRsp]);

  const filteredData = (() => {
    let result = groupedData.filter((item) => {
      const t = skey(searchTerm);
      const matchesSearch = !t || [
        item.customer_name, item.invoice_no, item.invoice_reference,
        item.amount, item.amount_paid, item.balance, item.due_date,
        item.payment_status,
      ].some(v => v != null && skey(v).includes(t));
      const matchesCompany = !activeFilters.company_name
        || (item.company_name || '') === activeFilters.company_name;
      const matchesStatus = matchesSelect(item.payment_status, activeFilters.payment_status);
      const matchesCustomer = matchesSelect(item.customer_name, activeFilters.customer_name);
      // Due Date range (compare on the ISO YYYY-MM-DD prefix).
      const dd = (item.due_date || '').slice(0, 10);
      const matchesDueFrom = !activeFilters.due_from || (dd && dd >= activeFilters.due_from);
      const matchesDueTo = !activeFilters.due_to || (dd && dd <= activeFilters.due_to);
      return matchesSearch && matchesCompany && matchesStatus && matchesCustomer
        && matchesDueFrom && matchesDueTo
        && period.match(item.invoice_date);
    });
    if (advRules.length > 0) result = applyAdvancedFilters(result, advRules, advLogic);
    return result;
  })();

  // ── Bills vs Receipts ─────────────────────────────────────────────────
  // The register below answers "which bills are unpaid" — one row per invoice.
  // That is not what someone reconciling against Tally is looking at: Tally's
  // ledger lists RECEIPTS, and Bliss Corp is 23 bills but four receipts. This
  // toggle puts both views on the page; the receipt rows open the receipt page,
  // which breaks each one back down into the invoices it settled.
  const [mode, setMode] = useState(rsp.get('tab') === 'receipts' ? 'receipts' : 'bills');
  const [receipts, setReceipts] = useState([]);
  // Opening balance per customer, so the list can close with Tally's own three
  // figures. Sent with the rows because the filtering below is by name, on the
  // client — the server never learns which customer is on screen.
  const [openings, setOpenings] = useState({});
  // Invoices + debit notes − credit notes per customer. The closing balance is
  // meaningless without it — it is what they owe MINUS what they paid.
  const [billed, setBilled] = useState({});
  // Debit / credit notes, kept apart from invoices on purpose: the freight
  // note is the whole reason the unapplied money looks bigger than the
  // customer's credit, and folding it into the invoice line hides that.
  const [notes, setNotes] = useState({});
  const [receiptsLoading, setReceiptsLoading] = useState(false);
  useEffect(() => {
    if (mode !== 'receipts') return;
    let cancelled = false;
    setReceiptsLoading(true);
    apiClient.get('/api/sales/receivables/receipts/')
      .then(r => {
        if (cancelled) return;
        setReceipts(r.data?.rows || []);
        setOpenings(r.data?.openings || {});
        setBilled(r.data?.billed || {});
        setNotes(r.data?.notes || {});
      })
      .catch(() => {
        if (!cancelled) { setReceipts([]); setOpenings({}); setBilled({}); setNotes({}); }
      })
      .finally(() => { if (!cancelled) setReceiptsLoading(false); });
    return () => { cancelled = true; };
  }, [mode]);
  // Filtered by the SAME panel the bills register uses, on the same fields.
  // The panel holds company_name / customer_name — names, not ids — so an
  // id-based query silently matched nothing and every receipt in both
  // companies came through with "Bliss Corp" selected.
  const nrq = skey(searchTerm);
  // Click a column to sort; click it again to flip. Seeded from the URL so the
  // order you chose is still there when you come back from a receipt.
  const [rsort, setRsort] = useState(() => {
    const sp0 = new URLSearchParams(window.location.search);
    return { key: sp0.get('sk') || 'date', dir: sp0.get('sd') === 'asc' ? 'asc' : 'desc' };
  });
  const toggleSort = (key) => setRsort(p =>
    p.key === key ? { key, dir: p.dir === 'asc' ? 'desc' : 'asc' }
                  : { key, dir: key === 'date' ? 'desc' : 'asc' });
  const filteredReceipts = receipts.filter(r => {
    const matchesCompany = !activeFilters.company_name
      || (r.company_name || '') === activeFilters.company_name;
    const matchesCustomer = matchesSelect(r.customer_name, activeFilters.customer_name);
    const matchesSearch = !nrq
      || skey(`${r.date || ''} ${r.label || ''} ${r.customer_name || ''} ${Number(r.total || 0)}`)
           .includes(nrq);
    return matchesCompany && matchesCustomer && matchesSearch;
  }).sort((a, b) => {
    const NUM = { total: 1, applied: 1, unapplied: 1, invoice_count: 1 };
    const k = rsort.key;
    const av = NUM[k] ? Number(a[k] || 0) : String(a[k] || '').toLowerCase();
    const bv = NUM[k] ? Number(b[k] || 0) : String(b[k] || '').toLowerCase();
    if (av === bv) return 0;
    return (av < bv ? -1 : 1) * (rsort.dir === 'asc' ? 1 : -1);
  });

  // Tally's ledger foot — Opening Balance / Current Total / Closing Balance —
  // shown always, for whatever is on screen. With one customer picked these are
  // that party's own three figures and match Tally line for line; with several,
  // they are the same three added across exactly the parties listed, the way
  // Tally totals a group. Each customer's opening is counted ONCE however many
  // receipts they have, which is why this walks a Set of names rather than the
  // rows.
  const rcptFoot = (() => {
    // Keyed by customer id, not name: both companies have a customer called
    // "Greenstar Fertilisers Limited -  North", and matching on the name added
    // one company's opening and invoices to the other's.
    const seen = new Set();
    let opening = 0, bills = 0, dn = 0;
    for (const r of filteredReceipts) {
      const id = r.customer_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      opening += Number(openings[id] || 0);
      bills += Number(billed[id] || 0);
      dn += Number(notes[id] || 0);
    }
    const received = filteredReceipts.reduce((s, r) => s + Number(r.total || 0), 0);
    // Tally's arithmetic: what they owed coming in, plus everything billed,
    // less what they paid. Positive = still owed, negative = money we hold.
    return { opening, bills, dn, received, closing: opening + bills + dn - received };
  })();

  // ── Receipts list pagination ──────────────────────────────────────────
  // The Bills Outstanding register has always paged; the Receipts list rendered
  // all 600+ rows in one scroll. Same 10-a-page treatment now. The footer totals
  // stay the FULL-period figures (opening / billed / received / closing), not a
  // per-page sum, so the closing balance still reconciles to Tally.
  const RCPT_PAGE_SIZE = 15;
  const [rcptPage, setRcptPage] = useState(1);
  const rcptTotalPages = Math.max(1, Math.ceil(filteredReceipts.length / RCPT_PAGE_SIZE));
  const rcptCp = Math.min(rcptPage, rcptTotalPages);
  const rcptPageRows = filteredReceipts.slice((rcptCp - 1) * RCPT_PAGE_SIZE, rcptCp * RCPT_PAGE_SIZE);

  // ── Tally "Bills Outstanding" register (desktop) ──────────────────────
  const RCV_PAGE_SIZE = 15;
  const rcvTotals = filteredData.reduce((a, r) => ({
    amount: a.amount + Number(r.amount || 0),
    paid: a.paid + Number(r.amount_paid || 0),
    balance: a.balance + Number(r.balance || 0),
  }), { amount: 0, paid: 0, balance: 0 });
  const rcvTotalPages = Math.max(1, Math.ceil(filteredData.length / RCV_PAGE_SIZE));
  const rcvPage = Math.min(page, rcvTotalPages);
  usePagerKeys({   // ← / → page the Bills Outstanding list (bills tab only)
    enabled: mode === 'bills' && rcvTotalPages > 1,
    onPrev: () => setPage(Math.max(1, rcvPage - 1)),
    onNext: () => setPage(Math.min(rcvTotalPages, rcvPage + 1)),
  });
  // Sorted before paging, so page 1 really is the first rows of the order and
  // not the first rows of the fetch re-shuffled. Amounts compare as numbers;
  // everything else as text with numeric collation, which orders the ISO dates
  // chronologically. Blanks go last in both directions.
  const rcvSorted = (() => {
    if (!regSort) return filteredData;
    const dir = regDir === 'desc' ? -1 : 1;
    const blank = (v) => v === null || v === undefined || v === '';
    return [...filteredData].sort((a, b) => {
      const av = a[regSort], bv = b[regSort];
      if (blank(av) && blank(bv)) return 0;
      if (blank(av)) return 1;
      if (blank(bv)) return -1;
      const an = Number(av), bn = Number(bv);
      if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  })();
  const rcvPageRows = rcvSorted.slice((rcvPage - 1) * RCV_PAGE_SIZE, rcvPage * RCV_PAGE_SIZE);
  // One header cell of the register. Defined here rather than at module level
  // so it can read regSort / regDir directly.
  const RegTh = ({ field, label, align = 'left' }) => (
    <th className={`${{ left: 'text-left', right: 'text-right', center: 'text-center' }[align]} font-semibold px-3 py-2.5 whitespace-nowrap`}>
      <button type="button" onClick={() => toggleRegSort(field)}
        title={`Sort by ${label}`}
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-700 ${regSort === field ? 'text-slate-700' : ''}`}>
        {label}
        {regSort === field && (
          <ChevronDown size={12} className={regDir === 'asc' ? 'rotate-180' : ''} />
        )}
      </button>
    </th>
  );

  // Days a bill is overdue (only when it still has a pending balance).
  const overdueDays = (row) => {
    if (Number(row.balance) <= 0 || !row.due_date) return 0;
    const d = Math.floor((Date.now() - new Date(row.due_date).getTime()) / 86400000);
    return d > 0 ? d : 0;
  };
  // Reset to first page whenever the result set changes.
  useEffect(() => { setPage(1); }, [searchTerm, activeFilters, advRules]);

  const exportBillsOutstanding = () => {
    const rows = filteredData.map(r => ({
      date: r.invoice_date || '', ref: r.invoice_no || '', party: r.customer_name || '',
      company: r.company_name || '', amount: Number(r.amount || 0).toFixed(2),
      received: Number(r.amount_paid || 0).toFixed(2), pending: Number(r.balance || 0).toFixed(2),
      due: r.due_date || '', overdue: overdueDays(r) || '', status: r.payment_status || '',
    }));
    rows.push({ date: '', ref: '', party: '', company: 'GRAND TOTAL',
      amount: rcvTotals.amount.toFixed(2), received: rcvTotals.paid.toFixed(2),
      pending: rcvTotals.balance.toFixed(2), due: '', overdue: '', status: '' });
    exportToExcel(rows, [
      { field: 'date', header: 'Date' }, { field: 'ref', header: 'Ref No' },
      { field: 'party', header: 'Party' }, { field: 'company', header: 'Company' },
      { field: 'amount', header: 'Bill Amount (₹)' }, { field: 'received', header: 'Received (₹)' },
      { field: 'pending', header: 'Pending (₹)' }, { field: 'due', header: 'Due Date' },
      { field: 'overdue', header: 'Overdue (days)' }, { field: 'status', header: 'Status' },
    ], `receivables-bills-outstanding-${new Date().toISOString().slice(0, 10)}`);
    toast.success('Bills Outstanding exported!');
  };

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-x-2 sm:gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 sm:min-w-[15rem] flex items-center gap-1.5">
            <BackToModule />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900 truncate lg:whitespace-normal lg:overflow-visible">Receivable Ledger</h1>
              <p className="hidden sm:block text-slate-600 mt-1 text-sm sm:text-base">Track customer receivables and overdue payments</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 shrink-0">
            {/* Generic "Flow" header button removed — it duplicated
                the sidebar Flow Dashboard entry without deep-linking
                to any specific record. Use the row-level Flow icon
                on SO / CPO / DC / Invoice list pages to enter the
                flow with the correct record pre-selected. */}
            {/* Ledger moved to its own Sales nav page ("Customer Ledger", /sales/ledger). */}
            {canCreate('Receivable') && (
              <>
                {/* Mirror of the Payments Made import: happens HERE, in a
                    modal, and the receipts land in this list. Only the credit
                    (money-in) rows are shown. No reconciliation — the
                    statement is simply the source of the receipts. */}
                <button onClick={() => setShowImport(true)}
                  title="Import a bank statement (CSV/Excel/PDF) and record the receipts in it"
                  className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition">
                  <Upload size={18} /> <span className="hidden sm:inline">Import Statement</span>
                </button>
                <button onClick={() => setShowBulkModal(true)} title="Bulk Entry" aria-label="Bulk Entry" className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border border-blue-300 rounded-lg text-sm font-medium text-blue-700 hover:bg-blue-50 transition"><Layers size={18} /> <span className="hidden sm:inline">Bulk Entry</span></button>
                <button onClick={() => navigate('/sales/receivables/new')} className="flex items-center gap-2 px-3 sm:px-6 py-2 sm:py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm sm:text-base font-medium"><Plus size={18} /> New Entry</button>
              </>
            )}
          </div>
        </div>

        {/* The period row the other sales lists carry. This page had no date
            filter at all. */}
        <div className="flex flex-wrap items-center gap-2">
          <PeriodNavigator allowAll {...period.navProps} />
          <div className="relative">
            <button type="button" onClick={() => setFieldsOpen(o => !o)}
              title="Choose columns" aria-label="Choose columns"
              aria-haspopup="true" aria-expanded={fieldsOpen}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${CTRL_H} ${fieldsOpen ? 'bg-primary-50 text-primary-700 border-primary-300' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
              <Settings2 size={15} /> Fields
              <ChevronDown size={13} className={`transition-transform ${fieldsOpen ? 'rotate-180' : ''}`} />
            </button>
            {fieldsOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setFieldsOpen(false)} />
                <div className="absolute z-30 mt-1 w-60 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg py-1">
                  {mergedColumns.map((c) => {
                    const on = visibleFieldKeys.includes(c.field);
                    return (
                      <label key={c.field}
                        className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 cursor-pointer">
                        <input type="checkbox" checked={on} className="accent-primary-600"
                          onChange={() => handleConfigApply(
                            on ? visibleFieldKeys.filter((k) => k !== c.field)
                               : [...visibleFieldKeys, c.field])} />
                        <span className="truncate">{c.header || c.field}</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          {period.range && (
            <button type="button" className="text-xs text-slate-500 hover:text-slate-800 underline"
              onClick={() => period.navProps.setPeriod('all')}>
              Clear
            </button>
          )}
        </div>

        <ListState error={error} onRetry={refetch}>
        <MobileListCards
          rows={filteredData}
          isLoading={isLoading}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          searchPlaceholder="Search ledger, customer, invoice…"
          onRowClick={(row) => navigate(`/sales/receivables/${row.id}`)}
          emptyMessage="No receivables found"
          config={{
            title: (row) => row.ledger_id || row.invoice_no || `Receivable #${row.id}`,
            subtitle: (row) => row.customer_name,
            badge: (row) => {
              const s = row.payment_status;
              const map = {
                PENDING:         { label: 'Pending',  cls: 'bg-amber-100 text-amber-800 border-amber-300' },
                PARTIAL:         { label: 'Partial',  cls: 'bg-blue-100 text-blue-800 border-blue-300' },
                PAID:            { label: 'Paid',     cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
                OVERDUE:         { label: 'Overdue',  cls: 'bg-red-100 text-red-700 border-red-300' },
                WRITE_OFF:       { label: 'Write-off',cls: 'bg-slate-200 text-slate-700 border-slate-300' },
              };
              return map[s] || { label: s || '-', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
            },
            fields: (row) => [
              { label: 'Invoice', value: row.invoice_no },
              { label: 'Due',     value: fmtDate(row.due_date) },
              { label: 'Amount',  value: row.amount != null ? formatCurrency(row.amount) : null, cls: 'text-slate-800 font-medium' },
              { label: 'Balance', value: row.balance != null ? formatCurrency(row.balance) : null, cls: 'text-red-700 font-medium' },
            ],
            actions: (row) => [
              { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/sales/receivables/${row.id}`) },
            ],
          }}
        />

        {/* Desktop — Tally-style "Bills Outstanding" register */}
        <div className="hidden sm:block bg-white rounded-lg border border-slate-300 shadow-sm overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-200 bg-slate-50">
            <div className="flex items-center gap-3 min-w-0">
              {/* One dropdown instead of two buttons. Same `mode` values, so
                  which register is shown and how it is exported are unchanged;
                  the count beside it still reports the visible list. */}
              <CustomSelect value={mode} onChange={(e) => setMode(e.target.value)} title="Register"
                className="border border-slate-300 rounded-md px-2 py-1 text-sm bg-white max-w-[200px]">
                <option value="bills">Bills Outstanding</option>
                <option value="receipts">Receipts</option>
              </CustomSelect>
              <span className="text-xs text-slate-400">
                {mode === 'bills'
                  ? `${filteredData.length} bill(s)`
                  : `${filteredReceipts.length} receipt(s)`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Search bill, party…"
                  className="w-52 border border-slate-300 rounded-md pl-8 pr-7 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-blue-400" />
                {searchTerm && <button onClick={() => setSearchTerm('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={13} /></button>}
              </div>
              {canExport('Receivable') && (
                <button onClick={exportBillsOutstanding} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-md text-xs font-medium hover:bg-emerald-700">
                  <FileText size={13} /> Export
                </button>
              )}
            </div>
          </div>
          {/* Receipts — one row per Tally voucher. Click through to see which
              invoices that money settled. */}
          {mode === 'receipts' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                    {[['date', 'Date', 'left'], ['label', 'Receipt', 'left'],
                      ['customer_name', 'Party', 'left'], ['total', 'Receipt Amount', 'right'],
                      ['applied', 'Applied', 'right'], ['unapplied', 'Not Applied', 'right'],
                      ['invoice_count', 'Invoices', 'right']].map(([k, label, align]) => (
                      <th key={k}
                        onClick={() => toggleSort(k)}
                        title="Sort"
                        className={`text-${align} font-semibold px-3 py-2.5 whitespace-nowrap cursor-pointer select-none hover:text-slate-700`}>
                        {label}
                        <span className={`ml-1 ${rsort.key === k ? 'text-blue-600' : 'text-slate-300'}`}>
                          {rsort.key === k ? (rsort.dir === 'asc' ? '▲' : '▼') : '▲'}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {receiptsLoading && (
                    <tr><td colSpan={7} className="px-3 py-10 text-center text-slate-500">Loading…</td></tr>
                  )}
                  {!receiptsLoading && !filteredReceipts.length && (
                    <tr><td colSpan={7} className="px-3 py-10 text-center text-slate-500">No receipts found.</td></tr>
                  )}
                  {!receiptsLoading && filteredReceipts.map(r => (
                    <tr key={r.id}
                      onClick={() => {
                        const back = new URLSearchParams({ tab: 'receipts' });
                        if (activeFilters.company_name) back.set('company_name', activeFilters.company_name);
                        if (activeFilters.customer_name) back.set('customer_name', activeFilters.customer_name);
                        if (searchTerm) back.set('q', searchTerm);
                        back.set('sk', rsort.key); back.set('sd', rsort.dir);
                        navigate(
                          `/sales/receivables/receipt/${encodeURIComponent(r.id)}` +
                          (r.customer_id ? `?customer=${r.customer_id}` : ''),
                          { state: { backTo: `/sales/receivables?${back.toString()}` } });
                      }}
                      className="border-b border-slate-100 odd:bg-white even:bg-slate-50/50 hover:bg-indigo-50/50 cursor-pointer">
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">{r.date ? formatDate(r.date) : '—'}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-blue-700 font-medium">{r.label || 'Receipt'}</td>
                      <td className="px-3 py-2.5 text-slate-700 max-w-[260px] truncate" title={r.customer_name}>{r.customer_name || '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-800 whitespace-nowrap">{formatCurrency(r.total)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700 whitespace-nowrap">{formatCurrency(r.applied)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${Number(r.unapplied) ? 'text-amber-700 font-medium' : 'text-slate-300'}`}>
                        {Number(r.unapplied) ? formatCurrency(r.unapplied) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap">{r.invoice_count || '—'}</td>
                    </tr>
                  ))}
                </tbody>
                {/* The closing balance Tally shows, reached the way Tally reaches
                    it: opening, plus what we billed, less what they paid. The
                    first version listed only the receipts and called their total
                    a closing balance — Bliss Corp read Rs 3,42,96,174 where Tally
                    closes at Rs 25,00,000. Billed is spelled out as its own line
                    so the subtraction is visible rather than assumed. */}
                {!receiptsLoading && !!filteredReceipts.length && (
                  <tfoot className="border-t-2 border-slate-300 bg-slate-50">
                    {[['Opening Balance', rcptFoot.opening, false],
                      ['Invoices', rcptFoot.bills, false],
                      ['Notes & adjustments (freight, exchange, etc.)', rcptFoot.dn, false],
                      ['Received', rcptFoot.received, false],
                      [rcptFoot.closing < 0 ? 'Closing Balance (their credit)' : 'Closing Balance',
                       Math.abs(rcptFoot.closing), true]].map(
                      ([lbl, val, last]) => (
                        <tr key={lbl} className={last ? 'border-t border-slate-200' : ''}>
                          <td colSpan={3} className={`px-3 py-1.5 text-right text-slate-600 ${last ? 'font-semibold' : ''}`}>
                            {lbl} :
                          </td>
                          <td className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap font-semibold ${
                            last && rcptFoot.closing < 0 ? 'text-emerald-700' : 'text-slate-900'}`}>
                            {formatCurrency(val)}
                          </td>
                          <td colSpan={3} />
                        </tr>
                      ))}
                  </tfoot>
                )}
              </table>
            </div>
          )}

          {/* Register */}
          <div className={`overflow-x-auto ${mode === 'receipts' ? 'hidden' : ''}`}>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                  {/* Click to sort; click again to reverse. The arrow shows on
                      the active column only, so the header row stays quiet. */}
                  <RegTh field="invoice_date" label="Date" />
                  <RegTh field="invoice_no" label="Ref No" />
                  <RegTh field="customer_name" label="Party" />
                  <RegTh field="company_name" label="Company" />
                  <RegTh field="amount" label="Bill Amount" align="right" />
                  <RegTh field="amount_paid" label="Received" align="right" />
                  <RegTh field="balance" label="Pending" align="right" />
                  <RegTh field="due_date" label="Due Date" align="center" />
                  <th className="text-center font-semibold px-3 py-2.5 whitespace-nowrap">Overdue</th>
                  <th className="text-center font-semibold px-3 py-2.5 whitespace-nowrap">Status</th>
                  <th className="text-center font-semibold px-3 py-2.5 whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && [0, 1, 2, 3, 4, 5].map(i => (
                  <tr key={i} className="border-b border-slate-100 animate-pulse">
                    <td colSpan={11} className="px-3 py-3"><div className="h-3 bg-slate-100 rounded w-full" /></td>
                  </tr>
                ))}
                {!isLoading && rcvPageRows.map(row => {
                  const od = overdueDays(row);
                  return (
                    <tr key={row.id} onClick={() => navigate(`/sales/receivables/${row.id}`)}
                      className="border-b border-slate-100 odd:bg-white even:bg-slate-50/50 hover:bg-amber-50/60 cursor-pointer transition-colors">
                      <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">{fmtDate(row.invoice_date)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {row.invoice_reference
                          ? <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/invoices/${row.invoice_reference}`); }} className="text-blue-700 hover:underline font-medium">{row.invoice_no || '-'}</button>
                          : <span className="text-slate-700">{row.invoice_no || '-'}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-slate-800 font-medium max-w-[220px] truncate" title={row.customer_name}>{row.customer_name || '-'}</td>
                      <td className="px-3 py-2.5 text-slate-500 text-sm max-w-[150px] truncate" title={row.company_name}>{row.company_name || '-'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 whitespace-nowrap">{fmt(row.amount)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700 whitespace-nowrap">{fmt(row.amount_paid)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums font-semibold whitespace-nowrap ${Number(row.balance) > 0 ? 'text-orange-700' : 'text-slate-400'}`}>{fmt(row.balance)}</td>
                      <td className="px-3 py-2.5 text-center text-slate-600 whitespace-nowrap">{fmtDate(row.due_date)}</td>
                      <td className="px-3 py-2.5 text-center whitespace-nowrap">
                        {od > 0 ? <span className="text-red-600 font-medium">{od} day{od > 1 ? 's' : ''}</span> : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center"><StatusBadge status={row.payment_status} /></td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => navigate(`/sales/receivables/${row.id}`)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="View"><Eye size={15} /></button>
                          {canSeeFlow && (row.so_id || row.so_no) && (
                            <button onClick={() => openFlow(row.so_id || row.so_no)} className="p-1.5 text-purple-600 hover:bg-purple-50 rounded" title="Flow"><GitBranch size={15} /></button>
                          )}
                          {canEdit('Receivable') && !['PAID', 'PARTIALLY_PAID'].includes(row.payment_status) && (
                            <button onClick={() => navigate(`/sales/receivables/${row.id}/edit`)} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded" title="Edit"><Pencil size={15} /></button>
                          )}
                          {canDelete('Receivable') && !['PAID', 'PARTIALLY_PAID'].includes(row.payment_status) && (
                            <button onClick={() => handleDelete(row.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Delete"><Trash2 size={15} /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!isLoading && rcvPageRows.length === 0 && (
                  <tr><td colSpan={11} className="px-3 py-12 text-center text-slate-400">No receivables found</td></tr>
                )}
              </tbody>
              {!isLoading && filteredData.length > 0 && (
                <tfoot>
                  <tr className="bg-slate-100 font-bold border-t-2 border-slate-300">
                    <td colSpan={4} className="px-3 py-2.5 text-right text-slate-700 whitespace-nowrap">Grand Total · {filteredData.length} bill(s)</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-800 whitespace-nowrap">{fmt(rcvTotals.amount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700 whitespace-nowrap">{fmt(rcvTotals.paid)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-orange-700 whitespace-nowrap">{fmt(rcvTotals.balance)}</td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {/* Pagination — numbered pages with arrows (old style).
              Bills only: the receipts view is one page. */}
          {mode === 'bills' && filteredData.length > RCV_PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-200 text-sm text-slate-500">
              <span className="text-xs sm:text-sm">Showing {(rcvPage - 1) * RCV_PAGE_SIZE + 1} to {Math.min(rcvPage * RCV_PAGE_SIZE, filteredData.length)} of {filteredData.length} results</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setPage(rcvPage - 1)} disabled={rcvPage <= 1}
                  className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page">
                  <ChevronLeft size={16} />
                </button>
                {(() => {
                  // Compact page list: 1 … around-current … last
                  const tp = rcvTotalPages, cur = rcvPage;
                  const pages = [];
                  const push = (p) => { if (!pages.includes(p) && p >= 1 && p <= tp) pages.push(p); };
                  push(1); push(2);
                  for (let p = cur - 1; p <= cur + 1; p++) push(p);
                  push(tp - 1); push(tp);
                  const sorted = [...new Set(pages)].sort((a, b) => a - b);
                  const out = [];
                  sorted.forEach((p, i) => {
                    if (i > 0 && p - sorted[i - 1] > 1) out.push(`gap-${p}`);
                    out.push(p);
                  });
                  return out.map(tok => typeof tok === 'string'
                    ? <span key={tok} className="px-1.5 text-slate-400">…</span>
                    : (
                      <button key={tok} onClick={() => setPage(tok)}
                        className={`min-w-[34px] px-2.5 py-1.5 rounded-lg border text-sm font-medium transition ${tok === cur ? 'bg-blue-600 text-white border-blue-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                        {tok}
                      </button>
                    ));
                })()}
                <button onClick={() => setPage(rcvPage + 1)} disabled={rcvPage >= rcvTotalPages}
                  className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page">
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
        </ListState>
      </div>
      {showBulkModal && <BulkReceivableModal onClose={() => setShowBulkModal(false)} onSuccess={refetch} />}
      {showImport && (
        <ImportStatementModal
          side="credit"
          onClose={() => setShowImport(false)}
          onRecorded={refetch}
        />
      )}
      {FlowPopup}
    </MainLayout>
  );
}

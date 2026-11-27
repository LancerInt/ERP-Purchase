import CustomSelect from "@/components/ui/CustomSelect";
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import MainLayout from '../../components/layout/MainLayout';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import StatusBadge from '../../components/common/StatusBadge';
import usePermissions from '../../hooks/usePermissions.js';
import useFieldPermissions from '../../hooks/useFieldPermissions.js';
import apiClient from '../../utils/api.js';
import useLookup from '../../hooks/useLookup.js';
import { useUrlState } from '../../hooks/useUrlState.js';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';
import { CTRL_SEG, CTRL_SEG_ITEM, CTRL_FIELD, CTRL_ROW } from '@/components/common/controls';
import toast from 'react-hot-toast';
import { Pencil, Trash2, Eye, Truck, ArrowDownLeft, ArrowUpRight, IndianRupee, Clock, CheckCircle, CheckCircle2, AlertTriangle, CreditCard, Paperclip, X, RefreshCw, Upload, Loader2 } from 'lucide-react';
import MobileListCards from './components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import { formatDate, formatCurrency } from '@/utils/formatters';

const fmt = (v) => { const n = Number(v || 0); return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 === 0 ? 0 : 2 })}`; };
const fmtDate = (d) => d ? formatDate(d) : '-';

// Roles allowed to approve a Freight Advice (Inbound).
const FREIGHT_APPROVE_ROLES = new Set(['admin', 'administrator', 'purchase manager']);

export default function UnifiedFreightList() {
  const navigate = useNavigate();
  const location = useLocation();
  // Each freight kind has its own dedicated list URL:
  //   /freight/inward   → Inward (Purchase) only
  //   /freight/outward  → Outward (Sales) only
  // The old unified /freight view was removed; the route now redirects
  // to /freight/inward. lockedDirection drives the title, the create
  // CTA target, and hides the Freight Type filter dropdown.
  const lockedDirection =
    location.pathname.startsWith('/freight/outward') ? 'Sales' : 'Purchase';
  const { canCreate, canEdit, canDelete, isAdmin, isSuperuser, role, canExport } = usePermissions();
  // Field-level column visibility for the Inward (Freight Advice) list.
  const { isHidden } = useFieldPermissions('Freight Advice');
  const _roleName = (role?.role_name || role?.name || '').trim().toLowerCase();
  const canApproveFreight = isAdmin || isSuperuser || FREIGHT_APPROVE_ROLES.has(_roleName);
  const [purchaseData, setPurchaseData] = useState([]);
  const [salesData, setSalesData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [attachmentModal, setAttachmentModal] = useState(null); // { freightId, attachments }
  const [loadingAttachments, setLoadingAttachments] = useState(false);
  // Upload Register (Excel/CSV, outward) + per-row slip upload
  const { options: companyOptions } = useLookup('/api/companies/');
  const [showUpload, setShowUpload] = useState(false);
  const [uploadCompany, setUploadCompany] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadingAttach, setUploadingAttach] = useState(false);

  // Domain filters live in the URL so Back from a detail (and refresh / sharing)
  // restores the SAME view instead of resetting to "All". Each freight route has
  // its own path, so inward / outward keep independent filter sets naturally.
  const [directionFilter, setDirectionFilter] = useUrlState('direction', '');
  const [statusFilter, setStatusFilter] = useUrlState('status', '');
  // Standard period navigator (All / Today / Week / Month / FY / Custom).
  const period = usePeriodFilter('all');
  const [search, setSearch] = useState('');
  // Inward freight source split: all | INVOICE_INCLUDED (freight inside the goods
  // bill) | SEPARATE_SLIP (its own slip). Only shown on the inward/purchase page.
  const [sourceFilter, setSourceFilter] = useUrlState('source', 'all');
  // Company comes from the GLOBAL header filter. The freight list filters by
  // company NAME, so translate the global company id → its legal name. '' = All.
  const { company: globalCompany, companies: globalCompanies } = useGlobalCompany();
  const companyName = globalCompany
    ? ((globalCompanies || []).find((c) => String(c.id) === String(globalCompany))?.legal_name
       || (globalCompanies || []).find((c) => String(c.id) === String(globalCompany))?.trade_name
       || '')
    : '';

  // Fetch EVERY page — the list paginates at 100, so a single request would drop
  // records (e.g. hide April freight behind newer months). Pull page_size=1000 and
  // follow `next` until exhausted so the whole list is available to filter/sort.
  const fetchAll = async (path) => {
    const out = [];
    let page = 1;
    for (let guard = 0; guard < 50; guard += 1) {
      const r = await apiClient.get(path, { params: { page_size: 1000, page } }).catch(() => null);
      if (!r) break;
      const d = r.data;
      if (Array.isArray(d)) { out.push(...d); break; }   // non-paginated response
      out.push(...(d?.results || []));
      if (!d?.next) break;
      page += 1;
    }
    return out;
  };

  const fetchData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Fetch only the side this page owns — Inward = purchase, Outward = sales.
      if (lockedDirection === 'Sales') {
        setPurchaseData([]);
        setSalesData(await fetchAll('/api/sales/freight/'));
      } else {
        setPurchaseData(await fetchAll('/api/purchase/freight/'));
        setSalesData([]);
      }
    } catch {
      setError('Failed to load freight data');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [lockedDirection]);

  const isSales = lockedDirection === 'Sales';
  const attachEndpoint = (dirKey) => (dirKey === 'sales' || isSales) ? '/api/sales/attachments/' : '/api/purchase/attachments/';

  // Upload an outward-freight register (Excel/CSV) -> creates freights + payments.
  const doUpload = async () => {
    if (!uploadCompany) { toast.error('Pick a company first.'); return; }
    if (!uploadFile) { toast.error('Choose an Excel / CSV file.'); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', uploadFile); fd.append('company', uploadCompany);
      const r = await apiClient.post('/api/sales/freight/import-register/', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const s = r.data || {};
      toast.success(`Loaded ${s.freights} freight(s)${s.rebuilt ? ` (${s.rebuilt} updated)` : ''}, ${s.payments} payment(s), ${s.new_transporters} new transporter(s).`);
      setShowUpload(false); setUploadFile(null); fetchData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed — check the file.');
    } finally { setUploading(false); }
  };

  // Attach a scanned slip (img/PDF) to the freight open in the attachment modal.
  const uploadAttachment = async (file) => {
    if (!file || !attachmentModal) return;
    setUploadingAttach(true);
    try {
      const ep = attachmentModal.endpoint || attachEndpoint();
      const fd = new FormData();
      fd.append('module', 'FREIGHT'); fd.append('record_id', attachmentModal.freightId); fd.append('file', file);
      await apiClient.post(ep, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Slip attached.');
      const res = await apiClient.get(`${ep}?module=FREIGHT&record_id=${attachmentModal.freightId}`).catch(() => ({ data: [] }));
      const allFiles = (res.data?.results || res.data || []).map((f) => ({ ...f, _source: 'Freight' }));
      setAttachmentModal((m) => (m ? { ...m, attachments: allFiles } : m));
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Could not attach the slip.');
    } finally { setUploadingAttach(false); }
  };

  // Normalize both datasets into unified format
  const unifiedData = useMemo(() => {
    const purchaseNormalized = purchaseData.map(f => ({
      id: f.id,
      direction: 'Purchase',
      direction_key: 'purchase',
      company_name: f.company_name || '',
      advice_no: f.advice_no || '-',
      // Where it came from — Tally voucher vs entered in the ERP (like Bills).
      source_origin: f.source_origin || 'ERP',
      freight_source: f.freight_source || 'SEPARATE_SLIP',
      freight_source_display: f.freight_source_display || '',
      vendor_bill_no: f.vendor_bill_no || '',
      // Date the row by the actual freight date (matches Zoho/Tally + the sales
      // side); fall back to when it was created only if freight has no date.
      // Otherwise imported past-dated freight would file under today's date.
      date: f.freight_date || f.created_date || f.dispatch_date || '',
      receipt_date: f.receipt_date || f.created_date || '',
      reference: f.receipt_advice_no || '-',
      reference_type: 'Receipt Advice',
      reference_id: f.receipt_advice,
      reference_link: f.receipt_advice ? `/purchase/receipts/${f.receipt_advice}` : null,
      party_name: f.vendor_name || '-',
      party_type: 'Vendor',
      transporter_name: f.transporter_name || '-',
      // Show the vehicle no only when the freight links to a real bill (matches the
      // detail page). Unlinked freight shows no lone vehicle number.
      vehicle_no: (f.bill_linked && f.lorry_no) ? f.lorry_no : '-',
      driver_name: f.driver_name || '-',
      driver_contact: f.driver_contact || '-',
      from_location: f.destination_state || '-',
      to_location: f.warehouse_name || '-',
      dispatch_date: f.dispatch_date || '',
      delivery_date: f.expected_arrival_date || f.actual_arrival_date || '',
      freight_charge: Number(f.base_amount) || 0,
      loading_charge: Number(f.loading_wages_amount) || 0,
      unloading_charge: Number(f.unloading_wages_amount) || 0,
      additional_charges: Number(f.other_charges) || 0,
      total_amount: Number(f.total_freight_cost) || Number(f.payable_amount) || 0,
      total_paid: Number(f.total_paid) || 0,
      balance: Number(f.balance) || 0,
      payment_status: (() => {
        const paid = Number(f.total_paid) || 0;
        const payable = Number(f.payable_amount) || Number(f.total_freight_cost) || 0;
        if (paid <= 0) return '';
        if (paid >= payable) return 'Paid';
        return 'Partially Paid';
      })(),
      status: f.status_display || f.status || '-',
      status_raw: f.status || '',
      freight_terms: f.freight_terms_display || f.freight_terms || '-',
      freight_terms_raw: (f.freight_terms || '').toUpperCase(),
      remarks: f.remarks || '',
    }));

    const salesNormalized = salesData.map(f => ({
      id: f.id,
      direction: 'Sales',
      direction_key: 'sales',
      company_name: f.company_name || '',
      advice_no: f.advice_no || '-',
      source_origin: f.source_origin || 'ERP',
      freight_source: 'SEPARATE_SLIP',
      vendor_bill_no: '',
      date: f.freight_date || f.created_date || '',
      reference: f.freight_detail ? `FD-${f.freight_detail}` : '-',
      reference_type: 'Freight Detail',
      reference_id: f.freight_detail,
      // Open the unified freight record (route /freight/sales/:id), keyed on the
      // freight row id — the legacy /sales/freight-details/:id page was de-routed.
      reference_link: `/freight/sales/${f.id}`,
      party_name: f.customer_name || '-',
      party_type: 'Customer',
      transporter_name: f.transporter_name || '-',
      vehicle_no: f.lorry_no || '-',
      driver_name: '-',
      driver_contact: '-',
      from_location: '-',
      to_location: f.destination || '-',
      dispatch_date: f.freight_date || '',
      delivery_date: f.invoice_date || '',
      freight_charge: Number(f.base_amount) || 0,
      loading_charge: 0,
      unloading_charge: Number(f.unloading_charges) || Number(f.unloading_wages_amount) || 0,
      additional_charges: 0,
      total_amount: Number(f.payable_amount) || 0,
      total_paid: Number(f.total_paid) || 0,
      balance: Number(f.balance) || 0,
      payment_status: (() => {
        const paid = Number(f.total_paid) || 0;
        const payable = Number(f.payable_amount) || 0;
        if (paid <= 0) return '';
        if (paid >= payable) return 'Paid';
        return 'Partially Paid';
      })(),
      status: f.status || '-',
      status_raw: f.status || '',
      freight_terms: f.freight_terms_display || f.freight_terms || '-',
      freight_terms_raw: (f.freight_terms || '').toUpperCase(),
      remarks: f.remarks || '',
      dc_count: f.dc_count || 0,
    }));

    return [...purchaseNormalized, ...salesNormalized];
  }, [purchaseData, salesData]);

  // Apply filters. When the route locks the direction (the dedicated
  // /freight/inward or /freight/outward pages), `lockedDirection`
  // wins regardless of the dropdown state — the dropdown itself is
  // hidden on those routes, so this is just defence-in-depth.
  const filtered = useMemo(() => {
    let result = unifiedData;
    const effectiveDirection = lockedDirection || directionFilter;
    if (effectiveDirection) result = result.filter(f => f.direction === effectiveDirection);
    if (statusFilter) result = result.filter(f => f.status_raw === statusFilter);
    if (companyName) {
      // Tolerant company match — the toggle sends a company's full legal name, but
      // rows may carry legal_name / trade_name / a differently-cased string. Match
      // on the distinctive token (biochem / united agro) so format never breaks it.
      const pick = companyName.toLowerCase();
      const token = /biochem/.test(pick) ? 'biochem' : (/united\s*agro/.test(pick) ? 'united agro' : null);
      result = result.filter(f => {
        const rn = (f.company_name || '').toLowerCase();
        if (!rn) return false;
        return token ? rn.includes(token) : (rn === pick || rn.includes(pick) || pick.includes(rn));
      });
    }
    // Records carry a full datetime (created_date); period.match compares on the
    // date part so a same-day "to" bound doesn't drop records stamped later.
    result = result.filter(f => period.match((f.date || '').slice(0, 10)));
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(f =>
        (f.advice_no || '').toLowerCase().includes(s) ||
        (f.party_name || '').toLowerCase().includes(s) ||
        (f.transporter_name || '').toLowerCase().includes(s) ||
        (f.vehicle_no || '').toLowerCase().includes(s) ||
        (f.reference || '').toLowerCase().includes(s)
      );
    }
    // Default to ascending order — oldest freight date first, then Freight No.
    return [...result].sort((a, b) => {
      const da = (a.date || '').slice(0, 10), db = (b.date || '').slice(0, 10);
      if (da !== db) return da < db ? -1 : 1;
      return (a.advice_no || '').localeCompare(b.advice_no || '', undefined, { numeric: true });
    });
  }, [unifiedData, lockedDirection, directionFilter, statusFilter, companyName, period, search]);

  // The table narrows further by the freight-source split; the summary cards stay
  // on `filtered` so they always show the full In-invoice vs Separate breakdown.
  const tableRows = useMemo(() => (
    sourceFilter === 'all' ? filtered
      : filtered.filter(f => (f.freight_source || 'SEPARATE_SLIP') === sourceFilter)
  ), [filtered, sourceFilter]);

  // Summary. The "Total Paid" card reflects whichever direction the
  // page is locked to:
  //   /freight/inward  → sum of Purchase freight payments
  //   /freight/outward → sum of Sales freight payments
  //   unified /freight → sum of Sales (legacy default)
  const summary = useMemo(() => {
    const total = filtered.length;
    const purchaseCount = filtered.filter(f => f.direction === 'Purchase').length;
    const salesCount = filtered.filter(f => f.direction === 'Sales').length;
    const totalAmount = filtered.reduce((s, f) => s + f.total_amount, 0);
    const paidDirection = lockedDirection || 'Sales';
    const totalPaid = filtered.filter(f => f.direction === paidDirection).reduce((s, f) => s + (f.total_paid || 0), 0);
    const pendingCount = filtered.filter(f => !['PAID', 'COMPLETED', 'CANCELLED'].includes(f.status_raw)).length;
    // In-invoice vs separate-slip split (value + paid + count) — the inward
    // freight breakdown Sir asked for. INVOICE_INCLUDED = freight was inside the
    // goods bill; everything else = a separate slip.
    const isInv = f => (f.freight_source || 'SEPARATE_SLIP') === 'INVOICE_INCLUDED';
    const invRows = filtered.filter(isInv), sepRows = filtered.filter(f => !isInv(f));
    const invValue = invRows.reduce((s, f) => s + f.total_amount, 0);
    const sepValue = sepRows.reduce((s, f) => s + f.total_amount, 0);
    const invPaid = invRows.reduce((s, f) => s + (f.total_paid || 0), 0);
    const sepPaid = sepRows.reduce((s, f) => s + (f.total_paid || 0), 0);
    return { total, purchaseCount, salesCount, totalAmount, totalPaid, paidDirection, pendingCount,
      invValue, sepValue, invPaid, sepPaid, invCount: invRows.length, sepCount: sepRows.length };
  }, [filtered, lockedDirection]);

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Delete freight ${row.advice_no}? This cannot be undone.`, isDangerous: true }))) return;
    try {
      const api = row.direction_key === 'purchase' ? '/api/purchase/freight' : '/api/sales/freight';
      await apiClient.delete(`${api}/${row.id}/`);
      toast.success(`${row.advice_no} deleted`);
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const handleApprove = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Approve freight ${row.advice_no}?` }))) return;
    try {
      await apiClient.post(`/api/purchase/freight/${row.id}/approve/`);
      toast.success(`${row.advice_no} approved`);
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to approve');
    }
  };

  const columns = [
    { key: 'direction', label: 'Type', sortable: true, render: (v) => (
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium leading-none ${v === 'Purchase' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
        {v === 'Purchase' ? <ArrowDownLeft size={10} /> : <ArrowUpRight size={10} />}
        {v}
      </span>
    )},
    { key: 'advice_no', label: 'Freight No', sortable: true, render: (v, row) => (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/${row.direction_key}/${row.id}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{v}</button>
    )},
    { key: 'date', label: 'Date', sortable: true, render: v => fmtDate(v) },
    { key: 'party_name', label: 'Vendor / Customer', sortable: true, render: (v, row) => (
      <span className="whitespace-nowrap"><span className="font-medium text-slate-800">{v}</span><span className="text-[11px] text-slate-400 ml-1">({row.party_type})</span></span>
    )},
    { key: 'reference', label: 'Reference', sortable: true, render: (v, row) => row.reference_link ? (
      <button onClick={(e) => { e.stopPropagation(); navigate(row.reference_link); }} className="text-primary-600 hover:underline text-xs">{v}</button>
    ) : <span className="text-slate-400 text-xs">{v}</span> },
    { key: 'transporter_name', label: 'Transporter', sortable: true },
    { key: 'freight_source', label: 'Source', sortable: true, render: (v, row) => (
      <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded border leading-none ${v === 'INVOICE_INCLUDED' ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>
        {v === 'INVOICE_INCLUDED' ? `In bill${row.vendor_bill_no ? ' · ' + row.vendor_bill_no : ''}` : 'Separate slip'}
      </span>
    )},
    { key: 'vehicle_no', label: 'Vehicle No', sortable: true },
    { key: 'to_location', label: 'Destination', sortable: true },
    { key: 'total_amount', label: 'Total Amount', sortable: true, render: v => <span className="font-semibold">{fmt(v)}</span> },
    { key: 'total_paid', label: 'Paid', sortable: true, render: v => <span className="text-emerald-700 tabular-nums">{fmt(v || 0)}</span> },
    { key: 'balance', label: 'Balance', sortable: false, render: (_, row) => <span className="text-amber-700 tabular-nums">{fmt((row.total_amount || 0) - (row.total_paid || 0))}</span> },
    { key: 'due_date', label: 'Due Date', sortable: true, render: (_, row) => {
      const baseDate = row.receipt_date || row.date;
      if (!baseDate) return '-';
      const due = new Date(baseDate);
      due.setDate(due.getDate() + 15);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const isOverdue = due < today && !['PAID', 'CANCELLED'].includes(row.status_raw);
      return <span className={isOverdue ? 'text-red-600 font-medium' : 'text-slate-700'}>{fmtDate(due.toISOString())}</span>;
    }},
    { key: 'status', label: 'Status', sortable: true, render: (v, row) => {
      // Freight Terms = 'PAID' means the charges were settled at source
      // (typically baked into the vendor invoice). Show as Paid and
      // skip the "Waiting for Payment" prompt regardless of total_paid.
      if (row.freight_terms_raw === 'PAID') return <StatusBadge status="Paid" />;
      if (row.payment_status) return <StatusBadge status={row.payment_status} />;
      if (row.status_raw === 'APPROVED' && !row.total_paid) return <StatusBadge status="Waiting for Payment" />;
      return <StatusBadge status={v} />;
    }},
    // SOURCE — where the freight came from, like the Bills page. ERP (entered
    // here) vs Tally (imported from a voucher), plus whether it's matched.
    { key: 'source_origin', label: 'Source', sortable: true, render: (_, row) => {
      const inTally = row.source_origin === 'TALLY';
      return (
        <div className="flex items-center gap-1 whitespace-nowrap">
          <span className={`inline-block text-[10px] font-medium rounded border px-1.5 py-0.5 ${inTally ? 'bg-teal-50 text-teal-700 border-teal-200' : 'bg-indigo-50 text-indigo-700 border-indigo-200'}`}
            title={inTally ? 'Imported from a Tally voucher' : 'Entered in the ERP'}>
            {inTally ? 'Tally' : 'ERP'}
          </span>
          <span className={`inline-block text-[10px] font-medium rounded border px-1.5 py-0.5 ${inTally ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}
            title={inTally ? 'Present in Tally' : 'In the ERP but not in Tally'}>
            {inTally ? 'In Tally' : 'Not in Tally'}
          </span>
        </div>
      );
    }},
    { key: 'approve', label: '', sortable: false, render: (_, row) => {
      if (row.direction_key !== 'purchase') return null;
      if (!canApproveFreight) return null;
      if (row.status_raw === 'APPROVED' || ['IN_TRANSIT', 'COMPLETED', 'PAID', 'CANCELLED'].includes(row.status_raw)) {
        if (row.status_raw === 'APPROVED') {
          return (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 text-emerald-700 text-[10px] font-medium rounded border border-emerald-200 whitespace-nowrap leading-none" title="Approved">
              <CheckCircle2 size={10} /> Approved
            </span>
          );
        }
        return null;
      }
      return (
        <button
          onClick={(e) => handleApprove(e, row)}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-600 text-white text-[10px] font-medium rounded border border-emerald-600 hover:bg-emerald-700 transition whitespace-nowrap leading-none"
          title="Approve Freight"
        >
          <CheckCircle2 size={10} /> Approve
        </button>
      );
    }},
    { key: 'attachments', label: '', sortable: false, render: (_, row) => (
      <button
        onClick={async (e) => {
          e.stopPropagation();
          setLoadingAttachments(true);
          const ep = attachEndpoint(row.direction_key);
          try {
            const res = await apiClient.get(`${ep}?module=FREIGHT&record_id=${row.id}`).catch(() => ({ data: [] }));
            const allFiles = (res.data?.results || res.data || []).map(f => ({ ...f, _source: 'Freight' }));
            // Always open — so the reviewer can UPLOAD a slip even when there are none yet.
            setAttachmentModal({ freightId: row.id, freightNo: row.freight_no || row.advice_no, endpoint: ep, attachments: allFiles });
          } catch { toast.error('Failed to load attachments'); }
          finally { setLoadingAttachments(false); }
        }}
        className="p-1.5 text-slate-500 hover:text-primary-600 hover:bg-primary-50 rounded transition"
        title="Attachments"
      >
        <Paperclip size={15} />
      </button>
    )},
    { key: 'payment', label: '', sortable: false, render: (_, row) => {
      // Gated on Freight Payment → Create (the Freight module permission
      // page): the Payment button is the entry point to recording a freight
      // payment, so only a role allowed to create freight payments sees it.
      if (!canCreate('Freight Payment')) return null;
      if (['CANCELLED', 'PAID', 'DRAFT', 'PENDING_APPROVAL', 'PENDING'].includes(row.status_raw)) return null;
      // Prepaid freight has no payment to record — hide the CTA.
      if (row.freight_terms_raw === 'PAID') return null;
      return (
        <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/payments/new?type=${row.direction_key}&freight_id=${row.id}`); }}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-600 text-white text-[10px] font-medium rounded border border-emerald-600 hover:bg-emerald-700 transition whitespace-nowrap leading-none" title="Make Payment">
          <CreditCard size={10} /> Payment
        </button>
      );
    }},
    { key: 'actions', label: '', sortable: false, render: (_, row) => (
      <div className="flex items-center gap-1">
        <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/${row.direction_key}/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="View">
          <Eye size={15} />
        </button>
        {canDelete(row.direction_key === 'sales' ? 'Sales Freight' : 'Freight Advice') && row.status_raw !== 'CANCELLED' && (
          <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Delete">
            <Trash2 size={15} />
          </button>
        )}
      </div>
    )},
  ];

  // Hide columns the 'Freight Advice' field-permission map marks HIDDEN.
  // Identifier/link, row actions and direction columns are always kept.
  // keyFor maps a column to its base catalog key (strip _name/_code/
  // _display companions, then apply explicit meaning-based aliases).
  const NEVER_HIDE = new Set(['direction', 'advice_no', 'freight_source', 'due_date', 'approve', 'attachments', 'payment', 'actions']);
  const COLUMN_KEY_ALIAS = {
    date: 'freight_date',
    reference: 'receipt_advice',
    vehicle_no: 'lorry_no',
    to_location: 'destination_state',
    total_amount: 'payable_amount',
  };
  const keyFor = (col) => {
    if (COLUMN_KEY_ALIAS[col.key]) return COLUMN_KEY_ALIAS[col.key];
    return col.key.replace(/_(name|code|display)$/, '');
  };
  const visibleColumns = columns.filter(c => NEVER_HIDE.has(c.key) || !isHidden(keyFor(c)));

  // All possible statuses for the filter
  const allStatuses = [
    { value: 'DRAFT', label: 'Draft' },
    { value: 'PENDING_APPROVAL', label: 'Pending Approval' },
    { value: 'APPROVED', label: 'Approved' },
    { value: 'IN_TRANSIT', label: 'In Transit' },
    { value: 'COMPLETED', label: 'Completed' },
    { value: 'PAID', label: 'Paid' },
    { value: 'PENDING', label: 'Pending' },
    { value: 'PARTIALLY_PAID', label: 'Partially Paid' },
    { value: 'CANCELLED', label: 'Cancelled' },
  ];

  return (
    <MainLayout>
      {/* Attachment Modal */}
      {attachmentModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setAttachmentModal(null)}>
          <div role="dialog" aria-modal="true" aria-label="Freight attachments" className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[80dvh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold text-slate-800">
                <Paperclip size={18} className="inline mr-2 text-primary-600" />
                Attachments — {attachmentModal.freightNo}
              </h3>
              <button onClick={() => setAttachmentModal(null)} aria-label="Close" title="Close" className="p-1 hover:bg-slate-100 rounded"><X size={18} /></button>
            </div>
            <div className="p-4 space-y-3">
              {/* Upload a scanned slip (image / PDF) to THIS freight */}
              <label className="flex items-center justify-center gap-2 p-3 border-2 border-dashed border-primary-200 rounded-lg cursor-pointer hover:bg-primary-50 text-sm font-medium text-primary-700">
                {uploadingAttach ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                <span>{uploadingAttach ? 'Uploading…' : 'Upload slip (image / PDF)'}</span>
                <input type="file" accept="image/*,.pdf" className="hidden" disabled={uploadingAttach}
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadAttachment(f); }} />
              </label>
              {attachmentModal.attachments.length === 0 && (
                <p className="text-sm text-slate-400 text-center py-1">No slips yet — upload one above.</p>
              )}
              {attachmentModal.attachments.map(att => (
                <div key={att.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="flex items-center gap-3 min-w-0">
                    <Paperclip size={16} className="text-slate-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{att.file_name}</p>
                      <p className="text-xs text-slate-500">
                        {att._source && <span className={`font-medium ${att._source === 'Receipt' ? 'text-blue-600' : 'text-slate-600'}`}>{att._source}</span>}
                        {att._source && ' • '}{att.file_type} {att.file_size ? `• ${(att.file_size / 1024).toFixed(1)} KB` : ''}
                      </p>
                    </div>
                  </div>
                  <a
                    href={att.file}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 px-3 py-1.5 bg-primary-600 text-white text-xs font-medium rounded-lg hover:bg-primary-700"
                  >
                    View
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Upload Register (Excel / CSV) modal — outward */}
      {showUpload && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !uploading && setShowUpload(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-800 mb-1">Upload Freight Register</h3>
            <p className="text-xs text-slate-500 mb-4">Excel or CSV — one freight per <b>Freight No</b>, payment rows merge, transporters matched/created. Re-uploading updates (no duplicates).</p>
            <label className="block text-xs font-medium text-slate-500 mb-1">Company</label>
            <select value={uploadCompany} onChange={(e) => setUploadCompany(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-3">
              <option value="">— select —</option>
              {(companyOptions || []).map((co) => <option key={co.value} value={co.value}>{co.label}</option>)}
            </select>
            <label className="block text-xs font-medium text-slate-500 mb-1">Register file (.xlsx / .csv)</label>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setUploadFile(e.target.files?.[0] || null)} className="w-full text-sm mb-4" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowUpload(false)} disabled={uploading} className="px-3 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
              <button onClick={doUpload} disabled={uploading} className="px-4 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-2">{uploading && <Loader2 size={14} className="animate-spin" />}Upload</button>
            </div>
          </div>
        </div>
      )}

      <PageHeader
        title={lockedDirection === 'Sales' ? 'Outward Freight' : 'Inward Freight'}
        subtitle={lockedDirection === 'Sales'
          ? 'Outbound freight from warehouse to customer'
          : 'Inbound freight from vendors to warehouse'}
        breadcrumbs={[
          { label: lockedDirection === 'Sales' ? 'Outward Freight' : 'Inward Freight' },
        ]}
        actions={{
          onPrint: () => window.print(),
          // Inward: import freight from Zoho + reconcile from live Tally.
          // Outward: upload a paid-freight register (Excel / CSV).
          ...(lockedDirection !== 'Sales' ? {} : { right: (
            <div className="flex items-center gap-2">
              <button onClick={() => setShowUpload(true)} title="Upload a freight register (Excel / CSV)"
                className="inline-flex items-center gap-2 px-3 sm:px-4 py-2 border border-emerald-300 text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100 transition text-sm font-medium">
                <Upload size={16} /> <span className="hidden sm:inline">Upload Register</span>
              </button>
            </div>
          ) }),
          // Inward Freight = 'Freight Advice' (purchase-owned),
          // Outward Freight = 'Sales Freight' (sales-owned).
          ...(lockedDirection === 'Sales'
            ? (canCreate('Sales Freight')
                ? { createLink: '/freight/outward/new', createLabel: 'New Outward Freight' }
                : {})
            : (canCreate('Freight Advice')
                ? { createLink: '/freight/inward/new', createLabel: 'New Inward Freight' }
                : {})),
        }}
      />

      {/* Filter bar — one clean row directly under the header, built from the
          shared toolbar vocabulary (CTRL_SEG / CTRL_FIELD / CTRL_ROW) so it reads
          exactly like the Purchase Analytics filter bar. Drives the summary cards
          below and the list (both recompute from it). */}
      <div className={`${CTRL_ROW} mb-3`}>
        {/* Standard period navigator (All / Today / Week / Month / FY / Custom). */}
        <PeriodNavigator allowAll {...period.navProps} />
        {/* Freight kind — Inward · Local as a dropdown (like the Bills "Category"
            picker). Each kind is its own route; picking one navigates there. */}
        <CustomSelect
          value={location.pathname.startsWith('/freight/local') ? 'local' : 'inward'}
          onChange={(e) => navigate(e.target.value === 'local' ? '/freight/local' : '/freight/inward')}
          title="Freight kind"
          className={`${CTRL_FIELD} max-w-[160px]`}>
          <option value="inward">Inward</option>
          <option value="local">Local</option>
        </CustomSelect>
        {/* Status quick-filter, inline like the Purchase Bills filter row. */}
        <CustomSelect value={statusFilter} onChange={e => setStatusFilter(e.target.value)} title="Status"
          className={`${CTRL_FIELD} max-w-[180px]`}>
          <option value="">All Status</option>
          {allStatuses.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </CustomSelect>
        {(period.range || statusFilter || search) && (
          <>
            <span className="text-xs text-slate-500 tabular-nums">
              {tableRows.length.toLocaleString('en-IN')} of {filtered.length.toLocaleString('en-IN')} records
            </span>
            <button type="button"
              onClick={() => { period.navProps.setPeriod('all'); setStatusFilter(''); setSearch(''); }}
              className="text-xs text-slate-500 hover:text-slate-800 underline">Clear</button>
          </>
        )}
      </div>


      {isLoading && <div className="text-center py-8 text-slate-500">Loading...</div>}
      {error && !isLoading && (
        <div className="text-center py-8">
          <p className="text-red-500 mb-3">Failed to load freight data.</p>
          <button onClick={() => fetchData()} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      )}

      {/* Summary band — hairline-divided cells, exactly like Purchase Bills:
          count · value · paid · outstanding, over the filtered rows. */}
      {!isLoading && !error && (
        <div className="metric-band mb-3">
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Freight bills</p><p className="text-sm font-bold text-slate-900 tabular-nums">{summary.total.toLocaleString('en-IN')}</p></div>
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Total value</p><p className="text-sm font-bold text-slate-900 money">{formatCurrency(summary.totalAmount)}</p></div>
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Paid</p><p className="text-sm font-bold text-emerald-700 money">{formatCurrency(summary.totalPaid)}</p></div>
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Outstanding</p><p className={`text-sm font-bold money ${(summary.totalAmount - summary.totalPaid) > 0 ? 'text-rose-600' : 'text-slate-900'}`}>{formatCurrency(Math.max(0, summary.totalAmount - summary.totalPaid))}</p></div>
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Pending</p><p className={`text-sm font-bold tabular-nums ${summary.pendingCount > 0 ? 'text-amber-600' : 'text-slate-900'}`}>{summary.pendingCount.toLocaleString('en-IN')}</p></div>
        </div>
      )}

      {/* Mobile cards — same data, no horizontal scroll. The desktop
          DataTable below is hidden on phones. */}
      <MobileListCards
        rows={tableRows}
        isLoading={isLoading}
        emptyMessage="No freight advices found"
        config={{
          // Field names match what unifiedData emits (party_name / date /
          // total_amount / direction_key = 'purchase'|'sales'). The old config
          // read vendor_name / freight_date / amount / 'inward'|'outward', none
          // of which exist on the row — so every mobile card rendered blank.
          title: (row) => row.advice_no || row.id,
          subtitle: (row) => row.party_name || row.transporter_name,
          badge: (row) => {
            const dir = row.direction_key;
            return dir === 'purchase'
              ? { label: 'Inward',  cls: 'bg-blue-100 text-blue-800 border-blue-300' }
              : dir === 'sales'
                ? { label: 'Outward', cls: 'bg-purple-100 text-purple-800 border-purple-300' }
                : { label: row.status || '-', cls: 'bg-slate-100 text-slate-700 border-slate-200' };
          },
          fields: (row) => [
            { label: 'Date',   value: row.date ? formatDate(row.date) : null },
            { label: 'Status', value: row.status },
            { label: 'Amount', value: row.total_amount ? formatCurrency(row.total_amount) : null, cls: 'font-medium' },
            { label: 'Paid',   value: row.total_paid != null ? formatCurrency(row.total_paid) : null },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/freight/${row.direction_key}/${row.id}`) },
          ],
        }}
        onRowClick={(row) => navigate(`/freight/${row.direction_key}/${row.id}`)}
      />

      <div className="hidden sm:block [&_td]:!py-1.5 [&_th]:!py-1.5">
        <DataTable dense persistKey="freight"
          exportFileName="unified-freight"
          canExport={canExport('Sales Freight')}
          columns={visibleColumns}
          data={tableRows}
          isLoading={isLoading}
          pageSize={15}
          onSearch={setSearch}
          searchPlaceholder="Search freight no, vendor, transporter, vehicle…"
          onRowClick={(row) => navigate(`/freight/${row.direction_key}/${row.id}`)}
          exportable
          pagination
        />
      </div>
    </MainLayout>
  );
}

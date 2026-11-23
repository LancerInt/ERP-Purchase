import { confirm } from '@/components/common/confirm';
import { promptText } from '@/components/common/prompt';
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ArrowLeft, Edit3, Trash2, FileText, ExternalLink, Printer, Ban, FileDown,
  UploadCloud, ChevronDown, MoreVertical, Pencil, Clock, Paperclip, Calendar,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { formatAddressDisplay } from '../../../components/common/AddressField';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import FileAttachments from '../components/FileAttachments';
import ActivityLog from '@/components/common/ActivityLog';
import ScaledDocument from '../../../components/common/ScaledDocument';
import { formatCurrency, formatDate as formatDateUtil } from '@/utils/formatters';

// Three words only: Paid, Partially Paid, Unpaid.
//
// The database (ReceivableLedger.PAYMENT_STATUS_CHOICES) keeps four states --
// it splits unpaid into NOT_DUE and OVERDUE by whether the due date has passed.
// Both mean the same thing to a reader of this page: nothing has come in yet.
// So both READ as "Unpaid".
//
// This is a label map and nothing more. No stored value is altered, no figure
// is recalculated, and the ledger still holds whichever of the four states it
// held before -- Outstanding, the aging buckets and the customer statement all
// go on using the full four. Only the word on this page is simplified. An
// unrecognised status is shown as-is rather than guessed at, so a new state
// would be visible instead of silently reading "Unpaid".
const PAY_STATUS_LABEL = {
  PAID: 'Paid',
  PARTIALLY_PAID: 'Partially Paid',
  NOT_DUE: 'Unpaid',
  OVERDUE: 'Unpaid',
  UNPAID: 'Unpaid',
};

// Which status to believe.
//
// `payment_status` asks one question: did CASH close this bill? A bill cleared
// by a credit note or by TDS is settled -- the customer owes nothing on it --
// but no receipt reached it, so it stays PARTIALLY_PAID for ever. KSE Limited
// showed three "Partially Paid" invoices against a balance of zero.
//
// `settled_status` answers the question a reader is actually asking: is there
// anything still owed on this bill, by any means. Settled is settled, however
// it was settled. Fall back to the old field if the API has not been
// redeployed yet, so an older backend still renders something sensible.
const payStatusOf = (r) => (r?.settled_status || r?.payment_status);
// What is really still owed on this bill, settled by ANY means -- cash, a
// credit note, a debit note, a TDS journal, money on account. `balance` knows
// only about cash. Served alongside settled_status by SettledStatusMixin.
const owedOf = (r) => Number(
  r?.settled_balance !== undefined && r?.settled_balance !== null
    ? r.settled_balance : (r?.balance || 0)) || 0;
const PAY_STATUS_CLS = {
  PAID: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  PARTIALLY_PAID: 'bg-amber-50 text-amber-800 border-amber-200',
  NOT_DUE: 'bg-rose-50 text-rose-700 border-rose-200',
  OVERDUE: 'bg-rose-50 text-rose-700 border-rose-200',
  UNPAID: 'bg-rose-50 text-rose-700 border-rose-200',
};

export default function SalesInvoiceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Where the Back button returns to — honours a `backTo` passed by the caller
  // (e.g. the Sales Dashboard tile drill-downs), else the invoice list.
  const backTo = location.state?.backTo || '/sales/invoices';
  const { canEdit, canDelete, canView, canCancel, canPushTally } = usePermissions();
  const { isHidden } = useFieldPermissions('Sales Invoice');
  const { isHidden: isLineHidden } = useFieldPermissions('Sales Invoice Line');
  // Cross-module nav gates. Each clickable jump to another sales
  // module is hidden when the user lacks view permission for that
  // module — the back-end would 403 the destination anyway, so we
  // suppress the link to keep the UI honest.
  const canSeeSO = canView('Sales Order');
  const canSeeDC = canView('Dispatch Challan');

  const [inv, setInv] = useState(null);
  // The invoice's ReceivableLedger row: where paid / balance / payment_status
  // live. Null once loaded means the invoice has no receivable row at all
  // (opening-balance carriers, for one) -- which is said plainly rather than
  // shown as "Unpaid", because those are different things.
  const [receivable, setReceivable] = useState(null);
  const [recvLoading, setRecvLoading] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [tallyInput, setTallyInput] = useState('');
  const [savingTally, setSavingTally] = useState(false);
  const [busy, setBusy] = useState(false);
  // "Go to Tally" review popup
  const [showTallyModal, setShowTallyModal] = useState(false);
  const [tallyPreview, setTallyPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [pushingTally, setPushingTally] = useState(false);
  // Compact-layout UI state.
  const [menuOpen, setMenuOpen] = useState(false);     // header "⋮" overflow
  const [openSec, setOpenSec] = useState('activity');  // which bottom accordion is open
  const [editTally, setEditTally] = useState(false);   // inline Tally-no editor in the info strip
  const [showShip, setShowShip] = useState(false);     // reveal consignee (ship-to) block

  useEffect(() => { fetchInvoice(); }, [id]);

  const fetchInvoice = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`/api/sales/invoices/${id}/`);
      // Payment status is NOT computed here. It is read from the invoice's
      // ReceivableLedger row -- the same row the Outstanding tile, the aging
      // buckets and the customer statement all read -- so this page can never
      // disagree with them. The invoice endpoint itself carries no paid or
      // balance field, and the receivable list can be searched by invoice no
      // (search_fields includes invoice_reference__invoice_no), so no backend
      // change is needed. We still match on invoice_reference, because a
      // search is a text match and could return a near neighbour.
      const invNo = res.data?.invoice_no;
      if (invNo) {
        apiClient.get(`/api/sales/receivables/?search=${encodeURIComponent(invNo)}`)
          .then(rr => {
            const list = Array.isArray(rr.data) ? rr.data : (rr.data?.results || []);
            setReceivable(list.find(x => String(x.invoice_reference) === String(id)) || null);
          })
          .catch(() => setReceivable(null))
          .finally(() => setRecvLoading(false));
      } else {
        setRecvLoading(false);
      }
      setInv(res.data);
      setTallyInput(res.data.tally_invoice_no || '');
    } catch (err) {
      if (err.response?.status !== 404) toast.error('Failed to load Invoice');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete Invoice ${inv.invoice_no}? This cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/sales/invoices/${id}/`);
      toast.success(`Invoice ${inv.invoice_no} deleted`);
      navigate('/sales/invoices');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  // Download this invoice as a Tally Sales-voucher XML for import into Tally.
  const downloadTally = async () => {
    try {
      const res = await apiClient.get(`/api/sales/invoices/${id}/tally-xml/`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tally-${inv.invoice_no || id}.xml`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success('Tally XML downloaded.');
    } catch {
      toast.error('Tally export failed.');
    }
  };

  // "Go to Tally": fetch a preview of the voucher and show it for review.
  // Nothing is written to Tally until the user clicks Confirm.
  const openTallyModal = async () => {
    setTallyPreview(null);
    setLoadingPreview(true);
    setShowTallyModal(true);
    try {
      const res = await apiClient.get(`/api/sales/invoices/${id}/tally-preview/`);
      setTallyPreview(res.data);
    } catch {
      toast.error('Could not load the Tally preview.');
      setShowTallyModal(false);
    } finally { setLoadingPreview(false); }
  };

  // Confirm — actually create the voucher in Tally.
  const confirmTallyPush = async () => {
    setPushingTally(true);
    try {
      const res = await apiClient.post(`/api/sales/invoices/${id}/tally-push/`);
      toast.success(res.data.message || 'Pushed to Tally.');
      setShowTallyModal(false);
      fetchInvoice();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Tally push failed.');
    } finally { setPushingTally(false); }
  };

  // Record the Tally invoice number; the backend also mirrors it onto the DC(s).
  const handleSaveTally = async () => {
    setSavingTally(true);
    try {
      await apiClient.post(`/api/sales/invoices/${id}/set-tally-number/`, { tally_invoice_no: tallyInput.trim() });
      toast.success('Tally invoice number saved');
      setEditTally(false);
      fetchInvoice();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save');
    } finally { setSavingTally(false); }
  };

  // Cancel (≠ delete): retires the invoice number so it's never reused, frees
  // the DC for a fresh invoice, and reverses the receivable.
  const handleCancel = async () => {
    const reason = await promptText({
      title: `Cancel Invoice ${inv.invoice_no}`,
      label: 'Reason for cancellation',
      placeholder: 'e.g. Wrong rate / customer changed the order',
      message: 'The invoice number will be retired (the next invoice continues the series) and the DC freed so you can re-invoice it.',
      multiline: true,
      required: true,
      isDangerous: true,
      confirmLabel: 'Cancel Invoice',
    });
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      await apiClient.post(`/api/sales/invoices/${id}/cancel/`, { cancellation_reason: reason.trim() });
      toast.success(`Invoice ${inv.invoice_no} cancelled`);
      fetchInvoice();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to cancel');
    } finally { setBusy(false); }
  };

  // Start a fresh invoice for the freed DC (pre-selects it on the create page).
  const handleReinvoice = () => {
    const dcId = (inv.dc_list && inv.dc_list[0]?.id) || inv.dc_reference;
    navigate(dcId ? `/sales/invoices/new?dc_id=${dcId}` : '/sales/invoices/new');
  };

  const formatDate = (d) => {
    if (!d) return '-';
    return formatDateUtil(d);
  };

  const fmt = (v) => {
    const n = Number(v);
    return isNaN(n) ? '-' : formatCurrency(n);
  };

  const fmtQty = (v) => {
    const n = Number(v);
    return isNaN(n) ? '-' : n.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  };

  const fmtNum = (v) => {
    const n = Number(v);
    return isNaN(n) ? '-' : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const termLabel = (val) => {
    const map = {
      'TO_PAY': 'To Pay', 'PAID': 'Paid', 'MIXED': 'Mixed',
      'NET_15': 'Net 15', 'NET_30': 'Net 30', 'NET_45': 'Net 45',
      'NET15': 'Net 15', 'NET30': 'Net 30', 'NET45': 'Net 45', 'NET60': 'Net 60',
      'IMMEDIATE': 'Immediate', 'CUSTOM': 'Custom',
      'INR': 'INR (₹)', 'USD': 'USD ($)',
      'EX_FACTORY': 'Ex-Factory', 'DOOR_DELIVERY': 'Door Delivery', 'CIF': 'CIF', 'FOB': 'FOB',
    };
    return map[val] || val || '-';
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="space-y-4 max-w-7xl">
          {[1, 2, 3].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}
        </div>
      </MainLayout>
    );
  }

  if (!inv) {
    return (
      <MainLayout>
        <div className="text-center py-12">
          <FileText className="mx-auto text-slate-300 mb-4" size={48} />
          <p className="text-slate-600 text-lg">Invoice not found</p>
          <button onClick={() => navigate(backTo, { replace: true })} className="mt-4 px-4 py-2 text-blue-600 hover:text-blue-800">
            Back to Invoices
          </button>
        </div>
      </MainLayout>
    );
  }

  const lines = inv.invoice_lines || [];
  const dcList = inv.dc_list || [];
  const taxTotal = Number(inv.cgst_total || 0) + Number(inv.sgst_total || 0) + Number(inv.igst_total || 0);
  // Field-permission gates for the invoice-line columns (catalog: 'Sales
  // Invoice Line'). Each hides the matching <th>/<td> pair.
  const showLineProduct = !isLineHidden('product');
  const showLineDesc    = !isLineHidden('description');
  const showLineBatch   = !isLineHidden('batch_no');
  const showLineHsn     = !isLineHidden('hsn_sac');
  const showLineGst     = !isLineHidden('gst_rate');
  const showLineQty     = !isLineHidden('quantity');
  const showLineUom     = !isLineHidden('uom');
  const showLineRate    = !isLineHidden('rate');
  const showLineDisc    = !isLineHidden('discount_percent');
  const showLineAmount  = !isLineHidden('amount');
  const hasEditPerm = canEdit('Sales Invoice');
  const hasDeletePerm = canDelete('Sales Invoice');
  const hasCancelPerm = canCancel('Sales Invoice');
  const hasPushTallyPerm = canPushTally('Sales Invoice');
  const inTally = !!(inv?.tally_invoice_no || '').trim();

  // Does this invoice carry any reference / dispatch data worth a section?
  const hasRefs = !!(inv.so_no || inv.dc_no || inv.buyers_order_no || inv.delivery_note
    || inv.other_references || inv.dispatch_doc_no || inv.dispatched_through || inv.destination);
  const hasTerms = !!(inv.payment_terms || inv.terms_of_delivery || inv.declaration || inv.remarks);
  // Ship-to equals bill-to unless a distinct consignee is named.
  const billName = inv.buyer_name || inv.customer_name || '';
  const sameShip = !inv.consignee_name || inv.consignee_name === billName;

  const received = receivable ? (Number(inv.grand_total || 0) - owedOf(receivable)) : 0;
  const balanceDue = receivable ? owedOf(receivable) : Number(inv.grand_total || 0);

  const InfoField = ({ label, children }) => (
    <div>
      <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wide">{label}</p>
      <p className="text-[13px] text-slate-900 font-semibold mt-0.5">{children}</p>
    </div>
  );

  // A collapsible section for the bottom-left column.
  const Section = ({ id: sid, icon: Icon, title, meta, children }) => {
    const open = openSec === sid;
    return (
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <div className="w-full flex items-center gap-2 px-3.5 py-3 cursor-pointer select-none"
          onClick={() => setOpenSec(open ? null : sid)}>
          {Icon && <Icon size={15} className="text-slate-400 shrink-0" />}
          <span className="text-sm font-semibold text-slate-800">{title}</span>
          {meta && <span className="text-xs text-slate-400 font-normal truncate">— {meta}</span>}
          <ChevronDown size={16} className={`ml-auto text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
        {open && <div className="px-3.5 pb-3.5 border-t border-slate-100 pt-3">{children}</div>}
      </div>
    );
  };

  // One cell of the top info strip.
  const StripCell = ({ icon: Icon, label, children, action, last }) => (
    <div className={`flex-1 min-w-[180px] px-4 py-2.5 flex items-center gap-2 border-b sm:border-b-0 ${last ? '' : 'border-r'} border-slate-100`}>
      {Icon && <Icon size={15} className="text-slate-400 shrink-0" />}
      <span className="text-[13px] text-slate-600 min-w-0">
        <span className="text-slate-400">{label}:</span> <span className="font-semibold text-slate-800">{children}</span>
      </span>
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );

  const payChip = receivable ? (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-lg text-xs font-semibold border ${PAY_STATUS_CLS[payStatusOf(receivable)] || 'bg-slate-100 text-slate-700 border-slate-200'}`}>
      {PAY_STATUS_LABEL[payStatusOf(receivable)] || payStatusOf(receivable) || '—'}
    </span>
  ) : null;

  const btnGhost = 'flex items-center gap-2 px-3 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium';

  return (
    <MainLayout>
      <div className="max-w-7xl space-y-3">
        {/* Breadcrumb */}
        <nav className="text-sm text-slate-500 print:hidden">
          <button onClick={() => navigate('/sales/invoices')} className="hover:text-slate-700">Sales</button>
          <span className="mx-1.5">/</span>
          <button onClick={() => navigate('/sales/invoices')} className="hover:text-slate-700">Invoices</button>
        </nav>

        {/* Title + status + actions */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 print:hidden">
          <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/sales/invoices'))}
            className="p-1 text-slate-500 hover:text-slate-700" title="Back"><ArrowLeft size={20} /></button>
          {!isHidden('invoice_no') && <h1 className="text-lg sm:text-2xl font-bold text-slate-900 break-all">{inv.invoice_no}</h1>}
          <StatusBadge status={inv.status} />
          {payChip}

          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => window.print()} className={btnGhost}><Printer size={16} /> Print</button>
            <button onClick={downloadTally} disabled={inTally}
              title={inTally ? `Already in Tally as ${inv.tally_invoice_no}` : 'Export to Tally (XML)'}
              className={`${btnGhost} disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent`}>
              <FileDown size={16} /> Tally
            </button>
            {hasPushTallyPerm && (
              <button onClick={openTallyModal} disabled={inTally}
                title={inTally ? `Already in Tally as ${inv.tally_invoice_no}` : 'Review & push this invoice to Tally'}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-emerald-600">
                <UploadCloud size={16} /> Go to Tally
              </button>
            )}
            {/* Overflow — Edit / Delete / Cancel / linked docs. */}
            <div className="relative">
              <button onClick={() => setMenuOpen(o => !o)} className="p-2 border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50" aria-label="More actions">
                <MoreVertical size={18} />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 mt-1 w-52 bg-white rounded-lg border border-slate-200 shadow-lg z-20 py-1 text-sm">
                    {hasEditPerm && inv.status === 'DRAFT' && (
                      <button onClick={() => { setMenuOpen(false); navigate(`/sales/invoices/${id}/edit`); }} className="w-full flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50"><Edit3 size={14} /> Edit invoice</button>
                    )}
                    {(canSeeDC && (dcList.length > 0 ? dcList : (inv.dc_reference ? [{ id: inv.dc_reference, dc_no: inv.dc_no }] : []))).map(dc => (
                      <button key={dc.id} onClick={() => { setMenuOpen(false); navigate(`/sales/dc/${dc.id}`); }} className="w-full flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50"><ExternalLink size={14} /> View {dc.dc_no || 'DC'}</button>
                    ))}
                    {canSeeSO && inv.so_reference && (
                      <button onClick={() => { setMenuOpen(false); navigate(`/sales/orders/${inv.so_reference}`); }} className="w-full flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50"><ExternalLink size={14} /> View {inv.so_no || 'SO'}</button>
                    )}
                    {hasDeletePerm && inv.status === 'DRAFT' && (
                      <button onClick={() => { setMenuOpen(false); handleDelete(); }} className="w-full flex items-center gap-2 px-3 py-2 text-red-600 hover:bg-red-50"><Trash2 size={14} /> Delete invoice</button>
                    )}
                    {hasCancelPerm && inv.status !== 'CANCELLED' && (
                      <button onClick={() => { setMenuOpen(false); handleCancel(); }} disabled={busy} className="w-full flex items-center gap-2 px-3 py-2 text-amber-700 hover:bg-amber-50 disabled:opacity-50"><Ban size={14} /> Cancel invoice</button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {inv.status === 'CANCELLED' && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex flex-wrap items-center justify-between gap-2 print:hidden">
            <span className="text-sm text-amber-800">
              This invoice is cancelled — its number ({inv.invoice_no}) is retired and won't be reused. The dispatch challan is free to re-invoice.
              {inv.cancellation_reason && <span className="block mt-0.5 text-amber-700"><span className="font-medium">Reason:</span> {inv.cancellation_reason}</span>}
            </span>
            <button onClick={handleReinvoice}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700">
              <FileText size={14} /> Create new invoice for this DC
            </button>
          </div>
        )}

        {/* No-template hint — the structured layout below is authoritative. */}
        {!inv.template_html && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2.5 flex items-center gap-2 text-sm text-amber-800 print:hidden">
            <FileText size={15} className="shrink-0" />
            <span>Printable snapshot unavailable.</span>
            <span className="text-amber-700/80">Invoices created before May 2026 don't carry a printable copy — the details below are authoritative.</span>
          </div>
        )}

        {/* Info strip */}
        <div className="flex flex-wrap rounded-lg border border-slate-200 bg-white overflow-hidden print:hidden">
          {!isHidden('invoice_date') && <StripCell icon={Calendar} label="Invoice date">{formatDate(inv.invoice_date)}</StripCell>}
          <StripCell icon={Calendar} label="Due date">{(inv.effective_due_date || inv.due_date) ? formatDate(inv.effective_due_date || inv.due_date) : '-'}</StripCell>
          {!isHidden('payment_terms') && <StripCell icon={FileText} label="Terms">{termLabel(inv.payment_terms)}</StripCell>}
          <StripCell icon={FileDown} label="Tally invoice" last
            action={hasEditPerm && inv.status !== 'CANCELLED' && !editTally ? (
              <button onClick={() => setEditTally(true)} className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:underline"><Pencil size={12} /> Edit</button>
            ) : null}>
            {editTally ? (
              <span className="inline-flex items-center gap-1.5">
                <input type="text" value={tallyInput} onChange={(e) => setTallyInput(e.target.value)} autoFocus
                  placeholder="Tally invoice no"
                  className="border border-slate-300 rounded px-2 py-0.5 text-[13px] w-40" />
                <button onClick={handleSaveTally} disabled={savingTally || tallyInput.trim() === (inv.tally_invoice_no || '')}
                  className="px-2 py-0.5 bg-primary-600 text-white rounded text-xs font-medium disabled:opacity-50">{savingTally ? '…' : 'Save'}</button>
                <button onClick={() => { setEditTally(false); setTallyInput(inv.tally_invoice_no || ''); }} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
              </span>
            ) : (inv.tally_invoice_no || <span className="text-slate-400 font-normal">Not set</span>)}
          </StripCell>
        </div>

        {/* Seller + Buyer, 1:1 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 print:hidden">
          {/* Seller */}
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-4">
            <h2 className="text-sm font-semibold text-slate-900 mb-3 pb-2 border-b">Seller (Company Details)</h2>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              {!isHidden('company') && <InfoField label="Company">{inv.company_name || '-'}</InfoField>}
              {!isHidden('company_gstin') && <InfoField label="GSTIN">{inv.company_gstin || '-'}</InfoField>}
              {!isHidden('company_pan') && <InfoField label="PAN">{inv.company_pan || '-'}</InfoField>}
              {inv.company_msme_no && <InfoField label="Udyam / MSME">{inv.company_msme_no}</InfoField>}
              {!isHidden('company_state') && <InfoField label="State">{inv.company_state ? `${inv.company_state}${inv.company_state_code ? ` (${inv.company_state_code})` : ''}` : '-'}</InfoField>}
            </div>
          </div>

          {/* Buyer */}
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-4">
            <h2 className="text-sm font-semibold text-slate-900 mb-3 pb-2 border-b">Buyer (Bill To)</h2>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              {!isHidden('buyer_name') && <InfoField label="Company">{billName || '-'}</InfoField>}
              {!isHidden('buyer_gstin') && <InfoField label="GSTIN">{inv.buyer_gstin || '-'}</InfoField>}
              {!isHidden('buyer_address') && (
                <div className="col-span-2">
                  <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wide">Address</p>
                  <p className="text-[13px] text-slate-900 font-medium mt-0.5 whitespace-pre-wrap">{formatAddressDisplay(inv.buyer_address) || '-'}</p>
                </div>
              )}
            </div>
            <div className="mt-3 pt-3 border-t flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1">
                Ship to: {sameShip ? 'Same as billing' : (inv.consignee_name || '—')}
              </span>
              {!sameShip && (
                <button onClick={() => setShowShip(s => !s)} className="text-xs font-medium text-blue-600 hover:underline">{showShip ? 'Hide' : 'View details'}</button>
              )}
            </div>
            {!sameShip && showShip && (
              <div className="mt-2 text-[13px] text-slate-600 space-y-0.5">
                {inv.consignee_gstin && <p><span className="text-slate-400">GSTIN:</span> {inv.consignee_gstin}</p>}
                {inv.consignee_address && <p className="whitespace-pre-wrap">{formatAddressDisplay(inv.consignee_address)}</p>}
                {inv.consignee_state && <p><span className="text-slate-400">State:</span> {inv.consignee_state}{inv.consignee_state_code ? ` (${inv.consignee_state_code})` : ''}</p>}
              </div>
            )}
          </div>
        </div>

        {/* Line items */}
        <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-4 print:hidden">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Line items ({lines.length})</h2>
          {lines.length === 0 ? (
            <p className="text-slate-500 text-center py-4">No line items</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b text-slate-600">
                    <th className="text-left px-2 sm:px-3 py-2 font-medium">#</th>
                    {showLineProduct && <th className="text-left px-2 sm:px-3 py-2 font-medium">Product</th>}
                    {showLineDesc && <th className="text-left px-2 sm:px-3 py-2 font-medium">Description</th>}
                    {showLineBatch && <th className="text-left px-2 sm:px-3 py-2 font-medium">Batch</th>}
                    {showLineHsn && <th className="text-left px-2 sm:px-3 py-2 font-medium">HSN/SAC</th>}
                    {showLineQty && <th className="text-right px-2 sm:px-3 py-2 font-medium">Qty</th>}
                    {showLineUom && <th className="text-left px-2 sm:px-3 py-2 font-medium">UOM</th>}
                    {showLineRate && <th className="text-right px-2 sm:px-3 py-2 font-medium">Rate</th>}
                    {showLineGst && <th className="text-right px-2 sm:px-3 py-2 font-medium">GST</th>}
                    {showLineDisc && <th className="text-right px-2 sm:px-3 py-2 font-medium">Disc.</th>}
                    {showLineAmount && <th className="text-right px-2 sm:px-3 py-2 font-medium">Amount</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lines.map((line, idx) => (
                    <tr key={line.id || idx} className="hover:bg-primary-50/40 transition-colors">
                      <td className="px-2 sm:px-3 py-2 text-slate-500">{line.sl_no || idx + 1}</td>
                      {showLineProduct && (
                        <td className="px-2 sm:px-3 py-2">
                          <p className="font-medium text-slate-800">{line.display_name || line.product_name || '-'}</p>
                        </td>
                      )}
                      {showLineDesc && (
                        <td className="px-2 sm:px-3 py-2 text-slate-600">{line.description || '—'}</td>
                      )}
                      {showLineBatch && <td className="px-2 sm:px-3 py-2 text-slate-600 whitespace-nowrap">{line.batch_no || '—'}</td>}
                      {showLineHsn && (
                        <td className="px-2 sm:px-3 py-2 whitespace-nowrap">
                          {line.hsn_sac
                            ? <span className="text-slate-600">{line.hsn_sac}</span>
                            : <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 text-[11px] font-medium">⚠ Missing</span>}
                        </td>
                      )}
                      {showLineQty && <td className="px-2 sm:px-3 py-2 text-right font-medium whitespace-nowrap">{fmtQty(line.quantity)}</td>}
                      {showLineUom && <td className="px-2 sm:px-3 py-2 text-slate-600 whitespace-nowrap">{line.uom || '-'}</td>}
                      {showLineRate && <td className="px-2 sm:px-3 py-2 text-right whitespace-nowrap">{fmtNum(line.rate)}</td>}
                      {showLineGst && <td className="px-2 sm:px-3 py-2 text-right text-slate-600 whitespace-nowrap">{line.gst_rate != null ? `${line.gst_rate}%` : '-'}</td>}
                      {showLineDisc && <td className="px-2 sm:px-3 py-2 text-right text-slate-600 whitespace-nowrap">{line.discount_percent != null ? `${line.discount_percent}%` : '-'}</td>}
                      {showLineAmount && <td className="px-2 sm:px-3 py-2 text-right font-semibold text-slate-800 whitespace-nowrap">{fmtNum(line.amount)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Bottom: collapsible sections (2) + payment summary (1) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-start print:hidden">
          <div className="lg:col-span-2 space-y-2">
            <Section id="refs" icon={Paperclip} title="References & dispatch" meta={hasRefs ? null : 'Not provided'}>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-3">
                {inv.so_no && <InfoField label="Sales Order">{inv.so_no}</InfoField>}
                {inv.dc_no && <InfoField label="DC Reference">{inv.dc_no}</InfoField>}
                {inv.buyers_order_no && <InfoField label="Buyer's Order No">{inv.buyers_order_no}</InfoField>}
                {inv.buyers_order_date && <InfoField label="Buyer's Order Date">{formatDate(inv.buyers_order_date)}</InfoField>}
                {inv.delivery_note && <InfoField label="Delivery Note">{inv.delivery_note}</InfoField>}
                {inv.other_references && <InfoField label="Other References">{inv.other_references}</InfoField>}
                {inv.dispatch_doc_no && <InfoField label="Dispatch Doc No">{inv.dispatch_doc_no}</InfoField>}
                {inv.dispatched_through && <InfoField label="Dispatched Through">{inv.dispatched_through}</InfoField>}
                {inv.destination && <InfoField label="Destination">{inv.destination}</InfoField>}
                {!hasRefs && <p className="text-sm text-slate-400 col-span-full">No references or dispatch details on this invoice.</p>}
              </div>
            </Section>

            <Section id="terms" icon={FileText} title="Terms & declaration" meta={hasTerms ? null : 'None'}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                {!isHidden('payment_terms') && <InfoField label="Payment Terms">{termLabel(inv.payment_terms)}</InfoField>}
                {!isHidden('terms_of_delivery') && <InfoField label="Terms of Delivery">{termLabel(inv.terms_of_delivery)}</InfoField>}
                {!isHidden('declaration') && inv.declaration && (
                  <div className="col-span-full"><p className="text-[10px] text-slate-500 font-medium uppercase tracking-wide">Declaration</p><p className="text-[13px] text-slate-700 mt-0.5 whitespace-pre-wrap">{inv.declaration}</p></div>
                )}
                {!isHidden('remarks') && inv.remarks && (
                  <div className="col-span-full"><p className="text-[10px] text-slate-500 font-medium uppercase tracking-wide">Remarks</p><p className="text-[13px] text-slate-700 mt-0.5 whitespace-pre-wrap">{inv.remarks}</p></div>
                )}
                {!hasTerms && <p className="text-sm text-slate-400 col-span-full">No terms or declaration recorded.</p>}
              </div>
            </Section>

            <Section id="attachments" icon={Paperclip} title="Attachments">
              <FileAttachments module="SALES_INVOICE" recordId={id} />
            </Section>

            <Section id="activity" icon={Clock} title="Activity">
              <ActivityLog module="Sales Invoice" recordId={id} />
            </Section>
          </div>

          {/* Invoice & payment summary */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-4">
              <h3 className="text-sm font-semibold text-slate-900 mb-3">Invoice &amp; payment summary</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-slate-600">Subtotal</span><span className="font-medium tabular-nums">{fmt(inv.subtotal)}</span></div>
                {Number(inv.cgst_total || 0) !== 0 && <div className="flex justify-between"><span className="text-slate-600">CGST</span><span className="font-medium tabular-nums">{fmt(inv.cgst_total)}</span></div>}
                {Number(inv.sgst_total || 0) !== 0 && <div className="flex justify-between"><span className="text-slate-600">SGST</span><span className="font-medium tabular-nums">{fmt(inv.sgst_total)}</span></div>}
                {Number(inv.igst_total || 0) !== 0 && <div className="flex justify-between"><span className="text-slate-600">IGST</span><span className="font-medium tabular-nums">{fmt(inv.igst_total)}</span></div>}
                {Number(inv.round_off || 0) !== 0 && <div className="flex justify-between"><span className="text-slate-600">Round off</span><span className="font-medium tabular-nums">{fmt(inv.round_off)}</span></div>}
                {Number(inv.tds_total || 0) !== 0 && <div className="flex justify-between"><span className="text-slate-600">Less: TDS (194Q)</span><span className="font-medium text-amber-700 tabular-nums">−{fmt(inv.tds_total)}</span></div>}
                <div className="flex justify-between pt-2 border-t font-bold text-base"><span>Total</span><span className="tabular-nums">{fmt(inv.grand_total)}</span></div>
                <div className="flex justify-between text-emerald-700"><span>Received</span><span className="font-medium tabular-nums">{fmt(received)}</span></div>
                <div className={`flex justify-between pt-2 border-t font-bold text-base ${balanceDue > 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                  <span>Balance due</span><span className="tabular-nums">{fmt(balanceDue)}</span>
                </div>
              </div>
              {!isHidden('amount_in_words') && inv.amount_in_words && (
                <p className="mt-3 pt-3 border-t text-xs italic text-slate-500">{inv.amount_in_words}</p>
              )}
              {receivable?.due_date && (
                <p className="mt-2 text-[11px] text-slate-400">Due {formatDateUtil(receivable.due_date)}</p>
              )}
            </div>
          </div>
        </div>

        {/* Frozen A4 template — kept for printing only; the compact layout above
            is what shows on screen. */}
        {inv.template_html && (
          <div className="hidden print:block">
            <ScaledDocument html={inv.template_html} />
          </div>
        )}
      </div>

      {/* "Go to Tally" review popup — shows the exact voucher; nothing is
          written to Tally until Confirm is clicked. */}
      {showTallyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 print:hidden"
             onClick={() => !pushingTally && setShowTallyModal(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90dvh] overflow-y-auto"
               onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
              <UploadCloud size={18} className="text-emerald-600" />
              <h3 className="text-base font-semibold text-slate-800">Push to Tally — review</h3>
            </div>
            <div className="px-5 py-4 text-sm">
              {loadingPreview || !tallyPreview ? (
                <p className="text-slate-500">Loading preview…</p>
              ) : (
                <>
                  {tallyPreview.already_synced && (
                    <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 text-xs">
                      This invoice was already pushed to Tally. Confirming again will create a duplicate voucher.
                    </div>
                  )}
                  <dl className="grid grid-cols-3 gap-y-1.5 mb-3">
                    <dt className="text-slate-500">Voucher</dt><dd className="col-span-2 font-medium">{tallyPreview.voucher_type}</dd>
                    <dt className="text-slate-500">Number</dt><dd className="col-span-2 font-medium">{tallyPreview.voucher_number}</dd>
                    <dt className="text-slate-500">Date</dt><dd className="col-span-2 font-medium">{tallyPreview.date || '-'}</dd>
                    <dt className="text-slate-500">Party</dt><dd className="col-span-2 font-medium">{tallyPreview.party}</dd>
                    {tallyPreview.company && (<><dt className="text-slate-500">Company</dt><dd className="col-span-2 font-medium">{tallyPreview.company}</dd></>)}
                    {tallyPreview.sales_order && (<><dt className="text-slate-500">Sales Order</dt><dd className="col-span-2 font-medium">{tallyPreview.sales_order}</dd></>)}
                    {tallyPreview.dispatch_challan && (<><dt className="text-slate-500">Dispatch Challan</dt><dd className="col-span-2 font-medium">{tallyPreview.dispatch_challan}</dd></>)}
                  </dl>
                  <div className="rounded-lg border border-slate-200 overflow-hidden mb-3">
                    <table className="w-full text-xs">
                      <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500">
                        <tr>
                          <th className="text-left px-3 py-1.5 font-medium">Ledger</th>
                          <th className="text-center px-2 py-1.5 font-medium">Dr/Cr</th>
                          <th className="text-right px-3 py-1.5 font-medium">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tallyPreview.entries.map((e, i) => (
                          <tr key={i} className="border-t border-slate-100">
                            <td className="px-3 py-1.5">{e.ledger}{e.is_party && <span className="ml-1 text-[10px] text-slate-400">(party)</span>}</td>
                            <td className="text-center px-2 py-1.5">{e.dc}</td>
                            <td className="text-right px-3 py-1.5 tabular-nums">{fmt(e.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Missing ledgers ({tallyPreview.ledgers_to_create.join(', ')}) are auto-created in Tally. Target: {tallyPreview.tally_url}
                  </p>
                </>
              )}
            </div>
            <div className="px-5 py-3 border-t border-slate-200 flex justify-end gap-2">
              <button onClick={() => setShowTallyModal(false)} disabled={pushingTally}
                className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium disabled:opacity-50">
                Cancel
              </button>
              <button onClick={confirmTallyPush} disabled={pushingTally || loadingPreview || !tallyPreview}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 text-sm font-medium disabled:opacity-50">
                {pushingTally ? 'Pushing…' : 'Confirm & Create in Tally'}
              </button>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}

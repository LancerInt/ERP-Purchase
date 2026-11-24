/**
 * Customer 360 — Detail view.
 *
 * Route: /sales/customer-360/:id
 * Sidebar + grouped tabs layout matching the prototype. Fetches data from
 * existing Tally-synced APIs and renders 12 live sections.
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend,
} from 'recharts';
import {
  ChevronLeft, ChevronDown, AlertCircle, AlertTriangle,
  CreditCard, TrendingUp, Package, FileText, BookOpen, DollarSign,
  Shield, RotateCcw, Clock, Users as UsersIcon, MapPin,
  Loader2, Download, Pencil, ChevronRight, X, ExternalLink,
  Calendar,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import apiClient from '../../../utils/api.js';
import { formatDate } from '@/utils/formatters';

// ── Formatting ──────────────────────────────────────────────────────
const num = (v) => Number(v) || 0;
const fmtINR = (v) => {
  const n = num(v);
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const fmtRup = (v) => `₹${Math.round(num(v)).toLocaleString('en-IN')}`;
const fmtDate = (iso) => (iso ? formatDate(iso) : '—');
const fmtQty = (v) => num(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const monthLabel = (ym) => {
  const [y, m] = String(ym || '').split('-');
  const mi = parseInt(m, 10) - 1;
  return (MONTH_ABBR[mi] || '?') + " '" + String(y || '').slice(2);
};
const CREDIT_DAYS = { CASH: 0, NET_15: 15, NET_30: 30, NET_45: 45, NET_60: 60 };
const creditLabel = (t) => t ? t.replace('_', ' ') : '—';

// ── Date range presets ─────────────────────────────────────────────
const _today = new Date();
const _isoDate = (d) => d.toISOString().slice(0, 10);
const _fyYear = (d) => d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
const _monthStart = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}-01`;
const _monthEnd = (y, m) => _isoDate(new Date(y, m + 1, 0));

function buildDatePresets() {
  const ty = _today.getFullYear();
  const tm = _today.getMonth();
  const fy = _fyYear(_today);
  const presets = [];
  // Current FY
  presets.push({ key: 'fy', label: `FY ${fy}-${String(fy + 1).slice(2)}`, from: `${fy}-04-01`, to: `${fy + 1}-03-31` });
  // Previous FY
  presets.push({ key: 'pfy', label: `FY ${fy - 1}-${String(fy).slice(2)}`, from: `${fy - 1}-04-01`, to: `${fy}-03-31` });
  // Current month
  presets.push({ key: 'cm', label: MONTH_ABBR[tm] + ' ' + ty, from: _monthStart(ty, tm), to: _isoDate(_today) });
  // Previous months (last 5)
  for (let i = 1; i <= 5; i++) {
    const d = new Date(ty, tm - i, 1);
    presets.push({ key: `m${i}`, label: MONTH_ABBR[d.getMonth()] + ' ' + d.getFullYear(), from: _monthStart(d.getFullYear(), d.getMonth()), to: _monthEnd(d.getFullYear(), d.getMonth()) });
  }
  // Quarters (Indian: Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar)
  const qStarts = [[fy, 3], [fy, 6], [fy, 9], [fy + 1, 0]];
  const qLabels = ['Q1 (Apr-Jun)', 'Q2 (Jul-Sep)', 'Q3 (Oct-Dec)', 'Q4 (Jan-Mar)'];
  for (let i = 0; i < 4; i++) {
    const [qy, qm] = qStarts[i];
    const qEnd = new Date(qy, qm + 3, 0);
    if (qEnd <= _today) {
      presets.push({ key: `q${i}`, label: qLabels[i], from: _monthStart(qy, qm), to: _isoDate(qEnd) });
    } else if (new Date(qy, qm, 1) <= _today) {
      presets.push({ key: `q${i}`, label: qLabels[i] + ' (so far)', from: _monthStart(qy, qm), to: _isoDate(_today) });
    }
  }
  return presets;
}
const DATE_PRESETS = buildDatePresets();

// ── Icons per nav section ───────────────────────────────────────────
const NAV_GROUPS = [
  { title: 'Receivables', items: [
    { id: 'unpaid',  label: 'Unpaid Invoices', icon: AlertCircle },
    { id: 'overdue', label: 'Overdue',         icon: AlertTriangle },
    { id: 'credit',  label: 'Credit & Ageing', icon: CreditCard },
  ]},
  { title: 'Sales', items: [
    { id: 'trend',    label: 'Sales Trend',    icon: TrendingUp },
    { id: 'items',    label: 'Item Analytics',  icon: Package },
    { id: 'invoices', label: 'All Invoices',    icon: FileText },
  ]},
  { title: 'Accounts', items: [
    { id: 'ledger',   label: 'Tally Ledger',     icon: BookOpen },
    { id: 'gst',      label: 'GST Summary',      icon: DollarSign },
    { id: 'tds',      label: 'TDS Summary',      icon: Shield },
    { id: 'returns',  label: 'Returns & DN/CN',  icon: RotateCcw },
    { id: 'payment',  label: 'Payment Behaviour', icon: Clock },
  ]},
  { title: 'CRM', items: [
    { id: 'contacts',  label: 'Contacts',           icon: UsersIcon },
    { id: 'addresses', label: 'Delivery Addresses', icon: MapPin },
  ]},
];

const tooltipStyle = { fontSize: 12, borderRadius: 8, border: '1px solid #c8e0d0' };
const PIE_COLORS = ['#16a34a','#0d9488','#2563eb','#7c3aed','#d97706','#dc2626','#059669','#6366f1'];
const VTYPE_CLS = {
  Invoice: 'bg-[#dbeafe] text-[#2563eb]', 'Debit Note': 'bg-[#fee2e2] text-[#991b1b]',
  Receipt: 'bg-[#d1fae5] text-[#065f46]', 'Credit Note': 'bg-[#ccfbf1] text-[#115e59]',
  TDS: 'bg-[#fef3c7] text-[#92400e]', Journal: 'bg-[#ede9fe] text-[#5b21b6]',
};

function Pill({ children, color = 'slate' }) {
  const map = {
    green: 'bg-[#d1fae5] text-[#065f46]', red: 'bg-[#fee2e2] text-[#991b1b]',
    amber: 'bg-[#fef3c7] text-[#92400e]', blue: 'bg-[#dbeafe] text-[#2563eb]',
    purple: 'bg-[#ede9fe] text-[#5b21b6]', teal: 'bg-[#ccfbf1] text-[#115e59]',
    slate: 'bg-[#e4f2ea] text-[#4a7c5c]',
  };
  return <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${map[color] || map.slate}`}>{children}</span>;
}

function SummaryCard({ label, value, sub, color }) {
  return (
    <div className="bg-white rounded-md border border-[#c8e0d0] px-4 py-3">
      <div className="text-[10px] font-semibold text-[#4a7c5c] uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold mt-1 tabular-nums ${color || 'text-[#1a3a2a]'}`}>{value}</div>
      {sub && <div className="text-[10px] text-[#7ba68e] mt-0.5">{sub}</div>}
    </div>
  );
}

function DataTable({ columns, rows, emptyMsg = 'No data', maxH = 'max-h-[calc(100vh-220px)]' }) {
  return (
    <div className={`${maxH} overflow-y-auto`}>
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 z-[1]">
          <tr className="bg-[#f0f7f4] border-b-2 border-[#c8e0d0]">
            {columns.map((col, i) => (
              <th key={i} className={`px-2.5 py-2 text-[10px] font-semibold text-[#4a7c5c] uppercase tracking-wide ${col.align === 'right' ? 'text-right' : 'text-left'}`}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="px-3 py-10 text-center text-[#7ba68e] text-sm">{emptyMsg}</td></tr>
          ) : rows.map((row, ri) => (
            <tr key={ri} className="border-b border-[#e4f2ea] hover:bg-[#e4f2ea] transition-colors">
              {columns.map((col, ci) => (
                <td key={ci} className={`px-2.5 py-2 tabular-nums ${col.align === 'right' ? 'text-right' : ''} ${col.mono ? 'font-mono text-xs' : ''}`}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Invoice popup (90% screen, green/white theme) ──────────────────
function InvoicePopup({ id, onClose }) {
  const [inv, setInv] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);
    setError(null);
    apiClient.get(`/api/sales/dashboard/records/?type=invoice_detail&id=${id}`)
      .then(({ data }) => { if (alive) setInv(data); })
      .catch((err) => {
        if (!alive) return;
        const st = err?.response?.status;
        if (st === 401) setError('Session expired — please re-login.');
        else if (st === 403) setError('You do not have permission to view this invoice.');
        else if (st === 404) setError('Invoice not found in the system.');
        else setError(`Could not load invoice (${st || 'network error'}).`);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!id) return null;

  const lines = inv?.invoice_lines || [];
  const bal = num(inv?.outstanding);
  const total = num(inv?.grand_total);
  const received = num(inv?.received) || (inv?.payments || []).reduce((s, p) => s + num(p.amount), 0);
  const dueDate = inv?.effective_due_date || inv?.due_date;
  const payLabel = total > 0 && bal <= 0 ? 'Paid' : bal > 0 && bal < total ? 'Partial' : 'Unpaid';
  const payColor = payLabel === 'Paid' ? 'green' : payLabel === 'Partial' ? 'amber' : 'red';

  const fmtAddr = (a) => {
    if (!a || typeof a !== 'object') return a || '';
    return [a.street, a.line2, a.city && a.state ? `${a.city} - ${a.pincode || ''}` : a.city, a.state].filter(Boolean).join(', ');
  };

  const handlePrint = () => {
    if (!inv) return;
    const hasIgst = num(inv.igst_total) > 0;
    const coAddr = fmtAddr(inv.company_address);
    const totalQty = lines.reduce((s, l) => s + num(l.quantity), 0);
    const totalUom = lines.length === 1 ? (lines[0].uom || '') : '';
    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>Tax Invoice - ${inv.invoice_no}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #000; }
  table { border-collapse: collapse; width: 100%; }
  .inv { border: 2px solid #000; }
  .inv td, .inv th { border: 1px solid #000; padding: 3px 5px; vertical-align: top; }
  .center { text-align: center; }
  .right { text-align: right; }
  .bold { font-weight: bold; }
  .title { font-size: 14px; font-weight: bold; text-align: center; padding: 6px; }
  .label { color: #555; font-size: 10px; }
  .total-row td { border-top: 2px solid #000; font-weight: bold; }
  .no-border td { border: none; }
  @media print { body { -webkit-print-color-adjust: exact; } }
</style></head><body>
<table class="inv">
  <tr><td colspan="6" class="title">Tax Invoice</td></tr>
  <tr>
    <td colspan="3" rowspan="4" style="width:50%">
      <div class="bold" style="font-size:12px">${inv.company_name || ''}</div>
      ${coAddr ? `<div>${coAddr}</div>` : ''}
      ${inv.company_gstin ? `<div>GSTIN/UIN: <b>${inv.company_gstin}</b></div>` : ''}
      ${inv.company_state ? `<div>State Name: ${inv.company_state}${inv.company_state_code ? `, Code: ${inv.company_state_code}` : ''}</div>` : ''}
      ${inv.company_cin ? `<div>CIN: ${inv.company_cin}</div>` : ''}
      ${inv.company_email ? `<div>E-Mail: ${inv.company_email}</div>` : ''}
    </td>
    <td colspan="1"><span class="label">Invoice No.</span><br/><b>${inv.invoice_no || ''}</b></td>
    <td colspan="2"><span class="label">Dated</span><br/>${inv.invoice_date ? formatDate(inv.invoice_date) : ''}</td>
  </tr>
  <tr>
    <td><span class="label">Delivery Note</span><br/>${inv.delivery_note || ''}</td>
    <td colspan="2"><span class="label">Mode/Terms of Payment</span><br/>${inv.payment_terms || ''}</td>
  </tr>
  <tr>
    <td><span class="label">Reference No. &amp; Date</span><br/>${inv.tally_invoice_no || inv.other_references || ''}</td>
    <td colspan="2"><span class="label">Other References</span><br/>${inv.other_references || ''}</td>
  </tr>
  <tr>
    <td><span class="label">Buyer's Order No.</span><br/>${inv.buyers_order_no || ''}</td>
    <td colspan="2"><span class="label">Dated</span><br/>${inv.buyers_order_date ? formatDate(inv.buyers_order_date) : ''}</td>
  </tr>
  <tr>
    <td colspan="3">
      <div class="label">Consignee (Ship to)</div>
      <div class="bold">${inv.consignee_name || inv.buyer_name || ''}</div>
      ${inv.consignee_address || inv.buyer_address ? `<div>${inv.consignee_address || inv.buyer_address}</div>` : ''}
      ${inv.consignee_gstin || inv.buyer_gstin ? `<div>GSTIN/UIN: <b>${inv.consignee_gstin || inv.buyer_gstin}</b></div>` : ''}
      ${inv.consignee_state || inv.buyer_state ? `<div>State Name: ${inv.consignee_state || inv.buyer_state}${(inv.consignee_state_code || inv.buyer_state_code) ? `, Code: ${inv.consignee_state_code || inv.buyer_state_code}` : ''}</div>` : ''}
    </td>
    <td><span class="label">Dispatch Doc No.</span><br/>${inv.dispatch_doc_no || inv.dc_no || ''}</td>
    <td colspan="2"><span class="label">Delivery Note Date</span><br/>${inv.delivery_note_date ? formatDate(inv.delivery_note_date) : ''}</td>
  </tr>
  <tr>
    <td colspan="3">
      <div class="label">Buyer (Bill to)</div>
      <div class="bold">${inv.buyer_name || inv.customer_name || ''}</div>
      ${inv.buyer_address ? `<div>${inv.buyer_address}</div>` : ''}
      ${inv.buyer_gstin ? `<div>GSTIN/UIN: <b>${inv.buyer_gstin}</b></div>` : ''}
      ${inv.buyer_state ? `<div>State Name: ${inv.buyer_state}${inv.buyer_state_code ? `, Code: ${inv.buyer_state_code}` : ''}</div>` : ''}
    </td>
    <td><span class="label">Dispatched through</span><br/>${inv.dispatched_through || ''}</td>
    <td colspan="2"><span class="label">Destination</span><br/>${inv.destination || ''}</td>
  </tr>
  <tr>
    <td colspan="3"></td>
    <td colspan="3"><span class="label">Terms of Delivery</span><br/>${inv.terms_of_delivery || ''}</td>
  </tr>
  <tr class="bold" style="background:#f5f5f5">
    <th style="width:5%">SI No.</th>
    <th style="width:35%">Description of Goods</th>
    <th>HSN/SAC</th>
    <th class="right">Quantity</th>
    <th class="right">Rate</th>
    <th class="right" style="width:15%">Amount</th>
  </tr>
  ${lines.map((l, i) => `<tr>
    <td class="center">${l.sl_no || i + 1}</td>
    <td>${l.description || ''}</td>
    <td class="center">${l.hsn_sac || ''}</td>
    <td class="right">${num(l.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${l.uom || ''}</td>
    <td class="right">${fmtRup(num(l.rate))}</td>
    <td class="right">${fmtRup(num(l.amount))}</td>
  </tr>`).join('')}
  ${hasIgst
    ? `<tr><td></td><td class="right bold">IGST @ ${lines[0] ? num(lines[0].igst_rate) : ''}%</td><td></td><td></td><td class="right">${lines[0] ? num(lines[0].igst_rate) : ''} %</td><td></td></tr>`
    : `<tr><td></td><td class="right"><b>CGST @ ${lines[0] ? num(lines[0].cgst_rate) : ''}% OUTPUT</b></td><td></td><td></td><td class="right">${lines[0] ? num(lines[0].cgst_rate) : ''} %</td><td></td></tr>
       <tr><td></td><td class="right"><b>SGST @ ${lines[0] ? num(lines[0].sgst_rate) : ''}% OUTPUT</b></td><td></td><td></td><td class="right">${lines[0] ? num(lines[0].sgst_rate) : ''} %</td><td></td></tr>`
  }
  ${num(inv.tds_total) > 0 ? `<tr><td></td><td>Less: <b>TDS Receivable U/s 194Q</b></td><td></td><td></td><td></td><td class="right">(-)${fmtRup(num(inv.tds_total))}</td></tr>` : ''}
  <tr class="total-row">
    <td></td><td class="right bold">Total</td><td></td>
    <td class="right bold">${totalQty.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${totalUom}</td>
    <td></td>
    <td class="right bold">${fmtRup(total)}</td>
  </tr>
  <tr>
    <td colspan="6">
      <div class="bold">Amount Chargeable (in words)</div>
      <div class="bold" style="font-size:12px">${inv.amount_in_words || ''}</div>
    </td>
  </tr>
  <tr style="background:#f5f5f5">
    <th colspan="2">HSN/SAC</th>
    <th colspan="2" class="right">Taxable Value</th>
    <th class="right">${hasIgst ? 'IGST' : 'CGST + SGST'}</th>
    <th class="right">Total</th>
  </tr>
  ${lines.map(l => {
    const tax = hasIgst ? num(l.igst_amount) : num(l.cgst_amount) + num(l.sgst_amount);
    return `<tr>
      <td colspan="2">${l.hsn_sac || ''}</td>
      <td colspan="2" class="right">${fmtRup(num(l.amount))}</td>
      <td class="right">${fmtRup(tax)}</td>
      <td class="right">${fmtRup(num(l.amount) + tax)}</td>
    </tr>`;
  }).join('')}
  <tr class="total-row">
    <td colspan="2" class="right bold">Total</td>
    <td colspan="2" class="right bold">${fmtRup(num(inv.subtotal))}</td>
    <td class="right bold">${fmtRup(hasIgst ? num(inv.igst_total) : num(inv.cgst_total) + num(inv.sgst_total))}</td>
    <td class="right bold">${fmtRup(num(inv.subtotal) + (hasIgst ? num(inv.igst_total) : num(inv.cgst_total) + num(inv.sgst_total)))}</td>
  </tr>
  <tr>
    <td colspan="3">
      <div>Company's PAN: <b>${inv.company_pan || ''}</b></div>
    </td>
    <td colspan="3" class="right">
      <div style="margin-bottom:30px">for ${inv.company_name || ''}</div>
      <div><i>Authorised Signatory</i></div>
    </td>
  </tr>
  <tr>
    <td colspan="6" style="font-size:10px">
      <div class="bold">Declaration</div>
      <div>${inv.declaration || 'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.'}</div>
    </td>
  </tr>
</table>
</body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 300);
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-[90vw] h-[90vh] bg-[#f8fcf9] rounded-xl shadow-2xl border border-[#c8e0d0] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="shrink-0 bg-white border-b-2 border-[#c8e0d0] px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <FileText size={18} className="text-[#4a7c5c] shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-bold text-[#1a3a2a] truncate">
                {inv?.invoice_no || (loading ? 'Loading...' : 'Invoice')}
              </div>
              {inv && (
                <div className="text-[10px] text-[#7ba68e]">
                  {inv.invoice_date ? formatDate(inv.invoice_date) : '—'}
                  {inv.tally_invoice_no ? ` · Tally ${inv.tally_invoice_no}` : ''}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {inv && <Pill color={payColor}>{payLabel}</Pill>}
            {inv && <Pill color={inv.status === 'CONFIRMED' ? 'green' : inv.status === 'DRAFT' ? 'amber' : 'slate'}>{inv.status}</Pill>}
            {inv && (
              <button onClick={handlePrint}
                className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-[#4a7c5c] bg-[#e4f2ea] hover:bg-[#c8e0d0] rounded-lg transition" title="Print / Save PDF">
                <Download size={13} /> Print
              </button>
            )}
            <button onClick={() => window.open(`/sales/invoices/${id}`, '_blank')}
              className="p-1.5 text-[#7ba68e] hover:text-[#4a7c5c] hover:bg-[#e4f2ea] rounded transition" title="Open full page">
              <ExternalLink size={15} />
            </button>
            <button onClick={onClose} className="p-1.5 text-[#7ba68e] hover:text-[#1a3a2a] hover:bg-[#e4f2ea] rounded transition" title="Close (Esc)">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex items-center justify-center py-20 text-[#7ba68e]">
              <Loader2 size={18} className="animate-spin mr-2" /> Loading invoice...
            </div>
          )}
          {error && <div className="text-center py-16 text-red-600 text-sm">{error}</div>}

          {inv && (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
              {/* Left: full invoice details */}
              <div className="space-y-3">
                {/* Seller + Invoice metadata */}
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden text-[11px]">
                  <div className="grid grid-cols-2">
                    <div className="p-3 border-r border-[#c8e0d0]">
                      <div className="font-bold text-[13px] text-[#1a3a2a]">{inv.company_name || '—'}</div>
                      {fmtAddr(inv.company_address) && <div className="text-[#555] mt-0.5">{fmtAddr(inv.company_address)}</div>}
                      {inv.company_gstin && <div className="mt-0.5">GSTIN/UIN: <span className="font-semibold">{inv.company_gstin}</span></div>}
                      {inv.company_state && <div>State: {inv.company_state}{inv.company_state_code ? `, Code: ${inv.company_state_code}` : ''}</div>}
                      {inv.company_cin && <div>CIN: {inv.company_cin}</div>}
                      {inv.company_email && <div>Email: {inv.company_email}</div>}
                    </div>
                    <div className="p-3 space-y-1">
                      <div className="grid grid-cols-2 gap-1">
                        <div><span className="text-[#7ba68e]">Invoice No.</span><div className="font-bold">{inv.invoice_no}</div></div>
                        <div><span className="text-[#7ba68e]">Date</span><div className="font-semibold">{inv.invoice_date ? formatDate(inv.invoice_date) : '—'}</div></div>
                      </div>
                      {inv.delivery_note && <div><span className="text-[#7ba68e]">Delivery Note</span><div>{inv.delivery_note}</div></div>}
                      {inv.payment_terms && <div><span className="text-[#7ba68e]">Payment Terms</span><div>{inv.payment_terms}</div></div>}
                      {inv.buyers_order_no && <div><span className="text-[#7ba68e]">Buyer's Order</span><div>{inv.buyers_order_no}{inv.buyers_order_date ? ` dt. ${formatDate(inv.buyers_order_date)}` : ''}</div></div>}
                      {inv.other_references && <div><span className="text-[#7ba68e]">Reference</span><div>{inv.other_references}</div></div>}
                    </div>
                  </div>
                </div>

                {/* Consignee + Buyer + Dispatch */}
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden text-[11px]">
                  <div className="grid grid-cols-2">
                    <div className="p-3 border-r border-[#c8e0d0]">
                      <div className="text-[9px] font-semibold text-[#4a7c5c] uppercase tracking-wide mb-1">Consignee (Ship to)</div>
                      <div className="font-bold text-[#1a3a2a]">{inv.consignee_name || inv.buyer_name || '—'}</div>
                      {(inv.consignee_address || inv.buyer_address) && <div className="text-[#555]">{inv.consignee_address || inv.buyer_address}</div>}
                      {(inv.consignee_gstin || inv.buyer_gstin) && <div>GSTIN: <span className="font-semibold">{inv.consignee_gstin || inv.buyer_gstin}</span></div>}
                      {(inv.consignee_state || inv.buyer_state) && <div>State: {inv.consignee_state || inv.buyer_state}{(inv.consignee_state_code || inv.buyer_state_code) ? `, Code: ${inv.consignee_state_code || inv.buyer_state_code}` : ''}</div>}
                    </div>
                    <div className="p-3">
                      <div className="text-[9px] font-semibold text-[#4a7c5c] uppercase tracking-wide mb-1">Buyer (Bill to)</div>
                      <div className="font-bold text-[#1a3a2a]">{inv.buyer_name || inv.customer_name || '—'}</div>
                      {inv.buyer_address && <div className="text-[#555]">{inv.buyer_address}</div>}
                      {inv.buyer_gstin && <div>GSTIN: <span className="font-semibold">{inv.buyer_gstin}</span></div>}
                      {inv.buyer_state && <div>State: {inv.buyer_state}{inv.buyer_state_code ? `, Code: ${inv.buyer_state_code}` : ''}</div>}
                    </div>
                  </div>
                  {(inv.dispatch_doc_no || inv.dispatched_through || inv.destination || inv.terms_of_delivery) && (
                    <div className="border-t border-[#c8e0d0] p-3 grid grid-cols-4 gap-2">
                      {inv.dispatch_doc_no && <div><span className="text-[#7ba68e]">Dispatch Doc</span><div>{inv.dispatch_doc_no}</div></div>}
                      {inv.dispatched_through && <div><span className="text-[#7ba68e]">Dispatched through</span><div>{inv.dispatched_through}</div></div>}
                      {inv.destination && <div><span className="text-[#7ba68e]">Destination</span><div>{inv.destination}</div></div>}
                      {inv.terms_of_delivery && <div><span className="text-[#7ba68e]">Terms of Delivery</span><div>{inv.terms_of_delivery}</div></div>}
                    </div>
                  )}
                </div>

                {/* Line items */}
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden">
                  <div className="px-3 py-1.5 bg-[#f0f7f4] border-b border-[#c8e0d0]">
                    <span className="text-[10px] font-semibold text-[#4a7c5c] uppercase tracking-wide">Line Items ({lines.length})</span>
                  </div>
                  {lines.length === 0 ? (
                    <div className="px-3 py-6 text-center text-[#7ba68e] text-[11px]">No line items</div>
                  ) : (
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="bg-[#f0f7f4] border-b border-[#c8e0d0]">
                          <th className="text-center px-2 py-1.5 text-[9px] font-semibold text-[#4a7c5c] uppercase w-8">SI</th>
                          <th className="text-left px-2.5 py-1.5 text-[9px] font-semibold text-[#4a7c5c] uppercase">Description of Goods</th>
                          <th className="text-center px-2 py-1.5 text-[9px] font-semibold text-[#4a7c5c] uppercase">HSN/SAC</th>
                          <th className="text-right px-2 py-1.5 text-[9px] font-semibold text-[#4a7c5c] uppercase">Quantity</th>
                          <th className="text-right px-2 py-1.5 text-[9px] font-semibold text-[#4a7c5c] uppercase">Rate</th>
                          <th className="text-right px-2.5 py-1.5 text-[9px] font-semibold text-[#4a7c5c] uppercase">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((l, i) => (
                          <tr key={l.id || i} className="border-b border-[#e4f2ea] hover:bg-[#e4f2ea]">
                            <td className="px-2 py-1.5 text-center text-[#7ba68e]">{l.sl_no || i + 1}</td>
                            <td className="px-2.5 py-1.5 font-medium text-[#1a3a2a]">{l.description || '—'}</td>
                            <td className="px-2 py-1.5 text-center text-[#7ba68e] tabular-nums">{l.hsn_sac || '—'}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{num(l.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 })}{l.uom ? ` ${l.uom}` : ''}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{fmtRup(num(l.rate))}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums font-semibold">{fmtRup(num(l.amount))}</td>
                          </tr>
                        ))}
                        {/* GST rows */}
                        {num(inv.cgst_total) > 0 && (
                          <tr className="border-b border-[#e4f2ea] text-[#555]">
                            <td></td><td className="px-2.5 py-1 text-right">CGST @ {lines[0] ? num(lines[0].cgst_rate) : ''}% OUTPUT</td>
                            <td></td><td></td><td></td><td className="px-2.5 py-1 text-right tabular-nums">{fmtRup(num(inv.cgst_total))}</td>
                          </tr>
                        )}
                        {num(inv.sgst_total) > 0 && (
                          <tr className="border-b border-[#e4f2ea] text-[#555]">
                            <td></td><td className="px-2.5 py-1 text-right">SGST @ {lines[0] ? num(lines[0].sgst_rate) : ''}% OUTPUT</td>
                            <td></td><td></td><td></td><td className="px-2.5 py-1 text-right tabular-nums">{fmtRup(num(inv.sgst_total))}</td>
                          </tr>
                        )}
                        {num(inv.igst_total) > 0 && (
                          <tr className="border-b border-[#e4f2ea] text-[#555]">
                            <td></td><td className="px-2.5 py-1 text-right">IGST @ {lines[0] ? num(lines[0].igst_rate) : ''}% OUTPUT</td>
                            <td></td><td></td><td></td><td className="px-2.5 py-1 text-right tabular-nums">{fmtRup(num(inv.igst_total))}</td>
                          </tr>
                        )}
                        {num(inv.tds_total) > 0 && (
                          <tr className="border-b border-[#e4f2ea] text-amber-700">
                            <td></td><td className="px-2.5 py-1">Less: <span className="font-semibold">TDS Receivable U/s 194Q</span></td>
                            <td></td><td></td><td></td><td className="px-2.5 py-1 text-right tabular-nums">(-){fmtRup(num(inv.tds_total))}</td>
                          </tr>
                        )}
                        {num(inv.round_off) !== 0 && (
                          <tr className="border-b border-[#e4f2ea] text-[#555]">
                            <td></td><td className="px-2.5 py-1 text-right">Round Off</td>
                            <td></td><td></td><td></td><td className="px-2.5 py-1 text-right tabular-nums">{fmtRup(num(inv.round_off))}</td>
                          </tr>
                        )}
                        <tr className="bg-[#f0f7f4] font-bold">
                          <td></td><td className="px-2.5 py-2 text-right">Total</td><td></td>
                          <td className="px-2 py-2 text-right tabular-nums">{lines.reduce((s, l) => s + num(l.quantity), 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })} {lines.length === 1 ? (lines[0].uom || '') : ''}</td>
                          <td></td>
                          <td className="px-2.5 py-2 text-right tabular-nums text-[13px]">{fmtRup(total)}</td>
                        </tr>
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Amount in words */}
                {inv.amount_in_words && (
                  <div className="bg-white rounded-lg border border-[#c8e0d0] p-3 text-[11px]">
                    <span className="text-[#7ba68e]">Amount Chargeable (in words):</span>
                    <div className="font-bold text-[#1a3a2a] mt-0.5">{inv.amount_in_words}</div>
                  </div>
                )}

                {/* HSN Summary */}
                {lines.length > 0 && (
                  <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden text-[11px]">
                    <div className="px-3 py-1.5 bg-[#f0f7f4] border-b border-[#c8e0d0]">
                      <span className="text-[10px] font-semibold text-[#4a7c5c] uppercase tracking-wide">HSN/SAC Summary</span>
                    </div>
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="bg-[#f0f7f4] border-b border-[#c8e0d0]">
                          <th className="text-left px-3 py-1.5 text-[9px] font-semibold text-[#4a7c5c] uppercase">HSN/SAC</th>
                          <th className="text-right px-3 py-1.5 text-[9px] font-semibold text-[#4a7c5c] uppercase">Taxable Value</th>
                          {num(inv.cgst_total) > 0 && <th className="text-right px-3 py-1.5 text-[9px] font-semibold text-[#4a7c5c] uppercase">CGST</th>}
                          {num(inv.sgst_total) > 0 && <th className="text-right px-3 py-1.5 text-[9px] font-semibold text-[#4a7c5c] uppercase">SGST</th>}
                          {num(inv.igst_total) > 0 && <th className="text-right px-3 py-1.5 text-[9px] font-semibold text-[#4a7c5c] uppercase">IGST</th>}
                          <th className="text-right px-3 py-1.5 text-[9px] font-semibold text-[#4a7c5c] uppercase">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((l, i) => {
                          const tax = num(l.cgst_amount) + num(l.sgst_amount) + num(l.igst_amount);
                          return (
                            <tr key={i} className="border-b border-[#e4f2ea]">
                              <td className="px-3 py-1.5 font-medium">{l.hsn_sac || '—'}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{fmtRup(num(l.amount))}</td>
                              {num(inv.cgst_total) > 0 && <td className="px-3 py-1.5 text-right tabular-nums">{fmtRup(num(l.cgst_amount))}</td>}
                              {num(inv.sgst_total) > 0 && <td className="px-3 py-1.5 text-right tabular-nums">{fmtRup(num(l.sgst_amount))}</td>}
                              {num(inv.igst_total) > 0 && <td className="px-3 py-1.5 text-right tabular-nums">{fmtRup(num(l.igst_amount))}</td>}
                              <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{fmtRup(num(l.amount) + tax)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Declaration + PAN */}
                <div className="bg-white rounded-lg border border-[#c8e0d0] p-3 text-[11px] grid grid-cols-2 gap-4">
                  <div>
                    {inv.company_pan && <div className="mb-1">Company's PAN: <span className="font-bold">{inv.company_pan}</span></div>}
                    <div className="text-[#7ba68e] text-[10px] font-semibold uppercase">Declaration</div>
                    <div className="text-[#555] mt-0.5">{inv.declaration || 'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.'}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[#1a3a2a] font-semibold">for {inv.company_name}</div>
                    <div className="mt-8 text-[#7ba68e] italic">Authorised Signatory</div>
                  </div>
                </div>
              </div>

              {/* Right: totals sidebar */}
              <div className="space-y-3">
                <div className="bg-white rounded-lg border border-[#c8e0d0] p-3 space-y-1.5 text-[11px]">
                  <div className="text-[9px] font-semibold text-[#4a7c5c] uppercase tracking-wide mb-1">Summary</div>
                  <div className="flex justify-between"><span className="text-[#7ba68e]">Taxable</span><span className="tabular-nums font-medium">{fmtRup(num(inv.subtotal))}</span></div>
                  {num(inv.cgst_total) > 0 && <div className="flex justify-between"><span className="text-[#7ba68e]">CGST</span><span className="tabular-nums">{fmtRup(num(inv.cgst_total))}</span></div>}
                  {num(inv.sgst_total) > 0 && <div className="flex justify-between"><span className="text-[#7ba68e]">SGST</span><span className="tabular-nums">{fmtRup(num(inv.sgst_total))}</span></div>}
                  {num(inv.igst_total) > 0 && <div className="flex justify-between"><span className="text-[#7ba68e]">IGST</span><span className="tabular-nums">{fmtRup(num(inv.igst_total))}</span></div>}
                  {num(inv.tds_total) > 0 && <div className="flex justify-between"><span className="text-[#7ba68e]">TDS</span><span className="tabular-nums text-amber-600">-{fmtRup(num(inv.tds_total))}</span></div>}
                  {num(inv.round_off) !== 0 && <div className="flex justify-between"><span className="text-[#7ba68e]">Round Off</span><span className="tabular-nums">{fmtRup(num(inv.round_off))}</span></div>}
                  <div className="border-t border-[#c8e0d0] pt-1.5 mt-1.5" />
                  <div className="flex justify-between font-bold text-[12px]"><span className="text-[#1a3a2a]">Invoice Total</span><span className="tabular-nums">{fmtRup(total)}</span></div>
                </div>

                <div className="bg-white rounded-lg border border-[#c8e0d0] p-3 space-y-1.5 text-[11px]">
                  <div className="text-[9px] font-semibold text-[#4a7c5c] uppercase tracking-wide mb-1">Payment</div>
                  <div className="flex justify-between"><span className="text-[#7ba68e]">Received</span><span className="tabular-nums font-medium text-emerald-600">{fmtRup(received)}</span></div>
                  {num(inv.tds_at_payment) > 0 && <div className="flex justify-between"><span className="text-[#7ba68e]">TDS at Payment</span><span className="tabular-nums text-amber-600">{fmtRup(num(inv.tds_at_payment))}</span></div>}
                  <div className="border-t border-[#c8e0d0] pt-1.5 mt-1.5" />
                  <div className="flex justify-between font-bold text-[12px]">
                    <span className="text-[#1a3a2a]">Outstanding</span>
                    <span className={`tabular-nums ${bal > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{fmtRup(bal)}</span>
                  </div>
                </div>

                {dueDate && bal > 0 && (() => {
                  const days = Math.round((new Date() - new Date(dueDate)) / 86400000);
                  return days > 0 ? (
                    <div className="bg-red-50 rounded-lg border border-red-200 p-3 text-center">
                      <div className="text-[10px] font-semibold text-red-800 uppercase">Overdue</div>
                      <div className="text-lg font-bold text-red-600 mt-0.5">{days} days</div>
                      <div className="text-[10px] text-red-500">Due {formatDate(dueDate)}</div>
                    </div>
                  ) : null;
                })()}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Main component ──────────────────────────────────────────────────
export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [stats, setStats] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [buckets, setBuckets] = useState(null);
  const [dispLines, setDispLines] = useState([]);
  const [momTrend, setMomTrend] = useState([]);
  const [activeSection, setActiveSection] = useState('unpaid');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [profileCollapsed, setProfileCollapsed] = useState(false);
  const [popupInvoiceId, setPopupInvoiceId] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState({ Receivables: true });

  // Date range filter — defaults to current FY
  const defaultPreset = DATE_PRESETS[0];
  const [dateFrom, setDateFrom] = useState(defaultPreset.from);
  const [dateTo, setDateTo] = useState(() => {
    const t = _isoDate(_today);
    return defaultPreset.to > t ? t : defaultPreset.to;
  });
  const [activePeriod, setActivePeriod] = useState(defaultPreset.key);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const applyPreset = useCallback((p) => {
    const t = _isoDate(_today);
    setDateFrom(p.from);
    setDateTo(p.to > t ? t : p.to);
    setActivePeriod(p.key);
    setShowDatePicker(false);
  }, []);

  const applyCustom = useCallback((from, to) => {
    setDateFrom(from);
    setDateTo(to);
    setActivePeriod('custom');
    setShowDatePicker(false);
  }, []);

  const periodLabel = useMemo(() => {
    if (activePeriod === 'custom') {
      return `${fmtDate(dateFrom)} — ${fmtDate(dateTo)}`;
    }
    const p = DATE_PRESETS.find(x => x.key === activePeriod);
    return p?.label || '';
  }, [activePeriod, dateFrom, dateTo]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    const qs = `customer=${id}&period=custom&from=${dateFrom}&to=${dateTo}&basis=turnover`;
    Promise.all([
      apiClient.get(`/api/customers/${id}/`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/sales/dashboard/?${qs}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/sales/receivables/customer-ledger/?customer=${id}&from=${dateFrom}&to=${dateTo}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/sales/dashboard/records/?type=receivables_buckets&${qs}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/sales/dashboard/records/?type=dispatches&${qs}`).then(r => r.data?.rows || []).catch(() => []),
      apiClient.get(`/api/sales/dashboard/analytics/?${qs}`).then(r => r.data?.mom_trend || []).catch(() => []),
    ]).then(([prof, dash, led, bkt, disp, trend]) => {
      setProfile(prof);
      setStats(dash?.stats || null);
      setLedger(led);
      setBuckets(bkt);
      setDispLines(disp.flatMap(row => (row.lines || []).map(l => ({ ...l, date: row.date }))));
      setMomTrend(trend || []);
    }).catch(err => {
      console.error('Customer 360 load failed', err);
    }).finally(() => setLoading(false));
  }, [id, dateFrom, dateTo]);

  const goBack = useCallback(() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/sales/customer-360'), [navigate]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (popupInvoiceId) return;
        if (showDatePicker) { setShowDatePicker(false); return; }
        goBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack, popupInvoiceId, showDatePicker]);

  // Close date picker on outside click
  useEffect(() => {
    if (!showDatePicker) return;
    const onClick = (e) => {
      if (!e.target.closest('[data-datepicker]')) setShowDatePicker(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showDatePicker]);

  const toggleGroup = (title) => {
    setExpandedGroups(prev => ({ ...prev, [title]: !prev[title] }));
  };

  const selectSection = (sectionId) => {
    setActiveSection(sectionId);
    for (const g of NAV_GROUPS) {
      if (g.items.some(it => it.id === sectionId)) {
        setExpandedGroups(prev => ({ ...prev, [g.title]: true }));
        break;
      }
    }
  };

  // Derived data
  const rs = stats?.received_against_sales || {};
  const out = stats?.outstanding_receivables || {};
  const outstanding = num(out.as_at_total ?? out.total ?? profile?.total_outstanding);
  const totalSales = num(ledger?.current_debit ?? rs.incl_gst ?? profile?.total_sales);
  const received = num(ledger?.current_credit ?? stats?.amount_received?.total);
  const invCount = num(stats?.quantity_invoiced?.invoice_count);
  const overdue = num(profile?.total_overdue ?? 0);
  const creditTerms = profile?.credit_terms || '';
  const creditDays = CREDIT_DAYS[creditTerms] ?? 30;

  // Credit notes total from ledger rows
  const creditNotesTotal = useMemo(() => {
    if (!ledger?.rows) return 0;
    return ledger.rows
      .filter(r => r.type === 'Credit Note')
      .reduce((s, r) => s + num(r.credit), 0);
  }, [ledger]);

  // Unpaid invoices from bucket rows (unsettled_bills — Tally-style bill allocation)
  const unpaidRaw = useMemo(() => {
    if (!buckets?.groups) return [];
    // Lookup original invoice amount from ledger rows
    const invMap = {};
    if (ledger?.rows) {
      for (const lr of ledger.rows) {
        if (lr.type === 'Invoice' && lr.ref_id) invMap[lr.ref_id] = num(lr.debit);
      }
    }
    const rows = [];
    for (const g of buckets.groups) {
      for (const sub of (g.sub || [])) {
        if (sub.key !== 'still_open' && sub.key !== 'overdue_unpaid') continue;
        for (const r of (sub.rows || [])) {
          const amt = num(r.amount);
          if (amt <= 0) continue;
          rows.push({
            inv: r.invoice_no || '',
            ref_id: r.invoice_id || '',
            date: fmtDate(r.invoice_date),
            rawDate: r.invoice_date || '',
            due: fmtDate(r.due_date),
            rawDue: r.due_date || '',
            daysLate: num(r.days),
            status: sub.key === 'overdue_unpaid' ? 'OVERDUE' : 'OPEN',
            invoiced: invMap[r.invoice_id] || 0,
            amount: amt,
            tds: 0,
          });
        }
      }
    }
    return rows.sort((a, b) => a.rawDate.localeCompare(b.rawDate));
  }, [buckets, ledger]);

  const groupByMonth = (rows, dateField) => {
    const grouped = new Map();
    for (const r of rows) {
      const d = r[dateField] || r.rawDate;
      const key = d ? d.slice(0, 7) : 'Unknown';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }
    return [...grouped.entries()].map(([k, v]) => ({ month: k, label: monthLabel(k), items: v, total: v.reduce((s, r) => s + r.amount, 0) }));
  };

  const unpaidInvoices = useMemo(() => ({
    rows: unpaidRaw,
    grouped: groupByMonth(unpaidRaw, 'rawDate'),
  }), [unpaidRaw]);

  const overdueInvoices = useMemo(() => {
    const rows = unpaidRaw.filter(i => i.daysLate > 0).sort((a, b) => a.rawDue.localeCompare(b.rawDue));
    return { rows, grouped: groupByMonth(rows, 'rawDue') };
  }, [unpaidRaw]);

  // Ageing buckets — flatten from groups → sub structure
  const ageingData = useMemo(() => {
    const bands = buckets?.reconciliation?.ageing;
    if (bands?.length) {
      return bands.filter(b => num(b.amount) !== 0).map(b => ({
        label: b.label || b.key || '',
        amount: num(b.amount),
        count: b.count ?? 0,
      }));
    }
    if (!buckets?.groups) return [];
    return buckets.groups.flatMap(g => (g.sub || []).filter(s => s.key === 'still_open' || s.key === 'overdue_unpaid').map(s => ({
      label: s.label || s.key || '',
      amount: num(s.total),
      count: s.count ?? (s.rows || []).length,
    }))).filter(b => b.amount !== 0);
  }, [buckets]);

  // Split unpaid into overdue vs upcoming (not yet due) for Credit & Ageing
  const overdueByBand = useMemo(() => {
    const rows = unpaidRaw.filter(r => r.status === 'OVERDUE');
    const bands = [
      { key: '0_30', label: '0-30 Days', min: 0, max: 30, rows: [], total: 0 },
      { key: '31_60', label: '31-60 Days', min: 31, max: 60, rows: [], total: 0 },
      { key: '61_90', label: '61-90 Days', min: 61, max: 90, rows: [], total: 0 },
      { key: '91_180', label: '91-180 Days', min: 91, max: 180, rows: [], total: 0 },
      { key: '180_plus', label: '180+ Days', min: 181, max: 99999, rows: [], total: 0 },
    ];
    for (const r of rows) {
      const d = r.daysLate;
      const b = bands.find(b => d >= b.min && d <= b.max);
      if (b) { b.rows.push(r); b.total += r.amount; }
    }
    return { bands: bands.filter(b => b.rows.length > 0), total: rows.reduce((s, r) => s + r.amount, 0), count: rows.length };
  }, [unpaidRaw]);

  const upcomingPayments = useMemo(() => {
    const rows = unpaidRaw.filter(r => r.status === 'OPEN');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() + (7 - today.getDay()));
    const endOfNextWeek = new Date(endOfWeek);
    endOfNextWeek.setDate(endOfNextWeek.getDate() + 7);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const buckets = [
      { key: 'this_week', label: 'This Week', rows: [], total: 0 },
      { key: 'next_week', label: 'Next Week', rows: [], total: 0 },
      { key: 'this_month', label: 'Rest of Month', rows: [], total: 0 },
      { key: 'later', label: 'Beyond This Month', rows: [], total: 0 },
    ];
    for (const r of rows) {
      const due = r.rawDue ? new Date(r.rawDue) : null;
      if (!due) { buckets[3].rows.push(r); buckets[3].total += r.amount; continue; }
      if (due <= endOfWeek) { buckets[0].rows.push(r); buckets[0].total += r.amount; }
      else if (due <= endOfNextWeek) { buckets[1].rows.push(r); buckets[1].total += r.amount; }
      else if (due <= endOfMonth) { buckets[2].rows.push(r); buckets[2].total += r.amount; }
      else { buckets[3].rows.push(r); buckets[3].total += r.amount; }
    }
    return { buckets: buckets.filter(b => b.rows.length > 0), total: rows.reduce((s, r) => s + r.amount, 0), count: rows.length };
  }, [unpaidRaw]);

  // All invoices from ledger rows
  const allInvoices = useMemo(() => {
    if (!ledger?.rows) return [];
    return ledger.rows
      .filter(r => r.type === 'Invoice' || r.type === 'Debit Note')
      .map(r => ({
        inv: r.doc_no || '',
        date: fmtDate(r.date),
        status: num(r.outstanding) <= 0 ? 'PAID' : (r.due_date && new Date(r.due_date) < new Date() ? 'OVERDUE' : 'UNPAID'),
        amount: num(r.debit),
        balance: num(r.outstanding),
        ref_id: r.ref_id || '',
        type: r.type,
      }));
  }, [ledger]);

  // Tally ledger entries — full rows array with running balance
  const ledgerEntries = useMemo(() => {
    if (!ledger?.rows) return [];
    return ledger.rows.map(e => ({
      date: fmtDate(e.date),
      particulars: e.narration || e.doc_no || '',
      type: e.type || '',
      vno: e.doc_no || '',
      debit: num(e.debit),
      credit: num(e.credit),
      balance: num(e.balance),
      ref_id: e.ref_id || '',
      ref_kind: e.ref_kind || '',
    }));
  }, [ledger]);

  const openEntry = useCallback((entry) => {
    if (!entry.ref_id) return;
    if (entry.type === 'Invoice') {
      setPopupInvoiceId(entry.ref_id);
    } else if (entry.ref_kind === 'note') {
      window.open(`/sales/receivables/${entry.ref_id}`, '_blank');
    }
  }, []);

  // Item analytics from dispatch lines — rate = amount / qty (backend has no rate field)
  const itemAnalytics = useMemo(() => {
    const m = new Map();
    for (const l of dispLines) {
      const name = l.product || l.item || '—';
      if (!m.has(name)) m.set(name, { name, qty: 0, value: 0, prices: [], uom: l.uom || '' });
      const rec = m.get(name);
      const q = num(l.qty);
      const a = num(l.amount || l.value || 0);
      rec.qty += q;
      rec.value += a;
      const rate = num(l.rate) || (q > 0 ? a / q : 0);
      if (rate > 0) rec.prices.push(rate);
    }
    return [...m.values()].map(r => ({
      ...r,
      avg: r.prices.length ? Math.round(r.prices.reduce((a, b) => a + b, 0) / r.prices.length) : 0,
      min: r.prices.length ? Math.round(Math.min(...r.prices)) : 0,
      max: r.prices.length ? Math.round(Math.max(...r.prices)) : 0,
    })).sort((a, b) => b.value - a.value);
  }, [dispLines]);

  // Month-wise pivot: product × month → qty, value, avg price
  const itemMonthPivot = useMemo(() => {
    const m = new Map();
    const months = new Set();
    for (const l of dispLines) {
      const name = l.product || l.item || '—';
      const ym = (l.date || '').slice(0, 7);
      if (!ym) continue;
      months.add(ym);
      const key = `${name}|${ym}`;
      if (!m.has(key)) m.set(key, { product: name, month: ym, qty: 0, value: 0 });
      const rec = m.get(key);
      rec.qty += num(l.qty);
      rec.value += num(l.amount || l.value || 0);
    }
    const sortedMonths = [...months].sort();
    const byProduct = new Map();
    for (const r of m.values()) {
      if (!byProduct.has(r.product)) byProduct.set(r.product, { product: r.product, months: {} });
      byProduct.get(r.product).months[r.month] = { qty: r.qty, value: r.value, avg: r.qty > 0 ? Math.round(r.value / r.qty) : 0 };
    }
    return { months: sortedMonths, products: [...byProduct.values()] };
  }, [dispLines]);

  const gstData = useMemo(() => {
    if (!stats) return {};
    const rs2 = stats.received_against_sales || {};
    return {
      taxable: num(rs2.taxable),
      gst: num(rs2.gst),
      cgst: num(rs2.cgst),
      sgst: num(rs2.sgst),
      igst: num(rs2.igst),
      incl_gst: num(rs2.incl_gst),
      debit_notes: num(rs2.debit_notes),
      credit_notes: num(rs2.credit_notes),
      other_charges: num(rs2.other_charges),
      round_off: num(rs2.round_off),
    };
  }, [stats]);

  // TDS from stats — `tds` is invoice-level, `tds_at_payment` is buyer withholding
  const tdsData = useMemo(() => {
    if (!stats) return {};
    const rs2 = stats.received_against_sales || {};
    const invoiceTds = num(rs2.tds);
    const paymentTds = num(rs2.tds_at_payment);
    const noteDebits = num(rs2.tds_note_debits);
    const reversed = num(rs2.tds_reversed);
    const ledgerTds = (ledger?.rows || [])
      .reduce((s, r) => s + num(r.tds), 0);
    return {
      invoice_tds: invoiceTds,
      payment_tds: paymentTds,
      note_debits: noteDebits,
      reversed,
      net: invoiceTds + noteDebits + paymentTds - reversed,
      ledger_total: ledgerTds,
    };
  }, [stats, ledger]);

  // Returns/DN/CN from ledger rows
  const returnEntries = useMemo(() => {
    if (!ledger?.rows) return [];
    return ledger.rows
      .filter(r => r.type === 'Debit Note' || r.type === 'Credit Note')
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [ledger]);

  // Payment behaviour from ledger rows (type === 'Receipt')
  const paymentData = useMemo(() => {
    if (!ledger?.rows) return { receipts: [], avgDays: 0, onTimeRate: 0 };
    const receipts = ledger.rows
      .filter(r => r.type === 'Receipt')
      .map(r => ({
        date: fmtDate(r.date),
        ref: r.doc_no || '',
        amount: num(r.credit),
        mode: r.mode || '',
      }));
    return { receipts, avgDays: 0, onTimeRate: 0 };
  }, [ledger]);

  // Contacts & addresses from profile
  const contacts = useMemo(() => {
    if (!profile) return [];
    const list = [];
    if (profile.contact_person) {
      list.push({
        name: profile.contact_person,
        role: 'Primary Contact',
        phone: profile.contact_phone || profile.phone || '',
        email: profile.contact_email || profile.email || '',
      });
    }
    return list;
  }, [profile]);

  const addresses = useMemo(() => {
    if (!profile) return [];
    const list = [];
    const ba = profile.billing_address && typeof profile.billing_address === 'object' ? profile.billing_address : {};
    const baLine = [ba.raw_address || (typeof profile.billing_address === 'string' ? profile.billing_address : ''), ba.district || profile.billing_city, ba.state || profile.billing_state, ba.pincode || profile.billing_pincode].filter(Boolean).join(', ');
    if (baLine) {
      list.push({ label: 'Billing Address', line: baLine });
    }
    const shipping = profile.shipping_addresses || [];
    for (const s of shipping) {
      list.push({
        label: s.label || 'Shipping Address',
        line: [s.address, s.city, s.state, s.pincode].filter(Boolean).join(', '),
      });
    }
    return list;
  }, [profile]);

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 bg-white flex items-center justify-center">
        <button onClick={goBack} className="absolute top-4 right-4 p-2 rounded-lg hover:bg-slate-100 text-slate-400"><X size={20} /></button>
        <Loader2 size={24} className="animate-spin mr-3 text-emerald-600" />
        <span className="text-slate-500">Loading customer data...</span>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="fixed inset-0 z-50 bg-white flex flex-col items-center justify-center gap-3">
        <button onClick={goBack} className="absolute top-4 right-4 p-2 rounded-lg hover:bg-slate-100 text-slate-400"><X size={20} /></button>
        <div className="text-slate-400">Customer not found.</div>
        <button onClick={goBack} className="text-sm text-emerald-600 hover:underline flex items-center gap-1"><ChevronLeft size={14} /> Back to list</button>
      </div>
    );
  }

  const custName = profile.customer_name || profile.name || '';
  const initials = custName.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

  // ── Section renderers ─────────────────────────────────────────────
  const renderSection = () => {
    switch (activeSection) {
      case 'unpaid':
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard label="Total Unpaid" value={fmtINR(unpaidInvoices.rows.reduce((s, r) => s + r.amount, 0))} color="text-amber-600" />
              <SummaryCard label="Unpaid Invoices" value={unpaidInvoices.rows.length} />
              {creditNotesTotal > 0 && <SummaryCard label="Credit Notes" value={`-${fmtINR(creditNotesTotal)}`} sub="netted against invoices" color="text-teal-600" />}
              <SummaryCard label="Overdue" value={unpaidInvoices.rows.filter(r => r.daysLate > 0).length} sub="invoices past due" color="text-red-600" />
            </div>
            {unpaidInvoices.grouped.length > 0 ? unpaidInvoices.grouped.map(g => (
              <div key={g.month}>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-semibold text-[#4a7c5c] uppercase tracking-wide">{g.label}</div>
                  <div className="text-xs font-bold text-amber-600">{fmtINR(g.total)}</div>
                </div>
                <DataTable
                  columns={[
                    { key: 'inv', label: 'Invoice', render: r => r.ref_id ? <button type="button" onClick={() => setPopupInvoiceId(r.ref_id)} className="text-emerald-700 hover:text-emerald-900 hover:underline font-medium text-left">{r.inv}</button> : r.inv },
                    { key: 'date', label: 'Date' },
                    { key: 'due', label: 'Due Date' },
                    { key: 'daysLate', label: 'Days Late', align: 'right', render: r => r.daysLate > 0 ? <span className="text-red-600 font-semibold">{r.daysLate}d</span> : <span className="text-[#7ba68e]">—</span> },
                    { key: 'status', label: 'Status', render: r => <Pill color={r.status === 'OVERDUE' ? 'red' : r.status === 'PARTIAL' ? 'amber' : 'blue'}>{r.status}</Pill> },
                    { key: 'invoiced', label: 'Invoiced', align: 'right', render: r => r.invoiced > 0 ? <span className="text-[#7ba68e]">{fmtRup(r.invoiced)}</span> : <span className="text-slate-300">—</span> },
                    { key: 'amount', label: 'Outstanding', align: 'right', render: r => <span className="font-semibold">{fmtRup(r.amount)}</span> },
                  ]}
                  rows={g.items}
                  maxH="max-h-none"
                />
              </div>
            )) : <div className="text-center py-16 text-[#7ba68e]">No unpaid invoices</div>}
          </div>
        );

      case 'overdue':
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <SummaryCard label="Total Overdue" value={fmtINR(overdueInvoices.rows.reduce((s, r) => s + r.amount, 0))} color="text-red-600" />
              <SummaryCard label="Overdue Invoices" value={overdueInvoices.rows.length} />
              {overdueInvoices.rows.length > 0 && <SummaryCard label="Oldest Due" value={overdueInvoices.rows[0]?.due || '—'} sub={`${overdueInvoices.rows[0]?.daysLate || 0} days late`} color="text-red-600" />}
            </div>
            {overdueInvoices.grouped.length > 0 ? overdueInvoices.grouped.map(g => (
              <div key={g.month}>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-semibold text-[#4a7c5c] uppercase tracking-wide">{g.label}</div>
                  <div className="text-xs font-bold text-red-600">{fmtINR(g.total)}</div>
                </div>
                <DataTable
                  columns={[
                    { key: 'inv', label: 'Invoice', render: r => r.ref_id ? <button type="button" onClick={() => setPopupInvoiceId(r.ref_id)} className="text-emerald-700 hover:text-emerald-900 hover:underline font-medium text-left">{r.inv}</button> : r.inv },
                    { key: 'date', label: 'Inv Date' },
                    { key: 'due', label: 'Due Date' },
                    { key: 'daysLate', label: 'Days Late', align: 'right', render: r => <span className="text-red-600 font-semibold">{r.daysLate}d</span> },
                    { key: 'invoiced', label: 'Invoiced', align: 'right', render: r => r.invoiced > 0 ? <span className="text-[#7ba68e]">{fmtRup(r.invoiced)}</span> : <span className="text-slate-300">—</span> },
                    { key: 'amount', label: 'Outstanding', align: 'right', render: r => <span className="font-semibold text-red-600">{fmtRup(r.amount)}</span> },
                  ]}
                  rows={g.items}
                  maxH="max-h-none"
                />
              </div>
            )) : <div className="text-center py-16 text-[#7ba68e]">No overdue invoices</div>}
          </div>
        );

      case 'credit':
        return (
          <div className="space-y-5">
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard label="Outstanding" value={fmtINR(outstanding)} sub={`${num(out.count)} unpaid`} color="text-amber-600" />
              <SummaryCard label="Received" value={fmtINR(received)} color="text-sky-600" />
              <SummaryCard label="Credit Terms" value={creditLabel(creditTerms)} />
              <SummaryCard label="Total Sales" value={fmtINR(totalSales)} color="text-emerald-600" />
            </div>

            {/* ── OVERDUE SECTION ── */}
            <div className="bg-white rounded-lg border border-red-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-red-50 border-b border-red-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={14} className="text-red-500" />
                  <span className="text-xs font-bold text-red-800 uppercase tracking-wide">Overdue</span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-red-600 font-bold">{fmtINR(overdueByBand.total)}</span>
                  <span className="text-red-400">{overdueByBand.count} invoice{overdueByBand.count !== 1 ? 's' : ''}</span>
                </div>
              </div>
              {overdueByBand.bands.length > 0 ? (
                <div className="p-4 space-y-4">
                  {/* Band cards */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                    {[
                      { key: '0_30', label: '0-30 Days' },
                      { key: '31_60', label: '31-60 Days' },
                      { key: '61_90', label: '61-90 Days' },
                      { key: '91_180', label: '91-180 Days' },
                      { key: '180_plus', label: '180+ Days' },
                    ].map((def, i) => {
                      const b = overdueByBand.bands.find(b => b.key === def.key);
                      const colors = ['#f59e0b', '#f97316', '#ef4444', '#dc2626', '#991b1b'];
                      return (
                        <div key={def.key} className={`rounded-lg border p-2.5 text-center ${b ? 'border-red-200 bg-red-50/50' : 'border-slate-100 bg-slate-50/50'}`}>
                          <div className="text-[10px] font-semibold text-slate-500 uppercase">{def.label}</div>
                          <div className="text-base font-bold mt-0.5" style={{ color: b ? colors[i] : '#cbd5e1' }}>{b ? fmtINR(b.total) : '—'}</div>
                          <div className="text-[10px] text-slate-400">{b ? `${b.rows.length} inv` : ''}</div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Overdue invoice rows */}
                  {overdueByBand.bands.map(b => (
                    <div key={b.key}>
                      <div className="text-[10px] font-semibold text-red-700 uppercase tracking-wide mb-1.5">{b.label} overdue — {fmtINR(b.total)}</div>
                      <DataTable
                        columns={[
                          { key: 'inv', label: 'Invoice', render: r => r.ref_id ? <button type="button" onClick={() => setPopupInvoiceId(r.ref_id)} className="text-emerald-700 hover:text-emerald-900 hover:underline font-medium text-left">{r.inv}</button> : r.inv },
                          { key: 'date', label: 'Inv Date' },
                          { key: 'due', label: 'Due Date' },
                          { key: 'daysLate', label: 'Days Late', align: 'right', render: r => <span className="text-red-600 font-semibold">{r.daysLate}d</span> },
                          { key: 'amount', label: 'Outstanding', align: 'right', render: r => <span className="font-semibold text-red-600">{fmtRup(r.amount)}</span> },
                        ]}
                        rows={b.rows}
                        maxH="max-h-none"
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-8 text-center text-sm text-slate-400">No overdue invoices</div>
              )}
            </div>

            {/* ── UPCOMING PAYMENTS SECTION ── */}
            <div className="bg-white rounded-lg border border-emerald-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-emerald-50 border-b border-emerald-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Calendar size={14} className="text-emerald-600" />
                  <span className="text-xs font-bold text-emerald-800 uppercase tracking-wide">Upcoming Payments</span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-emerald-600 font-bold">{fmtINR(upcomingPayments.total)}</span>
                  <span className="text-emerald-400">{upcomingPayments.count} invoice{upcomingPayments.count !== 1 ? 's' : ''}</span>
                </div>
              </div>
              {upcomingPayments.buckets.length > 0 ? (
                <div className="p-4 space-y-4">
                  {/* Timing cards */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {upcomingPayments.buckets.map((b, i) => {
                      const colors = ['#059669', '#0d9488', '#0ea5e9', '#6366f1'];
                      return (
                        <div key={b.key} className="rounded-lg border border-emerald-100 bg-emerald-50/40 p-2.5 text-center">
                          <div className="text-[10px] font-semibold text-slate-500 uppercase">{b.label}</div>
                          <div className="text-base font-bold mt-0.5" style={{ color: colors[i] || '#059669' }}>{fmtINR(b.total)}</div>
                          <div className="text-[10px] text-slate-400">{b.rows.length} invoice{b.rows.length !== 1 ? 's' : ''}</div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Upcoming invoice rows */}
                  {upcomingPayments.buckets.map(b => (
                    <div key={b.key}>
                      <div className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wide mb-1.5">{b.label} — {fmtINR(b.total)}</div>
                      <DataTable
                        columns={[
                          { key: 'inv', label: 'Invoice', render: r => r.ref_id ? <button type="button" onClick={() => setPopupInvoiceId(r.ref_id)} className="text-emerald-700 hover:text-emerald-900 hover:underline font-medium text-left">{r.inv}</button> : r.inv },
                          { key: 'date', label: 'Inv Date' },
                          { key: 'due', label: 'Due Date' },
                          { key: 'daysLate', label: 'Days to Due', align: 'right', render: r => <span className="text-emerald-600 font-medium">{r.daysLate}d</span> },
                          { key: 'amount', label: 'Amount Due', align: 'right', render: r => <span className="font-semibold text-[#1a3a2a]">{fmtRup(r.amount)}</span> },
                        ]}
                        rows={b.rows}
                        maxH="max-h-none"
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-8 text-center text-sm text-slate-400">No upcoming payments — all invoices are either paid or overdue</div>
              )}
            </div>
          </div>
        );

      case 'trend':
        return (
          <div className="space-y-4">
            {momTrend.length > 0 ? (
              <div className="bg-white rounded-lg border border-[#c8e0d0] p-4">
                <div className="text-xs font-semibold text-[#4a7c5c] uppercase tracking-wide mb-3">Monthly Trend ({periodLabel})</div>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={momTrend.map(m => ({ month: (m.label || m.month || '').replace(' 20', " '"), invoiced: num(m.invoiced), received: num(m.received) }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#c8e0d0" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={v => fmtINR(v)} tick={{ fontSize: 11 }} />
                    <RTooltip contentStyle={tooltipStyle} formatter={(v, name) => [fmtRup(v), name === 'invoiced' ? 'Invoiced' : 'Received']} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="invoiced" fill="#10b981" radius={[4, 4, 0, 0]} name="Invoiced" />
                    <Bar dataKey="received" fill="#0ea5e9" radius={[4, 4, 0, 0]} name="Received" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="text-center py-16 text-[#7ba68e]">No monthly trend data available</div>
            )}
          </div>
        );

      case 'items':
        return (
          <div className="space-y-5">
            <DataTable
              columns={[
                { key: 'name', label: 'Product' },
                { key: 'qty', label: 'Qty', align: 'right', render: r => `${fmtQty(r.qty)} ${r.uom}` },
                { key: 'avg', label: 'Avg Price', align: 'right', render: r => r.avg ? <span className="font-semibold">{fmtRup(r.avg)}</span> : '—' },
                { key: 'min', label: 'Min', align: 'right', render: r => r.min ? <span className="text-emerald-600">{fmtRup(r.min)}</span> : '—' },
                { key: 'max', label: 'Max', align: 'right', render: r => r.max ? <span className="text-red-600">{fmtRup(r.max)}</span> : '—' },
                { key: 'value', label: 'Total Value', align: 'right', render: r => <span className="font-semibold">{fmtINR(r.value)}</span> },
              ]}
              rows={itemAnalytics}
              emptyMsg="No item data available"
            />
            {itemMonthPivot.months.length > 0 && (
              <>
                <div className="text-xs font-semibold text-[#4a7c5c] uppercase tracking-wide">Month-wise Breakdown</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px] border-collapse">
                    <thead>
                      <tr className="bg-[#f0f7f4] border-b-2 border-[#c8e0d0]">
                        <th className="px-2 py-1.5 text-left text-[10px] font-semibold text-[#4a7c5c] uppercase tracking-wide sticky left-0 bg-[#f0f7f4] z-[1]">Product</th>
                        {itemMonthPivot.months.map(ym => (
                          <th key={ym} colSpan={2} className="px-1 py-1.5 text-center text-[10px] font-semibold text-[#4a7c5c] uppercase tracking-wide border-l border-[#c8e0d0]">{monthLabel(ym)}</th>
                        ))}
                      </tr>
                      <tr className="bg-[#e4f2ea] border-b border-[#c8e0d0]">
                        <th className="px-2 py-1 sticky left-0 bg-[#e4f2ea] z-[1]"></th>
                        {itemMonthPivot.months.map(ym => (
                          <React.Fragment key={ym}>
                            <th className="px-1 py-1 text-right text-[9px] text-[#4a7c5c] border-l border-[#c8e0d0]">Qty</th>
                            <th className="px-1 py-1 text-right text-[9px] text-[#4a7c5c]">Avg ₹</th>
                          </React.Fragment>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {itemMonthPivot.products.map((p, i) => (
                        <tr key={i} className="border-b border-[#e4f2ea] hover:bg-[#e4f2ea] transition-colors">
                          <td className="px-2 py-1.5 font-medium sticky left-0 bg-white z-[1]">{p.product}</td>
                          {itemMonthPivot.months.map(ym => {
                            const d = p.months[ym];
                            return (
                              <React.Fragment key={ym}>
                                <td className="px-1 py-1.5 text-right tabular-nums border-l border-[#e4f2ea]">{d ? fmtQty(d.qty) : '—'}</td>
                                <td className="px-1 py-1.5 text-right tabular-nums font-medium">{d?.avg ? fmtRup(d.avg) : '—'}</td>
                              </React.Fragment>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        );

      case 'invoices':
        return (
          <DataTable
            columns={[
              { key: 'inv', label: 'Invoice', render: r => r.ref_id && r.type === 'Invoice' ? <button type="button" onClick={() => setPopupInvoiceId(r.ref_id)} className="text-emerald-700 hover:text-emerald-900 hover:underline font-medium text-left">{r.inv}</button> : r.inv },
              { key: 'date', label: 'Date' },
              { key: 'status', label: 'Status', render: r => <Pill color={r.status === 'PAID' ? 'green' : r.status === 'PARTIAL' ? 'amber' : 'red'}>{r.status}</Pill> },
              { key: 'amount', label: 'Amount', align: 'right', render: r => <span className="font-semibold">{fmtRup(r.amount)}</span> },
              { key: 'balance', label: 'Balance', align: 'right', render: r => r.balance > 0 ? <span className="text-amber-600">{fmtRup(r.balance)}</span> : <span className="text-slate-400">—</span> },
            ]}
            rows={allInvoices}
            emptyMsg="No invoices found"
          />
        );

      case 'ledger':
        return (
          <div className="bg-[#f8fcf9] border-2 border-[#b8d4c2] rounded font-mono text-[11px] text-[#1a3a2a]">
            <div className="text-center font-bold text-[13px] tracking-wide py-2 bg-[#d1e8d8] border-b-2 border-[#b8d4c2]">{custName}</div>
            <div className="text-center text-[11px] py-1 border-b border-[#b8d4c2] text-[#4a7c5c]">
              {fmtDate(dateFrom)} to {fmtDate(dateTo)}
            </div>
            <div className="grid grid-cols-2 border-b-2 border-[#b8d4c2]">
              <div className="p-2.5 border-r-2 border-[#b8d4c2]">
                <div className="text-[10px] text-[#4a7c5c] font-sans font-medium">Opening Balance</div>
                <div className="font-semibold">{fmtRup(num(ledger?.opening_balance))} Dr</div>
              </div>
              <div className="p-2.5">
                <div className="text-[10px] text-[#4a7c5c] font-sans font-medium">Closing Balance</div>
                <div className="font-semibold text-[#dc2626]">{fmtRup(num(ledger?.closing_balance || outstanding))} {outstanding >= 0 ? 'Dr' : 'Cr'}</div>
              </div>
            </div>
            <div className="grid grid-cols-2 border-b-2 border-[#b8d4c2]">
              <div className="p-2.5 border-r-2 border-[#b8d4c2]">
                <div className="text-[10px] text-[#4a7c5c] font-sans font-medium">Current Period (Dr)</div>
                <div className="font-semibold">{fmtINR(num(ledger?.current_debit))}</div>
              </div>
              <div className="p-2.5">
                <div className="text-[10px] text-[#4a7c5c] font-sans font-medium">Current Period (Cr)</div>
                <div className="font-semibold text-[#059669]">{fmtINR(num(ledger?.current_credit))}</div>
              </div>
            </div>
            <div className="max-h-[calc(100vh-320px)] overflow-y-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 z-[1]">
                  <tr className="bg-[#d1e8d8] border-b-2 border-[#b8d4c2]">
                    <th className="px-2.5 py-1.5 text-left text-[10px] uppercase tracking-wide font-semibold">Date</th>
                    <th className="px-2.5 py-1.5 text-left text-[10px] uppercase tracking-wide font-semibold">Particulars</th>
                    <th className="px-2.5 py-1.5 text-left text-[10px] uppercase tracking-wide font-semibold">Vch Type</th>
                    <th className="px-2.5 py-1.5 text-left text-[10px] uppercase tracking-wide font-semibold">Vch No.</th>
                    <th className="px-2.5 py-1.5 text-right text-[10px] uppercase tracking-wide font-semibold">Debit</th>
                    <th className="px-2.5 py-1.5 text-right text-[10px] uppercase tracking-wide font-semibold">Credit</th>
                    <th className="px-2.5 py-1.5 text-right text-[10px] uppercase tracking-wide font-semibold">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerEntries.map((e, i) => (
                    <tr key={i} onClick={() => openEntry(e)} className={`border-b border-[#b8d4c2] hover:bg-[#e4f2ea] transition-colors ${e.ref_id ? 'cursor-pointer' : ''}`}>
                      <td className="px-2.5 py-1.5">{e.date}</td>
                      <td className="px-2.5 py-1.5 font-sans">{e.particulars}</td>
                      <td className="px-2.5 py-1.5">{e.type && <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-medium font-sans ${VTYPE_CLS[e.type] || 'bg-[#e4f2ea] text-[#4a7c5c]'}`}>{e.type}</span>}</td>
                      <td className="px-2.5 py-1.5">{e.vno}</td>
                      <td className="px-2.5 py-1.5 text-right">{e.debit ? fmtRup(e.debit) : ''}</td>
                      <td className="px-2.5 py-1.5 text-right text-[#059669]">{e.credit ? fmtRup(e.credit) : ''}</td>
                      <td className="px-2.5 py-1.5 text-right">{fmtRup(Math.abs(e.balance))} {e.balance >= 0 ? 'Dr' : 'Cr'}</td>
                    </tr>
                  ))}
                  {ledgerEntries.length > 0 && (
                    <tr className="font-bold border-t-2 border-[#b8d4c2] bg-[#d1e8d8]">
                      <td colSpan={4} className="px-2.5 py-1.5 text-right">Total</td>
                      <td className="px-2.5 py-1.5 text-right">{fmtRup(ledgerEntries.reduce((s, e) => s + e.debit, 0))}</td>
                      <td className="px-2.5 py-1.5 text-right text-[#059669]">{fmtRup(ledgerEntries.reduce((s, e) => s + e.credit, 0))}</td>
                      <td className="px-2.5 py-1.5 text-right">{fmtRup(Math.abs(num(ledger?.closing_balance || outstanding)))} {outstanding >= 0 ? 'Dr' : 'Cr'}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );

      case 'gst': {
        const gstMonths = momTrend.filter(m => num(m.cgst) + num(m.sgst) + num(m.igst) > 0);
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <SummaryCard label="Ex-GST (Taxable)" value={fmtINR(gstData.taxable)} />
              <SummaryCard label="Total GST" value={fmtINR(gstData.gst)} color="text-emerald-600" />
              <SummaryCard label="Incl. GST" value={fmtINR(gstData.incl_gst)} sub="Total invoice value" />
            </div>
            {(gstData.cgst > 0 || gstData.sgst > 0 || gstData.igst > 0) && (
              <>
                <div className="text-xs font-semibold text-[#4a7c5c] uppercase tracking-wide">GST Breakup</div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-white rounded-lg border border-[#c8e0d0] p-3 text-center">
                    <div className="text-[10px] font-semibold text-[#4a7c5c] uppercase">CGST</div>
                    <div className="text-lg font-bold text-[#1a3a2a] mt-1">{fmtINR(gstData.cgst)}</div>
                  </div>
                  <div className="bg-white rounded-lg border border-[#c8e0d0] p-3 text-center">
                    <div className="text-[10px] font-semibold text-[#4a7c5c] uppercase">SGST</div>
                    <div className="text-lg font-bold text-[#1a3a2a] mt-1">{fmtINR(gstData.sgst)}</div>
                  </div>
                  <div className="bg-white rounded-lg border border-[#c8e0d0] p-3 text-center">
                    <div className="text-[10px] font-semibold text-[#4a7c5c] uppercase">IGST</div>
                    <div className="text-lg font-bold text-[#1a3a2a] mt-1">{fmtINR(gstData.igst)}</div>
                  </div>
                </div>
              </>
            )}
            {gstData.other_charges > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <SummaryCard label="Other Charges" value={fmtINR(gstData.other_charges)} sub="Freight / testing" />
                {gstData.round_off !== 0 && <SummaryCard label="Round Off" value={fmtRup(gstData.round_off)} />}
              </div>
            )}
            {(gstData.debit_notes > 0 || gstData.credit_notes > 0) && (
              <>
                <div className="text-xs font-semibold text-[#4a7c5c] uppercase tracking-wide">Debit / Credit Notes</div>
                <div className="grid grid-cols-2 gap-3">
                  <SummaryCard label="Debit Notes" value={fmtINR(gstData.debit_notes)} color="text-red-600" />
                  <SummaryCard label="Credit Notes" value={fmtINR(gstData.credit_notes)} color="text-emerald-600" />
                </div>
              </>
            )}
            {gstMonths.length > 0 && (
              <>
                <div className="text-xs font-semibold text-[#4a7c5c] uppercase tracking-wide">Monthly GST Pivot</div>
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[#c8e0d0] bg-[#f0f7f4]">
                        <th className="text-left px-3 py-2 text-[10px] font-semibold text-[#4a7c5c] uppercase">Month</th>
                        <th className="text-right px-3 py-2 text-[10px] font-semibold text-[#4a7c5c] uppercase">CGST</th>
                        <th className="text-right px-3 py-2 text-[10px] font-semibold text-[#4a7c5c] uppercase">SGST</th>
                        <th className="text-right px-3 py-2 text-[10px] font-semibold text-[#4a7c5c] uppercase">IGST</th>
                        <th className="text-right px-3 py-2 text-[10px] font-semibold text-[#4a7c5c] uppercase">Total GST</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gstMonths.map(m => {
                        const c = num(m.cgst), s = num(m.sgst), i = num(m.igst);
                        return (
                          <tr key={m.month} className="border-b border-[#e4f2ea] hover:bg-[#f8fcf9]">
                            <td className="px-3 py-2 font-medium text-[#1a3a2a]">{(m.label || m.month || '').replace(' 20', " '")}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{c > 0 ? fmtRup(c) : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{s > 0 ? fmtRup(s) : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{i > 0 ? fmtRup(i) : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums font-semibold text-[#4a7c5c]">{fmtRup(c + s + i)}</td>
                          </tr>
                        );
                      })}
                      <tr className="bg-[#f0f7f4] font-semibold">
                        <td className="px-3 py-2 text-[#1a3a2a]">Total</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtRup(gstMonths.reduce((a, m) => a + num(m.cgst), 0))}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtRup(gstMonths.reduce((a, m) => a + num(m.sgst), 0))}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtRup(gstMonths.reduce((a, m) => a + num(m.igst), 0))}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-[#4a7c5c]">{fmtRup(gstMonths.reduce((a, m) => a + num(m.cgst) + num(m.sgst) + num(m.igst), 0))}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        );
      }

      case 'tds':
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <SummaryCard label="TDS on Invoices" value={fmtINR(tdsData.invoice_tds)} sub="194Q on sales" color="text-amber-600" />
              <SummaryCard label="TDS at Payment" value={fmtINR(tdsData.payment_tds)} sub="Buyer withheld" color="text-amber-600" />
              {tdsData.note_debits > 0 && <SummaryCard label="TDS on DN" value={fmtINR(tdsData.note_debits)} sub="Debit note withholding" />}
              {tdsData.reversed > 0 && <SummaryCard label="TDS Reversed" value={fmtINR(tdsData.reversed)} sub="CN / Journal reversal" color="text-emerald-600" />}
              <SummaryCard label="Net TDS Receivable" value={fmtINR(tdsData.net)} sub="Debit − Credit" color="text-red-600" />
            </div>
            {(ledger?.rows || []).some(r => num(r.tds) > 0) && (
              <>
                <div className="text-xs font-semibold text-[#4a7c5c] uppercase tracking-wide mt-4">Bill-wise TDS</div>
                <DataTable
                  columns={[
                    { key: 'doc_no', label: 'Voucher' },
                    { key: 'type', label: 'Type', render: r => <Pill color={r.type === 'Invoice' ? 'blue' : r.type === 'Credit Note' ? 'teal' : 'amber'}>{r.type}</Pill> },
                    { key: 'date', label: 'Date', render: r => fmtDate(r.date) },
                    { key: 'amount', label: 'Amount', align: 'right', render: r => <span className="font-semibold">{fmtRup(num(r.debit || r.credit))}</span> },
                    { key: 'tds', label: 'TDS', align: 'right', render: r => <span className="text-amber-600 font-semibold">{fmtRup(num(r.tds))}</span> },
                  ]}
                  rows={(ledger?.rows || []).filter(r => num(r.tds) > 0)}
                  emptyMsg="No TDS entries"
                />
              </>
            )}
          </div>
        );

      case 'returns':
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard label="Debit Notes" value={fmtINR(num(rs.debit_notes) || returnEntries.filter(r => r.type === 'Debit Note').reduce((s, r) => s + num(r.debit), 0))} color="text-red-600" />
              <SummaryCard label="Credit Notes" value={fmtINR(num(rs.credit_notes) || returnEntries.filter(r => r.type === 'Credit Note').reduce((s, r) => s + num(r.credit), 0))} color="text-emerald-600" />
            </div>
            {returnEntries.length > 0 && (
              <DataTable
                columns={[
                  { key: 'date', label: 'Date', render: r => fmtDate(r.date) },
                  { key: 'type', label: 'Type', render: r => <Pill color={r.type === 'Debit Note' ? 'red' : 'teal'}>{r.type}</Pill> },
                  { key: 'doc_no', label: 'Ref No.' },
                  { key: 'narration', label: 'Narration', render: r => r.narration || '—' },
                  { key: 'amount', label: 'Amount', align: 'right', render: r => <span className="font-semibold">{fmtRup(num(r.debit) || num(r.credit))}</span> },
                ]}
                rows={returnEntries}
              />
            )}
          </div>
        );

      case 'payment':
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard label="Avg Days to Pay" value={paymentData.avgDays ? `${Math.round(paymentData.avgDays)}d` : '—'} sub={`vs ${creditDays}d terms`} />
              <SummaryCard label="On-time Rate" value={paymentData.onTimeRate ? `${Math.round(paymentData.onTimeRate)}%` : '—'} color="text-emerald-600" />
              <SummaryCard label="Total Receipts" value={paymentData.receipts.length} />
              <SummaryCard label="Total Received" value={fmtINR(paymentData.receipts.reduce((s, r) => s + r.amount, 0))} color="text-emerald-600" />
            </div>
            {paymentData.receipts.length > 0 && (
              <>
                <div className="text-xs font-semibold text-[#4a7c5c] uppercase tracking-wide">Recent Receipts</div>
                <DataTable
                  columns={[
                    { key: 'date', label: 'Date' },
                    { key: 'ref', label: 'Receipt No.' },
                    { key: 'mode', label: 'Mode', render: r => r.mode ? <Pill>{r.mode}</Pill> : '—' },
                    { key: 'amount', label: 'Amount', align: 'right', render: r => <span className="font-semibold">{fmtRup(r.amount)}</span> },
                  ]}
                  rows={paymentData.receipts}
                />
              </>
            )}
          </div>
        );

      case 'contacts':
        return contacts.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {contacts.map((c, i) => (
              <div key={i} className="bg-white rounded-lg border border-[#c8e0d0] p-4">
                <div className="font-semibold text-[#1a3a2a]">{c.name}</div>
                <div className="text-xs text-[#7ba68e] mt-0.5">{c.role}</div>
                {c.phone && <div className="text-sm text-[#4a7c5c] mt-2">{c.phone}</div>}
                {c.email && <div className="text-sm text-[#4a7c5c] mt-1">{c.email}</div>}
              </div>
            ))}
          </div>
        ) : <div className="text-center py-16 text-[#7ba68e]">No contacts on file</div>;

      case 'addresses':
        return addresses.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {addresses.map((a, i) => (
              <div key={i} className="bg-white rounded-lg border border-[#c8e0d0] p-4">
                <div className="font-semibold text-[#1a3a2a] text-sm">{a.label}</div>
                <div className="text-sm text-[#4a7c5c] mt-1">{a.line}</div>
              </div>
            ))}
          </div>
        ) : <div className="text-center py-16 text-[#7ba68e]">No addresses on file</div>;

      default:
        return <div className="text-center py-16 text-[#7ba68e]">Select a section from the sidebar</div>;
    }
  };

  const sectionTitle = NAV_GROUPS.flatMap(g => g.items).find(i => i.id === activeSection)?.label || '';

  return (
    <div className="fixed inset-0 z-50 bg-[#f0f7f4] flex flex-col">
      {/* ── Top bar ── */}
      <div className="bg-white border-b-2 border-[#c8e0d0] px-4 py-2 flex items-center gap-3 flex-shrink-0">
        <button onClick={goBack} className="p-1.5 rounded-lg hover:bg-[#e4f2ea] text-[#4a7c5c] transition-colors" title="Back to list">
          <ChevronLeft size={20} />
        </button>
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-white flex items-center justify-center text-xs font-bold flex-shrink-0">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-[#1a3a2a] truncate">{custName}</div>
          <div className="text-[10px] text-[#7ba68e]">{profile.company_name || 'Customer 360'}</div>
        </div>
        <div className="hidden md:flex items-center gap-4 text-xs mr-4">
          <span className="text-slate-400">Sales <span className="font-bold text-emerald-600 ml-1">{fmtINR(totalSales)}</span></span>
          <span className="text-slate-400">Received <span className="font-bold text-sky-600 ml-1">{fmtINR(received)}</span></span>
          <span className="text-slate-400">Outstanding <span className="font-bold text-amber-600 ml-1">{fmtINR(outstanding)}</span></span>
          {overdue > 0 && <span className="text-slate-400">Overdue <span className="font-bold text-red-600 ml-1">{fmtINR(overdue)}</span></span>}
        </div>
        <button onClick={goBack} className="p-1.5 rounded-lg hover:bg-[#e4f2ea] text-[#7ba68e] transition-colors" title="Close (Esc)">
          <X size={18} />
        </button>
      </div>

      {/* ── Body: sidebar + content ── */}
      <div className="flex flex-1 min-h-0">
        {/* ── Sidebar ── */}
        <div className={`flex-shrink-0 bg-white border-r-2 border-[#c8e0d0] flex flex-col transition-all duration-200 overflow-hidden ${sidebarCollapsed ? 'w-[52px]' : 'w-[250px]'}`}
          onMouseEnter={() => sidebarCollapsed && setSidebarCollapsed(false)}
        >
          {/* Profile details */}
          <div className="p-3 border-b border-[#e4f2ea] flex-shrink-0">
            <button onClick={() => setProfileCollapsed(!profileCollapsed)}
              className="w-full flex items-center justify-between text-[10px] font-semibold text-emerald-600">
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Active Customer</span>
              <ChevronDown size={10} className={`text-slate-400 transition-transform ${profileCollapsed ? '-rotate-90' : ''}`} />
            </button>
            <div className={`overflow-hidden transition-all duration-200 ${profileCollapsed || sidebarCollapsed ? 'max-h-0 opacity-0' : 'max-h-[500px] opacity-100 mt-2'}`}>
              <div className="space-y-1 text-[11px]">
                <div className="flex justify-between"><span className="text-[#7ba68e]">GSTIN</span><span className={`font-semibold tabular-nums ${profile.gstin ? '' : 'text-slate-300'}`}>{profile.gstin || '—'}</span></div>
                {profile.pan && <div className="flex justify-between"><span className="text-[#7ba68e]">PAN</span><span className="font-semibold tabular-nums">{profile.pan}</span></div>}
                <div className="flex justify-between"><span className="text-[#7ba68e]">Credit Terms</span><span className="font-semibold">{creditLabel(creditTerms)}</span></div>
                {num(profile.credit_limit) > 0 && <div className="flex justify-between"><span className="text-[#7ba68e]">Credit Limit</span><span className="font-semibold">{fmtINR(profile.credit_limit)}{outstanding > 0 ? ` (${Math.round(outstanding / num(profile.credit_limit) * 100)}%)` : ''}</span></div>}
                <div className="border-t border-[#e4f2ea] my-1.5 pt-1.5"></div>
                <div className="flex justify-between"><span className="text-[#7ba68e]">Total Sales</span><span className="font-semibold text-emerald-600">{fmtINR(totalSales)}</span></div>
                <div className="flex justify-between"><span className="text-[#7ba68e]">Outstanding</span><span className="font-semibold text-amber-600">{fmtINR(outstanding)}</span></div>
                {creditNotesTotal > 0 && <div className="flex justify-between"><span className="text-[#7ba68e]">Credit Notes</span><span className="font-semibold text-teal-600">-{fmtINR(creditNotesTotal)}</span></div>}
                {overdue > 0 && <div className="flex justify-between"><span className="text-[#7ba68e]">Overdue</span><span className="font-semibold text-red-600">{fmtINR(overdue)}</span></div>}
                <div className="flex justify-between"><span className="text-[#7ba68e]">Received</span><span className="font-semibold text-sky-600">{fmtINR(received)}</span></div>
                <div className="flex justify-between"><span className="text-[#7ba68e]">Invoices</span><span className="font-semibold">{invCount}</span></div>
                {ledger?.rows?.length > 0 && (() => {
                  const lastInv = ledger.rows.filter(r => r.type === 'Invoice').slice(-1)[0];
                  return lastInv ? <div className="flex justify-between"><span className="text-[#7ba68e]">Last Invoice</span><span className="font-semibold">{fmtDate(lastInv.date)}</span></div> : null;
                })()}
                <div className="border-t border-[#e4f2ea] my-1.5 pt-1.5"></div>
                {profile.contact_person && <div className="flex justify-between"><span className="text-[#7ba68e]">Contact</span><span className="font-semibold">{profile.contact_person}</span></div>}
                {(profile.contact_phone || profile.phone) && <div className="flex justify-between"><span className="text-[#7ba68e]">Phone</span><span className="font-semibold">{profile.contact_phone || profile.phone}</span></div>}
                {(profile.contact_email || profile.email) && <div className="flex justify-between"><span className="text-[#7ba68e]">Email</span><span className="font-semibold truncate ml-2">{profile.contact_email || profile.email}</span></div>}
                {(() => { const ba = profile.billing_address && typeof profile.billing_address === 'object' ? profile.billing_address : {}; const loc = [ba.district || profile.billing_city, ba.state || profile.billing_state].filter(Boolean).join(', '); return loc ? <div className="flex justify-between"><span className="text-[#7ba68e]">Location</span><span className="font-semibold">{loc}</span></div> : null; })()}
              </div>
            </div>
          </div>

          {/* Nav groups */}
          <div className="flex-1 overflow-y-auto p-1.5">
            {NAV_GROUPS.map(g => (
              <div key={g.title} className="mb-0.5">
                <button
                  onClick={() => toggleGroup(g.title)}
                  className="w-full flex items-center gap-1 px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-[#7ba68e] hover:text-[#4a7c5c] hover:bg-[#e4f2ea] rounded transition-colors"
                >
                  <ChevronDown size={10} className={`transition-transform ${expandedGroups[g.title] ? '' : '-rotate-90'}`} />
                  {!sidebarCollapsed && <span>{g.title}</span>}
                </button>
                {(expandedGroups[g.title] || sidebarCollapsed) && g.items.map(item => {
                  const Icon = item.icon;
                  const isActive = activeSection === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => selectSection(item.id)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors ${isActive ? 'bg-[#d1fae5] text-[#065f46] font-semibold border-l-2 border-[#16a34a]' : 'text-[#4a7c5c] hover:bg-[#e4f2ea] hover:text-[#1a3a2a]'}`}
                    >
                      <Icon size={14} className="flex-shrink-0" />
                      {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* ── Main content ── */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-5 py-2.5 bg-white border-b border-[#c8e0d0] flex items-center justify-between gap-3 flex-shrink-0">
            <h2 className="text-base font-bold text-[#1a3a2a] shrink-0">{sectionTitle}</h2>
            {/* Date range filter */}
            <div className="relative flex items-center gap-1.5" data-datepicker>
              {/* Quick presets — FYs */}
              {DATE_PRESETS.filter(p => p.key === 'fy' || p.key === 'pfy').map(p => (
                <button key={p.key} type="button" onClick={() => applyPreset(p)}
                  className={`px-2 py-1 rounded text-[10px] font-semibold border transition whitespace-nowrap ${activePeriod === p.key ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-[#4a7c5c] border-[#c8e0d0] hover:border-emerald-400'}`}>
                  {p.label}
                </button>
              ))}
              {/* Quick presets — current month */}
              {DATE_PRESETS.filter(p => p.key === 'cm').map(p => (
                <button key={p.key} type="button" onClick={() => applyPreset(p)}
                  className={`px-2 py-1 rounded text-[10px] font-semibold border transition whitespace-nowrap ${activePeriod === p.key ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-[#4a7c5c] border-[#c8e0d0] hover:border-emerald-400'}`}>
                  {p.label}
                </button>
              ))}
              {/* More / Custom toggle */}
              <button type="button" onClick={() => setShowDatePicker(v => !v)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border transition whitespace-nowrap ${activePeriod === 'custom' || showDatePicker ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-[#4a7c5c] border-[#c8e0d0] hover:border-emerald-400'}`}>
                <Calendar size={11} /> {activePeriod === 'custom' ? `${fmtDate(dateFrom)} — ${fmtDate(dateTo)}` : 'More'}
              </button>
              {/* Dropdown */}
              {showDatePicker && (
                <div className="absolute right-0 top-full mt-1 z-30 bg-white rounded-lg border border-[#c8e0d0] shadow-lg p-3 w-[340px]">
                  {/* Month presets */}
                  <div className="text-[9px] font-semibold text-[#4a7c5c] uppercase tracking-wide mb-1.5">Month</div>
                  <div className="flex flex-wrap gap-1 mb-3">
                    {DATE_PRESETS.filter(p => p.key === 'cm' || p.key.startsWith('m')).map(p => (
                      <button key={p.key} type="button" onClick={() => applyPreset(p)}
                        className={`px-2 py-1 rounded text-[10px] font-medium border transition ${activePeriod === p.key ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-[#f0f7f4] text-[#4a7c5c] border-[#e4f2ea] hover:border-emerald-300'}`}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                  {/* Quarter presets */}
                  <div className="text-[9px] font-semibold text-[#4a7c5c] uppercase tracking-wide mb-1.5">Quarter</div>
                  <div className="flex flex-wrap gap-1 mb-3">
                    {DATE_PRESETS.filter(p => p.key.startsWith('q')).map(p => (
                      <button key={p.key} type="button" onClick={() => applyPreset(p)}
                        className={`px-2 py-1 rounded text-[10px] font-medium border transition ${activePeriod === p.key ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-[#f0f7f4] text-[#4a7c5c] border-[#e4f2ea] hover:border-emerald-300'}`}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                  {/* Custom date range */}
                  <div className="text-[9px] font-semibold text-[#4a7c5c] uppercase tracking-wide mb-1.5">Custom Range</div>
                  <div className="flex items-center gap-2">
                    <input type="date" defaultValue={dateFrom}
                      className="flex-1 px-2 py-1 text-[11px] border border-[#c8e0d0] rounded focus:outline-none focus:border-emerald-400"
                      id="_c360_from" />
                    <span className="text-[10px] text-[#7ba68e]">to</span>
                    <input type="date" defaultValue={dateTo}
                      className="flex-1 px-2 py-1 text-[11px] border border-[#c8e0d0] rounded focus:outline-none focus:border-emerald-400"
                      id="_c360_to" />
                    <button type="button"
                      onClick={() => {
                        const f = document.getElementById('_c360_from')?.value;
                        const t = document.getElementById('_c360_to')?.value;
                        if (f && t) applyCustom(f, t);
                      }}
                      className="px-2.5 py-1 rounded text-[10px] font-semibold bg-emerald-600 text-white hover:bg-emerald-700 transition">
                      Apply
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 p-5 overflow-y-auto bg-[#f0f7f4]">
            {renderSection()}
          </div>
        </div>
      </div>

      {popupInvoiceId && (
        <InvoicePopup id={popupInvoiceId} onClose={() => setPopupInvoiceId(null)} />
      )}
    </div>
  );
}

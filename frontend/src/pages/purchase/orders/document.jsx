import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Printer, Save, Loader2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate, formatCurrency } from '@/utils/formatters';
import { PAYMENT_TERM_OPTIONS, FREIGHT_TERM_OPTIONS, withCurrent } from '@/constants/purchaseTerms';

// Inline-editable field styles. On screen they carry a faint dashed
// underline so the operator can see what's editable; in print the borders
// vanish and only the text remains, so the paper looks like a clean PO.
const editCls =
  'w-full bg-transparent px-1 py-0.5 border-b border-dashed border-slate-300 ' +
  'focus:outline-none focus:border-primary-500 print:border-0 print:px-0';
const editAreaCls =
  'w-full bg-transparent px-1 py-0.5 border border-dashed border-slate-300 rounded ' +
  'focus:outline-none focus:border-primary-500 print:border-0 print:px-0 resize-none';

// Browsers drop background colours in print unless told otherwise — the
// accent-filled table header carries this so the paper matches the screen.
const printExact = { WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' };

// Fixed document accent (slate — the PO sheet's monochrome house style).
const ACCENT = '#334155';

// A read-only-in-print, editable-on-screen single-line text field.
//
// PRINT TWIN: an <input> clips its value to its box on paper — "Humic
// Liquid" printed as "Humic L". So the input is screen-only and a plain
// wrapped <span> with the same value renders in print instead, letting
// long content take its full width and wrap across lines.
function Field({ value, onChange, className = '', placeholder }) {
  return (
    <>
      <input
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${editCls} ${className} print:hidden`}
      />
      <span className="hidden print:inline whitespace-pre-wrap break-words">{value ?? ''}</span>
    </>
  );
}

// Print twin for textareas — same clipping problem, block-level.
function PrintText({ value, className = '' }) {
  return (
    <div className={`hidden print:block whitespace-pre-wrap break-words ${className}`}>
      {value ?? ''}
    </div>
  );
}

// Wrapping editable cell — the product name must show in FULL on screen, not
// clip to a single input box. A textarea wraps long names across lines; the
// print twin (below) renders the full wrapped value on paper.
function WrapField({ value, onChange, className = '', placeholder }) {
  return (
    <>
      <textarea
        rows={1}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${editAreaCls} ${className} print:hidden`}
        style={{ minHeight: '2.1em' }}
      />
      <span className="hidden print:inline whitespace-pre-wrap break-words">{value ?? ''}</span>
    </>
  );
}

// Company / Warehouse source toggle for an address slot. Screen-only (hidden on
// paper); clicking swaps the block's address text to the chosen source.
function AddrToggle({ value, onChange }) {
  return (
    <span className="doc-edit-only inline-flex rounded border border-slate-300 overflow-hidden text-[10px] font-medium print:hidden ml-2 align-middle">
      {[['company', 'Company'], ['warehouse', 'Warehouse']].map(([s, label]) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={`px-1.5 py-0.5 ${value === s ? 'bg-primary-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

export default function PurchaseOrderDocument() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit } = usePermissions();
  const hasEdit = canEdit('Purchase Order');

  const [po, setPo] = useState(null);
  const [doc, setDoc] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const accent = ACCENT;

  useEffect(() => {
    (async () => {
      setIsLoading(true);
      try {
        const res = await apiClient.get(`/api/purchase/orders/${id}/`);
        const p = res.data;
        setPo(p);
        setDoc({
          // Header (company) — printout-only edits
          companyName: p.company_name || p.company_trade_name || '',
          companyAddress: p.warehouse_address || p.company_address || '',
          companyGstin: p.company_gstin || '',
          // Purchase-department contact printed on every PO (editable per doc).
          companyPhone: '+91 93605 71507',
          companyMail: 'purchase@ssbiochem.com',
          // Supplier (vendor) — printout-only edits
          vendorName: p.vendor_name || '',
          vendorAddress: p.vendor_address || '',
          vendorGstin: p.vendor_gstin || '',
          vendorGstType: p.vendor_gst_type || '',
          // Bill To — printout-only edits
          billingAddress: p.warehouse_address || p.company_billing_address || p.company_address || '',
          billingGstin: p.company_gstin || '',
          // Deliver To — printout-only edits
          deliverAddress: p.warehouse_address || p.company_address || '',
          deliverGstin: p.company_gstin || '',
          // Raw address sources for the Company/Warehouse toggles on each slot.
          // All three default to the WAREHOUSE address; each can be flipped to
          // Company independently. Kept alongside the editable text so a toggle
          // resets the block to that source (edits still allowed after).
          companyAddrRaw: p.company_address || '',
          companyBillAddrRaw: p.company_billing_address || p.company_address || '',
          warehouseAddrRaw: p.warehouse_address || '',
          srcHeader: 'warehouse',
          srcBill: 'warehouse',
          srcDeliver: 'warehouse',
          // Meta
          poNo: p.po_no || '',
          poDate: p.po_date || '',
          dueDate: p.expected_delivery_end || '',      // persists → expected_delivery_end
          freightTerms: p.freight_terms || '',          // persists
          paymentTerms: p.payment_terms || '',          // persists
          terms: p.terms_and_conditions || '',          // persists
          // Lines
          lines: (p.po_lines || []).map((l) => ({
            id: l.id,
            product: l.item_name || l.product_name || '',   // printout-only
            // Specification is OPERATOR-TYPED only. Deliberately NOT
            // pre-filled from l.description (the PR-line remark) —
            // the PR remark is internal context that must not leak
            // to the vendor's PO document / email unless the operator
            // deliberately re-types it into this field.
            specification: l.specification || '',            // persists (DRAFT)
            qty: l.quantity_ordered ?? '',                   // persists (DRAFT)
            uom: l.uom || '',                                // persists (DRAFT)
            rate: l.unit_price ?? '',                        // persists (DRAFT)
            gst: l.gst ?? '',                                // persists (DRAFT)
          })),
        });
      } catch (err) {
        if (err.response?.status !== 404) toast.error(getApiErrorMessage(err));
      } finally {
        setIsLoading(false);
      }
    })();
  }, [id]);

  const set = (key, value) => setDoc((prev) => ({ ...prev, [key]: value }));

  // Flip an address slot between the Company and Warehouse address. Resets that
  // block's text to the chosen source (Bill To uses the company billing address
  // for "Company"; header + Deliver To use the plain company address).
  const setAddrSrc = (slot, src) =>
    setDoc((prev) => {
      const wh = prev.warehouseAddrRaw;
      if (slot === 'header') return { ...prev, srcHeader: src, companyAddress: src === 'warehouse' ? wh : prev.companyAddrRaw };
      if (slot === 'bill') return { ...prev, srcBill: src, billingAddress: src === 'warehouse' ? wh : prev.companyBillAddrRaw };
      if (slot === 'deliver') return { ...prev, srcDeliver: src, deliverAddress: src === 'warehouse' ? wh : prev.companyAddrRaw };
      return prev;
    });

  const setLine = (idx, key, value) =>
    setDoc((prev) => ({
      ...prev,
      lines: prev.lines.map((l, i) => (i === idx ? { ...l, [key]: value } : l)),
    }));

  // Line rate/qty edits persist only while the PO is a DRAFT — changing an
  // approved PO's financials from a print screen would silently alter the
  // committed order value, so past DRAFT those edits are printout-only.
  const canPersistLines = po?.status === 'DRAFT';

  // ── Totals (Indian PO convention) ─────────────────────────────────
  const totals = useMemo(() => {
    const lines = doc?.lines || [];
    let taxable = 0;
    let gst = 0;
    lines.forEach((l) => {
      const t = (Number(l.qty) || 0) * (Number(l.rate) || 0);
      taxable += t;
      gst += t * (Number(l.gst) || 0) / 100;
    });
    return { taxable, gst, total: taxable + gst };
  }, [doc]);

  // GST type is a place-of-supply rule, not a vendor attribute: the tax is
  // intra-state (CGST+SGST → labelled "GST") when the vendor is in the same
  // state as the buying company, else inter-state ("IGST"). The state is the
  // first 2 digits of the GSTIN (e.g. 33 = Tamil Nadu). Falls back to the
  // vendor's configured gst_type only when a GSTIN is missing. Recomputed on
  // every render so editing a GSTIN in the document updates the label live.
  const taxTypeLabel = (() => {
    const co = (doc?.companyGstin || '').trim();
    const ve = (doc?.vendorGstin || '').trim();
    if (co.length >= 2 && ve.length >= 2) {
      return co.slice(0, 2) === ve.slice(0, 2) ? 'GST' : 'IGST';
    }
    return doc?.vendorGstType === 'IGST' ? 'IGST' : 'GST';
  })();

  const doPrint = () => {
    // Defer so any pending state flush paints before the print snapshot.
    setTimeout(() => window.print(), 60);
  };

  // Save only — printing is its own button. The old combined
  // "Save & Print" forced the browser print dialog on every save,
  // which operators making quick edits didn't want.
  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        freight_terms: doc.freightTerms || '',
        payment_terms: doc.paymentTerms || '',
        terms_and_conditions: doc.terms || '',
        expected_delivery_end: doc.dueDate || null,
      };
      if (canPersistLines) {
        // DRAFT — full line edit is allowed, including financials.
        payload.po_lines = doc.lines.map((l) => ({
          id: l.id,
          unit_price: String(l.rate ?? '0'),
          quantity_ordered: l.qty,
          gst: String(l.gst ?? '0'),
          uom: l.uom || '',
          // Specification input in the Product Name cell writes to the
          // dedicated POLine.specification field — kept separate from
          // POLine.description (which preserves the auto-copied PR
          // remark). PDF + vendor email render from specification.
          specification: l.specification || '',
        }));
      } else {
        // Post-DRAFT — financials are locked so we don't silently
        // alter a committed order value. But specification is
        // editorial vendor-facing text, not a financial field, so
        // it still saves. Without this the operator would type a
        // spec, hit Save & Print, print would show it, then a
        // refresh / navigate-back / email-send would find blank
        // spec on the server and lose the addition.
        payload.po_lines = doc.lines.map((l) => ({
          id: l.id,
          specification: l.specification || '',
        }));
      }
      const res = await apiClient.patch(`/api/purchase/orders/${id}/`, payload);
      setPo(res.data);
      toast.success('PO saved');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || !doc) {
    return (
      <MainLayout>
        <div className="max-w-[820px] mx-auto space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />
          ))}
        </div>
      </MainLayout>
    );
  }

  if (!po) {
    return (
      <MainLayout>
        <div className="text-center py-12">
          <p className="text-slate-600">Purchase Order not found</p>
          <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/orders'))} className="mt-4 text-blue-600 hover:text-blue-800">
            Back to Purchase Orders
          </button>
        </div>
      </MainLayout>
    );
  }

  const nfmt = (v) => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

  return (
    <MainLayout>
      {/* Toolbar — hidden on paper */}
      <div className="max-w-[820px] mx-auto flex flex-wrap items-center justify-between gap-3 mb-4 print:hidden">
        <button
          onClick={() => navigate(`/purchase/orders/${id}`)}
          className="flex items-center gap-2 text-slate-600 hover:text-slate-800 text-sm font-medium"
        >
          <ArrowLeft size={18} /> Back to PO
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {hasEdit && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 text-sm font-medium disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          <button
            onClick={doPrint}
            className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium"
          >
            <Printer size={16} /> Print
          </button>
        </div>
      </div>

      {!hasEdit && (
        <div className="max-w-[820px] mx-auto mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 print:hidden">
          You have view-only access — the document prints with the saved values (edits won't be saved).
        </div>
      )}
      {hasEdit && !canPersistLines && (
        <div className="max-w-[820px] mx-auto mb-3 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 print:hidden">
          This PO is <span className="font-semibold">{po.status}</span> — line quantities/rates are locked; edits to them affect only this printout. Terms &amp; dates still save.
        </div>
      )}

      {/* Print setup: A4 with small margins so the sheet fills the page (far
          less white space). The date / URL / title around the page are the
          BROWSER's header/footer — untick "Headers and footers" in the print
          dialog's More settings to hide them (can't be removed via CSS). */}
      <style>{`
        @media print { @page { size: A4; margin: 8mm; } }
        /* View-only users get the sheet wrapped in <fieldset disabled>, which
           turns off every input/textarea/select/button inside. Strip the
           editable affordances so it reads as a clean printed PO, not a form. */
        fieldset:disabled input, fieldset:disabled textarea, fieldset:disabled select {
          border-color: transparent !important; opacity: 1; cursor: default;
          color: inherit; background: transparent;
        }
        fieldset:disabled .doc-edit-only { display: none !important; }
      `}</style>
      {/* ── The A4 PO document ──────────────────────────────────────── */}
      {/* View-only users (no Purchase Order Edit permission) get a disabled
          fieldset so nothing is editable — not just unsaved. */}
      <fieldset disabled={!hasEdit} className="min-w-0 border-0 p-0 m-0">
      <div className="max-w-[820px] mx-auto bg-white text-slate-900 border border-slate-300 print:border-0 print:max-w-none print:mx-0 p-4 sm:p-5 sm:p-8 print:p-0 text-[13px] leading-snug">
        {/* Header: company (left) + title (right) */}
        <div className="flex justify-between gap-4 sm:gap-5 pb-3">
          <div className="w-3/5">
            <input
              type="text"
              value={doc.companyName}
              onChange={(e) => set('companyName', e.target.value)}
              className={`${editCls} text-lg font-bold print:hidden`}
            />
            <PrintText value={doc.companyName} className="text-lg font-bold" />
            <div className="mt-1 print:hidden">
              <span className="text-[10px] uppercase tracking-wide text-slate-400">Address</span>
              <AddrToggle value={doc.srcHeader} onChange={(s) => setAddrSrc('header', s)} />
            </div>
            <textarea
              rows={2}
              value={doc.companyAddress}
              onChange={(e) => set('companyAddress', e.target.value)}
              className={`${editAreaCls} mt-1 text-[12px] text-slate-700 print:hidden`}
            />
            <PrintText value={doc.companyAddress} className="mt-1 text-[12px] text-slate-700" />
            <div className="mt-1 text-[12px]">
              <span className="text-slate-500">GSTIN: </span>
              <Field value={doc.companyGstin} onChange={(v) => set('companyGstin', v)} className="inline w-56" />
            </div>
            <div className="text-[12px]">
              <span className="text-slate-500">Ph: </span>
              <Field value={doc.companyPhone} onChange={(v) => set('companyPhone', v)} className="inline w-40" />
            </div>
            <div className="text-[12px]">
              <span className="text-slate-500">Mail: </span>
              <Field value={doc.companyMail} onChange={(v) => set('companyMail', v)} className="inline w-56" />
            </div>
          </div>
          <div className="w-2/5 text-right">
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: accent }}>Purchase Order</h1>
            <p className="mt-2 text-[13px]">
              <span className="text-slate-500">Po No: </span>
              <span className="font-semibold">{doc.poNo}</span>
            </p>
          </div>
        </div>

        {/* Supplier */}
        <div className="border-t border-slate-300 pt-3">
          <p className="font-semibold">Supplier:</p>
          <Field value={doc.vendorName} onChange={(v) => set('vendorName', v)} className="font-medium" />
          {/* Compact supplier address — constrained width so a long address
              wraps into ~3 tidy lines instead of one full-width sprawl. */}
          <textarea
            rows={3}
            value={doc.vendorAddress}
            onChange={(e) => set('vendorAddress', e.target.value)}
            className={`${editAreaCls} mt-1 max-w-md text-[12px] text-slate-700 print:hidden`}
          />
          <PrintText value={doc.vendorAddress} className="mt-1 max-w-md text-[12px] text-slate-700" />
          <div className="text-[12px]">
            <span className="text-slate-500">GST: </span>
            <Field value={doc.vendorGstin} onChange={(v) => set('vendorGstin', v)} className="inline w-56" />
          </div>
        </div>

        {/* Bill To / Deliver To (left) + PO meta (right) */}
        <div className="flex justify-between gap-4 sm:gap-5 border-t border-slate-300 mt-3 pt-3">
          <div className="w-3/5 space-y-3">
            <div>
              <p className="font-semibold">Bill To <AddrToggle value={doc.srcBill} onChange={(s) => setAddrSrc('bill', s)} /></p>
              <textarea
                rows={2}
                value={doc.billingAddress}
                onChange={(e) => set('billingAddress', e.target.value)}
                className={`${editAreaCls} text-[12px] text-slate-700 print:hidden`}
              />
              <PrintText value={doc.billingAddress} className="text-[12px] text-slate-700" />
              <div className="text-[12px]">
                <span className="text-slate-500">GSTIN: </span>
                <Field value={doc.billingGstin} onChange={(v) => set('billingGstin', v)} className="inline w-56" />
              </div>
            </div>
            <div>
              <p className="font-semibold">Deliver To <AddrToggle value={doc.srcDeliver} onChange={(s) => setAddrSrc('deliver', s)} /></p>
              <textarea
                rows={2}
                value={doc.deliverAddress}
                onChange={(e) => set('deliverAddress', e.target.value)}
                className={`${editAreaCls} text-[12px] text-slate-700 print:hidden`}
              />
              <PrintText value={doc.deliverAddress} className="text-[12px] text-slate-700" />
              <div className="text-[12px]">
                <span className="text-slate-500">GSTIN: </span>
                <Field value={doc.deliverGstin} onChange={(v) => set('deliverGstin', v)} className="inline w-56" />
              </div>
            </div>
          </div>
          <div className="w-2/5">
            <table className="w-full text-[12px]">
              <tbody>
                <tr>
                  <td className="text-slate-500 py-0.5 align-top w-28">PO Date</td>
                  <td className="py-0.5">: {formatDate(doc.poDate)}</td>
                </tr>
                <tr>
                  <td className="text-slate-500 py-0.5 align-top">Freight Terms</td>
                  <td className="py-0.5">
                    <div className="flex items-center gap-1">
                      <span>:</span>
                      <div className="flex-1 print:hidden">
                        <CustomSelect
                          value={doc.freightTerms}
                          onChange={(e) => set('freightTerms', e.target.value)}
                          disabled={!hasEdit}
                          className={editCls}
                        >
                          <option value="">—</option>
                          {withCurrent(FREIGHT_TERM_OPTIONS, doc.freightTerms).map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </CustomSelect>
                      </div>
                      <span className="hidden print:inline">{doc.freightTerms || '—'}</span>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td className="text-slate-500 py-0.5 align-top">Delivery Schedule</td>
                  <td className="py-0.5">
                    <div className="flex items-center gap-1">
                      <span>:</span>
                      <div className="flex-1 print:hidden">
                        <CustomDatePicker
                          value={doc.dueDate || ''}
                          onChange={(e) => set('dueDate', e.target.value)}
                          disabled={!hasEdit}
                          className={editCls}
                        />
                      </div>
                      <span className="hidden print:inline">{doc.dueDate ? formatDate(doc.dueDate) : '—'}</span>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td className="text-slate-500 py-0.5 align-top">Payment Terms</td>
                  <td className="py-0.5">
                    <div className="flex items-center gap-1">
                      <span>:</span>
                      <div className="flex-1 print:hidden">
                        <CustomSelect
                          value={doc.paymentTerms}
                          onChange={(e) => set('paymentTerms', e.target.value)}
                          disabled={!hasEdit}
                          className={editCls}
                        >
                          <option value="">—</option>
                          {withCurrent(PAYMENT_TERM_OPTIONS, doc.paymentTerms).map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </CustomSelect>
                      </div>
                      <span className="hidden print:inline">{doc.paymentTerms || '—'}</span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Line items */}
        {/* table-fixed + explicit column widths: the table always fits its
            container (no horizontal scroll) and the Product Name column is the
            widest, so names read on a single line. */}
        <table className="w-full table-fixed border border-slate-400 border-collapse mt-4 text-[11px]">
          <colgroup>
            {['5%', '33%', '9%', '6%', '11%', '12%', '13%', '11%'].map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            {/* Accent-filled header row, white text. Explicit white on each
                th too — the preflight th colour otherwise wins the cascade. */}
            <tr style={{ ...printExact, backgroundColor: accent }}>
              {['S.No', 'Product Name', 'Quantity', 'Unit', 'Rate', 'Tax %', 'Taxable Amount', 'GST Value'].map((h) => {
                const align = ['Quantity', 'Rate', 'Tax %', 'Taxable Amount', 'GST Value'].includes(h)
                  ? 'text-right' : h === 'S.No' ? 'text-center' : 'text-left';
                return (
                  <th
                    key={h}
                    className={`border border-slate-400 px-2 py-1.5 font-semibold text-white ${align}`}
                    style={{ ...printExact, color: '#ffffff' }}
                  >
                    {h}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l, idx) => {
              const taxable = (Number(l.qty) || 0) * (Number(l.rate) || 0);
              const gstVal = taxable * (Number(l.gst) || 0) / 100;
              return (
                <tr key={l.id || idx} className="align-top">
                  <td className="border border-slate-400 px-2 py-1.5 text-center text-slate-600">{idx + 1}</td>
                  <td className="border border-slate-400 px-2 py-1.5 align-top">
                    {/* Product name on the first line; specification
                        (technical spec / variant / dimensions) shown
                        underneath in smaller text. Same cell keeps the
                        column layout stable; spec wraps if long. Saved
                        back to POLine.description on Save & Print. */}
                    <Field value={l.product} onChange={(v) => setLine(idx, 'product', v)} />
                    <span className="doc-edit-only print:hidden mt-1 block text-[9px] font-medium uppercase tracking-wide text-slate-400">
                      Specification
                    </span>
                    <input
                      type="text"
                      value={l.specification || ''}
                      onChange={(e) => setLine(idx, 'specification', e.target.value)}
                      placeholder="Specification (optional)"
                      className={`${editCls} mt-0.5 text-[10px] text-slate-600 print:hidden`}
                    />
                    {(l.specification || '').trim() && (
                      <div className="hidden print:block text-[10px] text-slate-600 mt-0.5 whitespace-pre-wrap break-words">
                        {l.specification}
                      </div>
                    )}
                  </td>
                  <td className="border border-slate-400 px-2 py-1.5 text-right">
                    <input
                      type="number" step="any" min="0"
                      value={l.qty}
                      onChange={(e) => setLine(idx, 'qty', e.target.value)}
                      className={`${editCls} text-right print:hidden`}
                    />
                    <span className="hidden print:inline">{l.qty === '' || l.qty == null ? '' : nfmt(l.qty)}</span>
                  </td>
                  <td className="border border-slate-400 px-2 py-1.5">
                    <Field value={l.uom} onChange={(v) => setLine(idx, 'uom', v)} className="w-14" />
                  </td>
                  <td className="border border-slate-400 px-2 py-1.5 text-right">
                    <input
                      type="number" step="any" min="0"
                      value={l.rate}
                      onChange={(e) => setLine(idx, 'rate', e.target.value)}
                      className={`${editCls} text-right print:hidden`}
                    />
                    <span className="hidden print:inline">{l.rate === '' || l.rate == null ? '' : nfmt(l.rate)}</span>
                  </td>
                  <td className="border border-slate-400 px-2 py-1.5 text-right whitespace-nowrap">
                    <span className="text-slate-500 mr-0.5">{taxTypeLabel}</span>
                    <input
                      type="number" step="any" min="0"
                      value={l.gst}
                      onChange={(e) => setLine(idx, 'gst', e.target.value)}
                      className={`${editCls} inline-block w-10 text-right print:hidden`}
                    />
                    <span className="hidden print:inline">{l.gst === '' || l.gst == null ? '' : l.gst}</span>
                    <span>%</span>
                  </td>
                  <td className="border border-slate-400 px-2 py-1.5 text-right whitespace-nowrap">
                    {formatCurrency(taxable)}
                  </td>
                  <td className="border border-slate-400 px-2 py-1.5 text-right whitespace-nowrap">
                    {formatCurrency(gstVal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Totals — capped to a right-side width so it never stretches across
            the page, and the separator is on the CELLS (a row border would
            otherwise paint the full table width, leaving stray lines on the
            empty left side). */}
        <div className="flex justify-end mt-3">
          <table className="w-72 text-[13px]">
            <tbody>
              <tr>
                <td className="text-right pr-6 py-0.5 text-slate-600">Total Taxable Value</td>
                <td className="text-right py-0.5 font-medium whitespace-nowrap">{formatCurrency(totals.taxable)}</td>
              </tr>
              <tr>
                <td className="text-right pr-6 py-0.5 text-slate-600">Total Gst Value</td>
                <td className="text-right py-0.5 font-medium whitespace-nowrap">{formatCurrency(totals.gst)}</td>
              </tr>
              <tr>
                <td className="text-right pr-6 py-1 font-semibold border-t border-slate-400" style={{ color: accent }}>Total Amount</td>
                <td className="text-right py-1 font-bold whitespace-nowrap border-t border-slate-400" style={{ color: accent }}>{formatCurrency(totals.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Terms & Conditions */}
        <div className="mt-5">
          <p className="font-semibold">Terms &amp; Conditions</p>
          <textarea
            rows={3}
            value={doc.terms}
            onChange={(e) => set('terms', e.target.value)}
            placeholder="Enter terms & conditions…"
            className={`${editAreaCls} mt-1 text-[12px] text-slate-700 print:hidden`}
          />
          <PrintText value={doc.terms} className="mt-1 text-[12px] text-slate-700" />
        </div>

        {/* Computer-generated note (replaces the seal/signature block) */}
        <div className="mt-8 pt-3 border-t border-slate-300 text-center text-[11px] text-slate-500 italic">
          This is a computer-generated Purchase Order and does not require a signature.
        </div>
      </div>
      </fieldset>
    </MainLayout>
  );
}

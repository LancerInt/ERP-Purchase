import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Printer } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '@/utils/formatters';

// Inline-editable field styles (same convention as the PO document). On
// screen they carry a faint dashed underline so the operator can see what's
// editable; in print the borders vanish and only the text remains, so the
// paper looks like a clean RFQ.
const editCls =
  'w-full bg-transparent px-1 py-0.5 border-b border-dashed border-slate-300 ' +
  'focus:outline-none focus:border-primary-500 print:border-0 print:px-0';
const editAreaCls =
  'w-full bg-transparent px-1 py-0.5 border border-dashed border-slate-300 rounded ' +
  'focus:outline-none focus:border-primary-500 print:border-0 print:px-0 resize-none';

// Browsers drop background colours in print unless told otherwise — the
// shaded table header carries this so the paper matches the screen.
const printExact = { WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' };

// Fixed document accent (slate — the purchase side's monochrome house style).
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
      <span className="hidden print:inline whitespace-pre-wrap break-words">
        {value ?? ''}
      </span>
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

// registered_address is a JSON blob (street/city/state/pincode…) but has
// been free-typed in places — flatten whatever shape shows up.
function flattenAddress(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (typeof a === 'object') {
    return [a.street, a.raw_address, a.city, a.district, a.state, a.country, a.pincode]
      .filter(Boolean)
      .join(', ');
  }
  return String(a);
}

export default function RFQDocument() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [rfq, setRfq] = useState(null);
  const [doc, setDoc] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const accent = ACCENT;

  useEffect(() => {
    (async () => {
      setIsLoading(true);
      try {
        const res = await apiClient.get(`/api/purchase/rfq/${id}/`);
        const r = res.data;
        setRfq(r);

        // Lines come from the RFQ products endpoint — already filtered to
        // exclude skip-routed PR lines, so it is the single source of truth
        // for what this RFQ actually asks vendors to quote.
        let products = [];
        try {
          const pRes = await apiClient.get(`/api/purchase/rfq/${id}/products/`);
          products = Array.isArray(pRes.data) ? pRes.data : [];
        } catch { /* table falls back to blank rows */ }

        // RFQHeader carries no company — walk to the first linked PR for the
        // buying company, then the company master for the letterhead. Every
        // hop is optional; the header falls back to blanks the operator can
        // type over.
        let pr = null;
        let company = null;
        const firstPrId = (r.linked_prs || [])[0];
        if (firstPrId) {
          try {
            pr = (await apiClient.get(`/api/purchase/requests/${firstPrId}/`)).data;
            if (pr?.company) {
              try {
                company = (await apiClient.get(`/api/companies/${pr.company}/`)).data;
              } catch { /* letterhead falls back to PR fields */ }
            }
          } catch { /* letterhead falls back to blanks */ }
        }

        const lines = products.map((p) => ({
          product: p.product_name || '',
          sku: p.sku_code || '',
          qty: p.quantity_requested != null
            ? (Number.isFinite(Number(p.quantity_requested))
                ? String(Number(p.quantity_requested))
                : String(p.quantity_requested))
            : '',
          uom: p.uom || '',
          remarks: '',
        }));

        setDoc({
          // ── Letterhead (printout-only) ───────────────────────────
          companyName: company?.legal_name || pr?.company_name || '',
          companyAddress: flattenAddress(company?.registered_address),
          companyGstin: company?.gstin || '',
          companyPhone: company?.contact_phone || '',
          companyEmail: company?.contact_email || '',
          // ── Addressee (printout-only) — the same RFQ goes to several
          //    vendors, so the operator fills these per printout (or
          //    leaves them blank). ─────────────────────────────────
          vendorName: '',
          vendorAddress: '',
          // ── Body (printout-only) ─────────────────────────────────
          intro:
            'Dear Sir/Madam, We request you to kindly quote your best rates ' +
            'for the following items:',
          lines: lines.length > 0
            ? lines
            : Array.from({ length: 3 }, () => ({ product: '', sku: '', qty: '', uom: '', remarks: '' })),
          terms:
            'Please mention: unit price, GST, delivery period, payment terms ' +
            'and validity of your quotation. Kindly send your quotation at the earliest.',
        });
      } catch (err) {
        if (err.response?.status !== 404) toast.error(getApiErrorMessage(err));
      } finally {
        setIsLoading(false);
      }
    })();
  }, [id]);

  const set = (key, value) => setDoc((prev) => ({ ...prev, [key]: value }));
  const setLine = (idx, key, value) =>
    setDoc((prev) => ({
      ...prev,
      lines: prev.lines.map((l, i) => (i === idx ? { ...l, [key]: value } : l)),
    }));

  const doPrint = () => {
    // Defer so any pending state flush paints before the print snapshot.
    setTimeout(() => window.print(), 60);
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

  if (!rfq) {
    return (
      <MainLayout>
        <div className="text-center py-12">
          <p className="text-slate-600">RFQ not found</p>
          <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/rfq')} className="mt-4 text-blue-600 hover:text-blue-800">
            Back to RFQs
          </button>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      {/* Toolbar — hidden on paper */}
      <div className="max-w-[820px] mx-auto flex flex-wrap items-center justify-between gap-3 mb-4 print:hidden">
        <button
          onClick={() => navigate(`/purchase/rfq/${id}`)}
          className="flex items-center gap-2 text-slate-600 hover:text-slate-800 text-sm font-medium"
        >
          <ArrowLeft size={18} /> Back to RFQ
        </button>
        <button
          onClick={doPrint}
          className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium"
        >
          <Printer size={16} /> Print
        </button>
      </div>

      <div className="max-w-[820px] mx-auto mb-3 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 print:hidden">
        Every field on this page affects <span className="font-semibold">only this printout</span> — nothing
        is saved to the RFQ. The same RFQ goes to several vendors, so fill the &ldquo;To&rdquo; address per
        printout (or leave it blank).
      </div>

      {/* ── The A4 RFQ document ─────────────────────────────────────── */}
      <div className="max-w-[820px] mx-auto bg-white text-slate-900 border border-slate-300 print:border-0 p-4 sm:p-5 sm:p-8 text-[13px] leading-snug">
        {/* Header: company letterhead (left) + title (right) */}
        <div className="flex justify-between gap-4 sm:gap-5 pb-3">
          <div className="w-3/5">
            <div className="text-lg font-bold">
              <Field value={doc.companyName} onChange={(v) => set('companyName', v)} placeholder="Company name" />
            </div>
            <textarea
              rows={2}
              value={doc.companyAddress}
              onChange={(e) => set('companyAddress', e.target.value)}
              placeholder="Company address"
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
          </div>
          <div className="w-2/5 text-right">
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: accent }}>Request for Quotation</h1>
            <p className="mt-2 text-[13px]">
              <span className="text-slate-500">RFQ No: </span>
              <span className="font-semibold">{rfq.rfq_no}</span>
            </p>
            <p className="text-[13px]">
              <span className="text-slate-500">Date: </span>
              <span className="font-semibold">{formatDate(rfq.creation_date)}</span>
            </p>
          </div>
        </div>

        {/* To: — filled per printout (the same RFQ goes to several vendors) */}
        <div className="border-t border-slate-300 pt-3">
          <p className="font-semibold">To:</p>
          <div className="flex items-baseline gap-1 font-medium">
            <span>M/s</span>
            <Field value={doc.vendorName} onChange={(v) => set('vendorName', v)} placeholder="Vendor name" />
          </div>
          <textarea
            rows={2}
            value={doc.vendorAddress}
            onChange={(e) => set('vendorAddress', e.target.value)}
            placeholder="Vendor address"
            className={`${editAreaCls} mt-1 text-[12px] text-slate-700 print:hidden`}
          />
          <PrintText value={doc.vendorAddress} className="mt-1 text-[12px] text-slate-700" />
        </div>

        {/* Intro line */}
        <div className="mt-4">
          <textarea
            rows={2}
            value={doc.intro}
            onChange={(e) => set('intro', e.target.value)}
            className={`${editAreaCls} text-[13px] print:hidden`}
          />
          <PrintText value={doc.intro} className="text-[13px]" />
        </div>

        {/* Items table */}
        <table className="w-full border border-slate-400 border-collapse mt-3 text-[12px]">
          <thead>
            <tr className="bg-slate-100" style={printExact}>
              {['S.No', 'Product', 'SKU', 'Qty', 'UOM', 'Remarks'].map((h, i) => (
                <th
                  key={h}
                  className={`border border-slate-400 px-2 py-1.5 font-semibold text-slate-700 ${i === 3 ? 'text-right' : 'text-left'}`}
                  style={printExact}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l, idx) => (
              <tr key={idx} className="align-top">
                <td className="border border-slate-400 px-2 py-1.5 text-slate-500 w-10">{idx + 1}</td>
                <td className="border border-slate-400 px-2 py-1.5">
                  <Field value={l.product} onChange={(v) => setLine(idx, 'product', v)} />
                </td>
                <td className="border border-slate-400 px-2 py-1.5 w-32">
                  <Field value={l.sku} onChange={(v) => setLine(idx, 'sku', v)} />
                </td>
                <td className="border border-slate-400 px-2 py-1.5 text-right w-20">
                  <Field value={l.qty} onChange={(v) => setLine(idx, 'qty', v)} className="text-right" />
                </td>
                <td className="border border-slate-400 px-2 py-1.5 w-20">
                  <Field value={l.uom} onChange={(v) => setLine(idx, 'uom', v)} />
                </td>
                <td className="border border-slate-400 px-2 py-1.5 w-44">
                  <Field value={l.remarks} onChange={(v) => setLine(idx, 'remarks', v)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Terms */}
        <div className="mt-5">
          <p className="font-semibold">Terms</p>
          <textarea
            rows={3}
            value={doc.terms}
            onChange={(e) => set('terms', e.target.value)}
            className={`${editAreaCls} mt-1 text-[12px] text-slate-700 print:hidden`}
          />
          <PrintText value={doc.terms} className="mt-1 text-[12px] text-slate-700" />
        </div>

        {/* Signature line */}
        <div className="mt-10 text-right font-semibold">
          For {doc.companyName || '________________'}
        </div>

        {/* Computer-generated note (replaces the seal/signature block) */}
        <div className="mt-8 pt-3 border-t border-slate-300 text-center text-[11px] text-slate-500 italic">
          This RFQ is computer-generated — no signature is required.
        </div>
      </div>
    </MainLayout>
  );
}

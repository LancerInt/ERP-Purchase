import { useState, useRef } from 'react';
import { Upload, X, Loader2, FileText, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';
import { Button } from '../ui';
import CustomSelect from '@/components/ui/CustomSelect';
import useLookup from '../../hooks/useLookup.js';
import apiClient from '../../utils/api.js';
import toast from 'react-hot-toast';
import { formatCurrency } from '@/utils/formatters';

/**
 * "Import Outward / Local Freight" — from a Tally Day Book XML.
 *
 * The live purchase import books an outward/local transporter payment as a bare
 * payment with no freight record (the connector drops the LFO/LFR narration), so
 * the Freight Outward/Local tiles read ~0. A full Day Book export still carries
 * the direction tag; this uploads it and creates the missing FreightAdviceOutbound
 * (LFO) / LocalFreight (LFR) records, matched to the payments by voucher GUID.
 * Idempotent (re-run never duplicates) and reversible (Revert tab on the page).
 *
 * Flow: pick company + file -> Preview (dry-run) -> Apply.
 */
export default function DaybookFreightImportButton({ onDone }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [company, setCompany] = useState('');
  const [preview, setPreview] = useState(null);
  const [applied, setApplied] = useState(null);
  const [busy, setBusy] = useState(false);
  const { options: companies } = useLookup('/api/companies/');
  const fileRef = useRef(null);

  const close = () => { setOpen(false); setPreview(null); setApplied(null); setFile(null); setCompany(''); };

  const post = async (apply) => {
    if (!file) { toast.error('Choose the Day Book XML first'); return; }
    if (!company) { toast.error('Pick a company'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('company', company);
      const { data } = await apiClient.post(
        `/api/purchase/local-freight/import-daybook/?apply=${apply ? 1 : 0}`, fd,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
      if (apply) { setApplied(data); toast.success('Freight records created'); onDone?.(); }
      else setPreview(data);
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message || 'Import failed');
    } finally { setBusy(false); }
  };

  const dir = (res, key) => res?.[key] || {};
  const money = (v) => formatCurrency(Number(v || 0));

  return (
    <>
      <Button variant="outline" icon={Upload} responsiveLabel onClick={() => { setPreview(null); setApplied(null); setOpen(true); }}
        title="Create outward & local freight records from a Tally Day Book export">
        Import Outward / Local Freight
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={close}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 max-h-[90dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-slate-800">Import Outward / Local Freight</h3>
              <button onClick={close} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close"><X size={18} /></button>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              The live import books outward/local transporter payments with no freight
              record. Upload the same <b>Day Book XML</b> (Day Book → Alt+E → XML) and this
              creates the missing <b>Outward</b> + <b>Local</b> records from the LFO / LFR
              vouchers. Safe to re-run — matched by voucher, never duplicated.
            </p>

            <div className="space-y-3 mb-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Company (in ERP)</label>
                <CustomSelect value={company} onChange={(e) => setCompany(e.target.value)}>
                  <option value="">Select company…</option>
                  {(companies || []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Day Book XML file</label>
                <input ref={fileRef} type="file" accept=".xml" onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); setApplied(null); }}
                  className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 file:mr-3 file:rounded file:border-0 file:bg-indigo-50 file:px-2 file:py-1 file:text-indigo-700" />
                {file && <p className="text-[11px] text-slate-500 mt-1 flex items-center gap-1"><FileText size={12} /> {file.name} ({Math.round(file.size / 1024)} KB)</p>}
              </div>
            </div>

            {/* dry-run preview */}
            {preview && !applied && (
              <div className="mb-3 rounded-lg border border-slate-200 overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 text-xs font-semibold text-slate-600 border-b border-slate-200">
                  Preview — nothing written yet
                  {preview?.parsed?.total != null && <span className="font-normal"> · {preview.parsed.total} freight vouchers in file</span>}
                </div>
                <table className="w-full text-sm">
                  <thead><tr className="text-xs text-slate-500">
                    <th className="text-left px-3 py-1.5">Direction</th>
                    <th className="text-right px-3 py-1.5">New</th>
                    <th className="text-right px-3 py-1.5">Updated</th>
                    <th className="text-right px-3 py-1.5">Amount</th>
                  </tr></thead>
                  <tbody>
                    {[['Outward', 'outward'], ['Local', 'local']].map(([label, key]) => (
                      <tr key={key} className="border-t border-slate-100">
                        <td className="px-3 py-1.5 text-slate-700">{label}</td>
                        <td className="px-3 py-1.5 text-right font-medium">{dir(preview, key).new ?? 0}</td>
                        <td className="px-3 py-1.5 text-right text-slate-500">{dir(preview, key).updated ?? 0}</td>
                        <td className="px-3 py-1.5 text-right">{money(dir(preview, key).amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100 space-y-0.5">
                  <div>Inward skipped: {preview.skipped_inward ?? 0} (already on purchase import)</div>
                  <div>New transporters to create: {preview.new_transporters ?? 0}</div>
                  {Array.isArray(preview.unresolved_transporter) && preview.unresolved_transporter.length > 0 &&
                    <div className="text-amber-600">Unresolved transporter on: {preview.unresolved_transporter.join(', ')}</div>}
                </div>
              </div>
            )}

            {/* applied */}
            {applied && (
              <div className="mb-3 flex flex-col items-center gap-2 py-3 text-center">
                <CheckCircle2 size={28} className="text-green-600" />
                <div className="text-sm text-slate-700">
                  Created <b>{dir(applied, 'outward').new ?? 0}</b> outward and <b>{dir(applied, 'local').new ?? 0}</b> local
                  freight records ({money(applied.gap_amount)}).
                </div>
                <div className="text-xs text-slate-500">
                  Updated {(dir(applied, 'outward').updated ?? 0) + (dir(applied, 'local').updated ?? 0)} ·
                  {' '}new transporters {applied.new_transporters ?? 0}
                </div>
              </div>
            )}

            <div className="flex justify-end items-center gap-2 mt-2">
              {applied ? (
                <Button variant="primary" onClick={close}>Done</Button>
              ) : (
                <>
                  <button onClick={close} className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">Cancel</button>
                  {!preview ? (
                    <Button variant="outline" icon={ArrowRight} onClick={() => post(false)} disabled={busy || !file || !company}>
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Preview'}
                    </Button>
                  ) : (
                    <Button variant="primary" icon={CheckCircle2} onClick={() => post(true)} disabled={busy}>
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Apply'}
                    </Button>
                  )}
                </>
              )}
            </div>
            {!preview && !applied && <p className="text-[11px] text-slate-400 mt-2 text-right">Pick company + file, then <b>Preview</b>.</p>}
          </div>
        </div>
      )}
    </>
  );
}

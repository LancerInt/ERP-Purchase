import React, { useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import apiClient from '../../utils/api.js';
import { timeAgo } from '../../utils/timeAgo.js';

/**
 * "Last synced …" strip for a page's sync buttons.
 *
 * Per COMPANY, because each company is imported separately: a single global
 * stamp would hide that United Agro has not synced in a week while SS Biochem
 * synced this morning. Reads /api/sync-status/ (one row per kind x company,
 * upserted by record_sync on every real import) and shows, for the `kinds`
 * this page cares about, each company's most recent run as a relative time.
 *
 * Shows nothing at all until something has actually synced, so a fresh install
 * carries no empty scaffolding. `refreshKey` — bump it (e.g. from a button's
 * onDone) to re-fetch after a sync completes.
 */
const KIND_LABEL = {
  tally_sales: 'Tally sales',
  tally_purchase: 'Tally purchase',
  tally_transactions: 'Tally',
  tally_creditors: 'Tally creditors',
  tally_tds_payable: 'Tally TDS',
  tally_freight_inward: 'Tally freight',
  tally_reconcile: 'Tally reconcile',
  tally_file: 'Tally file',
  zoho_bills: 'Zoho',
  bank_tally: 'Bank (Tally)',
};

const shortCo = (name) => (/biochem/i.test(name) ? 'SS'
  : /united\s*agro/i.test(name) ? 'UAI'
    : (name || '').split(/\s+/)[0] || name);

export default function SyncStatusBar({ kinds, companyId = '', refreshKey = 0, className = '' }) {
  const [runs, setRuns] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const qp = companyId ? `?company=${encodeURIComponent(companyId)}` : '';
    apiClient.get(`/api/sync-status/${qp}`)
      .then((r) => { if (!cancelled) setRuns(r.data?.runs || []); })
      // A failure here must never disrupt the page — the buttons still work.
      .catch(() => { if (!cancelled) setRuns([]); });
    return () => { cancelled = true; };
  }, [companyId, refreshKey]);

  if (!runs || runs.length === 0) return null;

  const wanted = kinds && kinds.length
    ? runs.filter((r) => kinds.includes(r.kind))
    : runs;
  if (!wanted.length) return null;

  // Group by kind, each kind listing its companies.
  const byKind = new Map();
  for (const r of wanted) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }

  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 ${className}`}>
      <span className="inline-flex items-center gap-1 font-medium text-slate-400">
        <RefreshCw size={11} /> Last synced
      </span>
      {[...byKind.entries()].map(([kind, list]) => (
        <span key={kind} className="inline-flex items-center gap-1">
          <span className="font-medium text-slate-600">{KIND_LABEL[kind] || kind}:</span>
          {list.map((r, i) => (
            <span key={r.company || i} className="inline-flex items-center gap-0.5">
              {r.company_name && <span className="text-slate-400">{shortCo(r.company_name)}</span>}
              <span
                title={`${r.company_name || 'All'} · ${new Date(r.finished_at).toLocaleString()}${r.detail ? ' · ' + r.detail : ''}`}
                className={r.status === 'error' ? 'text-amber-600' : 'text-slate-600'}
              >
                {r.status === 'error' && <AlertTriangle size={10} className="inline mb-0.5 mr-0.5" />}
                {timeAgo(r.finished_at)}
              </span>
              {i < list.length - 1 && <span className="text-slate-300">·</span>}
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

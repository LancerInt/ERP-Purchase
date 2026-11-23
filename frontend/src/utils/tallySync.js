import apiClient from './api.js';

/**
 * Turn the raw /api/sync-status/ rows (SyncRun, one per kind×company) into a
 * per-company, per-kind "when did Tally last sync" summary for the sidebar
 * button and the status modal. This reuses the SAME data the Bills/Invoices
 * "Last synced" strip shows — the real import recency.
 *
 * Sales and Purchase are now distinct kinds (tally_sales / tally_purchase),
 * stamped separately per company, so the modal can show each side on its own.
 * tally_transactions is the pre-split combined kind, kept for older rows.
 */

// SyncRun kinds that count as "Tally" (zoho_bills is deliberately excluded),
// in the order they should appear within a company.
export const TALLY_KINDS = {
  tally_sales: 'Sales',
  tally_purchase: 'Purchase',
  tally_transactions: 'Sales / Purchase',   // legacy (pre-split) rows
  tally_creditors: 'Creditors',
  tally_tds_payable: 'TDS payable',
  tally_freight_inward: 'Freight inward',
  tally_reconcile: 'Reconcile',
  tally_file: 'File import',
  bank_tally: 'Bank',
};

const shortCo = (name = '') =>
  (/biochem/i.test(name) ? 'SS'
    : /united\s*agro/i.test(name) ? 'UAI'
      : (String(name).split(/\s+/)[0] || name));

const ms = (iso) => (iso ? new Date(iso).getTime() : 0);

/**
 * Reduce raw runs → {
 *   last_synced_at, error_count,            // overall (for the sidebar dot)
 *   by_company: [{ company_id, company_name, short, last_synced_at, error_count,
 *                  kinds: [{ kind, label, last_synced_at, status }] }],
 *   count,
 * }
 */
export function summariseSyncRuns(runs) {
  const tally = (runs || []).filter((r) => r && r.kind in TALLY_KINDS);

  let last = null;
  let errorCount = 0;
  const companies = new Map();

  for (const r of tally) {
    const t = ms(r.finished_at);
    if (r.status === 'error') errorCount += 1;
    if (!last || t > ms(last)) last = r.finished_at;

    const cid = r.company || '__none__';
    let c = companies.get(cid);
    if (!c) {
      c = {
        company_id: r.company || null,
        company_name: r.company_name || '',
        short: shortCo(r.company_name),
        last_synced_at: null,
        error_count: 0,
        _kinds: new Map(),   // kind → most-recent run for this company
      };
      companies.set(cid, c);
    }
    if (r.status === 'error') c.error_count += 1;
    if (!c.last_synced_at || t > ms(c.last_synced_at)) c.last_synced_at = r.finished_at;

    const prev = c._kinds.get(r.kind);
    if (!prev || t > ms(prev.last_synced_at)) {
      c._kinds.set(r.kind, {
        kind: r.kind,
        label: TALLY_KINDS[r.kind],
        last_synced_at: r.finished_at,
        status: r.status,
      });
    }
  }

  const by_company = [...companies.values()]
    .map((c) => {
      // Always render Sales and Purchase — but with the REAL per-side sync time
      // only. No combined fallback: a side that wasn't imported reads "never"
      // (the real-time truth), it never borrows the old combined time.
      const side = (kind, label) => {
        const real = c._kinds.get(kind);
        return real
          ? { kind, label, last_synced_at: real.last_synced_at, status: real.status }
          : { kind, label, last_synced_at: null, status: 'ok' };
      };
      const sales = side('tally_sales', 'Sales');
      const purchase = side('tally_purchase', 'Purchase');
      // Company header reflects its two modules so it never disagrees with the
      // rows (e.g. "3h ago" over two "never" rows).
      const times = [sales.last_synced_at, purchase.last_synced_at]
        .filter(Boolean).map((t) => ms(t));
      return {
        company_id: c.company_id,
        company_name: c.company_name,
        short: c.short,
        last_synced_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
        error_count: (sales.status === 'error' ? 1 : 0) + (purchase.status === 'error' ? 1 : 0),
        kinds: [sales, purchase],
      };
    })
    .sort((a, b) => a.short.localeCompare(b.short));

  return { last_synced_at: last, error_count: errorCount, by_company, count: tally.length };
}

/** Fetch + summarise. Throws on network/HTTP error (callers decide how to fail). */
export async function fetchTallySyncSummary() {
  const res = await apiClient.get('/api/sync-status/');
  return summariseSyncRuns(res.data?.runs || []);
}

/** green = fresh (<24h), amber = stale (>24h), red = any error, slate = never. */
export function syncTone({ last_synced_at, error_count } = {}) {
  if (error_count > 0) return 'red';
  if (!last_synced_at) return 'slate';
  return (Date.now() - ms(last_synced_at)) / 3.6e6 > 24 ? 'amber' : 'green';
}

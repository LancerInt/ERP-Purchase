/**
 * Customer PO Inbox panel.
 *
 * Surfaces PO-related emails the backend IMAP poller has captured,
 * lets the user pick an attachment, and routes to the Create
 * Customer PO page with `?inbox_id=...&attachment_id=...` so the
 * existing extract flow can pull the file directly.
 *
 * UX:
 *   - The panel inlines the 5 most-recent emails so the table below
 *     stays the focal point of the Customer PO page.
 *   - A "View all N emails" button opens a modal with the full list
 *     when there are more than 5.
 *   - After each Refresh Inbox click, the latest poll stats
 *     (scanned / new / duplicate / non-PO / failed) are shown right
 *     under the header so the user can see exactly what the poll did.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  RefreshCw, Mail, Paperclip, ChevronDown, ChevronUp,
  AlertTriangle, CheckCircle2, Clock, Inbox, X,
  FileText, FileImage, FileSpreadsheet, File, ScrollText,
  Download as DownloadIcon, Sparkles, Eye, Copy, Search,
} from 'lucide-react';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { formatDateTime } from '@/utils/formatters';

const STATUS_META = {
  NEW:              { label: 'New',              cls: 'bg-slate-100 text-slate-700' },
  ATTACHMENT_FOUND: { label: 'Attachment Found', cls: 'bg-amber-50 text-amber-700 border border-amber-200' },
  NO_ATTACHMENT:    { label: 'No Attachment',    cls: 'bg-slate-100 text-slate-500' },
  PROCESSED:        { label: 'Processed',        cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200' },
  FAILED:           { label: 'Failed',           cls: 'bg-red-50 text-red-700 border border-red-200' },
};

const VISIBLE_LIMIT = 5;

const fmtDateTime = (iso) => {
  if (!iso) return '-';
  try {
    return formatDateTime(iso);
  } catch { return iso; }
};

const fmtBytes = (n) => {
  const x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  return `${(x / 1024 / 1024).toFixed(2)} MB`;
};

// Map file extension → coloured Lucide icon. Mirrors the visual
// language email clients (Gmail, Outlook, Apple Mail) use for
// attachment chips so the row reads at-a-glance.
const ATTACHMENT_META_BY_EXT = {
  pdf:  { Icon: FileText,        cls: 'bg-red-50 text-red-600 border-red-200',          label: 'PDF' },
  doc:  { Icon: FileText,        cls: 'bg-blue-50 text-blue-600 border-blue-200',        label: 'DOC' },
  docx: { Icon: FileText,        cls: 'bg-blue-50 text-blue-600 border-blue-200',        label: 'DOCX' },
  xls:  { Icon: FileSpreadsheet, cls: 'bg-emerald-50 text-emerald-600 border-emerald-200', label: 'XLS' },
  xlsx: { Icon: FileSpreadsheet, cls: 'bg-emerald-50 text-emerald-600 border-emerald-200', label: 'XLSX' },
  png:  { Icon: FileImage,       cls: 'bg-amber-50 text-amber-600 border-amber-200',      label: 'PNG' },
  jpg:  { Icon: FileImage,       cls: 'bg-amber-50 text-amber-600 border-amber-200',      label: 'JPG' },
  jpeg: { Icon: FileImage,       cls: 'bg-amber-50 text-amber-600 border-amber-200',      label: 'JPEG' },
  webp: { Icon: FileImage,       cls: 'bg-amber-50 text-amber-600 border-amber-200',      label: 'WEBP' },
};

const _attachmentMeta = (filename) => {
  const ext = (filename || '').toLowerCase().split('.').pop();
  return ATTACHMENT_META_BY_EXT[ext] || {
    Icon: File, cls: 'bg-slate-100 text-slate-500 border-slate-200', label: 'FILE',
  };
};

/**
 * Single attachment "chip" — Gmail-style: rounded card with a
 * coloured file-type icon on the left, filename + size in the
 * middle, and Download / Process buttons on the right. Designed so
 * users opening the inbox panel see attachments the same way they
 * would in their actual email client.
 */
function AttachmentChip({ attachment, canProcess, isProcessed, onProcess, onView }) {
  const meta = _attachmentMeta(attachment.filename);
  const { Icon } = meta;
  return (
    <div className={`flex items-stretch gap-2 rounded-lg border ${meta.cls.replace('text-', 'border-').replace('bg-', '')} bg-white max-w-md`}>
      {/* Icon block */}
      <div className={`flex items-center justify-center px-3 py-2 rounded-l-lg border-r ${meta.cls}`}>
        <Icon size={20} />
      </div>
      {/* Filename + size */}
      <div className="flex-1 min-w-0 py-2 pr-2 flex flex-col justify-center">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-800 truncate" title={attachment.filename}>
            {attachment.filename}
          </span>
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${meta.cls}`}>
            {meta.label}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-slate-500 mt-0.5">
          <span>{fmtBytes(attachment.size)}</span>
          {!attachment.is_processable && (
            <span className="text-amber-600 italic">unsupported format</span>
          )}
        </div>
      </div>
      {/* Action buttons */}
      <div className="flex items-center gap-1 pr-2">
        {onView && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onView(attachment); }}
            title="View attachment in this page"
            className="p-1.5 text-slate-500 hover:text-indigo-700 hover:bg-indigo-50 rounded"
          >
            <Eye size={14} />
          </button>
        )}
        <a
          href={attachment.download_url}
          download={attachment.filename}
          onClick={(e) => e.stopPropagation()}
          title="Download"
          className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-50 rounded"
        >
          <DownloadIcon size={14} />
        </a>
        {attachment.is_processable && !isProcessed && canProcess && (
          <button
            type="button"
            onClick={onProcess}
            title="Run through the Auto Extractor"
            className="inline-flex items-center gap-1 px-2 py-1 bg-indigo-600 text-white rounded text-[11px] font-medium hover:bg-indigo-700"
          >
            <Sparkles size={11} />
            Process
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One row in the email list. Pulled out so we can render the same
 * markup in both the inline 5-email panel AND the "View all" modal
 * without duplicating the row layout.
 */
function EmailRow({ email, isRowExpanded, canProcess, onProcessClick, onProcessAttachment, onToggleAttachments, onPreview, onViewAttachment }) {
  const meta = STATUS_META[email.status] || STATUS_META.NEW;
  const processable = (email.attachments || []).filter(a => a.is_processable);
  const isProcessed = email.status === 'PROCESSED';
  const canProcessThisRow = canProcess && processable.length > 0 && !isProcessed;
  // Show the attachment list inline when:
  //   - user explicitly expanded the row, OR
  //   - the email has multiple processable attachments (user must
  //     pick one before the Process Mail button can act)
  const showAttachments = email.attachments?.length > 0 && (
    isRowExpanded || (processable.length > 1 && !isProcessed)
  );
  return (
    <div className="px-3 sm:px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${meta.cls}`}>
              {email.status === 'PROCESSED' && <CheckCircle2 size={11} />}
              {email.status === 'ATTACHMENT_FOUND' && <Paperclip size={11} />}
              {email.status === 'NO_ATTACHMENT' && <AlertTriangle size={11} />}
              {email.status === 'NEW' && <Clock size={11} />}
              {meta.label}
            </span>
            {/* The poller now captures EVERY email, not just PO matches.
                Tag the ones whose subject/body/attachment names didn't
                trip a PO keyword so users can scan past them quickly. */}
            {email.is_po_likely === false && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-500 border border-slate-200" title="No PO keyword matched in subject, body, sender or attachment names — kept for audit only.">
                Non-PO
              </span>
            )}
            {email.attachment_count > 0 && (
              <button
                type="button"
                onClick={() => onToggleAttachments?.(email.id)}
                className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-700"
                title={isRowExpanded ? 'Hide attachments' : 'Show attachments'}
              >
                <Paperclip size={11} />
                {email.attachment_count} attachment{email.attachment_count === 1 ? '' : 's'}
                {isRowExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              </button>
            )}
            <span className="text-[11px] text-slate-400">{fmtDateTime(email.received_at)}</span>
          </div>
          <p className="text-sm font-medium text-slate-800 truncate">{email.subject || '(no subject)'}</p>
          <p className="text-xs text-slate-500 truncate">From: {email.sender || '-'}</p>
          {email.body_preview && (
            <p className="text-xs text-slate-400 mt-1 line-clamp-2">{email.body_preview}</p>
          )}
          {email.failure_reason && (
            <p className="text-xs text-red-600 mt-1">⚠ {email.failure_reason}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end sm:gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onPreview?.(email)}
            title="View the full email — subject, body, attachments"
            className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 text-slate-700 rounded-lg text-xs font-medium hover:bg-slate-50 whitespace-nowrap"
          >
            <Eye size={12} /> Preview
          </button>
          <button
            type="button"
            onClick={() => onProcessClick(email)}
            disabled={!canProcessThisRow}
            title={
              isProcessed ? 'Already processed' :
              !canProcess ? 'Requires Customer PO create permission' :
              processable.length === 0 ? 'No processable attachment on this email' :
              'Load the attachment into the Auto Extractor'
            }
            className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {isProcessed ? 'Processed' : 'Process Mail'}
          </button>
        </div>
      </div>

      {showAttachments && (
        <div className="mt-3 ml-1 sm:ml-6 flex flex-wrap gap-2">
          {email.attachments.map(att => (
            <AttachmentChip
              key={att.id}
              attachment={att}
              canProcess={canProcess}
              isProcessed={isProcessed}
              onProcess={() => onProcessAttachment(email, att.id)}
              onView={onViewAttachment}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Stats badge — small inline counter, e.g. "scanned 63".
 * Used to render the last-poll summary so the user can see exactly
 * what each Refresh did.
 */
function StatChip({ label, value, tone = 'slate' }) {
  const toneCls = {
    slate:   'bg-slate-100 text-slate-700',
    emerald: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
    amber:   'bg-amber-50 text-amber-700 border border-amber-200',
    sky:     'bg-sky-50 text-sky-700 border border-sky-200',
    red:     'bg-red-50 text-red-700 border border-red-200',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${toneCls}`}>
      <span className="font-normal opacity-75">{label}</span>
      <span className="tabular-nums">{value}</span>
    </span>
  );
}

export default function InboxPanel() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const canRefresh = canCreate('Customer PO');
  // Processing a mail loads its attachment into the Customer PO Auto
  // Extractor and ultimately creates a fresh CPO record — it's a
  // create action, not an edit. Gating it on can_create alone matches
  // that semantic; previously requiring can_edit too forced admins
  // to grant a permission that wasn't actually needed for this flow.
  const canProcess = canCreate('Customer PO');

  const [emails, setEmails] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isPolling, setIsPolling] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [expandedRowId, setExpandedRowId] = useState(null);
  // Modal that lists ALL captured emails. Opened by the "View all"
  // button when more than VISIBLE_LIMIT emails exist.
  const [showAllModal, setShowAllModal] = useState(false);
  // Modal showing emails the backend flagged as duplicates of an
  // earlier capture — same PO forwarded again. Opened by the
  // "Duplicate Mail" button in the header.
  const [showDuplicatesModal, setShowDuplicatesModal] = useState(false);
  // Free-text search across subject / sender / body / attachment
  // filenames. Drives the inline list, "Show all mail" modal and
  // "Duplicate Mail" modal so the same query narrows every view.
  const [searchQuery, setSearchQuery] = useState('');
  // Latest poll result — shown right under the header so the user
  // can see exactly what the most recent Refresh did. Cleared on
  // page mount; rendered as a row of stat chips + a "last refresh
  // at" timestamp.
  const [lastPoll, setLastPoll] = useState(null);
  // Scan-log modal — opens when the user clicks the scan-log link
  // next to the last-refresh stats. Shows the per-message verdicts
  // (subject + sender + verdict + reason) the backend returned in
  // `decisions`. Empty if no poll has run yet this page-load.
  const [showScanLog, setShowScanLog] = useState(false);
  // Email-preview modal. Holds the email object whose body + meta
  // + attachments should be shown in a full-page card; null when
  // no preview is open.
  const [previewEmail, setPreviewEmail] = useState(null);
  // Attachment viewer modal — opened by the Eye button on each
  // chip. Renders images / PDFs inline so the user can verify the
  // file without leaving the page (or trusting their OS to open
  // the download safely). Shape: { attachment, blobUrl, status,
  // error } where status is one of 'loading' | 'ready' | 'error'.
  const [viewer, setViewer] = useState(null);
  // Synchronous lock for the Refresh button (immune to React's
  // async state batching).
  const pollingRef = useRef(false);

  const fetchEmails = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get('/api/sales/inbox-pos/?ordering=-received_at&page_size=200');
      setEmails(res.data?.results || res.data || []);
    } catch (err) {
      console.error('inbox fetch failed', err);
      toast.error('Failed to load inbox emails');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { fetchEmails(); }, []);

  // Revoke the viewer's blob URL when the URL changes (user opened a
  // different attachment) or the component unmounts. handleCloseViewer
  // already revokes on explicit close, but this catches the edge
  // cases — navigation away while the viewer is open, or rapid
  // attachment-swapping inside the same session.
  useEffect(() => {
    const url = viewer?.blobUrl;
    if (!url) return undefined;
    return () => {
      try { URL.revokeObjectURL(url); } catch { /* no-op */ }
    };
  }, [viewer?.blobUrl]);

  const handleRefresh = async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    setIsPolling(true);
    try {
      // 120s timeout — a poll walks every message in the SINCE
      // window over IMAP, which on Gmail can take ~30-60s per
      // ~100 messages. apiClient's 30s default is too tight for
      // first-time imports or large mailboxes.
      const res = await apiClient.post('/api/sales/inbox-pos/poll/', null, {
        timeout: 120000,
      });
      const r = res.data || {};
      // Stash the poll result so the user can see counters inline
      // (the toast is just a quick summary).
      setLastPoll({ ...r, at: new Date().toISOString() });

      if (r.busy) {
        toast('A refresh is already running in another tab', { icon: '⏳' });
      } else if (r.error) {
        toast.error(`Inbox refresh failed: ${r.error}`);
      } else {
        const imported = r.imported || 0;
        const dupes = r.skipped_duplicate || 0;
        const fetched = r.fetched || 0;
        if (imported > 0) {
          toast.success(
            imported === 1
              ? '✓ 1 new PO email captured'
              : `✓ ${imported} new PO emails captured`,
          );
        } else if (dupes > 0 || fetched > 0) {
          toast.success('Inbox is up to date — no new PO emails');
        } else {
          toast('No PO-related emails found in the last 30 days', { icon: '📭' });
        }
      }
      await fetchEmails();
    } catch (err) {
      console.error('inbox poll failed', err);
      // Surface as much detail as possible. DRF error responses come
      // back as { detail: '…' } or a raw message; show whichever we
      // can extract so "Inbox poll failed" is never a dead end.
      const reason =
        err.response?.data?.detail
        || err.response?.data?.error
        || err.message
        || 'Unknown error';
      toast.error(`Inbox refresh failed: ${reason}`);
    } finally {
      pollingRef.current = false;
      setIsPolling(false);
    }
  };

  const handleProcessAttachment = (email, attachmentId) => {
    const att = email.attachments?.find(a => String(a.id) === String(attachmentId));
    if (att && !att.is_processable) {
      toast.error(`"${att.filename}" is not a supported PO format.`);
      return;
    }
    // Pass the original filename in the URL so the create page can
    // construct a properly-named File even when CORS hides the
    // Content-Disposition header (the cross-origin prod setup strips
    // it unless explicitly exposed). Without the extension on the
    // filename the extractor's format check rejects the upload.
    const params = new URLSearchParams({
      inbox_id: String(email.id),
      attachment_id: String(attachmentId),
    });
    if (att?.filename) params.set('filename', att.filename);
    navigate(`/sales/customer-po/new?${params.toString()}`);
  };

  const handleProcessClick = (email) => {
    const processable = (email.attachments || []).filter(a => a.is_processable);
    if (processable.length === 0) {
      toast.error('No processable attachment on this email.');
      return;
    }
    if (processable.length === 1) {
      handleProcessAttachment(email, processable[0].id);
      return;
    }
    // Multi-attachment: expand the row so user can pick.
    setExpandedRowId(email.id === expandedRowId ? null : email.id);
  };

  const handleToggleAttachments = (id) => {
    setExpandedRowId(prev => prev === id ? null : id);
  };

  // Fetch the attachment as a Blob (apiClient adds the auth header
  // which a bare <img src=...> wouldn't), wrap it in an object URL,
  // and stash it in the viewer state so the modal can render it.
  // The object URL is revoked on close so we don't leak memory.
  const handleViewAttachment = async (attachment) => {
    setViewer({ attachment, blobUrl: null, status: 'loading' });
    try {
      const res = await apiClient.get(attachment.download_url, {
        responseType: 'blob',
        timeout: 30000,
      });
      const blobUrl = URL.createObjectURL(res.data);
      setViewer({ attachment, blobUrl, status: 'ready' });
    } catch (err) {
      console.error('attachment view failed', err);
      setViewer({
        attachment,
        blobUrl: null,
        status: 'error',
        error: err?.response?.data?.detail || err?.message || 'Failed to load attachment',
      });
    }
  };

  const handleCloseViewer = () => {
    if (viewer?.blobUrl) {
      // Free the Blob's memory immediately rather than waiting for GC.
      try { URL.revokeObjectURL(viewer.blobUrl); } catch { /* no-op */ }
    }
    setViewer(null);
  };

  // Case-insensitive needle. Match against subject + sender + body +
  // attachment filenames so a search for "T stanes" finds the email
  // regardless of where the buyer wrote the brand name.
  const q = searchQuery.trim().toLowerCase();
  const searchedEmails = q
    ? emails.filter(e => {
        const haystack = [
          e.subject || '',
          e.sender || '',
          e.body_preview || '',
          e.body_text || '',
          ...(e.attachments || []).map(a => a.filename || ''),
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : emails;

  // Emails the backend flagged as forwards of a previously-captured
  // PO (same attachment bytes + normalized subject as an earlier row).
  // Filtered by the search query so the Duplicate Mail count matches
  // what's actually shown.
  const duplicates = searchedEmails.filter(e => e.duplicate_of);

  const counts = {
    total: emails.length,
    actionable: emails.filter(e => e.status === 'ATTACHMENT_FOUND').length,
    processed: emails.filter(e => e.status === 'PROCESSED').length,
    duplicates: duplicates.length,
    matched: searchedEmails.length,
  };

  // Inline panel shows only the most recent N; everything else lives
  // behind the "View all" modal so the page below stays the focus.
  // Duplicates are hidden from the inline list — they're surfaced
  // separately via the "Duplicate Mail" button so the main view stays
  // one row per unique PO.
  const primaryEmails = searchedEmails.filter(e => !e.duplicate_of);
  const visibleEmails = primaryEmails.slice(0, VISIBLE_LIMIT);
  const hasMore = primaryEmails.length > VISIBLE_LIMIT;

  const rowProps = {
    canProcess,
    onProcessClick: handleProcessClick,
    onProcessAttachment: handleProcessAttachment,
    onToggleAttachments: handleToggleAttachments,
    onPreview: setPreviewEmail,
    onViewAttachment: handleViewAttachment,
  };

  return (
    <>
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        {/* Header row */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-2 text-left"
          >
            <Inbox size={18} className="text-indigo-600 shrink-0" />
            <div>
              <p className="font-semibold text-slate-800 text-sm sm:text-base">PO Email Inbox</p>
              <p className="text-xs text-slate-500">
                {counts.total} captured · {counts.actionable} ready to process · {counts.processed} processed
              </p>
            </div>
            {expanded
              ? <ChevronUp  size={16} className="text-slate-400 ml-1" />
              : <ChevronDown size={16} className="text-slate-400 ml-1" />}
          </button>
          {/* Action buttons sit side-by-side on tablets+ and stack
              on phones. Two buttons here: Show all (opens the full
              email list modal) and Refresh Inbox (kicks the poll).
              The Show all button stays visible even when there are
              zero captured emails so the affordance is consistent
              — it just shows an empty-state hint instead of a list. */}
          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
            <button
              type="button"
              onClick={() => setShowAllModal(true)}
              title={`View all ${counts.total} captured email${counts.total === 1 ? '' : 's'} in a modal`}
              className="flex items-center gap-2 px-3 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50"
            >
              <Mail size={14} />
              Show all mail
              {counts.total > 0 && (
                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-indigo-100 text-indigo-700 text-[11px] font-semibold tabular-nums">
                  {counts.total}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setShowDuplicatesModal(true)}
              disabled={counts.duplicates === 0}
              title={
                counts.duplicates === 0
                  ? 'No forwarded duplicates detected'
                  : `View ${counts.duplicates} email${counts.duplicates === 1 ? '' : 's'} flagged as a forward of an earlier PO`
              }
              className="flex items-center gap-2 px-3 py-2 border border-amber-300 text-amber-800 rounded-lg text-sm font-medium hover:bg-amber-50 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white"
            >
              <Copy size={14} />
              Duplicate Mail
              {counts.duplicates > 0 && (
                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-amber-100 text-amber-700 text-[11px] font-semibold tabular-nums">
                  {counts.duplicates}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isPolling || !canRefresh}
              title={canRefresh ? 'Pull latest PO emails from the configured mailbox' : 'Requires Customer PO create permission'}
              className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw size={14} className={isPolling ? 'animate-spin' : ''} />
              {isPolling ? 'Checking…' : 'Refresh Inbox'}
            </button>
          </div>
        </div>

        {/* Last-poll stats — what the most recent Refresh actually did.
            Only shown after the first refresh of this page-load. */}
        {expanded && lastPoll && (
          <div className="px-4 py-2 border-b border-slate-100 bg-indigo-50/40 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-medium text-slate-700 mr-1">
              Last refresh{lastPoll.at ? ` ${fmtDateTime(lastPoll.at)}` : ''}:
            </span>
            {/* Mode badge — "incremental" means we only fetched NEW
                UIDs since last poll, "full scan" means we walked
                the full SINCE-date window. Makes it obvious why a
                subsequent refresh is fast. */}
            {lastPoll.mode === 'incremental' && (
              <StatChip label="mode" value="incremental" tone="emerald" />
            )}
            {lastPoll.mode === 'full_scan' && (
              <StatChip label="mode" value="full scan" tone="sky" />
            )}
            <StatChip label="scanned" value={lastPoll.fetched ?? 0} tone="sky" />
            <StatChip label="new" value={lastPoll.imported ?? 0} tone={lastPoll.imported ? 'emerald' : 'slate'} />
            <StatChip label="already known" value={lastPoll.skipped_duplicate ?? 0} />
            <StatChip label="non-PO" value={lastPoll.skipped_non_po ?? 0} />
            {(lastPoll.errors ?? 0) > 0 && (
              <StatChip label="failed" value={lastPoll.errors} tone="red" />
            )}
            {lastPoll.folder_total > 0 && (
              <StatChip label="folder total" value={lastPoll.folder_total} />
            )}
            {lastPoll.busy && (
              <span className="text-amber-700 italic">another poll was in progress — try again</span>
            )}
            {lastPoll.error && (
              <span className="text-red-700">⚠ {lastPoll.error}</span>
            )}
            {/* Scan-log link — opens a modal listing every message
                we touched, with the verdict and reason. Lets the
                user diagnose "why isn't email X showing up". */}
            {(lastPoll.decisions || []).length > 0 && (
              <button
                type="button"
                onClick={() => setShowScanLog(true)}
                className="ml-auto inline-flex items-center gap-1 text-indigo-700 hover:text-indigo-900 hover:underline font-medium"
              >
                <ScrollText size={12} />
                View scan log ({lastPoll.decisions.length})
              </button>
            )}
          </div>
        )}

        {/* Search bar — filters subject, sender, body and attachment
            filenames. Drives the inline list AND both modals so the
            same query applies across every view. */}
        {expanded && emails.length > 0 && (
          <div className="px-4 py-2 border-b border-slate-100 bg-white">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search by subject, sender, body or attachment name…"
                className="w-full pl-9 pr-9 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  title="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            {searchQuery && (
              <p className="mt-1 text-xs text-slate-500">
                {counts.matched === 0
                  ? `No emails match "${searchQuery}".`
                  : `${counts.matched} of ${counts.total} email${counts.matched === 1 ? '' : 's'} match "${searchQuery}".`}
              </p>
            )}
          </div>
        )}

        {expanded && (
          <div>
            {isLoading ? (
              <div className="px-4 py-4 sm:py-6 text-center text-sm text-slate-500">Loading…</div>
            ) : emails.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-400">
                <Mail size={28} className="mx-auto text-slate-300 mb-2" />
                No PO emails captured yet. Click <strong>Refresh Inbox</strong> to pull the latest from the configured mailbox.
              </div>
            ) : primaryEmails.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-400">
                <Search size={28} className="mx-auto text-slate-300 mb-2" />
                {searchQuery
                  ? <>No PO emails match <strong>"{searchQuery}"</strong>.</>
                  : 'All captured emails are flagged as duplicates — see the Duplicate Mail button above.'}
              </div>
            ) : (
              <>
                <div className="divide-y divide-slate-100">
                  {visibleEmails.map(email => (
                    <EmailRow
                      key={email.id}
                      email={email}
                      isRowExpanded={expandedRowId === email.id}
                      {...rowProps}
                    />
                  ))}
                </div>
                {hasMore && (
                  <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/60 text-center">
                    <button
                      type="button"
                      onClick={() => setShowAllModal(true)}
                      className="text-sm font-medium text-indigo-700 hover:text-indigo-900 hover:underline"
                    >
                      View all {searchQuery ? counts.matched : counts.total} emails →
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Email-preview modal — opens when the user clicks the
          Preview button on an email row. Renders the email the way
          a mail client would: a clean header (subject + from +
          date) followed by the plain-text body, then any
          attachments as our Gmail-style chips. The user can also
          fire Process from inside the modal without closing it. */}
      {previewEmail && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4"
          onClick={() => setPreviewEmail(null)}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[95dvh] sm:max-h-[90dvh] flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-label="Email preview"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4 gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-slate-900 break-words">
                  {previewEmail.subject || '(no subject)'}
                </h2>
                <div className="mt-1 text-xs text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>
                    <span className="font-medium text-slate-700">From:</span>{' '}
                    {previewEmail.sender || '-'}
                  </span>
                  <span>
                    <span className="font-medium text-slate-700">Received:</span>{' '}
                    {fmtDateTime(previewEmail.received_at)}
                  </span>
                  {(() => {
                    const m = STATUS_META[previewEmail.status] || STATUS_META.NEW;
                    return (
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${m.cls}`}>
                        {m.label}
                      </span>
                    );
                  })()}
                </div>
              </div>
              <button
                onClick={() => setPreviewEmail(null)}
                className="p-1.5 rounded hover:bg-slate-100 text-slate-500 shrink-0"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            {/* Body — plain-text rendered with `whitespace-pre-wrap`
                so line breaks survive and never wraps off the edge.
                Empty bodies are common for emails that just carry
                an attachment; show a friendly note instead of a
                blank box. */}
            <div className="overflow-auto px-5 py-4 flex-1">
              {(previewEmail.body_text || previewEmail.body_preview || '').trim() ? (
                <pre className="whitespace-pre-wrap font-sans text-sm text-slate-700 leading-relaxed">
                  {previewEmail.body_text || previewEmail.body_preview}
                </pre>
              ) : (
                <p className="text-sm text-slate-400 italic">
                  This email has no text body — only the attachment(s) below.
                </p>
              )}

              {/* Attachments — same chip component as the inline
                  row, so visual style matches everywhere. */}
              {previewEmail.attachments && previewEmail.attachments.length > 0 && (
                <div className="mt-4 sm:mt-6 pt-4 border-t border-slate-100">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
                    {previewEmail.attachments.length} attachment{previewEmail.attachments.length === 1 ? '' : 's'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {previewEmail.attachments.map(att => (
                      <AttachmentChip
                        key={att.id}
                        attachment={att}
                        canProcess={canProcess}
                        isProcessed={previewEmail.status === 'PROCESSED'}
                        onProcess={() => handleProcessAttachment(previewEmail, att.id)}
                        onView={handleViewAttachment}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer actions */}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-3 bg-slate-50">
              <button
                type="button"
                onClick={() => setPreviewEmail(null)}
                className="px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded-lg"
              >
                Close
              </button>
              {previewEmail.status !== 'PROCESSED' && (previewEmail.attachments || []).some(a => a.is_processable) && canProcess && (
                <button
                  type="button"
                  onClick={() => {
                    handleProcessClick(previewEmail);
                    setPreviewEmail(null);
                  }}
                  className="inline-flex items-center gap-1 px-3 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700"
                >
                  <Sparkles size={14} /> Process Mail
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Scan-log modal — every message touched by the latest poll,
          with the verdict and reason. Read-only diagnostic; surfaces
          information that previously lived only at DEBUG log level. */}
      {showScanLog && lastPoll && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4"
          onClick={() => setShowScanLog(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[95dvh] sm:max-h-[85dvh] flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-label="Scan log"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-4 sm:px-5 py-3">
              <div>
                <h2 className="text-base font-semibold text-slate-800">Scan log</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  What the most recent Refresh did, message-by-message.
                  {lastPoll.mode === 'incremental' && ' Incremental poll — only new messages since the last refresh.'}
                  {lastPoll.mode === 'full_scan' && ' Full scan — walked the entire 30-day SINCE window.'}
                </p>
              </div>
              <button
                onClick={() => setShowScanLog(false)}
                className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="overflow-auto divide-y divide-slate-100">
              {(lastPoll.decisions || []).map((d, i) => {
                const verdictMeta = {
                  imported:  { Icon: CheckCircle2,   cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'PO captured' },
                  duplicate: { Icon: Inbox,          cls: 'bg-slate-100 text-slate-600 border-slate-200',        label: 'Already known' },
                  non_po:    { Icon: AlertTriangle,  cls: 'bg-amber-50 text-amber-700 border-amber-200',         label: 'Not a PO' },
                }[d.verdict] || { Icon: File, cls: 'bg-slate-100 text-slate-600 border-slate-200', label: d.verdict };
                const { Icon } = verdictMeta;
                return (
                  <div key={i} className="px-4 py-3 flex items-start gap-3">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border shrink-0 ${verdictMeta.cls}`}>
                      <Icon size={11} />
                      {verdictMeta.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800 truncate">
                        {d.subject || '(no subject)'}
                      </p>
                      <p className="text-xs text-slate-500 truncate">
                        From: {d.sender || '-'} · UID {d.uid}
                      </p>
                      <p className="text-xs text-slate-400 mt-0.5">{d.reason}</p>
                    </div>
                  </div>
                );
              })}
              {(lastPoll.decisions || []).length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-slate-400">
                  No scan decisions recorded yet — click <strong>Refresh Inbox</strong> first.
                </div>
              )}
            </div>
            <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
              Showing the last {lastPoll.decisions?.length || 0} messages this poll touched. Earlier polls aren't retained.
            </div>
          </div>
        </div>
      )}

      {/* "Duplicate Mail" modal — emails the backend flagged as a
          forward of an earlier capture (same attachment bytes + same
          normalized subject). Lets the user decide which copy to
          process and ignore the rest. Rendered with the same EmailRow
          so the user can preview / process any duplicate too — the
          flag is informational, not a hard block. */}
      {showDuplicatesModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4"
          onClick={() => setShowDuplicatesModal(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[95dvh] sm:max-h-[85dvh] flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-label="Duplicate POs"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-4 sm:px-5 py-3">
              <div>
                <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
                  <Copy size={16} className="text-amber-600" />
                  Duplicate POs
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {counts.duplicates} email{counts.duplicates === 1 ? '' : 's'} look like a forward of a PO we already captured.
                  Same attachment bytes + same subject as an earlier email.
                </p>
              </div>
              <button
                onClick={() => setShowDuplicatesModal(false)}
                className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="overflow-auto divide-y divide-slate-100">
              {duplicates.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-slate-400">
                  <Copy size={32} className="mx-auto text-slate-300 mb-3" />
                  <p>No forwarded duplicates detected.</p>
                  <p className="text-xs mt-1">
                    When the same PO arrives twice (e.g. forwarded), the second copy will show up here.
                  </p>
                </div>
              ) : (
                duplicates.map(email => (
                  <div key={email.id}>
                    <div className="px-4 pt-3 pb-1 text-xs text-amber-800 bg-amber-50/60 border-l-4 border-amber-300">
                      <span className="font-semibold">Duplicate of:</span>{' '}
                      <span className="text-slate-700">{email.duplicate_of_subject || `Email #${email.duplicate_of}`}</span>
                      {email.duplicate_of_received_at && (
                        <span className="text-slate-500"> · received {fmtDateTime(email.duplicate_of_received_at)}</span>
                      )}
                    </div>
                    <EmailRow
                      email={email}
                      isRowExpanded={expandedRowId === email.id}
                      {...rowProps}
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* "View all" modal — full email list rendered with the same
          EmailRow component so behaviour is identical to the inline
          view. Honours the search query so opening it after a search
          shows the narrowed list. */}
      {showAllModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4"
          onClick={() => setShowAllModal(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[95dvh] sm:max-h-[85dvh] flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-label="All PO emails"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-4 sm:px-5 py-3">
              <div>
                <h2 className="text-base font-semibold text-slate-800">All PO emails</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {searchQuery
                    ? <>{counts.matched} of {counts.total} match <strong>"{searchQuery}"</strong></>
                    : <>{counts.total} captured · {counts.actionable} ready to process · {counts.processed} processed</>}
                </p>
              </div>
              <button
                onClick={() => setShowAllModal(false)}
                className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="overflow-auto divide-y divide-slate-100">
              {searchedEmails.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-slate-400">
                  <Mail size={32} className="mx-auto text-slate-300 mb-3" />
                  {emails.length === 0 ? (
                    <>
                      <p>No PO emails captured yet.</p>
                      <p className="text-xs mt-1">Click <strong>Refresh Inbox</strong> to pull the latest from the configured mailbox.</p>
                    </>
                  ) : (
                    <p>No emails match <strong>"{searchQuery}"</strong>.</p>
                  )}
                </div>
              ) : (
                searchedEmails.map(email => (
                  <EmailRow
                    key={email.id}
                    email={email}
                    isRowExpanded={expandedRowId === email.id}
                    {...rowProps}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Attachment viewer modal — renders the file inline via a Blob
          object URL (fetched with the auth header by apiClient).
          Image extensions render in an <img>, PDFs in an <iframe>;
          everything else falls back to a download prompt. */}
      {viewer && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/70 flex items-center justify-center p-2 sm:p-4"
          onClick={handleCloseViewer}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[95dvh] flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-label="Attachment preview"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 sm:px-5 py-3">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-slate-800 truncate" title={viewer.attachment?.filename}>
                  {viewer.attachment?.filename || 'Attachment'}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {fmtBytes(viewer.attachment?.size || 0)}
                  {viewer.attachment?.mime_type && ` · ${viewer.attachment.mime_type}`}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {viewer.blobUrl && (
                  <a
                    href={viewer.blobUrl}
                    download={viewer.attachment?.filename}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 text-slate-700 rounded-lg text-xs font-medium hover:bg-slate-50"
                  >
                    <DownloadIcon size={12} />
                    Download
                  </a>
                )}
                <button
                  onClick={handleCloseViewer}
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-slate-50 flex items-center justify-center p-4">
              {viewer.status === 'loading' && (
                <div className="text-sm text-slate-500 flex flex-col items-center gap-2">
                  <RefreshCw size={20} className="animate-spin text-indigo-500" />
                  Loading attachment…
                </div>
              )}
              {viewer.status === 'error' && (
                <div className="text-sm text-red-600 flex flex-col items-center gap-2 max-w-md text-center">
                  <AlertTriangle size={20} />
                  <p className="font-medium">Couldn't load attachment</p>
                  <p className="text-xs text-slate-500">{viewer.error}</p>
                </div>
              )}
              {viewer.status === 'ready' && viewer.blobUrl && (() => {
                const name = (viewer.attachment?.filename || '').toLowerCase();
                const ext = name.split('.').pop();
                const mime = viewer.attachment?.mime_type || '';
                const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext) || mime.startsWith('image/');
                const isPdf = ext === 'pdf' || mime === 'application/pdf';
                if (isImage) {
                  return (
                    <img
                      src={viewer.blobUrl}
                      alt={viewer.attachment.filename}
                      className="max-w-full max-h-[78dvh] object-contain rounded shadow-sm bg-white"
                    />
                  );
                }
                if (isPdf) {
                  return (
                    <iframe
                      src={viewer.blobUrl}
                      title={viewer.attachment.filename}
                      className="w-full h-[78dvh] rounded border border-slate-200 bg-white"
                    />
                  );
                }
                return (
                  <div className="text-sm text-slate-600 flex flex-col items-center gap-3 max-w-md text-center">
                    <File size={28} className="text-slate-400" />
                    <p>This file type can't be previewed in the browser.</p>
                    <a
                      href={viewer.blobUrl}
                      download={viewer.attachment?.filename}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700"
                    >
                      <DownloadIcon size={12} />
                      Download to open
                    </a>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import PermissionDenied from '../../../components/common/PermissionDenied.jsx';
import EmailAutocomplete from '../../../components/common/EmailAutocomplete.jsx';
import { DEFAULT_PURCHASE_CC } from '../../../constants/emailDefaults.js';
import { Eye, Send, X, Mail, Paperclip, FileText, Loader2, MessageCircle, Download } from 'lucide-react';
import { formatDate, formatDateTime, formatCurrency } from '@/utils/formatters';

export default function SendPOEmail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canSendEmail } = usePermissions();

  const [po, setPo] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [emailLogs, setEmailLogs] = useState([]);
  const [logsPage, setLogsPage] = useState(1);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);

  // Preview state
  const [showPreview, setShowPreview] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState(null); // { subject, body_html, context_data }

  // Editable email fields
  const [editSubject, setEditSubject] = useState('');
  const [editTo, setEditTo] = useState('');
  const [editCc, setEditCc] = useState(DEFAULT_PURCHASE_CC);
  const [editBcc, setEditBcc] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editingBody, setEditingBody] = useState(false);
  const [pdfHtml, setPdfHtml] = useState('');
  const [showPdfPreview, setShowPdfPreview] = useState(false);

  // Fetch all data on mount
  useEffect(() => {
    const fetchAll = async () => {
      setIsLoadingData(true);
      try {
        const [poRes, templatesRes, logsRes] = await Promise.allSettled([
          apiClient.get(`/api/purchase/orders/${id}/`),
          apiClient.get('/api/communications/templates/'),
          apiClient.get(`/api/communications/email-logs/?po=${id}`),
        ]);
        if (poRes.status === 'fulfilled') setPo(poRes.value.data);
        else toast.error('Failed to load PO details');

        if (templatesRes.status === 'fulfilled') {
          const tplData = templatesRes.value.data?.results || templatesRes.value.data || [];
          setTemplates(tplData);
          // Default to the Purchase Order template on THIS page — it's a PO
          // send screen, so the PO template should win over any globally-
          // marked default (e.g. the RFQ/quote template). Fall back to the
          // flagged default, then the first template.
          const poTpl = tplData.find(t => /purchase\s*order/i.test(t.name || ''));
          const def = tplData.find(t => t.is_default);
          const chosen = poTpl || def || tplData[0];
          if (chosen) setSelectedTemplate(chosen.id);
        }
        if (logsRes.status === 'fulfilled') {
          setEmailLogs(logsRes.value.data?.results || logsRes.value.data || []);
        }
      } catch { toast.error('Failed to load page data'); }
      finally { setIsLoadingData(false); }
    };
    fetchAll();
  }, [id]);

  const refreshLogs = useCallback(async () => {
    try {
      const res = await apiClient.get(`/api/communications/email-logs/?po=${id}`);
      setEmailLogs(res.data?.results || res.data || []);
      setLogsPage(1);
    } catch {}
  }, [id]);

  // "Send Mail" button → load preview first, then show preview modal
  const handleSendMailClick = async () => {
    if (!selectedTemplate) { toast.error('Please select a template first'); return; }
    if (!po?.vendor) { toast.error('No vendor associated with this PO'); return; }

    setPreviewLoading(true);
    setShowPreview(true);
    setPreviewData(null);
    try {
      const res = await apiClient.post(`/api/purchase/orders/${id}/preview-email/`, {
        template_id: selectedTemplate,
      });
      const data = {
        subject: res.data.subject || '',
        body_html: res.data.body_html || res.data.pdf_html || '',
        context_data: res.data.context_data || {},
      };
      setPreviewData(data);
      setPdfHtml(res.data.pdf_html || '');
      // Populate editable fields
      setEditSubject(data.subject);
      setEditTo(data.context_data?.vendor_email || '');
      setEditCc(DEFAULT_PURCHASE_CC);
      setEditBcc('');
      setEditBody(data.body_html);
      setEditingBody(false);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
      setShowPreview(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Confirm send from preview
  // Confirm send — stays on preview until complete
  const handleConfirmSend = async () => {
    if (isSending) return;
    if (!editTo.trim()) { toast.error('Recipient email is required'); return; }
    if (!editSubject.trim()) { toast.error('Subject is required'); return; }
    setIsSending(true);
    setSendResult(null);
    try {
      const res = await apiClient.post(`/api/purchase/orders/${id}/send-email/`, {
        template_id: selectedTemplate,
        custom_subject: editSubject,
        custom_body: editBody,
        custom_to: editTo,
        custom_cc: editCc,
        custom_bcc: editBcc,
      });
      setSendResult(res.data);
      if (res.data.success) {
        toast.success(res.data.message || 'PO email sent successfully!');
      } else {
        toast.error(res.data.error || 'Failed to send email');
      }
      refreshLogs();
      // Close preview only after success
      setShowPreview(false);
    } catch (err) {
      // Keep preview open on failure so user can retry
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSending(false);
    }
  };

  const [pdfLoading, setPdfLoading] = useState(false);
  const [waProof, setWaProof] = useState(null);     // screenshot file
  const [waLogging, setWaLogging] = useState(false);

  // Log a WhatsApp send — upload the chat screenshot as proof. Records a
  // WhatsApp row in the history and marks the PO sent (like an email send).
  const handleLogWhatsApp = async () => {
    if (!waProof) { toast.error('Attach a WhatsApp screenshot first.'); return; }
    setWaLogging(true);
    try {
      const fd = new FormData();
      fd.append('screenshot', waProof);
      const res = await apiClient.post(`/api/purchase/orders/${id}/log-whatsapp/`, fd,
        { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(res.data.message || 'WhatsApp send logged.');
      setWaProof(null);
      refreshLogs();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setWaLogging(false);
    }
  };

  const waPhone = () => {
    const digits = String(po?.vendor_phone || '').replace(/\D/g, '');
    // Prefix the country code for a bare 10-digit Indian mobile.
    return digits ? (digits.length === 10 ? `91${digits}` : digits) : '';
  };
  const waMessage = () => {
    const lines = (po?.po_lines || [])
      .map((l, i) => `${i + 1}. ${l.item_name || l.product_name || l.service_catalogue_name || 'Item'} — ${Number(l.quantity_ordered || 0).toLocaleString('en-IN')} ${l.uom || ''}`)
      .join('\n');
    return `*Purchase Order ${po?.po_no}*\n` +
      `${po?.company_name || ''}\n\n` +
      `Vendor: ${po?.vendor_name || ''}\n` +
      `Date: ${po?.po_date ? formatDate(po.po_date) : '-'}\n` +
      (po?.total_order_value ? `Amount: ${formatCurrency(po.total_order_value)}\n` : '') +
      (lines ? `\nItems:\n${lines}\n` : '') +
      `\nPlease find the PO document attached. Kindly confirm.`;
  };

  // Fetch the real PO PDF as a Blob (same document the email attaches).
  const fetchPdfBlob = async () => {
    const res = await apiClient.get(`/api/purchase/orders/${id}/download-pdf/`, { responseType: 'blob' });
    return new Blob([res.data], { type: 'application/pdf' });
  };

  // Share the PO on WhatsApp WITH the PDF attached where the device allows it.
  // On a phone the native share sheet carries the file, so picking WhatsApp
  // attaches the PO PDF directly. On desktop (no file-share) we fall back to
  // wa.me with the text prefilled and download the PDF so it can be attached
  // by hand — WhatsApp share links cannot carry a file themselves.
  const handleWhatsApp = async () => {
    if (!po || pdfLoading) return;
    setPdfLoading(true);
    try {
      const msg = waMessage();
      let file = null;
      try {
        const blob = await fetchPdfBlob();
        file = new File([blob], `${po.po_no}.pdf`, { type: 'application/pdf' });
      } catch { /* fall through to text-only */ }

      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], text: msg, title: `Purchase Order ${po.po_no}` });
          return;
        } catch (e) {
          if (e?.name === 'AbortError') return;   // user cancelled the sheet
        }
      }
      // Desktop fallback: open WhatsApp with the text, and hand over the PDF.
      const url = `https://wa.me/${waPhone()}?text=${encodeURIComponent(msg)}`;
      window.open(url, '_blank', 'noopener');
      if (file) {
        const href = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = href; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 4000);
        toast('PO PDF downloaded — attach it in the WhatsApp chat.', { icon: '📎' });
      } else if (!waPhone()) {
        toast('No vendor phone on file — pick the contact in WhatsApp.', { icon: 'ℹ️' });
      }
    } finally {
      setPdfLoading(false);
    }
  };

  // Download the PO as a real PDF file to attach in WhatsApp (or keep).
  const handleDownloadPdf = async () => {
    if (pdfLoading) return;
    setPdfLoading(true);
    try {
      const blob = await fetchPdfBlob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href; a.download = `${po?.po_no || 'PO'}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 4000);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setPdfLoading(false);
    }
  };

  const vendorEmail = previewData?.context_data?.vendor_email || '';
  const canSend = selectedTemplate && po?.vendor;
  const alreadySent = emailLogs.some(l => l.email_sent || (l.status || '').toLowerCase().includes('sent'));

  if (isLoadingData) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center py-24">
          <div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin" />
        </div>
      </MainLayout>
    );
  }

  if (!canSendEmail('Purchase Order')) return <PermissionDenied />;

  // Client-side pagination for the Email History table.
  const LOGS_PER_PAGE = 10;
  const totalLogPages = Math.max(1, Math.ceil(emailLogs.length / LOGS_PER_PAGE));
  const safeLogsPage = Math.min(logsPage, totalLogPages);
  const pagedLogs = emailLogs.slice((safeLogsPage - 1) * LOGS_PER_PAGE, safeLogsPage * LOGS_PER_PAGE);

  return (
    <MainLayout>
      <PageHeader
        title={`Send PO: ${po?.po_no || ''}`}
        subtitle="Send the PO to the vendor by email, or share it on WhatsApp"
        breadcrumbs={[
          { label: 'Orders', href: '/purchase/orders' },
          { label: po?.po_no || `#${id}`, href: `/purchase/orders/${id}` },
          { label: 'Send Email' },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        {/* Vendor & PO Info */}
        <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <h3 className="text-sm font-semibold text-slate-800 mb-2">Vendor & PO Details</h3>
          {po && (
            <>
              <div className="flex items-center gap-3 px-3 py-3 rounded-lg bg-primary-50 border border-primary-200 mb-3">
                <Mail size={18} className="text-primary-600 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-800">{po.vendor_name || 'Unknown Vendor'}</p>
                  <p className="text-xs text-slate-500">Email will be sent to vendor's registered email address</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-slate-500">PO Number:</span> <span className="font-medium ml-1">{po.po_no}</span></div>
                <div><span className="text-slate-500">Status:</span> <StatusBadge status={po.status} /></div>
                <div><span className="text-slate-500">Date:</span> <span className="font-medium ml-1">{po.po_date ? formatDate(po.po_date) : '-'}</span></div>
                <div><span className="text-slate-500">Amount:</span> <span className="font-medium ml-1">{po.total_order_value ? formatCurrency(po.total_order_value) : '-'}</span></div>
                <div><span className="text-slate-500">Company:</span> <span className="font-medium ml-1">{po.company_name || '-'}</span></div>
                <div><span className="text-slate-500">Warehouse:</span> <span className="font-medium ml-1">{po.warehouse_name || '-'}</span></div>
              </div>
            </>
          )}

          {po?.po_lines?.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <h4 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Line Items ({po.po_lines.length})</h4>
              <table className="w-full text-xs border border-slate-200 rounded">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="text-left px-2 py-1 font-medium">#</th>
                    <th className="text-left px-2 py-1 font-medium">Product</th>
                    <th className="text-right px-2 py-1 font-medium">Qty</th>
                    <th className="text-left px-2 py-1 font-medium">UOM</th>
                    <th className="text-right px-2 py-1 font-medium">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {po.po_lines.map((line, idx) => (
                    <tr key={line.id || idx} className="border-t border-slate-100">
                      <td className="px-2 py-1 text-slate-500">{line.line_no || idx + 1}</td>
                      <td className="px-2 py-1 font-medium text-slate-800">
                        {/* Fall back to item_name (unified) so Machinery /
                            Service PO lines don't render as a dash. */}
                        {line.item_name || line.product_name || line.machinery_name || line.service_catalogue_name || '-'}
                        {line.item_type && line.item_type !== 'PRODUCT' && (
                          <span className={`ml-1.5 inline-block px-1.5 py-0.5 rounded text-[9px] font-medium align-middle ${
                            line.item_type === 'MACHINERY' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'
                          }`}>
                            {line.item_type === 'MACHINERY' ? 'Machinery' : 'Service'}
                          </span>
                        )}
                        {/* Specification (POLine.specification) — operator-typed
                            on the PO document. Kept separate from
                            POLine.description (which holds the auto-copied
                            PR remark and must not leak to vendors). */}
                        {line.specification && (
                          <div className="text-[10px] text-slate-500 font-normal mt-0.5 whitespace-pre-line">
                            {line.specification}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right font-medium">{Number(line.quantity_ordered || 0).toLocaleString()}</td>
                      <td className="px-2 py-1 text-slate-500">{line.uom || '-'}</td>
                      <td className="px-2 py-1 text-right">{formatCurrency(Number(line.unit_price || 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Template Selection & Send */}
        <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <h3 className="text-sm font-semibold text-slate-800 mb-2">Select Template & Send</h3>
          <div className="space-y-3">
            <CustomSelect
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate(e.target.value)}
              className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            >
              <option value="">Select a template...</option>
              {templates.map(tpl => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}{tpl.is_default ? ' (Default)' : ''}</option>
              ))}
            </CustomSelect>
            {templates.length === 0 && (
              <p className="text-xs text-amber-600">No templates found. <button onClick={() => navigate('/admin/email-templates/new')} className="underline">Create one</button></p>
            )}

            {/* Send / Resend button — opens preview first */}
            <button
              type="button"
              onClick={() => { setSendResult(null); handleSendMailClick(); }}
              disabled={!canSend || previewLoading}
              className={`w-full px-4 py-3 text-white rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2 ${
                alreadySent ? 'bg-amber-600 hover:bg-amber-700' : 'bg-primary-600 hover:bg-primary-700'
              }`}
            >
              {previewLoading ? (
                <><Loader2 size={16} className="animate-spin" /> Preparing Preview...</>
              ) : alreadySent ? (
                <><Send size={16} /> Resend Mail</>
              ) : (
                <><Send size={16} /> Send Mail</>
              )}
            </button>
            {alreadySent && (
              <p className="text-xs text-amber-600 text-center">
                Email was already sent for this PO. Click above to resend.
              </p>
            )}

            {/* WhatsApp share + PO PDF download — a PO can go by email OR
                WhatsApp. WhatsApp opens with the PO text prefilled; since it
                can't carry the file, Download PO PDF lets the user save and
                attach it in the chat. */}
            <div className="flex items-center gap-2 pt-1">
              <div className="flex-1 border-t border-slate-200" />
              <span className="text-[11px] text-slate-400 uppercase tracking-wide">or share</span>
              <div className="flex-1 border-t border-slate-200" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleWhatsApp}
                disabled={!po}
                className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold text-white bg-[#25D366] hover:bg-[#1ebe5a] disabled:opacity-50 transition"
              >
                <MessageCircle size={16} /> WhatsApp
              </button>
              <button
                type="button"
                onClick={handleDownloadPdf}
                disabled={!po || pdfLoading}
                className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition"
              >
                {pdfLoading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} PO PDF
              </button>
            </div>
            <p className="text-[11px] text-slate-400 text-center">
              On a phone, WhatsApp opens with the PO&nbsp;PDF attached. On desktop the PDF downloads to attach by hand.
            </p>

            {/* Proof of a WhatsApp send — upload the chat screenshot. Logs a
                WhatsApp row in the history below and marks the PO as sent. */}
            <div className="rounded-lg border border-dashed border-[#25D366]/50 bg-[#25D366]/5 p-2.5 space-y-2">
              <p className="text-[11px] font-semibold text-slate-600">Sent on WhatsApp? Log it with proof</p>
              <div className="flex items-center gap-2">
                <label className="flex-1 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-700 rounded-lg cursor-pointer hover:bg-slate-50 min-w-0">
                  <Paperclip size={13} className="shrink-0" />
                  <span className="truncate">{waProof ? waProof.name : 'Attach WhatsApp screenshot'}</span>
                  <input type="file" accept="image/*" className="hidden"
                    onChange={(e) => { setWaProof(e.target.files?.[0] || null); e.target.value = ''; }} />
                </label>
                {waProof && (
                  <button type="button" onClick={() => setWaProof(null)} className="text-slate-400 hover:text-red-500" title="Remove"><X size={14} /></button>
                )}
              </div>
              <button
                type="button"
                onClick={handleLogWhatsApp}
                disabled={!waProof || waLogging}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-[#25D366] hover:bg-[#1ebe5a] disabled:opacity-50 transition"
              >
                {waLogging ? <Loader2 size={14} className="animate-spin" /> : <MessageCircle size={14} />}
                Log WhatsApp send
              </button>
            </div>

            {!canSend && (
              <p className="text-xs text-slate-500">
                {!selectedTemplate ? 'Please select a template.' : 'No vendor associated with this PO.'}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Send Result */}
      {sendResult && (
        <div className={`rounded-lg border p-3 sm:p-4 mb-3 ${sendResult.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          <h3 className={`text-sm font-semibold mb-1 ${sendResult.success ? 'text-green-800' : 'text-red-800'}`}>
            {sendResult.success ? 'Email Sent Successfully' : 'Email Failed'}
          </h3>
          <p className={`text-sm ${sendResult.success ? 'text-green-700' : 'text-red-700'}`}>
            {sendResult.message || sendResult.error || '-'}
          </p>
        </div>
      )}

      {/* ====== FULL-SCREEN EMAIL PREVIEW MODAL ====== */}
      {showPreview && (
        <>
          <div className="fixed inset-0 bg-black/50 z-50" onClick={() => !isSending && setShowPreview(false)} />
          <div className="fixed inset-4 md:inset-6 lg:inset-10 bg-white rounded-2xl shadow-2xl z-50 flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="Email Preview">

            {/* Preview Header */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-blue-50 to-white flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center">
                  <Eye size={20} className="text-white" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-800">Email Preview</h2>
                  <p className="text-xs text-slate-500">Review the email before sending</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleConfirmSend}
                  disabled={isSending || previewLoading || !previewData}
                  className="flex items-center gap-2 px-5 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 disabled:opacity-50 transition"
                >
                  {isSending ? <><Loader2 size={16} className="animate-spin" /> Sending...</> : <><Send size={16} /> Confirm & Send</>}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPreview(false)}
                  disabled={isSending}
                  className="flex items-center gap-2 px-4 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition"
                >
                  <X size={16} /> Cancel
                </button>
              </div>
            </div>

            {/* Preview Content */}
            <div className="flex-1 overflow-y-auto">
              {previewLoading ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <Loader2 size={40} className="animate-spin text-blue-500 mb-3" />
                  <p className="text-slate-500 text-sm">Generating email preview...</p>
                </div>
              ) : previewData ? (
                <div className="p-3 sm:p-4 space-y-3">
                  {/* Editable Email Metadata */}
                  <div className="bg-slate-50 rounded-xl border border-slate-200 p-5 space-y-3">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 uppercase w-16 flex-shrink-0">To <span className="text-red-500">*</span></span>
                      <EmailAutocomplete type="email" multiple={false} value={editTo} onChange={setEditTo} placeholder="Recipient email" className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 uppercase w-16 flex-shrink-0">CC</span>
                      <EmailAutocomplete value={editCc} onChange={setEditCc} placeholder="CC emails (comma separated)" className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 uppercase w-16 flex-shrink-0">BCC</span>
                      <EmailAutocomplete value={editBcc} onChange={setEditBcc} placeholder="BCC emails (comma separated)" className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
                    </div>
                    <div className="border-t border-slate-200" />
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 uppercase w-16 flex-shrink-0">Subject <span className="text-red-500">*</span></span>
                      <input type="text" value={editSubject} onChange={e => setEditSubject(e.target.value)} placeholder="Email subject" className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
                    </div>
                    <div className="border-t border-slate-200" />
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 uppercase w-16 flex-shrink-0">From</span>
                      <p className="text-sm text-slate-600">{previewData.context_data?.from_email || previewData.context_data?.company_email || previewData.context_data?.company_name || 'System'}</p>
                    </div>
                    <div className="border-t border-slate-200" />
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 uppercase w-16 flex-shrink-0">Attach</span>
                      <button
                        type="button"
                        onClick={() => setShowPdfPreview(true)}
                        className="flex items-center gap-2 text-primary-600 hover:text-primary-800 hover:underline"
                      >
                        <Paperclip size={14} />
                        <span className="text-sm font-medium">{po?.po_no || 'PO'}.pdf</span>
                        <span className="text-xs text-slate-400">(Click to preview)</span>
                      </button>
                    </div>
                  </div>

                  {/* Document Details (read-only reference) */}
                  <div className="bg-blue-50 rounded-xl border border-blue-200 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <FileText size={14} className="text-blue-600" />
                      <span className="text-xs font-semibold text-blue-800 uppercase">Document Details</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      <div><span className="text-blue-600">PO:</span> <span className="font-medium text-blue-900">{po?.po_no}</span></div>
                      <div><span className="text-blue-600">Vendor:</span> <span className="font-medium text-blue-900">{po?.vendor_name || '-'}</span></div>
                      <div><span className="text-blue-600">Date:</span> <span className="font-medium text-blue-900">{previewData.context_data?.po_date || '-'}</span></div>
                      <div><span className="text-blue-600">Amount:</span> <span className="font-medium text-blue-900">{po?.total_order_value ? formatCurrency(po.total_order_value) : '-'}</span></div>
                    </div>
                  </div>

                  {/* Email Body — rendered preview with edit toggle */}
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
                    <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 rounded-t-xl flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-500 uppercase">Email Body</span>
                      <button
                        type="button"
                        onClick={() => setEditingBody(!editingBody)}
                        className="text-xs font-medium text-primary-600 hover:text-primary-800 hover:underline"
                      >
                        {editingBody ? 'Preview' : 'Edit HTML'}
                      </button>
                    </div>
                    <div className="p-3 sm:p-4">
                      {editingBody ? (
                        <textarea
                          value={editBody}
                          onChange={e => setEditBody(e.target.value)}
                          rows={20}
                          className="w-full px-4 py-3 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-primary-500 resize-y"
                          placeholder="Email body (HTML)"
                        />
                      ) : (
                        <div
                          className="prose prose-sm max-w-none"
                          dangerouslySetInnerHTML={{ __html: editBody }}
                        />
                      )}
                    </div>
                  </div>

                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                  <Mail size={48} className="mb-3 opacity-30" />
                  <p>Failed to load preview</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* PDF Attachment Preview Modal */}
      {showPdfPreview && pdfHtml && (
        <>
          <div className="fixed inset-0 bg-black/50 z-[60]" onClick={() => setShowPdfPreview(false)} />
          <div className="fixed inset-4 md:inset-8 lg:inset-12 bg-white rounded-2xl shadow-2xl z-[60] flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="PDF Attachment Preview">
            <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-slate-200 bg-slate-50 flex-shrink-0">
              <div className="flex items-center gap-2">
                <FileText size={18} className="text-red-600" />
                <span className="font-semibold text-slate-800">{po?.po_no || 'PO'}.pdf — Attachment Preview</span>
              </div>
              <button onClick={() => setShowPdfPreview(false)} className="flex items-center gap-1 px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-100">
                <X size={14} /> Close
              </button>
            </div>
            <div className="flex-1 overflow-auto bg-slate-100 p-4">
              <div className="max-w-[800px] mx-auto bg-white shadow-lg rounded-lg overflow-hidden">
                <iframe
                  srcDoc={pdfHtml}
                  title="PDF Preview"
                  className="w-full border-0"
                  style={{ minHeight: '80vh' }}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {/* Email History */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-800">Email History</h3>
          <button type="button" onClick={refreshLogs} className="text-xs text-primary-600 hover:text-primary-700 font-medium">Refresh</button>
        </div>
        {emailLogs.length === 0 ? (
          <p className="text-sm text-slate-500 py-4 text-center">No emails sent for this PO yet</p>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Vendor</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Channel</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Status</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Sent At</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pagedLogs.map((log, idx) => {
                  const logStatus = log.status || (log.email_sent ? 'Email Sent' : 'Failed');
                  const isWhatsApp = /whatsapp/i.test(log.status || '') || /whatsapp/i.test(log.subject || '');
                  return (
                    <tr key={log.id || idx} className="hover:bg-primary-50/40 transition-colors">
                      <td className="py-2 px-3 font-medium text-slate-800">{log.vendor_name || log.vendor_email || po?.vendor_name || '-'}</td>
                      <td className="py-2 px-3">
                        {isWhatsApp ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border border-[#25D366]/40 bg-[#25D366]/10 text-[#128C3E]"><MessageCircle size={11} /> WhatsApp</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border border-primary-200 bg-primary-50 text-primary-700"><Mail size={11} /> Email</span>
                        )}
                      </td>
                      <td className="py-2 px-3"><StatusBadge status={logStatus} /></td>
                      <td className="py-2 px-3 text-slate-600">{log.sent_at || log.created_at ? formatDateTime(log.sent_at || log.created_at) : '-'}</td>
                      <td className="py-2 px-3 text-slate-500 text-xs">{log.error || log.error_message || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totalLogPages > 1 && (
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100 text-xs text-slate-500">
              <span>
                Showing {(safeLogsPage - 1) * LOGS_PER_PAGE + 1}–{Math.min(safeLogsPage * LOGS_PER_PAGE, emailLogs.length)} of {emailLogs.length}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setLogsPage((p) => Math.max(1, p - 1))}
                  disabled={safeLogsPage <= 1}
                  className="px-2.5 py-1 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Prev
                </button>
                <span className="px-1">Page {safeLogsPage} of {totalLogPages}</span>
                <button
                  type="button"
                  onClick={() => setLogsPage((p) => Math.min(totalLogPages, p + 1))}
                  disabled={safeLogsPage >= totalLogPages}
                  className="px-2.5 py-1 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
          </>
        )}
      </div>
    </MainLayout>
  );
}

import CustomSelect from '@/components/ui/CustomSelect';
import { useState, useEffect } from 'react';
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
import { Eye, Send, X, Mail, Paperclip, FileText, Loader2, CheckCircle } from 'lucide-react';
import { formatDate, formatCurrency } from '@/utils/formatters';

export default function SendQuoteEmail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canSendEmail } = usePermissions();

  const [quote, setQuote] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);

  const [showPreview, setShowPreview] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState(null);

  const [editSubject, setEditSubject] = useState('');
  const [editTo, setEditTo] = useState('');
  const [editCc, setEditCc] = useState('');
  const [editBcc, setEditBcc] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editingBody, setEditingBody] = useState(false);
  const [pdfHtml, setPdfHtml] = useState('');
  const [showPdfPreview, setShowPdfPreview] = useState(false);

  useEffect(() => {
    const fetchAll = async () => {
      setIsLoadingData(true);
      try {
        const [qRes, tRes] = await Promise.allSettled([
          apiClient.get(`/api/sales/quotations/${id}/`),
          apiClient.get('/api/communications/templates/'),
        ]);
        if (qRes.status === 'fulfilled') setQuote(qRes.value.data);
        else toast.error('Failed to load quote.');
        if (tRes.status === 'fulfilled') {
          const tpls = tRes.value.data?.results || tRes.value.data || [];
          setTemplates(tpls);
          // Prefer the quote template by name, else default, else first.
          const quoteTpl = tpls.find(t => /quot/i.test(t.name));
          setSelectedTemplate((quoteTpl || tpls.find(t => t.is_default) || tpls[0])?.id || '');
        }
      } catch { toast.error('Failed to load page data.'); }
      finally { setIsLoadingData(false); }
    };
    fetchAll();
  }, [id]);

  const openPreview = async () => {
    if (!selectedTemplate) { toast.error('Select a template first.'); return; }
    setPreviewLoading(true);
    setShowPreview(true);
    setPreviewData(null);
    try {
      const res = await apiClient.post(`/api/sales/quotations/${id}/preview-email/`, { template_id: selectedTemplate });
      const data = {
        subject: res.data.subject || '',
        body_html: res.data.body_html || res.data.pdf_html || '',
        context_data: res.data.context_data || {},
      };
      setPreviewData(data);
      setPdfHtml(res.data.pdf_html || '');
      setEditSubject(data.subject);
      setEditTo(data.context_data?.customer_email || '');
      setEditCc(''); setEditBcc('');
      setEditBody(data.body_html);
      setEditingBody(false);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
      setShowPreview(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  const confirmSend = async () => {
    if (isSending) return;
    if (!editTo.trim()) { toast.error('Recipient email is required.'); return; }
    if (!editSubject.trim()) { toast.error('Subject is required.'); return; }
    setIsSending(true);
    setSendResult(null);
    try {
      const res = await apiClient.post(`/api/sales/quotations/${id}/send-email/`, {
        template_id: selectedTemplate,
        custom_subject: editSubject,
        custom_body: editBody,
        custom_to: editTo,
        custom_cc: editCc,
        custom_bcc: editBcc,
      });
      setSendResult(res.data);
      if (res.data.success) {
        toast.success(res.data.message || 'Quote emailed.');
        setShowPreview(false);
      } else {
        toast.error(res.data.error || 'Failed to send.');
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSending(false);
    }
  };

  if (isLoadingData) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center py-24">
          <div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin" />
        </div>
      </MainLayout>
    );
  }

  if (!canSendEmail('Sales Quote')) return <PermissionDenied />;

  return (
    <MainLayout>
      <PageHeader
        title={`Send Quote Email: ${quote?.quote_no || ''}`}
        subtitle="Select a template and email the quotation to the customer"
        breadcrumbs={[
          { label: 'Sales', href: '/sales/quotes' },
          { label: 'Quotes', href: '/sales/quotes' },
          { label: quote?.quote_no || `#${id}`, href: `/sales/quotes/${id}` },
          { label: 'Send Email' },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mb-4 sm:mb-6">
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-800 mb-4">Customer & Quote</h3>
          {quote && (
            <>
              <div className="flex items-center gap-3 px-3 py-3 rounded-lg bg-primary-50 border border-primary-200 mb-4">
                <Mail size={18} className="text-primary-600 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-800">{quote.customer_name || 'Customer'}</p>
                  <p className="text-xs text-slate-500">The quote PDF will be emailed to the customer's contact email.</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-slate-500">Quote No:</span> <span className="font-medium ml-1">{quote.quote_no}</span></div>
                <div><span className="text-slate-500">Status:</span> <StatusBadge status={quote.status} /></div>
                <div><span className="text-slate-500">Date:</span> <span className="font-medium ml-1">{quote.quote_date ? formatDate(quote.quote_date) : '-'}</span></div>
                <div><span className="text-slate-500">Valid Until:</span> <span className="font-medium ml-1">{quote.valid_until ? formatDate(quote.valid_until) : '-'}</span></div>
                <div><span className="text-slate-500">Company:</span> <span className="font-medium ml-1">{quote.company_name || '-'}</span></div>
              </div>
            </>
          )}
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-800 mb-4">Select Template & Send</h3>
          <div className="space-y-4">
            <CustomSelect value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
              <option value="">Select a template...</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.is_default ? ' (Default)' : ''}</option>)}
            </CustomSelect>
            {templates.length === 0 && (
              <p className="text-xs text-amber-600">No templates found. <button onClick={() => navigate('/admin/email-templates/new')} className="underline">Create one</button></p>
            )}
            <button type="button" onClick={openPreview} disabled={!selectedTemplate || previewLoading || sendResult?.success}
              className={`w-full px-4 py-3 text-white rounded-lg text-sm font-semibold disabled:opacity-50 transition flex items-center justify-center gap-2 ${sendResult?.success ? 'bg-green-600' : 'bg-primary-600 hover:bg-primary-700'}`}>
              {previewLoading ? <><Loader2 size={16} className="animate-spin" /> Preparing…</>
                : sendResult?.success ? <><CheckCircle size={16} /> Email Sent</>
                : <><Send size={16} /> Send Mail</>}
            </button>
          </div>
        </div>
      </div>

      {sendResult && (
        <div className={`rounded-lg border p-5 mb-4 ${sendResult.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          <p className={`text-sm ${sendResult.success ? 'text-green-700' : 'text-red-700'}`}>{sendResult.message || sendResult.error || '-'}</p>
        </div>
      )}

      {/* Preview modal */}
      {showPreview && (
        <>
          <div className="fixed inset-0 bg-black/50 z-50" onClick={() => !isSending && setShowPreview(false)} />
          <div className="fixed inset-4 md:inset-6 lg:inset-10 bg-white rounded-2xl shadow-2xl z-50 flex flex-col overflow-hidden" role="dialog" aria-modal="true">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-blue-50 to-white shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center"><Eye size={20} className="text-white" /></div>
                <div><h2 className="text-lg font-bold text-slate-800">Email Preview</h2><p className="text-xs text-slate-500">Review before sending</p></div>
              </div>
              <div className="flex items-center gap-3">
                <button type="button" onClick={confirmSend} disabled={isSending || previewLoading || !previewData}
                  className="flex items-center gap-2 px-5 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 disabled:opacity-50">
                  {isSending ? <><Loader2 size={16} className="animate-spin" /> Sending…</> : <><Send size={16} /> Confirm & Send</>}
                </button>
                <button type="button" onClick={() => setShowPreview(false)} disabled={isSending}
                  className="flex items-center gap-2 px-4 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"><X size={16} /> Cancel</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {previewLoading ? (
                <div className="flex flex-col items-center justify-center py-20"><Loader2 size={40} className="animate-spin text-blue-500 mb-3" /><p className="text-slate-500 text-sm">Generating preview…</p></div>
              ) : previewData ? (
                <div className="p-4 sm:p-6 space-y-4">
                  <div className="bg-slate-50 rounded-xl border border-slate-200 p-5 space-y-3">
                    <div className="flex items-center gap-3"><span className="text-xs font-semibold text-slate-500 uppercase w-16 shrink-0">To <span className="text-red-500">*</span></span>
                      <EmailAutocomplete type="email" multiple={false} value={editTo} onChange={setEditTo} placeholder="Recipient email" className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm" /></div>
                    <div className="flex items-center gap-3"><span className="text-xs font-semibold text-slate-500 uppercase w-16 shrink-0">CC</span>
                      <EmailAutocomplete value={editCc} onChange={setEditCc} placeholder="Comma separated" className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm" /></div>
                    <div className="flex items-center gap-3"><span className="text-xs font-semibold text-slate-500 uppercase w-16 shrink-0">BCC</span>
                      <EmailAutocomplete value={editBcc} onChange={setEditBcc} placeholder="Comma separated" className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm" /></div>
                    <div className="border-t border-slate-200" />
                    <div className="flex items-center gap-3"><span className="text-xs font-semibold text-slate-500 uppercase w-16 shrink-0">Subject <span className="text-red-500">*</span></span>
                      <input type="text" value={editSubject} onChange={e => setEditSubject(e.target.value)} className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-medium" /></div>
                    <div className="border-t border-slate-200" />
                    <div className="flex items-center gap-3"><span className="text-xs font-semibold text-slate-500 uppercase w-16 shrink-0">From</span>
                      <p className="text-sm text-slate-600">{previewData.context_data?.from_email || previewData.context_data?.company_email || quote?.company_name || 'System'}</p></div>
                    <div className="border-t border-slate-200" />
                    <div className="flex items-center gap-3"><span className="text-xs font-semibold text-slate-500 uppercase w-16 shrink-0">Attach</span>
                      <button type="button" onClick={() => setShowPdfPreview(true)} className="flex items-center gap-2 text-primary-600 hover:underline">
                        <Paperclip size={14} /><span className="text-sm font-medium">{quote?.quote_no || 'Quote'}.pdf</span><span className="text-xs text-slate-400">(preview)</span></button></div>
                  </div>
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
                    <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 rounded-t-xl flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-500 uppercase">Email Body</span>
                      <button type="button" onClick={() => setEditingBody(!editingBody)} className="text-xs font-medium text-primary-600 hover:underline">{editingBody ? 'Preview' : 'Edit HTML'}</button>
                    </div>
                    <div className="p-4 sm:p-6">
                      {editingBody
                        ? <textarea value={editBody} onChange={e => setEditBody(e.target.value)} rows={20} className="w-full px-4 py-3 border border-slate-300 rounded-lg text-sm font-mono resize-y" />
                        : <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: editBody }} />}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400"><Mail size={48} className="mb-3 opacity-30" /><p>Failed to load preview</p></div>
              )}
            </div>
          </div>
        </>
      )}

      {/* PDF preview */}
      {showPdfPreview && pdfHtml && (
        <>
          <div className="fixed inset-0 bg-black/50 z-[60]" onClick={() => setShowPdfPreview(false)} />
          <div className="fixed inset-4 md:inset-8 lg:inset-12 bg-white rounded-2xl shadow-2xl z-[60] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
              <div className="flex items-center gap-2"><FileText size={18} className="text-red-600" /><span className="font-semibold text-slate-800">{quote?.quote_no || 'Quote'}.pdf — Attachment</span></div>
              <button onClick={() => setShowPdfPreview(false)} className="flex items-center gap-1 px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-100"><X size={14} /> Close</button>
            </div>
            <div className="flex-1 overflow-auto bg-slate-100 p-4">
              <div className="max-w-[800px] mx-auto bg-white shadow-lg rounded-lg overflow-hidden">
                <iframe srcDoc={pdfHtml} title="PDF Preview" className="w-full border-0" style={{ minHeight: '80vh' }} />
              </div>
            </div>
          </div>
        </>
      )}
    </MainLayout>
  );
}

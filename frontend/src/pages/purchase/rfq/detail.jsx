import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Edit3, Save, X, Mail, Check, FileText, Trash2, Printer } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { confirm } from '@/components/common/confirm';
import { formatDate as fmtDate, formatDateTime as fmtDateTime } from '@/utils/formatters';
import { getApiErrorMessage } from '@/utils/formHelpers';

export default function RFQDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, canDelete, canSendEmail } = usePermissions();
  const { isHidden, isReadOnly } = useFieldPermissions('RFQ');
  const { raw: vendors } = useLookup('/api/vendors/');
  const { raw: templates } = useLookup('/api/communications/templates/');

  const [rfq, setRfq] = useState(null);
  const [linkedPRs, setLinkedPRs] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editData, setEditData] = useState({});
  const [selectedVendors, setSelectedVendors] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [vendorsSaved, setVendorsSaved] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [emailLogs, setEmailLogs] = useState([]);

  useEffect(() => { fetchRFQ(); }, [id]);

  const fetchRFQ = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`/api/purchase/rfq/${id}/`);
      const rfqData = res.data;
      setRfq(rfqData);
      setEditData(rfqData);

      // Fetch linked PR details with line items
      const prIds = rfqData.linked_prs || [];
      if (prIds.length > 0) {
        const prResults = await Promise.all(
          prIds.map(prId => apiClient.get(`/api/purchase/requests/${prId}/`).catch(() => null))
        );
        // Drop skip-routed lines once at load — every render spot on this
        // page (per-PR tables, aggregate list, counts) must show only the
        // lines this RFQ actually covers.
        setLinkedPRs(prResults.filter(r => r !== null).map(r => ({
          ...r.data,
          lines: (r.data.lines || []).filter(l => !l.allow_rfq_skip),
        })));
      }

      try {
        const logRes = await apiClient.get(`/api/communications/email-logs/?rfq=${id}`);
        setEmailLogs(logRes.data?.results || logRes.data || []);
      } catch (e) { /* ignore */ }
    } catch (err) { if (err.response?.status !== 404) toast.error(getApiErrorMessage(err)); }
    finally { setIsLoading(false); }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: 'Are you sure you want to delete this RFQ? This action cannot be undone.', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/rfq/${id}/`);
      toast.success('RFQ deleted successfully');
      navigate('/purchase/rfq');
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  const handleEdit = () => { setIsEditing(true); setEditData({ ...rfq }); setVendorsSaved(false); };
  const handleCancelEdit = () => { setIsEditing(false); setEditData({ ...rfq }); setSelectedVendors([]); setVendorsSaved(false); };
  const handleChange = (e) => { const { name, value, type, checked } = e.target; setEditData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value })); };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Mirror the create-page payload — include the Additional Information
      // textareas (skip_rfq_justification, notes) so they're editable in
      // addition to the original three fields.
      const payload = {
        rfq_mode: editData.rfq_mode,
        rfq_status: editData.rfq_status,
        quote_count_expected: editData.quote_count_expected,
        skip_rfq_justification: editData.skip_rfq_justification || '',
        notes: editData.notes || '',
      };
      const res = await apiClient.patch(`/api/purchase/rfq/${id}/`, payload);
      setRfq(res.data); setEditData(res.data);

      setIsEditing(false);
      toast.success('RFQ saved');
    } catch (err) { toast.error(getApiErrorMessage(err)); }
    finally { setIsSaving(false); }
  };

  const toggleVendor = (vid) => { setSelectedVendors(prev => prev.includes(vid) ? prev.filter(v => v !== vid) : [...prev, vid]); setVendorsSaved(false); };
  const handleSaveVendors = () => { if (!selectedVendors.length) { toast.error('Select vendors'); return; } if (!selectedTemplate) { toast.error('Select template'); return; } setVendorsSaved(true); toast.success('Ready to send'); };
  const handleSendEmail = async () => {
    if (!vendorsSaved) return;
    if (!(await confirm({ message: `Send to ${selectedVendors.length} vendor(s)?` }))) return;
    setIsSending(true);
    try {
      const res = await apiClient.post('/api/communications/rfq-emails/send-emails/', { rfq_id: id, template_id: selectedTemplate, vendor_ids: selectedVendors });
      const results = res.data?.results || [];
      toast.success(`${results.filter(r => r.success).length} email(s) sent!`);
      setSelectedVendors([]); setVendorsSaved(false); fetchRFQ();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
    finally { setIsSending(false); }
  };

  const formatDate = (d) => d ? fmtDate(d) : '-';
  const formatDateTime = (d) => d ? fmtDateTime(d) : '-';
  const inputClass = "w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500";
  const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;
  const readonlyClass = "w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-600";

  if (isLoading) return <MainLayout><div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin" /></div></MainLayout>;
  if (!rfq) return <MainLayout><div className="text-center py-12"><FileText className="mx-auto text-slate-300 mb-4" size={48} /><p className="text-slate-500">RFQ not found</p></div></MainLayout>;

  return (
    <MainLayout>
      <div className="max-w-6xl space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/rfq'))} className="p-1 text-slate-500 hover:text-slate-700"><ArrowLeft size={20} /></button>
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900">{rfq.rfq_no}</h1>
            </div>
            <div className="flex items-center gap-4 ml-8">
              <StatusBadge status={rfq.rfq_status} />
              <span className="text-sm text-slate-500">Created {formatDate(rfq.creation_date)}</span>
              {(rfq.linked_pr_numbers || []).length > 0 && (
                <span className="text-sm text-slate-500">
                  PR:{' '}
                  {rfq.linked_pr_numbers.map((prNo, i) => {
                    const prId = (rfq.linked_prs || [])[i];
                    return (
                      <span key={prNo}>
                        {i > 0 && ', '}
                        {prId ? (
                          <button onClick={() => navigate(`/purchase/requests/${prId}`)} className="text-blue-600 hover:text-blue-800 hover:underline font-medium">{prNo}</button>
                        ) : prNo}
                      </span>
                    );
                  })}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 ml-8 sm:ml-0">
            {!isEditing && <>
              {canEdit('RFQ') && (
                <button onClick={handleEdit} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-lg text-xs sm:text-sm font-medium hover:bg-slate-50 whitespace-nowrap"><Edit3 size={14} /> Edit</button>
              )}
              <button onClick={() => navigate(`/purchase/rfq/${id}/document`)} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-lg text-xs sm:text-sm font-medium hover:bg-slate-50 whitespace-nowrap"><Printer size={14} /> RFQ Document</button>
              {canDelete('RFQ') && (
                <button onClick={handleDelete} className="flex items-center gap-1.5 px-3 py-1.5 border border-red-300 text-red-600 rounded-lg text-xs sm:text-sm font-medium hover:bg-red-50 whitespace-nowrap"><Trash2 size={14} /> Delete</button>
              )}
              {emailLogs.length > 0 ? (
                <>
                  <button
                    onClick={() => { if (!rfq?.is_evaluated) navigate(`/purchase/quotes/new?rfq=${id}`); }}
                    disabled={!!rfq?.is_evaluated}
                    title={rfq?.is_evaluated
                      ? 'Quotes for this RFQ have already been evaluated — new responses are locked'
                      : 'Create Quote Response'}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium whitespace-nowrap transition ${
                      rfq?.is_evaluated
                        ? 'bg-slate-200 text-slate-500 cursor-not-allowed'
                        : 'bg-green-600 text-white hover:bg-green-700'
                    }`}
                  >
                    <FileText size={14} /> Quote Response
                  </button>
                  <button disabled className="flex items-center gap-1.5 px-3 py-1.5 bg-green-100 text-green-700 rounded-lg text-xs sm:text-sm font-medium cursor-not-allowed whitespace-nowrap"><Mail size={14} /> Email Sent</button>
                </>
              ) : (
                canSendEmail('RFQ') && (
                  <button onClick={() => navigate(`/purchase/rfq/${id}/send-email`)} className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 text-white rounded-lg text-xs sm:text-sm font-medium hover:bg-primary-700 whitespace-nowrap"><Mail size={14} /> Send Email</button>
                )
              )}
            </>}
            {isEditing && (
              <>
                <button onClick={handleSave} disabled={isSaving} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"><Save size={16} /> {isSaving ? 'Saving...' : 'Save'}</button>
                <button onClick={handleCancelEdit} className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50"><X size={16} /> Cancel</button>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
          <div className="lg:col-span-2 space-y-4 sm:space-y-6">
            {/* RFQ Details */}
            <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
              <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">RFQ Details</h3>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                {!isHidden('rfq_no') && (
                <div><label className="block text-sm font-medium text-slate-600 mb-1">RFQ Number</label><input type="text" value={rfq.rfq_no} disabled className={readonlyClass} /></div>
                )}
                {!isHidden('rfq_mode') && (
                <div><label className="block text-sm font-medium text-slate-600 mb-1">Mode</label>
                  {isEditing ? <CustomSelect name="rfq_mode" value={editData.rfq_mode || ''} onChange={handleChange} disabled={isReadOnly('rfq_mode')} className={isReadOnly('rfq_mode') ? lockedInputClass : inputClass}><option value="EMAIL">Email</option><option value="PORTAL">Portal</option><option value="PHONE">Phone</option></CustomSelect> : <input type="text" value={rfq.rfq_mode_display || rfq.rfq_mode} disabled className={readonlyClass} />}
                </div>
                )}
                {!isHidden('rfq_status') && (
                <div><label className="block text-sm font-medium text-slate-600 mb-1">Status</label>
                  {isEditing ? <CustomSelect name="rfq_status" value={editData.rfq_status || ''} onChange={handleChange} disabled={isReadOnly('rfq_status')} className={isReadOnly('rfq_status') ? lockedInputClass : inputClass}><option value="OPEN">Open</option><option value="CLOSED">Closed</option><option value="CANCELLED">Cancelled</option></CustomSelect> : <input type="text" value={rfq.rfq_status_display || rfq.rfq_status} disabled className={readonlyClass} />}
                </div>
                )}
                {!isHidden('quote_count_expected') && (
                <div><label className="block text-sm font-medium text-slate-600 mb-1">Expected Quotes</label>
                  {isEditing ? <input type="number" name="quote_count_expected" value={editData.quote_count_expected || ''} onChange={handleChange} disabled={isReadOnly('quote_count_expected')} className={isReadOnly('quote_count_expected') ? lockedInputClass : inputClass} min="1" /> : <input type="text" value={rfq.quote_count_expected} disabled className={readonlyClass} />}
                </div>
                )}
                {!isHidden('linked_prs') && (
                <div><label className="block text-sm font-medium text-slate-600 mb-1">Linked PRs</label><input type="text" value={(rfq.linked_pr_numbers || []).join(', ') || '-'} disabled className={readonlyClass} /></div>
                )}
                <div><label className="block text-sm font-medium text-slate-600 mb-1">Created</label><input type="text" value={formatDate(rfq.creation_date)} disabled className={readonlyClass} /></div>
              </div>
            </div>

            {/* Additional Information — matches the Create page section of the
                same name. In view mode shows read-only text (or a dash); in
                edit mode renders textareas matching the create form. */}
            <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
              <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Additional Information</h3>
              <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">Skip RFQ Justification</label>
                  {isEditing ? (
                    <textarea
                      name="skip_rfq_justification"
                      value={editData.skip_rfq_justification || ''}
                      onChange={handleChange}
                      rows={3}
                      placeholder="Reason for skipping RFQ process..."
                      className={inputClass}
                    />
                  ) : (
                    <div className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-slate-50 text-slate-700 min-h-[60px] whitespace-pre-wrap">
                      {rfq.skip_rfq_justification || '-'}
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">Notes</label>
                  {isEditing ? (
                    <textarea
                      name="notes"
                      value={editData.notes || ''}
                      onChange={handleChange}
                      rows={3}
                      placeholder="Additional notes..."
                      className={inputClass}
                    />
                  ) : (
                    <div className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-slate-50 text-slate-700 min-h-[60px] whitespace-pre-wrap">
                      {rfq.notes || '-'}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Linked Purchase Requests & Line Items */}
            {linkedPRs.map(pr => (
              <div key={pr.id} className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
                <div className="flex items-center gap-3 mb-4 pb-2 border-b">
                  <h3 className="text-base sm:text-lg font-semibold text-slate-800">
                    Purchase Request:{' '}
                    <button onClick={() => navigate(`/purchase/requests/${pr.id}`)} className="text-primary-600 hover:text-primary-800 hover:underline">{pr.pr_no}</button>
                  </h3>
                  <StatusBadge status={pr.approval_status} />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  <div><p className="text-xs text-slate-500">Warehouse</p><p className="text-sm font-medium">{pr.warehouse_name || '-'}</p></div>
                  <div><p className="text-xs text-slate-500">Priority</p><p className="text-sm font-medium">{pr.priority_display || pr.priority || '-'}</p></div>
                  <div><p className="text-xs text-slate-500">Requirement Type</p><p className="text-sm font-medium">{pr.requirement_type_display || pr.requirement_type || '-'}</p></div>
                  <div><p className="text-xs text-slate-500">Required By</p><p className="text-sm font-medium">{pr.required_by_date ? formatDate(pr.required_by_date) : '-'}</p></div>
                </div>
                {pr.justification && <div className="mb-4"><p className="text-xs text-slate-500 mb-1">Justification</p><p className="text-sm text-slate-700 bg-slate-50 p-2 rounded">{pr.justification}</p></div>}
                {pr.notes && <div className="mb-4"><p className="text-xs text-slate-500 mb-1">Notes</p><p className="text-sm text-slate-700 bg-slate-50 p-2 rounded">{pr.notes}</p></div>}

                {/* Line Items Table */}
                {pr.lines && pr.lines.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-slate-700 mb-2">Line Items ({pr.lines.length})</h4>
                    {/* Mobile-stacked linked PR lines (read-only). */}
                    <div className="sm:hidden space-y-2 mb-3">
                      {pr.lines.map((line, idx) => {
                        const displayName = line.product_name || line.machinery_name || line.service_catalogue_name || '-';
                        return (
                          <div key={`m-${line.id || idx}`} className="border border-slate-200 rounded bg-white p-2 text-xs">
                            <div className="flex items-start justify-between gap-2 mb-1">
                              <div className="min-w-0">
                                <p className="text-[10px] uppercase text-slate-500">Line #{line.line_no || idx + 1}</p>
                                <p className="font-semibold text-slate-800 break-words">{displayName}</p>
                                {line.product_code && <p className="text-[10px] text-slate-500">{line.product_code}</p>}
                              </div>
                              <StatusBadge status={line.status} />
                            </div>
                            <div className="grid grid-cols-2 gap-1 text-[10px]">
                              <div><span className="text-slate-500">Qty:</span> <span className="text-slate-700 font-medium">{Number(line.quantity_requested || 0).toLocaleString()} {line.uom || ''}</span></div>
                              <div><span className="text-slate-500">Purpose:</span> <span className="text-slate-700">{line.purpose || '-'}</span></div>
                              {line.description_override && <div className="col-span-2"><span className="text-slate-500">Desc:</span> <span className="text-slate-700 break-words">{line.description_override}</span></div>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="hidden sm:block overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                            <th className="text-left px-3 py-2 font-medium text-slate-600 w-10">#</th>
                            <th className="text-left px-3 py-2 font-medium text-slate-600">Product</th>
                            <th className="text-left px-3 py-2 font-medium text-slate-600">SKU</th>
                            <th className="text-left px-3 py-2 font-medium text-slate-600">Description</th>
                            <th className="text-right px-3 py-2 font-medium text-slate-600">Quantity</th>
                            <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                            <th className="text-left px-3 py-2 font-medium text-slate-600">Purpose</th>
                            <th className="text-left px-3 py-2 font-medium text-slate-600">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pr.lines.map((line, idx) => {
                            // PR lines can be backed by Product / Machinery /
                            // ServiceCatalogue — fall back so Services and
                            // Machinery lines don't render as a blank dash.
                            const displayName = line.product_name || line.machinery_name || line.service_catalogue_name || '-';
                            return (
                            <tr key={line.id || idx} className="border-b border-slate-100 hover:bg-primary-50/40 transition-colors">
                              <td className="px-3 py-2.5 text-slate-500">{line.line_no || idx + 1}</td>
                              <td className="px-3 py-2.5 font-medium text-slate-800">{displayName}</td>
                              <td className="px-3 py-2.5 text-slate-500">{line.product_code || '-'}</td>
                              <td className="px-3 py-2.5 text-slate-600">{line.description_override || '-'}</td>
                              <td className="px-3 py-2.5 text-right font-semibold">{Number(line.quantity_requested || 0).toLocaleString()}</td>
                              <td className="px-3 py-2.5 text-slate-500">{line.uom || '-'}</td>
                              <td className="px-3 py-2.5 text-slate-500">{line.purpose || '-'}</td>
                              <td className="px-3 py-2.5"><StatusBadge status={line.status} /></td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {linkedPRs.length === 0 && (
              <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6 text-center text-slate-400">
                No linked Purchase Requests found
              </div>
            )}

          </div>

          {/* Sidebar */}
          <div className="space-y-3 sm:space-y-6">
            {/* Summary + Products Required share a row on mobile; back to a
                single column in the narrow desktop sidebar. */}
            <div className="grid grid-cols-2 lg:grid-cols-1 gap-3 sm:gap-6">
            <div className={`bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5 ${linkedPRs.some(pr => pr.lines?.length > 0) ? '' : 'col-span-2 lg:col-span-1'}`}>
              <h4 className="text-sm font-semibold text-slate-700 mb-3">Summary</h4>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between"><span className="text-slate-500">Status</span><StatusBadge status={rfq.rfq_status} /></div>
                <div className="flex justify-between"><span className="text-slate-500">Mode</span><span className="font-medium">{rfq.rfq_mode_display || rfq.rfq_mode}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Expected</span><span className="font-medium">{rfq.quote_count_expected}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Received</span><span className="font-medium">{rfq.quote_count || 0}</span></div>
              </div>
            </div>
            {/* Products Summary from PRs */}
            {linkedPRs.some(pr => pr.lines?.length > 0) && (
              <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
                <h4 className="text-sm font-semibold text-slate-700 mb-3">Products Required</h4>
                <div className="space-y-2">
                  {linkedPRs.flatMap(pr => pr.lines || []).map((line, idx) => (
                    <div key={idx} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-50 last:border-0">
                      <div>
                        <p className="font-medium text-slate-800">{line.product_name || line.machinery_name || line.service_catalogue_name || '-'}</p>
                        <p className="text-xs text-slate-400">{line.product_code || ''}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">{Number(line.quantity_requested || 0).toLocaleString()}</p>
                        <p className="text-xs text-slate-400">{line.uom || ''}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            </div>{/* end Summary + Products row */}

            <div className="bg-white rounded-lg border border-slate-200 p-5">
              <h4 className="text-sm font-semibold text-slate-700 mb-3">Email History</h4>
              {emailLogs.length === 0 ? <p className="text-xs text-slate-400 text-center py-4">No emails sent</p> : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {emailLogs.map(log => (
                    <div key={log.id} className={`p-3 rounded-lg border text-xs ${log.email_sent ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                      <div className="font-medium">{log.vendor_email}</div>
                      <div className="flex justify-between mt-1"><span className={log.email_sent ? 'text-green-700' : 'text-red-700'}>{log.email_sent ? 'Email Sent' : 'Failed'}</span><span className="text-slate-400">{formatDateTime(log.sent_at || log.created_at)}</span></div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}

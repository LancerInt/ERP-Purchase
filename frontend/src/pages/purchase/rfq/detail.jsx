import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Edit3, Save, X, Mail, Check, FileText, Trash2, Printer, Clock } from 'lucide-react';
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

      const prIds = rfqData.linked_prs || [];
      if (prIds.length > 0) {
        const prResults = await Promise.all(
          prIds.map(prId => apiClient.get(`/api/purchase/requests/${prId}/`).catch(() => null))
        );
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

  if (isLoading) return <MainLayout><div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin" /></div></MainLayout>;
  if (!rfq) return <MainLayout><div className="text-center py-12"><FileText className="mx-auto text-slate-300 mb-4" size={48} /><p className="text-slate-500">RFQ not found</p></div></MainLayout>;

  const thCls = 'text-left px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap';

  return (
    <MainLayout>
      <div className="max-w-6xl space-y-2">

        {/* ── Header row: Back + RFQ# + badge + chips + actions ── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/rfq'))}
              className="p-1 text-slate-400 hover:text-slate-700 transition shrink-0"
              title="Back to list"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="text-lg sm:text-xl font-bold text-slate-900 truncate">{rfq.rfq_no}</h1>
            <StatusBadge status={rfq.rfq_status} />
            <div className="hidden sm:flex items-center gap-1.5 ml-1">
              <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{rfq.rfq_mode_display || rfq.rfq_mode}</span>
              <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{formatDate(rfq.creation_date)}</span>
              <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">Expected: {rfq.quote_count_expected} · Received: {rfq.quote_count || 0}</span>
              {(rfq.linked_pr_numbers || []).map((prNo, i) => {
                const prId = (rfq.linked_prs || [])[i];
                return (
                  <button key={prNo} onClick={() => prId && navigate(`/purchase/requests/${prId}`)} className="px-2 py-0.5 rounded bg-blue-50 text-[10px] font-medium text-blue-700 hover:bg-blue-100 transition">
                    PR: {prNo}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap ml-6 sm:ml-0">
            {!isEditing && <>
              {canEdit('RFQ') && (
                <button onClick={handleEdit} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 transition text-xs font-medium">
                  <Edit3 size={13} /> Edit
                </button>
              )}
              <button onClick={() => navigate(`/purchase/rfq/${id}/document`)} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 transition text-xs font-medium">
                <Printer size={13} /> RFQ Document
              </button>
              {canDelete('RFQ') && (
                <button onClick={handleDelete} className="flex items-center gap-1.5 px-3 py-1.5 border border-red-200 rounded-md text-red-600 hover:bg-red-50 transition text-xs font-medium">
                  <Trash2 size={13} /> Delete
                </button>
              )}
              {emailLogs.length > 0 ? (
                <>
                  <button
                    onClick={() => { if (!rfq?.is_evaluated) navigate(`/purchase/quotes/new?rfq=${id}`); }}
                    disabled={!!rfq?.is_evaluated}
                    title={rfq?.is_evaluated
                      ? 'Quotes for this RFQ have already been evaluated — new responses are locked'
                      : 'Create Quote Response'}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition ${
                      rfq?.is_evaluated
                        ? 'bg-slate-200 text-slate-500 cursor-not-allowed'
                        : 'bg-green-600 text-white hover:bg-green-700'
                    }`}
                  >
                    <FileText size={13} /> Quote Response
                  </button>
                  <span className="flex items-center gap-1.5 px-3 py-1.5 bg-green-100 text-green-700 rounded-md text-xs font-medium"><Mail size={13} /> Email Sent</span>
                </>
              ) : (
                canSendEmail('RFQ') && (
                  <button onClick={() => navigate(`/purchase/rfq/${id}/send-email`)} className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 text-white rounded-md text-xs font-medium hover:bg-primary-700 transition">
                    <Mail size={13} /> Send Email
                  </button>
                )
              )}
            </>}
            {isEditing && (
              <>
                <button onClick={handleSave} disabled={isSaving} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 transition disabled:opacity-50">
                  <Save size={13} /> {isSaving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={handleCancelEdit} disabled={isSaving} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 transition text-xs font-medium">
                  <X size={13} /> Cancel
                </button>
              </>
            )}
          </div>
        </div>

        {/* Mobile chips row */}
        <div className="flex sm:hidden items-center gap-1.5 flex-wrap ml-7">
          <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{rfq.rfq_mode_display || rfq.rfq_mode}</span>
          <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{formatDate(rfq.creation_date)}</span>
          <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">Exp: {rfq.quote_count_expected} · Rcvd: {rfq.quote_count || 0}</span>
          {(rfq.linked_pr_numbers || []).map((prNo, i) => {
            const prId = (rfq.linked_prs || [])[i];
            return (
              <button key={prNo} onClick={() => prId && navigate(`/purchase/requests/${prId}`)} className="px-2 py-0.5 rounded bg-blue-50 text-[10px] font-medium text-blue-700">
                PR: {prNo}
              </button>
            );
          })}
        </div>

        {/* ── Single-row field strip ── */}
        <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
          {!isEditing ? (
            <div className="flex items-start gap-4 overflow-x-auto" style={{ fontSize: 0 }}>
              {!isHidden('rfq_no') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">RFQ Number</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{rfq.rfq_no}</p></div>
              )}
              {!isHidden('rfq_mode') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Mode</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{rfq.rfq_mode_display || rfq.rfq_mode}</p></div>
              )}
              {!isHidden('rfq_status') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Status</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{rfq.rfq_status_display || rfq.rfq_status}</p></div>
              )}
              {!isHidden('quote_count_expected') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Expected Quotes</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{rfq.quote_count_expected}</p></div>
              )}
              <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Received</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{rfq.quote_count || 0}</p></div>
              {!isHidden('linked_prs') && (rfq.linked_pr_numbers || []).length > 0 && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Linked PRs</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{(rfq.linked_pr_numbers || []).join(', ')}</p></div>
              )}
              <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Created</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{formatDate(rfq.creation_date)}</p></div>
              {rfq.skip_rfq_justification && (
                <div className="min-w-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Skip Justification</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-700 truncate max-w-[260px]" title={rfq.skip_rfq_justification}>{rfq.skip_rfq_justification}</p></div>
              )}
              {rfq.notes && (
                <div className="min-w-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Notes</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-700 truncate max-w-[200px]" title={rfq.notes}>{rfq.notes}</p></div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2">
              {!isHidden('rfq_mode') && (
                <div>
                  <p className="text-[8px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Mode</p>
                  {!isReadOnly('rfq_mode') ? (
                    <CustomSelect name="rfq_mode" value={editData.rfq_mode || ''} onChange={handleChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="EMAIL">Email</option><option value="PORTAL">Portal</option><option value="PHONE">Phone</option>
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{rfq.rfq_mode_display || rfq.rfq_mode}</p>)}
                </div>
              )}
              {!isHidden('rfq_status') && (
                <div>
                  <p className="text-[8px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Status</p>
                  {!isReadOnly('rfq_status') ? (
                    <CustomSelect name="rfq_status" value={editData.rfq_status || ''} onChange={handleChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="OPEN">Open</option><option value="CLOSED">Closed</option><option value="CANCELLED">Cancelled</option>
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{rfq.rfq_status_display || rfq.rfq_status}</p>)}
                </div>
              )}
              {!isHidden('quote_count_expected') && (
                <div>
                  <p className="text-[8px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Expected Quotes</p>
                  {!isReadOnly('quote_count_expected') ? (
                    <input type="number" name="quote_count_expected" value={editData.quote_count_expected || ''} onChange={handleChange} min="1" className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  ) : (<p className="text-[12px] font-medium text-slate-800">{rfq.quote_count_expected}</p>)}
                </div>
              )}
              <div className="col-span-2 sm:col-span-4">
                <p className="text-[8px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Skip RFQ Justification</p>
                <textarea name="skip_rfq_justification" value={editData.skip_rfq_justification || ''} onChange={handleChange} rows={1} placeholder="Reason for skipping RFQ process..." className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
              <div className="col-span-2 sm:col-span-4">
                <p className="text-[8px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Notes</p>
                <textarea name="notes" value={editData.notes || ''} onChange={handleChange} rows={1} placeholder="Additional notes..." className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
            </div>
          )}
        </div>

        {/* ── Products Required (compact) ── */}
        {linkedPRs.some(pr => pr.lines?.length > 0) && (
          <div className="bg-white rounded-lg border border-slate-200">
            <div className="px-3 py-1.5 border-b border-slate-100">
              <h2 style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">Products Required</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className={thCls}>Product</th>
                    <th className={thCls}>SKU</th>
                    <th className={`${thCls} text-right`}>Qty</th>
                    <th className={thCls}>UOM</th>
                  </tr>
                </thead>
                <tbody>
                  {linkedPRs.flatMap(pr => pr.lines || []).map((line, idx) => (
                    <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50/60 transition-colors">
                      <td className="px-2 py-1.5 font-medium text-slate-800">{line.product_name || line.machinery_name || line.service_catalogue_name || '-'}</td>
                      <td className="px-2 py-1.5 text-slate-500">{line.product_code || '-'}</td>
                      <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{Number(line.quantity_requested || 0).toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-slate-500">{line.uom || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Linked Purchase Requests (compact per-PR sections) ── */}
        {linkedPRs.map(pr => (
          <div key={pr.id} className="bg-white rounded-lg border border-slate-200">
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-100">
              <h2 style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">Purchase Request</h2>
              <button onClick={() => navigate(`/purchase/requests/${pr.id}`)} className="text-[12px] font-semibold text-primary-600 hover:text-primary-800 hover:underline">{pr.pr_no}</button>
              <StatusBadge status={pr.approval_status} />
            </div>

            {/* PR field strip */}
            <div className="px-3 py-2 border-b border-slate-100">
              <div className="flex items-start gap-4 overflow-x-auto" style={{ fontSize: 0 }}>
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Warehouse</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{pr.warehouse_name || '-'}</p></div>
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Priority</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{pr.priority_display || pr.priority || '-'}</p></div>
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Requirement</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{pr.requirement_type_display || pr.requirement_type || '-'}</p></div>
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Required By</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{pr.required_by_date ? formatDate(pr.required_by_date) : '-'}</p></div>
                {pr.justification && (
                  <div className="min-w-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Justification</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-700 truncate max-w-[260px]" title={pr.justification}>{pr.justification}</p></div>
                )}
              </div>
            </div>

            {/* Line Items Table */}
            {pr.lines && pr.lines.length > 0 && (
              <>
                <div className="px-3 py-1.5 border-b border-slate-100">
                  <h3 style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">Line Items ({pr.lines.length})</h3>
                </div>

                {/* Mobile stacked lines */}
                <div className="sm:hidden divide-y divide-slate-100">
                  {pr.lines.map((line, idx) => {
                    const displayName = line.product_name || line.machinery_name || line.service_catalogue_name || '-';
                    return (
                      <div key={`m-${line.id || idx}`} className="px-3 py-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-[11px] text-slate-500">#{line.line_no || idx + 1}</p>
                            <p className="text-[12px] font-semibold text-slate-800 truncate">{displayName}</p>
                            {line.product_code && <p className="text-[10px] text-slate-400">{line.product_code}</p>}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-[12px] font-semibold">{Number(line.quantity_requested || 0).toLocaleString()} {line.uom || ''}</p>
                            <StatusBadge status={line.status} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Desktop table */}
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className={thCls}>#</th>
                        <th className={thCls}>Product</th>
                        <th className={thCls}>SKU</th>
                        <th className={thCls}>Description</th>
                        <th className={`${thCls} text-right`}>Qty</th>
                        <th className={thCls}>UOM</th>
                        <th className={thCls}>Purpose</th>
                        <th className={thCls}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pr.lines.map((line, idx) => {
                        const displayName = line.product_name || line.machinery_name || line.service_catalogue_name || '-';
                        return (
                          <tr key={line.id || idx} className="border-b border-slate-100 hover:bg-slate-50/60 transition-colors">
                            <td className="px-2 py-1.5 text-slate-400">{line.line_no || idx + 1}</td>
                            <td className="px-2 py-1.5 font-medium text-slate-800">{displayName}</td>
                            <td className="px-2 py-1.5 text-slate-500">{line.product_code || '-'}</td>
                            <td className="px-2 py-1.5 text-slate-600">{line.description_override || '-'}</td>
                            <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{Number(line.quantity_requested || 0).toLocaleString()}</td>
                            <td className="px-2 py-1.5 text-slate-500">{line.uom || '-'}</td>
                            <td className="px-2 py-1.5 text-slate-500">{line.purpose || '-'}</td>
                            <td className="px-2 py-1.5"><StatusBadge status={line.status} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        ))}

        {linkedPRs.length === 0 && (
          <div className="bg-white rounded-lg border border-slate-200 px-3 py-2 text-center text-slate-400 text-[12px]">
            No linked Purchase Requests found
          </div>
        )}

        {/* ── Email History (collapsible) ── */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <details className="group">
            <summary className="flex items-center justify-between px-3 py-2 cursor-pointer select-none hover:bg-slate-50 transition">
              <span style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                <Clock size={13} className="text-slate-400" />
                Email History ({emailLogs.length})
              </span>
              <span className="text-[10px] text-blue-600 font-medium group-open:hidden">View ↓</span>
              <span className="text-[10px] text-blue-600 font-medium hidden group-open:inline">Hide ↑</span>
            </summary>
            <div className="px-3 pb-3 border-t border-slate-100">
              {emailLogs.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-3">No emails sent</p>
              ) : (
                <div className="space-y-1.5 pt-2 max-h-48 overflow-y-auto">
                  {emailLogs.map(log => (
                    <div key={log.id} className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded border text-[11px] ${log.email_sent ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                      <span className="font-medium text-slate-700 truncate">{log.vendor_email}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={log.email_sent ? 'text-green-700 font-medium' : 'text-red-700 font-medium'}>{log.email_sent ? 'Sent' : 'Failed'}</span>
                        <span className="text-slate-400">{formatDateTime(log.sent_at || log.created_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>
        </div>

      </div>
    </MainLayout>
  );
}

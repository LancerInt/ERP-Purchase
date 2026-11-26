import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import { CheckCircle2, XCircle, ArrowLeft, Package } from 'lucide-react';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '@/utils/formatters';

export default function StockDeclarationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, isSuperuser } = usePermissions();
  const canApprove = isAdmin || isSuperuser;

  const [decl, setDecl] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [adminRemarks, setAdminRemarks] = useState('');
  const [acting, setActing] = useState(null);

  const fetchDecl = useCallback(async () => {
    try {
      const res = await apiClient.get(`/api/inventory/stock-declarations/${id}/`);
      setDecl(res.data);
    } catch {
      setDecl(null);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchDecl(); }, [fetchDecl]);

  const handleApprove = async () => {
    setActing('approve');
    try {
      const res = await apiClient.post(`/api/inventory/stock-declarations/${id}/approve/`, {
        admin_remarks: adminRemarks,
      });
      toast.success('Declaration approved — product & opening stock created');
      setDecl(res.data);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setActing(null);
    }
  };

  const handleReject = async () => {
    if (!adminRemarks.trim()) {
      toast.error('Please add remarks explaining the rejection');
      return;
    }
    setActing('reject');
    try {
      const res = await apiClient.post(`/api/inventory/stock-declarations/${id}/reject/`, {
        admin_remarks: adminRemarks,
      });
      toast.success('Declaration rejected');
      setDecl(res.data);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setActing(null);
    }
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center min-h-[40vh]">
          <div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin" />
        </div>
      </MainLayout>
    );
  }

  if (!decl) {
    return (
      <MainLayout>
        <div className="text-center py-16 text-slate-500">
          Declaration not found.
          <button onClick={() => navigate('/inventory/stock-declarations')} className="ml-2 text-primary-600 hover:underline">Go back</button>
        </div>
      </MainLayout>
    );
  }

  const isPending = decl.approval_status === 'PENDING';

  return (
    <MainLayout>
      <PageHeader
        title={decl.product_name}
        subtitle={`Stock Declaration — ${decl.approval_status}`}
        hideCompanyFilter
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Stock Declarations', href: '/inventory/stock-declarations' },
          { label: decl.product_name },
        ]}
      />

      <div className="space-y-3 px-1">
        {/* Status banner */}
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${
          decl.approval_status === 'APPROVED' ? 'bg-green-50 border-green-200' :
          decl.approval_status === 'REJECTED' ? 'bg-red-50 border-red-200' :
          'bg-amber-50 border-amber-200'
        }`}>
          {decl.approval_status === 'APPROVED' ? <CheckCircle2 size={14} className="text-green-600" /> :
           decl.approval_status === 'REJECTED' ? <XCircle size={14} className="text-red-600" /> :
           <Package size={14} className="text-amber-600" />}
          <span className="font-medium">
            {decl.approval_status === 'APPROVED' ? 'Approved' :
             decl.approval_status === 'REJECTED' ? 'Rejected' : 'Pending Approval'}
          </span>
          {decl.approved_by_name && (
            <span className="text-slate-500">by {decl.approved_by_name} on {formatDate(decl.approved_at)}</span>
          )}
        </div>

        {/* Detail fields — flat on page background */}
        <div className="grid grid-cols-4 gap-x-4 gap-y-3">
          <div>
            <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Product</div>
            <div className="text-sm text-slate-800 font-medium">{decl.product_name}</div>
          </div>
          <div>
            <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Type</div>
            <div className="text-sm">
              {decl.is_new_product
                ? <span className="text-amber-700 font-medium">New Product</span>
                : <span className="text-green-700 font-medium">Existing ({decl.product_sku || '-'})</span>}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Quantity</div>
            <div className="text-sm text-slate-800">{Number(decl.quantity).toLocaleString()} {decl.uom}</div>
          </div>
          <div>
            <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Warehouse</div>
            <div className="text-sm text-slate-800">{decl.warehouse_name || '-'}</div>
          </div>
          <div>
            <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Godown</div>
            <div className="text-sm text-slate-800">{decl.godown_name || '-'}</div>
          </div>
          <div>
            <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Declared By</div>
            <div className="text-sm text-slate-800">{decl.created_by_name || '-'}</div>
          </div>
          <div>
            <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Date</div>
            <div className="text-sm text-slate-800">{formatDate(decl.created_at) || '-'}</div>
          </div>
          {decl.specification && (
            <div className="col-span-2">
              <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Specification</div>
              <div className="text-sm text-slate-800">{decl.specification}</div>
            </div>
          )}
          {decl.admin_remarks && (
            <div className="col-span-4">
              <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Admin Remarks</div>
              <div className="text-sm text-slate-800">{decl.admin_remarks}</div>
            </div>
          )}
        </div>

        {/* Approve / Reject — admin only, pending only */}
        {canApprove && isPending && (
          <div className="flex items-end gap-3 pt-2 border-t border-slate-200">
            <div className="flex-1">
              <label className="block text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-0.5">Admin Remarks</label>
              <input
                value={adminRemarks}
                onChange={(e) => setAdminRemarks(e.target.value)}
                placeholder="Optional for approve, required for reject"
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-400 transition"
              />
            </div>
            <button
              onClick={handleApprove}
              disabled={!!acting}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition disabled:opacity-50 whitespace-nowrap"
            >
              <CheckCircle2 size={13} />
              {acting === 'approve' ? 'Approving...' : 'Approve'}
            </button>
            <button
              onClick={handleReject}
              disabled={!!acting}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition disabled:opacity-50 whitespace-nowrap"
            >
              <XCircle size={13} />
              {acting === 'reject' ? 'Rejecting...' : 'Reject'}
            </button>
          </div>
        )}

        <div className="pt-1">
          <button
            onClick={() => navigate('/inventory/stock-declarations')}
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition"
          >
            <ArrowLeft size={13} /> Back to list
          </button>
        </div>
      </div>
    </MainLayout>
  );
}

import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import usePermissions from './usePermissions.js';

// Maps a target route prefix → the RBAC module that guards it. Mirrors the
// module= props on the corresponding <ProtectedRoute>s in App.jsx so a
// cross-module hyperlink can be permission-checked before navigating,
// instead of routing the user into a denied redirect.
const PATH_MODULE = [
  ['/purchase/orders', 'Purchase Order'],
  ['/purchase/rfq', 'RFQ'],
  ['/purchase/requests', 'Purchase Request'],
  ['/purchase/receipts', 'Receipt Advice'],
  ['/purchase/bills', 'Vendor Bill'],
  ['/purchase/payments-made', 'Payment Made'],
  ['/purchase/vendor-credits', 'Vendor Credit'],
  ['/sales/customer-po', 'Customer PO'],
  ['/sales/dc', 'Dispatch Challan'],
  ['/sales/orders', 'Sales Order'],
  ['/sales/invoices', 'Sales Invoice'],
  ['/sales/receivables', 'Receivable'],
  ['/sales/advances', 'Receivable'],
  ['/freight/purchase', 'Freight Advice'],
  ['/freight/sales', 'Sales Freight'],
  ['/production/work-orders', 'Work Order'],
  ['/production/packing-processes', 'Packing Process'],
  ['/production/wage-vouchers', 'Wage Voucher'],
  ['/finance/vendor-ledger', 'Vendor Ledger'],
  ['/finance/customer-ledger', 'Customer Ledger'],
  ['/finance/freight-ledger-all', 'Freight Ledger'],
  ['/finance/wage-ledger-all', 'Wage Ledger'],
  ['/finance/expense-ledger', 'Expense Ledger'],
  ['/finance/petty-cash-ledger', 'Petty Cash Ledger'],
];

export const moduleForPath = (path) =>
  (PATH_MODULE.find(([p]) => String(path).startsWith(p)) || [])[1] || null;

/**
 * Returns a `go(to)` navigator that checks the user's view permission on the
 * target route's module first. If denied, it raises a toast and does NOT
 * navigate. Admins/superusers bypass the check (canView returns true).
 * Unknown routes (no module mapping) navigate freely.
 */
export default function useGuardedNavigate() {
  const navigate = useNavigate();
  const { canView } = usePermissions();

  return (to) => {
    if (!to) return;
    const mod = moduleForPath(to);
    if (mod && !canView(mod)) {
      toast.error(`You don't have permission to access ${mod}.`);
      return;
    }
    navigate(to);
  };
}

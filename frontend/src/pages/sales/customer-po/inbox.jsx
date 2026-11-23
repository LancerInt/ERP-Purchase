/**
 * Dedicated PO Email Inbox page.
 *
 * Hosts the same `<InboxPanel />` component that used to live at the
 * top of the Customer PO list page. Splitting it out:
 *   1. Frees the Customer PO list from inbox clutter — the list page
 *      is now purely a list, faster to scan.
 *   2. Gives the inbox a stable URL (/sales/customer-po/inbox) that
 *      we can link to from anywhere (sidebar, notifications, etc.)
 *      without forcing the user into the full list view.
 *
 * Functionality is identical to the previous embed — the InboxPanel
 * component is unchanged. This file is purely a host shell.
 */
import { Link, Navigate } from 'react-router-dom';
import { ArrowLeft, Lock } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import InboxPanel from './InboxPanel';
import usePermissions from '../../../hooks/usePermissions.js';

export default function CustomerPOInboxPage() {
  // Route-level guard. The Inbox button on the Customer PO list is
  // already permission-gated, but URL pasting / bookmarks would
  // otherwise let an unauthorized user reach this page. Block the
  // render here too; while the perms hook is loading we hold the
  // page back behind a brief spinner-style placeholder rather than
  // flash the inbox before deciding.
  const { canViewInbox, isLoading } = usePermissions();
  const allowed = canViewInbox('Customer PO');

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center py-24 text-sm text-slate-500">
          Loading permissions…
        </div>
      </MainLayout>
    );
  }

  if (!allowed) {
    return (
      <MainLayout>
        <div className="max-w-md mx-auto mt-16 p-4 sm:p-6 bg-white rounded-lg border border-slate-200 text-center">
          <Lock size={28} className="mx-auto text-slate-400 mb-3" />
          <h2 className="text-lg font-semibold text-slate-800">Inbox access not granted</h2>
          <p className="text-sm text-slate-600 mt-2">
            You don't have permission to view the Customer PO inbox. Ask an admin
            to enable <strong>View Inbox</strong> on the Customer PO row in the
            Sales Module Permissions admin page.
          </p>
          <Link to="/sales/customer-po" className="mt-4 inline-block text-sm text-blue-700 hover:underline">
            ← Back to Customer PO list
          </Link>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        title="PO Email Inbox"
        subtitle="Customer purchase orders captured from the shared mailbox"
        breadcrumbs={[
          { label: 'Sales' },
          { label: 'Customer PO', path: '/sales/customer-po' },
          { label: 'Email Inbox' },
        ]}
      />

      <div className="mb-3">
        <Link
          to="/sales/customer-po"
          className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft size={14} /> Back to Customer PO list
        </Link>
      </div>

      <InboxPanel />
    </MainLayout>
  );
}

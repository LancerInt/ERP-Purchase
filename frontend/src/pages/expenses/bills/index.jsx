import VendorBillList from '../../purchase/bills/index.jsx';

// Expense Bills — the single list page for direct & indirect expense bookings,
// built on the Purchase Bills table in "expense only" mode (bill type pinned to
// Expenses, with a Direct/Indirect bucket picker). Replaces the two separate
// Direct / Indirect analytics pages.
export default function ExpenseBillsPage() {
  return <VendorBillList expenseOnly />;
}

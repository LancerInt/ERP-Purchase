import GeneralLedger from '../components/GeneralLedger';

// Customer Ledger — every customer's financial detail from the Sales module
// (invoices, advances received and payments received) shown as debit / credit
// with a running balance. Built on-the-fly from the live sales records, so it
// always reflects every money event (the old table-based view stayed empty
// because nothing populated it).
export default function CustomerLedger() {
  return (
    <GeneralLedger
      endpoint="/api/finance/customer-ledger-entries/"
      title="Customer Ledger"
      subtitle="Customer invoices, advances and receipts — debit, credit and running balance"
      breadcrumbLabel="Customer Ledger"
      partyLabel="Customer"
      moduleName="Customer Ledger"
      exportName="customer-ledger"
    />
  );
}

import GeneralLedger from '../components/GeneralLedger';

// Ledgers — loans, advances, suspense: money that's neither a trade
// Vendor/Customer payable nor a P&L expense (see finance.Ledger's own
// docstring on the backend for why this exists as a third bucket). Balance
// is a plain running total (money received minus money paid) rather than a
// payable/receivable figure, since a Ledger can run either way depending on
// its Type — a Loan Given behaves like a receivable, a Loan Taken like a
// payable. The Type column carries that context.
export default function Ledgers() {
  return (
    <GeneralLedger
      endpoint="/api/finance/ledger-entries/"
      title="Ledgers"
      subtitle="Loans, advances and suspense entries — money that's neither a vendor payable nor an expense"
      breadcrumbLabel="Ledgers"
      partyLabel="Ledger"
      statusLabel="Type"
      moduleName="Reconcile Statement"
      exportName="ledgers"
    />
  );
}

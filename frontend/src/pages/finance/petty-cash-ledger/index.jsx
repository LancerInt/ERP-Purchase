import GeneralLedger from '../components/GeneralLedger';

// Petty cash ledger — the imprest cash book: fund top-ups (debit) and voucher
// spends (credit) with a running cash-on-hand balance per fund. Closing
// balance matches each fund's derived balance.
export default function PettyCashLedger() {
  return (
    <GeneralLedger
      endpoint="/api/finance/petty-cash-ledger/"
      title="Petty Cash Ledger"
      subtitle="Imprest fund top-ups and voucher spends with a running cash balance"
      breadcrumbLabel="Petty Cash Ledger"
      partyLabel="Fund"
      statusLabel="Type"
      moduleName="Petty Cash Ledger"
      exportName="petty-cash-ledger"
    />
  );
}

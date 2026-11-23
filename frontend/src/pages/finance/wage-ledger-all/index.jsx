import GeneralLedger from '../components/GeneralLedger';

// Wage ledger — every wage money event: production wage vouchers and
// loading/unloading wage bills (credit) and their payments (debit), with a
// running payable balance per contractor / worker.
export default function WageLedgerAll() {
  return (
    <GeneralLedger
      endpoint="/api/finance/wage-ledger-all/"
      title="Wage Ledger"
      subtitle="Wage vouchers, loading/unloading wages and payments with a running balance"
      breadcrumbLabel="Wage Ledger"
      partyLabel="Contractor"
      statusLabel="Status"
      moduleName="Wage Ledger"
      exportName="wage-ledger"
    />
  );
}

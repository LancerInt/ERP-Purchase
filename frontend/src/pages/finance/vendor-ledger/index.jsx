import GeneralLedger from '../components/GeneralLedger';

// Vendor Ledger — every vendor's financial detail from the Purchase module
// (bills, advances paid and payments) shown as credit / debit with a running
// payable balance. Built on-the-fly from the live purchase records, so it
// always reflects every money event (the old table-based view stayed empty
// because nothing populated it).
export default function VendorLedger() {
  return (
    <GeneralLedger
      endpoint="/api/finance/vendor-ledger-entries/"
      title="Vendor Ledger"
      subtitle="Vendor bills, advances and payments — credit, debit and running balance"
      breadcrumbLabel="Vendor Ledger"
      partyLabel="Vendor"
      statusLabel="Paid Status"
      moduleName="Vendor Ledger"
      exportName="vendor-ledger"
    />
  );
}

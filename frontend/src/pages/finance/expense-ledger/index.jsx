import GeneralLedger from '../components/GeneralLedger';

// Expense ledger — every expense money event: credit & voucher expenses
// (credit) and their settlements (debit), with a running payable balance per
// party. Gives finance the same ledger view for expenses that it has for
// bills, freight and wages.
export default function ExpenseLedger() {
  return (
    <GeneralLedger
      endpoint="/api/finance/expense-ledger/"
      title="Expense Ledger"
      subtitle="Every expense on one line with a running total of spend"
      breadcrumbLabel="Expense Ledger"
      partyLabel="Party"
      statusLabel="Method"
      moduleName="Expense Ledger"
      exportName="expense-ledger"
    />
  );
}

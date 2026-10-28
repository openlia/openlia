// Synthetic copies of the feature contract for hermetic tests and local previews.
// Runtime account creation must always read the installed workspace contract.
export const financeAccountSchema: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "status",
    "account_type",
    "ledger_account",
    "institution_label",
    "currencies",
    "opening_balance_date",
    "reconciliation_frequency",
    "last_reconciled",
  ],
  properties: {
    journal_path: { type: ["string", "null"], minLength: 1 },
    id: { type: ["string", "null"], minLength: 1 },
    status: { enum: ["active", "closed", "archived"] },
    account_type: {
      enum: [
        "bank",
        "credit-card",
        "cash",
        "e-wallet",
        "brokerage",
        "exchange",
        "loan",
        "other",
      ],
    },
    ledger_account: { type: ["string", "null"], minLength: 1 },
    institution_label: { type: ["string", "null"], minLength: 1 },
    currencies: {
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true,
    },
    opening_balance_date: { type: ["string", "null"], format: "date" },
    reconciliation_frequency: {
      enum: ["weekly", "monthly", "quarterly", "none", null],
    },
    last_reconciled: { type: ["string", "null"], format: "date" },
  },
};
export const financeAccountDefaults: Record<string, unknown> = {
  id: null,
  status: "active",
  account_type: "other",
  ledger_account: null,
  institution_label: null,
  currencies: [],
  opening_balance_date: null,
  reconciliation_frequency: null,
  last_reconciled: null,
  journal_path: null,
};
export const financeAccountBody =
  "# <Finance Account>\n\n## Mapping\n- Ledger account:\n- Account purpose:\n- Related journal or rules:\n- Opening balance evidence:\n\n## Reconciliation\n- Statement or source cadence:\n- Last checked balance:\n- Outstanding discrepancy:\n- Next check:\n\n## Safety\n- Do not record full account numbers, credentials, tokens, or raw exports here.\n";
export const financeAccountTemplate = `---\n$schema: ./accounts-template.schema.json\nid: null\nstatus: active\naccount_type: other\nledger_account: null\ninstitution_label: null\ncurrencies: []\nopening_balance_date: null\nreconciliation_frequency: null\nlast_reconciled: null\njournal_path: null\n---\n${financeAccountBody}`;
export const financeProgram =
  'root = Finance([Tabs([TabItem("overview", "Overview", [FinanceOverview(), FinanceChart("income-expenses", "bar")]), TabItem("flows", "Flows", [FinanceChart("flows", "sankey")]), TabItem("spending", "Spending", [FinanceChart("spending", "bar"), FinanceChart("spending", "pie")]), TabItem("trends", "Trends", [FinanceChart("balances", "line")]), TabItem("accounts", "Accounts", [FinanceAccounts()])])])\n';
export const financeJournalFiles: Record<string, string> = {
  "main.journal":
    "include payslips-company-A.hledger\ninclude bank-B.hledger\n",
  "payslips-company-A.hledger":
    "account assets:bank:B\naccount assets:unused\naccount income:salary\n\n2026-09-01 * Salary\n    assets:bank:B    1000.25 USD\n    income:salary  -1000.25 USD\n\n2026-10-01 * Salary\n    assets:bank:B    1000.25 USD\n    income:salary  -1000.25 USD\n",
  "bank-B.hledger":
    "account expenses:food\naccount assets:cash\n\n2026-10-02 * Groceries\n    expenses:food    100.10 USD\n    assets:bank:B   -100.10 USD\n\n2026-10-03 * ATM transfer\n    assets:cash      50.00 USD\n    assets:bank:B   -50.00 USD\n\n2026-10-04 * Refund\n    assets:bank:B     10.00 USD\n    expenses:food    -10.00 USD\n",
};

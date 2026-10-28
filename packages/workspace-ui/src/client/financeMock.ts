import type { WorkspaceApi } from "./api";
import {
  financeAccountSchema,
  financeAccountDefaults,
  financeAccountBody,
} from "../../test-fixtures/finance";
import {
  financeCreateMappingSchema,
  type FinanceMapping,
  type FinanceReport,
} from "../shared/finance";

export function createFinanceMock(
  authenticate: () => void = () => {},
): Pick<
  WorkspaceApi,
  | "loadFinanceContext"
  | "loadFinanceReport"
  | "createFinanceMapping"
  | "validateFinanceMapping"
> {
  const mappings: FinanceMapping[] = [];
  return {
    async validateFinanceMapping(input) {
      authenticate();
      // Only the fixed synthetic fixture is modelled here; production uses the installed schema on the server.
      const errors: string[] = [];
      if (!financeCreateMappingSchema.safeParse(input).success)
        return {
          schema: 1,
          valid: false,
          errors: ["Invalid mapping request."],
        };
      if (input.contractRevision !== "sha256:finance-contract")
        errors.push("Account contract changed.");
      for (const key of financeAccountSchema.required as string[])
        if (!Object.hasOwn(input.fields, key))
          errors.push(`Missing required field: ${key}`);
      if (
        typeof input.fields.ledger_account !== "string" ||
        !input.fields.ledger_account.trim()
      )
        errors.push("Ledger account is required.");
      if (
        Array.isArray(input.fields.currencies) &&
        new Set(input.fields.currencies).size !== input.fields.currencies.length
      )
        errors.push("Currencies must be unique.");
      for (const section of ["Mapping", "Reconciliation", "Safety"])
        if (
          !input.body
            .split("\n")
            .some((line) => line.trim() === `## ${section}`)
        )
          errors.push(`Missing template section: ${section}`);
      return { schema: 1, valid: errors.length === 0, errors };
    },
    async loadFinanceContext(path) {
      authenticate();
      return {
        schema: 1,
        path,
        journals: [
          `${path}/main.journal`,
          `${path}/bank-B.hledger`,
          `${path}/payslips-company-A.hledger`,
        ],
        includedJournals: [
          `${path}/bank-B.hledger`,
          `${path}/payslips-company-A.hledger`,
        ],
        suggestedJournal: `${path}/main.journal`,
        mappings: structuredClone(mappings),
        warnings: [],
        contract: {
          available: true,
          errors: [],
          revision: "sha256:finance-contract",
          templatePath: `${path}/accounts/accounts-template.md`,
          schemaPath: `${path}/accounts/accounts-template.schema.json`,
          defaults: structuredClone(financeAccountDefaults),
          body: financeAccountBody,
          schemaJson: structuredClone(financeAccountSchema),
        },
      };
    },
    async createFinanceMapping(input) {
      authenticate();
      const validation = await this.validateFinanceMapping(input);
      if (!validation.valid) throw new Error(validation.errors.join("; "));
      const mapping = {
        path: `${input.path}/accounts/${input.requestId}.md`,
        title: input.title,
        revision: "sha256:finance-mapping",
        fields: input.fields,
        valid: true,
      };
      if (!mappings.some((item) => item.path === mapping.path))
        mappings.push(structuredClone(mapping));
      return { schema: 1, mapping: structuredClone(mapping), warnings: [] };
    },
    async loadFinanceReport(scope): Promise<FinanceReport> {
      authenticate();
      const periods: string[] = [];
      const date = new Date(`${scope.from}T12:00:00Z`);
      while (
        date.toISOString().slice(0, 10) < scope.to &&
        periods.length < 24
      ) {
        periods.push(date.toISOString().slice(0, 7));
        date.setUTCMonth(date.getUTCMonth() + 1);
      }
      const row = (account: string, type: string, value: string) => ({
        account,
        type,
        amounts: periods.map(() => ({ USD: value })),
      });
      return {
        schema: 1,
        status: "ok",
        message:
          "Synthetic local hledger fixture — no real journal is accessed.",
        scope,
        revision: "sha256:finance-report",
        periods,
        commodities: ["USD"],
        files: [
          `${scope.path}/main.journal`,
          `${scope.path}/bank-B.hledger`,
          `${scope.path}/payslips-company-A.hledger`,
        ],
        accounts: [
          { name: "assets:bank:B", type: "C", declared: true, used: true },
          { name: "assets:unused", type: "A", declared: true, used: false },
          { name: "income:salary", type: "R", declared: true, used: true },
          { name: "expenses:food", type: "X", declared: true, used: true },
        ],
        changes: [
          row("income:salary", "R", "-1000.25"),
          row("expenses:food", "X", "90.1"),
        ],
        balances: [row("assets:bank:B", "C", "1860.4")],
        flows: {
          USD: {
            data: {
              nodes: [
                { id: "from:income:salary", label: "Credit: income:salary" },
                { id: "transaction:1", label: "Posting group" },
                { id: "to:assets:bank:B", label: "Debit: assets:bank:B" },
              ],
              links: [
                {
                  source: "from:income:salary",
                  target: "transaction:1",
                  value: 1000.25,
                  exact: "1000.25",
                },
                {
                  source: "transaction:1",
                  target: "to:assets:bank:B",
                  value: 1000.25,
                  exact: "1000.25",
                },
              ],
            },
            reason:
              "Synthetic accounting posting flow; not a cash-spending attribution.",
          },
        },
        warnings: [],
        commands: ["Synthetic fixture: no commands are executed"],
      };
    },
  };
}

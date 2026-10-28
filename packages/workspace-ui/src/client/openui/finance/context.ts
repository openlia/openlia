import { createContext, useContext } from "react";
import type {
  FinanceContextResponse,
  FinanceMapping,
  FinanceReport,
} from "../../../shared/finance";
import { addDecimal } from "../../../shared/charts";

export interface FinanceContextValue {
  data: FinanceContextResponse;
  report: FinanceReport | null;
  currency: string | null;
  loading: boolean;
  newAccount: () => void;
  openFile: ((path: string) => void) | undefined;
}
export const FinanceContext = createContext<FinanceContextValue | null>(null);
export const useFinance = () => useContext(FinanceContext);

export function mappingLinkState(
  fields: FinanceMapping["fields"],
  report: FinanceReport | null,
): string {
  if (!fields.journal_path) return "No journal configured";
  if (
    !report ||
    report.scope.journal !== fields.journal_path ||
    report.status !== "ok"
  )
    return "Unverified";
  const account = report.accounts.find(
    (account) => account.name === fields.ledger_account,
  );
  return account
    ? account.used
      ? "Linked — used in journal"
      : "Linked — declared, no postings"
    : "Not yet present in journal";
}
export function mappingBalance(
  mapping: FinanceMapping,
  report: FinanceReport | null,
  currency: string | null,
): string {
  if (
    report?.status !== "ok" ||
    mapping.fields.journal_path !== report.scope.journal
  )
    return "No verified ledger data";
  if (currency === null) return "Choose a currency / commodity";
  const account = mapping.fields.ledger_account;
  if (typeof account !== "string") return "No ledger account mapped";
  const rows = report.balances.filter(
    (row) => row.account === account || row.account.startsWith(`${account}:`),
  );
  const amounts = rows
    .map((row) => {
      const values = row.amounts.at(-1);
      return values && Object.hasOwn(values, currency)
        ? values[currency]
        : undefined;
    })
    .filter((value): value is string => value !== undefined);
  return amounts.length
    ? `${amounts.reduce(addDecimal, "0")} ${currency || "(unitless)"}`
    : "No ledger data in this commodity / account scope";
}

import { defineComponent } from "@openuidev/react-lang";
import { useEffect, useState } from "react";
import { domainOpenUIProps } from "../../shared/domainOpenUI";
import {
  buildJournalMetrics,
  computeMonthlyCashflow,
  type ParsedJournal,
} from "../journal/parser";
import { useOpenLiaOpenUI } from "./context";
import { text } from "./domainData";
import { loadFinanceJournal } from "./financeData";
import { parseMarkdownRecord } from "./recordMutator";
import { FinanceValidationCard } from "./FinanceValidationCard";

export const FinanceOverview = defineComponent({
  name: "FinanceOverview",
  description:
    "Read-only journal preview: per-currency net assets, monthly cashflow, category breakdown, and account history",
  props: domainOpenUIProps.FinanceOverview,
  component: ({ props: { journalPath } }) => {
    const {
      loadFile,
      currentRecordContent = "",
      onOpenRecord,
    } = useOpenLiaOpenUI();
    const { metadata } = parseMarkdownRecord(currentRecordContent);
    const path = text(metadata.journal_path) || journalPath;
    const [result, setResult] = useState<{
      parsed: ParsedJournal;
      warnings: string[];
    } | null>(null);
    const [currency, setCurrency] = useState("");
    const [month, setMonth] = useState("");
    const [loading, setLoading] = useState(false);
    useEffect(() => {
      let active = true;
      setResult(null);
      if (!path || !loadFile) {
        setLoading(false);
        return;
      }
      setLoading(true);
      void loadFinanceJournal(path, loadFile).then((data) => {
        if (active) {
          setResult(data);
          setLoading(false);
        }
      });
      return () => {
        active = false;
      };
    }, [path, loadFile]);
    const parsed = result?.parsed;
    const selectedCurrency = parsed?.currencies.includes(currency)
      ? currency
      : parsed?.currencies[0] || "";
    const monthly = parsed
      ? computeMonthlyCashflow(parsed.transactions, selectedCurrency)
      : [];
    const selectedMonth = monthly.some((point) => point.monthKey === month)
      ? month
      : monthly.at(-1)?.monthKey || "";
    const point = monthly.find((item) => item.monthKey === selectedMonth);
    const asOf = parsed
      ? buildJournalMetrics(
          parsed.transactions.filter(
            (tx) => tx.date.slice(0, 7) <= selectedMonth,
          ),
          [selectedCurrency],
        )
      : null;
    const period = parsed
      ? buildJournalMetrics(
          parsed.transactions.filter((tx) => tx.date.startsWith(selectedMonth)),
          [selectedCurrency],
        )
      : null;
    const partial = Boolean(result?.warnings.length);
    const accounts = [...(asOf?.accounts.values() ?? [])];
    const netAssets = accounts
      .filter((account) => ["assets", "liabilities"].includes(account.rootType))
      .reduce(
        (sum, account) =>
          sum + (account.balances.get(selectedCurrency)?.net ?? 0),
        0,
      );
    const ledgerAccount = text(metadata.ledger_account);
    let balance = 0;
    const history = [...(parsed?.transactions ?? [])]
      .sort((a, b) => a.date.localeCompare(b.date))
      .flatMap((tx) => {
        const postings = tx.postings.filter(
          (post) =>
            post.account === ledgerAccount &&
            post.currency === selectedCurrency,
        );
        if (!postings.length) return [];
        balance += postings.reduce((sum, post) => sum + post.amount, 0);
        return [
          { id: tx.id, date: tx.date, description: tx.description, balance },
        ];
      });
    return (
      <section
        className="rounded-xl border border-base-content/10 bg-base-100 p-4 space-y-3"
        aria-label="Finance overview"
      >
        <h2 className="font-semibold">Financial journal preview</h2>
        {path && <FinanceValidationCard key={path} path={path} />}
        <p className="text-sm text-warning">
          Preview calculations are not hledger-validated. No currency conversion
          or market valuation. Checklist completion does not reconcile
          transactions.
        </p>
        {path ? (
          <button
            type="button"
            className="btn btn-link btn-xs"
            onClick={() => onOpenRecord?.(path)}
          >
            Open {path}
          </button>
        ) : (
          <p>
            Journal scope unknown — set journal_path to a workspace-relative
            journal file.
          </p>
        )}
        {loading && <p role="status">Loading journal…</p>}
        {result?.warnings.map((warning) => (
          <p role="alert" key={warning}>
            {warning}
          </p>
        ))}
        {parsed && !parsed.transactions.length && (
          <p>No recognized transactions. Balances unknown.</p>
        )}
        {parsed && parsed.transactions.length > 0 && (
          <>
            <div className="flex gap-3">
              <select
                aria-label="Reporting currency"
                className="select select-bordered select-sm"
                value={selectedCurrency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {parsed.currencies.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
              <select
                aria-label="Reporting month"
                className="select select-bordered select-sm"
                value={selectedMonth}
                onChange={(e) => setMonth(e.target.value)}
              >
                {monthly.map((item) => (
                  <option key={item.monthKey}>{item.monthKey}</option>
                ))}
              </select>
            </div>
            <p>
              Scope: {selectedMonth}, {selectedCurrency}.{" "}
              {partial
                ? "Incomplete includes; totals unavailable."
                : "Recognized postings only; unsupported journal syntax may be omitted."}
            </p>
            {!partial && (
              <>
                <dl className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    ["Net assets (book value, month end)", netAssets],
                    ["Monthly income", point?.income],
                    ["Monthly expenses", point?.expenses],
                    ["Monthly cashflow", point?.net],
                  ].map(([label, value]) => (
                    <div className="rounded-lg bg-base-200 p-3" key={label}>
                      <dt>{label}</dt>
                      <dd className="font-semibold">
                        {typeof value === "number"
                          ? value.toLocaleString()
                          : "Unknown"}{" "}
                        {selectedCurrency}
                      </dd>
                    </div>
                  ))}
                </dl>
                <h3 className="font-semibold">Transaction categories</h3>
                <ul>
                  {period?.highlights.topExpenseCategories.map((category) => (
                    <li key={category.name}>
                      {category.name}: {category.amount.toLocaleString()}{" "}
                      {selectedCurrency}
                    </li>
                  ))}
                </ul>
                {ledgerAccount && (
                  <>
                    <h3 className="font-semibold">
                      Running balance: {ledgerAccount}
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="table table-sm">
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Transaction</th>
                            <th>Balance ({selectedCurrency})</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history
                            .filter((row) => row.date.startsWith(selectedMonth))
                            .map((row) => (
                              <tr key={row.id}>
                                <td>{row.date}</td>
                                <td>{row.description}</td>
                                <td>{row.balance.toLocaleString()}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </section>
    );
  },
});

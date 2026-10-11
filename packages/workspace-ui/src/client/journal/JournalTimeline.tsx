import { useMemo, useState } from "react";
import {
  classifyAccount,
  classifyTransaction,
  formatCurrency,
  groupTransactionsByMonth,
  type JournalTransaction,
} from "./parser";

export interface JournalTimelineProps {
  transactions: JournalTransaction[];
  currency: string;
  order: "desc" | "asc";
  viewMode?: ("timeline" | "compact") | undefined;
  filterQuery?: string | undefined;
  onSwitchToEdit?: (() => void) | undefined;
  onFilterAccount?: ((account: string) => void) | undefined;
}

export function JournalTimeline({
  transactions,
  currency,
  order,
  viewMode = "timeline",
  filterQuery,
  onSwitchToEdit,
  onFilterAccount,
}: JournalTimelineProps) {
  const [userToggledMonths, setUserToggledMonths] = useState<
    Map<string, boolean>
  >(() => new Map());
  const [visibleMonthCount, setVisibleMonthCount] = useState<number>(6);

  const groups = useMemo(() => {
    return groupTransactionsByMonth(transactions, order);
  }, [transactions, order]);

  // If search query is active, show all groups so matches aren't hidden
  const effectiveVisibleCount = filterQuery ? groups.length : visibleMonthCount;
  const visibleGroups = groups.slice(0, effectiveVisibleCount);

  const isMonthCollapsed = (monthKey: string, index: number) => {
    if (userToggledMonths.has(monthKey)) {
      return Boolean(userToggledMonths.get(monthKey));
    }
    // Auto-collapse older months if there are more than 4 months
    return groups.length > 4 && index >= 3;
  };

  const toggleMonth = (monthKey: string, index: number) => {
    const current = isMonthCollapsed(monthKey, index);
    setUserToggledMonths((prev) => {
      const next = new Map(prev);
      next.set(monthKey, !current);
      return next;
    });
  };

  const anyExpanded = visibleGroups.some(
    (g, i) => !isMonthCollapsed(g.monthKey, i),
  );

  const toggleAll = () => {
    setUserToggledMonths((prev) => {
      const next = new Map(prev);
      for (const g of visibleGroups) {
        next.set(g.monthKey, anyExpanded);
      }
      return next;
    });
  };

  if (transactions.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-base-content/50">
        {filterQuery
          ? `No transactions match "${filterQuery}".`
          : "No transactions match the current filter or date range."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.length > 1 && (
        <div className="flex justify-end">
          <button
            className="btn btn-ghost btn-xs text-base-content/60 hover:text-base-content"
            onClick={toggleAll}
            type="button"
          >
            {anyExpanded ? "Collapse all months" : "Expand all months"}
          </button>
        </div>
      )}

      {visibleGroups.map((group, index) => {
        const isCollapsed = isMonthCollapsed(group.monthKey, index);
        const groupTotals = group.totalsByCurrency.get(currency) ?? {
          income: 0,
          expenses: 0,
          net: 0,
          count: 0,
        };

        return (
          <div
            className="flex flex-col gap-3"
            data-testid={`month-group-${group.monthKey}`}
            key={group.monthKey}
          >
            {/* Month Milestone Header */}
            <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-base-content/10 bg-base-200/90 p-3 backdrop-blur-md shadow-xs">
              <button
                aria-expanded={!isCollapsed}
                className="flex items-center gap-2.5 text-left font-semibold text-sm cursor-pointer"
                onClick={() => toggleMonth(group.monthKey, index)}
                type="button"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary text-xs">
                  📅
                </span>
                <span className="font-bold tracking-tight">{group.label}</span>
                <span className="badge badge-neutral badge-xs font-mono">
                  {group.transactions.length} txs
                </span>
                <span className="text-xs text-base-content/40 transition-transform">
                  {isCollapsed ? "▼" : "▲"}
                </span>
              </button>

              {/* Month Period Cashflow Chips */}
              <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                {groupTotals.income > 0 && (
                  <span className="badge badge-sm badge-success/15 text-emerald-600 dark:text-emerald-400 font-medium">
                    +{formatCurrency(groupTotals.income, currency)} in
                  </span>
                )}
                {groupTotals.expenses > 0 && (
                  <span className="badge badge-sm badge-error/15 text-rose-600 dark:text-rose-400 font-medium">
                    -{formatCurrency(groupTotals.expenses, currency)} out
                  </span>
                )}
                <span
                  className={`badge badge-sm font-bold ${
                    groupTotals.net >= 0
                      ? "badge-primary/20 text-primary"
                      : "badge-error/20 text-rose-600 dark:text-rose-400"
                  }`}
                >
                  Net: {groupTotals.net > 0 ? "+" : ""}
                  {formatCurrency(groupTotals.net, currency)}
                </span>
              </div>
            </div>

            {/* Transactions under this Month */}
            {!isCollapsed && (
              <div
                className={
                  viewMode === "timeline"
                    ? "relative flex flex-col gap-3.5 pl-6 sm:pl-8 before:absolute before:bottom-3 before:top-2 before:left-[11px] sm:before:left-[15px] before:w-[2px] before:bg-base-content/15"
                    : "flex flex-col gap-2.5"
                }
              >
                {group.transactions.map((tx) => {
                  const summary = classifyTransaction(tx);
                  const isIncome = summary.type === "income";
                  const isExpense = summary.type === "expense";

                  return (
                    <div
                      className="relative flex flex-col gap-1"
                      data-testid={`tx-${tx.id}`}
                      key={tx.id}
                    >
                      {/* Timeline Node Dot (only in timeline view) */}
                      {viewMode === "timeline" && (
                        <div
                          className={`absolute -left-[23px] sm:-left-[27px] top-3.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-base-100 shadow-xs ${
                            isIncome
                              ? "bg-emerald-500"
                              : isExpense
                                ? "bg-rose-500"
                                : "bg-sky-500"
                          }`}
                          title={summary.type.toUpperCase()}
                        />
                      )}

                      {/* Transaction Card */}
                      <div className="rounded-xl border border-base-content/10 bg-base-100 p-3 shadow-2xs hover:border-base-content/25 transition-all">
                        {/* Transaction Card Header */}
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-content/5 pb-2">
                          <div className="flex items-center gap-2">
                            <span className="rounded-md bg-base-200 px-2 py-0.5 font-mono text-xs font-bold text-base-content/80">
                              {tx.date}
                            </span>
                            {tx.status && (
                              <span className="badge badge-xs badge-success">
                                {tx.status}
                              </span>
                            )}
                            <span className="text-xs font-semibold text-base-content">
                              {tx.description}
                            </span>
                          </div>

                          <div className="flex items-center gap-2">
                            {/* Primary Impact Badge */}
                            <span
                              className={`rounded-md px-2 py-0.5 font-mono text-xs font-bold ${
                                isIncome
                                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                  : isExpense
                                    ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                                    : "bg-sky-500/10 text-sky-600 dark:text-sky-400"
                              }`}
                            >
                              {summary.netImpact > 0 ? "+" : ""}
                              {formatCurrency(
                                summary.netImpact,
                                summary.primaryCurrency || currency,
                              )}
                            </span>

                            {/* Line number link */}
                            {onSwitchToEdit ? (
                              <button
                                className="btn btn-ghost btn-xs font-mono text-[10px] text-base-content/50 hover:text-primary cursor-pointer"
                                onClick={onSwitchToEdit}
                                title="Click to view/edit in code editor"
                                type="button"
                              >
                                Line {tx.lineNumber} ↗
                              </button>
                            ) : (
                              <span className="text-[10px] font-mono text-base-content/40">
                                Line {tx.lineNumber}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Postings Breakdown Table */}
                        <div className="mt-2 divide-y divide-base-content/5 rounded-lg bg-base-200/40 font-mono text-[11px]">
                          {tx.postings.map((p) => {
                            const accType = classifyAccount(p.account);
                            const isCredit = p.amount < 0;
                            return (
                              <div
                                className="flex items-center justify-between px-2.5 py-1.5 hover:bg-base-200/80 transition-colors"
                                key={`${tx.id}-${p.account}-${p.amount}-${p.currency}`}
                              >
                                <button
                                  className={`truncate text-left cursor-pointer hover:underline ${
                                    accType === "income"
                                      ? "text-emerald-600 dark:text-emerald-400 font-medium"
                                      : accType === "expenses"
                                        ? "text-rose-600 dark:text-rose-400"
                                        : "text-sky-600 dark:text-sky-400"
                                  }`}
                                  onClick={() => onFilterAccount?.(p.account)}
                                  title={`Filter by ${p.account}`}
                                  type="button"
                                >
                                  {p.account}
                                </button>
                                <span
                                  className={`shrink-0 ml-4 font-semibold ${
                                    isCredit
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : "text-base-content/80"
                                  }`}
                                >
                                  {formatCurrency(p.amount, p.currency)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {groups.length > effectiveVisibleCount && (
        <div className="flex flex-col items-center justify-center pt-2 pb-4">
          <button
            className="btn btn-sm btn-outline gap-2 font-mono text-xs"
            onClick={() => setVisibleMonthCount((prev) => prev + 6)}
            type="button"
          >
            <span>Load earlier months</span>
            <span className="badge badge-xs badge-neutral">
              {groups.length - effectiveVisibleCount} remaining
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

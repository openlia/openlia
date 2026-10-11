import { useState } from "react";
import {
  type AnnualCashflowPoint,
  formatCurrency,
  type MonthlyCashflowPoint,
} from "./parser";

export interface MonthlyCashflowChartProps {
  data: MonthlyCashflowPoint[];
  annualData?: AnnualCashflowPoint[] | undefined;
  selectedMonth: string | null;
  onSelectMonth: (monthKey: string | null) => void;
  selectedYear?: number | null | undefined;
  onSelectYear?: ((year: number | null) => void) | undefined;
  currency: string;
}

export function MonthlyCashflowChart({
  data,
  annualData = [],
  selectedMonth,
  onSelectMonth,
  selectedYear,
  onSelectYear,
  currency,
}: MonthlyCashflowChartProps) {
  const hasMultipleYears = annualData.length > 1;
  const [granularity, setGranularity] = useState<"monthly" | "annual">(() =>
    hasMultipleYears && !selectedYear ? "annual" : "monthly",
  );

  const effectiveGranularity = selectedYear ? "monthly" : granularity;

  if (data.length === 0 && annualData.length === 0) return null;

  const isAnnual = effectiveGranularity === "annual" && annualData.length > 0;

  const maxVal = isAnnual
    ? Math.max(...annualData.map((d) => Math.max(d.income, d.expenses)), 1)
    : Math.max(...data.map((d) => Math.max(d.income, d.expenses)), 1);

  return (
    <div className="rounded-xl border border-base-content/10 bg-base-100 p-4 shadow-2xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-content/10 pb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-base-content/70">
            {isAnnual
              ? "Annual Cashflow Trajectory"
              : selectedYear
                ? `${selectedYear} Monthly Trajectory`
                : "Monthly Cashflow Trajectory"}
          </span>

          {/* Active filter badge */}
          {selectedMonth && (
            <button
              className="badge badge-sm badge-outline gap-1 hover:badge-error cursor-pointer"
              onClick={() => onSelectMonth(null)}
              title="Clear month filter"
              type="button"
            >
              <span>{selectedMonth}</span>
              <span className="text-[10px]">✕</span>
            </button>
          )}

          {selectedYear && (
            <button
              className="badge badge-sm badge-outline gap-1 hover:badge-error cursor-pointer font-mono"
              onClick={() => onSelectYear?.(null)}
              title="Reset year filter"
              type="button"
            >
              <span>Year {selectedYear}</span>
              <span className="text-[10px]">✕</span>
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Granularity Switcher when multi-year and no single year forced */}
          {hasMultipleYears && !selectedYear && (
            <div className="join">
              <button
                className={`btn btn-xs join-item ${
                  granularity === "annual" ? "btn-neutral" : "btn-ghost"
                }`}
                onClick={() => setGranularity("annual")}
                type="button"
              >
                Annual
              </button>
              <button
                className={`btn btn-xs join-item ${
                  granularity === "monthly" ? "btn-neutral" : "btn-ghost"
                }`}
                onClick={() => setGranularity("monthly")}
                type="button"
              >
                Monthly
              </button>
            </div>
          )}

          {/* Legend */}
          <div className="flex items-center gap-3 text-[11px] font-medium text-base-content/70">
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-xs bg-emerald-500" />
              <span>Income</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-xs bg-rose-500" />
              <span>Expenses</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-violet-400" />
              <span>Net Surplus</span>
            </div>
          </div>
        </div>
      </div>

      {/* Bar Chart Display */}
      {isAnnual ? (
        <div className="mt-4 flex items-end justify-around gap-2 overflow-x-auto pb-2 pt-4">
          {annualData.map((point) => {
            const isSelected = selectedYear === point.year;
            const incomeHeight = Math.max(
              Math.round((point.income / maxVal) * 96),
              point.income > 0 ? 6 : 0,
            );
            const expenseHeight = Math.max(
              Math.round((point.expenses / maxVal) * 96),
              point.expenses > 0 ? 6 : 0,
            );
            const isSurplus = point.net >= 0;

            return (
              <button
                aria-label={`Select Year ${point.year}`}
                className={`group flex min-w-[80px] flex-1 flex-col items-center rounded-lg p-2 transition-all cursor-pointer ${
                  isSelected
                    ? "bg-primary/10 ring-2 ring-primary"
                    : "hover:bg-base-200/60"
                }`}
                key={point.year}
                onClick={() => onSelectYear?.(isSelected ? null : point.year)}
                title={`Year ${point.year}\nIncome: ${formatCurrency(point.income, currency)}\nExpenses: ${formatCurrency(point.expenses, currency)}\nNet: ${formatCurrency(point.net, currency)}\n${point.txCount} transactions\nClick to view monthly breakdown`}
                type="button"
              >
                {/* Bars container */}
                <div className="flex h-24 w-full items-end justify-center gap-2 px-1">
                  {/* Income Bar */}
                  <div
                    className="w-4 rounded-t-sm bg-emerald-500/80 transition-all group-hover:bg-emerald-500 sm:w-5"
                    style={{ height: `${incomeHeight}px` }}
                  />
                  {/* Expense Bar */}
                  <div
                    className="w-4 rounded-t-sm bg-rose-500/80 transition-all group-hover:bg-rose-500 sm:w-5"
                    style={{ height: `${expenseHeight}px` }}
                  />
                </div>

                {/* Net indicator dot */}
                <div className="my-1.5 flex items-center justify-center">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      isSurplus ? "bg-violet-400" : "bg-rose-400"
                    }`}
                  />
                </div>

                {/* Year label */}
                <span className="font-mono text-xs font-bold text-base-content/90">
                  {point.year}
                </span>

                {/* Net balance text */}
                <span
                  className={`mt-0.5 font-mono text-[10px] font-medium ${
                    isSurplus
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400"
                  }`}
                >
                  {point.net > 0 ? "+" : ""}
                  {formatCurrency(point.net, currency)}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mt-4 flex items-end justify-around gap-2 overflow-x-auto pb-2 pt-4">
          {data.map((point) => {
            const isSelected = selectedMonth === point.monthKey;
            const incomeHeight = Math.max(
              Math.round((point.income / maxVal) * 96),
              point.income > 0 ? 6 : 0,
            );
            const expenseHeight = Math.max(
              Math.round((point.expenses / maxVal) * 96),
              point.expenses > 0 ? 6 : 0,
            );
            const isSurplus = point.net >= 0;

            return (
              <button
                aria-label={`Select ${point.label}`}
                className={`group flex min-w-[72px] flex-1 flex-col items-center rounded-lg p-2 transition-all cursor-pointer ${
                  isSelected
                    ? "bg-primary/10 ring-2 ring-primary"
                    : "hover:bg-base-200/60"
                }`}
                key={point.monthKey}
                onClick={() =>
                  onSelectMonth(isSelected ? null : point.monthKey)
                }
                title={`${point.label}\nIncome: ${formatCurrency(point.income, currency)}\nExpenses: ${formatCurrency(point.expenses, currency)}\nNet: ${formatCurrency(point.net, currency)}\n${point.txCount} transactions`}
                type="button"
              >
                {/* Bars container */}
                <div className="flex h-24 w-full items-end justify-center gap-1.5 px-1">
                  {/* Income Bar */}
                  <div
                    className="w-3 rounded-t-sm bg-emerald-500/80 transition-all group-hover:bg-emerald-500 sm:w-4"
                    style={{ height: `${incomeHeight}px` }}
                  />
                  {/* Expense Bar */}
                  <div
                    className="w-3 rounded-t-sm bg-rose-500/80 transition-all group-hover:bg-rose-500 sm:w-4"
                    style={{ height: `${expenseHeight}px` }}
                  />
                </div>

                {/* Net indicator dot */}
                <div className="my-1.5 flex items-center justify-center">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      isSurplus ? "bg-violet-400" : "bg-rose-400"
                    }`}
                  />
                </div>

                {/* Month label */}
                <span className="font-mono text-[11px] font-semibold text-base-content/80">
                  {point.shortLabel}
                </span>

                {/* Net balance text */}
                <span
                  className={`mt-0.5 font-mono text-[10px] font-medium ${
                    isSurplus
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400"
                  }`}
                >
                  {point.net > 0 ? "+" : ""}
                  {formatCurrency(point.net, currency)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

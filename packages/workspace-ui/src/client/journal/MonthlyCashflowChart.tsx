import { formatCurrency, type MonthlyCashflowPoint } from "./parser";

export interface MonthlyCashflowChartProps {
  data: MonthlyCashflowPoint[];
  selectedMonth: string | null;
  onSelectMonth: (monthKey: string | null) => void;
  currency: string;
}

export function MonthlyCashflowChart({
  data,
  selectedMonth,
  onSelectMonth,
  currency,
}: MonthlyCashflowChartProps) {
  if (data.length === 0) return null;

  const maxVal = Math.max(
    ...data.map((d) => Math.max(d.income, d.expenses)),
    1,
  );

  return (
    <div className="rounded-xl border border-base-content/10 bg-base-100 p-4 shadow-2xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-content/10 pb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-base-content/70">
            Monthly Cashflow Trajectory
          </span>
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
        </div>

        <div className="flex items-center gap-4 text-[11px] font-medium text-base-content/70">
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

      {/* Bar Chart Display */}
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
              onClick={() => onSelectMonth(isSelected ? null : point.monthKey)}
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
    </div>
  );
}

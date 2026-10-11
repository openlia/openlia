import type { DateRangeScope } from "./parser";

export interface PeriodScopeSelectorProps {
  availableYears: number[];
  scope: DateRangeScope;
  onScopeChange: (scope: DateRangeScope) => void;
  scopedCount: number;
  totalCount: number;
}

export function PeriodScopeSelector({
  availableYears,
  scope,
  onScopeChange,
  scopedCount,
  totalCount,
}: PeriodScopeSelectorProps) {
  if (availableYears.length <= 1) {
    return null;
  }

  const isAll = scope.type === "all";
  const selectedYear = scope.type === "year" ? scope.year : null;

  // Show top 3 years as direct buttons, the rest in a dropdown if there are > 4 years
  const maxDirectYears = 3;
  const directYears = availableYears.slice(0, maxDirectYears);
  const overflowYears = availableYears.slice(maxDirectYears);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-base-content/10 bg-base-200/40 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold uppercase tracking-wider text-[11px] text-base-content/60 mr-1">
          Period:
        </span>

        {/* All Time button */}
        <button
          aria-pressed={isAll}
          className={`btn btn-xs rounded-lg ${
            isAll ? "btn-primary shadow-xs" : "btn-ghost text-base-content/70"
          }`}
          onClick={() => onScopeChange({ type: "all" })}
          type="button"
        >
          All Time
        </button>

        {/* Direct Year buttons */}
        {directYears.map((year) => {
          const isSelected = selectedYear === year;
          return (
            <button
              aria-pressed={isSelected}
              className={`btn btn-xs rounded-lg font-mono ${
                isSelected
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              key={year}
              onClick={() => onScopeChange({ type: "year", year })}
              type="button"
            >
              {year}
            </button>
          );
        })}

        {/* Overflow years dropdown */}
        {overflowYears.length > 0 && (
          <div className="dropdown dropdown-bottom">
            <button
              className={`btn btn-xs rounded-lg font-mono ${
                selectedYear && overflowYears.includes(selectedYear)
                  ? "btn-primary shadow-xs"
                  : "btn-ghost text-base-content/70"
              }`}
              type="button"
            >
              {selectedYear && overflowYears.includes(selectedYear)
                ? `${selectedYear} ▾`
                : "More Years ▾"}
            </button>
            <ul className="dropdown-content menu z-20 rounded-box border border-base-content/10 bg-base-100 p-1 shadow-md w-32 font-mono text-xs">
              {overflowYears.map((year) => (
                <li key={year}>
                  <button
                    className={selectedYear === year ? "active" : ""}
                    onClick={() => onScopeChange({ type: "year", year })}
                    type="button"
                  >
                    {year}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Scope status indicator */}
      <div className="flex items-center gap-2 text-[11px] text-base-content/60 font-mono">
        {!isAll && selectedYear && (
          <button
            className="badge badge-sm badge-outline gap-1 hover:badge-error cursor-pointer"
            onClick={() => onScopeChange({ type: "all" })}
            title="Reset to All Time"
            type="button"
          >
            <span>{selectedYear}</span>
            <span className="text-[10px]">✕ Reset</span>
          </button>
        )}
        <span>
          {scopedCount} of {totalCount} txs
        </span>
      </div>
    </div>
  );
}

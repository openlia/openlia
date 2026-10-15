import type { CalendarViewMode } from "./types";

export interface CalendarToolbarProps {
  viewMode: CalendarViewMode;
  onViewModeChange: (mode: CalendarViewMode) => void;
  title: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onNewEvent: () => void;
  onSwitchToEdit?: (() => void) | undefined;
}

export function CalendarToolbar({
  viewMode,
  onViewModeChange,
  title,
  onPrev,
  onNext,
  onToday,
  onNewEvent,
  onSwitchToEdit,
}: CalendarToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-content/10 bg-base-200/50 px-4 py-2 text-sm">
      {/* Left: View Mode Switcher */}
      <div className="flex items-center gap-2">
        <div className="join border border-base-content/15 rounded-lg bg-base-100 p-0.5 shadow-xs">
          <button
            type="button"
            className={`btn btn-xs join-item ${viewMode === "month" ? "btn-primary shadow-xs" : "btn-ghost"}`}
            onClick={() => onViewModeChange("month")}
            aria-pressed={viewMode === "month"}
          >
            Month
          </button>
          <button
            type="button"
            className={`btn btn-xs join-item ${viewMode === "week" ? "btn-primary shadow-xs" : "btn-ghost"}`}
            onClick={() => onViewModeChange("week")}
            aria-pressed={viewMode === "week"}
          >
            Week
          </button>
          <button
            type="button"
            className={`btn btn-xs join-item ${viewMode === "gantt" ? "btn-primary shadow-xs" : "btn-ghost"}`}
            onClick={() => onViewModeChange("gantt")}
            aria-pressed={viewMode === "gantt"}
          >
            Gantt
          </button>
        </div>

        {/* Date Navigation */}
        <div className="join border border-base-content/15 rounded-lg bg-base-100 p-0.5 shadow-xs">
          <button
            type="button"
            className="btn btn-xs btn-ghost join-item"
            onClick={onPrev}
            aria-label="Previous period"
            title="Previous"
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          <button
            type="button"
            className="btn btn-xs btn-ghost join-item px-2 font-medium"
            onClick={onToday}
            title="Jump to today"
          >
            Today
          </button>
          <button
            type="button"
            className="btn btn-xs btn-ghost join-item"
            onClick={onNext}
            aria-label="Next period"
            title="Next"
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>
        </div>

        <h2 className="text-base font-semibold tracking-tight text-base-content ml-1">
          {title}
        </h2>
      </div>

      {/* Right: New Event and raw source shortcut */}
      <div className="flex items-center gap-2">
        {/* New Event Button */}
        <button
          type="button"
          className="btn btn-xs btn-primary gap-1 shadow-xs"
          onClick={onNewEvent}
          title="Add a new event"
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
          <span>New Event</span>
        </button>

        {/* Raw Remind shortcut */}
        {onSwitchToEdit && (
          <button
            type="button"
            className="btn btn-xs btn-ghost text-base-content/60 hover:text-base-content"
            onClick={onSwitchToEdit}
            title="Edit raw Remind syntax in CodeMirror"
          >
            Edit Source
          </button>
        )}
      </div>
    </div>
  );
}

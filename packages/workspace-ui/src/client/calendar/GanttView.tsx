import { useState } from "react";
import { daysBetween } from "./eventInterpretation";
import type { CalendarSource, LogicalEvent } from "./types";

export interface GanttViewProps {
  currentDate: Date;
  events: LogicalEvent[];
  sources: CalendarSource[];
  onSelectEvent: (event: LogicalEvent) => void;
  onNewEventOnDate: (dateIso: string) => void;
}

type GanttRange = 7 | 14 | 30 | 60 | 90;

const RANGE_CONFIG: Record<GanttRange, { label: string; dayWidth: number }> = {
  7: { label: "7 Days", dayWidth: 140 },
  14: { label: "14 Days", dayWidth: 110 },
  30: { label: "1 Month", dayWidth: 70 },
  60: { label: "2 Months", dayWidth: 48 },
  90: { label: "Quarter", dayWidth: 38 },
};

export function GanttView({
  currentDate,
  events,
  sources,
  onSelectEvent,
  onNewEventOnDate: _onNewEventOnDate,
}: GanttViewProps) {
  const [rangeDays, setRangeDays] = useState<GanttRange>(14);

  const todayIso = new Date().toISOString().slice(0, 10);
  const dayWidth = RANGE_CONFIG[rangeDays].dayWidth;

  // Compute start date of Gantt timeline: Monday of current week
  const curr = new Date(
    Date.UTC(
      currentDate.getFullYear(),
      currentDate.getMonth(),
      currentDate.getDate(),
    ),
  );
  let dayOfWeek = curr.getUTCDay();
  if (dayOfWeek === 0) dayOfWeek = 7;
  const startDay = new Date(
    curr.getTime() - (dayOfWeek - 1) * 24 * 60 * 60 * 1000,
  );

  const days = Array.from({ length: rangeDays }, (_, i) => {
    const d = new Date(startDay.getTime() + i * 24 * 60 * 60 * 1000);
    const iso = d.toISOString().slice(0, 10);
    const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
      d.getUTCDay()
    ];
    return {
      date: d,
      iso,
      dayName,
      monthDay: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      isToday: iso === todayIso,
      index: i,
    };
  });

  const startIso = days[0]?.iso ?? "";
  const endIso = days[days.length - 1]?.iso ?? "";

  // Filter events active within this Gantt timeline window
  // (event overlaps [startIso, endIso])
  const visibleEvents = events
    .filter((ev) => ev.startDate <= endIso && ev.endDate >= startIso)
    .sort((a, b) => {
      if (a.startDate !== b.startDate)
        return a.startDate.localeCompare(b.startDate);
      if (a.isRange !== b.isRange) return a.isRange ? -1 : 1;
      return (a.time || "00:00").localeCompare(b.time || "00:00");
    });

  const sourceMap = new Map<string, CalendarSource>();
  for (const src of sources) {
    sourceMap.set(src.path, src);
  }

  const totalWidth = rangeDays * dayWidth;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-base-100">
      {/* Gantt Control Sub-toolbar */}
      <div className="flex items-center justify-between border-b border-base-content/10 bg-base-200/30 px-4 py-1.5 text-xs">
        <span className="font-semibold text-base-content/70">
          Gantt Schedule ({visibleEvents.length} events)
        </span>
        <div className="join border border-base-content/15 rounded-md bg-base-100 p-0.5">
          {([7, 14, 30, 60, 90] as GanttRange[]).map((r) => (
            <button
              key={r}
              type="button"
              className={`btn btn-xs join-item ${
                rangeDays === r ? "btn-primary" : "btn-ghost"
              }`}
              onClick={() => setRangeDays(r)}
            >
              {RANGE_CONFIG[r].label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Gantt Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel: Event Title, Dates & Tags */}
        <div className="w-80 shrink-0 border-r border-base-content/10 flex flex-col bg-base-100 overflow-y-auto">
          {/* Header */}
          <div className="h-12 border-b border-base-content/10 bg-base-200/50 px-3 flex items-center justify-between font-semibold text-xs text-base-content/70">
            <span>Event / Task</span>
            <span className="text-[11px] font-normal text-base-content/50">
              Duration
            </span>
          </div>

          {/* Event Rows */}
          {visibleEvents.length === 0 ? (
            <div className="p-4 text-center text-xs text-base-content/50 italic">
              No events scheduled in this period.
            </div>
          ) : (
            visibleEvents.map((ev) => {
              const src = sourceMap.get(ev.sourceFile);
              const isMultiDay = ev.isRange || ev.durationDays > 1;

              return (
                <button
                  type="button"
                  key={ev.id}
                  className="h-11 border-b border-base-content/5 px-3 flex items-center justify-between gap-2 hover:bg-base-200/50 cursor-pointer transition-colors w-full text-left"
                  onClick={() => onSelectEvent(ev)}
                >
                  <div className="truncate flex flex-col min-w-0">
                    <div className="flex items-center gap-1.5 truncate">
                      <span
                        className={`h-2 w-2 rounded-full shrink-0 ${
                          src?.bgClass || "bg-primary"
                        }`}
                      />
                      <span
                        className="text-xs font-semibold text-base-content truncate"
                        title={ev.title}
                      >
                        {ev.title}
                      </span>
                    </div>

                    {/* Tags preview */}
                    {ev.tags.length > 0 && (
                      <div className="flex items-center gap-1 mt-0.5 truncate pl-3.5">
                        {ev.tags.slice(0, 2).map((tag) => (
                          <span
                            key={tag}
                            className="text-[10px] text-primary/80 font-mono"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="shrink-0 text-right font-mono text-[10px] text-base-content/60">
                    {isMultiDay ? (
                      <span className="badge badge-xs badge-ghost font-mono">
                        {ev.durationDays}d
                      </span>
                    ) : ev.time ? (
                      ev.time
                    ) : (
                      "all day"
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Right Panel: Timeline Header & Horizontal Bars */}
        <div className="flex-1 overflow-x-auto overflow-y-auto relative">
          <div
            style={{ width: `${totalWidth}px` }}
            className="min-h-full flex flex-col"
          >
            {/* Timeline Header (Days) */}
            <div className="h-12 border-b border-base-content/10 bg-base-200/50 flex sticky top-0 z-20">
              {days.map((day) => (
                <div
                  key={day.iso}
                  className={`flex flex-col items-center justify-center border-r border-base-content/10 text-xs shrink-0 ${
                    day.isToday ? "bg-primary/10 font-bold" : ""
                  }`}
                  style={{ width: `${dayWidth}px` }}
                >
                  <span className="text-[10px] opacity-70 uppercase tracking-wide">
                    {day.dayName}
                  </span>
                  <span
                    className={
                      day.isToday ? "text-primary" : "text-base-content"
                    }
                  >
                    {day.monthDay}
                  </span>
                </div>
              ))}
            </div>

            {/* Timeline Grid & Continuous Event Bars */}
            <div className="relative flex-1">
              {/* Vertical Day Lines */}
              <div className="pointer-events-none absolute inset-0 flex z-0">
                {days.map((day) => (
                  <div
                    key={day.iso}
                    className={`border-r border-base-content/5 h-full shrink-0 ${
                      day.isToday ? "bg-primary/[0.02]" : ""
                    }`}
                    style={{ width: `${dayWidth}px` }}
                  />
                ))}
              </div>

              {/* Rows with Continuous Horizontal Bars */}
              {visibleEvents.map((ev) => {
                const rawStartOffset = daysBetween(startIso, ev.startDate);
                const rawEndOffset = daysBetween(startIso, ev.endDate);

                const clampedStartOffset = Math.max(0, rawStartOffset);
                const clampedEndOffset = Math.min(rangeDays - 1, rawEndOffset);

                const spanDays = Math.max(
                  1,
                  clampedEndOffset - clampedStartOffset + 1,
                );

                let leftOffset = clampedStartOffset * dayWidth;
                let barWidth = spanDays * dayWidth - 4;

                const isMultiDay = ev.isRange || ev.durationDays > 1;

                if (!isMultiDay && ev.time) {
                  const parts = ev.time.split(":");
                  const h = parseInt(parts[0] ?? "0", 10) || 0;
                  const m = parseInt(parts[1] ?? "0", 10) || 0;
                  const minutesIntoDay = h * 60 + m;
                  leftOffset += (minutesIntoDay / 1440) * dayWidth;

                  const durMins = ev.duration > 0 ? ev.duration : 60;
                  barWidth = Math.max(28, (durMins / 1440) * dayWidth);
                }

                const continuesPrior = rawStartOffset < 0;
                const continuesAfter = rawEndOffset >= rangeDays;

                const src = sourceMap.get(ev.sourceFile);
                const bg = src?.bgClass || "bg-primary/20";
                const border = src?.borderClass || "border-primary/50";
                const text = src?.textClass || "text-primary";

                return (
                  <div
                    key={ev.id}
                    className="h-11 border-b border-base-content/5 relative flex items-center z-10 px-1"
                  >
                    <button
                      type="button"
                      className={`absolute h-7 border shadow-xs px-2 flex items-center gap-1.5 cursor-pointer hover:shadow-md transition-shadow truncate text-left ${bg} ${border} ${text} ${
                        continuesPrior
                          ? "rounded-l-none border-l-0 pl-1"
                          : "rounded-l-md"
                      } ${
                        continuesAfter
                          ? "rounded-r-none border-r-0 pr-1"
                          : "rounded-r-md"
                      }`}
                      style={{
                        left: `${leftOffset}px`,
                        width: `${barWidth}px`,
                        minWidth: "32px",
                      }}
                      onClick={() => onSelectEvent(ev)}
                      title={`${ev.title} (${ev.startDate}${isMultiDay ? ` → ${ev.endDate}` : ""})`}
                    >
                      {continuesPrior && (
                        <span className="text-[10px] opacity-75 shrink-0">
                          ◀
                        </span>
                      )}
                      {ev.callUrl && (
                        <span className="text-[10px] shrink-0">📹</span>
                      )}
                      <span className="text-xs font-semibold truncate leading-none">
                        {ev.title}
                      </span>
                      {isMultiDay && (
                        <span className="text-[10px] opacity-75 shrink-0 ml-auto font-mono">
                          {ev.durationDays}d
                        </span>
                      )}
                      {continuesAfter && (
                        <span className="text-[10px] opacity-75 shrink-0 ml-1">
                          ▶
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

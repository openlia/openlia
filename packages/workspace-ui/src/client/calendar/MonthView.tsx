import { useEffect, useRef, useState } from "react";
import type { CalendarEvent, CalendarSource } from "./types";

export interface MonthViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  sources: CalendarSource[];
  onSelectEvent: (event: CalendarEvent) => void;
  onNewEventOnDate: (dateIso: string) => void;
}

interface CalendarDay {
  date: Date;
  iso: string;
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  dayEvents: CalendarEvent[];
}

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MIN_WEEK_ROW_HEIGHT = "7rem";
const COMFORTABLE_WEEK_ROW_HEIGHT = 9 * 16;

export function MonthView({
  currentDate,
  events,
  sources,
  onSelectEvent,
  onNewEventOnDate,
}: MonthViewProps) {
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [isCompact, setIsCompact] = useState(true);
  const monthGridRef = useRef<HTMLDivElement>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const todayIso = new Date().toISOString().slice(0, 10);

  // Group events by date (YYYY-MM-DD)
  const eventsByDate = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    if (!eventsByDate.has(ev.date)) {
      eventsByDate.set(ev.date, []);
    }
    eventsByDate.get(ev.date)?.push(ev);
  }

  // Calculate calendar grid days
  const firstDayOfMonth = new Date(Date.UTC(year, month, 1));
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0));

  // Monday = 1, ..., Sunday = 7
  let startWeekday = firstDayOfMonth.getUTCDay();
  if (startWeekday === 0) startWeekday = 7; // Sunday is 7th in Mon-start grid

  const days: CalendarDay[] = [];

  // Leading days from previous month
  const prevMonthLastDay = new Date(Date.UTC(year, month, 0));
  for (let i = startWeekday - 1; i > 0; i--) {
    const d = new Date(
      Date.UTC(year, month - 1, prevMonthLastDay.getUTCDate() - i + 1),
    );
    const iso = d.toISOString().slice(0, 10);
    days.push({
      date: d,
      iso,
      dayNumber: d.getUTCDate(),
      isCurrentMonth: false,
      isToday: iso === todayIso,
      dayEvents: eventsByDate.get(iso) || [],
    });
  }

  // Days in current month
  for (let i = 1; i <= lastDayOfMonth.getUTCDate(); i++) {
    const d = new Date(Date.UTC(year, month, i));
    const iso = d.toISOString().slice(0, 10);
    days.push({
      date: d,
      iso,
      dayNumber: i,
      isCurrentMonth: true,
      isToday: iso === todayIso,
      dayEvents: eventsByDate.get(iso) || [],
    });
  }

  // Trailing days to fill 35 or 42 grid cells
  const remaining = (7 - (days.length % 7)) % 7;
  for (let i = 1; i <= remaining; i++) {
    const d = new Date(Date.UTC(year, month + 1, i));
    const iso = d.toISOString().slice(0, 10);
    days.push({
      date: d,
      iso,
      dayNumber: d.getUTCDate(),
      isCurrentMonth: false,
      isToday: iso === todayIso,
      dayEvents: eventsByDate.get(iso) || [],
    });
  }

  const weekCount = days.length / 7;

  useEffect(() => {
    const monthGrid = monthGridRef.current;
    if (!monthGrid || typeof ResizeObserver === "undefined") return;

    const updateDensity = () => {
      setIsCompact(
        monthGrid.clientHeight / weekCount < COMFORTABLE_WEEK_ROW_HEIGHT,
      );
    };

    updateDensity();
    const observer = new ResizeObserver(updateDensity);
    observer.observe(monthGrid);

    return () => observer.disconnect();
  }, [weekCount]);

  const sourceMap = new Map<string, CalendarSource>();
  for (const src of sources) {
    sourceMap.set(src.path, src);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-base-100">
      {/* Weekday Header */}
      <div className="grid shrink-0 grid-cols-7 border-b border-base-content/10 bg-base-200/40 text-center text-xs font-semibold text-base-content/70">
        {WEEKDAY_NAMES.map((name) => (
          <div key={name} className="py-2">
            {name}
          </div>
        ))}
      </div>

      {/* Month Days Grid */}
      <div
        ref={monthGridRef}
        data-calendar-month-grid
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        <div
          className="grid min-h-full grid-cols-7 divide-x divide-y divide-base-content/10"
          style={{
            gridTemplateRows: `repeat(${weekCount}, minmax(${MIN_WEEK_ROW_HEIGHT}, 1fr))`,
          }}
        >
          {days.map((day) => {
            const maxVisible = isCompact ? 2 : 3;
            const hasOverflow = day.dayEvents.length > maxVisible;
            const visibleEvents = day.dayEvents.slice(0, maxVisible);

            return (
              <div
                key={day.iso}
                className={`group relative flex min-h-0 min-w-0 flex-col p-1.5 transition-colors hover:bg-base-200/30 ${
                  !day.isCurrentMonth
                    ? "bg-base-200/20 text-base-content/40"
                    : "bg-base-100"
                }`}
              >
                {/* Day Header */}
                <div className="flex items-center justify-between">
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                      day.isToday
                        ? "bg-primary text-primary-content"
                        : day.isCurrentMonth
                          ? "text-base-content"
                          : "text-base-content/40"
                    }`}
                  >
                    {day.dayNumber}
                  </span>

                  <button
                    type="button"
                    className="btn btn-ghost btn-xs h-5 w-5 min-h-0 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    title={`Add event on ${day.iso}`}
                    aria-label={`Add event on ${day.iso}`}
                    onClick={() => onNewEventOnDate(day.iso)}
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
                  </button>
                </div>

                {/* Day Events */}
                <div className="mt-1 flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
                  {visibleEvents.map((ev) => {
                    const src = sourceMap.get(ev.sourceFile);
                    const bg = src?.bgClass || "bg-primary/20";
                    const border = src?.borderClass || "border-primary/40";
                    const text = src?.textClass || "text-primary";

                    return (
                      <button
                        key={ev.id}
                        type="button"
                        className={`flex min-w-0 w-full shrink-0 items-center gap-1 truncate rounded px-1.5 py-0.5 text-left text-xs font-medium border ${bg} ${border} ${text} hover:opacity-80 transition-opacity`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectEvent(ev);
                        }}
                        title={`${ev.time ? `${ev.time} - ` : ""}${ev.summary}`}
                      >
                        {ev.callUrl && (
                          <span
                            title="Video Meeting"
                            className="shrink-0 text-[10px]"
                          >
                            📹
                          </span>
                        )}
                        {ev.location && !ev.callUrl && (
                          <span
                            title="Physical Location"
                            className="shrink-0 text-[10px]"
                          >
                            📍
                          </span>
                        )}
                        {ev.time && (
                          <span className="shrink-0 font-bold opacity-80">
                            {ev.time}
                          </span>
                        )}
                        <span className="min-w-0 truncate">{ev.summary}</span>
                      </button>
                    );
                  })}

                  {/* Overflow chip */}
                  {hasOverflow && (
                    <button
                      type="button"
                      className="shrink-0 px-1 text-left text-[11px] font-semibold text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedDate(
                          expandedDate === day.iso ? null : day.iso,
                        );
                      }}
                    >
                      +{day.dayEvents.length - maxVisible} more
                    </button>
                  )}
                </div>

                {/* Day Overflow Popover */}
                {expandedDate === day.iso && (
                  <div className="absolute inset-x-1 top-8 z-30 flex flex-col gap-1 rounded-box bg-base-100 p-2 shadow-xl border border-base-content/20 max-h-48 overflow-y-auto">
                    <div className="flex items-center justify-between border-b border-base-content/10 pb-1 mb-1">
                      <span className="text-xs font-semibold text-base-content">
                        {day.iso}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs h-4 w-4 min-h-0 p-0"
                        onClick={() => setExpandedDate(null)}
                      >
                        ✕
                      </button>
                    </div>
                    {day.dayEvents.map((ev) => (
                      <button
                        key={ev.id}
                        type="button"
                        className="flex items-center gap-1.5 rounded p-1 text-left text-xs hover:bg-base-200"
                        onClick={() => {
                          setExpandedDate(null);
                          onSelectEvent(ev);
                        }}
                      >
                        {ev.callUrl && <span>📹</span>}
                        {ev.time && (
                          <span className="font-bold">{ev.time}</span>
                        )}
                        <span className="truncate font-medium">
                          {ev.summary}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

import { useRef, useState } from "react";
import { daysBetween, eventSpansDate } from "./eventInterpretation";
import type { CalendarSource, LogicalEvent } from "./types";

export interface MonthViewProps {
  currentDate: Date;
  events: LogicalEvent[];
  sources: CalendarSource[];
  onSelectEvent: (event: LogicalEvent) => void;
  onNewEventOnDate: (dateIso: string) => void;
}

interface CalendarDay {
  date: Date;
  iso: string;
  dayNumber: number;
  dayOfWeekIndex: number; // 0 = Mon, ..., 6 = Sun
  isCurrentMonth: boolean;
  isToday: boolean;
}

interface WeekEventSegment {
  event: LogicalEvent;
  colStart: number; // 1 to 7
  colSpan: number; // 1 to 7
  continuesPrior: boolean;
  continuesAfter: boolean;
  track: number; // 1-indexed track
}

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MIN_WEEK_ROW_HEIGHT = "7rem";
const MAX_VISIBLE_TRACKS = 2;

export function MonthView({
  currentDate,
  events,
  sources,
  onSelectEvent,
  onNewEventOnDate,
}: MonthViewProps) {
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const monthGridRef = useRef<HTMLDivElement>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const todayIso = new Date().toISOString().slice(0, 10);

  // Source map for color badges
  const sourceMap = new Map<string, CalendarSource>();
  for (const src of sources) {
    sourceMap.set(src.path, src);
  }

  // Calculate calendar grid days
  const firstDayOfMonth = new Date(Date.UTC(year, month, 1));
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0));

  let startWeekday = firstDayOfMonth.getUTCDay();
  if (startWeekday === 0) startWeekday = 7; // Monday = 1 ... Sunday = 7

  const days: CalendarDay[] = [];

  // Trailing days from previous month
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
      dayOfWeekIndex: (d.getUTCDay() + 6) % 7,
      isCurrentMonth: false,
      isToday: iso === todayIso,
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
      dayOfWeekIndex: (d.getUTCDay() + 6) % 7,
      isCurrentMonth: true,
      isToday: iso === todayIso,
    });
  }

  // Leading days to fill grid
  const remaining = (7 - (days.length % 7)) % 7;
  for (let i = 1; i <= remaining; i++) {
    const d = new Date(Date.UTC(year, month + 1, i));
    const iso = d.toISOString().slice(0, 10);
    days.push({
      date: d,
      iso,
      dayNumber: d.getUTCDate(),
      dayOfWeekIndex: (d.getUTCDay() + 6) % 7,
      isCurrentMonth: false,
      isToday: iso === todayIso,
    });
  }

  // Split into weeks of 7 days
  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }

  // Helper to get all events active on a specific date
  const getEventsForDate = (dateIso: string): LogicalEvent[] => {
    return events.filter((ev) => eventSpansDate(ev, dateIso));
  };

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

      {/* Month Weeks Grid */}
      <div
        ref={monthGridRef}
        data-calendar-month-grid
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        <div
          className="grid min-h-full divide-y divide-base-content/10"
          style={{
            gridTemplateRows: `repeat(${weeks.length}, minmax(${MIN_WEEK_ROW_HEIGHT}, 1fr))`,
          }}
        >
          {weeks.map((week) => {
            const weekStartDay = week[0];
            const weekEndDay = week[6];
            if (!weekStartDay || !weekEndDay) return null;

            const weekStartIso = weekStartDay.iso;
            const weekEndIso = weekEndDay.iso;

            // Events active in this week
            const weekActiveEvents = events.filter(
              (ev) => ev.startDate <= weekEndIso && ev.endDate >= weekStartIso,
            );

            // Sort: Multi-day ranges first (longer first), then by start date
            const sortedWeekEvents = [...weekActiveEvents].sort((a, b) => {
              if (a.isRange !== b.isRange) return a.isRange ? -1 : 1;
              if (a.durationDays !== b.durationDays) {
                return b.durationDays - a.durationDays;
              }
              if (a.startDate !== b.startDate) {
                return a.startDate.localeCompare(b.startDate);
              }
              return (a.time || "").localeCompare(b.time || "");
            });

            // Track allocation
            const occupiedTracks: boolean[][] = [];
            const segments: WeekEventSegment[] = [];

            for (const ev of sortedWeekEvents) {
              const segStartIso =
                ev.startDate < weekStartIso ? weekStartIso : ev.startDate;
              const segEndIso =
                ev.endDate > weekEndIso ? weekEndIso : ev.endDate;

              const startDayOffset = Math.max(
                0,
                daysBetween(weekStartIso, segStartIso),
              );
              const endDayOffset = Math.min(
                6,
                daysBetween(weekStartIso, segEndIso),
              );

              const colStart = startDayOffset + 1; // 1-indexed
              const colSpan = Math.max(1, endDayOffset - startDayOffset + 1);

              // Find lowest available track
              let track = 1;
              while (true) {
                if (!occupiedTracks[track]) {
                  occupiedTracks[track] = Array(7).fill(false);
                }
                let trackFree = true;
                for (let c = startDayOffset; c <= endDayOffset; c++) {
                  if (occupiedTracks[track]?.[c]) {
                    trackFree = false;
                    break;
                  }
                }
                if (trackFree) {
                  for (let c = startDayOffset; c <= endDayOffset; c++) {
                    const row = occupiedTracks[track];
                    if (row) row[c] = true;
                  }
                  break;
                }
                track++;
              }

              segments.push({
                event: ev,
                colStart,
                colSpan,
                continuesPrior: ev.startDate < weekStartIso,
                continuesAfter: ev.endDate > weekEndIso,
                track,
              });
            }

            // Visible segments and overflow per day
            const visibleSegments = segments.filter(
              (seg) => seg.track <= MAX_VISIBLE_TRACKS,
            );

            return (
              <div
                key={`week-${weekStartIso}`}
                className="relative flex flex-col min-h-[4.5rem] sm:min-h-[7rem] min-w-0"
              >
                {/* Background 7 Day Cells */}
                <div className="absolute inset-0 grid grid-cols-7 divide-x divide-base-content/10 pointer-events-none">
                  {week.map((day) => (
                    <div
                      key={day.iso}
                      className={`h-full ${
                        !day.isCurrentMonth
                          ? "bg-base-200/20 text-base-content/40"
                          : "bg-base-100"
                      } ${day.isToday ? "bg-primary/[0.03]" : ""}`}
                    />
                  ))}
                </div>

                {/* Day Numbers & Quick Add Row */}
                <div className="relative z-10 grid grid-cols-7 px-1 pt-1 shrink-0">
                  {week.map((day) => (
                    <div
                      key={day.iso}
                      className="group flex items-center justify-between px-1"
                    >
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
                  ))}
                </div>

                {/* Event Bars Overlay Grid */}
                <div
                  className="relative z-10 grid grid-cols-7 gap-x-1 gap-y-1 p-1 min-h-0 flex-1 content-start"
                  style={{
                    gridTemplateRows: `repeat(${MAX_VISIBLE_TRACKS}, minmax(1.25rem, auto))`,
                  }}
                >
                  {visibleSegments.map((seg) => {
                    const ev = seg.event;
                    const src = sourceMap.get(ev.sourceFile);
                    const bg = src?.bgClass || "bg-primary/20";
                    const border = src?.borderClass || "border-primary/40";
                    const text = src?.textClass || "text-primary";

                    const isMultiDay = ev.isRange || ev.durationDays > 1;

                    return (
                      <button
                        key={`${ev.id}_w_${weekStartIso}`}
                        type="button"
                        style={{
                          gridColumn: `${seg.colStart} / span ${seg.colSpan}`,
                          gridRow: seg.track,
                        }}
                        className={`flex shrink-0 min-w-0 items-center gap-1 truncate px-1.5 py-0.5 text-left text-xs font-medium border shadow-2xs hover:opacity-85 transition-opacity cursor-pointer ${bg} ${border} ${text} ${
                          seg.continuesPrior
                            ? "rounded-l-none border-l-0 pl-1"
                            : "rounded-l"
                        } ${
                          seg.continuesAfter
                            ? "rounded-r-none border-r-0 pr-1"
                            : "rounded-r"
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectEvent(ev);
                        }}
                        title={`${ev.title} (${ev.startDate}${isMultiDay ? ` → ${ev.endDate}` : ""})`}
                      >
                        {seg.continuesPrior && (
                          <span
                            className="text-[10px] opacity-75 shrink-0"
                            title="Continues from previous week"
                          >
                            ◀
                          </span>
                        )}
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
                            title="Location"
                            className="shrink-0 text-[10px]"
                          >
                            📍
                          </span>
                        )}
                        {ev.time && (
                          <span className="hidden sm:inline shrink-0 font-bold opacity-80">
                            {ev.time}
                          </span>
                        )}
                        <span className="min-w-0 truncate font-medium">
                          {ev.title}
                        </span>
                        {seg.continuesAfter && (
                          <span
                            className="text-[10px] opacity-75 shrink-0 ml-auto"
                            title="Continues next week"
                          >
                            ▶
                          </span>
                        )}
                      </button>
                    );
                  })}

                  {/* Overflow "+N more" buttons for days having track > MAX_VISIBLE_TRACKS */}
                  {week.map((day, colIndex) => {
                    const dayEvents = getEventsForDate(day.iso);
                    if (dayEvents.length <= MAX_VISIBLE_TRACKS) return null;
                    const overflowCount = dayEvents.length - MAX_VISIBLE_TRACKS;

                    return (
                      <div
                        key={`more-${day.iso}`}
                        style={{
                          gridColumn: colIndex + 1,
                          gridRow: MAX_VISIBLE_TRACKS + 1,
                        }}
                        className="relative"
                      >
                        <button
                          type="button"
                          className="px-1 text-left text-[11px] font-semibold text-primary hover:underline cursor-pointer"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedDate(
                              expandedDate === day.iso ? null : day.iso,
                            );
                          }}
                        >
                          +{overflowCount} more
                        </button>

                        {/* Day Overflow Popover */}
                        {expandedDate === day.iso && (
                          <div className="absolute left-0 top-6 z-40 flex flex-col gap-1 rounded-box bg-base-100 p-2 shadow-2xl border border-base-content/20 w-56 max-h-52 overflow-y-auto">
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
                            {dayEvents.map((ev) => (
                              <button
                                key={`pop_${ev.id}`}
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
                                  {ev.title}
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
            );
          })}
        </div>
      </div>
    </div>
  );
}

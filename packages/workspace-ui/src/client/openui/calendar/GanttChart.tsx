import { defineComponent } from "@openuidev/react-lang";
import { useEffect, useState } from "react";
import {
  addDays,
  calendarOpenUIProps,
  dateInZone,
  defaultCalendarDate,
  type InlineCalendarEvent,
  type TimelineItem,
  timeInZone,
  validDate,
  validTimezone,
} from "../../../shared/calendar";
import { CalendarView } from "./Calendar";
import { CalendarNavigation } from "./CalendarNavigation";
import { useCalendar } from "./context";
import { shiftMonth, timelineCoordinate, weekDays } from "./layout";

export function GanttChartTimeline({
  title = "Timeline",
  items,
  timezone: configuredTimezone,
  date: configuredDate,
  zoom = "week",
  groupBy = "none",
}: {
  title?: string | undefined;
  items?: TimelineItem[] | undefined;
  timezone?: string | undefined;
  date?: string | undefined;
  zoom?: "day" | "week" | "month" | undefined;
  groupBy?: "none" | "source" | "location" | "group" | undefined;
}) {
  const calendar = useCalendar();
  const timezone =
    configuredTimezone && validTimezone(configuredTimezone)
      ? configuredTimezone
      : (calendar?.timezone ?? "UTC");
  const initialItems = items ?? calendar?.timelineItems;
  const [localDate, setLocalDate] = useState(() =>
    defaultCalendarDate(
      initialItems?.map((item) => ({
        start: item.start,
        allDay: validDate(item.start),
      })),
      timezone,
      configuredDate,
    ),
  );
  const [scale, setScale] = useState(zoom ?? "week");
  const [selected, setSelected] = useState<TimelineItem | null>(null);

  useEffect(() => {
    if (zoom) setScale(zoom);
  }, [zoom]);

  const date = calendar?.date ?? localDate;
  const navigate = calendar?.navigate ?? setLocalDate;
  const first =
    scale === "month"
      ? `${date.slice(0, 7)}-01`
      : scale === "week"
        ? (weekDays(date)[0] as string)
        : date;
  const last =
    scale === "month"
      ? shiftMonth(first, 1)
      : addDays(first, scale === "week" ? 7 : 1);
  const coordinate = (value: string) => timelineCoordinate(value, timezone);
  let begin: number;
  let finish: number;
  try {
    begin = coordinate(first);
    finish = coordinate(last);
  } catch {
    return (
      <p role="alert">
        This timeline range has an ambiguous or nonexistent midnight. Choose UTC
        as the display timezone.
      </p>
    );
  }
  const duration = finish - begin;
  const timeline: TimelineItem[] =
    initialItems ??
    (calendar?.events ?? []).map((event) => ({
      id: event.occurrenceId,
      title: event.title,
      start: event.start,
      end: event.end,
      group:
        groupBy === "source"
          ? "sourcePath" in event
            ? event.sourcePath
            : "Inline events"
          : groupBy === "location"
            ? (event.location ?? "No location")
            : groupBy === "group"
              ? (event.group ?? undefined)
              : undefined,
    }));
  const coordinates = new Map<
    string,
    {
      rawStart: number;
      rawEnd: number;
      visualStart: number;
      visualEnd: number;
      isDateOnly: boolean;
      timeRangeLabel?: string | undefined;
      startTimeLabel?: string | undefined;
    }
  >();
  try {
    for (const item of timeline) {
      const rawStart = coordinate(item.start);
      const rawEnd = coordinate(item.end);
      if (
        !Number.isFinite(rawStart) ||
        !Number.isFinite(rawEnd) ||
        rawEnd < rawStart
      )
        throw new Error("Invalid timeline item");
      const isDateOnly = validDate(item.start) && validDate(item.end);
      let visualStart = rawStart;
      let visualEnd = rawEnd;
      if (scale !== "day" && !isDateOnly) {
        const startDay = dateInZone(rawStart, timezone);
        const endDay = addDays(
          dateInZone(Math.max(rawStart, rawEnd - 1), timezone),
          1,
        );
        visualStart = coordinate(startDay);
        visualEnd = coordinate(endDay);
      }
      const startTimeLabel = isDateOnly
        ? undefined
        : timeInZone(rawStart, timezone);
      const timeRangeLabel = isDateOnly
        ? undefined
        : `${timeInZone(rawStart, timezone)}–${timeInZone(rawEnd, timezone)}`;
      coordinates.set(item.id, {
        rawStart,
        rawEnd,
        visualStart,
        visualEnd,
        isDateOnly,
        timeRangeLabel,
        startTimeLabel,
      });
    }
  } catch {
    return (
      <p role="alert">
        Timeline items need valid date-only ranges or offset-bearing timestamps
        with end at or after start.
      </p>
    );
  }
  const visible = timeline
    .filter(
      (item) =>
        (coordinates.get(item.id)?.rawStart ?? finish) < finish &&
        (coordinates.get(item.id)?.rawEnd ?? begin) >= begin,
    )
    .sort(
      (a, b) =>
        (a.group ?? "").localeCompare(b.group ?? "") ||
        a.start.localeCompare(b.start),
    );
  const ticks =
    scale === "day"
      ? Math.ceil(duration / 3600000)
      : Math.round((Date.parse(last) - Date.parse(first)) / 86400000);
  let tickLabels: Array<{
    instant: number;
    width: number;
    label: string;
    detail: string;
    dayDate?: string | undefined;
  }>;
  try {
    tickLabels = Array.from({ length: ticks }, (_, index) => {
      const dayDate = scale === "day" ? undefined : addDays(first, index);
      const instant =
        scale === "day"
          ? begin + index * 3600000
          : coordinate(dayDate as string);
      const next =
        scale === "day"
          ? Math.min(finish, instant + 3600000)
          : coordinate(addDays(first, index + 1));
      return {
        instant,
        width: ((next - instant) / duration) * 100,
        label:
          scale === "day"
            ? timeInZone(instant, timezone)
            : String(Number((dayDate as string).slice(-2))),
        detail: new Intl.DateTimeFormat("en-GB", {
          timeZone: timezone,
          dateStyle: "short",
          timeStyle: "long",
        }).format(new Date(instant)),
        dayDate,
      };
    });
  } catch {
    return (
      <p role="alert">
        This timeline includes an ambiguous or nonexistent midnight. Choose UTC
        as the display timezone.
      </p>
    );
  }

  const handleSelectItem = (item: TimelineItem) => {
    const event =
      !initialItems &&
      calendar?.events.find((ev) => ev.occurrenceId === item.id);
    if (event) calendar?.select(event);
    else setSelected(item);
  };

  return (
    <section
      aria-label="Event duration timeline"
      aria-busy={calendar?.loading}
      className={
        calendar
          ? ""
          : "rounded-xl border border-base-content/10 p-4 space-y-3 min-w-0"
      }
    >
      <CalendarNavigation
        title={title}
        date={date}
        timezone={timezone}
        period={scale}
        navigate={navigate}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <label className="text-xs flex items-center gap-2">
          <span>Timeline zoom</span>
          <select
            className="select select-bordered select-sm"
            value={scale}
            onChange={(event) => setScale(event.target.value as typeof scale)}
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </label>
        {scale !== "day" && (
          <p className="text-xs opacity-60">
            Tip: Click any day number in the header to drill into Day view, or
            click any row for details.
          </p>
        )}
      </div>
      <div className="overflow-x-auto border border-base-content/10 rounded-lg">
        <div style={{ minWidth: scale === "month" ? 1000 : 680 }}>
          <div className="flex border-b border-base-content/10 text-[10px] bg-base-200/30">
            <div className="w-48 shrink-0 p-2 font-semibold">Event</div>
            <div className="flex flex-1">
              {tickLabels.map((tick) =>
                tick.dayDate ? (
                  <button
                    key={tick.instant}
                    type="button"
                    aria-label={`Zoom to ${tick.dayDate}`}
                    title={`View ${tick.dayDate} in Day zoom (${tick.detail})`}
                    style={{ width: `${tick.width}%` }}
                    className="shrink-0 border-l border-base-content/10 py-2 text-center font-medium hover:bg-primary/15 hover:text-primary transition-colors cursor-pointer"
                    onClick={() => {
                      navigate(tick.dayDate as string);
                      setScale("day");
                    }}
                  >
                    {tick.label}
                  </button>
                ) : (
                  <span
                    key={tick.instant}
                    title={tick.detail}
                    style={{ width: `${tick.width}%` }}
                    className="shrink-0 border-l border-base-content/10 py-2 text-center"
                  >
                    {tick.label}
                  </span>
                ),
              )}
            </div>
          </div>
          {!visible.length && (
            <p className="p-4 text-sm opacity-70">No events in this range.</p>
          )}
          {visible.map((item, index) => {
            const coord = coordinates.get(item.id);
            if (!coord) return null;
            const { visualStart, visualEnd, timeRangeLabel, startTimeLabel } =
              coord;
            const left = Math.max(0, ((visualStart - begin) / duration) * 100);
            const rawWidth =
              ((Math.min(finish, visualEnd) - Math.max(begin, visualStart)) /
                duration) *
              100;
            const width = Math.min(Math.max(1.5, rawWidth), 100 - left);
            const showFullTextInsideBar = width >= 22;
            const showStartTimeInsidePill =
              !showFullTextInsideBar &&
              scale === "week" &&
              width >= 10 &&
              Boolean(startTimeLabel);
            const placeCalloutOnLeft = left + width > 68;
            const fullLabel = timeRangeLabel
              ? `${timeRangeLabel} · ${item.title}`
              : item.title;
            const isSelected = selected?.id === item.id;
            const group = item.group;

            return (
              <div key={item.id}>
                {group && group !== visible[index - 1]?.group && (
                  <h4 className="bg-base-200 p-2 text-xs font-semibold">
                    {group}
                  </h4>
                )}
                <div
                  className={`group flex border-b border-base-content/10 min-h-11 transition-colors hover:bg-base-200/40 ${isSelected ? "bg-primary/10" : ""}`}
                >
                  <button
                    type="button"
                    className="w-48 shrink-0 p-2 text-left text-xs hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 cursor-pointer"
                    title={`${item.title} (${item.start} – ${item.end})`}
                    onClick={() => handleSelectItem(item)}
                  >
                    <span className="block truncate font-medium">
                      {item.title}
                    </span>
                    {timeRangeLabel && (
                      <span className="block truncate text-[10px] opacity-65">
                        {timeRangeLabel}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Open ${item.title}`}
                    title={`${item.title}: ${item.start} – ${item.end}`}
                    className="flex-1 relative min-h-11 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
                    onClick={() => handleSelectItem(item)}
                  >
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 flex"
                    >
                      {tickLabels.map((tick) => (
                        <span
                          key={tick.instant}
                          style={{ width: `${tick.width}%` }}
                          className="shrink-0 border-l border-base-content/10 h-full"
                        />
                      ))}
                    </span>
                    <span
                      className="absolute top-1/2 -translate-y-1/2 h-6 min-w-[28px] rounded-md bg-primary/75 group-hover:bg-primary text-primary-content text-xs font-medium flex items-center justify-center px-2 shadow-sm transition-colors overflow-hidden"
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                      }}
                    >
                      {showFullTextInsideBar ? (
                        <span className="truncate">{fullLabel}</span>
                      ) : showStartTimeInsidePill ? (
                        <span className="text-[11px] font-semibold tracking-tight">
                          {startTimeLabel}
                        </span>
                      ) : null}
                    </span>
                    {!showFullTextInsideBar && (
                      <span
                        className="absolute top-1/2 -translate-y-1/2 text-xs text-base-content/90 group-hover:text-base-content font-medium whitespace-nowrap truncate max-w-[55%] px-2 py-0.5 rounded bg-base-100/85 pointer-events-none"
                        style={
                          placeCalloutOnLeft
                            ? { right: `${100 - left + 0.8}%` }
                            : { left: `${left + width + 0.8}%` }
                        }
                      >
                        {fullLabel}
                      </span>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {selected && (
        <aside
          className="mt-3 rounded-xl border border-base-content/15 bg-base-200/30 p-3.5 flex items-start justify-between gap-3"
          aria-label="Timeline item details"
        >
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold text-sm">{selected.title}</h4>
              {selected.group && (
                <span className="badge badge-ghost badge-xs">
                  {selected.group}
                </span>
              )}
            </div>
            <p className="text-xs text-base-content/70 font-mono">
              {selected.start} – {selected.end}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close details"
            title="Close details"
            className="btn btn-ghost btn-xs btn-circle shrink-0 text-base-content/70 hover:text-base-content"
            onClick={() => setSelected(null)}
          >
            <svg
              aria-hidden="true"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                d="M6 18L18 6M6 6l12 12"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </aside>
      )}
    </section>
  );
}

export function GanttChartView({
  title = "Timeline",
  items,
  events,
  source,
  timezone,
  date,
  zoom = "week",
  groupBy = "none",
}: {
  title?: string | null | undefined;
  items?: TimelineItem[] | null | undefined;
  events?: InlineCalendarEvent[] | null | undefined;
  source?: string | null | undefined;
  timezone?: string | null | undefined;
  date?: string | null | undefined;
  zoom?: "day" | "week" | "month" | null | undefined;
  groupBy?: "none" | "source" | "location" | "group" | null | undefined;
}) {
  const hasSourceOrEvents =
    (source !== undefined && source !== null) ||
    (events !== undefined && events !== null);
  if (hasSourceOrEvents) {
    return (
      <CalendarView
        source={source ?? undefined}
        timezone={timezone ?? undefined}
        date={date ?? undefined}
        events={events ?? undefined}
      >
        <GanttChartTimeline
          title={title ?? "Timeline"}
          items={items ?? undefined}
          timezone={timezone ?? undefined}
          date={date ?? undefined}
          zoom={zoom ?? "week"}
          groupBy={groupBy ?? "none"}
        />
      </CalendarView>
    );
  }
  return (
    <GanttChartTimeline
      title={title ?? "Timeline"}
      items={items ?? undefined}
      timezone={timezone ?? undefined}
      date={date ?? undefined}
      zoom={zoom ?? "week"}
      groupBy={groupBy ?? "none"}
    />
  );
}

export const CalendarGantt = defineComponent({
  name: "CalendarGantt",
  description:
    "Gantt / event-duration timeline view with day/week/month zoom. Supports inline items/events, external .rem/.json source files, or nesting inside Calendar.",
  props: calendarOpenUIProps.CalendarGantt,
  component: ({ props }) => <GanttChartView {...props} />,
});

export const GanttChart = defineComponent({
  name: "GanttChart",
  description:
    "Event-duration timeline with day/week/month zoom (alias for CalendarGantt).",
  props: calendarOpenUIProps.GanttChart,
  component: ({ props }) => <GanttChartView {...props} />,
});

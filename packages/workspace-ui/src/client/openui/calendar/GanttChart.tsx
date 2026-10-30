import { defineComponent } from "@openuidev/react-lang";
import { useState } from "react";
import {
  addDays,
  calendarOpenUIProps,
  dateInZone,
  timeInZone,
} from "../../../shared/calendar";
import { CalendarNavigation } from "./CalendarNavigation";
import { useCalendar } from "./context";
import { shiftMonth, timelineCoordinate, weekDays } from "./layout";

interface TimelineItem {
  id: string;
  title: string;
  start: string;
  end: string;
  group?: string | undefined;
}

export function GanttChartView({
  title = "Timeline",
  items,
  zoom = "week",
  groupBy = "none",
}: {
  title?: string | undefined;
  items?: TimelineItem[] | undefined;
  zoom?: "day" | "week" | "month" | undefined;
  groupBy?: "none" | "source" | "location" | undefined;
}) {
  const calendar = useCalendar();
  const timezone = calendar?.timezone ?? "UTC";
  const [localDate, setLocalDate] = useState(dateInZone(Date.now(), timezone));
  const [scale, setScale] = useState(zoom);
  const [selected, setSelected] = useState<TimelineItem | null>(null);
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
    items ??
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
            : undefined,
    }));
  const coordinates = new Map<string, { start: number; end: number }>();
  try {
    for (const item of timeline) {
      const start = coordinate(item.start);
      const end = coordinate(item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
        throw new Error("Invalid timeline item");
      coordinates.set(item.id, { start, end });
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
        (coordinates.get(item.id)?.start ?? finish) < finish &&
        (coordinates.get(item.id)?.end ?? begin) >= begin,
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
  }>;
  try {
    tickLabels = Array.from({ length: ticks }, (_, index) => {
      const instant =
        scale === "day"
          ? begin + index * 3600000
          : coordinate(addDays(first, index));
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
            : String(Number(addDays(first, index).slice(-2))),
        detail: new Intl.DateTimeFormat("en-GB", {
          timeZone: timezone,
          dateStyle: "short",
          timeStyle: "long",
        }).format(new Date(instant)),
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
  return (
    <section aria-label="Event duration timeline" aria-busy={calendar?.loading}>
      <CalendarNavigation
        title={title}
        date={date}
        timezone={timezone}
        period={scale}
        navigate={navigate}
      />
      <label className="text-xs">
        Timeline zoom{" "}
        <select
          className="select select-bordered select-sm ml-2 mb-3"
          value={scale}
          onChange={(event) => setScale(event.target.value as typeof scale)}
        >
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </select>
      </label>
      <div className="overflow-x-auto border border-base-content/10 rounded-lg">
        <div style={{ minWidth: scale === "month" ? 1000 : 640 }}>
          <div className="flex border-b border-base-content/10 text-[10px]">
            <div className="w-44 shrink-0 p-2">Event</div>
            <div className="flex flex-1">
              {tickLabels.map((tick) => (
                <span
                  key={tick.instant}
                  title={tick.detail}
                  style={{ width: `${tick.width}%` }}
                  className="shrink-0 border-l border-base-content/10 py-2 text-center"
                >
                  {tick.label}
                </span>
              ))}
            </div>
          </div>
          {!visible.length && (
            <p className="p-4 text-sm opacity-70">No events in this range.</p>
          )}
          {visible.map((item, index) => {
            const { start, end } = coordinates.get(item.id) as {
              start: number;
              end: number;
            };
            const left = Math.max(0, ((start - begin) / duration) * 100);
            const width = Math.max(
              0.4,
              ((Math.min(finish, end) - Math.max(begin, start)) / duration) *
                100,
            );
            const group = item.group;
            return (
              <div key={item.id}>
                {group && group !== visible[index - 1]?.group && (
                  <h4 className="bg-base-200 p-2 text-xs font-semibold">
                    {group}
                  </h4>
                )}
                <div className="flex border-b border-base-content/10 min-h-10">
                  <span
                    className="w-44 shrink-0 truncate p-2 text-xs"
                    title={item.title}
                  >
                    {item.title}
                  </span>
                  <div className="flex-1 relative">
                    <button
                      type="button"
                      aria-label={`Open ${item.title}`}
                      title={`${item.title}: ${item.start} – ${item.end}`}
                      className="absolute top-2 h-6 rounded bg-primary/60 hover:bg-primary text-primary-content text-xs overflow-hidden px-1"
                      style={{
                        left: `${left}%`,
                        width: `${Math.min(width, 100 - left)}%`,
                      }}
                      onClick={() => {
                        const event =
                          !items &&
                          calendar?.events.find(
                            (event) => event.occurrenceId === item.id,
                          );
                        if (event) calendar?.select(event);
                        else setSelected(item);
                      }}
                    >
                      {item.title}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {selected && (
        <aside
          className="mt-3 border border-base-content/10 rounded-lg p-3"
          aria-label="Timeline item details"
        >
          <h4 className="font-semibold">{selected.title}</h4>
          <p>
            {selected.start} – {selected.end}
          </p>
          <button
            type="button"
            className="btn btn-sm mt-2"
            onClick={() => setSelected(null)}
          >
            Close details
          </button>
        </aside>
      )}
    </section>
  );
}

export const GanttChart = defineComponent({
  name: "GanttChart",
  description:
    "Event-duration timeline with day/week/month zoom; no dependencies or progress tracking",
  props: calendarOpenUIProps.GanttChart,
  component: ({ props }) => <GanttChartView {...props} />,
});

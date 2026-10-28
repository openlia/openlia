import { defineComponent } from "@openuidev/react-lang";
import { calendarOpenUIProps, timeInZone } from "../../../shared/calendar";
import { CalendarNavigation } from "./CalendarNavigation";
import { useCalendar } from "./context";
import { onDay, weekBlocks, weekDays } from "./layout";

export function CalendarWeekView({
  title = "Week",
}: {
  title?: string | undefined;
}) {
  const calendar = useCalendar();
  if (!calendar)
    return <p role="alert">CalendarWeek must be inside Calendar.</p>;
  const { events, date, timezone, navigate, select, loading } = calendar;
  const days = weekDays(date);
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  return (
    <section aria-label="Week calendar" aria-busy={loading}>
      <CalendarNavigation
        title={title}
        date={date}
        timezone={timezone}
        period="week"
        navigate={navigate}
      />
      <p className="text-xs opacity-70 mb-2">
        Wall-clock hours in {timezone}. Details include UTC offsets at
        daylight-saving transitions.
      </p>
      <div className="overflow-auto max-h-[650px] border border-base-content/10 rounded-lg">
        <div className="min-w-[800px]">
          <div className="grid grid-cols-[52px_repeat(7,minmax(0,1fr))] sticky top-0 z-10 bg-base-100 border-b border-base-content/10">
            <span className="text-xs p-1">All day</span>
            {days.map((day) => (
              <div
                key={day}
                className="p-1 border-l border-base-content/10 text-xs"
              >
                <p className="font-semibold">{day}</p>
                {events
                  .filter(
                    (event) => event.allDay && onDay(event, day, timezone),
                  )
                  .map((event) => (
                    <button
                      key={event.occurrenceId}
                      type="button"
                      onClick={() => select(event)}
                      className="block w-full truncate bg-primary/10 rounded p-1 mt-1 text-left"
                    >
                      {event.title}
                    </button>
                  ))}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-[52px_repeat(7,minmax(0,1fr))]">
            <div className="relative h-[1440px]">
              {hours.map((hour) => (
                <span
                  key={hour}
                  className="absolute text-[10px] opacity-70"
                  style={{ top: hour * 60 }}
                >
                  {String(hour).padStart(2, "0")}:00
                </span>
              ))}
            </div>
            {days.map((day) => (
              <section
                key={day}
                aria-label={day}
                className="relative h-[1440px] border-l border-base-content/10"
              >
                {hours.map((hour) => (
                  <div
                    key={hour}
                    className="absolute w-full border-t border-base-content/10"
                    style={{ top: hour * 60 }}
                  />
                ))}
                {weekBlocks(events, day, timezone).map(
                  ({ event, top, bottom, column, columns }) => (
                    <button
                      key={event.occurrenceId}
                      type="button"
                      onClick={() => select(event)}
                      title={`${event.title} · ${timeInZone(event.start, timezone)}`}
                      className="absolute overflow-hidden rounded border border-primary/30 bg-primary/15 p-1 text-left text-xs hover:bg-primary/25"
                      style={{
                        top,
                        height: bottom - top,
                        left: `${(column * 100) / columns}%`,
                        width: `${100 / columns}%`,
                      }}
                    >
                      <span className="font-medium">
                        {timeInZone(event.start, timezone)}
                      </span>{" "}
                      {event.title}
                    </button>
                  ),
                )}
              </section>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export const CalendarWeek = defineComponent({
  name: "CalendarWeek",
  description: "Week time grid with overlap layout and an all-day lane",
  props: calendarOpenUIProps.CalendarWeek,
  component: ({ props }) => <CalendarWeekView {...props} />,
});

import { defineComponent } from "@openuidev/react-lang";
import {
  calendarOpenUIProps,
  dateInZone,
  timeInZone,
} from "../../../shared/calendar";
import { CalendarNavigation } from "./CalendarNavigation";
import { useCalendar } from "./context";
import { monthDays, onDay } from "./layout";

export function CalendarMonthView({
  title = "Month",
}: {
  title?: string | undefined;
}) {
  const calendar = useCalendar();
  if (!calendar)
    return <p role="alert">CalendarMonth must be inside Calendar.</p>;
  const { events, date, timezone, navigate, select, loading } = calendar;
  const today = dateInZone(Date.now(), timezone);
  const days = monthDays(date);
  const weeks = Array.from({ length: 6 }, (_, index) =>
    days.slice(index * 7, index * 7 + 7),
  );
  return (
    <section aria-label="Month calendar" aria-busy={loading}>
      <CalendarNavigation
        title={title}
        date={date}
        timezone={timezone}
        period="month"
        navigate={navigate}
      />
      <div className="overflow-x-auto">
        <table
          className="calendar-month-table table-fixed w-full min-w-[560px]"
          aria-label="Calendar month dates"
        >
          <thead>
            <tr>
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
                <th
                  key={day}
                  scope="col"
                  className="p-2 text-left text-xs font-semibold"
                >
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0]}>
                {week.map((day) => {
                  const entries = events.filter((event) =>
                    onDay(event, day, timezone),
                  );
                  return (
                    <td
                      key={day}
                      aria-label={day}
                      aria-current={day === today ? "date" : undefined}
                      className={`h-28 align-top border border-base-content/10 p-1 ${day.slice(0, 7) === date.slice(0, 7) ? "" : "bg-base-200/50"}`}
                    >
                      <span
                        className={`text-xs inline-block rounded px-1 ${day === today ? "bg-primary text-primary-content" : ""}`}
                      >
                        {Number(day.slice(-2))}
                      </span>
                      {entries.slice(0, 3).map((event) => (
                        <button
                          type="button"
                          key={event.occurrenceId}
                          className="block w-full truncate rounded bg-primary/10 p-1 mt-1 text-left text-xs hover:bg-primary/20"
                          title={event.title}
                          onClick={() => select(event)}
                        >
                          {!event.allDay &&
                            `${timeInZone(event.start, timezone)} `}
                          {event.title}
                        </button>
                      ))}
                      {entries.length > 3 && (
                        <details className="text-xs mt-1">
                          <summary className="cursor-pointer">
                            +{entries.length - 3} more
                          </summary>
                          {entries.slice(3).map((event) => (
                            <button
                              type="button"
                              className="block text-left p-1"
                              key={event.occurrenceId}
                              onClick={() => select(event)}
                            >
                              {event.title}
                            </button>
                          ))}
                        </details>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export const CalendarMonth = defineComponent({
  name: "CalendarMonth",
  description:
    "Month grid for Calendar occurrences, including all-day and multi-day events",
  props: calendarOpenUIProps.CalendarMonth,
  component: ({ props }) => <CalendarMonthView {...props} />,
});

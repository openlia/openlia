import { addDays, dateInZone } from "../../../shared/calendar";
import { shiftMonth } from "./layout";

export function CalendarNavigation({
  title,
  date,
  timezone,
  period,
  navigate,
}: {
  title: string;
  date: string;
  timezone: string;
  period: "day" | "week" | "month";
  navigate: (date: string) => void;
}) {
  const shift = (direction: number) =>
    navigate(
      period === "month"
        ? shiftMonth(date, direction)
        : addDays(date, direction * (period === "week" ? 7 : 1)),
    );
  return (
    <header className="flex flex-wrap items-center justify-between gap-2 mb-3">
      <div>
        <h3 className="font-semibold">{title}</h3>
        <p className="text-xs opacity-70">
          {date} · {timezone}
        </p>
      </div>
      <nav className="join" aria-label={`${title} navigation`}>
        <button
          type="button"
          className="btn btn-sm join-item"
          aria-label={`Previous ${period}`}
          onClick={() => shift(-1)}
        >
          ←
        </button>
        <button
          type="button"
          className="btn btn-sm join-item"
          onClick={() => navigate(dateInZone(Date.now(), timezone))}
        >
          Today
        </button>
        <button
          type="button"
          className="btn btn-sm join-item"
          aria-label={`Next ${period}`}
          onClick={() => shift(1)}
        >
          →
        </button>
      </nav>
    </header>
  );
}

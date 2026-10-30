import {
  addDays,
  type CalendarDisplayEvent,
  dateInZone,
  timeInZone,
  validDate,
  wallTimeToInstant,
} from "../../../shared/calendar";

/** Actual instants keep duration bars accurate across 23/25-hour DST days. */
export function timelineCoordinate(value: string, timezone: string): number {
  if (validDate(value))
    return Date.parse(wallTimeToInstant(`${value}T00:00`, timezone));
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : Number.NaN;
}

export function monthDays(date: string): string[] {
  const first = `${date.slice(0, 7)}-01`;
  const weekday = new Date(`${first}T12:00:00Z`).getUTCDay();
  const start = addDays(first, -((weekday + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function weekDays(date: string): string[] {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const first = addDays(date, -((weekday + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => addDays(first, index));
}

export function shiftMonth(date: string, months: number): string {
  const value = new Date(`${date.slice(0, 7)}-01T12:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}

export function onDay(
  event: CalendarDisplayEvent,
  day: string,
  timezone: string,
): boolean {
  if (event.allDay) return event.start <= day && event.end > day;
  const start = dateInZone(event.start, timezone);
  const end = dateInZone(
    Math.max(Date.parse(event.start), Date.parse(event.end) - 1),
    timezone,
  );
  return start <= day && end >= day;
}

export interface WeekBlock {
  event: CalendarDisplayEvent;
  top: number;
  bottom: number;
  column: number;
  columns: number;
}

/** Lay out overlap clusters independently; touching intervals do not overlap. */
export function weekBlocks(
  events: CalendarDisplayEvent[],
  day: string,
  timezone: string,
): WeekBlock[] {
  const minutes = (instant: string) => {
    const [hours = 0, minutes = 0] = timeInZone(instant, timezone)
      .split(":")
      .map(Number);
    return hours * 60 + minutes;
  };
  const blocks: WeekBlock[] = events
    .filter((event) => !event.allDay && onDay(event, day, timezone))
    .map((event) => {
      const top =
        dateInZone(event.start, timezone) < day ? 0 : minutes(event.start);
      const end =
        dateInZone(event.end, timezone) > day ? 1440 : minutes(event.end);
      return {
        event,
        top,
        bottom: Math.max(top + 15, end),
        column: 0,
        columns: 1,
      };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster: WeekBlock[] = [];
  let end = -1;
  const finish = () => {
    const columns = Math.max(1, ...cluster.map((block) => block.column + 1));
    for (const block of cluster) block.columns = columns;
    cluster = [];
  };
  for (const block of blocks) {
    if (block.top >= end) finish();
    const occupied = new Set(
      cluster
        .filter((other) => other.bottom > block.top)
        .map((other) => other.column),
    );
    while (occupied.has(block.column)) block.column++;
    cluster.push(block);
    end = Math.max(...cluster.map((item) => item.bottom));
  }
  finish();
  return blocks;
}

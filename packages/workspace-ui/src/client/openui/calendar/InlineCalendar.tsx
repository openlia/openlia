import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  dateInZone,
  type InlineCalendarEvent,
  inlineCalendarOccurrences,
} from "../../../shared/calendar";
import { CalendarPresentation } from "./CalendarPresentation";

export function InlineCalendarView({
  children,
  events,
  timezone: configuredTimezone = "UTC",
}: {
  children: ReactNode;
  events: InlineCalendarEvent[];
  timezone?: string | undefined;
}) {
  const [timezone, setTimezone] = useState(configuredTimezone);
  const [date, navigate] = useState(() =>
    dateInZone(Date.now(), configuredTimezone),
  );
  const [selectedId, select] = useState<string | null>(null);
  const occurrences = useMemo(
    () => inlineCalendarOccurrences(events, configuredTimezone),
    [events, configuredTimezone],
  );
  const selected = occurrences.find((event) => event.id === selectedId) ?? null;
  useEffect(() => setTimezone(configuredTimezone), [configuredTimezone]);
  useEffect(() => {
    if (!selected) select(null);
  }, [selected]);
  return (
    <CalendarPresentation
      value={{
        events: occurrences,
        date,
        timezone,
        loading: false,
        navigate,
        select: (event) => select(event.id),
      }}
      onTimezoneChange={setTimezone}
      selected={selected}
      onClose={() => select(null)}
      description="Inline events · read-only"
    >
      {children}
    </CalendarPresentation>
  );
}

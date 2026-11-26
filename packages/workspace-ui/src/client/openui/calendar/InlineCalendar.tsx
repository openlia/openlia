import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  defaultCalendarDate,
  type InlineCalendarEvent,
  inlineCalendarOccurrences,
  type TimelineItem,
} from "../../../shared/calendar";
import { CalendarPresentation } from "./CalendarPresentation";

export function InlineCalendarView({
  children,
  events,
  timelineItems,
  timezone: configuredTimezone = "UTC",
  date: configuredDate,
  description = "Inline events · read-only",
  actions,
  error,
  loading = false,
}: {
  children: ReactNode;
  events: InlineCalendarEvent[];
  timelineItems?: TimelineItem[] | undefined;
  timezone?: string | undefined;
  date?: string | undefined;
  description?: string | undefined;
  actions?: ReactNode | undefined;
  error?: string | undefined;
  loading?: boolean | undefined;
}) {
  const [timezone, setTimezone] = useState(configuredTimezone);
  const [date, navigate] = useState(() =>
    defaultCalendarDate(events, configuredTimezone, configuredDate),
  );
  const [selectedId, select] = useState<string | null>(null);
  const occurrences = useMemo(
    () => inlineCalendarOccurrences(events, timezone),
    [events, timezone],
  );
  const selected = occurrences.find((event) => event.id === selectedId) ?? null;

  useEffect(() => {
    setTimezone(configuredTimezone);
  }, [configuredTimezone]);

  useEffect(() => {
    if (configuredDate || events.length > 0) {
      navigate(defaultCalendarDate(events, configuredTimezone, configuredDate));
    }
  }, [configuredDate, configuredTimezone, events]);

  useEffect(() => {
    if (!selected) select(null);
  }, [selected]);

  return (
    <CalendarPresentation
      value={{
        events: occurrences,
        timelineItems,
        date,
        timezone,
        loading,
        navigate,
        select: (event) => select(event.id),
      }}
      onTimezoneChange={setTimezone}
      selected={selected}
      onClose={() => select(null)}
      description={description}
      actions={actions}
      error={error}
    >
      {children}
    </CalendarPresentation>
  );
}

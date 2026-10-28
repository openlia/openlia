import type { ReactNode } from "react";
import { useState } from "react";
import { action, calendarEvents } from "./fixtures";
import { CalendarContext } from "../openui/calendar/context";
import { CalendarEventDetails } from "../openui/calendar/CalendarEventDetails";
import type { CalendarEvent } from "../../shared/calendar";

export function Panel({ children }: { children: ReactNode }) {
  return <div className="p-4 min-h-[320px]">{children}</div>;
}
export function PageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col h-[850px] min-h-0 overflow-auto bg-base-100">
      {children}
    </div>
  );
}
export function CalendarFrame({
  children,
  events = calendarEvents,
  date: initialDate = "2026-10-27",
  timezone = "UTC",
}: {
  children: ReactNode;
  events?: CalendarEvent[];
  date?: string;
  timezone?: string;
}) {
  const [date, navigate] = useState(initialDate);
  const [selected, select] = useState<CalendarEvent | null>(null);
  return (
    <CalendarContext.Provider
      value={{ events, date, timezone, navigate, select, loading: false }}
    >
      <Panel>{children}</Panel>
      {selected && (
        <CalendarEventDetails
          event={selected}
          timezone={timezone}
          onClose={() => select(null)}
          onOpenFile={action("openRecord")}
        />
      )}
    </CalendarContext.Provider>
  );
}

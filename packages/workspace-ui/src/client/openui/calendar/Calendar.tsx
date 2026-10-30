import { defineComponent } from "@openuidev/react-lang";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type CalendarCreateRequest,
  type CalendarDisplayEvent,
  type CalendarResponse,
  calendarOpenUIProps,
  dateInZone,
  type InlineCalendarEvent,
  validateCalendarProps,
  validTimezone,
} from "../../../shared/calendar";
import { ApiError } from "../../api";
import { notifyWorkspaceFileChange } from "../../workspaceFileChanges";
import { useOpenLiaOpenUI } from "../context";
import { CalendarEventEditor } from "./CalendarEventEditor";
import { CalendarPresentation } from "./CalendarPresentation";
import { InlineCalendarView } from "./InlineCalendar";
import { shiftMonth } from "./layout";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.payload?.error) {
      case "calendar_unavailable":
        return "Remind is unavailable on the workspace-ui server. Install Remind to use this calendar.";
      case "calendar_invalid":
        return "Native Remind reported errors or an ambiguous source time. Inspect the calendar source/timezone; no appointment was saved.";
      case "revision_conflict":
        return "Calendar changed. Cancel this draft, reload the calendar, and try again.";
      case "calendar_request_conflict":
        return "This save identifier already belongs to another appointment. Cancel this draft and start a new one.";
      case "not_found":
        return "Calendar source file was not found. Install or repair the Calendar feature.";
      case "invalid_calendar_request":
        return "Invalid calendar request or unsupported source directive. Use literal, calendar-local .rem includes and valid appointment dates.";
      default:
        return "Calendar request failed. Check your session and calendar source.";
    }
  }
  return error instanceof Error ? error.message : "Calendar request failed.";
}

export function CalendarView({
  children,
  source,
  timezone,
  events,
}: {
  children: ReactNode;
  source?: string | undefined;
  timezone?: string | undefined;
  events?: InlineCalendarEvent[] | undefined;
}) {
  const checked = validateCalendarProps({
    children: [],
    source,
    timezone,
    events,
  });
  if (!checked.success)
    return (
      <p role="alert">
        Invalid Calendar:{" "}
        {checked.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}
      </p>
    );
  return checked.data.events !== undefined ? (
    <InlineCalendarView
      events={checked.data.events}
      timezone={checked.data.timezone}
    >
      {children}
    </InlineCalendarView>
  ) : (
    <RemindCalendarView
      source={checked.data.source}
      timezone={checked.data.timezone}
    >
      {children}
    </RemindCalendarView>
  );
}

function RemindCalendarView({
  children,
  source = "reminders.rem",
  timezone: configuredTimezone,
}: {
  children: ReactNode;
  source?: string | undefined;
  timezone?: string | undefined;
}) {
  const { calendarApi, domainPath } = useOpenLiaOpenUI();
  const sourcePath = [domainPath ?? "calendar", source]
    .filter(Boolean)
    .join("/");
  const [timezone, setTimezone] = useState(configuredTimezone ?? "UTC");
  const [date, setDate] = useState(
    dateInZone(
      Date.now(),
      configuredTimezone && validTimezone(configuredTimezone)
        ? configuredTimezone
        : "UTC",
    ),
  );
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<CalendarDisplayEvent | null>(null);
  const [editing, setEditing] = useState(false);
  const initializedSource = useRef("");
  const from = shiftMonth(date, -1);
  const to = shiftMonth(date, 2);
  useEffect(() => {
    // An explicit refresh re-evaluates the same bounded range.
    void refresh;
    let active = true;
    setLoading(true);
    setError("");
    setData(null);
    if (!calendarApi) {
      setError("Calendar API is unavailable in this renderer.");
      setLoading(false);
      return;
    }
    calendarApi
      .loadCalendar({ source: sourcePath, from, to })
      .then((next) => {
        if (!active) return;
        setData(next);
        const key = `${sourcePath}:${configuredTimezone ?? ""}`;
        if (initializedSource.current !== key) {
          setTimezone(configuredTimezone ?? next.timezone);
          initializedSource.current = key;
        }
      })
      .catch((caught) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [calendarApi, sourcePath, from, to, refresh, configuredTimezone]);
  const save = async (event: CalendarCreateRequest) => {
    if (!calendarApi) throw new Error("Calendar API unavailable.");
    try {
      const result = await calendarApi.createCalendarEvent(event);
      setSelected(
        result.events.find(
          (item) => item.id === `openlia-ui-${event.requestId}`,
        ) ?? null,
      );
      setDate(dateInZone(event.start, timezone));
      setEditing(false);
      setRefresh((value) => value + 1);
      notifyWorkspaceFileChange(sourcePath);
    } catch (caught) {
      throw new Error(errorMessage(caught));
    }
  };
  if (!validTimezone(timezone))
    return <p role="alert">Calendar requires a valid IANA timezone.</p>;
  return (
    <CalendarPresentation
      value={{
        events: data?.events ?? [],
        date,
        timezone,
        loading,
        navigate: setDate,
        select: setSelected,
      }}
      onTimezoneChange={setTimezone}
      selected={selected}
      onClose={() => setSelected(null)}
      description={`Local appointments · ${sourcePath}`}
      error={error}
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm"
            disabled={editing || loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Reload calendar
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={loading || !data || editing}
            onClick={() => setEditing(true)}
          >
            New appointment
          </button>
        </>
      }
    >
      {children}
      {editing && data && (
        <CalendarEventEditor
          date={date}
          timezone={timezone}
          source={sourcePath}
          revision={data.revision}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      )}
    </CalendarPresentation>
  );
}

export const Calendar = defineComponent({
  name: "Calendar",
  description:
    "Calendar shared by Month, Week, and Gantt views. Use source for Remind-backed loading and appointment creation, or events for read-only inline data without API access.",
  props: calendarOpenUIProps.Calendar,
  component: ({ props, renderNode }) => (
    <CalendarView
      source={props.source}
      timezone={props.timezone}
      events={props.events}
    >
      {renderNode(props.children)}
    </CalendarView>
  ),
});

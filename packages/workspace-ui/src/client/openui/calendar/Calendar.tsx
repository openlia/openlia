import { defineComponent } from "@openuidev/react-lang";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type CalendarCreateRequest,
  type CalendarDisplayEvent,
  type CalendarResponse,
  calendarOpenUIProps,
  dateInZone,
  type InlineCalendarEvent,
  isJsonCalendarSource,
  type ParsedExternalCalendarJson,
  parseExternalCalendarJson,
  validateCalendarProps,
  validDate,
  validTimezone,
} from "../../../shared/calendar";
import { ApiError, httpWorkspaceApi } from "../../api";
import { resolveOpenUISourcePath, useOpenLiaOpenUI } from "../context";
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
        return "Calendar source file was not found.";
      case "invalid_calendar_request":
        return (
          error.payload.message ||
          "Invalid calendar request or unsupported source directive."
        );
      default:
        return error.payload?.message || "Calendar request failed.";
    }
  }
  return error instanceof Error ? error.message : "Calendar request failed.";
}

export function CalendarView({
  children,
  source,
  timezone,
  date,
  events,
}: {
  children: ReactNode;
  source?: string | undefined;
  timezone?: string | undefined;
  date?: string | undefined;
  events?: InlineCalendarEvent[] | undefined;
}) {
  const checked = validateCalendarProps({
    children: [],
    source,
    timezone,
    date,
    events,
  });
  if (!checked.success)
    return (
      <p role="alert" className="text-error text-sm">
        Invalid Calendar:{" "}
        {checked.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}
      </p>
    );

  if (checked.data.source !== undefined) {
    if (isJsonCalendarSource(checked.data.source)) {
      return (
        <JsonCalendarView
          source={checked.data.source}
          timezone={checked.data.timezone}
          date={checked.data.date}
        >
          {children}
        </JsonCalendarView>
      );
    }
    return (
      <RemindCalendarView
        source={checked.data.source}
        timezone={checked.data.timezone}
        date={checked.data.date}
      >
        {children}
      </RemindCalendarView>
    );
  }

  return (
    <InlineCalendarView
      events={checked.data.events ?? []}
      timezone={checked.data.timezone}
      date={checked.data.date}
    >
      {children}
    </InlineCalendarView>
  );
}

function JsonCalendarView({
  children,
  source,
  timezone: configuredTimezone,
  date: configuredDate,
}: {
  children: ReactNode;
  source: string;
  timezone?: string | undefined;
  date?: string | undefined;
}) {
  const {
    api = httpWorkspaceApi,
    filePath,
    scope = "workspace",
    onNavigateLink,
  } = useOpenLiaOpenUI();
  const resolved = resolveOpenUISourcePath(source, filePath, scope);
  const [loaded, setLoaded] = useState<ParsedExternalCalendarJson | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    void refresh;
    let active = true;
    setLoading(true);
    setError("");
    api
      .loadFile(resolved.path, resolved.scope)
      .then((file) => {
        if (!active) return;
        const parsed = parseExternalCalendarJson(file.content);
        setLoaded(parsed);
      })
      .catch((caught) => {
        if (!active) return;
        setLoaded(null);
        setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, resolved.path, resolved.scope, refresh]);

  const effectiveTimezone = configuredTimezone ?? loaded?.timezone ?? "UTC";
  const effectiveDate = configuredDate ?? loaded?.date;

  return (
    <InlineCalendarView
      events={loaded?.events ?? []}
      timelineItems={loaded?.items}
      timezone={effectiveTimezone}
      date={effectiveDate}
      loading={loading}
      error={error}
      description={`External JSON · ${resolved.path}`}
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading}
            onClick={() => setRefresh((v) => v + 1)}
          >
            Reload calendar
          </button>
          {onNavigateLink && (
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => onNavigateLink(resolved.path)}
            >
              Open JSON source
            </button>
          )}
        </>
      }
    >
      {children}
    </InlineCalendarView>
  );
}

function RemindCalendarView({
  children,
  source = "reminders.rem",
  timezone: configuredTimezone,
  date: configuredDate,
}: {
  children: ReactNode;
  source?: string | undefined;
  timezone?: string | undefined;
  date?: string | undefined;
}) {
  const {
    api = httpWorkspaceApi,
    filePath,
    scope = "workspace",
    onNavigateLink,
  } = useOpenLiaOpenUI();
  const resolved = resolveOpenUISourcePath(source, filePath, scope);
  const sourcePath = resolved.path;
  const [timezone, setTimezone] = useState(configuredTimezone ?? "UTC");
  const [date, setDate] = useState(() =>
    configuredDate && validDate(configuredDate)
      ? configuredDate
      : dateInZone(
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
    void refresh;
    let active = true;
    setLoading(true);
    setError("");
    setData(null);
    if (!api.loadCalendar) {
      setError("Calendar API is unavailable in this renderer.");
      setLoading(false);
      return;
    }
    api
      .loadCalendar({ source: sourcePath, from, to }, resolved.scope)
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
  }, [api, sourcePath, resolved.scope, from, to, refresh, configuredTimezone]);

  const save = async (event: CalendarCreateRequest) => {
    if (!api.createCalendarEvent) throw new Error("Calendar API unavailable.");
    try {
      const result = await api.createCalendarEvent(event, resolved.scope);
      setSelected(
        result.events.find(
          (item) => item.id === `openlia-ui-${event.requestId}`,
        ) ?? null,
      );
      setDate(dateInZone(event.start, timezone));
      setEditing(false);
      setRefresh((value) => value + 1);
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
      description={`Remind calendar · ${sourcePath}`}
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
          {onNavigateLink && (
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => onNavigateLink(sourcePath)}
            >
              Open calendar source
            </button>
          )}
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
    "Calendar container shared by Month, Week, and Gantt views. Use source (.rem, .remind, or .json) or inline events.",
  props: calendarOpenUIProps.Calendar,
  component: ({ props, renderNode }) => (
    <CalendarView
      source={props.source ?? undefined}
      timezone={props.timezone ?? undefined}
      date={props.date ?? undefined}
      events={props.events ?? undefined}
    >
      {renderNode(props.children)}
    </CalendarView>
  ),
});

export type CalendarViewMode = "month" | "week" | "gantt";

export type RemindScheduleKind =
  | "annual"
  | "daily"
  | "interval"
  | "monthly"
  | "once"
  | "weekday"
  | "yearly";

export interface RemindSchedule {
  kind: RemindScheduleKind;
  dateSpec?: string | undefined;
  startDate?: string | undefined;
  anchorDate?: string | undefined;
  endDate?: string | undefined;
  endKeyword?: "THROUGH" | "UNTIL" | undefined;
  fromDate?: string | undefined;
  repeat?: string | undefined;
  intervalDays?: number | undefined;
  advanceDays?: number | undefined;
  advanceToken?: string | undefined;
  backDays?: number | undefined;
  backToken?: string | undefined;
  weekdays?: number[] | undefined;
  dayOfMonth?: number | undefined;
  month?: number | undefined;
  year?: number | undefined;
  anchorDay?: number | undefined;
  isRecurring: boolean;
  preservedClauses?: string[] | undefined;
  unsupportedClauses?: string[] | undefined;
}

export interface RemindParseWarning {
  sourceFile: string;
  lineNumber: number;
  message: string;
}

export interface RemindInfoEntry {
  header: string;
  value: string;
  raw: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  date: string; // YYYY-MM-DD or weekday identifier
  time?: string | undefined; // HH:MM (24-hour)
  duration: number; // in minutes (0 if unspecified)
  attendees: string[];
  location?: string | undefined;
  mapUrl?: string | undefined;
  callUrl?: string | undefined;
  description?: string | undefined;
  note?: string | undefined;
  tags: string[];
  priority?: number | undefined;
  repeat?: string | undefined;
  advanceDays?: number | undefined;
  advanceToken?: string | undefined;
  schedule?: RemindSchedule | undefined;
  info?: Record<string, string> | undefined;
  rawInfoEntries?: RemindInfoEntry[] | undefined;
  rawSummary?: string | undefined;
  unsupportedClauses?: string[] | undefined;
  sourceFile: string;
  lineNumber?: number | undefined;
  rawStatement?: string | undefined;
}

export interface CalendarSource {
  path: string;
  name: string;
  color: string; // hex or badge color
  bgClass: string;
  textClass: string;
  borderClass: string;
  enabled: boolean;
  isCurrentFile: boolean;
  eventCount: number;
}

export interface CalendarFilterState {
  enabledSources: Set<string>;
}

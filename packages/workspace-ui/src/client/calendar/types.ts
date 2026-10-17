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
  endDate?: string | undefined; // YYYY-MM-DD (inclusive end date for ranges)
  sourceFile: string;
  lineNumber?: number | undefined;
  rawStatement?: string | undefined;
}

export interface LogicalEvent {
  id: string;
  ruleId: string;
  title: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD (inclusive)
  allDay: boolean;
  time?: string | undefined; // HH:MM (24-hour)
  duration: number; // in minutes (0 if unspecified or untimed)
  durationDays: number; // inclusive day count (1 for single-day, >=1 for multi-day)
  tags: string[];
  attendees: string[];
  location?: string | undefined;
  mapUrl?: string | undefined;
  callUrl?: string | undefined;
  description?: string | undefined;
  note?: string | undefined;
  priority?: number | undefined;
  sourceFile: string;
  lineNumber?: number | undefined;
  sourceRule: string; // original raw statement
  isRange: boolean; // true if startDate !== endDate
  isRecurring: boolean;
  rawEvent: CalendarEvent;
  info?: Record<string, string> | undefined;
  unsupportedClauses?: string[] | undefined;
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
  selectedTags: Set<string>;
  selectedPeople: Set<string>;
  searchQuery: string;
}

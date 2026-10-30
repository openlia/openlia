# Calendar OpenUI integration

The Calendar feature lives in `openlia/templates`. Workspace UI supplies reusable
OpenUI components in `packages/workspace-ui/src/client/openui/calendar/`; the
feature's Markdown documents compose them in fenced `openui` blocks. The runtime does not
install Calendar content or replace user calendar files when it upgrades.

## Components

```openui
root = Calendar([Tabs([
  TabItem("month", "Month", [CalendarMonth()]),
  TabItem("week", "Week", [CalendarWeek()]),
  TabItem("timeline", "Timeline", [GanttChart()])
])])
```

`Calendar(children, source?, timezone?, events?)` resolves `source` (default `reminders.rem` when `events` is omitted)
relative to the containing Markdown document's folder. It owns range loading, selected date, appointment
selection/details, and the draft editor. Views share that context. `GanttChart`
also works standalone with `items: [{id, title, start, end, group?}]`, and supports
day/week/month zoom. It is an event-duration timeline, without task dependencies,
milestones, progress tracking, or drag-to-reschedule.

The shared event model uses offset-bearing ISO instants for timed events and
date-only, exclusive-end intervals for all-day events. It keeps occurrence IDs,
source file/line references, timezone, agenda, attendees, location, and optional
companion-note links. Month and Week use Monday-first, wall-clock date layouts.
Details include timezone offsets; ambiguous/nonexistent editor wall times fail
validation instead of being silently shifted.

## Inline structured events

Use `events` for a self-contained, read-only calendar in Markdown. It needs no
calendar API provider, authentication, or Remind installation in the renderer.
Source-backed calendars still use Remind and the existing APIs unchanged.

```openui
Calendar(
  timezone: "Asia/Ho_Chi_Minh",
  events: [
    {
      id: "review",
      title: "Project review",
      start: "2026-10-30T09:00:00+07:00",
      end: "2026-10-30T10:00:00+07:00",
      agenda: "Review milestones",
      attendees: ["Alice", "Bob"],
      location: "Meeting room"
    },
    {
      id: "conference",
      title: "Conference",
      allDay: true,
      start: "2026-11-02",
      end: "2026-11-04"
    }
  ],
  children: [CalendarMonth(), CalendarWeek(), GanttChart()]
)
```

- Supply either `events` or `source`, never both. `events: []` is an empty inline
  calendar and never falls back to `reminders.rem`. Omitting both retains the
  existing default source. Existing positional arguments are unchanged; prefer
  named arguments for new views.
- Each event requires a unique, nonempty `id`, a nonempty `title`, `start`, and
  `end`. `allDay` defaults to `false`. Optional metadata is `timezone`, `agenda`,
  `attendees`, and `location`; Remind source fields are not accepted.
- Timed events require valid offset-bearing ISO timestamps. Floating wall times
  are rejected. All-day events require valid `YYYY-MM-DD` dates, with an exclusive
  end. Every event must end after it starts; timed chronology compares instants.
- Calendar timezone defaults to UTC. An event's appointment timezone defaults to
  that configured timezone, not the user's subsequently selected display zone.
  All-day dates do not shift when display timezone changes.
- Limits: 1,000 events, 300 characters for IDs/titles and each attendee, 100
  attendees, 10,000 characters for agenda, and 1,000 for location. Timezone names
  must be valid IANA identifiers. Runtime and offline authoring validation check
  chronology, unique IDs, and timezone validity in addition to field types.
- Month, Week, and Gantt share navigation and selection, initially showing today.
  Inline details omit source-file links and lines. Timeline source grouping uses
  the label **Inline events**. Standalone `GanttChart(items: [...])` is unchanged.
- Inline calendars show **Inline events · read-only**, with no Reload or New
  appointment action. They make no calendar API reads or writes, deliver no
  notifications/invitations, and do not write events back into Markdown. Edit the
  containing Markdown to update data; selected details refresh by stable event ID.
- Literal calendars can render in public snapshots without inheriting private
  workspace capabilities. Inline data in a shared document is visible to its
  recipients; do not embed private events in public documents.

JSON files, remote event URLs, recurrence rules, and mixing inline events with a
Remind source are not supported by this mode. Expand recurring occurrences into
explicit events or use the existing Remind-backed calendar.

## Native data and safety

`GET /api/workspace/calendar?source=calendar/reminders.rem&from=YYYY-MM-DD&to=YYYY-MM-DD`
returns native Remind occurrences, the calendar timezone, and a revision covering
the root file plus all its includes. `to` is exclusive, with a maximum range of
100 days. Evaluation runs in an isolated temporary copy, uses native monthly JSON
(`-ppp`), disables RUN/shell execution (`-r`) and queueing (`-q`), and enforces
timeouts/output limits. Native stderr is a failure even with exit status zero.
Only literal `.rem`/`.remind` includes within the calendar folder are accepted;
symlinks, dynamic/system/command includes, and include cycles fail visibly. The
snapshot is bounded to 32 files and 2 MiB. This is not a general Remind script
sandbox; unsupported directives are rejected conservatively.

This is the data-loading endpoint for source-backed calendars, not a file-download
endpoint. Inline calendars do not call it.

`POST /api/workspace/calendar` accepts a validated one-off appointment draft,
expected aggregate revision, and idempotency UUID. It validates the complete
candidate calendar natively before appending through the existing atomic,
revision-checked workspace writer. User comments, included files, and unrelated
events are preserved. Reusing a UUID with different fields fails. Titles and INFO
values are escaped for native Remind, including literal interpolation brackets.

New events use `NOQUEUE`, with notification/invitation delivery visibly off and
unavailable. No messages, external calendar changes, cron jobs, or notification
delivery are implemented. Attendees are metadata. Existing source-defined behavior
is not changed. This initial editor does not edit recurrence or existing entries;
users can open the native source or use the Calendar skill.

## Deployment

The workspace-ui image installs `remind` and `tzdata`; the Calendar feature still
provisions its own agent-side Remind dependency. For local development install
Remind on PATH, or set the server-only `OPENLIA_REMIND_BINARY` to an executable
path. Configure floating legacy entry times with `OPENLIA_TIMEZONE`, falling back
to `TZ` then UTC. New timed entries use a UTC-based `tzconvert` expression so
their instants survive changes to the server timezone. A source event falling in
an ambiguous DST hour is rejected by the UI adapter rather than guessed; inspect
its source or use UTC as the calendar evaluation timezone.

Deploy the updated workspace-ui before installing/updating Calendar 0.2.0 from
`openlia/templates`. Existing customized feature content must follow the normal
review/rebase update flow, never be overwritten directly.

## Verification

- `bun run --cwd packages/workspace-ui typecheck`
- `bun run --cwd packages/workspace-ui test -- src/client/openui/calendar/calendar.test.tsx`
- `bun run --cwd packages/workspace-ui test -- src/client/openui/calendar/inlineCalendar.test.tsx`
- `bun test packages/workspace-ui/src/server/calendarInline.test.ts`
- `bun test packages/workspace-ui/src/server/calendar.test.ts` (native cases require Remind)
- `WORKSPACE_UI_E2E_MODE=real bun run --cwd packages/workspace-ui e2e -- e2e/calendar.spec.ts`

The real-backend browser test covers pre-save controls, cancellation without a
save request, explicit timezone/agenda/attendees, save, reload, reopen, and all
three views on desktop and mobile. It does not use backend observations as a
substitute for UI acceptance evidence.

The inline Markdown Storybook stories also exercise populated/empty inline
calendars without private capabilities. Browser tests cover desktop/mobile month
column widths, multi-day exclusive ends, overlapping week events, timezone and
date navigation, details, and timeline zoom/selection.

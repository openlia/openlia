# Calendar OpenUI integration

The Calendar feature lives in `openlia/templates`. Workspace UI supplies reusable
OpenUI components in `packages/workspace-ui/src/client/openui/calendar/`; the
feature's `project-manifest.toml` and `ui.openui` compose them. The runtime does not
install Calendar content or replace user calendar files when it upgrades.

## Components

```openui
root = Calendar([Tabs([
  TabItem("month", "Month", [CalendarMonth()]),
  TabItem("week", "Week", [CalendarWeek()]),
  TabItem("timeline", "Timeline", [GanttChart()])
])])
```

`Calendar(children, source?, timezone?)` resolves `source` (default `reminders.rem`)
relative to the project. It owns range loading, selected date, appointment
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
- `bun test packages/workspace-ui/src/server/calendar.test.ts` (native cases require Remind)
- `WORKSPACE_UI_E2E_MODE=real bun run --cwd packages/workspace-ui e2e -- e2e/calendar.spec.ts`

The real-backend browser test covers pre-save controls, cancellation without a
save request, explicit timezone/agenda/attendees, save, reload, reopen, and all
three views on desktop and mobile. It does not use backend observations as a
substitute for UI acceptance evidence.

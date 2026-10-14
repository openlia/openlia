---
name: calendar
description: Manage calendar events, agendas, reminders, and recurring schedules using Remind with full support for attendees, locations, and call links.
version: 0.1.0
platforms: [macos, linux]
required_environment_variables: []
required_credential_files: []
metadata:
  hermes:
    tags: [personal-os, calendar, remind, agenda, scheduling, meetings]
    category: productivity
---

# Calendar

## When to Use

- Use when viewing, querying, scheduling, rescheduling, or canceling calendar events, meetings, appointments, and reminders.
- Use to check today's agenda, multi-day lookaheads, upcoming deadlines, and event conflicts.
- Use when events contain rich metadata such as attendees (names, emails, wiki links), physical locations (addresses, rooms, Google Maps links), video conferencing links (Zoom, Google Meet, Microsoft Teams), tags, and descriptions.
- Use to manage recurring schedules (daily standups, weekly 1:1s, monthly reviews, bi-weekly paydays, annual anniversaries).

## Data Model

Calendar entries are maintained in the workspace using [Remind](https://manpages.debian.org/testing/remind/remind.1.en.html) syntax.

- **Primary Calendar File**: `calendar/reminders.rem` in the runtime workspace (e.g. `/opt/data/workspace/calendar/reminders.rem`).
- **Modular Calendars**: Additional `.rem` files (e.g. `calendar/holidays.rem`, `calendar/work.rem`) can be included via Remind's `INCLUDE` directive:
  ```remind
  INCLUDE holidays.rem
  ```
- **Companion Event Notes**: Deep meeting agendas, minutes, and follow-up action items can be tracked in Markdown files using `calendar/event-note-template.md` (e.g. `calendar/2026-10-15-q4-sync.md`), linked via the `Event-Note:` INFO header.

### Remind Syntax & INFO Convention

Remind specifies events with the `REM` command:
```remind
REM <date_spec> [AT <time>] [DURATION <duration>] [TAG <tags>] \
    [INFO "<Header>: <Value>"]... \
    MSG <Summary>
```

Per the Debian `remind(1)` specification, the `INFO` keyword transmits metadata to backends. Each `INFO` string has the form `"Header: Value"` (no whitespace before the colon; headers are case-insensitive and unique per reminder).

Standardized INFO headers supported by OpenLia:

| Header | Description | Example |
| :--- | :--- | :--- |
| `Attendees:` | Comma-separated list of attendees (names, emails, or workspace links) | `Alice <alice@example.com>, Bob, [[Charlie]]` |
| `Location:` | Physical address, room, or venue name | `123 Market St, San Francisco, CA` |
| `Map-Url:` | Google Maps or web link to location (alias: `Map:`) | `https://maps.google.com/?q=123+Market+St` |
| `Video-Link:` | Video conferencing link: Zoom, Google Meet, Teams (alias: `Call:`) | `https://meet.google.com/abc-defg-hij` |
| `Description:` | Detailed agenda, topics, or notes | `Quarterly review and roadmap planning` |
| `Event-Note:` | Companion workspace event note Markdown file (alias: `Note:`) | `calendar/2026-10-15-roadmap-review.md` |

### Date & Time Specification Reference

- **Specific Date**: `2026-10-15` or `15 Oct 2026`
- **Time & Duration**: `AT 10:00 DURATION 1:00` (or `DURATION 60`)
- **Advance Warning**: `+3` (warn 3 days ahead) or `AT 14:00 +15` (warn 15 minutes ahead)
- **Weekly Recurrence**: `REM Mon AT 09:00 DURATION 0:30 MSG Team Standup`
- **Multiple Days**: `REM Mon Wed Fri AT 08:30 MSG Morning Gym`
- **Monthly Recurrence**: `REM 15 AT 14:00 MSG Monthly Billing`
- **Interval Recurrence**: `REM 2026-10-14 *14 AT 11:00 MSG Sprint Planning` (every 14 days)
- **Nth Weekday of Month**: `REM Mon 1 Oct MSG First Monday in October`
- **Last Weekday of Month**: `REM Mon 1 -7 Nov MSG Last Monday in November`
- **Annual**: `REM Oct 15 MSG Project Anniversary`

## Operating Procedures

### 1. View Agenda & Lookaheads (Read-Only)

Run the bundled calendar helper script:

```sh
# View today's agenda
python scripts/remind_calendar.py agenda --workspace-root /opt/data/workspace

# View agenda for a specific date and lookahead window (e.g. 7 days)
python scripts/remind_calendar.py agenda --workspace-root /opt/data/workspace --date YYYY-MM-DD --days 7

# Output machine-readable JSON
python scripts/remind_calendar.py agenda --workspace-root /opt/data/workspace --format json
```

Or run `remind` directly when the binary is installed:
```sh
remind -s+7 /opt/data/workspace/calendar/reminders.rem
```

Present the agenda in clean Markdown:
- Format each event with its start time, duration, and title.
- Render clickable video call links: `[Join Call](URL)`.
- Render physical location and clickable maps link: `📍 Location` (`[Map](URL)`).
- List attendees with formatting: `👥 Attendees: Alice, Bob`.
- Include description excerpts or linked companion notes when present.

### 2. Schedule New Events

Use the helper script to construct syntactically valid `REM` statements without syntax or escaping mistakes:

```sh
python scripts/remind_calendar.py add \
  --workspace-root /opt/data/workspace \
  --date YYYY-MM-DD \
  --time HH:MM \
  --duration HH:MM \
  --summary "Event Title" \
  --attendees "Alice <alice@example.com>, [[Bob]]" \
  --location "Physical Address or Room" \
  --map-url "https://maps.google.com/?q=..." \
  --video-link "https://meet.google.com/..." \
  --description "Agenda topics" \
  --event-note "calendar/2026-10-15-agenda.md" \
  --tag "meeting"
```

The helper script formats every `REM` entry as a readable multi-line block with backslash continuations, validates unique `INFO` headers, and appends the entry to `calendar/reminders.rem`. Entries without metadata use the same shape with only the header and `MSG` lines.

### 3. Reschedule or Cancel Events

1. First inspect the existing reminders using `python scripts/remind_calendar.py agenda` or `grep` in `calendar/reminders.rem`.
2. To reschedule, locate the target `REM` statement, update the date, time, or duration, and verify with `python scripts/remind_calendar.py validate`.
3. To cancel, comment out or remove the `REM` block.

### 4. Safety & Policy Rules

- **Workspace File Mutations**: Adding or updating events in `calendar/reminders.rem` is a local workspace change. Always verify the proposed change with the user before committing destructive edits or deleting existing entries.
- **External Calendars**: Local `reminders.rem` management does NOT authorize modifying external calendar services (Google Calendar, Microsoft Outlook, CalDAV). Modifying external calendar integrations requires explicit authorization under `modify_external_calendar` policy.

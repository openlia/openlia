#!/usr/bin/env python3
"""OpenLia Calendar & Agenda Manager powered by Remind.

Reference: https://manpages.debian.org/testing/remind/remind.1.en.html
Supports rich event metadata via Remind INFO clauses:
  - Attendees: Comma-separated names, emails, or wiki links
  - Location: Physical address, room, or venue
  - Map / Gmap: Google Maps link
  - Call / Call-Link: Zoom, Google Meet, Teams link
  - Description: Event details and agenda
  - Note: Companion workspace markdown event note
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# Standard weekday name mappings for Remind
WEEKDAYS = {
    "mon": 0,
    "monday": 0,
    "tue": 1,
    "tuesday": 1,
    "wed": 2,
    "wednesday": 2,
    "thu": 3,
    "thursday": 3,
    "fri": 4,
    "friday": 4,
    "sat": 5,
    "saturday": 5,
    "sun": 6,
    "sunday": 6,
}

MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}


@dataclass
class CalendarEvent:
    summary: str
    date: str  # YYYY-MM-DD
    time: str | None = None  # HH:MM
    duration: int = 0  # in minutes
    attendees: list[str] = field(default_factory=list)
    location: str | None = None
    map_url: str | None = None
    call_url: str | None = None
    description: str | None = None
    note: str | None = None
    tags: list[str] = field(default_factory=list)
    priority: int | None = None
    repeat: str | None = None
    source_file: str | None = None
    line_number: int | None = None

    def end_time(self) -> str | None:
        if not self.time or self.duration <= 0:
            return None
        try:
            parts = [int(p) for p in self.time.split(":")]
            start_dt = datetime.datetime(2000, 1, 1, parts[0], parts[1])
            end_dt = start_dt + datetime.timedelta(minutes=self.duration)
            return end_dt.strftime("%H:%M")
        except Exception:
            return None


def format_duration_str(minutes: int) -> str:
    if minutes <= 0:
        return ""
    hours = minutes // 60
    mins = minutes % 60
    if hours > 0 and mins > 0:
        return f"{hours}h {mins}m"
    if hours > 0:
        return f"{hours}h"
    return f"{mins}m"


def format_rem_statement(
    summary: str,
    date_str: str,
    time_str: str | None = None,
    duration_str: str | None = None,
    attendees: str | list[str] | None = None,
    location: str | None = None,
    map_url: str | None = None,
    call_url: str | None = None,
    description: str | None = None,
    note: str | None = None,
    tags: str | list[str] | None = None,
    repeat: str | None = None,
    priority: int | None = None,
) -> str:
    """Format a syntactically valid Remind REM statement with INFO headers."""
    tokens = ["REM", date_str]

    if repeat:
        tokens.append(f"*{repeat.lstrip('*')}")

    if time_str:
        tokens.extend(["AT", time_str])

    if duration_str:
        tokens.extend(["DURATION", duration_str])

    if priority is not None:
        tokens.extend(["PRIORITY", str(priority)])

    if tags:
        if isinstance(tags, str):
            tag_list = [t.strip() for t in tags.split() if t.strip()]
        else:
            tag_list = list(tags)
        for t in tag_list:
            tokens.extend(["TAG", t])

    # Clean and accumulate INFO clauses
    info_clauses: list[str] = []

    if location:
        clean_loc = location.strip().replace('"', '\\"')
        info_clauses.append(f'INFO "Location: {clean_loc}"')

    if map_url:
        clean_map = map_url.strip().replace('"', '\\"')
        info_clauses.append(f'INFO "Map-Url: {clean_map}"')

    if call_url:
        clean_call = call_url.strip().replace('"', '\\"')
        info_clauses.append(f'INFO "Video-Link: {clean_call}"')

    if attendees:
        if isinstance(attendees, list):
            att_str = ", ".join(attendees)
        else:
            att_str = str(attendees).strip()
        clean_att = att_str.replace('"', '\\"')
        info_clauses.append(f'INFO "Attendees: {clean_att}"')

    if description:
        clean_desc = description.strip().replace('"', '\\"').replace("\n", "\\n")
        info_clauses.append(f'INFO "Description: {clean_desc}"')

    if note:
        clean_note = note.strip().replace('"', '\\"')
        info_clauses.append(f'INFO "Event-Note: {clean_note}"')

    clean_summary = summary.strip().replace("\n", " ")

    # Keep every generated reminder block readable and structurally consistent.
    header_line = " ".join(tokens) + " \\"
    lines = [header_line]
    for clause in info_clauses:
        lines.append(f"    {clause} \\")
    lines.append(f"    MSG {clean_summary}")
    return "\n".join(lines)


def parse_info_clauses(text: str) -> dict[str, str]:
    """Extract INFO headers from a REM line or block."""
    results: dict[str, str] = {}
    pattern = re.compile(r'INFO\s+"([^":]+):\s*([^"]*)"', re.IGNORECASE)
    for match in pattern.finditer(text):
        header = match.group(1).strip().lower()
        val = match.group(2).strip().replace('\\"', '"').replace("\\n", "\n")
        results[header] = val
    return results


def parse_rem_line(line: str, line_no: int = 1, file_name: str = "") -> CalendarEvent | None:
    """Parse a single (possibly joined) REM statement into a CalendarEvent."""
    clean = line.strip()
    if not clean.startswith("REM ") and not clean.startswith("rem "):
        return None

    # Check for MSG
    msg_split = re.split(r"\bMSG\b|\bmsg\b", clean, maxsplit=1)
    if len(msg_split) < 2:
        return None

    rem_head = msg_split[0]
    summary = msg_split[1].strip()

    # Extract INFO clauses
    info = parse_info_clauses(rem_head)

    # Extract time
    time_match = re.search(r"\bAT\s+([0-9]{1,2}:[0-9]{2})\b", rem_head, re.IGNORECASE)
    time_str = time_match.group(1) if time_match else None

    # Extract duration
    dur_match = re.search(r"\bDURATION\s+([0-9]+(?::[0-9]{2})?)\b", rem_head, re.IGNORECASE)
    duration_mins = 0
    if dur_match:
        val = dur_match.group(1)
        if ":" in val:
            h, m = val.split(":")
            duration_mins = int(h) * 60 + int(m)
        else:
            duration_mins = int(val)

    # Extract tags
    tags: list[str] = []
    for tag_match in re.finditer(r"\bTAG\s+([^\s\\]+)", rem_head, re.IGNORECASE):
        tags.append(tag_match.group(1))

    # Extract priority
    prio_match = re.search(r"\bPRIORITY\s+([0-9]+)\b", rem_head, re.IGNORECASE)
    priority = int(prio_match.group(1)) if prio_match else None

    # Extract date
    # Inspect only the trigger prefix, not INFO text or other clause values.
    date_tokens = []
    for token in rem_head.split()[1:]:
        low = token.lower()
        if (low not in WEEKDAYS and low not in MONTHS
                and not re.fullmatch(r"(?:[0-9]+|[0-9]{4}[-/][0-9]{2}[-/][0-9]{2}|\*[0-9]+|[+-][0-9]+)", token)):
            break
        date_tokens.append(token)
    date_str = ""
    repeat_str = None

    for token in date_tokens:
        if token.startswith("*"):
            repeat_str = token
            continue
        if re.match(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$", token):
            date_str = token
            break
        # Match YYYY/MM/DD
        if re.match(r"^[0-9]{4}/[0-9]{2}/[0-9]{2}$", token):
            date_str = token.replace("/", "-")
            break

    # Remind accepts named-month dates in either order.
    if not date_str:
        named_date = re.search(
            r"\b(?:([0-9]{1,2})\s+([a-z]+)|([a-z]+)\s+([0-9]{1,2}))\s+([0-9]{4})\b",
            " ".join(date_tokens), re.IGNORECASE,
        )
        if named_date:
            day = int(named_date.group(1) or named_date.group(4))
            month = MONTHS.get((named_date.group(2) or named_date.group(3)).lower())
            year = int(named_date.group(5))
            if month:
                try:
                    date_str = datetime.date(year, month, day).isoformat()
                except ValueError:
                    pass

    # If no explicit date, check for a weekday in the trigger prefix.
    if not date_str:
        # Check weekday
        for token in date_tokens:
            tok_low = token.lower()
            if tok_low in WEEKDAYS:
                date_str = tok_low
                break

    attendees_val = info.get("attendees") or info.get("attendee") or info.get("participants")
    attendee_list = [a.strip() for a in attendees_val.split(",") if a.strip()] if attendees_val else []

    location_val = info.get("location") or info.get("venue") or info.get("address")
    map_val = (
        info.get("map-url")
        or info.get("map_url")
        or info.get("map")
        or info.get("map-link")
        or info.get("gmap")
    )

    # If location contains a URL in parentheses, extract it if map_val isn't explicit
    if location_val and not map_val:
        url_match = re.search(r"\((https?://[^\)]+)\)", location_val)
        if url_match:
            map_val = url_match.group(1)

    call_val = (
        info.get("video-link")
        or info.get("video_link")
        or info.get("video-url")
        or info.get("call")
        or info.get("call-link")
        or info.get("call-url")
        or info.get("url")
    )
    desc_val = (
        info.get("description")
        or info.get("agenda")
        or info.get("details")
        or info.get("summary")
    )
    note_val = (
        info.get("event-note")
        or info.get("event_note")
        or info.get("note")
        or info.get("note-path")
    )

    return CalendarEvent(
        summary=summary,
        date=date_str or "unspecified",
        time=time_str,
        duration=duration_mins,
        attendees=attendee_list,
        location=location_val,
        map_url=map_val,
        call_url=call_val,
        description=desc_val,
        note=note_val,
        tags=tags,
        priority=priority,
        repeat=repeat_str,
        source_file=file_name,
        line_number=line_no,
    )


def load_reminders(file_path: Path) -> list[CalendarEvent]:
    """Parse a .rem file, joining backslash continuation lines."""
    if not file_path.is_file():
        return []

    events: list[CalendarEvent] = []
    lines = file_path.read_text(encoding="utf-8").splitlines()

    current_block: list[str] = []
    start_line = 1

    for idx, raw_line in enumerate(lines, 1):
        line = raw_line.rstrip()
        if not current_block:
            start_line = idx

        if line.endswith("\\"):
            current_block.append(line[:-1].rstrip())
        else:
            current_block.append(line)
            full_statement = " ".join(current_block).strip()
            current_block = []

            # Skip comments or empty lines
            if full_statement.startswith("#") or not full_statement:
                continue

            # Check for INCLUDE directive
            if full_statement.startswith("INCLUDE ") or full_statement.startswith("include "):
                included_name = full_statement.split(maxsplit=1)[1].strip().strip('"')
                sub_path = file_path.parent / included_name
                if sub_path.is_file():
                    events.extend(load_reminders(sub_path))
                continue

            event = parse_rem_line(full_statement, line_no=start_line, file_name=str(file_path))
            if event:
                events.append(event)

    return events


def query_agenda(
    calendar_file: Path,
    target_date: datetime.date,
    days: int = 1,
) -> list[CalendarEvent]:
    """Query agenda for target_date up to days ahead."""
    events = load_reminders(calendar_file)
    end_date = target_date + datetime.timedelta(days=max(0, days - 1))

    matched: list[CalendarEvent] = []
    for ev in events:
        # Check ISO date match
        if re.match(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$", ev.date):
            ev_date = datetime.date.fromisoformat(ev.date)
            if target_date <= ev_date <= end_date:
                matched.append(ev)
        elif ev.date in WEEKDAYS:
            # Check if any day in range has this weekday
            target_weekday = WEEKDAYS[ev.date]
            curr = target_date
            while curr <= end_date:
                if curr.weekday() == target_weekday:
                    # Clone event with specific date
                    ev_copy = CalendarEvent(**asdict(ev))
                    ev_copy.date = curr.isoformat()
                    matched.append(ev_copy)
                curr += datetime.timedelta(days=1)

    # Sort by date, then start time, then priority
    def sort_key(e: CalendarEvent):
        time_part = e.time or "23:59"
        prio_part = e.priority if e.priority is not None else 5000
        return (e.date, time_part, prio_part)

    matched.sort(key=sort_key)
    return matched


def render_markdown_agenda(events: list[CalendarEvent], start_date: datetime.date, days: int) -> str:
    """Render events into readable GitHub markdown agenda with rich badges and links."""
    lines: list[str] = []
    lines.append(f"## Calendar Agenda ({start_date.isoformat()} to {(start_date + datetime.timedelta(days=days - 1)).isoformat()})")
    lines.append("")

    if not events:
        lines.append("_No scheduled events found for this period._")
        return "\n".join(lines)

    # Group by date
    by_date: dict[str, list[CalendarEvent]] = {}
    for ev in events:
        by_date.setdefault(ev.date, []).append(ev)

    for d_str in sorted(by_date.keys()):
        d_obj = datetime.date.fromisoformat(d_str)
        weekday_name = d_obj.strftime("%A")
        lines.append(f"### {d_str} ({weekday_name})")
        lines.append("")

        for ev in by_date[d_str]:
            time_label = ""
            if ev.time:
                end_t = ev.end_time()
                dur_text = f" ({format_duration_str(ev.duration)})" if ev.duration > 0 else ""
                time_label = f"**{ev.time}{(' - ' + end_t) if end_t else ''}**{dur_text}: "

            lines.append(f"- {time_label}**{ev.summary}**")

            # Video link
            if ev.call_url:
                lines.append(f"  - 📹 **Video Link**: [{ev.call_url}]({ev.call_url})")

            # Location & Map
            if ev.location or ev.map_url:
                loc_text = ev.location or "Location"
                if ev.map_url:
                    loc_text = f"{loc_text} ([Map]({ev.map_url}))"
                lines.append(f"  - 📍 **Location**: {loc_text}")

            # Attendees
            if ev.attendees:
                lines.append(f"  - 👥 **Attendees**: {', '.join(ev.attendees)}")

            # Description
            if ev.description:
                lines.append(f"  - 📝 **Details**: {ev.description}")

            # Note link
            if ev.note:
                lines.append(f"  - 📄 **Event Note**: `{ev.note}`")

            # Tags
            if ev.tags:
                lines.append(f"  - 🏷️ **Tags**: {', '.join(f'`{t}`' for t in ev.tags)}")

            lines.append("")

    return "\n".join(lines).rstrip()


def validate_file(file_path: Path) -> tuple[bool, list[str]]:
    """Validate a .rem file syntax and INFO rules."""
    errors: list[str] = []
    if not file_path.is_file():
        return False, [f"File not found: {file_path}"]

    lines = file_path.read_text(encoding="utf-8").splitlines()
    current_block: list[str] = []
    start_line = 1

    for idx, raw_line in enumerate(lines, 1):
        line = raw_line.rstrip()
        if not current_block:
            start_line = idx

        if line.endswith("\\"):
            current_block.append(line[:-1].rstrip())
        else:
            current_block.append(line)
            full_statement = " ".join(current_block).strip()
            current_block = []

            if not full_statement or full_statement.startswith("#"):
                continue

            if full_statement.startswith("INCLUDE ") or full_statement.startswith("include "):
                continue

            if not (full_statement.startswith("REM ") or full_statement.startswith("rem ")):
                errors.append(f"Line {start_line}: Expected REM statement, got '{full_statement[:30]}...'")
                continue

            if not re.search(r"\b(?:MSG|msg|MSF|msf|RUN|run)\b", full_statement):
                errors.append(f"Line {start_line}: Missing MSG directive in REM statement")
                continue

            # Check INFO headers
            info_pattern = re.compile(r'INFO\s+"([^":]+):\s*([^"]*)"', re.IGNORECASE)
            headers_seen = set()
            for m in info_pattern.finditer(full_statement):
                h = m.group(1).strip().lower()
                if " " in m.group(1):
                    errors.append(f"Line {start_line}: INFO header '{m.group(1)}' contains invalid whitespace")
                if h in headers_seen:
                    errors.append(f"Line {start_line}: Duplicate INFO header '{h}' is prohibited by Remind")
                headers_seen.add(h)

    return len(errors) == 0, errors


def resolve_calendar_file(workspace_root: str | None, explicit_file: str | None) -> Path:
    if explicit_file:
        return Path(explicit_file).resolve()
    base = Path(workspace_root or ".").resolve()
    return base / "calendar" / "reminders.rem"


def self_test() -> bool:
    """Run comprehensive offline self-tests for Remind calendar manager."""
    print("Running remind_calendar.py self-tests...")

    with tempfile.TemporaryDirectory() as tmp_dir:
        temp_dir_path = Path(tmp_dir)
        cal_path = temp_dir_path / "reminders.rem"

        # Test 1: format_rem_statement with all fields
        stmt1 = format_rem_statement(
            summary="Client Roadmap Review",
            date_str="2026-10-15",
            time_str="10:00",
            duration_str="1:00",
            attendees=["Alice <alice@example.com>", "[[Bob Jones]]"],
            location="123 Market St, San Francisco, CA",
            map_url="https://maps.google.com/?q=123+Market+St",
            call_url="https://meet.google.com/abc-defg-hij",
            description="Discuss Q4 milestones",
            note="calendar/2026-10-15-review.md",
            tags=["client", "q4"],
            priority=1000,
        )
        assert "REM 2026-10-15 AT 10:00 DURATION 1:00 PRIORITY 1000 TAG client TAG q4" in stmt1, f"bad header: {stmt1}"
        assert 'INFO "Location: 123 Market St, San Francisco, CA"' in stmt1
        assert 'INFO "Map-Url: https://maps.google.com/?q=123+Market+St"' in stmt1
        assert 'INFO "Video-Link: https://meet.google.com/abc-defg-hij"' in stmt1
        assert 'INFO "Attendees: Alice <alice@example.com>, [[Bob Jones]]"' in stmt1
        assert 'INFO "Description: Discuss Q4 milestones"' in stmt1
        assert 'INFO "Event-Note: calendar/2026-10-15-review.md"' in stmt1
        assert "MSG Client Roadmap Review" in stmt1

        # Test 2: parse_rem_line with canonical headers
        event1 = parse_rem_line(stmt1.replace("\\\n", " "), line_no=1, file_name="test.rem")
        assert event1 is not None
        assert event1.summary == "Client Roadmap Review"
        assert event1.date == "2026-10-15"
        assert event1.time == "10:00"
        assert event1.duration == 60
        assert event1.end_time() == "11:00"
        assert event1.location == "123 Market St, San Francisco, CA"
        assert event1.map_url == "https://maps.google.com/?q=123+Market+St"
        assert event1.call_url == "https://meet.google.com/abc-defg-hij"
        assert event1.note == "calendar/2026-10-15-review.md"
        assert len(event1.attendees) == 2
        assert "[[Bob Jones]]" in event1.attendees
        assert event1.tags == ["client", "q4"]
        assert event1.priority == 1000

        # Test 2b: parse_rem_line with legacy aliases (Call, Map, Note)
        legacy_stmt = (
            'REM 2026-10-16 AT 15:00 DURATION 30 '
            'INFO "Call: https://zoom.us/j/999" '
            'INFO "Map: https://maps.google.com/?q=Office" '
            'INFO "Note: calendar/legacy.md" '
            'MSG Legacy Meeting'
        )
        legacy_ev = parse_rem_line(legacy_stmt)
        assert legacy_ev is not None
        assert legacy_ev.call_url == "https://zoom.us/j/999"
        assert legacy_ev.map_url == "https://maps.google.com/?q=Office"
        assert legacy_ev.note == "calendar/legacy.md"

        # Named-month dates must not become weekly Thursdays because of "thu hoach".
        for date_spec in ("27 OCT 2026", "Oct 27 2026", "27 October 2026", "October 27 2026"):
            named_stmt = (
                f'REM {date_spec} AT 07:30 DURATION 8:00 '
                'INFO "Description: Nop bai thu hoach truoc 30/10/2026." '
                'MSG Hoạt động trải nghiệm STEM'
            )
            named_ev = parse_rem_line(named_stmt)
            assert named_ev is not None and named_ev.date == "2026-10-27"
            assert named_ev.duration == 480
            cal_path.write_text(named_stmt + "\n", encoding="utf-8")
            october = query_agenda(cal_path, datetime.date(2026, 10, 1), days=31)
            assert len(october) == 1 and october[0].date == "2026-10-27"
            assert not query_agenda(cal_path, datetime.date(2026, 11, 1), days=30)

        for statement in (
            'REM 15 AT 07:30 INFO "Description: thu 2026-10-27 mon" MSG Test',
            'REM AT 07:30 INFO "Location: thu" MSG Test',
            'REM 15 TAG thu MSG Test',
            'REM 31 Feb 2026 INFO "Description: thu" MSG Test',
        ):
            ev = parse_rem_line(statement)
            assert ev is not None and ev.date == "unspecified"
        weekly = parse_rem_line('REM Mon AT 09:00 INFO "Description: thu 2026-10-27" MSG Weekly')
        assert weekly is not None and weekly.date == "mon"

        # Test 3: Write to file and query agenda
        stmt2 = format_rem_statement(
            summary="Engineering Standup",
            date_str="Mon",
            time_str="09:30",
            duration_str="15",
            call_url="https://zoom.us/j/12345678",
            attendees="Carol, Dave",
            tags="engineering",
        )
        assert stmt2 == (
            "REM Mon AT 09:30 DURATION 15 TAG engineering \\\n"
            "    INFO \"Video-Link: https://zoom.us/j/12345678\" \\\n"
            "    INFO \"Attendees: Carol, Dave\" \\\n"
            "    MSG Engineering Standup"
        )
        simple_stmt = format_rem_statement(
            summary="Simple Reminder",
            date_str="2026-10-21",
            time_str="08:00",
        )
        assert simple_stmt == "\n".join(
            ("REM 2026-10-21 AT 08:00 " + chr(92), "    MSG Simple Reminder")
        )
        cal_path.write_text(f"{stmt1}\n\n{stmt2}\n", encoding="utf-8")

        # Validate file
        valid, errors = validate_file(cal_path)
        assert valid, f"Validation failed: {errors}"

        # Query on 2026-10-15 (Thursday)
        d_thurs = datetime.date(2026, 10, 15)
        agenda = query_agenda(cal_path, d_thurs, days=1)
        assert len(agenda) == 1
        assert agenda[0].summary == "Client Roadmap Review"

        # Query 7 days starting from Monday 2026-10-12
        d_mon = datetime.date(2026, 10, 12)
        agenda_week = query_agenda(cal_path, d_mon, days=7)
        assert len(agenda_week) == 2, f"Expected 2 events, got {len(agenda_week)}"
        assert any(e.summary == "Engineering Standup" for e in agenda_week)
        assert any(e.summary == "Client Roadmap Review" for e in agenda_week)

        # Test 4: Render Markdown
        md = render_markdown_agenda(agenda_week, d_mon, days=7)
        assert "### 2026-10-12 (Monday)" in md
        assert "### 2026-10-15 (Thursday)" in md
        assert "[https://meet.google.com/abc-defg-hij](https://meet.google.com/abc-defg-hij)" in md
        assert "[Map](https://maps.google.com/?q=123+Market+St)" in md
        assert "👥 **Attendees**: Alice <alice@example.com>, [[Bob Jones]]" in md

        # Test 5: Validation errors detection
        bad_stmt = 'REM 2026-10-20 INFO "Bad Header: val" MSG Test'
        bad_file = temp_dir_path / "bad.rem"
        bad_file.write_text(bad_stmt, encoding="utf-8")
        is_val, errs = validate_file(bad_file)
        assert not is_val
        assert any("contains invalid whitespace" in e for e in errs)

        # Duplicate INFO headers
        dup_stmt = 'REM 2026-10-20 INFO "Location: A" INFO "Location: B" MSG Test'
        bad_file.write_text(dup_stmt, encoding="utf-8")
        is_val, errs = validate_file(bad_file)
        assert not is_val
        assert any("Duplicate INFO header" in e for e in errs)

    print("All remind_calendar.py self-tests PASSED successfully.")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenLia Remind Calendar & Agenda Manager")
    parser.add_argument("--self-test", action="store_true", help="Run offline deterministic self-tests")
    parser.add_argument("--workspace-root", type=str, default=".", help="Path to workspace root")
    parser.add_argument("--file", type=str, default="", help="Path to specific .rem file")

    subparsers = parser.add_subparsers(dest="subcommand")

    # agenda subcommand
    agenda_p = subparsers.add_parser("agenda", help="Query agenda")
    agenda_p.add_argument("--date", type=str, default="", help="Start date (YYYY-MM-DD), default today")
    agenda_p.add_argument("--days", type=int, default=7, help="Number of days to display (default: 7)")
    agenda_p.add_argument("--format", choices=["markdown", "json", "text"], default="markdown", help="Output format")

    # add subcommand
    add_p = subparsers.add_parser("add", help="Add a new event")
    add_p.add_argument("--summary", required=True, type=str, help="Event summary/title")
    add_p.add_argument("--date", required=True, type=str, help="Date (YYYY-MM-DD or weekday)")
    add_p.add_argument("--time", type=str, default="", help="Start time (HH:MM)")
    add_p.add_argument("--duration", type=str, default="", help="Duration (e.g. 1:00 or 45)")
    add_p.add_argument("--attendees", type=str, default="", help="Comma-separated attendees")
    add_p.add_argument("--location", type=str, default="", help="Physical address or room")
    add_p.add_argument("--map-url", "--map", dest="map_url", type=str, default="", help="Google Maps or location URL")
    add_p.add_argument("--video-link", "--call", dest="video_link", type=str, default="", help="Video conference link (Zoom, Meet, Teams)")
    add_p.add_argument("--description", type=str, default="", help="Event description")
    add_p.add_argument("--event-note", "--note", dest="event_note", type=str, default="", help="Path to companion markdown event note")
    add_p.add_argument("--tag", type=str, default="", help="Tags (space-separated)")
    add_p.add_argument("--repeat", type=str, default="", help="Repeat interval in days (e.g. 14)")
    add_p.add_argument("--priority", type=int, default=None, help="Priority (0-9999)")

    # common options for subparsers
    for subp in (agenda_p, add_p):
        subp.add_argument("--workspace-root", type=str, default="", help="Path to workspace root")
        subp.add_argument("--file", type=str, default="", help="Path to specific .rem file")

    # validate subcommand
    val_p = subparsers.add_parser("validate", help="Validate calendar .rem file")
    val_p.add_argument("--workspace-root", type=str, default="", help="Path to workspace root")
    val_p.add_argument("--file", type=str, default="", help="Path to specific .rem file")

    args = parser.parse_args()

    if args.self_test:
        sys.exit(0 if self_test() else 1)

    effective_ws = getattr(args, "workspace_root", "") or args.workspace_root
    effective_file = getattr(args, "file", "") or args.file
    cal_file = resolve_calendar_file(effective_ws, effective_file)

    if args.subcommand == "agenda":
        target_date = datetime.date.fromisoformat(args.date) if args.date else datetime.date.today()
        events = query_agenda(cal_file, target_date, days=args.days)
        if args.format == "json":
            print(json.dumps([asdict(e) for e in events], indent=2))
        elif args.format == "text":
            for e in events:
                print(f"{e.date} {e.time or '--:--'} {e.summary}")
        else:
            print(render_markdown_agenda(events, target_date, days=args.days))
        sys.exit(0)

    elif args.subcommand == "add":
        cal_file.parent.mkdir(parents=True, exist_ok=True)
        stmt = format_rem_statement(
            summary=args.summary,
            date_str=args.date,
            time_str=args.time or None,
            duration_str=args.duration or None,
            attendees=args.attendees or None,
            location=args.location or None,
            map_url=args.map_url or None,
            call_url=args.video_link or None,
            description=args.description or None,
            note=args.event_note or None,
            tags=args.tag or None,
            repeat=args.repeat or None,
            priority=args.priority,
        )
        with open(cal_file, "a", encoding="utf-8") as f:
            f.write(f"\n{stmt}\n")
        print(f"Added event to {cal_file}:\n{stmt}")
        sys.exit(0)

    elif args.subcommand == "validate":
        ok, errs = validate_file(cal_file)
        if ok:
            print(f"Valid Remind calendar: {cal_file}")
            sys.exit(0)
        else:
            print(f"Validation errors in {cal_file}:", file=sys.stderr)
            for err in errs:
                print(f"  - {err}", file=sys.stderr)
            sys.exit(1)

    else:
        parser.print_help()
        sys.exit(0)


if __name__ == "__main__":
    main()

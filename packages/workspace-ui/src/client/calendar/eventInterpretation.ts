import type {
  CalendarEvent,
  CalendarFilterState,
  LogicalEvent,
  RemindSchedule,
} from "./types";

const WEEKDAYS: Record<string, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 0,
  sunday: 0,
};

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dateFromIso(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

export function dateIsBefore(left: string, right: string): boolean {
  return left < right;
}

export function dateIsAfter(left: string, right: string): boolean {
  return left > right;
}

export function addDays(value: string, days: number): string {
  const date = dateFromIso(value);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

export function daysBetween(start: string, end: string): number {
  return Math.round(
    (dateFromIso(end).getTime() - dateFromIso(start).getTime()) / 86400000,
  );
}

export function isDateInRange(
  date: string,
  start: string,
  end: string,
): boolean {
  return date >= start && date <= end;
}

export function eventSpansDate(event: LogicalEvent, dateIso: string): boolean {
  return event.startDate <= dateIso && event.endDate >= dateIso;
}

function matchesSchedule(date: string, schedule: RemindSchedule): boolean {
  if (schedule.fromDate && dateIsBefore(date, schedule.fromDate)) return false;
  if (schedule.endDate && dateIsAfter(date, schedule.endDate)) return false;

  if (schedule.startDate) {
    if (schedule.repeat && schedule.intervalDays) {
      const elapsed = daysBetween(schedule.startDate, date);
      return elapsed >= 0 && elapsed % schedule.intervalDays === 0;
    }
    if (schedule.endKeyword === "THROUGH" && !schedule.repeat) {
      return !dateIsBefore(date, schedule.startDate);
    }
    return date === schedule.startDate;
  }

  const current = dateFromIso(date);
  const weekday = current.getUTCDay();
  if (schedule.kind === "weekday") {
    if (schedule.backDays === 7) {
      if (!(schedule.weekdays ?? []).includes(weekday)) return false;
      const target = schedule.anchorDate
        ? dateFromIso(schedule.anchorDate)
        : new Date(
            Date.UTC(
              schedule.year ?? current.getUTCFullYear(),
              schedule.month !== undefined
                ? schedule.month - 1
                : current.getUTCMonth() + 1,
              schedule.anchorDay ?? 1,
            ),
          );
      while (target.getUTCDay() !== weekday) {
        target.setUTCDate(target.getUTCDate() + 1);
      }
      target.setUTCDate(target.getUTCDate() - schedule.backDays);
      return isoDate(target) === date;
    }

    if (schedule.anchorDate) {
      const anchor = dateFromIso(schedule.anchorDate);
      if (
        current.getUTCFullYear() !== anchor.getUTCFullYear() ||
        current.getUTCMonth() !== anchor.getUTCMonth()
      ) {
        return false;
      }
    }
    if (
      schedule.month !== undefined &&
      current.getUTCMonth() + 1 !== schedule.month
    ) {
      return false;
    }
    if (
      schedule.year !== undefined &&
      current.getUTCFullYear() !== schedule.year
    ) {
      return false;
    }
    if (schedule.anchorDay !== undefined) {
      const firstCandidate = new Date(
        Date.UTC(
          current.getUTCFullYear(),
          current.getUTCMonth(),
          schedule.anchorDay,
        ),
      );
      if (firstCandidate.getUTCMonth() !== current.getUTCMonth()) return false;
      while (!(schedule.weekdays ?? []).includes(firstCandidate.getUTCDay())) {
        firstCandidate.setUTCDate(firstCandidate.getUTCDate() + 1);
      }
      return isoDate(firstCandidate) === date;
    }
    if (!(schedule.weekdays ?? []).includes(weekday)) return false;
    return true;
  }

  if (schedule.kind === "monthly") {
    return (
      schedule.dayOfMonth === current.getUTCDate() &&
      (schedule.year === undefined ||
        schedule.year === current.getUTCFullYear())
    );
  }

  if (schedule.kind === "annual" || schedule.kind === "yearly") {
    if (
      schedule.year !== undefined &&
      schedule.year !== current.getUTCFullYear()
    ) {
      return false;
    }
    if (
      schedule.month !== undefined &&
      current.getUTCMonth() + 1 !== schedule.month
    ) {
      return false;
    }
    return (
      schedule.dayOfMonth === undefined ||
      schedule.dayOfMonth === current.getUTCDate()
    );
  }

  return true;
}

export function interpretLogicalEvents(
  rawEvents: CalendarEvent[],
  startIso: string,
  endIso: string,
): LogicalEvent[] {
  const logicalEvents: LogicalEvent[] = [];

  for (const raw of rawEvents) {
    const schedule = raw.schedule;

    // 1. Non-recurring THROUGH date-range rules (represented as ONE logical multi-day event)
    if (
      schedule?.endKeyword === "THROUGH" &&
      schedule.startDate &&
      schedule.endDate &&
      !schedule.repeat
    ) {
      // Overlaps if not (startDate > endIso || endDate < startIso)
      if (
        !dateIsAfter(schedule.startDate, endIso) &&
        !dateIsBefore(schedule.endDate, startIso)
      ) {
        const dDays = Math.max(
          1,
          daysBetween(schedule.startDate, schedule.endDate) + 1,
        );
        logicalEvents.push({
          id: raw.id,
          ruleId: raw.id,
          title: raw.summary,
          startDate: schedule.startDate,
          endDate: schedule.endDate,
          allDay: !raw.time,
          time: raw.time,
          duration: raw.duration,
          durationDays: dDays,
          tags: raw.tags,
          attendees: raw.attendees,
          location: raw.location,
          mapUrl: raw.mapUrl,
          callUrl: raw.callUrl,
          description: raw.description,
          note: raw.note,
          priority: raw.priority,
          sourceFile: raw.sourceFile,
          lineNumber: raw.lineNumber,
          sourceRule: raw.rawStatement ?? "",
          isRange: schedule.startDate !== schedule.endDate,
          isRecurring: false,
          rawEvent: raw,
          info: raw.info,
          unsupportedClauses: raw.unsupportedClauses,
        });
      }
      continue;
    }

    // 2. Recurring schedules (produce distinct occurrences in the range)
    if (schedule && (schedule.isRecurring || schedule.repeat)) {
      for (
        let current = startIso;
        !dateIsAfter(current, endIso);
        current = addDays(current, 1)
      ) {
        if (!matchesSchedule(current, schedule)) continue;
        logicalEvents.push({
          id: `${raw.id}_${current}`,
          ruleId: raw.id,
          title: raw.summary,
          startDate: current,
          endDate: current,
          allDay: !raw.time,
          time: raw.time,
          duration: raw.duration,
          durationDays: 1,
          tags: raw.tags,
          attendees: raw.attendees,
          location: raw.location,
          mapUrl: raw.mapUrl,
          callUrl: raw.callUrl,
          description: raw.description,
          note: raw.note,
          priority: raw.priority,
          sourceFile: raw.sourceFile,
          lineNumber: raw.lineNumber,
          sourceRule: raw.rawStatement ?? "",
          isRange: false,
          isRecurring: true,
          rawEvent: raw,
          info: raw.info,
          unsupportedClauses: raw.unsupportedClauses,
        });
      }
      continue;
    }

    // 3. Single-day or explicit date rule
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) {
      const targetEndDate = raw.endDate || raw.date;
      if (
        !dateIsAfter(raw.date, endIso) &&
        !dateIsBefore(targetEndDate, startIso)
      ) {
        const dDays = Math.max(1, daysBetween(raw.date, targetEndDate) + 1);
        logicalEvents.push({
          id: raw.id,
          ruleId: raw.id,
          title: raw.summary,
          startDate: raw.date,
          endDate: targetEndDate,
          allDay: !raw.time,
          time: raw.time,
          duration: raw.duration,
          durationDays: dDays,
          tags: raw.tags,
          attendees: raw.attendees,
          location: raw.location,
          mapUrl: raw.mapUrl,
          callUrl: raw.callUrl,
          description: raw.description,
          note: raw.note,
          priority: raw.priority,
          sourceFile: raw.sourceFile,
          lineNumber: raw.lineNumber,
          sourceRule: raw.rawStatement ?? "",
          isRange: raw.date !== targetEndDate,
          isRecurring: false,
          rawEvent: raw,
          info: raw.info,
          unsupportedClauses: raw.unsupportedClauses,
        });
      }
      continue;
    }

    // 4. Raw weekday string without explicit schedule object
    const weekday = WEEKDAYS[raw.date.toLowerCase()];
    if (weekday !== undefined) {
      for (
        let current = startIso;
        !dateIsAfter(current, endIso);
        current = addDays(current, 1)
      ) {
        if (dateFromIso(current).getUTCDay() === weekday) {
          logicalEvents.push({
            id: `${raw.id}_${current}`,
            ruleId: raw.id,
            title: raw.summary,
            startDate: current,
            endDate: current,
            allDay: !raw.time,
            time: raw.time,
            duration: raw.duration,
            durationDays: 1,
            tags: raw.tags,
            attendees: raw.attendees,
            location: raw.location,
            mapUrl: raw.mapUrl,
            callUrl: raw.callUrl,
            description: raw.description,
            note: raw.note,
            priority: raw.priority,
            sourceFile: raw.sourceFile,
            lineNumber: raw.lineNumber,
            sourceRule: raw.rawStatement ?? "",
            isRange: false,
            isRecurring: true,
            rawEvent: raw,
            info: raw.info,
            unsupportedClauses: raw.unsupportedClauses,
          });
        }
      }
    }
  }

  // Sort logical events:
  // 1. By startDate ascending
  // 2. Multi-day range events before single-day events (for neat track packing)
  // 3. Untimed / all-day events before timed events
  // 4. By time ascending
  // 5. By priority
  return logicalEvents.sort((a, b) => {
    if (a.startDate !== b.startDate) {
      return a.startDate.localeCompare(b.startDate);
    }
    if (a.isRange !== b.isRange) {
      return a.isRange ? -1 : 1;
    }
    if (a.allDay !== b.allDay) {
      return a.allDay ? -1 : 1;
    }
    const timeA = a.time || "00:00";
    const timeB = b.time || "00:00";
    if (timeA !== timeB) {
      return timeA.localeCompare(timeB);
    }
    return (a.priority ?? 500) - (b.priority ?? 500);
  });
}

export function filterLogicalEvents(
  events: LogicalEvent[],
  filters: CalendarFilterState,
): LogicalEvent[] {
  return events.filter((event) => {
    // 1. Enabled Sources filter
    if (
      filters.enabledSources.size > 0 &&
      !filters.enabledSources.has(event.sourceFile)
    ) {
      return false;
    }

    // 2. Tags filter: event must match any selected tag
    if (filters.selectedTags.size > 0) {
      const eventTagsLower = event.tags.map((t) => t.toLowerCase());
      const matchesAnyTag = Array.from(filters.selectedTags).some((tag) =>
        eventTagsLower.includes(tag.toLowerCase()),
      );
      if (!matchesAnyTag) return false;
    }

    // 3. Attendees / People filter: event must include any selected person
    if (filters.selectedPeople.size > 0) {
      const attendeesLower = event.attendees.map((a) => a.toLowerCase());
      const matchesAnyPerson = Array.from(filters.selectedPeople).some((person) =>
        attendeesLower.some(
          (att) =>
            att === person.toLowerCase() ||
            att.includes(person.toLowerCase()) ||
            person.toLowerCase().includes(att),
        ),
      );
      if (!matchesAnyPerson) return false;
    }

    // 4. Search text filter: query in title, description, location, or note
    if (filters.searchQuery.trim()) {
      const query = filters.searchQuery.trim().toLowerCase();
      const inTitle = event.title.toLowerCase().includes(query);
      const inDesc = (event.description ?? "").toLowerCase().includes(query);
      const inLoc = (event.location ?? "").toLowerCase().includes(query);
      const inNote = (event.note ?? "").toLowerCase().includes(query);
      if (!inTitle && !inDesc && !inLoc && !inNote) return false;
    }

    return true;
  });
}

export function extractFilterOptions(events: LogicalEvent[]): {
  tags: string[];
  people: string[];
} {
  const tagSet = new Set<string>();
  const peopleSet = new Set<string>();

  for (const event of events) {
    for (const tag of event.tags) {
      if (tag.trim()) tagSet.add(tag.trim());
    }
    for (const attendee of event.attendees) {
      // Clean up bracketed markdown links or emails: e.g. [[Charlie]] -> Charlie, Alice <email> -> Alice
      const clean = attendee
        .replace(/^\[\[|\]\]$/g, "")
        .replace(/<[^>]+>/g, "")
        .trim();
      if (clean) peopleSet.add(clean);
    }
  }

  return {
    tags: Array.from(tagSet).sort((a, b) => a.localeCompare(b)),
    people: Array.from(peopleSet).sort((a, b) => a.localeCompare(b)),
  };
}

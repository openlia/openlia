import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalendarService } from "./calendar";
import { WorkspaceService } from "./workspace";
import { createWorkspaceHandler } from "./app";
import {
  calendarResponseSchema,
  type CalendarCreateRequest,
} from "../shared/calendar";

const binary = process.env.OPENLIA_REMIND_BINARY ?? Bun.which("remind");
let root: string;
let calendar: CalendarService;
const source = "calendar/reminders.rem";
const range = { source, from: "2026-10-01", to: "2026-11-01" };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openlia-calendar-test-"));
  mkdirSync(join(root, "calendar"));
  writeFileSync(join(root, source), "# User calendar\n");
  calendar = new CalendarService(
    new WorkspaceService({ workspaceRoot: root }),
    "Asia/Ho_Chi_Minh",
    binary ?? "/missing-remind",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function appointment(
  revision: string,
  overrides: Partial<CalendarCreateRequest> = {},
): CalendarCreateRequest {
  return {
    source,
    expectedRevision: revision,
    requestId: crypto.randomUUID(),
    title: "Client review",
    start: "2026-10-27T02:00:00.000Z",
    end: "2026-10-27T03:30:00.000Z",
    timezone: "Asia/Ho_Chi_Minh",
    agenda: "Discuss the roadmap",
    attendees: ["Alice", "Bob"],
    location: "Office",
    notifications: "off",
    invitations: "off",
    ...overrides,
  };
}

test("rejects traversal, symlinks, computed includes, executable directives and excessive ranges", async () => {
  await expect(
    calendar.load({ ...range, source: "calendar/../secret.rem" }),
  ).rejects.toThrow();
  await expect(calendar.load({ ...range, to: "2027-10-01" })).rejects.toThrow();
  await expect(
    calendar.load({ ...range, from: "2026-02-30" }),
  ).rejects.toThrow();
  for (const directive of [
    "INCLUDE /etc/passwd",
    "INCLUDE ../secret.rem",
    'INCLUDE ["secret.rem"]',
    "INCLUDECMD echo injected",
    "DO secret.rem",
    "SYSINCLUDE secret.rem",
    "RUN ON",
  ]) {
    writeFileSync(join(root, source), `${directive}\n`);
    await expect(calendar.load(range)).rejects.toThrow();
  }
  writeFileSync(join(root, source), "INCLUDE linked.rem\n");
  symlinkSync(join(root, source), join(root, "calendar/linked.rem"));
  await expect(calendar.load(range)).rejects.toThrow();
});

test("rejects include cycles before executing native Remind", async () => {
  writeFileSync(join(root, source), "INCLUDE other.rem\n");
  writeFileSync(join(root, "calendar/other.rem"), "INCLUDE reminders.rem\n");
  await expect(calendar.load(range)).rejects.toThrow("cycle");
});

test("reports missing native evaluator without creating anything", async () => {
  const unavailable = new CalendarService(
    new WorkspaceService({ workspaceRoot: root }),
    "UTC",
    "/missing-remind",
  );
  await expect(unavailable.load(range)).rejects.toThrow("not installed");
  expect(readFileSync(join(root, source), "utf8")).toBe("# User calendar\n");
});

test("calendar writes enforce same-origin and validate delivery options", async () => {
  const handler = createWorkspaceHandler({ workspaceRoot: root });
  const response = await handler(
    new Request("http://localhost/api/workspace/calendar", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(response.status).toBe(403);
  await expect(
    calendar.create({ ...appointment("revision"), invitations: "on" }),
  ).rejects.toThrow();
  await expect(
    calendar.create(appointment("revision", { end: "2026-10-27T01:00:00Z" })),
  ).rejects.toThrow();
});

describe.skipIf(!binary)("native Remind calendar", () => {
  test("evaluates recurrence, literal includes, date ranges and overnight durations", async () => {
    writeFileSync(
      join(root, source),
      "# Keep this comment\nINCLUDE holidays.rem\nREM Mon AT 09:00 DURATION 60 MSG Standup\nREM 2026-10-27 AT 23:30 DURATION 120 MSG Overnight\n",
    );
    writeFileSync(
      join(root, "calendar/holidays.rem"),
      "REM 2026-10-28 THROUGH 2026-10-30 MSG Holiday\n",
    );
    const before = readFileSync(join(root, source), "utf8");
    const result = await calendar.load(range);
    expect(
      result.events.filter((event) => event.title === "Standup"),
    ).toHaveLength(4);
    const holiday = result.events.filter((event) => event.title === "Holiday");
    expect(holiday).toHaveLength(1);
    expect(holiday[0]).toMatchObject({
      start: "2026-10-28",
      end: "2026-10-31",
      allDay: true,
      sourcePath: "calendar/holidays.rem",
    });
    expect(
      result.events.filter((event) => event.title === "Overnight"),
    ).toHaveLength(1);
    expect(readFileSync(join(root, source), "utf8")).toBe(before);
  });

  test("creates and reloads a complete safe appointment, preserving source and idempotency", async () => {
    const initial = await calendar.load(range);
    const input = appointment(initial.revision);
    const saved = await calendar.create(input);
    expect(saved.events).toContainEqual(
      expect.objectContaining({
        title: input.title,
        start: input.start,
        end: input.end,
        agenda: input.agenda,
        attendees: input.attendees,
        timezone: input.timezone,
        notifications: "off",
      }),
    );
    const content = readFileSync(join(root, source), "utf8");
    expect(content.startsWith("# User calendar\n")).toBe(true);
    expect(content).toContain("NOQUEUE");
    const reloaded = await calendar.load(range);
    expect(reloaded.events).toEqual(saved.events);
    await calendar.create(input);
    expect(readFileSync(join(root, source), "utf8")).toBe(content);
  });

  test("round-trips Unicode, percent signs, brackets, quotes and multiline agendas without injection", async () => {
    const initial = await calendar.load(range);
    const input = appointment(initial.revision, {
      title: 'Cà phê 日本語 50% [shell("touch /tmp/no")] "quoted" \\ text',
      agenda: 'Line 1 [shell("ignored")]\nLine 2 50% "quotes" \\ text',
      attendees: ["Alice, PhD", "Bob [observer]"],
    });
    const saved = await calendar.create(input);
    expect(saved.events[0]?.title).toBe(input.title);
    expect(saved.events[0]?.agenda).toBe(input.agenda);
    expect(saved.events[0]?.attendees).toEqual(input.attendees);
  });

  test("preserves absolute appointment time when the calendar server timezone changes", async () => {
    const initial = await calendar.load(range);
    const input = appointment(initial.revision);
    await calendar.create(input);
    const utcCalendar = new CalendarService(
      new WorkspaceService({ workspaceRoot: root }),
      "UTC",
      binary as string,
    );
    const reloaded = await utcCalendar.load(range);
    expect(reloaded.events[0]?.start).toBe(input.start);
    expect(reloaded.events[0]?.timezone).toBe(input.timezone);
    await expect(
      calendar.create({ ...input, title: "Different appointment" }),
    ).rejects.toThrow("identifier");
  });

  test("detects concurrent changes to included files and leaves original untouched", async () => {
    writeFileSync(join(root, source), "INCLUDE holidays.rem\n");
    writeFileSync(join(root, "calendar/holidays.rem"), "# Original\n");
    const initial = await calendar.load(range);
    writeFileSync(join(root, "calendar/holidays.rem"), "# Changed\n");
    await expect(
      calendar.create(appointment(initial.revision)),
    ).rejects.toThrow("changed");
    expect(readFileSync(join(root, source), "utf8")).toBe(
      "INCLUDE holidays.rem\n",
    );
  });

  test("does not turn daily recurrence or title text into an all-day span", async () => {
    writeFileSync(
      join(root, source),
      "REM 2026-10-27 *1 UNTIL 2026-10-29 MSG Work THROUGH the checklist\n",
    );
    const result = await calendar.load(range);
    expect(result.events).toHaveLength(3);
    expect(result.events.map((event) => event.start)).toEqual([
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
    ]);
  });

  test("fails on native stderr even when Remind exits successfully", async () => {
    writeFileSync(join(root, source), "REM 2026-10-27 AT 99:99 MSG Invalid\n");
    await expect(calendar.load(range)).rejects.toThrow("diagnostics");
  });

  test("HTTP create and reload use actual native evaluation", async () => {
    const handler = createWorkspaceHandler({
      workspaceRoot: root,
      timezone: "Asia/Ho_Chi_Minh",
    });
    const get = () =>
      handler(
        new Request(
          `http://localhost/api/workspace/calendar?${new URLSearchParams(range)}`,
        ),
      );
    const initial = calendarResponseSchema.parse(await (await get()).json());
    const response = await handler(
      new Request("http://localhost/api/workspace/calendar", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify(appointment(initial.revision)),
      }),
    );
    expect(response.status).toBe(201);
    expect(
      calendarResponseSchema.parse(await (await get()).json()).events,
    ).toHaveLength(1);
  });
});

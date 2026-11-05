import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinionViewService } from "./minion-views";
import { WorkspaceService } from "./workspace";
import { CalendarService } from "./calendar";
import { minionViewsSchema } from "../shared/minionViews";
import { createWorkspaceHandler } from "./app";

let root: string;
let service: MinionViewService;
const view = {
  id: "sessions",
  label: "Sessions",
  reader: "json",
  path: "data/items.json",
  fields: ["id", "title", "date", "person_id"],
  title_field: "title",
  date_field: "date",
  id_field: "id",
  max_records: 1,
};
const request = {
  id: "example",
  view: "sessions",
  from: "2026-10-01",
  to: "2026-11-01",
};
function write(path: string, value: unknown) {
  writeFileSync(
    join(root, "minions/example", path),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "minion-views-test-"));
  mkdirSync(join(root, "minions/example/data"), { recursive: true });
  write("data.views.json", { schema: 1, views: [view] });
  write("config.json", { trigger: { on_new_entry: false } });
  write("main.py", "raise RuntimeError('never run for reads')");
  write("data/items.json", [
    { id: "late", title: "Later", date: "2026-10-20", secret: "PRIVATE" },
    { id: "early", title: "Earlier", date: "2026-10-02", secret: "PRIVATE" },
  ]);
  service = new MinionViewService(
    new WorkspaceService({ workspaceRoot: root }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("projects declared scalar fields, ranks before limiting, and preserves provenance", async () => {
  const before = readFileSync(
    join(root, "minions/example/data/items.json"),
    "utf8",
  );
  const result = await service.query(request);
  expect(result.records[0]?.id).toBe("early");
  expect(result.truncated).toBe(true);
  expect(result.matched).toBe(2);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(result.records[0]?.source).toBe(
    "openlia://workspace/minions/example/data/items.json",
  );
  expect(
    readFileSync(join(root, "minions/example/data/items.json"), "utf8"),
  ).toBe(before);
});
test("briefings require local opt-in; scope cannot be widened", async () => {
  await expect(
    service.query({ ...request, purpose: "briefing" }),
  ).rejects.toThrow("not enabled");
  write("config.json", {
    data_views: {
      briefing: ["sessions"],
      scopes: { sessions: { person_id: "self" } },
    },
  });
  await expect(
    service.query({ ...request, filters: { person_id: "other" } }),
  ).rejects.toThrow("override");
  expect(
    (await service.query({ ...request, purpose: "briefing" })).records,
  ).toEqual([]);
});
test("required person scope is not inferred", async () => {
  write("data.views.json", {
    schema: 1,
    views: [{ ...view, required_filters: ["person_id"] }],
  });
  await expect(service.query(request)).rejects.toThrow("explicit scope");
});
test("rejects symlinks, traversal, internals and excessive date ranges", async () => {
  symlinkSync(
    join(root, "minions/example/data/items.json"),
    join(root, "minions/example/data/link.json"),
  );
  write("data.views.json", {
    schema: 1,
    views: [{ ...view, path: "data/link.json" }],
  });
  await expect(service.query(request)).rejects.toThrow("symlink");
  for (const path of ["data/../config.json", "tests/data.json"])
    expect(
      minionViewsSchema.safeParse({ schema: 1, views: [{ ...view, path }] })
        .success,
    ).toBe(false);
  write("data.views.json", {
    schema: 1,
    views: [{ ...view, path: "data/pending/items.json" }],
  });
  await expect(service.query(request)).rejects.toThrow("internals");
  await expect(service.query({ ...request, to: "2027-01-01" })).rejects.toThrow(
    "1–31",
  );
});
test("missing data is unavailable, not an empty successful result", async () => {
  write("data.views.json", {
    schema: 1,
    views: [{ ...view, path: "data/missing.json" }],
  });
  await expect(service.query(request)).rejects.toThrow();
});
test("unknown dates are reported and scan limits fail closed", async () => {
  write("data/items.json", [
    { id: "unknown", title: "Unknown date", date: null },
  ]);
  expect((await service.query(request)).unknown_dates).toBe(1);
  write("data.views.json", {
    schema: 1,
    views: [{ ...view, max_bytes: 1024 }],
  });
  write("data/items.json", JSON.stringify([{ title: "x".repeat(1500) }]));
  await expect(service.query(request)).rejects.toThrow();
});
test("missing config defaults to no scheduled inclusion; malformed settings fail closed", async () => {
  unlinkSync(join(root, "minions/example/config.json"));
  expect(service.describe("example").views[0]?.briefing_enabled).toBe(false);
  write("config.json", { data_views: { briefing: "all" } });
  await expect(service.query(request)).rejects.toThrow();
});
test("API and direct queries have the same projected records and source revision", async () => {
  const handler = createWorkspaceHandler({ workspaceRoot: root });
  const response = await handler(
    new Request("http://localhost/api/minion-views/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
      },
      body: JSON.stringify(request),
    }),
  );
  expect(response.status).toBe(200);
  const result = (await response.json()) as Awaited<
    ReturnType<MinionViewService["query"]>
  >;
  const direct = await service.query(request);
  expect(result.records).toEqual(direct.records);
  expect(result.revision).toBe(direct.revision);
});
test("Markdown projection does not leak raw bodies", async () => {
  write(
    "data/record.md",
    "---\nid: record\ndate: 2026-10-03\n---\n# A note\nPRIVATE BODY",
  );
  write("data.views.json", {
    schema: 1,
    views: [{ ...view, reader: "markdown", path: "data/record.md" }],
  });
  const result = await service.query(request);
  expect(result.records[0]?.title).toBe("A note");
  expect(JSON.stringify(result)).not.toContain("PRIVATE BODY");
});
test("Calendar view delegates to the same runtime service as the dashboard", async () => {
  const workspace = new WorkspaceService({ workspaceRoot: root });
  const calendar = new CalendarService(workspace);
  let called = false;
  calendar.load = async (range) => {
    called = true;
    expect(range.source).toBe("minions/example/data/reminders.rem");
    return { schema: 1, events: [], revision: "sha256:test", timezone: "UTC" };
  };
  write("data.views.json", {
    schema: 1,
    views: [{ ...view, reader: "calendar", path: "data/reminders.rem" }],
  });
  await new MinionViewService(workspace, calendar).query(request);
  expect(called).toBe(true);
});

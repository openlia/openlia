import { afterEach, expect, it, vi } from "vitest";
import { createStoryApi, loadStoryData } from "./fixtures";
import { installStoryNetworkGuard } from "./networkGuard";

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.storybookBlockedRequest;
});

it("creates independent synthetic workspaces for stories", async () => {
  const first = await loadStoryData();
  const second = await loadStoryData();
  expect(first.api).not.toBe(second.api);
  const range = {
    source: "calendar/reminders.rem",
    from: "2026-10-01",
    to: "2026-11-01",
  };
  const initial = await first.api.loadCalendar(range);
  await first.api.createCalendarEvent({
    source: range.source,
    expectedRevision: initial.revision,
    requestId: crypto.randomUUID(),
    title: "Story-only appointment",
    start: "2026-10-27T17:00:00Z",
    end: "2026-10-27T18:00:00Z",
    timezone: "UTC",
    agenda: "Review",
    attendees: [],
    location: "",
    notifications: "off",
    invitations: "off",
  });
  expect((await first.api.loadCalendar(range)).events).toHaveLength(
    initial.events.length + 1,
  );
  expect((await second.api.loadCalendar(range)).events).toHaveLength(
    initial.events.length,
  );
});

it("serves synthetic raw content rather than linking a live API", () => {
  const api = createStoryApi();
  expect(api.rawUrl("review.md")).toMatch(/^data:text\/plain/);
  expect(api.publicShareRawUrl("story-share")).toMatch(/^data:text\/plain/);
});

it("blocks API, server-function, and external fetches before sending them", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("asset"));
  vi.stubGlobal("fetch", fetch);
  installStoryNetworkGuard();
  for (const url of [
    "/api/workspace/file",
    "/_server/request",
    "https://example.com/data",
  ]) {
    await expect(globalThis.fetch(url)).rejects.toThrow(
      "Storybook blocked a live request",
    );
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(document.documentElement.dataset.storybookBlockedRequest).toBe(
    "/data",
  );
  await globalThis.fetch("/assets/preview.js");
  expect(fetch).toHaveBeenCalledOnce();
});

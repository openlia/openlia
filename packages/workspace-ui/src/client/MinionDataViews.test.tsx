import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  minionQueryResultSchema,
  minionViewDescriptionSchema,
} from "../shared/minionViews";
import { MinionDataViews } from "./MinionDataViews";

it("uses the injected runtime API, including TanStack transport", async () => {
  const describeMinionViews = vi.fn().mockResolvedValue(
    minionViewDescriptionSchema.parse({
      schema: 1,
      id: "gym",
      revision: "sha256:test",
      settings: {},
      views: [
        {
          id: "sessions",
          label: "Sessions",
          reader: "json",
          path: "data/items.json",
          fields: ["item", "date"],
          title_field: "item",
          date_field: "date",
          briefing_enabled: false,
        },
      ],
    }),
  );
  const queryMinionView = vi.fn().mockResolvedValue(
    minionQueryResultSchema.parse({
      schema: 1,
      id: "gym",
      view: "sessions",
      status: "ok",
      from: "2026-10-01",
      to: "2026-10-08",
      observed_at: "2026-10-02",
      revision: "sha256:test",
      matched: 2,
      unknown_dates: 0,
      truncated: true,
      records: [
        {
          id: "session",
          title: "Recorded session",
          source: "openlia://workspace/minions/gym/data/items.json",
          fields: { item: "Recorded session" },
        },
      ],
    }),
  );
  render(
    <MinionDataViews id="gym" api={{ describeMinionViews, queryMinionView }} />,
  );
  await screen.findByRole("button", { name: "Read view" });
  fireEvent.click(screen.getByRole("button", { name: "Read view" }));
  await screen.findByRole("button", { name: "Recorded session" });
  expect(queryMinionView.mock.calls[0]?.[0]).toMatchObject({
    id: "gym",
    view: "sessions",
    purpose: "interactive",
  });
  expect(screen.getByText(/Additional records omitted/)).toBeTruthy();
  expect(screen.getByText("Read-only")).toBeTruthy();
  expect(screen.queryByText(/Briefing participation/)).toBeNull();
});
it("distinguishes unavailable data from zero activity", async () => {
  render(
    <MinionDataViews
      id="gym"
      api={{
        describeMinionViews: vi
          .fn()
          .mockRejectedValue(new Error("Unavailable")),
      }}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "does not mean zero activity",
    ),
  );
});

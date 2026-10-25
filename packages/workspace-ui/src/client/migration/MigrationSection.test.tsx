import { render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { MigrationProgress, MigrationSummary } from "../../shared/api";
import {
  MigrationSection,
  type MigrationSectionProps,
} from "./MigrationSection";

const emptyProgress: MigrationProgress = {
  total: 0,
  completed: 0,
  succeeded: 0,
  running: 0,
  pending: 0,
  failed: 0,
  percent: 0,
};

const processingProgress: MigrationProgress = {
  total: 2,
  completed: 1,
  succeeded: 1,
  running: 1,
  pending: 0,
  failed: 0,
  percent: 50,
};

function renderMigration(
  view: "list" | "detail",
  state: string,
  progress?: MigrationProgress,
) {
  const migration: MigrationSummary = {
    id: "mig-test",
    schema: 2,
    state,
    progress,
    stop_intent: false,
    total_sources: 1,
    total_revisions: 0,
    created_at: "2026-10-25T08:24:53Z",
    updated_at: "2026-10-25T08:24:53Z",
  };
  const props: MigrationSectionProps = {
    migrationsList: [migration],
    migrationDetail:
      view === "detail"
        ? {
            schema: 2,
            migration,
            sources: [],
            revisions: [],
            feedback: [],
            worker_status: "sleeping",
          }
        : null,
    loading: false,
    onSelectMigration: vi.fn(),
    onRefresh: vi.fn(),
    onWakeWorker: vi.fn(),
    onStop: vi.fn(),
    onResume: vi.fn(),
    onApprove: vi.fn(async () => {}),
    onDiscard: vi.fn(async () => {}),
    onSubmitFeedback: vi.fn(async () => {}),
  };
  return render(<MigrationSection {...props} />);
}

describe.each(["list", "detail"] as const)("Migration %s progress", (view) => {
  test.each([
    undefined,
    emptyProgress,
    processingProgress,
  ])("shows Applied without a percentage (%j)", (progress) => {
    renderMigration(view, "applied", progress);

    expect(screen.getByText("Applied", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    if (view === "detail") {
      expect(
        screen.getByText(
          "Approved changes have been applied to your workspace.",
        ),
      ).toBeInTheDocument();
    }
  });

  test.each([
    undefined,
    emptyProgress,
  ])("hides progress without jobs (%j)", (progress) => {
    renderMigration(view, "ready_for_review", progress);

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Applied", { exact: true }),
    ).not.toBeInTheDocument();
    if (view === "list") {
      const row = screen.getByText("mig-test").closest("tr")!;
      expect(within(row).getByText("—")).toBeInTheDocument();
    }
  });

  test.each([0, 50])("keeps real job progress visible at %i%%", (percent) => {
    renderMigration(view, "processing", { ...processingProgress, percent });

    expect(screen.getByText(`${percent}%`)).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Processing progress" }),
    ).toHaveAttribute("value", String(percent));
    expect(
      screen.queryByText("Applied", { exact: true }),
    ).not.toBeInTheDocument();
  });

  test("does not confuse completed processing with an applied migration", () => {
    renderMigration(view, "ready_for_review", {
      ...processingProgress,
      completed: 2,
      succeeded: 2,
      running: 0,
      percent: 100,
    });

    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(
      screen.queryByText("Applied", { exact: true }),
    ).not.toBeInTheDocument();
  });
});

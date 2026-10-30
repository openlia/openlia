import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatExecution } from "./ChatExecution";
import type { ChatRun } from "../shared/chat";

afterEach(cleanup);
const failed: ChatRun = {
  run_id: "run-failed",
  request_id: "request-1",
  status: "failed",
  status_source: "recorded",
  submitted_at: 1793091600000,
  status_observed_at: 1793091660000,
  error: "SECRET_PROVIDER_KEY=never-display",
};
const props = {
  run: failed,
  history: [failed],
  hasMore: false,
  busy: false,
  historyError: "",
  onRefresh: vi.fn(),
  onRefreshRun: vi.fn(),
  onMore: vi.fn(),
};

describe("Chat execution recovery", () => {
  it("renders a recorded terminal state with identity and side-effect caveat, never raw provider errors", () => {
    render(<ChatExecution {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("Execution failed");
    expect(screen.getAllByText("run-failed").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/tools may already have changed workspace records/),
    ).toBeVisible();
    expect(
      screen.getByText(/Live Hermes run metadata is no longer available/),
    ).toBeVisible();
    expect(screen.queryByText(/SECRET_PROVIDER_KEY/)).toBeNull();
    expect(screen.queryByRole("button", { name: /retry|send/i })).toBeNull();
  });
  it("retains earlier failed executions when the latest run completes", () => {
    const latest: ChatRun = {
      run_id: "run-completed",
      status: "completed",
      status_source: "hermes",
    };
    render(
      <ChatExecution
        {...props}
        run={latest}
        history={[latest, failed]}
        hasMore
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Execution completed");
    fireEvent.click(screen.getByText("Execution history (2+)"));
    expect(screen.getByText("run-failed")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh run run-failed" }),
    );
    expect(props.onRefreshRun).toHaveBeenCalledWith("run-failed");
    fireEvent.click(
      screen.getByRole("button", { name: "Load earlier executions" }),
    );
    expect(props.onMore).toHaveBeenCalled();
  });
  it("never presents an unconfirmed submission as no execution or failed execution", () => {
    render(
      <ChatExecution
        {...props}
        run={{ run_id: "", status: "unknown", status_source: "unconfirmed" }}
        history={[]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Execution outcome unknown",
    );
    expect(screen.getByText(/Sending is blocked/)).toBeVisible();
    expect(screen.getByText(/empty run ID is not proof/)).toBeVisible();
    expect(screen.queryByText("Execution failed")).toBeNull();
    expect(screen.queryByText(/No records changed/)).toBeNull();
  });
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinanceCheckResponse } from "../../shared/finance";
import {
  OpenLiaOpenUIProvider,
  type OpenLiaOpenUIContextValue,
} from "./context";
import { FinanceValidationCard } from "./FinanceValidationCard";
import { notifyWorkspaceFileChange } from "../workspaceFileChanges";

const path = "finance/main.journal";
function result(
  status: FinanceCheckResponse["status"] = "passed",
): FinanceCheckResponse {
  return {
    schema: 1,
    path,
    status,
    checked_at: "2026-10-25T12:00:00Z",
    fingerprint: `sha256:${"a".repeat(64)}`,
    engine_version: "hledger 1.52.4",
    files: [
      { path, revision: "root" },
      { path: "finance/year.journal", revision: "included" },
    ],
    diagnostics: [],
  };
}
function setup(response = result()) {
  const checkFinanceJournal = vi.fn(async () => response);
  const checkFinanceJournalFreshness = vi.fn(async () => ({
    schema: 1 as const,
    current: true,
    fingerprint: response.fingerprint,
  }));
  const onOpenRecord = vi.fn();
  const context = {
    financeApi: { checkFinanceJournal, checkFinanceJournalFreshness },
    onOpenRecord,
  };
  const view = render(
    <OpenLiaOpenUIProvider value={context}>
      <FinanceValidationCard path={path} />
    </OpenLiaOpenUIProvider>,
  );
  return {
    ...view,
    context,
    checkFinanceJournal,
    checkFinanceJournalFreshness,
    onOpenRecord,
  };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("journal validation card", () => {
  it("checks explicitly and keeps validation distinct from preview reporting", async () => {
    const { checkFinanceJournal, onOpenRecord } = setup();
    expect(checkFinanceJournal).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Not checked");
    fireEvent.click(screen.getByRole("button", { name: "Check journal" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "hledger check passed for this snapshot",
      ),
    );
    expect(checkFinanceJournal).toHaveBeenCalledWith(path);
    expect(
      screen.getByText(/Preview metrics remain non-authoritative/),
    ).toBeDefined();
    expect(screen.getByText(/hledger 1.52.4/)).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "finance/year.journal" }),
    );
    expect(onOpenRecord).toHaveBeenCalledWith("finance/year.journal");
  });

  it.each([
    "failed",
    "unavailable",
    "timed_out",
    "blocked",
    "error",
    "stale",
  ] as const)("renders %s without claiming a successful check", async (status) => {
    setup({
      ...result(status),
      diagnostics: [
        {
          code: "test",
          message: "Actionable diagnostic",
          path: "finance/year.journal",
          line: 3,
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Check journal" }));
    await waitFor(() =>
      expect(screen.getByText("Actionable diagnostic")).toBeDefined(),
    );
    expect(screen.getByRole("status").textContent).not.toContain("passed");
    expect(
      screen.getByRole("button", { name: "finance/year.journal:3" }),
    ).toBeDefined();
  });

  it("invalidates included-file saves immediately but ignores unrelated saves", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Check journal" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("passed"),
    );
    act(() => notifyWorkspaceFileChange("tasks/unrelated.md"));
    expect(screen.getByRole("status").textContent).toContain("passed");
    act(() => notifyWorkspaceFileChange("finance/year.journal"));
    expect(screen.getByRole("status").textContent).toContain("stale");
  });

  it("checks freshness on focus and fails closed when freshness cannot be confirmed", async () => {
    const { checkFinanceJournalFreshness } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Check journal" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("passed"),
    );
    checkFinanceJournalFreshness.mockRejectedValueOnce(new Error("Offline"));
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("stale"),
    );
    expect(
      screen.getByText(/Could not confirm snapshot freshness/),
    ).toBeDefined();
  });

  it("periodically detects external changes without running hledger again", async () => {
    vi.useFakeTimers();
    const { checkFinanceJournal, checkFinanceJournalFreshness } = setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check journal" }));
    });
    expect(screen.getByRole("status").textContent).toContain("passed");
    checkFinanceJournalFreshness.mockResolvedValueOnce({
      schema: 1,
      current: false,
      fingerprint: null,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(screen.getByRole("status").textContent).toContain("stale");
    expect(checkFinanceJournal).toHaveBeenCalledTimes(1);
  });

  it("never displays a passing result if a dependency was saved during the request", async () => {
    let resolveCheck: ((value: FinanceCheckResponse) => void) | undefined;
    const context: OpenLiaOpenUIContextValue = {
      financeApi: {
        checkFinanceJournal: () =>
          new Promise((resolve) => {
            resolveCheck = resolve;
          }),
        checkFinanceJournalFreshness: vi.fn(),
      },
    };
    render(
      <OpenLiaOpenUIProvider value={context}>
        <FinanceValidationCard path={path} />
      </OpenLiaOpenUIProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Check journal" }));
    act(() => notifyWorkspaceFileChange("finance/year.journal"));
    await act(async () => {
      resolveCheck?.(result());
    });
    expect(screen.getByRole("status").textContent).toContain("stale");
  });

  it("discards results when the journal scope changes", async () => {
    const { rerender, context } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Check journal" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("passed"),
    );
    rerender(
      <OpenLiaOpenUIProvider value={context}>
        <FinanceValidationCard path="finance/other.journal" />
      </OpenLiaOpenUIProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe("Not checked");
  });

  it("shows request failures and allows retry", async () => {
    const { checkFinanceJournal } = setup();
    checkFinanceJournal.mockRejectedValueOnce(
      new Error("Authentication required"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check journal" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Authentication required",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check journal" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("passed"),
    );
  });
});

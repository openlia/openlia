import { afterEach, describe, expect, it, vi } from "vitest";
import { httpWorkspaceApi } from "./api";
import {
  isFinanceCheckResponse,
  isFinanceCheckFreshnessResponse,
  type FinanceCheckResponse,
} from "../shared/finance";

const checked: FinanceCheckResponse = {
  schema: 1,
  path: "finance/main.journal",
  status: "passed",
  checked_at: "2026-10-25T12:00:00Z",
  fingerprint: `sha256:${"a".repeat(64)}`,
  engine_version: "hledger 1.52.4",
  files: [{ path: "finance/main.journal", revision: "revision" }],
  diagnostics: [],
};
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("finance API contract", () => {
  it("posts only the journal scope and validates the response", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(checked), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await httpWorkspaceApi.checkFinanceJournal(checked.path)).toEqual(
      checked,
    );
    expect(fetch).toHaveBeenCalledWith("/api/workspace/finance/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: checked.path }),
    });
  });
  it("checks fingerprints without requesting native validation", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ schema: 1, current: false, fingerprint: null }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    expect(
      (
        await httpWorkspaceApi.checkFinanceJournalFreshness(
          checked.path,
          checked.fingerprint!,
        )
      ).current,
    ).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspace/finance/check-status",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          path: checked.path,
          fingerprint: checked.fingerprint,
        }),
      }),
    );
  });
  it("rejects malformed diagnostic responses rather than displaying success", async () => {
    for (const value of [
      { ...checked, status: "balanced" },
      { ...checked, diagnostics: [{ code: "broken", message: 42 }] },
      { ...checked, files: null },
    ])
      expect(isFinanceCheckResponse(value)).toBe(false);
    expect(
      isFinanceCheckFreshnessResponse({
        schema: 1,
        current: "yes",
        fingerprint: null,
      }),
    ).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "passed" }))),
    );
    await expect(
      httpWorkspaceApi.checkFinanceJournal(checked.path),
    ).rejects.toThrow("invalid_api_response");
  });
});

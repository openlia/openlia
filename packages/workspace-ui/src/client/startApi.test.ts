import { afterEach, describe, expect, test, vi } from "vitest";
import { workspaceServerRequest } from "../server/start-api";
import { startWorkspaceApi } from "./startApi";

vi.mock("../server/start-api", () => ({
  workspaceServerRequest: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

describe("Start workspace API", () => {
  test.each([1, 2])("preserves schema-%i migration errors", async (schema) => {
    const payload = {
      schema,
      ok: false,
      error: "Apply failed: patch hash mismatch",
    };
    vi.mocked(workspaceServerRequest).mockResolvedValue({
      status: 400,
      payload,
    });

    await expect(
      startWorkspaceApi.approveMigration("mig-test", "rev-test", "patch-test"),
    ).rejects.toMatchObject({
      message: payload.error,
      status: 400,
      payload,
    });
    expect(workspaceServerRequest).toHaveBeenCalledWith({
      data: {
        body: { revision_id: "rev-test", patch_hash: "patch-test" },
        method: "POST",
        path: "/api/workspace/migration/mig-test/approve",
      },
    });
  });
});

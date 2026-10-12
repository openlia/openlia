import { afterEach, describe, expect, test, vi } from "vitest";
import { httpWorkspaceApi } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HTTP workspace API", () => {
  test("routes memory reads and writes through the dedicated API", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schema: 1,
            path: "@memories/USER.md",
            source: "memory",
            editable: true,
            modified_at: "2026-09-22T00:00:00.000Z",
            size: 5,
            content: "Hello",
            revision: "sha256:after",
            ok: true,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await httpWorkspaceApi.loadFile("@memories/USER.md");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/memory/file?name=USER.md",
      undefined,
    );
    await httpWorkspaceApi.saveFile(
      "@memories/USER.md",
      "Hello",
      "sha256:before",
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/memory/file",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          content: "Hello",
          expected_revision: "sha256:before",
          name: "USER.md",
        }),
      }),
    );
  });
  test("rejects a successful response that does not match the contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ auth_required: false, schema: 1 })),
      ),
    );

    await expect(httpWorkspaceApi.loadSession()).rejects.toThrow(
      "invalid_api_response",
    );
  });

  test("validates tree entries instead of accepting arbitrary arrays", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              entries: [{ path: "notes.md", kind: "file" }],
              schema: 1,
              truncated: false,
            }),
          ),
      ),
    );

    await expect(httpWorkspaceApi.loadTree()).rejects.toThrow(
      "invalid_api_response",
    );
  });

  test("sends writes through the HTTP contract", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            editable: true,
            modified_at: "2026-09-22T00:00:00.000Z",
            ok: true,
            path: "notes.md",
            revision: "sha256:after",
            schema: 1,
            size: 5,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await httpWorkspaceApi.saveFile("notes.md", "Hello", "sha256:before");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace/file",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          content: "Hello",
          expected_revision: "sha256:before",
          path: "notes.md",
        }),
      }),
    );
  });

  test("sends deletes through the HTTP contract", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            path: "notes.md",
            schema: 1,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await httpWorkspaceApi.deleteFile("notes.md", "sha256:before");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace/file",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          expected_revision: "sha256:before",
          path: "notes.md",
        }),
      }),
    );
  });

  test("loads and validates workspace activity through the HTTP contract", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            branch: "main",
            commits: [
              {
                author: "Tester",
                files: [{ path: "notes.md", status: "modified" }],
                hash: "1234567890abcdef",
                message: "update notes",
                shortHash: "1234567",
                timestamp: "2026-09-28T00:00:00.000Z",
              },
            ],
            gitConfigured: true,
            recentFiles: [
              {
                editable: true,
                modified_at: "2026-09-28T00:00:00.000Z",
                path: "notes.md",
                size: 10,
              },
            ],
            schema: 1,
            uncommitted: [{ path: "draft.md", status: "added" }],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const activity = await httpWorkspaceApi.loadActivity();
    expect(activity.gitConfigured).toBe(true);
    expect(activity.commits.length).toBe(1);
    expect(activity.uncommitted.length).toBe(1);
    expect(activity.recentFiles.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace/activity",
      undefined,
    );
  });
});

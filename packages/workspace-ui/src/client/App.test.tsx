import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthLoginResponse,
  AuthSessionResponse,
  WorkspaceDeleteResponse,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceMoveResponse,
  WorkspaceRenameResponse,
  WorkspaceTreeEntry,
  WorkspaceTreeResponse,
  WorkspaceUploadFileResponse,
  WorkspaceWriteResponse,
} from "../shared/api";
import { App } from "./App";
import type { WorkspaceApi } from "./api";

function createTestApi(overrides?: Partial<WorkspaceApi>): WorkspaceApi {
  const entries: WorkspaceTreeEntry[] = [
    { editable: true, kind: "file", path: "notes/welcome.md" },
    { editable: true, kind: "file", path: "config/settings.yaml" },
    { editable: false, kind: "file", path: "docs/manual.pdf" },
  ];

  const files: Record<string, WorkspaceFile> = {
    "notes/welcome.md": {
      content: "# Welcome\n\nHello **OpenLia** workspace!",
      editable: true,
      modified_at: "2026-04-15T00:00:00.000Z",
      ok: true,
      path: "notes/welcome.md",
      revision: "rev-welcome-1",
      schema: 1,
      size: 42,
    },
    "config/settings.yaml": {
      content: "theme: dark\nport: 8089\n",
      editable: true,
      modified_at: "2026-04-15T00:00:00.000Z",
      ok: true,
      path: "config/settings.yaml",
      revision: "rev-yaml-1",
      schema: 1,
      size: 23,
    },
  };

  const metadata: Record<string, WorkspaceFileMetadata> = {
    "docs/manual.pdf": {
      editable: false,
      modified_at: "2026-04-15T00:00:00.000Z",
      ok: true,
      path: "docs/manual.pdf",
      revision: "rev-pdf-1",
      schema: 1,
      size: 10240,
    },
  };

  let session: AuthSessionResponse = {
    auth_provider: "password",
    auth_required: true,
    authenticated: true,
    schema: 1,
  };

  return {
    createFile: vi.fn(
      async ({ path, content = "" }): Promise<WorkspaceWriteResponse> => ({
        editable: true,
        modified_at: "2026-04-15T01:00:00.000Z",
        ok: true,
        path,
        revision: "rev-created",
        schema: 1,
        size: content.length,
      }),
    ),
    deleteFile: vi.fn(
      async (path): Promise<WorkspaceDeleteResponse> => ({
        deleted: true,
        ok: true,
        path,
        schema: 1,
      }),
    ),
    downloadUrl: (path) =>
      `/api/workspace/download?path=${encodeURIComponent(path)}`,
    loadFile: vi.fn(async (path): Promise<WorkspaceFile> => {
      const f = files[path];
      if (!f) throw new Error("file_not_found");
      return f;
    }),
    loadFileMetadata: vi.fn(async (path): Promise<WorkspaceFileMetadata> => {
      const m = metadata[path];
      if (!m) throw new Error("file_not_found");
      return m;
    }),
    loadSession: vi.fn(async (): Promise<AuthSessionResponse> => session),
    loadTree: vi.fn(
      async (): Promise<WorkspaceTreeResponse> => ({
        entries,
        ok: true,
        schema: 1,
        truncated: false,
      }),
    ),
    login: vi.fn(async (): Promise<AuthLoginResponse> => {
      session = {
        auth_provider: "password",
        auth_required: true,
        authenticated: true,
        schema: 1,
      };
      return { authenticated: true, ok: true, schema: 1 };
    }),
    logout: vi.fn(
      async (): Promise<{ schema: 1; ok: true; authenticated: boolean }> => {
        session = {
          auth_provider: "password",
          auth_required: true,
          authenticated: false,
          schema: 1,
        };
        return { authenticated: false, ok: true, schema: 1 };
      },
    ),
    moveFile: vi.fn(
      async (sourcePath, destinationDir): Promise<WorkspaceMoveResponse> => {
        const fileName = sourcePath.split("/").at(-1) ?? sourcePath;
        const newPath = destinationDir
          ? `${destinationDir}/${fileName}`
          : fileName;
        return {
          new_path: newPath,
          ok: true,
          old_path: sourcePath,
          schema: 1,
        };
      },
    ),
    rawUrl: (path) => `about:blank#${encodeURIComponent(path)}`,
    renameFile: vi.fn(
      async (path, newName): Promise<WorkspaceRenameResponse> => ({
        new_path: path.includes("/")
          ? `${path.slice(0, path.lastIndexOf("/"))}/${newName}`
          : newName,
        ok: true,
        old_path: path,
        schema: 1,
      }),
    ),
    saveFile: vi.fn(
      async (path, content): Promise<WorkspaceWriteResponse> => ({
        editable: true,
        modified_at: "2026-04-15T01:00:00.000Z",
        ok: true,
        path,
        revision: "rev-saved-2",
        schema: 1,
        size: content.length,
      }),
    ),
    uploadFile: vi.fn(
      async (destinationPath, file): Promise<WorkspaceUploadFileResponse> => ({
        editable: false,
        modified_at: "2026-04-15T01:00:00.000Z",
        ok: true,
        path: destinationPath,
        revision: "rev-uploaded",
        schema: 1,
        size: file.size,
      }),
    ),
    ...overrides,
  };
}

describe("Workspace UI App", () => {
  it("renders password login gate when unauthenticated and logs in", async () => {
    let authenticated = false;
    const api = createTestApi({
      loadSession: vi.fn(
        async (): Promise<AuthSessionResponse> => ({
          auth_provider: "password",
          auth_required: true,
          authenticated,
          schema: 1,
        }),
      ),
      login: vi.fn(async (): Promise<AuthLoginResponse> => {
        authenticated = true;
        return { authenticated: true, ok: true, schema: 1 };
      }),
    });

    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", { name: "Sign in to Workspace" }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret-pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByText("Select a file to view or edit"),
    ).toBeInTheDocument();
    expect(api.login).toHaveBeenCalledWith("secret-pass", undefined);
  });

  it("renders OIDC SSO sign-in link when auth_provider is oidc", async () => {
    const api = createTestApi({
      loadSession: vi.fn(
        async (): Promise<AuthSessionResponse> => ({
          auth_provider: "oidc",
          auth_required: true,
          authenticated: false,
          schema: 1,
        }),
      ),
    });

    render(<App api={api} />);

    const ssoLink = await screen.findByRole("link", {
      name: "Sign in with SSO",
    });
    expect(ssoLink).toHaveAttribute(
      "href",
      expect.stringContaining("/api/auth/oidc/login"),
    );
  });

  it("opens Markdown files in Preview mode by default, non-Markdown text files in Edit mode, and binary files in View-only ArtifactPane", async () => {
    window.history.replaceState(null, "", "/files/notes/welcome.md");
    const api = createTestApi();

    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", { name: "Welcome" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Switch to non-Markdown text file (YAML) -> opens in Edit mode
    fireEvent.click(screen.getByTestId("workspace-directory-config"));
    fireEvent.click(screen.getByRole("button", { name: "settings.yaml" }));

    await waitFor(() => {
      expect(api.loadFile).toHaveBeenCalledWith("config/settings.yaml");
    });
    expect(await screen.findByLabelText("Code editor")).toBeInTheDocument();

    // Switch to binary file (PDF) -> opens in View-only ArtifactPane
    fireEvent.click(screen.getByTestId("workspace-directory-docs"));
    fireEvent.click(screen.getByRole("button", { name: /^manual\.pdf/i }));

    await waitFor(() => {
      expect(api.loadFileMetadata).toHaveBeenCalledWith("docs/manual.pdf");
    });
    expect(await screen.findByText("View only artifact")).toBeInTheDocument();
    expect(screen.getByTitle("Preview of docs/manual.pdf")).toBeInTheDocument();
  });
});

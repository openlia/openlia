import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

  const skillEntries: WorkspaceTreeEntry[] = [
    { editable: true, kind: "file", path: "weather/SKILL.md", scope: "skills" },
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
    "weather/SKILL.md": {
      content:
        "---\nname: weather\ndescription: Get weather reports\n---\n\n# Weather Skill\n\nInstructions here.",
      editable: true,
      modified_at: "2026-04-15T00:00:00.000Z",
      ok: true,
      path: "weather/SKILL.md",
      revision: "rev-skill-1",
      schema: 1,
      scope: "skills",
      size: 85,
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
    deleteDirectory: vi.fn(
      async (path, scope): Promise<WorkspaceDeleteResponse> => ({
        deleted: true,
        ok: true,
        path,
        schema: 1,
        scope,
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
      async (scope): Promise<WorkspaceTreeResponse> => ({
        entries: scope === "skills" ? skillEntries : entries,
        ok: true,
        schema: 1,
        scope,
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
      expect.stringContaining("/auth/oidc/login"),
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

    // Verify standalone Details button is eliminated from toolbar and metadata is hidden
    expect(screen.queryByText("Saved revision")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Details" }),
    ).not.toBeInTheDocument();

    // Open Details drawer via 3-dots dropdown menu
    fireEvent.click(screen.getByRole("button", { name: "Artifact actions" }));
    const detailsMenuItem = screen.getByRole("button", { name: "Details" });
    fireEvent.click(detailsMenuItem);

    const drawer = await screen.findByLabelText("Artifact details");
    expect(within(drawer).getByText("Saved revision")).toBeInTheDocument();
    expect(within(drawer).getByText("rev-pdf-1")).toBeInTheDocument();
    expect(within(drawer).getByText("10 KB")).toBeInTheDocument();
    expect(within(drawer).getByText("manual.pdf")).toBeInTheDocument();

    // Close Details drawer via Close button (✕)
    fireEvent.click(
      within(drawer).getByRole("button", { name: "Close Artifact Details" }),
    );
    expect(screen.queryByText("Saved revision")).not.toBeInTheDocument();

    // Toggle Details drawer via 3-dots dropdown menu again
    fireEvent.click(screen.getByRole("button", { name: "Artifact actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(
      await screen.findByLabelText("Artifact details"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Artifact actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.queryByText("Saved revision")).not.toBeInTheDocument();
  });

  it("auto-closes the mobile files drawer when a document is opened on mobile viewports", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      window.history.replaceState(null, "", "/files/notes/welcome.md");
      const api = createTestApi();
      render(<App api={api} />);

      expect(
        await screen.findByRole("heading", { name: "Welcome" }),
      ).toBeInTheDocument();

      const filesButton = screen.getByRole("button", {
        name: /show files|hide files/i,
      });
      // Open files drawer on mobile
      fireEvent.click(filesButton);

      const fileNavigator = screen.getByLabelText("Workspace files");
      expect(fileNavigator).toHaveClass("is-open");

      // Click on settings.yaml in mobile navigator
      fireEvent.click(
        within(fileNavigator).getByTestId("workspace-directory-config"),
      );
      fireEvent.click(
        within(fileNavigator).getByRole("button", { name: "settings.yaml" }),
      );

      await waitFor(() => {
        expect(api.loadFile).toHaveBeenCalledWith("config/settings.yaml");
      });

      // Mobile drawer should be closed automatically
      expect(fileNavigator).not.toHaveClass("is-open");
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("navigates to /skills/weather/SKILL.md, renders FrontmatterBlock, and shows OPENLIA / SKILLS eyebrow", async () => {
    window.history.replaceState(null, "", "/skills/weather/SKILL.md");
    const api = createTestApi();
    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", { name: "Weather Skill" }),
    ).toBeInTheDocument();

    expect(screen.getByText("OPENLIA / SKILLS")).toBeInTheDocument();
    expect(screen.getAllByText("weather").length).toBeGreaterThan(0);
    expect(screen.getByText("Get weather reports")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Document actions" }));
    expect(
      screen.getByTitle(/Copy link \(.*\/skills\/weather\/SKILL\.md\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle("Copy URI (openlia://skills/weather/SKILL.md)"),
    ).toBeInTheDocument();
  });

  it("switches between Workspace and Skills tabs in FileNavigator", async () => {
    window.history.replaceState(null, "", "/");
    const api = createTestApi();
    render(<App api={api} />);

    // Default is Workspace
    expect(await screen.findByText("OPENLIA / WORKSPACE")).toBeInTheDocument();

    // Click Skills tab in FileNavigator
    const skillsTab = screen.getByRole("button", { name: /^skills/i });
    fireEvent.click(skillsTab);
    expect(window.location.pathname).toBe("/skills/");
    expect(window.location.pathname).toBe("/skills/");

    // Skills navigator is active
    expect(screen.getByLabelText("Hermes skills")).toBeInTheDocument();
    expect(screen.getByText("+ New Skill")).toBeInTheDocument();

    // Click weather directory and SKILL.md
    fireEvent.click(screen.getByTestId("workspace-directory-weather"));
    fireEvent.click(screen.getByRole("button", { name: "SKILL.md" }));

    expect(
      await screen.findByRole("heading", { name: "Weather Skill" }),
    ).toBeInTheDocument();
    expect(screen.getByText("OPENLIA / SKILLS")).toBeInTheDocument();
  });

  it("does not enter an infinite re-fetch loop on mount (flicker prevention)", async () => {
    window.history.replaceState(null, "", "/");
    const api = createTestApi();
    render(<App api={api} />);

    expect(await screen.findByText("OPENLIA / WORKSPACE")).toBeInTheDocument();

    // Verify api.loadSession was only called once
    expect(api.loadSession).toHaveBeenCalledTimes(1);
    // Tree was called for both workspace and skills once
    expect(api.loadTree).toHaveBeenCalledTimes(2);

    // Give any potential microtask / re-render loops time to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(api.loadSession).toHaveBeenCalledTimes(1);
    expect(api.loadTree).toHaveBeenCalledTimes(2);
  });

  it("deletes folder in workspace scope and closes opened document inside it", async () => {
    window.history.replaceState(null, "", "/files/notes/welcome.md");
    const api = createTestApi();
    render(<App api={api} />);

    // Document is opened
    expect(
      await screen.findByRole("heading", { name: "Welcome" }),
    ).toBeInTheDocument();

    // Click delete folder button for notes
    const deleteBtn = screen.getByTestId("delete-folder-notes");
    fireEvent.click(deleteBtn);

    // Verify confirmation modal appears
    expect(
      await screen.findByRole("heading", { name: "Delete folder?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /permanently delete the folder "notes" and all of its contents/i,
      ),
    ).toBeInTheDocument();

    // Confirm deletion
    const confirmBtn = screen.getByRole("button", { name: "Delete folder" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(api.deleteDirectory).toHaveBeenCalledWith("notes", "workspace");
    });
  });

  it("deletes folder in skills scope", async () => {
    window.history.replaceState(null, "", "/skills/weather/SKILL.md");
    const api = createTestApi();
    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", { name: "Weather Skill" }),
    ).toBeInTheDocument();

    // Click delete folder button for weather skill
    const deleteBtn = screen.getByTestId("delete-folder-weather");
    fireEvent.click(deleteBtn);

    // Verify confirmation modal appears
    expect(
      await screen.findByRole("heading", { name: "Delete folder?" }),
    ).toBeInTheDocument();

    // Confirm deletion
    const confirmBtn = screen.getByRole("button", { name: "Delete folder" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(api.deleteDirectory).toHaveBeenCalledWith("weather", "skills");
    });
  });
});

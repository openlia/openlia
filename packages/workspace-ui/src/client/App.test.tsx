import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";
import { ApiError, type WorkspaceApi } from "./api";
import { createMockWorkspaceApi } from "./mockApi";
import { buildCanonicalWorkspaceUri } from "./openliaLinks";

const firebaseMocks = vi.hoisted(() => {
  type Account = { displayName: string | null; email: string | null };
  let initialAccount: Account | null = null;

  return {
    setInitialAccount(account: Account | null) {
      initialAccount = account;
    },
    signInWithGoogle: vi.fn(),
    signOutFirebase: vi.fn(async () => undefined),
    subscribeToFirebaseAuth: vi.fn(
      (
        _config: unknown,
        onAccountChange: (account: Account | null) => void,
      ) => {
        onAccountChange(initialAccount);
        return () => undefined;
      },
    ),
  };
});

vi.mock("./firebase", () => firebaseMocks);

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  firebaseMocks.signInWithGoogle.mockReset();
  firebaseMocks.signOutFirebase.mockReset();
  firebaseMocks.signOutFirebase.mockResolvedValue(undefined);
  firebaseMocks.setInitialAccount(null);
});

function setEditorText(editor: HTMLElement, value: string): void {
  const view = EditorView.findFromDOM(editor);
  if (!view) throw new Error("CodeMirror view was not found");
  act(() => {
    view.dispatch({
      changes: { from: 0, insert: value, to: view.state.doc.length },
    });
  });
}

function createFirebaseApi(
  baseApi: WorkspaceApi,
  loginWithFirebase: WorkspaceApi["loginWithFirebase"] = async () => ({
    ok: true,
    schema: 1,
  }),
): WorkspaceApi {
  return {
    ...baseApi,
    async loadSession() {
      return {
        auth_provider: "firebase",
        auth_required: true,
        authenticated: false,
        firebase_config: {
          apiKey: "dummy-key",
          authDomain: "dummy.firebaseapp.com",
          projectId: "dummy-project",
        },
        schema: 1,
      };
    },
    loginWithFirebase,
  };
}

describe("workspace application", () => {
  test("opens binary files in the artifact view instead of showing a document error", async () => {
    const baseApi = createMockWorkspaceApi();
    const artifact = {
      editable: false,
      modified_at: "2026-09-22T00:00:00.000Z",
      path: "sources/artifacts/sample.bin",
      size: 2048,
    };
    const api: WorkspaceApi = {
      ...baseApi,
      async loadFile(path) {
        if (path === artifact.path) {
          throw new ApiError(415, {
            error: "binary_file",
            ok: false,
            schema: 1,
          });
        }
        return baseApi.loadFile(path);
      },
      async loadFileMetadata(path) {
        if (path === artifact.path) return artifact;
        return baseApi.loadFileMetadata(path);
      },
      async loadTree() {
        const response = await baseApi.loadTree();
        return {
          ...response,
          entries: [
            ...response.entries,
            { ...artifact, kind: "file" as const },
          ],
        };
      },
      rawUrl(path) {
        return `/api/workspace/raw?${new URLSearchParams({ path })}`;
      },
    };

    window.history.replaceState(
      null,
      "",
      "/files/sources/artifacts/sample.bin",
    );
    render(<App api={api} />);

    expect(
      await screen.findByRole("region", { name: "Non-text artifact" }),
    ).toBeInTheDocument();
    expect(screen.getByText("View only artifact")).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("region", { name: "Non-text artifact" }),
      ).getByRole("link", { name: /Open in New Tab/ }),
    ).toHaveAttribute(
      "href",
      "/api/workspace/raw?path=sources%2Fartifacts%2Fsample.bin",
    );
    expect(screen.queryByText("This document could not be opened")).toBeNull();
  });

  test("confirms and deletes a non-text artifact", async () => {
    const baseApi = createMockWorkspaceApi();
    let entries = [
      ...(await baseApi.loadTree()).entries,
      {
        editable: false,
        kind: "file" as const,
        modified_at: "2026-09-22T00:00:00.000Z",
        path: "sample.png",
        size: 1024,
      },
    ];
    let deletedPath = "";
    const api: WorkspaceApi = {
      ...baseApi,
      async deleteFile(path, revision) {
        deletedPath = path;
        entries = entries.filter((e) => e.path !== path);
        return { ok: true, path, schema: 1 };
      },
      async loadFile(path) {
        if (path === "sample.png") {
          throw new ApiError(415, {
            error: "binary_file",
            ok: false,
            schema: 1,
          });
        }
        return baseApi.loadFile(path);
      },
      async loadFileMetadata(path) {
        if (path === "sample.png") {
          return {
            editable: false,
            modified_at: "2026-09-22T00:00:00.000Z",
            path: "sample.png",
            revision: "sha256:png-rev",
            size: 1024,
          };
        }
        return baseApi.loadFileMetadata(path);
      },
      async loadTree() {
        return { entries, schema: 1, truncated: false };
      },
      rawUrl(path) {
        return `/api/workspace/raw?${new URLSearchParams({ path })}`;
      },
    };

    window.history.replaceState(null, "", "/files/sample.png");
    render(<App api={api} />);

    expect(
      await screen.findByRole("region", { name: "Non-text artifact" }),
    ).toBeInTheDocument();

    const deleteBtn = await screen.findByRole("button", {
      name: "Delete file",
    });
    fireEvent.click(deleteBtn);

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      'permanently delete "sample.png"',
    );

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Recent Changes" }),
      ).toBeInTheDocument(),
    );
    expect(deletedPath).toBe("sample.png");
    expect(
      screen.queryByRole("region", { name: "Non-text artifact" }),
    ).toBeNull();
  });

  test("opens a document, tracks edits, and saves it", async () => {
    render(<App api={createMockWorkspaceApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", {
      name: "Code editor",
    });
    expect(editor).toHaveTextContent("Hello");
    setEditorText(editor, "Hello\nworld");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
  });

  test("opens configuration and saves workspace visibility settings", async () => {
    render(<App api={createMockWorkspaceApi()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Configuration" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Workspace configuration" }),
    ).toBeInTheDocument();
    expect(screen.getByText("0.1.0")).toBeInTheDocument();

    const configurationToggle = screen.getByLabelText(
      "Hide configuration files",
    );
    expect(configurationToggle).toBeChecked();
    fireEvent.click(configurationToggle);

    await waitFor(() => expect(configurationToggle).not.toBeChecked());
    expect(window.location.pathname).toBe("/configuration");
  });

  test("keeps the draft visible when saving encounters a revision conflict", async () => {
    render(<App api={createMockWorkspaceApi({ scenario: "conflict" })} />);
    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", {
      name: "Code editor",
    });
    setEditorText(editor, "draft");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file changed after you opened it.",
    );
    expect(editor).toHaveTextContent("draft");
  });

  test("enables memory documents, edits both live identities, and disables their visibility", async () => {
    const api = createMockWorkspaceApi();
    render(<App api={api} />);
    expect(
      screen.queryByRole("heading", { name: "Assistant memory" }),
    ).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "Configuration" }),
    );
    const toggle = await screen.findByLabelText(
      "Enable user profile and memory editing",
    );
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    await screen.findByRole("heading", {
      name: "Assistant memory",
    });
    for (const name of ["USER.md", "MEMORY.md"]) {
      fireEvent.click(await screen.findByRole("button", { name }));
      await waitFor(() =>
        expect(window.location.pathname).toBe(`/memory/${name}`),
      );
      const pane = screen.getByRole("region", { name: "Document workspace" });
      expect(
        within(pane).queryByRole("button", { name: "Delete file" }),
      ).toBeNull();
      expect(
        within(pane).queryByRole("button", { name: "Rename..." }),
      ).toBeNull();
      expect(
        within(pane).queryByRole("button", { name: "Move..." }),
      ).toBeNull();
      fireEvent.click(within(pane).getByRole("button", { name: "Edit" }));
      const editor = await screen.findByRole("textbox", {
        name: "Code editor",
      });
      setEditorText(editor, `# Updated ${name}`);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled(),
      );
      expect((await api.loadFile(`@memories/${name}`)).content).toBe(
        `# Updated ${name}`,
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    fireEvent.click(
      await screen.findByLabelText("Enable user profile and memory editing"),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Enable user profile and memory editing"),
      ).not.toBeChecked(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(
      screen.queryByRole("heading", { name: "Assistant memory" }),
    ).toBeNull();
    await expect(api.loadFile("@memories/USER.md")).rejects.toMatchObject({
      status: 403,
    });
  });

  test("opens a memory deep link and protects its draft when navigating away", async () => {
    const api = createMockWorkspaceApi();
    await api.updateSettings({
      ...(await api.loadSettings()),
      enable_memory_editing: true,
    });
    window.history.replaceState(null, "", "/memory/USER.md?view=edit");
    render(<App api={api} />);
    const editor = await screen.findByRole("textbox", { name: "Code editor" });
    setEditorText(editor, "Unsaved user profile");
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(editor).toHaveTextContent("Unsaved user profile");
    expect(window.location.pathname).toBe("/memory/USER.md");
  });

  test("shows a missing memory file and creates it on an explicit save", async () => {
    const base = createMockWorkspaceApi();
    await base.updateSettings({
      ...(await base.loadSettings()),
      enable_memory_editing: true,
    });
    let missing = true;
    const saveFile = vi.fn(
      async (...args: Parameters<WorkspaceApi["saveFile"]>) => {
        const saved = await base.saveFile(...args);
        missing = false;
        return { ...saved, missing: false };
      },
    );
    const api: WorkspaceApi = {
      ...base,
      saveFile,
      async loadFile(path) {
        const file = await base.loadFile(path);
        return path === "@memories/MEMORY.md" && missing
          ? { ...file, missing: true, content: "", size: 0, modified_at: "" }
          : file;
      },
    };
    window.history.replaceState(null, "", "/memory/MEMORY.md");
    render(<App api={api} />);
    expect(
      await screen.findByText(/This file has not been created yet/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled(),
    );
    expect(saveFile).toHaveBeenCalledWith(
      "@memories/MEMORY.md",
      "",
      expect.any(String),
    );
    expect(screen.queryByText(/This file has not been created yet/)).toBeNull();
  });

  test("preserves a memory draft across external disabling and re-enabling", async () => {
    const api = createMockWorkspaceApi();
    const settings = {
      ...(await api.loadSettings()),
      enable_memory_editing: true,
    };
    await api.updateSettings(settings);
    window.history.replaceState(null, "", "/memory/USER.md?view=edit");
    render(<App api={api} />);
    const editor = await screen.findByRole("textbox", { name: "Code editor" });
    setEditorText(editor, "My unsaved profile");
    await api.updateSettings({ ...settings, enable_memory_editing: false });
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Memory editing was disabled",
      ),
    );
    expect(editor).toHaveTextContent("My unsaved profile");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    const toggle = await screen.findByLabelText(
      "Enable user profile and memory editing",
    );
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    const recoveredEditor = await screen.findByRole("textbox", {
      name: "Code editor",
    });
    expect(recoveredEditor).toHaveTextContent("My unsaved profile");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled(),
    );
    expect((await api.loadFile("@memories/USER.md")).content).toBe(
      "My unsaved profile",
    );
  });

  test("confirms and deletes the selected document", async () => {
    render(<App api={createMockWorkspaceApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));

    fireEvent.click(await screen.findByRole("button", { name: "Delete file" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      'permanently delete "notes.md"',
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Recent Changes" }),
      ).toBeInTheDocument(),
    );
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(screen.queryByRole("button", { name: "notes.md" })).toBeNull();
    expect(window.location.pathname).toBe("/");
  });

  test("requires explicit discard before deleting a dirty document", async () => {
    render(<App api={createMockWorkspaceApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", {
      name: "Code editor",
    });
    setEditorText(editor, "unsaved");

    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Deleting it will discard the draft",
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard and delete" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Recent Changes" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByDisplayValue("unsaved")).toBeNull();
  });

  test("protects a dirty draft before switching documents", async () => {
    render(<App api={createMockWorkspaceApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", {
      name: "Code editor",
    });
    setEditorText(editor, "draft");
    fireEvent.click(screen.getByRole("button", { name: "calendar" }));
    fireEvent.click(screen.getByRole("button", { name: "event.md" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Keep your draft?",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(editor).toHaveTextContent("draft");
  });

  test("shows the login gate and loads the workspace after authentication", async () => {
    render(<App api={createMockWorkspaceApi({ scenario: "auth" })} />);
    const password = await screen.findByLabelText("Password");
    fireEvent.change(password, {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByRole("button", { name: "notes.md" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  test("shows Google Sign-In and hides password form when Firebase Auth is configured without exposing authorized email", async () => {
    const baseApi = createMockWorkspaceApi({ scenario: "auth" });
    const api: WorkspaceApi = {
      ...baseApi,
      async loadSession() {
        return {
          auth_provider: "firebase",
          auth_required: true,
          authenticated: false,
          firebase_config: {
            apiKey: "dummy-key",
            authDomain: "dummy.firebaseapp.com",
            projectId: "dummy-project",
          },
          schema: 1,
        };
      },
      async loginWithFirebase(_idToken) {
        return { ok: true, schema: 1 };
      },
    };

    render(<App api={api} />);

    expect(
      await screen.findByRole("button", { name: "Sign in with Google" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Only the authorized account can access this workspace\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Authorized User")).toBeNull();
    expect(screen.queryByText(/@/)).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  test("shows the denied Google account and lets the user sign it out", async () => {
    const baseApi = createMockWorkspaceApi({ scenario: "auth" });
    const api: WorkspaceApi = {
      ...baseApi,
      async loadSession() {
        return {
          auth_provider: "firebase",
          auth_required: true,
          authenticated: false,
          firebase_config: {
            apiKey: "dummy-key",
            authDomain: "dummy.firebaseapp.com",
            projectId: "dummy-project",
          },
          schema: 1,
        };
      },
      async loginWithFirebase() {
        throw new ApiError(403, {
          error: "forbidden_user",
          ok: false,
          schema: 1,
        });
      },
    };
    firebaseMocks.signInWithGoogle.mockResolvedValueOnce({
      account: {
        displayName: "Alex Johnson",
        email: "alex@example.com",
      },
      idToken: "firebase-token",
    });

    render(<App api={api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Google" }),
    );

    expect(await screen.findByText("Alex Johnson")).toBeInTheDocument();
    expect(screen.getByText("alex@example.com")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Access denied: The account signed in is not authorized for this workspace.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use another Google account" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out of Google" }));

    await waitFor(() => {
      expect(screen.queryByText("alex@example.com")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Sign in with Google" }),
      ).toBeInTheDocument();
    });
    expect(firebaseMocks.signOutFirebase).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "dummy-project" }),
    );
  });

  test("lets a denied account switch to another Google account", async () => {
    let attempts = 0;
    const baseApi = createMockWorkspaceApi({ scenario: "auth" });
    const api = createFirebaseApi(baseApi, async (idToken) => {
      attempts += 1;
      if (attempts === 1) {
        throw new ApiError(403, {
          error: "forbidden_user",
          ok: false,
          schema: 1,
        });
      }
      return baseApi.loginWithFirebase(idToken);
    });
    firebaseMocks.signInWithGoogle
      .mockResolvedValueOnce({
        account: { displayName: "Alex Johnson", email: "alex@example.com" },
        idToken: "denied-token",
      })
      .mockResolvedValueOnce({
        account: { displayName: "Taylor Smith", email: "taylor@example.com" },
        idToken: "authorized-token",
      });

    render(<App api={api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Google" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use another Google account" }),
    );

    expect(
      await screen.findByRole("button", { name: "notes.md" }),
    ).toBeInTheDocument();
    expect(firebaseMocks.signInWithGoogle).toHaveBeenCalledTimes(2);
  });

  test("shows a restored Firebase account before workspace authorization", async () => {
    firebaseMocks.setInitialAccount({
      displayName: "Taylor Smith",
      email: "taylor@example.com",
    });

    render(
      <App
        api={createFirebaseApi(createMockWorkspaceApi({ scenario: "auth" }))}
      />,
    );

    expect(await screen.findByText("Taylor Smith")).toBeInTheDocument();
    expect(screen.getByText("taylor@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use another Google account" }),
    ).toBeInTheDocument();
  });

  test("does not show an error when the Google popup is cancelled", async () => {
    firebaseMocks.signInWithGoogle.mockRejectedValueOnce(
      new Error("auth/popup-closed-by-user"),
    );
    render(
      <App
        api={createFirebaseApi(createMockWorkspaceApi({ scenario: "auth" }))}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Google" }),
    );

    await waitFor(() => {
      expect(firebaseMocks.signInWithGoogle).toHaveBeenCalledOnce();
      expect(
        screen.queryByText(/Google sign-in could not be completed/),
      ).toBeNull();
    });
  });

  test("keeps the account visible when Google sign-out fails", async () => {
    const api = createFirebaseApi(
      createMockWorkspaceApi({ scenario: "auth" }),
      async () => {
        throw new ApiError(403, {
          error: "forbidden_user",
          ok: false,
          schema: 1,
        });
      },
    );
    firebaseMocks.signInWithGoogle.mockResolvedValueOnce({
      account: { displayName: "Alex Johnson", email: "alex@example.com" },
      idToken: "denied-token",
    });
    firebaseMocks.signOutFirebase.mockRejectedValueOnce(
      new Error("sign_out_failed"),
    );

    render(<App api={api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Google" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign out of Google" }),
    );

    expect(
      await screen.findByText(
        "Google sign-out could not be completed. Try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("alex@example.com")).toBeInTheDocument();
  });

  test("keeps workspace files visible when Git status is unavailable", async () => {
    const baseApi = createMockWorkspaceApi();
    const api: WorkspaceApi = {
      ...baseApi,
      async loadGitStatus() {
        throw new Error("git_unavailable");
      },
    };

    render(<App api={api} />);

    expect(
      await screen.findByRole("button", { name: "notes.md" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Documents" })).toHaveAttribute(
      "title",
      "View recent workspace changes (Version control unavailable)",
    );
  });

  test("automatically loads document from route path on initial load/reload", async () => {
    window.history.replaceState(null, "", "/files/notes.md");
    render(<App api={createMockWorkspaceApi()} />);

    expect(
      await screen.findByRole("article", { name: "Markdown preview" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(document.title).toBe("notes.md - OpenLia Workspace");
  });

  test("restores view and filter query params from URL on reload", async () => {
    window.history.replaceState(
      null,
      "",
      "/files/notes.md?view=edit&filter=calendar",
    );
    render(<App api={createMockWorkspaceApi()} />);

    expect(
      await screen.findByRole("textbox", { name: "Code editor" }),
    ).toBeInTheDocument();
    const filterInput = screen.getByLabelText("Find files");
    expect(filterInput).toHaveValue("calendar");
  });

  test("updates URL when user opens a document, switches views, and filters", async () => {
    window.history.replaceState(null, "", "/");
    render(<App api={createMockWorkspaceApi()} />);

    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));
    await screen.findByRole("article", { name: "Markdown preview" });
    expect(window.location.pathname).toBe("/files/notes.md");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(window.location.search).toContain("view=edit");

    const filterInput = screen.getByLabelText("Find files");
    fireEvent.change(filterInput, { target: { value: "task" } });
    expect(window.location.search).toContain("filter=task");
  });

  test("uses the Markdown default when navigating from YAML", async () => {
    render(<App api={createMockWorkspaceApi()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "workspace.yaml" }),
    );
    expect(
      await screen.findByRole("textbox", { name: "Code editor" }),
    ).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "calendar" }));
    fireEvent.click(await screen.findByRole("button", { name: "event.md" }));
    expect(
      await screen.findByRole("article", { name: "Markdown preview" }),
    ).toBeInTheDocument();
    expect(window.location.search).toBe("?view=preview");
  });

  test("navigates on popstate event (browser history back)", async () => {
    window.history.replaceState(null, "", "/files/notes.md");
    render(<App api={createMockWorkspaceApi()} />);

    await screen.findByRole("article", { name: "Markdown preview" });

    window.history.replaceState(null, "", "/");
    fireEvent(window, new PopStateEvent("popstate"));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Recent Changes" }),
      ).toBeInTheDocument(),
    );
  });

  test("displays error and retry button when route document cannot be opened", async () => {
    window.history.replaceState(null, "", "/files/missing.md");
    render(<App api={createMockWorkspaceApi()} />);

    expect(
      await screen.findByText("This document could not be opened. Try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  test("opens YAML files in the code editor without Markdown view toggles", async () => {
    const path = "knowledge/chatgpt/export.yaml";
    const content = `schema: 1
session:
    platform: chatgpt
  topic: A saved conversation
messages:
  - role: user
    content: What is this?
  - role: assistant
    content: It is a saved conversation.
    `;
    const baseApi = createMockWorkspaceApi();
    const yamlApi: WorkspaceApi = {
      ...baseApi,
      async loadFile(requestedPath) {
        if (requestedPath === path)
          return {
            content,
            editable: true,
            modified_at: "2026-09-24T00:00:00.000Z",
            path,
            revision: "sha256:chat",
            schema: 1,
            size: new TextEncoder().encode(content).byteLength,
          };
        return baseApi.loadFile(requestedPath);
      },
      async loadTree() {
        const response = await baseApi.loadTree();
        return {
          ...response,
          entries: [
            ...response.entries,
            { kind: "directory", path: "knowledge" },
            { kind: "directory", path: "knowledge/chatgpt" },
            {
              editable: true,
              kind: "file",
              modified_at: "2026-09-24T00:00:00.000Z",
              path,
              size: new TextEncoder().encode(content).byteLength,
            },
          ],
        };
      },
    };

    window.history.replaceState(null, "", `/files/${path}?view=preview`);
    render(<App api={yamlApi} />);

    expect(
      await screen.findByRole("textbox", { name: "Code editor" }),
    ).toHaveTextContent("schema: 1");
    expect(screen.getByText("Code")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
  });

  test("opens Go To modal via header button and navigates to document", async () => {
    render(<App api={createMockWorkspaceApi()} />);

    // Click Go To button in header
    const goToButton = await screen.findByRole("button", {
      name: /Go to document or skill/i,
    });
    fireEvent.click(goToButton);

    const input = await screen.findByPlaceholderText(
      "Paste link or path, or type file/skill name...",
    );
    expect(input).toBeInTheDocument();

    // Paste web link
    fireEvent.change(input, {
      target: {
        value: "https://workspace.example.com/files/calendar/event.md",
      },
    });

    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText("calendar/event.md")).toBeInTheDocument();

    // Submit
    fireEvent.keyDown(input, { key: "Enter" });

    // The document should now be open
    expect(
      await screen.findByRole("heading", { name: "Calendar event" }),
    ).toBeInTheDocument();
  });

  test("opens Go To modal via Cmd+P shortcut", async () => {
    render(<App api={createMockWorkspaceApi()} />);

    // Press Cmd+P
    fireEvent.keyDown(window, { key: "p", metaKey: true });

    expect(
      await screen.findByPlaceholderText(
        "Paste link or path, or type file/skill name...",
      ),
    ).toBeInTheDocument();
  });

  test("protects dirty draft when navigating via Go To modal", async () => {
    render(<App api={createMockWorkspaceApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", {
      name: "Code editor",
    });
    setEditorText(editor, "unsaved changes");

    // Open Go To modal and paste link
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    const input = await screen.findByPlaceholderText(
      "Paste link or path, or type file/skill name...",
    );
    fireEvent.change(input, {
      target: { value: "/files/calendar/event.md" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    // Dirty draft dialog should appear
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Keep your draft?",
    );
  });

  test("navigates in-app when clicking link in markdown preview", async () => {
    window.history.replaceState(null, "", "/");
    const baseApi = createMockWorkspaceApi();
    const customApi: WorkspaceApi = {
      ...baseApi,
      async loadFile(requestedPath) {
        if (requestedPath === "notes.md") {
          const original = await baseApi.loadFile(requestedPath);
          return {
            ...original,
            content: "[Check Calendar](/files/calendar/event.md)",
          };
        }
        return baseApi.loadFile(requestedPath);
      },
    };

    render(<App api={customApi} />);
    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));

    // Click the markdown link in preview
    const link = await screen.findByRole("link", { name: "Check Calendar" });
    expect(link).toHaveAttribute("href", "/files/calendar/event.md");
    fireEvent.click(link);

    // Should navigate to calendar/event.md without opening a new tab
    expect(
      await screen.findByRole("heading", { name: "Calendar event" }),
    ).toBeInTheDocument();
  });

  test("allows copying document link to clipboard from document view", async () => {
    window.history.replaceState(null, "", "/");
    let copiedText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copiedText = text;
        },
      },
    });

    render(<App api={createMockWorkspaceApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));

    const expectedUri = buildCanonicalWorkspaceUri("notes.md");
    const copyButton = await screen.findByRole("button", {
      name: `Copy link: ${expectedUri}`,
    });
    expect(copyButton).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Copy link:/ })).toHaveLength(
      1,
    );

    fireEvent.click(copyButton);
    expect(copiedText).toBe(expectedUri);
  });

  test("clicking Reveal in Tree clears filter and focuses the file", async () => {
    window.history.replaceState(null, "", "/");
    render(<App api={createMockWorkspaceApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));

    // Put a filter that excludes notes.md
    const filterInput = screen.getByPlaceholderText("Search paths");
    fireEvent.change(filterInput, { target: { value: "calendar" } });
    expect(filterInput).toHaveValue("calendar");

    // Click Reveal in Tree
    const revealBtn = await screen.findByRole("button", {
      name: "Reveal in tree",
    });
    fireEvent.click(revealBtn);

    // Filter should be cleared
    expect(filterInput).toHaveValue("");
    expect(
      await screen.findByRole("button", { name: "notes.md" }),
    ).toBeInTheDocument();
  });

  test("live updates file content when window regains focus and document is not dirty", async () => {
    window.history.replaceState(null, "", "/");
    let currentContent = "Original notes";
    let currentRevision = "rev-1";

    const baseApi = createMockWorkspaceApi();
    const customApi: WorkspaceApi = {
      ...baseApi,
      async loadFile(requestedPath) {
        if (requestedPath === "notes.md") {
          return {
            content: currentContent,
            editable: true,
            modified_at: new Date().toISOString(),
            path: "notes.md",
            revision: currentRevision,
            schema: 1,
            size: currentContent.length,
          };
        }
        return baseApi.loadFile(requestedPath);
      },
    };

    render(<App api={customApi} />);
    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));

    expect(await screen.findByText("Original notes")).toBeInTheDocument();

    // External agent updates the file on disk
    currentContent = "Updated notes from agent";
    currentRevision = "rev-2";

    // Simulate window focus / tab revalidation
    fireEvent(window, new Event("focus"));

    // Content should update automatically without user refresh
    await waitFor(() => {
      expect(screen.getByText("Updated notes from agent")).toBeInTheDocument();
    });
  });

  test("flags conflict on live update when user has unsaved draft changes", async () => {
    window.history.replaceState(null, "", "/");
    let currentContent = "Original notes";
    let currentRevision = "rev-1";

    const baseApi = createMockWorkspaceApi();
    const customApi: WorkspaceApi = {
      ...baseApi,
      async loadFile(requestedPath) {
        if (requestedPath === "notes.md") {
          return {
            content: currentContent,
            editable: true,
            modified_at: new Date().toISOString(),
            path: "notes.md",
            revision: currentRevision,
            schema: 1,
            size: currentContent.length,
          };
        }
        return baseApi.loadFile(requestedPath);
      },
    };

    render(<App api={customApi} />);
    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", {
      name: "Code editor",
    });
    setEditorText(editor, "My unsaved user edits");

    // External agent updates the file on disk
    currentContent = "Agent edits from background";
    currentRevision = "rev-2";

    // Simulate window focus
    fireEvent(window, new Event("focus"));

    // User draft must NOT be overwritten, and conflict alert should be displayed
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The file changed on disk. Your unsaved draft is preserved; review before saving.",
      );
    });
    expect(editor).toHaveTextContent("My unsaved user edits");
  });

  test("renders the file changes Activity section on initial page and allows opening files", async () => {
    render(<App api={createMockWorkspaceApi()} />);

    expect(
      await screen.findByRole("heading", { name: "Recent Changes" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Recently Modified Documents/)).toBeInTheDocument();
    expect(screen.getByText(/Git History:/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View Git Activity →" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Git Commit History (3)"),
    ).not.toBeInTheDocument();

    // Click on Open for tasks/task.md in the recently modified files list
    const openButtons = screen.getAllByRole("button", { name: "Open" });
    const firstOpenButton = openButtons[0];
    expect(firstOpenButton).toBeDefined();
    if (firstOpenButton) {
      fireEvent.click(firstOpenButton);
    }

    // Document view should be opened
    expect(
      await screen.findByRole("article", { name: "Markdown preview" }),
    ).toBeInTheDocument();

    // Documents returns to the root Recent Changes page.
    expect(screen.getByRole("button", { name: "Documents" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const activityButton = screen.getByRole("button", { name: "Documents" });
    fireEvent.click(activityButton);

    expect(
      await screen.findByRole("heading", { name: "Recent Changes" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("button", { name: "Documents" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      within(screen.getByRole("navigation", { name: "Workspace navigation" }))
        .getAllByRole("button")
        .map((btn) => btn.textContent?.trim()),
    ).toEqual([
      "Chat",
      "Documents",
      "Projects",
      "Ingestion",
      "Skills",
      "Shared Links",
      "Maintainer",
      "MigrationsBeta",
      "Usage",
      "Schedule",
      "Git",
    ]);

    for (const tab of ["Skills", "Configuration"]) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      fireEvent.click(screen.getByRole("button", { name: "Documents" }));
      expect(
        await screen.findByRole("heading", { name: "Recent Changes" }),
      ).toBeInTheDocument();
      expect(window.location.pathname).toBe("/");
    }
  });

  test("navigates to Git Activity tab and displays commit history", async () => {
    render(<App api={createMockWorkspaceApi()} />);

    expect(
      await screen.findByRole("heading", { name: "Recent Changes" }),
    ).toBeInTheDocument();

    // Click the Git Activity tab button in header
    const gitTabButton = screen.getByRole("button", { name: "Git" });
    fireEvent.click(gitTabButton);

    expect(
      await screen.findByRole("heading", { name: "Git History & Activity" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Git Commit History (3)")).toBeInTheDocument();
    expect(
      screen.getByText("chore: update daily notes and task plan"),
    ).toBeInTheDocument();

    // Expand the first commit
    const expandBtn = screen.getByRole("button", { name: "1 file ▾" });
    fireEvent.click(expandBtn);

    // Click View on the file in the commit
    const viewBtn = screen.getByRole("button", { name: "View" });
    fireEvent.click(viewBtn);

    // Should switch to documents tab and open markdown preview
    expect(
      await screen.findByRole("article", { name: "Markdown preview" }),
    ).toBeInTheDocument();
  });

  test("triggers export from Configuration", async () => {
    let exportCalled = false;
    const customApi = createMockWorkspaceApi();
    customApi.downloadWorkspaceExport = async () => {
      exportCalled = true;
    };

    render(<App api={customApi} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Configuration" }),
    );
    const exportBtn = await screen.findByRole("button", {
      name: "Export Workspace",
    });
    expect(exportBtn).toBeInTheDocument();

    fireEvent.click(exportBtn);
    await waitFor(() => {
      expect(exportCalled).toBe(true);
    });
  });

  test("displays error message if export fails", async () => {
    const customApi = createMockWorkspaceApi();
    customApi.downloadWorkspaceExport = async () => {
      throw new Error("Network error during export");
    };

    render(<App api={customApi} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Configuration" }),
    );
    const exportBtn = await screen.findByRole("button", {
      name: "Export Workspace",
    });
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Network error during export",
      );
    });
  });

  test("renames a file via DocumentPane action menu and navigates to new path", async () => {
    const api = createMockWorkspaceApi();
    render(<App api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));
    expect(
      await screen.findByRole("article", { name: "Markdown preview" }),
    ).toBeInTheDocument();

    // Click Document action menu
    fireEvent.click(screen.getByRole("button", { name: "Document actions" }));
    const renameButtons = screen.getAllByRole("button", { name: "Rename..." });
    const renameBtn = renameButtons.at(-1);
    expect(renameBtn).toBeDefined();
    if (renameBtn) fireEvent.click(renameBtn);

    // Rename dialog appears
    const input = screen.getByRole("textbox", { name: /new file name/i });
    fireEvent.change(input, { target: { value: "renamed-notes.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    // Document is updated to renamed file
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "renamed-notes.md" }),
      ).toBeInTheDocument();
    });
  });

  test("moves a file into a folder via DocumentPane action menu", async () => {
    const api = createMockWorkspaceApi();
    render(<App api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));
    expect(
      await screen.findByRole("article", { name: "Markdown preview" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Document actions" }));
    const moveButtons = screen.getAllByRole("button", { name: "Move..." });
    const moveBtn = moveButtons.at(-1);
    expect(moveBtn).toBeDefined();
    if (moveBtn) fireEvent.click(moveBtn);

    fireEvent.click(
      screen.getByRole("button", { name: "Enter new folder path" }),
    );
    const folderInput = screen.getByPlaceholderText(
      "e.g. archive or tasks/done",
    );
    fireEvent.change(folderInput, { target: { value: "archive" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => {
      expect(
        screen.getByText("archive/notes.md", { selector: ".workspace-path" }),
      ).toBeInTheDocument();
    });
  });

  test("displays template & schema diagnostics on the dashboard and warning banner on file", async () => {
    const api = createMockWorkspaceApi();
    api.loadDiagnostics = async () => ({
      issues: [
        {
          errors: ["frontmatter: missing required property 'title'"],
          path: "notes.md",
          schema_path: "notes.schema.json",
        },
      ],
      schema: 1,
      valid: false,
    });
    const origLoadFile = api.loadFile.bind(api);
    api.loadFile = async (p: string) => {
      const f = await origLoadFile(p);
      return {
        ...f,
        validation: {
          errors: ["frontmatter: missing required property 'title'"],
          schema_path: "notes.schema.json",
          valid: false,
        },
      };
    };

    render(<App api={api} />);

    // On dashboard (/), Template & Schema Health should be visible
    expect(
      await screen.findByText("Template & Schema Health"),
    ).toBeInTheDocument();
    expect(screen.getByText("1 issue")).toBeInTheDocument();
    expect(
      screen.getByText("frontmatter: missing required property 'title'"),
    ).toBeInTheDocument();

    // Click "Open & Fix"
    fireEvent.click(screen.getByRole("button", { name: "Open & Fix" }));

    // File opens and warning banner is shown
    expect(
      await screen.findByText("Template & Schema Warning"),
    ).toBeInTheDocument();
    // Permissive editing: Edit button is still available
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
  });

  test("navigates to migrations list and allows returning to list from migration detail", async () => {
    window.history.replaceState(null, "", "/migration/mig-mock-1");
    render(<App api={createMockWorkspaceApi()} />);

    // Renders migration detail
    expect(
      await screen.findByRole("button", { name: /Back to migrations list/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("mig-mock-1")).toBeInTheDocument();

    // Clicking Back breadcrumb returns to migration list
    fireEvent.click(
      screen.getByRole("button", { name: /Back to migrations list/i }),
    );
    expect(
      await screen.findByRole("heading", { name: "Workspace Migrations" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/migration");

    // Click inspect on mig-mock-1
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(
      await screen.findByRole("button", { name: /Back to migrations list/i }),
    ).toBeInTheDocument();

    // Clicking top navigation [Migrations] button also returns to list
    fireEvent.click(screen.getByRole("button", { name: "Migrations" }));
    expect(
      await screen.findByRole("heading", { name: "Workspace Migrations" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/migration");
  });

  test("creates a new domain file via UI, initializes with template, and opens in editor view", async () => {
    window.history.replaceState(null, "", "/");
    render(<App api={createMockWorkspaceApi()} />);

    // Click "+ New File" in the file navigator header
    const newFileBtn = await screen.findByRole("button", {
      name: "+ New File",
    });
    fireEvent.click(newFileBtn);

    // Modal opens
    expect(await screen.findByText("Create New File")).toBeInTheDocument();

    // Select domain "tasks" and enter filename
    const select = screen.getByRole("combobox", { name: "Domain" });
    fireEvent.change(select, { target: { value: "tasks" } });

    const input = screen.getByRole("textbox", { name: "File Name" });
    fireEvent.change(input, { target: { value: "refactor-auth" } });

    expect(screen.getByText("tasks/refactor-auth.md")).toBeInTheDocument();

    // Submit creation
    fireEvent.click(screen.getByRole("button", { name: "Create File" }));

    // Modal closes and file opens in editor view with template content
    const editor = await screen.findByRole("textbox", { name: "Code editor" });
    expect(editor).toHaveTextContent("$schema: ./task-template.schema.json");
    expect(editor).toHaveTextContent("# refactor-auth");

    // File is present in tree
    expect(
      await screen.findByRole("button", { name: "refactor-auth.md" }),
    ).toBeInTheDocument();
  });

  test("shows Template & Schema Warning with Fix in Migrations button and navigates to migration on click", async () => {
    window.history.replaceState(null, "", "/");
    const mockApi = createMockWorkspaceApi();
    mockApi.loadFile = async () => ({
      content: "---\nstatus: invalid\n---\n# Bad Record\n\n## Conteext\n",
      editable: true,
      modified_at: "2026-10-20T00:00:00Z",
      path: "tasks/sample.md",
      revision: "rev-1",
      schema: 1,
      size: 100,
      validation: {
        errors: [
          "heading: missing section '## Context' (found misspelled '## Conteext')",
          "frontmatter: status must be one of allowed values",
        ],
        schema_path: "tasks/task-template.schema.json",
        template_path: "tasks/task-template.md",
        valid: false,
      },
    });

    render(<App api={mockApi} />);

    // Open file
    const fileBtn = await screen.findByRole("button", {
      name: "notes.md",
    });
    fireEvent.click(fileBtn);

    // Warning is visible
    expect(
      await screen.findByText(/Template & Schema Warning/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/missing section '## Context'/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/\[template: tasks\/task-template.md\]/),
    ).toBeInTheDocument();

    // Click "Fix in Migrations"
    const fixBtn = screen.getByRole("button", { name: "Fix in Migrations" });
    fireEvent.click(fixBtn);

    // Navigates to migration view
    expect(await screen.findByText("Revision Summary")).toBeInTheDocument();
    expect(window.location.pathname).toMatch(/^\/migration\/mig-/);
  });

  test("shares a workspace document via Share modal, detects stale snapshot after edit, and manages it in Shared Links tab", async () => {
    window.history.replaceState(null, "", "/");
    const mockApi = createMockWorkspaceApi();
    render(<App api={mockApi} />);

    // Open notes.md
    const fileBtn = await screen.findByRole("button", { name: "notes.md" });
    fireEvent.click(fileBtn);

    // Click Share button in DocumentPane toolbar
    const shareBtn = await screen.findByRole("button", {
      name: "Share document",
    });
    fireEvent.click(shareBtn);

    // Share modal opens
    const dialog = await screen.findByRole("dialog", {
      name: "Share notes.md",
    });
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Create Share Link" }),
    ).toBeInTheDocument();

    // Create a share link
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create Share Link" }),
    );
    expect(await within(dialog).findByText("Up to date")).toBeInTheDocument();

    // Close modal
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close share modal" }),
    );

    // Edit and save notes.md so the snapshot becomes stale
    const currentNotes = await mockApi.loadFile("notes.md");
    await mockApi.saveFile(
      "notes.md",
      "# Updated Notes\n\nNew content after snapshot.\n",
      currentNotes.revision,
    );

    // Navigate to Shared Links tab
    fireEvent.click(screen.getByRole("button", { name: "Shared Links" }));
    expect(window.location.pathname).toBe("/shares");

    // Verify the share appears as Stale in Shared Links section
    const section = await screen.findByRole("region", { name: "Shared Links" });
    const card = await within(section).findByTestId(
      "shared-link-card-mockshare_0000000000000000000001",
    );
    expect(card).toBeInTheDocument();

    // Click Update Snapshot on the stale share
    const updateBtn = within(card).getByRole("button", {
      name: "Update Snapshot",
    });
    fireEvent.click(updateBtn);
    expect(await within(card).findByText("Up to date")).toBeInTheDocument();
  });

  test("renders standalone Public Share View at /share/<share_id> without workspace login or navigation", async () => {
    const mockApi = createMockWorkspaceApi();
    const created = await mockApi.createShare({
      expires_in: "7d",
      kind: "workspace",
      target_path: "notes.md",
    });

    window.history.replaceState(null, "", `/share/${created.share.id}`);
    // Even if session requires auth, public share view renders directly without login
    mockApi.loadSession = async () => ({
      auth_required: true,
      authenticated: false,
      schema: 1,
    });
    render(<App api={mockApi} />);

    // Does NOT render login screen or workspace navigation even though auth is required
    expect(
      await screen.findByText("OPENLIA / SHARED DOCUMENT"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Workspace navigation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Sign in to your workspace" }),
    ).not.toBeInTheDocument();

    // Injects noindex meta tag in head
    const robotsMeta = document.head.querySelector('meta[name="robots"]');
    expect(robotsMeta?.getAttribute("content")).toBe(
      "noindex, nofollow, noarchive",
    );
  });

  test("re-opens the same project record in Documents after navigating back to /projects/*", {
    timeout: 15_000,
  }, async () => {
    window.history.replaceState(null, "", "/projects/tasks");
    const mockApi = createMockWorkspaceApi({
      files: {
        "tasks/ship-ui.md":
          "---\nstatus: todo\npriority: high\n---\n\n# Ship workspace UI\n",
      },
    });
    render(<App api={mockApi} />);

    // Allow for the first lazy-loaded ProjectPage import on slower CI runners.
    const firstRecordButtons = await screen.findAllByText(
      "Ship workspace UI",
      {},
      { timeout: 10_000 },
    );
    expect(firstRecordButtons.length).toBeGreaterThan(0);

    // 1. Click record in Projects -> navigates to /files/tasks/ship-ui.md
    if (firstRecordButtons[0]) {
      fireEvent.click(firstRecordButtons[0]);
    }
    expect(
      await screen.findByRole("article", { name: "Markdown preview" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/files/tasks/ship-ui.md");

    // 2. Simulate browser Back navigation to /projects/tasks
    window.history.replaceState(null, "", "/projects/tasks");
    fireEvent(window, new PopStateEvent("popstate"));

    expect(
      await screen.findByRole("region", { name: "Projects workspace" }),
    ).toBeInTheDocument();
    const recordButtonsAfterBack =
      await screen.findAllByText("Ship workspace UI");
    expect(recordButtonsAfterBack.length).toBeGreaterThan(0);

    // 3. Click the same record again -> navigates back to /files/tasks/ship-ui.md
    if (recordButtonsAfterBack[0]) {
      fireEvent.click(recordButtonsAfterBack[0]);
    }
    expect(
      await screen.findByRole("article", { name: "Markdown preview" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/files/tasks/ship-ui.md");
  });

  test("navigates to Workspace Maintainer view and displays collections and audit controls", async () => {
    window.history.replaceState(null, "", "/");
    const mockApi = createMockWorkspaceApi();
    render(<App api={mockApi} />);

    const maintainerBtn = await screen.findByRole("button", {
      name: "Maintainer",
    });
    fireEvent.click(maintainerBtn);

    expect(window.location.pathname).toBe("/maintainer");
    expect(
      await screen.findByRole("button", { name: "Run Audit" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/All scanned files conform to their active contracts/),
    ).toBeInTheDocument();
  });
});

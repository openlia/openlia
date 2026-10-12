import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, test } from "vitest";
import type { WorkspaceTreeEntry } from "../shared/api";
import {
  CopyLinkButton,
  DeleteFileDialog,
  DocumentInspector,
  DocumentPane,
  FileNavigator,
  MarkdownPreview,
  WorkspaceHeader,
} from "./components";
import { buildCanonicalWorkspaceUri, buildWorkspaceLink } from "./openliaLinks";

describe("workspace presentation components", () => {
  test("renders safe GFM structures semantically", () => {
    const { container } = render(
      <MarkdownPreview
        content={
          "# Notes\n\n- [x] shipped\n\n| Area | State |\n| --- | --- |\n| UI | ready |\n\n<script>alert(1)</script>"
        }
      />,
    );

    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });

  test("renders frontmatter as a structured card in MarkdownPreview", () => {
    render(
      <MarkdownPreview
        content={`---
name: my-skill
description: A helpful skill
tags:
  - web
  - api
---
# Main Content
This is the document body.
`}
      />,
    );

    expect(screen.getByText("my-skill")).toBeInTheDocument();
    expect(screen.getByText("A helpful skill")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Main Content" }),
    ).toBeInTheDocument();
    expect(screen.getByText("This is the document body.")).toBeInTheDocument();
  });

  test("renders a marked original message in a separate source panel", () => {
    const { container } = render(
      <MarkdownPreview
        content={`# Review

## Proposed extraction

Keep this above the source panel.

<!-- ORIGINAL MESSAGE START -->

# Original title

The **original** message.

<!-- ORIGINAL MESSAGE END -->`}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Proposed extraction" }),
    ).toBeInTheDocument();
    const sourcePanel = screen.getByRole("region", {
      name: "Original message",
    });
    expect(sourcePanel).toHaveClass("workspace-original-message");
    expect(
      within(sourcePanel).getByRole("heading", { name: "Original message" }),
    ).toBeInTheDocument();
    expect(
      within(sourcePanel).getByRole("heading", { name: "Original title" }),
    ).toBeInTheDocument();
    expect(within(sourcePanel).getByText("original")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });

  test("renders non-Markdown documents in the code editor", () => {
    let changed = "";
    render(
      <DocumentPane
        conflict=""
        deleting={false}
        diff={[]}
        documentError=""
        draft="enabled: true"
        file={{
          content: "enabled: true",
          editable: true,
          modified_at: "2026-09-22T00:00:00.000Z",
          path: "workspace.yaml",
          revision: "rev1",
          schema: 1,
          size: 13,
        }}
        fileLoading={false}
        onCloseFiles={() => undefined}
        onDelete={() => undefined}
        onDownload={() => undefined}
        onDraftChange={(value) => {
          changed = value;
        }}
        onOpenDetails={() => undefined}
        onRetry={() => undefined}
        onSave={() => undefined}
        onViewChange={() => undefined}
        saving={false}
        view="preview"
      />,
    );

    expect(screen.getByText("Code")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    const editor = screen.getByRole("textbox", { name: "Code editor" });
    expect(editor).toHaveTextContent("enabled: true");
    const view = EditorView.findFromDOM(editor);
    if (!view) throw new Error("CodeMirror view was not found");
    act(() => {
      view.dispatch({
        changes: {
          from: 0,
          insert: "enabled: false",
          to: view.state.doc.length,
        },
      });
    });
    expect(changed).toBe("enabled: false");
  });

  test("sorts folders and files naturally while keeping empty folders visible", () => {
    const entries: WorkspaceTreeEntry[] = [
      { kind: "directory", path: "zeta" },
      { kind: "directory", path: "alpha" },
      {
        editable: true,
        kind: "file",
        modified_at: "2026-09-22T00:00:00.000Z",
        path: "alpha/10.md",
        size: 1,
      },
      {
        editable: true,
        kind: "file",
        modified_at: "2026-09-22T00:00:00.000Z",
        path: "alpha/2.md",
        size: 1,
      },
      {
        editable: true,
        kind: "file",
        modified_at: "2026-09-22T00:00:00.000Z",
        path: "root.md",
        size: 1,
      },
    ];

    render(
      <FileNavigator
        entries={entries}
        filter=""
        loading={false}
        mobileOpen={false}
        onClose={() => undefined}
        onFilterChange={() => undefined}
        onOpenFile={() => undefined}
        onRetry={() => undefined}
        selectedPath={undefined}
        truncated={false}
        workspaceError=""
      />,
    );

    const navigator = screen.getByLabelText("Workspace files");
    const treeButtons = within(navigator)
      .getAllByRole("button")
      .map((button) => button.textContent?.replace(/[▾▸]/, ""));
    expect(treeButtons).toEqual(["Close", "alpha", "root.md"]);
    expect(screen.getByLabelText("zeta, empty folder")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    const alphaFiles = within(navigator)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(alphaFiles).toContain("2.md");
    expect(alphaFiles).toContain("10.md");
    expect(alphaFiles.indexOf("2.md")).toBeLessThan(
      alphaFiles.indexOf("10.md"),
    );
  });

  test("forces matching folders open and disables collapse during search", () => {
    render(
      <FileNavigator
        entries={[
          { kind: "directory", path: "projects" },
          {
            editable: true,
            kind: "file",
            modified_at: "2026-09-22T00:00:00.000Z",
            path: "projects/roadmap.md",
            size: 1,
          },
        ]}
        filter="roadmap"
        loading={false}
        mobileOpen={false}
        onClose={() => undefined}
        onFilterChange={() => undefined}
        onOpenFile={() => undefined}
        onRetry={() => undefined}
        selectedPath={undefined}
        truncated={false}
        workspaceError=""
      />,
    );

    expect(screen.getByRole("button", { name: "projects" })).toBeDisabled();
  });
});

describe("CopyLinkButton and document copy integration", () => {
  test("renders copy button and updates label to Copied! on click", async () => {
    let copiedText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copiedText = text;
        },
      },
    });

    const expectedLink = buildWorkspaceLink("tasks.md");
    render(<CopyLinkButton link={expectedLink} />);
    const button = screen.getByRole("button", {
      name: /copy link/i,
    });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    await waitFor(() => {
      expect(copiedText).toBe(expectedLink);
      expect(screen.getByText("Copied!")).toBeInTheDocument();
    });
  });

  test("WorkspaceHeader renders copy link button when currentLink is provided", async () => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
    });

    const expectedUri = buildCanonicalWorkspaceUri("tasks.md");
    render(
      <WorkspaceHeader
        authRequired={false}
        currentLink={expectedUri}
        file={{
          content: "hello",
          editable: true,
          modified_at: "2026-09-22T00:00:00.000Z",
          path: "tasks.md",
          revision: "rev1",
          schema: 1,
          size: 5,
        }}
        filesButtonRef={{ current: null }}
        git={null}
        onOpenFiles={() => undefined}
        onSignOut={() => undefined}
      />,
    );

    const copyBtn = screen.getByRole("button", {
      name: `Copy link: ${expectedUri}`,
    });
    expect(copyBtn).toBeInTheDocument();
    fireEvent.click(copyBtn);
    expect(copied).toBe(expectedUri);
  });

  test("WorkspaceHeader opens Documents without an export button", () => {
    let opened = false;
    render(
      <WorkspaceHeader
        authRequired={false}
        file={null}
        filesButtonRef={{ current: null }}
        git={null}
        onOpenDocuments={() => {
          opened = true;
        }}
        onOpenFiles={() => undefined}
        onSignOut={() => undefined}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /Export/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(opened).toBe(true);
  });

  test("DocumentPane does not render a duplicate toolbar copy button", () => {
    const expectedLink = buildWorkspaceLink("tasks.md");
    render(
      <DocumentPane
        conflict=""
        diff={[]}
        documentError=""
        draft="hello"
        file={{
          content: "hello",
          editable: true,
          modified_at: "2026-09-22T00:00:00.000Z",
          path: "tasks.md",
          revision: "rev1",
          schema: 1,
          size: 5,
        }}
        fileLoading={false}
        onCloseFiles={() => undefined}
        onDelete={() => undefined}
        onDownload={() => undefined}
        onDraftChange={() => undefined}
        onOpenDetails={() => undefined}
        onRetry={() => undefined}
        onSave={() => undefined}
        deleting={false}
        onViewChange={() => undefined}
        saving={false}
        view="preview"
      />,
    );

    expect(
      screen.queryByRole("button", { name: `Copy link: ${expectedLink}` }),
    ).not.toBeInTheDocument();
  });

  test("DocumentPane renders Reveal in Tree button and fires callback", () => {
    let revealed = false;
    render(
      <DocumentPane
        conflict=""
        diff={[]}
        documentError=""
        draft="hello"
        file={{
          content: "hello",
          editable: true,
          modified_at: "2026-09-22T00:00:00.000Z",
          path: "tasks.md",
          revision: "rev1",
          schema: 1,
          size: 5,
        }}
        fileLoading={false}
        onCloseFiles={() => undefined}
        onDelete={() => undefined}
        onDownload={() => undefined}
        onDraftChange={() => undefined}
        onOpenDetails={() => undefined}
        onRevealInTree={() => {
          revealed = true;
        }}
        onRetry={() => undefined}
        onSave={() => undefined}
        deleting={false}
        onViewChange={() => undefined}
        saving={false}
        view="preview"
      />,
    );

    const revealBtn = screen.getByRole("button", {
      name: "Reveal in tree",
    });
    expect(revealBtn).toBeInTheDocument();
    fireEvent.click(revealBtn);
    expect(revealed).toBe(true);
  });

  test("DocumentPane renders a delete action and fires callback", () => {
    let deleted = false;
    render(
      <DocumentPane
        conflict=""
        deleting={false}
        diff={[]}
        documentError=""
        draft="hello"
        file={{
          content: "hello",
          editable: true,
          modified_at: "2026-09-22T00:00:00.000Z",
          path: "tasks.md",
          revision: "rev1",
          schema: 1,
          size: 5,
        }}
        fileLoading={false}
        onCloseFiles={() => undefined}
        onDelete={() => {
          deleted = true;
        }}
        onDownload={() => undefined}
        onDraftChange={() => undefined}
        onOpenDetails={() => undefined}
        onRetry={() => undefined}
        onSave={() => undefined}
        onViewChange={() => undefined}
        saving={false}
        view="preview"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    expect(deleted).toBe(true);
  });

  test("DeleteFileDialog describes and confirms discarding a dirty draft", () => {
    let confirmed = false;
    render(
      <DeleteFileDialog
        deleting={false}
        dirty
        filePath="tasks.md"
        onCancel={() => undefined}
        onConfirm={() => {
          confirmed = true;
        }}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Deleting it will discard the draft",
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard and delete" }));
    expect(confirmed).toBe(true);
  });

  test("DocumentPane renders Copy URI button and copies canonical openlia:// URI", () => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
    });

    const expectedUri = buildCanonicalWorkspaceUri("tasks.md");
    render(
      <DocumentPane
        conflict=""
        diff={[]}
        documentError=""
        draft="hello"
        file={{
          content: "hello",
          editable: true,
          modified_at: "2026-09-22T00:00:00.000Z",
          path: "tasks.md",
          revision: "rev1",
          schema: 1,
          size: 5,
        }}
        fileLoading={false}
        onCloseFiles={() => undefined}
        onDelete={() => undefined}
        onDownload={() => undefined}
        onDraftChange={() => undefined}
        onOpenDetails={() => undefined}
        onRetry={() => undefined}
        onSave={() => undefined}
        deleting={false}
        onViewChange={() => undefined}
        saving={false}
        view="preview"
      />,
    );

    const copyUriBtn = screen.getByRole("button", {
      name: `Copy URI (${expectedUri})`,
    });
    expect(copyUriBtn).toBeInTheDocument();
    fireEvent.click(copyUriBtn);
    expect(copied).toBe(expectedUri);
  });

  test("DocumentInspector renders Web Link and Document URI with copy buttons", () => {
    const file = {
      content: "hello",
      editable: true,
      modified_at: "2026-09-22T00:00:00.000Z",
      path: "projects/website.md",
      revision: "rev1",
      schema: 1 as const,
      size: 5,
    };
    render(<DocumentInspector diff={[]} draft="hello" file={file} />);

    expect(screen.getByText("Web Link (Share)")).toBeInTheDocument();
    expect(screen.getByText("Document URI (openlia://)")).toBeInTheDocument();
    expect(screen.getByText(buildWorkspaceLink(file.path))).toBeInTheDocument();
    expect(
      screen.getByText(buildCanonicalWorkspaceUri(file.path)),
    ).toBeInTheDocument();
  });

  test("MarkdownPreview navigates on clicking relative markdown links", () => {
    let navigated = "";
    render(
      <MarkdownPreview
        content={"Check [Another Doc](./another.md) and [Parent](../readme.md)"}
        currentFilePath="projects/sub/notes.md"
        onNavigateLink={(href) => {
          navigated = href;
        }}
      />,
    );

    const link = screen.getByText("Another Doc");
    expect(link).toBeInTheDocument();
    fireEvent.click(link);
    expect(navigated).toBe("./another.md");
  });
});

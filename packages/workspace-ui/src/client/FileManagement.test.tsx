import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { MoveFileDialog } from "./MoveFileDialog";
import { RenameFileDialog } from "./RenameFileDialog";
import { FileNavigator } from "./components";

describe("RenameFileDialog", () => {
  test("renders with current filename and handles submit", () => {
    const handleRename = vi.fn();
    const handleCancel = vi.fn();

    render(
      <RenameFileDialog
        filePath="notes.md"
        onCancel={handleCancel}
        onRename={handleRename}
        renaming={false}
      />,
    );

    const input = screen.getByRole("textbox", { name: /new file name/i });
    expect(input).toHaveValue("notes.md");

    fireEvent.change(input, { target: { value: "renamed.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(handleRename).toHaveBeenCalledWith("renamed.md");
  });

  test("validates against paths with slashes, empty names, and template patterns", () => {
    const handleRename = vi.fn();

    render(
      <RenameFileDialog
        filePath="notes.md"
        onCancel={() => {}}
        onRename={handleRename}
        renaming={false}
      />,
    );

    const input = screen.getByRole("textbox", { name: /new file name/i });
    const submitBtn = screen.getByRole("button", { name: "Rename" });

    // Path slash
    fireEvent.change(input, { target: { value: "sub/notes.md" } });
    fireEvent.click(submitBtn);
    expect(
      screen.getByText(/File name cannot contain path separators/),
    ).toBeInTheDocument();

    // Template protection
    fireEvent.change(input, { target: { value: "topic-template.md" } });
    fireEvent.click(submitBtn);
    expect(
      screen.getByText(/Cannot rename to a protected template or schema name/),
    ).toBeInTheDocument();

    // Unsupported extension
    fireEvent.change(input, { target: { value: "script.sh" } });
    fireEvent.click(submitBtn);
    expect(screen.getByText(/is not editable/)).toBeInTheDocument();

    expect(handleRename).not.toHaveBeenCalled();
  });
});

describe("MoveFileDialog", () => {
  test("lists existing directories and shows preview", () => {
    const handleMove = vi.fn();

    render(
      <MoveFileDialog
        directories={["archive", "projects", "notes"]}
        filePath="notes.md"
        moving={false}
        onCancel={() => {}}
        onMove={handleMove}
      />,
    );

    expect(screen.getByText("Destination Preview")).toBeInTheDocument();

    // Select existing folder
    const select = screen.getByRole("combobox", {
      name: "Destination Folder",
    });
    fireEvent.change(select, { target: { value: "archive" } });

    // Preview should update to archive/notes.md
    expect(screen.getByText("archive/notes.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(handleMove).toHaveBeenCalledWith("archive/notes.md");
  });

  test("allows custom new folder and displays schema domain guidance", () => {
    const handleMove = vi.fn();

    render(
      <MoveFileDialog
        directories={["archive"]}
        filePath="my-decision.md"
        moving={false}
        onCancel={() => {}}
        onMove={handleMove}
      />,
    );

    // Toggle to custom folder input
    fireEvent.click(
      screen.getByRole("button", { name: "Enter new folder path" }),
    );

    const customFolderInput = screen.getByPlaceholderText(
      "e.g. archive or tasks/done",
    );
    fireEvent.change(customFolderInput, { target: { value: "decisions" } });

    // Cross-domain schema banner should be displayed for 'decisions'
    expect(
      screen.getByText(/this domain enforces template schemas/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(handleMove).toHaveBeenCalledWith("decisions/my-decision.md");
  });
});

describe("FileNavigator Action Menu", () => {
  test("separates assistant memory above workspace files when present", () => {
    render(
      <FileNavigator
        entries={[
          {
            editable: true,
            kind: "file",
            modified_at: "",
            path: "@memories/USER.md",
            size: 10,
            source: "memory",
          },
          {
            editable: true,
            kind: "file",
            modified_at: "",
            path: "notes.md",
            size: 10,
          },
        ]}
        filter=""
        loading={false}
        mobileOpen={false}
        onClose={() => {}}
        onFilterChange={() => {}}
        onOpenFile={() => {}}
        onRetry={() => {}}
        selectedPath="notes.md"
        truncated={false}
        workspaceError=""
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Assistant memory" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Workspace files" }),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("heading", { name: "Assistant memory" })
        .compareDocumentPosition(
          screen.getByRole("heading", { name: "Workspace files" }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Assistant memory" }).parentElement
        ?.parentElement,
    ).toContainElement(screen.getByText("USER.md"));
  });

  test("does not show section headings for workspace-only files", () => {
    render(
      <FileNavigator
        entries={[
          {
            editable: true,
            kind: "file",
            modified_at: "",
            path: "notes.md",
            size: 10,
          },
        ]}
        filter=""
        loading={false}
        mobileOpen={false}
        onClose={() => {}}
        onFilterChange={() => {}}
        onOpenFile={() => {}}
        onRetry={() => {}}
        selectedPath="notes.md"
        truncated={false}
        workspaceError=""
      />,
    );

    expect(
      screen.queryByRole("heading", { name: "Assistant memory" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Workspace files" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "notes.md" }),
    ).toBeInTheDocument();
  });

  test("exposes rename, move, and delete actions for files", () => {
    const onRenameFile = vi.fn();
    const onMoveFile = vi.fn();
    const onDeleteFile = vi.fn();

    render(
      <FileNavigator
        entries={[
          {
            editable: true,
            kind: "file",
            modified_at: "2026-09-22T00:00:00.000Z",
            path: "sample.md",
            size: 10,
          },
        ]}
        filter=""
        loading={false}
        mobileOpen={false}
        onClose={() => {}}
        onDeleteFile={onDeleteFile}
        onFilterChange={() => {}}
        onMoveFile={onMoveFile}
        onOpenFile={() => {}}
        onRenameFile={onRenameFile}
        onRetry={() => {}}
        selectedPath="sample.md"
        truncated={false}
        workspaceError=""
      />,
    );

    const actionButton = screen.getByRole("button", {
      name: "Actions for sample.md",
    });
    expect(actionButton).toBeInTheDocument();

    const renameBtn = screen.getByRole("button", { name: "Rename..." });
    const moveBtn = screen.getByRole("button", { name: "Move..." });
    const deleteBtn = screen.getByRole("button", { name: "Delete..." });

    fireEvent.click(renameBtn);
    expect(onRenameFile).toHaveBeenCalledWith("sample.md");

    fireEvent.click(moveBtn);
    expect(onMoveFile).toHaveBeenCalledWith("sample.md");

    fireEvent.click(deleteBtn);
    expect(onDeleteFile).toHaveBeenCalledWith("sample.md");
  });

  test("exposes external actions for non-editable files", () => {
    render(
      <FileNavigator
        downloadUrl={(path) => `/download/${path}`}
        entries={[
          {
            editable: false,
            kind: "file",
            modified_at: "2026-09-22T00:00:00.000Z",
            path: "sample.pdf",
            size: 10,
          },
        ]}
        filter=""
        loading={false}
        mobileOpen={false}
        onClose={() => {}}
        onFilterChange={() => {}}
        onOpenFile={() => {}}
        onRetry={() => {}}
        rawUrl={(path) => `/raw/${path}`}
        selectedPath={undefined}
        truncated={false}
        workspaceError=""
      />,
    );

    expect(screen.getByText("View only ↗")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open in New Tab ↗" }),
    ).toHaveAttribute("href", "/raw/sample.pdf");
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/download/sample.pdf",
    );
  });
});

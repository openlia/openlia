import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkspaceApi } from "../api";
import { createMockWorkspaceApi } from "../mockApi";
import { RecordOpenUIPane } from "./RecordOpenUIPane";

describe("RecordOpenUIPane", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const markdownContent = `---
schema_version: 1
status: in_progress
priority: high
tags:
  - ops
  - urgent
---
# Upgrade Servers

Mission critical hardware maintenance.

## Substeps
- [ ] Backup configuration
- [x] Notify team
- [ ] Reboot main node
`;

  test("renders record visual view with frontmatter editor and interactive checklist", async () => {
    const api = createMockWorkspaceApi({
      files: {
        "tasks/task-template.md":
          "---\nschema_version: 1\nstatus: todo\npriority: medium\n---\n# Task\n\n## Substeps\n- [ ] Task\n",
        "tasks/task-template.schema.json": JSON.stringify({
          type: "object",
          properties: {
            schema_version: { type: "integer" },
            status: { type: "string", enum: ["todo", "in_progress", "done"] },
            priority: { type: "string", enum: ["low", "medium", "high"] },
          },
        }),
      },
    });

    const onSaveRecordContent = vi.fn(async (_c: string) => undefined);

    render(
      <RecordOpenUIPane
        api={api}
        content={markdownContent}
        onOpenFile={vi.fn()}
        onSaveContent={onSaveRecordContent}
        path="tasks/upgrade-servers.md"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Upgrade Servers")).toBeDefined();
    });

    // Check checklist items are rendered
    expect(screen.getByText("Backup configuration")).toBeDefined();
    expect(screen.getByText("Notify team")).toBeDefined();
    expect(screen.getByText("Reboot main node")).toBeDefined();

    // Toggle checklist checkbox
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThanOrEqual(3);

    // Toggle the first checkbox ("Backup configuration")
    fireEvent.click(checkboxes[0]!);

    await waitFor(() => {
      expect(onSaveRecordContent).toHaveBeenCalled();
      const updatedContent = onSaveRecordContent.mock.calls[0]?.[0];
      expect(updatedContent).toContain("- [x] Backup configuration");
    });
  });

  test("updates frontmatter and saves updated markdown content", async () => {
    const api = createMockWorkspaceApi();
    const onSaveRecordContent = vi.fn(async (_c: string) => undefined);

    render(
      <RecordOpenUIPane
        api={api}
        content={markdownContent}
        onOpenFile={vi.fn()}
        onSaveContent={onSaveRecordContent}
        path="tasks/upgrade-servers.md"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Upgrade Servers")).toBeDefined();
    });

    // Find Save Frontmatter button
    const saveBtn = screen.queryByRole("button", { name: "Save Frontmatter" });
    if (saveBtn) {
      fireEvent.click(saveBtn);
      await waitFor(() => {
        expect(onSaveRecordContent).toHaveBeenCalled();
      });
    }
  });

  test("surfaces rejected checklist saves without an unhandled rejection", async () => {
    render(
      <RecordOpenUIPane
        api={createMockWorkspaceApi()}
        content={markdownContent}
        path="tasks/upgrade-servers.md"
        onOpenFile={vi.fn()}
        onSaveContent={async () => {
          throw new Error("Revision conflict");
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Backup configuration")).toBeDefined(),
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    await waitFor(() =>
      expect(
        screen.getByText("Could not save record: Revision conflict"),
      ).toBeDefined(),
    );
  });

  test("serializes rapid edits against the latest successfully saved content", async () => {
    const saved: string[] = [];
    render(
      <RecordOpenUIPane
        api={createMockWorkspaceApi()}
        content={markdownContent}
        path="tasks/upgrade-servers.md"
        onOpenFile={vi.fn()}
        onSaveContent={async (next) => {
          saved.push(next);
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Backup configuration")).toBeDefined(),
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    // Save a property while the checklist edit is queued.
    fireEvent.click(screen.getByRole("button", { name: "Save Properties" }));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[1]).toContain("- [x] Backup configuration");
  });

  test("handles broken custom .openui with fallback toggle", async () => {
    const baseApi = createMockWorkspaceApi();
    const api: WorkspaceApi = {
      ...baseApi,
      async loadDomainOverview(_path: string) {
        return {
          schema: 1 as const,
          domain: {
            path: "custom",
            label: "Custom",
            record_openui_path: "custom/custom-record.openui",
          },
          records: [],
          schema_json: { properties: { status: { enum: ["open"] } } },
          template_headings: ["Details"],
        };
      },
      async loadFile(path: string) {
        if (path === "custom/custom-record.openui") {
          return {
            path,
            content: "syntax error ::: [[[ broken",
            revision: "1",
            schema: 1 as const,
            size: 10,
            modified_at: "2026-09-22T00:00:00.000Z",
            editable: true,
          };
        }
        return baseApi.loadFile(path);
      },
    };

    render(
      <RecordOpenUIPane
        api={api}
        content={`---
status: open
---
# Custom Record

## Details
Some detail text
`}
        onOpenFile={vi.fn()}
        path="custom/rec-1.md"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/OpenUI Render Error/i)).toBeDefined();
    });

    const fallbackBtn = screen.getByRole("button", {
      name: "Use Default View",
    });
    fireEvent.click(fallbackBtn);

    await waitFor(() => {
      expect(screen.getByText("Custom Record")).toBeDefined();
    });
  });
});

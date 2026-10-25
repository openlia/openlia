import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkspaceApi } from "../api";
import { createMockWorkspaceApi } from "../mockApi";
import { DomainDashboardPane } from "./DomainDashboardPane";

describe("DomainDashboardPane", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("loads and renders domain dashboard overview and metrics", async () => {
    const api = createMockWorkspaceApi({
      files: {
        "tasks/task-template.md":
          "---\nschema_version: 1\nstatus: todo\npriority: medium\n---\n# Task Template\n\n## Subtasks\n- [ ] Task 1\n",
        "tasks/task-template.schema.json": JSON.stringify({
          type: "object",
          properties: {
            schema_version: { type: "integer" },
            status: { type: "string", enum: ["todo", "in_progress", "done"] },
            priority: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["schema_version", "status", "priority"],
        }),
        "tasks/buy-groceries.md":
          "---\nschema_version: 1\nstatus: todo\npriority: high\n---\n# Buy Groceries\n\n## Subtasks\n- [ ] Milk\n",
        "tasks/read-book.md":
          "---\nschema_version: 1\nstatus: done\npriority: low\n---\n# Read Book\n\n## Subtasks\n- [x] Chapter 1\n",
      },
    });

    const onOpenRecord = vi.fn();
    const onNavigate = vi.fn();

    render(
      <DomainDashboardPane
        api={api}
        domainPath="tasks"
        onNavigate={onNavigate}
        onOpenFile={onOpenRecord}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Tasks")).toBeDefined();
    });

    // Check records rendered
    const groceriesItems = screen.getAllByText("Buy Groceries");
    expect(groceriesItems.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Read Book").length).toBeGreaterThanOrEqual(1);

    // Click to open record
    fireEvent.click(groceriesItems[0]!);
    expect(onOpenRecord).toHaveBeenCalledWith("tasks/buy-groceries.md");
  });

  test("displays contract drift banner and triggers fixDomainTemplateIssues", async () => {
    const baseApi = createMockWorkspaceApi();
    const fixSpy = vi.fn(async () => ({
      schema: 1 as const,
      ok: true as const,
      migration_id: "mig-tasks-fix-123",
      fixed_count: 2,
    }));

    const api: WorkspaceApi = {
      ...baseApi,
      async loadDomainOverview(_path: string) {
        return {
          schema: 1 as const,
          domain: {
            path: "tasks",
            label: "Tasks",
            description: "Actionable items and todos",
            record_count: 3,
            invalid_record_count: 2,
          },
          records: [
            {
              path: "tasks/task-1.md",
              filename: "task-1.md",
              title: "Task 1",
              modified_at: "2026-09-22T00:00:00.000Z",
              size: 10,
              revision: "1",
              frontmatter: {},
              sections: [],
              excerpt: "",
              validation: { valid: false, errors: ["Missing priority"] },
            },
            {
              path: "tasks/task-2.md",
              filename: "task-2.md",
              title: "Task 2",
              modified_at: "2026-09-22T00:00:00.000Z",
              size: 10,
              revision: "1",
              frontmatter: {},
              sections: [],
              excerpt: "",
              validation: { valid: false, errors: ["Invalid status"] },
            },
            {
              path: "tasks/task-3.md",
              filename: "task-3.md",
              title: "Task 3",
              modified_at: "2026-09-22T00:00:00.000Z",
              size: 10,
              revision: "1",
              frontmatter: {},
              sections: [],
              excerpt: "",
              validation: { valid: true, errors: [] },
            },
          ],
          schema_json: {
            properties: {
              status: { enum: ["todo", "done"] },
              priority: { enum: ["low", "high"] },
            },
          },
          template_headings: ["Subtasks"],
        };
      },
      fixDomainTemplateIssues: fixSpy,
    };

    const onNavigate = vi.fn();

    render(
      <DomainDashboardPane
        api={api}
        domainPath="tasks"
        onNavigate={onNavigate}
        onOpenFile={vi.fn()}
      />,
    );

    // Verify contract drift banner is visible
    await waitFor(() => {
      expect(
        screen.getByText(/do not match the updated template or schema/i),
      ).toBeDefined();
    });

    const fixBtn = screen.getByRole("button", {
      name: /Fix All 2 in Migrations/i,
    });
    fireEvent.click(fixBtn);

    await waitFor(() => {
      expect(fixSpy).toHaveBeenCalledWith("tasks");
      expect(onNavigate).toHaveBeenCalledWith("/migration/mig-tasks-fix-123");
    });
  });

  test("handles custom .openui file error gracefully with fallback toggle", async () => {
    const baseApi = createMockWorkspaceApi();
    const api: WorkspaceApi = {
      ...baseApi,
      async loadDomainOverview(_path: string) {
        return {
          schema: 1 as const,
          domain: {
            path: "custom_domain",
            label: "Custom Domain",
            dashboard_openui_path: "custom_domain/custom-dashboard.openui",
            record_count: 1,
            invalid_record_count: 0,
          },
          records: [
            {
              path: "custom_domain/item-1.md",
              filename: "item-1.md",
              title: "Item 1",
              modified_at: "2026-09-22T00:00:00.000Z",
              size: 10,
              revision: "1",
              frontmatter: {},
              sections: [],
              excerpt: "",
              validation: { valid: true, errors: [] },
            },
          ],
          schema_json: { properties: { status: { enum: ["active"] } } },
          template_headings: ["Notes"],
        };
      },
      async loadFile(path: string) {
        if (path === "custom_domain/custom-dashboard.openui") {
          return {
            path,
            content: "invalid openui syntax ::: ((( not valid",
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
      <DomainDashboardPane
        api={api}
        domainPath="custom_domain"
        onOpenFile={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/OpenUI Render Error/i)).toBeDefined();
    });

    // Clicking "Use Default View" recovers and renders synthesized dashboard
    const fallbackBtn = screen.getByRole("button", {
      name: "Use Default View",
    });
    fireEvent.click(fallbackBtn);

    await waitFor(() => {
      expect(screen.getByText("Custom Domain")).toBeDefined();
      expect(screen.getAllByText("Item 1").length).toBeGreaterThanOrEqual(1);
    });
  });
});

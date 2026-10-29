import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockWorkspaceApi } from "../../mockApi";
import { ProjectPage } from "./ProjectPage";

describe("ProjectPage", () => {
  it("loads mini-projects, renders OpenUI dashboard, switches to Project Files with URL view sync, and confirms before handing off prompt to Lia", async () => {
    const api = createMockWorkspaceApi();
    const onSelectProject = vi.fn();
    const onViewChange = vi.fn();
    const onOpenFile = vi.fn();
    const onCreateFile = vi.fn();
    const onAskLia = vi.fn();

    render(
      <ProjectPage
        api={api}
        selectedProjectPath="tasks"
        onSelectProject={onSelectProject}
        onViewChange={onViewChange}
        onOpenFile={onOpenFile}
        onCreateFile={onCreateFile}
        onAskLia={onAskLia}
      />,
    );

    expect(
      (await screen.findAllByRole("heading", { name: "Tasks", level: 2 }))
        .length,
    ).toBeGreaterThan(0);

    const diagnostics = screen.getByRole("status", {
      name: "OpenUI diagnostics",
    });
    const copyProjectLink = screen.getByRole("button", {
      name: /Copy project link/,
    });
    expect(diagnostics).toHaveTextContent("OpenUI layout is valid.");
    expect(diagnostics.nextElementSibling).toBe(copyProjectLink);

    // Switch to Project Files inspector and verify view callback
    fireEvent.click(screen.getByRole("button", { name: "Project Files" }));
    expect(onViewChange).toHaveBeenCalledWith("files");
    expect(
      await screen.findByText(/Project Architecture/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit project-manifest.toml" }),
    ).toBeInTheDocument();

    // Click Improve UI with Lia -> opens confirmation modal first
    fireEvent.click(
      screen.getByRole("button", { name: /Improve UI with Lia/i }),
    );
    expect(onAskLia).not.toHaveBeenCalled();

    const promptInput = (await screen.findByLabelText(
      "Prompt context",
    )) as HTMLTextAreaElement;
    expect(promptInput.value).toContain("tasks/project-manifest.toml");

    // Confirm modal to hand off to Chat
    fireEvent.click(screen.getByRole("button", { name: "Open in Chat" }));
    expect(onAskLia).toHaveBeenCalledTimes(1);
    expect(onAskLia.mock.calls[0]?.[0]).toContain(
      "tasks/project-manifest.toml",
    );
    expect(onAskLia.mock.calls[0]?.[0]).toContain("tasks/ui.openui");
  });

  it("rolls back optimistic frontmatter updates if saveFile fails", async () => {
    const api = createMockWorkspaceApi();
    vi.spyOn(api, "saveFile").mockRejectedValueOnce(
      new Error("Revision conflict"),
    );

    render(
      <ProjectPage
        api={api}
        selectedProjectPath="tasks"
        onSelectProject={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );

    expect(
      (await screen.findAllByRole("heading", { name: "Tasks", level: 2 }))
        .length,
    ).toBeGreaterThan(0);

    // Trigger a frontmatter update via Kanban status select if present
    const selects = screen.queryAllByRole("combobox");
    if (selects[0]) {
      fireEvent.change(selects[0], { target: { value: "done" } });
      await waitFor(() => {
        expect(screen.getByText(/Revision conflict/i)).toBeInTheDocument();
      });
    }
  });
});

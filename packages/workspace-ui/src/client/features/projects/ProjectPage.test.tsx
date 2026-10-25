import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockWorkspaceApi } from "../../mockApi";
import { ProjectPage } from "./ProjectPage";

describe("ProjectPage", () => {
  it("loads mini-projects, renders OpenUI dashboard, switches to Project Files, and hands off Improve UI prompt to Lia", async () => {
    const api = createMockWorkspaceApi();
    const onSelectProject = vi.fn();
    const onOpenFile = vi.fn();
    const onCreateFile = vi.fn();
    const onAskLia = vi.fn();

    render(
      <ProjectPage
        api={api}
        selectedProjectPath="tasks"
        onSelectProject={onSelectProject}
        onOpenFile={onOpenFile}
        onCreateFile={onCreateFile}
        onAskLia={onAskLia}
      />,
    );

    expect(
      (await screen.findAllByRole("heading", { name: "Tasks", level: 2 }))
        .length,
    ).toBeGreaterThan(0);

    // Switch to Project Files inspector
    fireEvent.click(screen.getByRole("button", { name: "Project Files" }));
    expect(
      await screen.findByText(/Project Architecture/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit project-manifest.toml" }),
    ).toBeInTheDocument();

    // Click Improve UI with Lia
    fireEvent.click(
      screen.getByRole("button", { name: /Improve UI with Lia/i }),
    );
    expect(onAskLia).toHaveBeenCalledTimes(1);
    expect(onAskLia.mock.calls[0]?.[0]).toContain(
      "tasks/project-manifest.toml",
    );
    expect(onAskLia.mock.calls[0]?.[0]).toContain("tasks/ui.openui");
  });
});

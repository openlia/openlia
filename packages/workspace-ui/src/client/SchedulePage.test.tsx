import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SchedulePage } from "./SchedulePage";
import { createMockWorkspaceApi } from "./mockApi";

describe("SchedulePage", () => {
  it("renders scheduled tasks and system schedules", async () => {
    const api = createMockWorkspaceApi();
    render(<SchedulePage api={api} />);

    // Check title
    expect(
      await screen.findByText("Scheduled Tasks & Automation"),
    ).toBeInTheDocument();

    // Check system schedules
    expect(screen.getByText("Encrypted Backup Scheduler")).toBeInTheDocument();
    expect(screen.getByText("20 4 * * *")).toBeInTheDocument();
    expect(
      screen.getByText("Workspace Checkpoint Reminder"),
    ).toBeInTheDocument();

    // Check policy banner
    expect(
      screen.getByText(/Assistant Scheduled Policy is Enabled/),
    ).toBeInTheDocument();

    // Check mock tasks
    expect(screen.getAllByText("openlia-workspace-git").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("Morning Briefing")).toBeInTheDocument();
    expect(screen.getByText("0 9 * * *")).toBeInTheDocument();
  });

  it("navigates to policy document when clicking view policy", async () => {
    const api = createMockWorkspaceApi();
    const onOpenDocument = vi.fn();
    render(<SchedulePage api={api} onOpenDocument={onOpenDocument} />);

    const policyButton = await screen.findByRole("button", {
      name: "View Policy",
    });
    fireEvent.click(policyButton);
    expect(onOpenDocument).toHaveBeenCalledWith("assistant-policy.yaml");
  });

  it("toggles task between scheduled and paused", async () => {
    const api = createMockWorkspaceApi();
    const toggleSpy = vi.spyOn(api, "toggleCronJob");
    render(<SchedulePage api={api} />);

    // Initially, Morning Briefing is paused, so its button is "Resume"
    const resumeButtons = await screen.findAllByRole("button", {
      name: "Resume",
    });
    expect(resumeButtons.length).toBeGreaterThan(0);

    const firstResume = resumeButtons[0];
    expect(firstResume).toBeDefined();
    if (firstResume) {
      fireEvent.click(firstResume);
    }
    await waitFor(() => {
      expect(toggleSpy).toHaveBeenCalled();
    });
  });

  it("opens schedule with agent guide modal and copies prompt template", async () => {
    const api = createMockWorkspaceApi();
    render(<SchedulePage api={api} />);

    const agentButton = await screen.findByRole("button", {
      name: /Schedule with Agent/i,
    });
    fireEvent.click(agentButton);

    expect(
      screen.getByText("Schedule a Task with Your Agent"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /In OpenLia, scheduled tasks are composed and managed through conversation/,
      ),
    ).toBeInTheDocument();

    // Check prompt templates
    expect(screen.getByText("Daily Morning Briefing")).toBeInTheDocument();
    expect(screen.getByText("Inbox & Document Triage")).toBeInTheDocument();

    // Click Got It to close
    const gotItBtn = screen.getByRole("button", { name: "Got It" });
    fireEvent.click(gotItBtn);
    expect(
      screen.queryByText("Schedule a Task with Your Agent"),
    ).not.toBeInTheDocument();
  });

  it("opens task details & prompt inspector modal", async () => {
    const api = createMockWorkspaceApi();
    render(<SchedulePage api={api} />);

    const inspectButtons = await screen.findAllByRole("button", {
      name: "Inspect",
    });
    const firstInspect = inspectButtons[0];
    expect(firstInspect).toBeDefined();
    if (firstInspect) {
      fireEvent.click(firstInspect);
    }

    expect(screen.getByText("Task Details & Agent Prompt")).toBeInTheDocument();
    expect(
      screen.getByText("Need to edit or revise this task?"),
    ).toBeInTheDocument();

    const closeBtn = screen.getByRole("button", { name: "Close" });
    fireEvent.click(closeBtn);
    expect(
      screen.queryByText("Task Details & Agent Prompt"),
    ).not.toBeInTheDocument();
  });

  it("opens delete confirmation modal and deletes job", async () => {
    const api = createMockWorkspaceApi();
    const deleteSpy = vi.spyOn(api, "deleteCronJob");
    render(<SchedulePage api={api} />);

    const deleteBtn = await screen.findByRole("button", { name: "Delete" });
    fireEvent.click(deleteBtn);

    expect(screen.getByText("Delete Scheduled Task?")).toBeInTheDocument();

    const confirmBtn = screen.getByRole("button", { name: "Delete Task" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalled();
    });
  });
});

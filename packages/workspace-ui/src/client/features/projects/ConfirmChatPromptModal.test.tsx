import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmChatPromptModal } from "./ConfirmChatPromptModal";

describe("ConfirmChatPromptModal", () => {
  it("displays notice, allows editing the prompt, and confirms or cancels", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <ConfirmChatPromptModal
        initialPrompt="Review my tasks in tasks/"
        onCancel={onCancel}
        onConfirm={onConfirm}
        projectName="Tasks"
        title="Triage overdue tasks"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Triage overdue tasks" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(
      screen.getByText(/This action will switch to the/i),
    ).toBeInTheDocument();

    const textarea = screen.getByLabelText("Prompt context");
    expect(textarea).toHaveValue("Review my tasks in tasks/");

    // Edit prompt before confirming
    fireEvent.change(textarea, {
      target: { value: "Review my high-priority tasks in tasks/ today" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Open in Chat" }));
    expect(onConfirm).toHaveBeenCalledWith(
      "Review my high-priority tasks in tasks/ today",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

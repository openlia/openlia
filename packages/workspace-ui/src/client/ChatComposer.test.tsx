import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyComposerEnter,
  applyComposerTab,
  ChatComposer,
} from "./ChatComposer";

afterEach(cleanup);
function props() {
  return {
    draft: "Hello",
    model: "",
    models: [],
    run: null,
    active: false,
    busy: false,
    disabled: false,
    canSteer: true,
    canStop: true,
    onDraft: vi.fn(),
    onModel: vi.fn(),
    onSend: vi.fn(),
    onSteer: vi.fn(),
    onStop: vi.fn(),
  };
}
describe("compact chat composer", () => {
  it("allows Enter and Shift+Enter without sending and sends with Ctrl/Cmd+Enter or the button", () => {
    const input = props();
    render(<ChatComposer {...input} />);
    const field = screen.getByRole("textbox", { name: "Message Lia" });
    expect(fireEvent.keyDown(field, { key: "Enter", shiftKey: true })).toBe(
      true,
    );
    expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(true);
    expect(input.onSend).not.toHaveBeenCalled();

    expect(fireEvent.keyDown(field, { key: "Enter", ctrlKey: true })).toBe(
      false,
    );
    expect(input.onSend).toHaveBeenCalledTimes(1);

    expect(fireEvent.keyDown(field, { key: "Enter", metaKey: true })).toBe(
      false,
    );
    expect(input.onSend).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(input.onSend).toHaveBeenCalledTimes(3);
  });
  it("preserves multiline drafts and explains how to submit", () => {
    const input = props();
    render(<ChatComposer {...input} />);
    const field = screen.getByRole("textbox", { name: "Message Lia" });
    fireEvent.change(field, { target: { value: "Hello\nLia" } });
    expect(input.onDraft).toHaveBeenCalledWith("Hello\nLia");
    expect(input.onSend).not.toHaveBeenCalled();
    expect(
      screen.getByText("Enter for a new line · Ctrl/⌘ + Enter to submit"),
    ).toBeVisible();
  });
  it("does not send during IME composition, loading, or an active run, and steers with Ctrl/Cmd+Enter when active", () => {
    const input = props();
    const view = render(<ChatComposer {...input} />);
    const field = screen.getByRole("textbox", { name: "Message Lia" });
    fireEvent.keyDown(field, {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    });
    view.rerender(<ChatComposer {...input} disabled />);
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    view.rerender(
      <ChatComposer
        {...input}
        active
        run={{ run_id: "run", status: "running" }}
      />,
    );
    fireEvent.keyDown(field, { key: "Enter" });
    expect(input.onSend).not.toHaveBeenCalled();
    expect(input.onSteer).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(input.onSteer).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Send guidance" }));
    expect(input.onSteer).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(input.onStop).toHaveBeenCalledOnce();
  });
  it("starts at one row, resets its height when the draft is cleared, and supports expanding", () => {
    const input = props();
    const view = render(<ChatComposer {...input} />);
    const field = screen.getByRole("textbox", { name: "Message Lia" });
    expect(field).toHaveAttribute("rows", "1");
    view.rerender(<ChatComposer {...input} draft="" />);
    expect(field.style.height).toBe("24px");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    const expandButton = screen.getByRole("button", { name: "Expand editor" });
    fireEvent.click(expandButton);
    expect(
      screen.getByRole("button", { name: "Collapse editor" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(
      screen.getByRole("button", { name: "Expand editor" }),
    ).toHaveAttribute("aria-pressed", "false");
  });
  it("continues and exits Markdown lists and blockquotes on Enter", () => {
    expect(applyComposerEnter("- first item", 12, 12)).toEqual({
      value: "- first item\n- ",
      selectionStart: 15,
      selectionEnd: 15,
    });
    expect(applyComposerEnter("- first item\n- ", 15, 15)).toEqual({
      value: "- first item\n",
      selectionStart: 13,
      selectionEnd: 13,
    });
    expect(applyComposerEnter("1. step one", 11, 11)).toEqual({
      value: "1. step one\n2. ",
      selectionStart: 15,
      selectionEnd: 15,
    });
    expect(applyComposerEnter("- [x] done task", 15, 15)).toEqual({
      value: "- [x] done task\n- [ ] ",
      selectionStart: 22,
      selectionEnd: 22,
    });
    expect(applyComposerEnter("> quoted note", 13, 13)).toEqual({
      value: "> quoted note\n> ",
      selectionStart: 16,
      selectionEnd: 16,
    });
    expect(applyComposerEnter("> quoted note\n> ", 16, 16)).toEqual({
      value: "> quoted note\n",
      selectionStart: 14,
      selectionEnd: 14,
    });
  });
  it("indents and outdents lines with Tab and Shift+Tab", () => {
    expect(applyComposerTab("- list item", 11, 11, false)).toEqual({
      value: "  - list item",
      selectionStart: 13,
      selectionEnd: 13,
    });
    expect(applyComposerTab("  - list item", 13, 13, true)).toEqual({
      value: "- list item",
      selectionStart: 11,
      selectionEnd: 11,
    });
    expect(applyComposerTab("line 1\nline 2", 0, 13, false)).toEqual({
      value: "  line 1\n  line 2",
      selectionStart: 2,
      selectionEnd: 17,
    });
    expect(applyComposerTab("  line 1\n  line 2", 2, 17, true)).toEqual({
      value: "line 1\nline 2",
      selectionStart: 0,
      selectionEnd: 13,
    });
  });
});

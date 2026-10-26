import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";

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
  it("allows Enter and Shift+Enter without sending and sends with the button", () => {
    const input = props();
    render(<ChatComposer {...input} />);
    const field = screen.getByRole("textbox", { name: "Message Lia" });
    expect(fireEvent.keyDown(field, { key: "Enter", shiftKey: true })).toBe(
      true,
    );
    expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(true);
    expect(input.onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(input.onSend).toHaveBeenCalledOnce();
  });
  it("preserves multiline drafts and explains how to submit", () => {
    const input = props();
    render(<ChatComposer {...input} />);
    const field = screen.getByRole("textbox", { name: "Message Lia" });
    fireEvent.change(field, { target: { value: "Hello\nLia" } });
    expect(input.onDraft).toHaveBeenCalledWith("Hello\nLia");
    expect(input.onSend).not.toHaveBeenCalled();
    expect(
      screen.getByText("Enter for a new line · Click Send to submit"),
    ).toBeVisible();
  });
  it("does not send during IME composition, loading, or an active run", () => {
    const input = props();
    const view = render(<ChatComposer {...input} />);
    const field = screen.getByRole("textbox", { name: "Message Lia" });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    view.rerender(<ChatComposer {...input} disabled />);
    fireEvent.keyDown(field, { key: "Enter" });
    view.rerender(
      <ChatComposer
        {...input}
        active
        run={{ run_id: "run", status: "running" }}
      />,
    );
    fireEvent.keyDown(field, { key: "Enter" });
    expect(input.onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send guidance" }));
    expect(input.onSteer).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(input.onStop).toHaveBeenCalledOnce();
  });
  it("starts at one row and resets its height when the draft is cleared", () => {
    const input = props();
    const view = render(<ChatComposer {...input} />);
    const field = screen.getByRole("textbox", { name: "Message Lia" });
    expect(field).toHaveAttribute("rows", "1");
    view.rerender(<ChatComposer {...input} draft="" />);
    expect(field.style.height).toBe("24px");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});

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
  it("sends on Enter but preserves Shift+Enter for multiline messages", () => {
    const input = props();
    render(<ChatComposer {...input} />);
    const field = screen.getByRole("textbox", { name: "Message Lia" });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(input.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(input.onSend).toHaveBeenCalledOnce();
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

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useViewportHeight } from "./useViewportHeight";

afterEach(() => vi.unstubAllGlobals());

test("tracks keyboard viewport height, reveals focused inputs, and cleans up", () => {
  const viewport = Object.assign(new EventTarget(), { height: 640 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const remove = vi.spyOn(viewport, "removeEventListener");
  function Harness() {
    const ref = useViewportHeight();
    return (
      <div ref={ref} data-testid="viewport">
        <input aria-label="Search" />
      </div>
    );
  }
  const { unmount } = render(<Harness />);
  const root = screen.getByTestId("viewport");
  const input = screen.getByRole("textbox", { name: "Search" });
  const reveal = vi.fn();
  input.scrollIntoView = reveal;
  expect(root.style.getPropertyValue("--workspace-viewport-height")).toBe(
    "640px",
  );
  input.focus();
  act(() => {
    viewport.height = 340;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(root.style.getPropertyValue("--workspace-viewport-height")).toBe(
    "340px",
  );
  expect(reveal).toHaveBeenCalledWith({ block: "nearest" });
  unmount();
  expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
  expect(root.style.getPropertyValue("--workspace-viewport-height")).toBe("");
});

test("attaches after the initial loading screen is replaced by the workspace", () => {
  vi.stubGlobal(
    "visualViewport",
    Object.assign(new EventTarget(), { height: 360 }),
  );
  function Harness() {
    const ref = useViewportHeight();
    const [ready, setReady] = useState(false);
    return ready ? (
      <main ref={ref} data-testid="loaded" />
    ) : (
      <button type="button" onClick={() => setReady(true)}>
        Load workspace
      </button>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Load workspace" }));
  expect(
    screen
      .getByTestId("loaded")
      .style.getPropertyValue("--workspace-viewport-height"),
  ).toBe("360px");
});

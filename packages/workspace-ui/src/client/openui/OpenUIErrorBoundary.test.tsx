import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OpenUIErrorBoundary } from "./OpenUIErrorBoundary";

function ThrowingWidget({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("Invalid OpenUI AST node: UnknownTable");
  }
  return <div>Rendered OpenUI Dashboard</div>;
}

describe("OpenUIErrorBoundary", () => {
  it("automatically retries a failed block when its source is edited", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { rerender } = render(
        <OpenUIErrorBoundary source="broken">
          <ThrowingWidget shouldThrow />
        </OpenUIErrorBoundary>,
      );
      expect(screen.getByRole("alert")).toBeInTheDocument();
      rerender(
        <OpenUIErrorBoundary source="repaired">
          <ThrowingWidget shouldThrow={false} />
        </OpenUIErrorBoundary>,
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("Rendered OpenUI Dashboard")).toBeInTheDocument();
      rerender(
        <OpenUIErrorBoundary source="broken again">
          <ThrowingWidget shouldThrow />
        </OpenUIErrorBoundary>,
      );
      expect(screen.getByRole("alert")).toBeInTheDocument();
      rerender(
        <OpenUIErrorBoundary source="still broken">
          <ThrowingWidget shouldThrow />
        </OpenUIErrorBoundary>,
      );
      expect(screen.getByRole("alert")).toBeInTheDocument();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("isolates OpenUI render errors, offers edit action, and recovers on retry", () => {
    const onEditUI = vi.fn();
    const onReset = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    function TestHarness() {
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <div>
          <h1>Host Shell</h1>
          <OpenUIErrorBoundary
            onEditUI={onEditUI}
            onReset={() => {
              setShouldThrow(false);
              onReset();
            }}
            uiPath="tasks/overview.md"
            source="CardHeader(title: invalid)"
          >
            <ThrowingWidget shouldThrow={shouldThrow} />
          </OpenUIErrorBoundary>
        </div>
      );
    }

    render(<TestHarness />);

    // Host shell stays intact
    expect(screen.getByText("Host Shell")).toBeInTheDocument();

    // Error boundary displays localized error card
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByText(/Failed to render tasks\/overview\.md/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Invalid OpenUI AST node: UnknownTable/i),
    ).toBeInTheDocument();

    // Edit button works
    fireEvent.click(
      screen.getByRole("button", { name: "Edit tasks/overview.md" }),
    );
    expect(onEditUI).toHaveBeenCalledTimes(1);

    // Retry button resets boundary and renders child
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Rendered OpenUI Dashboard")).toBeInTheDocument();

    consoleSpy.mockRestore();
  });
});

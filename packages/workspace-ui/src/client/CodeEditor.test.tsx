import { EditorView } from "@codemirror/view";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { CodeEditor } from "./CodeEditor";

describe("CodeEditor", () => {
  test("toggles soft wrapping without changing the document or highlighting", () => {
    const value = 'const message = "hello";';
    const onChange = vi.fn();
    render(
      <CodeEditor filePath="example.js" onChange={onChange} value={value} />,
    );

    const editor = screen.getByRole("textbox", { name: "Code editor" });
    const view = EditorView.findFromDOM(editor);
    if (!view) throw new Error("CodeMirror view was not found");

    const highlightedTokens = () =>
      Array.from(editor.querySelectorAll(".cm-line span[class]"), (span) => ({
        className: span.className,
        text: span.textContent,
      }));
    const initialTokens = highlightedTokens();
    expect(initialTokens.length).toBeGreaterThan(0);
    const expectHighlighting = () => {
      expect(highlightedTokens()).toEqual(initialTokens);
    };

    expect(editor).not.toHaveClass("cm-lineWrapping");
    expectHighlighting();
    expect(screen.queryByRole("button", { name: /Syntax/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Wrap Off", pressed: false }),
    );
    expect(
      screen.getByRole("button", { name: "Wrap On", pressed: true }),
    ).toBeInTheDocument();
    expect(editor).toHaveClass("cm-lineWrapping");
    expectHighlighting();

    fireEvent.click(screen.getByRole("button", { name: "Wrap On" }));
    expect(
      screen.getByRole("button", { name: "Wrap Off", pressed: false }),
    ).toBeInTheDocument();
    expect(editor).not.toHaveClass("cm-lineWrapping");
    expectHighlighting();
    expect(view.state.doc.toString()).toBe(value);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("retains wrapping when switching files", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CodeEditor
        filePath="first.js"
        onChange={onChange}
        value="const first = 1;"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Wrap Off" }));

    rerender(
      <CodeEditor
        filePath="second.py"
        onChange={onChange}
        value="second = 2"
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Code editor" });
    expect(editor).toHaveClass("cm-lineWrapping");
    expect(
      screen.getByRole("button", { name: "Wrap On", pressed: true }),
    ).toBeInTheDocument();
  });
});

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import {
  deleteMarkupBackward,
  markdown,
  markdownKeymap,
} from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  oneDarkHighlightStyle,
  oneDarkTheme,
} from "@codemirror/theme-one-dark";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef, useState } from "react";

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  filePath: string;
  readOnly?: boolean;
  minHeight?: string;
  className?: string;
}

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

export function detectLanguage(path: string): { id: string; name: string } {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "py":
      return { id: "python", name: "Python" };
    case "sh":
    case "bash":
    case "zsh":
      return { id: "shell", name: "Shell" };
    case "json":
      return { id: "json", name: "JSON" };
    case "yaml":
    case "yml":
      return { id: "yaml", name: "YAML" };
    case "md":
    case "markdown":
      return { id: "markdown", name: "Markdown" };
    case "ts":
    case "tsx":
      return { id: "typescript", name: "TypeScript" };
    case "js":
    case "jsx":
      return { id: "javascript", name: "JavaScript" };
    case "toml":
      return { id: "toml", name: "TOML" };
    case "openui":
      return { id: "openui", name: "OpenUI" };
    default:
      return { id: "text", name: "Plain Text" };
  }
}

function languageExtension(path: string): Extension {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "openui":
      return javascript();
    case "py":
      return python();
    case "json":
      return json();
    case "yaml":
    case "yml":
      return yaml();
    case "md":
    case "markdown":
      return markdown();
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return javascript({
        jsx: true,
        typescript: ext === "ts" || ext === "tsx",
      });
    default:
      return [];
  }
}

function readOnlyExtension(readOnly: boolean): Extension {
  return readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];
}

function pageCspNonce(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return (
    document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')
      ?.content || undefined
  );
}

export function CodeEditor({
  value,
  onChange,
  filePath,
  readOnly = false,
  minHeight = "100%",
  className = "",
}: CodeEditorProps) {
  const [highlightEnabled, setHighlightEnabled] = useState(true);
  const [language, setLanguage] = useState(() => detectLanguage(filePath));
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const highlightCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());
  const editorOptionsRef = useRef({ highlightEnabled, readOnly });
  editorOptionsRef.current = { highlightEnabled, readOnly };

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    valueRef.current = value;
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, insert: value, to: view.state.doc.length },
    });
  }, [value]);

  useEffect(() => {
    const nextLanguage = detectLanguage(filePath);
    setLanguage(nextLanguage);
    const parent = parentRef.current;
    if (!parent) return;
    const cspNonce = pageCspNonce();

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          bracketMatching(),
          indentOnInput(),
          highlightSelectionMatches(),
          history(),
          oneDarkTheme,
          ...(cspNonce ? [EditorView.cspNonce.of(cspNonce)] : []),
          highlightCompartmentRef.current.of(
            editorOptionsRef.current.highlightEnabled
              ? syntaxHighlighting(oneDarkHighlightStyle)
              : syntaxHighlighting(defaultHighlightStyle),
          ),
          readOnlyCompartmentRef.current.of(
            readOnlyExtension(editorOptionsRef.current.readOnly),
          ),
          languageExtension(filePath),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...markdownKeymap,
            { key: "Backspace", run: deleteMarkupBackward },
            indentWithTab,
          ]),
          EditorView.contentAttributes.of({ "aria-label": "Code editor" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const nextValue = update.state.doc.toString();
              valueRef.current = nextValue;
              onChangeRef.current(nextValue);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [filePath]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: highlightCompartmentRef.current.reconfigure(
        highlightEnabled
          ? syntaxHighlighting(oneDarkHighlightStyle)
          : syntaxHighlighting(defaultHighlightStyle),
      ),
    });
  }, [highlightEnabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure(
        readOnlyExtension(readOnly),
      ),
    });
  }, [readOnly]);

  const lineCount = value.split("\n").length;

  return (
    <div
      className={`flex h-full flex-col overflow-hidden bg-base-100 ${className}`}
      style={{ minHeight }}
    >
      <div className="flex items-center justify-between border-b border-base-content/10 bg-base-200/40 px-3 py-1 text-xs">
        <div className="flex items-center gap-2">
          <span className="badge badge-neutral badge-xs font-mono font-medium">
            {language.name}
          </span>
          <span className="font-mono text-[10px] text-base-content/50">
            {lineCount} lines • {value.length} chars
          </span>
        </div>
        <button
          className={`btn btn-ghost btn-xs h-6 min-h-0 text-[11px] ${
            highlightEnabled
              ? "font-medium text-primary"
              : "text-base-content/50"
          }`}
          onClick={() => setHighlightEnabled((enabled) => !enabled)}
          title="Toggle live syntax highlighting"
          type="button"
        >
          {highlightEnabled ? "Syntax On" : "Syntax Off"}
        </button>
      </div>
      <div
        className="workspace-codemirror min-h-0 flex-1 overflow-hidden"
        ref={parentRef}
      />
    </div>
  );
}

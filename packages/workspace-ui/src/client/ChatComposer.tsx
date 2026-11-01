import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import type { ChatRun } from "../shared/chat";

interface ComposerEditResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export function applyComposerEnter(
  draft: string,
  selectionStart: number,
  selectionEnd: number,
): ComposerEditResult | null {
  if (selectionStart !== selectionEnd) return null;
  const lineStart =
    selectionStart === 0 ? 0 : draft.lastIndexOf("\n", selectionStart - 1) + 1;
  const nextNewline = draft.indexOf("\n", selectionStart);
  const lineEnd = nextNewline === -1 ? draft.length : nextNewline;
  const lineBefore = draft.slice(lineStart, selectionStart);
  const lineAfter = draft.slice(selectionStart, lineEnd);

  const taskMatch = /^(\s*)([-*+])\s+\[[ xX]\]\s+(.*)$/.exec(lineBefore);
  if (taskMatch) {
    const indent = taskMatch[1] ?? "";
    const bullet = taskMatch[2] ?? "-";
    const rest = taskMatch[3] ?? "";
    if (!rest.trim() && !lineAfter.trim()) {
      const next =
        draft.slice(0, lineStart) + indent + draft.slice(selectionStart);
      const caret = lineStart + indent.length;
      return { value: next, selectionStart: caret, selectionEnd: caret };
    }
    const insert = `\n${indent}${bullet} [ ] `;
    const caret = selectionStart + insert.length;
    return {
      value:
        draft.slice(0, selectionStart) + insert + draft.slice(selectionStart),
      selectionStart: caret,
      selectionEnd: caret,
    };
  }

  const bulletMatch = /^(\s*)([-*+])\s+(.*)$/.exec(lineBefore);
  if (bulletMatch) {
    const indent = bulletMatch[1] ?? "";
    const bullet = bulletMatch[2] ?? "-";
    const rest = bulletMatch[3] ?? "";
    if (!rest.trim() && !lineAfter.trim()) {
      const next =
        draft.slice(0, lineStart) + indent + draft.slice(selectionStart);
      const caret = lineStart + indent.length;
      return { value: next, selectionStart: caret, selectionEnd: caret };
    }
    const insert = `\n${indent}${bullet} `;
    const caret = selectionStart + insert.length;
    return {
      value:
        draft.slice(0, selectionStart) + insert + draft.slice(selectionStart),
      selectionStart: caret,
      selectionEnd: caret,
    };
  }

  const orderedMatch = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(lineBefore);
  if (orderedMatch) {
    const indent = orderedMatch[1] ?? "";
    const num = Number(orderedMatch[2] ?? "1");
    const delim = orderedMatch[3] ?? ".";
    const rest = orderedMatch[4] ?? "";
    if (!rest.trim() && !lineAfter.trim()) {
      const next =
        draft.slice(0, lineStart) + indent + draft.slice(selectionStart);
      const caret = lineStart + indent.length;
      return { value: next, selectionStart: caret, selectionEnd: caret };
    }
    const insert = `\n${indent}${num + 1}${delim} `;
    const caret = selectionStart + insert.length;
    return {
      value:
        draft.slice(0, selectionStart) + insert + draft.slice(selectionStart),
      selectionStart: caret,
      selectionEnd: caret,
    };
  }

  const quoteMatch = /^(\s*(?:>\s+)+)(.*)$/.exec(lineBefore);
  if (quoteMatch) {
    const prefix = quoteMatch[1] ?? "> ";
    const rest = quoteMatch[2] ?? "";
    if (!rest.trim() && !lineAfter.trim()) {
      const next = draft.slice(0, lineStart) + draft.slice(selectionStart);
      return {
        value: next,
        selectionStart: lineStart,
        selectionEnd: lineStart,
      };
    }
    const insert = `\n${prefix}`;
    const caret = selectionStart + insert.length;
    return {
      value:
        draft.slice(0, selectionStart) + insert + draft.slice(selectionStart),
      selectionStart: caret,
      selectionEnd: caret,
    };
  }

  return null;
}

export function applyComposerTab(
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  shiftKey: boolean,
): ComposerEditResult | null {
  if (!draft) return null;
  const blockStart =
    selectionStart === 0 ? 0 : draft.lastIndexOf("\n", selectionStart - 1) + 1;
  const effectiveEnd =
    selectionEnd > blockStart && draft[selectionEnd - 1] === "\n"
      ? selectionEnd - 1
      : selectionEnd;
  const nextNewline = draft.indexOf("\n", effectiveEnd);
  const blockEnd = nextNewline === -1 ? draft.length : nextNewline;
  const block = draft.slice(blockStart, blockEnd);
  const lines = block.split("\n");

  if (shiftKey) {
    let firstRemoved = 0;
    let totalRemoved = 0;
    const updated = lines.map((line, index) => {
      const match = /^( {1,2}|\t)/.exec(line);
      if (!match) return line;
      const removed = match[0].length;
      if (index === 0) firstRemoved = removed;
      totalRemoved += removed;
      return line.slice(removed);
    });
    if (totalRemoved === 0) return null;
    const nextValue =
      draft.slice(0, blockStart) + updated.join("\n") + draft.slice(blockEnd);
    const nextStart = Math.max(blockStart, selectionStart - firstRemoved);
    const nextEnd = Math.max(nextStart, selectionEnd - totalRemoved);
    return {
      value: nextValue,
      selectionStart: nextStart,
      selectionEnd: nextEnd,
    };
  }

  if (selectionStart === selectionEnd) {
    const currentLine = lines[0] ?? "";
    if (/^\s*(?:[-*+]|\d+[.)]|>)\s/.test(currentLine)) {
      const nextValue = `${draft.slice(0, blockStart)}  ${draft.slice(blockStart)}`;
      return {
        value: nextValue,
        selectionStart: selectionStart + 2,
        selectionEnd: selectionEnd + 2,
      };
    }
    const nextValue = `${draft.slice(0, selectionStart)}  ${draft.slice(selectionEnd)}`;
    return {
      value: nextValue,
      selectionStart: selectionStart + 2,
      selectionEnd: selectionEnd + 2,
    };
  }

  const indented = lines.map((line) => `  ${line}`).join("\n");
  const nextValue =
    draft.slice(0, blockStart) + indented + draft.slice(blockEnd);
  return {
    value: nextValue,
    selectionStart: selectionStart + 2,
    selectionEnd: selectionEnd + lines.length * 2,
  };
}

export function ChatComposer({
  draft,
  model,
  models,
  run,
  active,
  busy,
  disabled,
  canSteer,
  canStop,
  onDraft,
  onModel,
  onSend,
  onSteer,
  onStop,
}: {
  draft: string;
  model: string;
  models: { id: string }[];
  run: ChatRun | null;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  canSteer: boolean;
  canStop: boolean;
  onDraft: (value: string) => void;
  onModel: (value: string) => void;
  onSend: () => void;
  onSteer: () => void;
  onStop: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    const savedScrollTop = el.scrollTop;
    if (expanded) {
      el.style.height = "";
    } else {
      el.style.height = "0px";
      el.style.height = `${draft ? Math.min(160, Math.max(24, el.scrollHeight)) : 24}px`;
    }
    el.scrollTop = savedScrollTop;
    if (pendingSelection.current) {
      el.setSelectionRange(
        pendingSelection.current.start,
        pendingSelection.current.end,
      );
      pendingSelection.current = null;
    }
  }, [draft, expanded]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      if (active) {
        if (canSteer && !busy && draft.trim() && run?.status === "running") {
          setExpanded(false);
          onSteer();
        }
      } else if (!busy && !disabled && draft.trim()) {
        setExpanded(false);
        onSend();
      }
      return;
    }

    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
      return;
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const target = event.currentTarget;
      const result = applyComposerEnter(
        draft,
        target.selectionStart ?? draft.length,
        target.selectionEnd ?? draft.length,
      );
      if (result) {
        event.preventDefault();
        pendingSelection.current = {
          start: result.selectionStart,
          end: result.selectionEnd,
        };
        onDraft(result.value);
      }
      return;
    }

    if (
      event.key === "Tab" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const target = event.currentTarget;
      const result = applyComposerTab(
        draft,
        target.selectionStart ?? draft.length,
        target.selectionEnd ?? draft.length,
        event.shiftKey,
      );
      if (result) {
        event.preventDefault();
        pendingSelection.current = {
          start: result.selectionStart,
          end: result.selectionEnd,
        };
        onDraft(result.value);
      }
    }
  };

  return (
    <form
      className={`chat-composer${expanded ? " chat-composer--expanded" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!active && !busy && !disabled && draft.trim()) {
          setExpanded(false);
          onSend();
        }
      }}
    >
      <div className="chat-composer-input">
        <textarea
          ref={input}
          aria-label="Message Lia"
          rows={1}
          maxLength={32000}
          placeholder={active ? "Guide the running agent…" : "Message Lia…"}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {active ? (
          <div className="chat-run-controls">
            {canSteer && (
              <button
                className="btn btn-sm"
                type="button"
                title="Send guidance (Ctrl/⌘+Enter)"
                disabled={busy || !draft.trim() || run?.status !== "running"}
                onClick={() => {
                  setExpanded(false);
                  onSteer();
                }}
              >
                Send guidance
              </button>
            )}
            {canStop && (
              <button
                className="btn btn-error btn-sm"
                type="button"
                disabled={busy || run?.status === "stopping"}
                onClick={onStop}
              >
                Stop
              </button>
            )}
          </div>
        ) : (
          <button
            className="chat-send btn btn-primary"
            type="submit"
            aria-label="Send"
            title="Send message (Ctrl/⌘+Enter)"
            disabled={busy || disabled || !draft.trim()}
          >
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                d="M12 19V5m-6 6 6-6 6 6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      <div className="chat-composer-footer">
        <select
          aria-label="Hermes model route"
          value={model}
          disabled={active}
          onChange={(event) => onModel(event.target.value)}
        >
          <option value="">Hermes default</option>
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id}
            </option>
          ))}
        </select>
        <div className="chat-composer-footer-actions">
          <span className="chat-composer-hint">
            {run?.runtime?.model
              ? `Used: ${run.runtime.model}`
              : "Enter for a new line · Ctrl/⌘ + Enter to submit"}
          </span>
          <button
            type="button"
            className="chat-expand-toggle btn btn-ghost btn-xs"
            aria-label={expanded ? "Collapse editor" : "Expand editor"}
            aria-pressed={expanded}
            title={
              expanded ? "Collapse editor (Esc)" : "Expand editor for long text"
            }
            onClick={() => {
              setExpanded((current) => !current);
              input.current?.focus();
            }}
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        </div>
      </div>
    </form>
  );
}

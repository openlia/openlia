import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { WorkspaceTreeEntry } from "../shared/api";
import {
  filterGoToSuggestions,
  type GoToSuggestion,
  resolveLinkTarget,
} from "./openliaLinks";

export interface GoToModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateWorkspace: (path: string) => void;
  tree?: WorkspaceTreeEntry[] | undefined;
}

export function GoToModal({
  isOpen,
  onClose,
  onNavigateWorkspace,
  tree = [],
}: GoToModalProps) {
  const [input, setInput] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (isOpen) {
      setInput("");
      setSelectedIndex(-1);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isOpen]);

  const target = useMemo(() => {
    if (!input.trim()) return null;
    return resolveLinkTarget(input, { tree });
  }, [input, tree]);

  const suggestions = useMemo(() => {
    return filterGoToSuggestions(input, { limit: 8, tree });
  }, [input, tree]);

  if (!isOpen) return null;

  function executeNavigation(item: GoToSuggestion | null) {
    if (item) {
      onNavigateWorkspace(item.id);
      onClose();
      return;
    }

    if (target) {
      onNavigateWorkspace(target.path);
      onClose();
    }
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (suggestions.length === 0) return;
      setSelectedIndex((prev) => (prev + 1) % suggestions.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (suggestions.length === 0) return;
      setSelectedIndex((prev) =>
        prev <= 0 ? suggestions.length - 1 : prev - 1,
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const selected =
        selectedIndex >= 0 && selectedIndex < suggestions.length
          ? (suggestions[selectedIndex] ?? null)
          : target?.exists
            ? null
            : (suggestions[0] ?? null);
      executeNavigation(selected);
    }
  }

  return (
    <div
      aria-labelledby={titleId}
      aria-modal="true"
      className="modal modal-open z-50"
      role="dialog"
    >
      <div className="modal-box max-w-xl overflow-hidden p-0 shadow-2xl bg-base-100 border border-base-content/10">
        <div className="border-b border-base-content/10 p-4">
          <div className="flex items-center justify-between pb-2">
            <div className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded bg-primary/10 text-primary">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <title>Go To</title>
                  <path
                    d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <h2 className="text-sm font-bold tracking-tight" id={titleId}>
                Go To Document
              </h2>
            </div>
            <kbd className="kbd kbd-xs bg-base-200 text-xs">Esc</kbd>
          </div>

          <div className="relative mt-2">
            <input
              aria-label="Target link or search query"
              autoComplete="off"
              className="input input-bordered input-md w-full bg-base-200/50 pl-3 pr-8 font-mono text-sm focus:bg-base-100"
              onChange={(e) => {
                setInput(e.target.value);
                setSelectedIndex(-1);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Paste link or path, or type file name..."
              ref={inputRef}
              spellCheck={false}
              type="text"
              value={input}
            />
            {input && (
              <button
                aria-label="Clear input"
                className="btn btn-ghost btn-circle btn-xs absolute right-2 top-1/2 -translate-y-1/2"
                onClick={() => {
                  setInput("");
                  inputRef.current?.focus();
                }}
                type="button"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {target && (
          <div className="border-b border-base-content/10 bg-base-200/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="badge badge-sm badge-primary font-semibold uppercase tracking-wider">
                  Document
                </span>
                <span className="truncate font-mono text-xs font-medium">
                  {target.label}
                </span>
              </div>
              <button
                className="btn btn-primary btn-xs shrink-0"
                onClick={() => executeNavigation(null)}
                type="button"
              >
                Open ↵
              </button>
            </div>
            {target.exists === false && (
              <p className="mt-1 text-[11px] text-base-content/50 italic">
                Target is not currently indexed in the tree, but will be loaded
                directly.
              </p>
            )}
          </div>
        )}

        <div className="max-h-64 overflow-y-auto p-2">
          {suggestions.length > 0 ? (
            <ul className="menu menu-compact w-full gap-0.5 p-0">
              {suggestions.map((item, index) => {
                const isSelected = index === selectedIndex;
                return (
                  <li key={`${item.kind}-${item.id}`}>
                    <button
                      className={`flex items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${
                        isSelected ? "active" : ""
                      }`}
                      onClick={() => executeNavigation(item)}
                      type="button"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-medium truncate">
                            {item.title}
                          </span>
                        </div>
                        {item.subtitle && (
                          <p className="truncate text-[11px] text-base-content/60">
                            {item.subtitle}
                          </p>
                        )}
                      </div>
                      <span className="badge badge-ghost badge-xs shrink-0 ml-2 font-mono text-[10px]">
                        {item.badge}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="p-4 text-center text-xs text-base-content/50">
              No matching documents found.
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-base-content/10 bg-base-200/30 px-3 py-2 text-[11px] text-base-content/60">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="kbd kbd-xs mr-1">↑↓</kbd> Navigate
            </span>
            <span>
              <kbd className="kbd kbd-xs mr-1">↵</kbd> Select
            </span>
            <span>
              <kbd className="kbd kbd-xs mr-1">Esc</kbd> Close
            </span>
          </div>
          <button
            className="btn btn-ghost btn-xs text-xs"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
      <button
        aria-label="Close modal backdrop"
        className="modal-backdrop bg-black/40"
        onClick={onClose}
        type="button"
      >
        close
      </button>
    </div>
  );
}

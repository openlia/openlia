import { useLayoutEffect, useRef } from "react";
import type { ChatRun } from "../shared/chat";

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
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = "0px";
    input.current.style.height = `${draft ? Math.min(160, Math.max(24, input.current.scrollHeight)) : 24}px`;
  }, [draft]);
  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!active && !busy && !disabled) onSend();
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
        />
        {active ? (
          <div className="chat-run-controls">
            {canSteer && (
              <button
                className="btn btn-sm"
                type="button"
                disabled={busy || !draft.trim() || run?.status !== "running"}
                onClick={onSteer}
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
            title="Send message"
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
        <span className="chat-composer-hint">
          {run?.runtime?.model
            ? `Used: ${run.runtime.model}`
            : "Enter for a new line · Click Send to submit"}
        </span>
      </div>
    </form>
  );
}

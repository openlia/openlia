import { useState } from "react";

export interface ConfirmChatPromptModalProps {
  title?: string | undefined;
  projectName: string;
  initialPrompt: string;
  onConfirm: (prompt: string) => void;
  onCancel: () => void;
}

export function ConfirmChatPromptModal({
  title = "Continue in Chat with Lia",
  projectName,
  initialPrompt,
  onConfirm,
  onCancel,
}: ConfirmChatPromptModalProps) {
  const [prompt, setPrompt] = useState(initialPrompt);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      role="presentation"
    >
      <section
        aria-labelledby="chat-prompt-dialog-title"
        aria-modal="true"
        className="card w-full max-w-lg border border-base-content/10 bg-base-100 shadow-2xl"
        role="dialog"
      >
        <div className="card-body gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="card-title text-base" id="chat-prompt-dialog-title">
              {title}
            </h2>
            <span className="badge badge-primary badge-outline text-xs">
              {projectName}
            </span>
          </div>

          <p className="text-xs text-base-content/70">
            This action will switch to the <strong>Chat</strong> tab with
            pre-filled context so you can edit or submit it to Lia:
          </p>

          <textarea
            aria-label="Prompt context"
            className="textarea textarea-bordered w-full text-xs font-mono h-28 focus:outline-primary"
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Prompt text..."
            value={prompt}
          />

          <div className="card-actions justify-end mt-2">
            <button
              className="btn btn-sm btn-ghost"
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-sm btn-primary"
              disabled={!prompt.trim()}
              onClick={() => onConfirm(prompt.trim())}
              type="button"
            >
              Open in Chat
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function DirtyDraftDialog({
  onCancel,
  onDiscard,
  onSave,
  actionLabel,
  saving,
}: {
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
  actionLabel: string;
  saving: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      role="presentation"
    >
      <section
        aria-labelledby="unsaved-dialog-title"
        aria-modal="true"
        className="card w-full max-w-md border border-base-content/10 bg-base-100 shadow-2xl"
        role="dialog"
      >
        <div className="card-body">
          <h2 className="card-title" id="unsaved-dialog-title">
            Keep your draft?
          </h2>
          <p className="text-sm leading-6 text-base-content/60">
            You have changes that are not saved. Save them before{" "}
            {actionLabel.toLowerCase()}, discard them, or keep editing.
          </p>
          <div className="card-actions mt-4 justify-end">
            <button className="btn btn-ghost" onClick={onCancel} type="button">
              Keep editing
            </button>
            <button
              className="btn btn-error btn-outline"
              onClick={onDiscard}
              type="button"
            >
              Discard
            </button>
            <button
              className="btn btn-primary"
              disabled={saving}
              onClick={onSave}
              type="button"
            >
              {saving ? "Saving..." : "Save and continue"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

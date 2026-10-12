export function DeleteFileDialog({
  dirty,
  filePath,
  onCancel,
  onConfirm,
  deleting,
}: {
  dirty: boolean;
  filePath: string;
  onCancel: () => void;
  onConfirm: () => void;
  deleting: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      role="presentation"
    >
      <section
        aria-labelledby="delete-dialog-title"
        aria-modal="true"
        className="card w-full max-w-md border border-error/30 bg-base-100 shadow-2xl"
        role="dialog"
      >
        <div className="card-body">
          <h2 className="card-title" id="delete-dialog-title">
            Delete document?
          </h2>
          <p className="break-words text-sm leading-6 text-base-content/60">
            {dirty
              ? `"${filePath}" has unsaved changes. Deleting it will discard the draft.`
              : `This will permanently delete "${filePath}" from the workspace.`}
          </p>
          <div className="card-actions mt-4 justify-end">
            <button
              className="btn btn-ghost"
              disabled={deleting}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-error"
              disabled={deleting}
              onClick={onConfirm}
              type="button"
            >
              {deleting
                ? "Deleting..."
                : dirty
                  ? "Discard and delete"
                  : "Delete"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

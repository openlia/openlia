export function DeleteFileDialog({
  dirty,
  filePath,
  onCancel,
  onConfirm,
  deleting,
  itemType = "file",
}: {
  dirty: boolean;
  filePath: string;
  onCancel: () => void;
  onConfirm: () => void;
  deleting: boolean;
  itemType?: "file" | "folder";
}) {
  const isFolder = itemType === "folder";
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
            {isFolder ? "Delete folder?" : "Delete document?"}
          </h2>
          <p className="break-words text-sm leading-6 text-base-content/60">
            {isFolder
              ? dirty
                ? `A document inside "${filePath}" has unsaved changes. Deleting this folder will discard the draft.`
                : `This will permanently delete the folder "${filePath}" and all of its contents.`
              : dirty
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
                  : isFolder
                    ? "Delete folder"
                    : "Delete"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

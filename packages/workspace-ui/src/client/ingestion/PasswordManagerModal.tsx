import { useCallback, useEffect, useId, useState } from "react";
import type { DocumentPasswordProfile } from "../../shared/api";
import type { WorkspaceApi } from "../api";

export interface PasswordManagerModalProps {
  api: WorkspaceApi;
  isOpen: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

export function PasswordManagerModal({
  api,
  isOpen,
  onClose,
  onChanged,
}: PasswordManagerModalProps) {
  const [profiles, setProfiles] = useState<DocumentPasswordProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Mode: "list" | "create" | "edit"
  const [mode, setMode] = useState<"list" | "create" | "edit">("list");
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);

  // Form states
  const [formProfileId, setFormProfileId] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formHint, setFormHint] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPatterns, setFormPatterns] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const titleId = useId();

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listDocumentPasswords();
      setProfiles(res.profiles ?? []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load password profiles",
      );
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (isOpen) {
      void loadProfiles();
      setMode("list");
      setEditingProfileId(null);
      setDeletingId(null);
      setSearch("");
    }
  }, [isOpen, loadProfiles]);

  const handleStartCreate = () => {
    setFormProfileId("");
    setFormLabel("");
    setFormPassword("");
    setShowPassword(false);
    setFormHint("");
    setFormDescription("");
    setFormPatterns("");
    setFormError(null);
    setMode("create");
  };

  const handleStartEdit = (prof: DocumentPasswordProfile) => {
    setEditingProfileId(prof.profile_id);
    setFormProfileId(prof.profile_id);
    setFormLabel(prof.label);
    setFormPassword(""); // Leave empty to keep existing password
    setShowPassword(false);
    setFormHint(prof.hint ?? "");
    setFormDescription(prof.description ?? "");
    setFormPatterns((prof.patterns ?? []).join(", "));
    setFormError(null);
    setMode("edit");
  };

  const handleLabelChange = (val: string) => {
    setFormLabel(val);
    if (mode === "create" && !formProfileId) {
      // Auto-generate profile_id slug from label
      const slug = val
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48);
      setFormProfileId(slug);
    }
  };

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = formProfileId.trim();
    const cleanLabel = formLabel.trim();
    if (!cleanId) {
      setFormError("Profile ID is required");
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cleanId)) {
      setFormError(
        "Profile ID must be alphanumeric and up to 64 characters (can include ., _, -)",
      );
      return;
    }
    if (!cleanLabel) {
      setFormError("Profile label is required");
      return;
    }
    if (mode === "create" && !formPassword) {
      setFormError("Document password is required for new profiles");
      return;
    }

    const patterns = formPatterns
      .split(/[,\n]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    setFormSaving(true);
    setFormError(null);
    try {
      await api.saveDocumentPassword(
        cleanId,
        cleanLabel,
        formPassword ? formPassword : undefined,
        formDescription.trim() || undefined,
        formHint.trim() || undefined,
        patterns.length > 0 ? patterns : undefined,
      );
      await loadProfiles();
      onChanged?.();
      setMode("list");
      setEditingProfileId(null);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to save profile",
      );
    } finally {
      setFormSaving(false);
    }
  };

  const handleDelete = async (profileId: string) => {
    try {
      await api.deleteDocumentPassword(profileId);
      await loadProfiles();
      onChanged?.();
      setDeletingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete profile");
    }
  };

  if (!isOpen) return null;

  const filteredProfiles = profiles.filter((p) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      p.label.toLowerCase().includes(q) ||
      p.profile_id.toLowerCase().includes(q) ||
      (p.hint && p.hint.toLowerCase().includes(q)) ||
      (p.description && p.description.toLowerCase().includes(q)) ||
      (p.patterns && p.patterns.some((pat) => pat.toLowerCase().includes(q)))
    );
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-base-content/10 bg-base-100 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-base-content/10 px-6 py-4">
          <div>
            <h2
              id={titleId}
              className="text-base font-bold text-base-content flex items-center gap-2"
            >
              <span>🔑</span>
              <span>Document Password Profiles</span>
            </h2>
            <p className="text-xs text-base-content/60 mt-0.5">
              Securely stored in Ingestion Vault (
              <code>document-passwords.toml</code>). Used to unlock encrypted
              PDFs and spreadsheets.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-circle btn-sm"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="alert alert-error mb-4 py-2 text-xs">
              <span>{error}</span>
            </div>
          )}

          {mode === "list" ? (
            <div className="space-y-4">
              {/* Search & Add Bar */}
              <div className="flex items-center justify-between gap-3">
                <div className="relative flex-1">
                  <input
                    type="text"
                    placeholder="Search profiles by label, ID, hint, or pattern..."
                    className="input input-bordered input-sm w-full pl-8 text-xs"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <svg
                    className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-base-content/40"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <title>Search</title>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm gap-1.5 shrink-0"
                  onClick={handleStartCreate}
                >
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <title>Add</title>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M12 4v16m8-8H4"
                    />
                  </svg>
                  Add Profile
                </button>
              </div>

              {/* Profiles List */}
              {loading ? (
                <div className="flex justify-center p-8">
                  <span className="loading loading-spinner loading-md text-primary" />
                </div>
              ) : filteredProfiles.length === 0 ? (
                <div className="rounded-xl border border-dashed border-base-content/20 p-8 text-center text-xs text-base-content/60">
                  {search ? (
                    <p>No password profiles match &ldquo;{search}&rdquo;.</p>
                  ) : (
                    <div>
                      <p className="font-medium text-base-content/80">
                        No password profiles defined yet.
                      </p>
                      <p className="mt-1">
                        Add profiles for banks, payroll, or recurring
                        password-protected documents.
                      </p>
                      <button
                        type="button"
                        className="btn btn-outline btn-xs mt-3"
                        onClick={handleStartCreate}
                      >
                        Create First Profile
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredProfiles.map((prof) => (
                    <div
                      key={prof.profile_id}
                      className="group rounded-xl border border-base-content/10 bg-base-200/30 p-3.5 transition hover:border-base-content/20 hover:bg-base-200/50"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-sm text-base-content">
                              {prof.label}
                            </span>
                            <span className="badge badge-sm font-mono text-[11px] bg-base-300 border-none text-base-content/70">
                              {prof.profile_id}
                            </span>
                          </div>

                          {prof.hint && (
                            <p className="mt-1 text-xs text-info flex items-center gap-1">
                              <span>💡</span>
                              <span>Hint: {prof.hint}</span>
                            </p>
                          )}

                          {prof.description && (
                            <p className="mt-1 text-xs text-base-content/70">
                              {prof.description}
                            </p>
                          )}

                          {prof.patterns && prof.patterns.length > 0 && (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <span className="text-[10px] uppercase font-semibold text-base-content/40">
                                Match rules:
                              </span>
                              {prof.patterns.map((pat) => (
                                <span
                                  key={`${prof.profile_id}-${pat}`}
                                  className="badge badge-outline badge-xs font-mono text-[10px]"
                                >
                                  {pat}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs text-base-content/70 hover:text-base-content"
                            onClick={() => handleStartEdit(prof)}
                            title="Edit profile metadata or rotate password"
                          >
                            Edit
                          </button>
                          {deletingId === prof.profile_id ? (
                            <div className="flex items-center gap-1 bg-error/10 p-1 rounded-lg border border-error/20">
                              <span className="text-[11px] text-error font-medium px-1">
                                Delete?
                              </span>
                              <button
                                type="button"
                                className="btn btn-error btn-xs"
                                onClick={() => handleDelete(prof.profile_id)}
                              >
                                Yes
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-xs"
                                onClick={() => setDeletingId(null)}
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs text-error/70 hover:text-error"
                              onClick={() => setDeletingId(prof.profile_id)}
                              title="Delete profile"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* Form Mode (Create or Edit) */
            <form onSubmit={handleSaveForm} className="space-y-4 text-xs">
              <div className="flex items-center justify-between border-b border-base-content/10 pb-2">
                <h3 className="font-bold text-sm text-base-content">
                  {mode === "create"
                    ? "Add New Password Profile"
                    : `Edit Profile: ${formLabel || formProfileId}`}
                </h3>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => setMode("list")}
                >
                  ← Back to List
                </button>
              </div>

              {formError && (
                <div className="alert alert-error py-2 text-xs">
                  <span>{formError}</span>
                </div>
              )}

              {/* Label */}
              <div>
                <label
                  htmlFor="pm-profile-label"
                  className="block font-semibold text-base-content/80 mb-1"
                >
                  Profile Label <span className="text-error">*</span>
                </label>
                <input
                  id="pm-profile-label"
                  type="text"
                  placeholder="e.g. Primary Bank Statements"
                  className="input input-bordered input-sm w-full text-xs"
                  value={formLabel}
                  onChange={(e) => handleLabelChange(e.target.value)}
                  required
                />
              </div>

              {/* Profile ID */}
              <div>
                <label
                  htmlFor="pm-profile-id"
                  className="block font-semibold text-base-content/80 mb-1"
                >
                  Profile Identifier (ID) <span className="text-error">*</span>
                </label>
                <input
                  id="pm-profile-id"
                  type="text"
                  placeholder="e.g. bank_statements"
                  className="input input-bordered input-sm w-full font-mono text-xs"
                  value={formProfileId}
                  onChange={(e) => setFormProfileId(e.target.value)}
                  disabled={mode === "edit"}
                  required
                />
                <p className="mt-0.5 text-[11px] text-base-content/50">
                  {mode === "edit"
                    ? "Profile ID cannot be changed once created."
                    : "Safe identifier (letters, digits, ., _, -). Auto-slugged from label."}
                </p>
              </div>

              {/* Password */}
              <div>
                <label
                  htmlFor="pm-profile-password"
                  className="block font-semibold text-base-content/80 mb-1"
                >
                  {mode === "create" ? (
                    <>
                      Document Password <span className="text-error">*</span>
                    </>
                  ) : (
                    <>Rotate Password (Optional)</>
                  )}
                </label>
                <div className="relative">
                  <input
                    id="pm-profile-password"
                    type={showPassword ? "text" : "password"}
                    placeholder={
                      mode === "create"
                        ? "Enter document password"
                        : "Leave blank to keep existing password"
                    }
                    className="input input-bordered input-sm w-full pr-16 text-xs font-mono"
                    value={formPassword}
                    onChange={(e) => setFormPassword(e.target.value)}
                    required={mode === "create"}
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1.5 btn btn-ghost btn-xs text-base-content/60"
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
                <p className="mt-0.5 text-[11px] text-base-content/50">
                  Stored with 0600 permissions in Ingestion Vault. Never exposed
                  in API list calls.
                </p>
              </div>

              {/* Password Hint */}
              <div>
                <label
                  htmlFor="pm-profile-hint"
                  className="block font-semibold text-base-content/80 mb-1"
                >
                  Password Hint (Optional)
                </label>
                <input
                  id="pm-profile-hint"
                  type="text"
                  placeholder="e.g. Last 4 digits of tax ID / phone number"
                  className="input input-bordered input-sm w-full text-xs"
                  value={formHint}
                  onChange={(e) => setFormHint(e.target.value)}
                />
                <p className="mt-0.5 text-[11px] text-base-content/50">
                  Displayed during upload and review to help you remember the
                  password.
                </p>
              </div>

              {/* Description */}
              <div>
                <label
                  htmlFor="pm-profile-description"
                  className="block font-semibold text-base-content/80 mb-1"
                >
                  Description & Usage Notes (Optional)
                </label>
                <textarea
                  id="pm-profile-description"
                  placeholder="e.g. Used for monthly checking and savings account statements from Chase."
                  className="textarea textarea-bordered textarea-xs w-full text-xs"
                  rows={2}
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                />
              </div>

              {/* Patterns */}
              <div>
                <label
                  htmlFor="pm-profile-patterns"
                  className="block font-semibold text-base-content/80 mb-1"
                >
                  Match Patterns for Smart Suggestions (Optional)
                </label>
                <input
                  id="pm-profile-patterns"
                  type="text"
                  placeholder="e.g. *chase*, *bank*, *statement*"
                  className="input input-bordered input-sm w-full font-mono text-xs"
                  value={formPatterns}
                  onChange={(e) => setFormPatterns(e.target.value)}
                />
                <p className="mt-0.5 text-[11px] text-base-content/50">
                  Comma-separated wildcard patterns. OpenLia automatically
                  suggests this profile when uploaded documents match.
                </p>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-3 border-t border-base-content/10">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setMode("list")}
                  disabled={formSaving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={formSaving}
                >
                  {formSaving ? (
                    <>
                      <span className="loading loading-spinner loading-xs" />
                      Saving...
                    </>
                  ) : mode === "create" ? (
                    "Create Profile"
                  ) : (
                    "Save Changes"
                  )}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-base-content/10 bg-base-200/40 px-6 py-3 text-xs text-base-content/60">
          <span>
            {profiles.length} password profile{profiles.length === 1 ? "" : "s"}{" "}
            configured
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

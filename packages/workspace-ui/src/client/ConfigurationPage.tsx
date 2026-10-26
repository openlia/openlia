import { useEffect, useState } from "react";
import type {
  ConsequentialPermissionsResponse,
  PermissionMode,
  WorkspaceSettings,
  WorkspaceSystemInfo,
} from "../shared/api";
import type { WorkspaceApi } from "./api";

export interface ConfigurationPageProps {
  api?: WorkspaceApi | undefined;
  usagePricing?: import("react").ReactNode;
  exporting: boolean;
  onExport: () => void;
  onOpenSchedule?: () => void;
  onSettingsChange: (
    key: Exclude<keyof WorkspaceSettings, "schema">,
    value: boolean,
  ) => void;
  savingSettings: boolean;
  settings: WorkspaceSettings;
  systemInfo: WorkspaceSystemInfo | null;
  error: string;
}

function SystemValue({ value }: { value: string | undefined }) {
  return (
    <span className="break-all font-mono text-sm text-base-content/80">
      {value || "Unavailable"}
    </span>
  );
}

function VisibilitySetting({
  checked,
  disabled,
  description,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  description: string;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-base-content/10 bg-base-200/40 p-4 transition hover:border-primary/40">
      <input
        checked={checked}
        className="checkbox checkbox-primary mt-0.5"
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span className="min-w-0">
        <span className="block font-semibold">{label}</span>
        <span className="mt-1 block text-sm leading-5 text-base-content/60">
          {description}
        </span>
      </span>
    </label>
  );
}

export function ConfigurationPage({
  api,
  usagePricing,
  error,
  exporting,
  onExport,
  onOpenSchedule,
  onSettingsChange,
  savingSettings,
  settings,
  systemInfo,
}: ConfigurationPageProps) {
  const [permissions, setPermissions] = useState<
    ConsequentialPermissionsResponse["permissions"] | null
  >(null);
  const [savingPermissions, setSavingPermissions] = useState(false);
  const [permissionsError, setPermissionsError] = useState("");

  useEffect(() => {
    if (!api?.loadPermissions) return;
    let cancelled = false;
    api
      .loadPermissions()
      .then((res) => {
        if (!cancelled) setPermissions(res.permissions);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api]);

  const handlePermissionChange = async (
    group: keyof ConsequentialPermissionsResponse["permissions"],
    key: string,
    mode: PermissionMode,
  ) => {
    if (!permissions || !api?.updatePermissions) return;
    const next: ConsequentialPermissionsResponse["permissions"] = {
      ...permissions,
      [group]: {
        ...permissions[group],
        [key]: mode,
      },
    };
    setPermissions(next);
    setSavingPermissions(true);
    setPermissionsError("");
    try {
      const saved = await api.updatePermissions(next);
      setPermissions(saved.permissions);
    } catch (err) {
      setPermissionsError(
        err instanceof Error ? err.message : "Failed to save permissions",
      );
    } finally {
      setSavingPermissions(false);
    }
  };
  return (
    <div className="min-h-0 overflow-auto bg-base-100">
      <div className="mx-auto grid w-full max-w-5xl gap-6 p-5 sm:p-8">
        <header className="border-b border-base-content/10 pb-6">
          <p className="workspace-eyebrow">OPENLIA / CONFIGURATION</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight">
            Workspace configuration
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-base-content/60">
            Customize your document navigator, enable advanced memory editing,
            and manage workspace exports.
          </p>
        </header>

        <section
          aria-labelledby="workspace-settings-heading"
          className="grid gap-4"
        >
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="workspace-eyebrow">WORKSPACE</p>
              <h3
                className="mt-1 text-xl font-bold"
                id="workspace-settings-heading"
              >
                Workspace appearance
              </h3>
            </div>
            {savingSettings && (
              <span
                className="flex items-center gap-2 text-xs text-base-content/60"
                role="status"
              >
                <span className="loading loading-spinner loading-xs" />
                Saving settings...
              </span>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <VisibilitySetting
              checked={settings.hide_template_schema_files}
              description="Hide files ending in -template.md and .schema.json from the navigator."
              disabled={savingSettings}
              label="Hide template and schema files"
              onChange={(value) =>
                onSettingsChange("hide_template_schema_files", value)
              }
            />
            <VisibilitySetting
              checked={settings.hide_configuration_files}
              description="Hide workspace-ui.yaml and legacy configuration files from the navigator."
              disabled={savingSettings}
              label="Hide configuration files"
              onChange={(value) =>
                onSettingsChange("hide_configuration_files", value)
              }
            />
          </div>
        </section>

        {permissions && (
          <section
            aria-labelledby="consequential-permissions-heading"
            className="grid gap-4"
          >
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="workspace-eyebrow">PERMISSIONS</p>
                <h3
                  className="mt-1 text-xl font-bold"
                  id="consequential-permissions-heading"
                >
                  Consequential permissions
                </h3>
                <p className="mt-1 text-xs text-base-content/60">
                  Creating and organizing local workspace files is always
                  permitted. These settings govern destructive operations,
                  external side effects, and scheduled work.
                </p>
              </div>
              {savingPermissions && (
                <span className="flex items-center gap-2 text-xs text-base-content/60">
                  <span className="loading loading-spinner loading-xs" />
                  Saving permissions...
                </span>
              )}
            </div>

            {permissionsError && (
              <div className="alert alert-error text-xs" role="alert">
                {permissionsError}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-4 space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-base-content/70">
                  Destructive Actions
                </h4>
                {(
                  [
                    ["delete_records", "Delete records"],
                    ["overwrite_records", "Overwrite records"],
                  ] as const
                ).map(([k, label]) => (
                  <div
                    className="flex items-center justify-between gap-2 text-xs"
                    key={k}
                  >
                    <span>{label}</span>
                    <select
                      aria-label={label}
                      className="select select-bordered select-xs font-mono"
                      disabled={savingPermissions}
                      onChange={(e) =>
                        void handlePermissionChange(
                          "destructive",
                          k,
                          e.target.value as PermissionMode,
                        )
                      }
                      value={permissions.destructive[k]}
                    >
                      <option value="allow">allow</option>
                      <option value="ask">ask</option>
                      <option value="deny">deny</option>
                    </select>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-4 space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-base-content/70">
                  External Side Effects
                </h4>
                {(
                  [
                    ["send_messages", "Send messages"],
                    ["make_purchases", "Make purchases"],
                    ["modify_external_accounts", "Modify accounts"],
                    ["ingest_external_content", "Ingest external"],
                  ] as const
                ).map(([k, label]) => (
                  <div
                    className="flex items-center justify-between gap-2 text-xs"
                    key={k}
                  >
                    <span>{label}</span>
                    <select
                      aria-label={label}
                      className="select select-bordered select-xs font-mono"
                      disabled={savingPermissions}
                      onChange={(e) =>
                        void handlePermissionChange(
                          "external",
                          k,
                          e.target.value as PermissionMode,
                        )
                      }
                      value={permissions.external[k]}
                    >
                      <option value="allow">allow</option>
                      <option value="ask">ask</option>
                      <option value="deny">deny</option>
                    </select>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-4 space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-base-content/70">
                  Scheduled Work
                </h4>
                {(
                  [
                    ["run_briefings", "Run briefings"],
                    ["run_audits", "Run audits"],
                    ["run_monitors", "Run monitors"],
                  ] as const
                ).map(([k, label]) => (
                  <div
                    className="flex items-center justify-between gap-2 text-xs"
                    key={k}
                  >
                    <span>{label}</span>
                    <select
                      aria-label={label}
                      className="select select-bordered select-xs font-mono"
                      disabled={savingPermissions}
                      onChange={(e) =>
                        void handlePermissionChange(
                          "scheduled_work",
                          k,
                          e.target.value as PermissionMode,
                        )
                      }
                      value={permissions.scheduled_work[k]}
                    >
                      <option value="allow">allow</option>
                      <option value="ask">ask</option>
                      <option value="deny">deny</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        <section
          aria-labelledby="advanced-editing-heading"
          className="grid gap-4"
        >
          <div>
            <p className="workspace-eyebrow">ASSISTANT</p>
            <h3
              className="mt-1 text-xl font-bold"
              id="advanced-editing-heading"
            >
              Advanced editing
            </h3>
          </div>
          <VisibilitySetting
            checked={settings.enable_memory_editing}
            description="Show USER.md (your profile and preferences) and MEMORY.md (durable assistant notes) in the Assistant memory group in Documents. Changes are loaded into new assistant sessions."
            disabled={savingSettings}
            label="Enable user profile and memory editing"
            onChange={(value) =>
              onSettingsChange("enable_memory_editing", value)
            }
          />
        </section>

        {error && (
          <div className="alert alert-error text-sm" role="alert">
            {error}
          </div>
        )}

        <section
          aria-labelledby="workspace-export-heading"
          className="grid gap-4"
        >
          <div>
            <p className="workspace-eyebrow">DATA</p>
            <h3
              className="mt-1 text-xl font-bold"
              id="workspace-export-heading"
            >
              Export
            </h3>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
            <div>
              <p className="font-semibold">Export Workspace</p>
              <p className="mt-1 text-sm text-base-content/60">
                Download workspace documents, skills, and assistant memory as a
                ZIP archive.
              </p>
            </div>
            <button
              className="btn btn-primary btn-sm"
              disabled={exporting}
              onClick={onExport}
              type="button"
            >
              {exporting ? (
                <>
                  <span className="loading loading-spinner loading-xs" />
                  Exporting...
                </>
              ) : (
                "Export Workspace"
              )}
            </button>
          </div>
        </section>

        {usagePricing}

        {onOpenSchedule && (
          <section
            aria-labelledby="automation-schedules-heading"
            className="grid gap-4"
          >
            <div>
              <p className="workspace-eyebrow">AUTOMATION</p>
              <h3
                className="mt-1 text-xl font-bold"
                id="automation-schedules-heading"
              >
                Scheduled tasks & cron jobs
              </h3>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-base-content/10 bg-base-200/40 p-4">
              <div>
                <p className="font-semibold">Manage Schedules & Jobs</p>
                <p className="mt-1 text-sm text-base-content/60">
                  View and edit Hermes recurring tasks, inspect backup
                  schedules, and check policy enforcement.
                </p>
              </div>
              <button
                className="btn btn-outline btn-sm"
                onClick={onOpenSchedule}
                type="button"
              >
                View Schedules
              </button>
            </div>
          </section>
        )}

        <section
          aria-labelledby="system-information-heading"
          className="grid gap-4"
        >
          <div>
            <p className="workspace-eyebrow">SYSTEM INFORMATION</p>
            <h3
              className="mt-1 text-xl font-bold"
              id="system-information-heading"
            >
              Runtime versions
            </h3>
          </div>
          <dl className="grid overflow-hidden rounded-xl border border-base-content/10 bg-base-200/30 sm:grid-cols-2">
            <div className="flex flex-col gap-1 border-b border-base-content/10 p-4 sm:border-r">
              <dt className="text-xs font-semibold uppercase tracking-wide text-base-content/50">
                OpenLia version
              </dt>
              <dd>
                <SystemValue value={systemInfo?.openlia_version} />
              </dd>
            </div>
            <div className="flex flex-col gap-1 border-b border-base-content/10 p-4">
              <dt className="text-xs font-semibold uppercase tracking-wide text-base-content/50">
                OpenLia hash
              </dt>
              <dd>
                <SystemValue value={systemInfo?.openlia_hash} />
              </dd>
            </div>
            <div className="flex flex-col gap-1 border-b border-base-content/10 p-4 sm:border-b-0 sm:border-r">
              <dt className="text-xs font-semibold uppercase tracking-wide text-base-content/50">
                Hermes version
              </dt>
              <dd>
                <SystemValue value={systemInfo?.hermes_version} />
              </dd>
            </div>
            <div className="flex flex-col gap-1 p-4">
              <dt className="text-xs font-semibold uppercase tracking-wide text-base-content/50">
                Locho version
              </dt>
              <dd>
                <SystemValue value={systemInfo?.locho_version} />
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}

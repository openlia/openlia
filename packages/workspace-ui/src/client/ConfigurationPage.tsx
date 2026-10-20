import type { WorkspaceSettings, WorkspaceSystemInfo } from "../shared/api";

export interface ConfigurationPageProps {
  usagePricing?: import("react").ReactNode;
  exporting: boolean;
  onExport: () => void;
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
  usagePricing,
  error,
  exporting,
  onExport,
  onSettingsChange,
  savingSettings,
  settings,
  systemInfo,
}: ConfigurationPageProps) {
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
              description="Hide workspace.yaml, assistant-policy.yaml, and their schemas from the navigator."
              disabled={savingSettings}
              label="Hide configuration files"
              onChange={(value) =>
                onSettingsChange("hide_configuration_files", value)
              }
            />
          </div>
        </section>

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

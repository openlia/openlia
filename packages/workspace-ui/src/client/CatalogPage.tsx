import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  FeatureInstallResponse,
  FeatureSummary,
  TemplatesCatalogProvenance,
} from "../shared/api";
import { ApiError, type WorkspaceApi } from "./api";

export type CatalogFilterKind =
  | "all"
  | "available"
  | "installed"
  | "minion"
  | "domains";

function getFeatureMinions(feature: FeatureSummary): string[] {
  if (feature.minions && feature.minions.length > 0) {
    return feature.minions;
  }
  return feature.domains
    .filter((d) => d.startsWith("minions/") && d.split("/").length === 2)
    .map((d) => d.slice("minions/".length));
}

function getWorkspaceDomains(feature: FeatureSummary): string[] {
  return feature.domains.filter((d) => !d.startsWith("minions/"));
}

function formatInstallError(
  featureId: string,
  caught: unknown,
): {
  code: string;
  title: string;
  detail: string;
  cliCommand?: string | undefined;
} {
  if (caught instanceof ApiError) {
    const code = caught.payload?.error || caught.message || "request_failed";
    const backendMessage = caught.payload?.message;

    if (code === "minion_install_requires_cli") {
      return {
        code,
        title: "Existing Minion App Conflict — Managed CLI Required",
        detail:
          backendMessage ||
          `A Minion app from '${featureId}' already exists in this workspace. Browser installation will not overwrite local code customizations or instance state.`,
        cliCommand: `openlia feature install ${featureId}`,
      };
    }

    if (code === "skill_install_requires_cli") {
      return {
        code,
        title: "Existing Skill Conflict — Managed CLI Required",
        detail:
          backendMessage ||
          `A skill bundled with '${featureId}' already exists (active or disabled). Browser installation will not overwrite local skill customizations or lineage.`,
        cliCommand: `openlia feature install ${featureId}`,
      };
    }

    if (code === "template_incompatible") {
      return {
        code,
        title: "Incompatible OpenLia Runtime Version",
        detail:
          backendMessage ||
          `Feature '${featureId}' requires a newer OpenLia runtime version than is currently deployed. Upgrade the deployment before installing.`,
      };
    }

    if (code === "runtime_identity_unavailable") {
      return {
        code,
        title: "Runtime Release Identity Unavailable",
        detail:
          backendMessage ||
          "Cannot verify the deployed Workspace UI release version required by this feature package.",
      };
    }

    if (
      code === "unsupported_required_tool" ||
      code === "invalid_template_compatibility"
    ) {
      return {
        code,
        title: "Requirement / Compatibility Check Failed",
        detail:
          backendMessage ||
          `Feature '${featureId}' declared requirements that failed validation (${code}).`,
      };
    }

    if (code === "feature_not_found") {
      return {
        code,
        title: "Feature or Required Dependency Not Found",
        detail:
          backendMessage ||
          `Feature '${featureId}' or one of its required feature dependencies was not found in the catalog.`,
      };
    }

    return {
      code,
      title: "Feature Installation Failed",
      detail: backendMessage || `Failed to install '${featureId}' (${code}).`,
    };
  }

  return {
    code: "install_failed",
    title: "Feature Installation Failed",
    detail:
      caught instanceof Error
        ? caught.message
        : `Failed to install '${featureId}'.`,
  };
}

export function CatalogPage({
  api,
  onOpenMinion,
  onOpenSkill,
  onOpenDomain,
  onFeatureInstalled,
}: {
  api: WorkspaceApi;
  onOpenMinion?: ((minionId: string) => void) | undefined;
  onOpenSkill?: ((skillId: string) => void) | undefined;
  onOpenDomain?: ((domainPath: string) => void) | undefined;
  onFeatureInstalled?:
    | ((result: FeatureInstallResponse) => void | Promise<void>)
    | undefined;
}) {
  const [features, setFeatures] = useState<FeatureSummary[]>([]);
  const [catalogProvenance, setCatalogProvenance] = useState<
    TemplatesCatalogProvenance | undefined
  >(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterKind, setFilterKind] = useState<CatalogFilterKind>("all");
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(
    null,
  );
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installResults, setInstallResults] = useState<
    Record<string, FeatureInstallResponse>
  >({});
  const [latestInstallResult, setLatestInstallResult] =
    useState<FeatureInstallResponse | null>(null);
  const [installError, setInstallError] = useState<{
    featureId: string;
    code: string;
    title: string;
    detail: string;
    cliCommand?: string | undefined;
  } | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await api.listFeatures();
      setFeatures(res.features);
      setCatalogProvenance(res.catalog);
      setSelectedFeatureId((current) => {
        if (current && res.features.some((f) => f.id === current)) {
          return current;
        }
        return res.features[0]?.id ?? null;
      });
    } catch (caught) {
      setLoadError(
        caught instanceof Error
          ? caught.message
          : "Failed to load feature catalog.",
      );
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const filteredFeatures = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return features.filter((feature) => {
      const minions = getFeatureMinions(feature);
      const workspaceDomains = getWorkspaceDomains(feature);

      if (filterKind === "available" && feature.state === "installed") {
        return false;
      }
      if (filterKind === "installed" && feature.state !== "installed") {
        return false;
      }
      if (filterKind === "minion" && minions.length === 0) {
        return false;
      }
      if (
        filterKind === "domains" &&
        workspaceDomains.length === 0 &&
        feature.skills.length === 0
      ) {
        return false;
      }

      if (!q) return true;
      const tools = feature.requires?.tools ?? [];
      return (
        feature.name.toLowerCase().includes(q) ||
        feature.id.toLowerCase().includes(q) ||
        feature.description.toLowerCase().includes(q) ||
        feature.domains.some((d) => d.toLowerCase().includes(q)) ||
        feature.skills.some((s) => s.toLowerCase().includes(q)) ||
        tools.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [features, searchQuery, filterKind]);

  const selectedFeature = useMemo(
    () =>
      features.find((f) => f.id === selectedFeatureId) ??
      filteredFeatures[0] ??
      null,
    [features, filteredFeatures, selectedFeatureId],
  );

  async function handleInstallFeature(featureId: string) {
    if (installingId) return;
    setInstallingId(featureId);
    setInstallError(null);
    try {
      const result = await api.installFeature({
        id: featureId,
        approve_policy: true,
      });
      setInstallResults((prev) => ({ ...prev, [featureId]: result }));
      setLatestInstallResult(result);
      setSelectedFeatureId(featureId);
      await loadCatalog();
      if (onFeatureInstalled) {
        await onFeatureInstalled(result);
      }
    } catch (caught) {
      setInstallError({
        featureId,
        ...formatInstallError(featureId, caught),
      });
    } finally {
      setInstallingId(null);
    }
  }

  const installedCount = useMemo(
    () => features.filter((f) => f.state === "installed").length,
    [features],
  );

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto bg-base-100 p-4 sm:p-6"
      data-testid="catalog-page"
    >
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between border-b border-base-content/10 pb-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">
                Feature &amp; Minion Catalog
              </h1>
              <span
                className="badge badge-sm badge-ghost font-mono"
                data-testid="catalog-summary-counts"
              >
                {installedCount} / {features.length} installed
              </span>
              {catalogProvenance && (
                <span
                  className="badge badge-sm badge-outline font-mono text-xs"
                  data-testid="catalog-provenance-badge"
                  title={`Source: ${catalogProvenance.source} (${catalogProvenance.mode})`}
                >
                  openlia/minions
                  {catalogProvenance.revision
                    ? `@${catalogProvenance.revision.slice(0, 7)}`
                    : ""}
                </span>
              )}
            </div>
            <p className="text-sm text-base-content/70 max-w-3xl">
              Discover and install curated feature packages from{" "}
              <code className="font-mono text-xs">openlia/minions</code>. A
              feature package may install a programmable{" "}
              <strong>Minion app</strong> (under{" "}
              <code className="font-mono text-xs">minions/</code>), structured{" "}
              <strong>workspace domains</strong> (templates &amp; schemas), and
              bundled <strong>assistant skills</strong>.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="btn btn-ghost btn-sm"
              disabled={loading}
              onClick={() => void loadCatalog()}
              type="button"
              data-testid="catalog-refresh-button"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Search & Filter Bar */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <input
              aria-label="Search catalog packages"
              className="input input-bordered input-sm w-full"
              data-testid="catalog-search-input"
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search packages, domains, skills, or tools (e.g. hledger)..."
              type="search"
              value={searchQuery}
            />
          </div>
          <fieldset
            className="flex flex-wrap items-center gap-1.5"
            aria-label="Filter catalog packages"
          >
            {(
              [
                { id: "all", label: "All Packages" },
                { id: "available", label: "Available" },
                { id: "installed", label: "Installed" },
                { id: "minion", label: "Minion Apps" },
                { id: "domains", label: "Domains & Skills" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                className={`btn btn-xs ${
                  filterKind === tab.id ? "btn-primary" : "btn-ghost"
                }`}
                data-testid={`catalog-filter-${tab.id}`}
                onClick={() => setFilterKind(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </fieldset>
        </div>

        {/* Error Banner */}
        {installError && (
          <div
            className="alert alert-error shadow-sm flex flex-col items-start gap-2 text-sm"
            data-testid="catalog-install-error"
            role="alert"
          >
            <div className="flex w-full items-start justify-between gap-2">
              <div>
                <h2 className="font-bold">{installError.title}</h2>
                <p className="text-xs mt-1">{installError.detail}</p>
              </div>
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => setInstallError(null)}
                type="button"
              >
                Dismiss
              </button>
            </div>
            {installError.cliCommand && (
              <div className="w-full rounded bg-base-100/20 p-2 font-mono text-xs">
                Run in terminal to update while preserving local state:{" "}
                <code data-testid="catalog-install-error-cli">
                  {installError.cliCommand}
                </code>
              </div>
            )}
          </div>
        )}

        {/* Latest Installation Result Banner */}
        {latestInstallResult && (
          <div
            className="rounded-xl border border-success/40 bg-success/10 p-4 space-y-3"
            data-testid="catalog-install-result"
            role="status"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="badge badge-success badge-sm">
                    Installed
                  </span>
                  <h2 className="font-bold text-sm">
                    Successfully installed package{" "}
                    <code className="font-mono">
                      {latestInstallResult.feature_id}
                    </code>
                  </h2>
                </div>
                <p className="text-xs text-base-content/70 mt-1">
                  All package templates, schemas, and assets have been added
                  non-destructively to your workspace.
                </p>
              </div>
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => setLatestInstallResult(null)}
                type="button"
              >
                Dismiss
              </button>
            </div>

            <div
              className="grid gap-3 sm:grid-cols-3 text-xs"
              data-testid={`catalog-install-result-${latestInstallResult.feature_id}`}
            >
              {/* Installed Minions */}
              <div className="rounded-lg border border-base-content/10 bg-base-100 p-3 space-y-1.5">
                <div className="font-semibold text-base-content/80">
                  Minion Apps ({latestInstallResult.minions?.length ?? 0})
                </div>
                {latestInstallResult.minions &&
                latestInstallResult.minions.length > 0 ? (
                  <ul className="space-y-1.5">
                    {latestInstallResult.minions.map((m) => (
                      <li
                        key={m.id}
                        className="flex flex-wrap items-center justify-between gap-1.5"
                      >
                        <code className="font-mono">minions/{m.id}</code>
                        <div className="flex items-center gap-1">
                          {m.configuration_required && (
                            <span
                              className="badge badge-warning badge-xs"
                              data-testid={`catalog-install-config-required-${m.id}`}
                            >
                              Config required
                            </span>
                          )}
                          {onOpenMinion && (
                            <button
                              className="btn btn-primary btn-xs"
                              data-testid={`catalog-open-installed-minion-${m.id}`}
                              onClick={() => onOpenMinion(m.id)}
                              type="button"
                            >
                              {m.configuration_required
                                ? "Configure Minion"
                                : "Open Minion"}
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-base-content/50">
                    None (domains &amp; skills package)
                  </p>
                )}
              </div>

              {/* Installed Workspace Domains */}
              <div className="rounded-lg border border-base-content/10 bg-base-100 p-3 space-y-1.5">
                <div className="font-semibold text-base-content/80">
                  Installed Domains (
                  {latestInstallResult.installed_domains.length})
                </div>
                {latestInstallResult.installed_domains.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {latestInstallResult.installed_domains.map((domain) => (
                      <span
                        key={domain}
                        className="badge badge-sm badge-outline font-mono"
                        data-testid={`catalog-installed-domain-${domain}`}
                      >
                        {domain}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-base-content/50">No workspace domains</p>
                )}
              </div>

              {/* Installed Skills */}
              <div className="rounded-lg border border-base-content/10 bg-base-100 p-3 space-y-1.5">
                <div className="font-semibold text-base-content/80">
                  Installed Skills (
                  {latestInstallResult.installed_skills.length})
                </div>
                {latestInstallResult.installed_skills.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {latestInstallResult.installed_skills.map((skillId) => (
                      <div key={skillId} className="flex items-center gap-1">
                        <span
                          className="badge badge-sm badge-secondary/20 text-secondary font-mono"
                          data-testid={`catalog-installed-skill-${skillId}`}
                        >
                          {skillId}
                        </span>
                        {onOpenSkill && (
                          <button
                            className="btn btn-ghost btn-xs"
                            data-testid={`catalog-open-installed-skill-${skillId}`}
                            onClick={() => onOpenSkill(skillId)}
                            type="button"
                          >
                            Open Skill
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-base-content/50">No bundled skills</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Main Content */}
        {loadError ? (
          <div
            className="alert alert-error flex items-center justify-between"
            data-testid="catalog-load-error"
          >
            <span>{loadError}</span>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => void loadCatalog()}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <div
            className="p-12 text-center text-sm text-base-content/60"
            data-testid="catalog-loading"
          >
            Loading feature catalog...
          </div>
        ) : filteredFeatures.length === 0 ? (
          <div
            className="rounded-xl border border-base-content/10 bg-base-200/30 p-8 text-center space-y-2"
            data-testid="catalog-empty"
          >
            <p className="font-semibold text-sm">
              No catalog packages match your filter.
            </p>
            <p className="text-xs text-base-content/60">
              Try clearing your search query or switching package filters.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] items-start">
            {/* Left Column: Package Cards */}
            <div className="space-y-3" data-testid="catalog-feature-list">
              {filteredFeatures.map((feature) => {
                const minions = getFeatureMinions(feature);
                const workspaceDomains = getWorkspaceDomains(feature);
                const isSelected = selectedFeature?.id === feature.id;
                const isInstalling = installingId === feature.id;
                const requiredTools = feature.requires?.tools ?? [];
                const requiredOpenlia =
                  feature.requires?.openlia ?? feature.requires_openlia;
                const packageKindLabel =
                  minions.length > 0
                    ? "Minion App Package"
                    : feature.skills.length > 0
                      ? "Domains & Skills Package"
                      : "Workspace Domains Package";

                return (
                  <article
                    key={feature.id}
                    className={`rounded-xl border p-4 transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-base-content/10 bg-base-100 hover:border-base-content/25"
                    }`}
                    data-testid={`catalog-feature-card-${feature.id}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            className="text-left font-bold text-base hover:underline focus:outline-none"
                            data-testid={`catalog-select-${feature.id}`}
                            onClick={() => setSelectedFeatureId(feature.id)}
                            type="button"
                          >
                            {feature.name}
                          </button>
                          <code className="text-xs font-mono text-base-content/60">
                            {feature.id}
                          </code>
                          <span className="badge badge-xs badge-ghost font-mono">
                            v{feature.version}
                          </span>
                          <span
                            className={`badge badge-xs ${
                              minions.length > 0
                                ? "badge-primary/20 text-primary"
                                : "badge-secondary/20 text-secondary"
                            }`}
                            data-testid={`catalog-package-kind-${feature.id}`}
                          >
                            {packageKindLabel}
                          </span>
                        </div>
                        <p className="text-xs text-base-content/70">
                          {feature.description}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`badge badge-sm ${
                            feature.state === "installed"
                              ? "badge-success"
                              : feature.state === "partial"
                                ? "badge-warning"
                                : "badge-ghost"
                          }`}
                          data-testid={`catalog-feature-status-${feature.id}`}
                        >
                          {feature.state === "installed"
                            ? "Installed"
                            : feature.state === "partial"
                              ? "Partially Installed"
                              : "Available"}
                        </span>

                        <button
                          className={`btn btn-sm ${
                            feature.state === "installed"
                              ? "btn-outline btn-success"
                              : "btn-primary"
                          }`}
                          data-testid={`catalog-install-${feature.id}`}
                          disabled={
                            Boolean(installingId) ||
                            feature.state === "installed"
                          }
                          onClick={() => void handleInstallFeature(feature.id)}
                          type="button"
                        >
                          {isInstalling
                            ? "Installing..."
                            : feature.state === "installed"
                              ? "Installed"
                              : feature.state === "partial"
                                ? "Complete Install"
                                : "Install"}
                        </button>
                      </div>
                    </div>

                    {/* Summary Pills: Contents & Requirements */}
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                      {minions.map((minionId) => (
                        <span
                          key={minionId}
                          className="badge badge-sm badge-outline font-mono"
                          data-testid={`catalog-card-minion-${feature.id}-${minionId}`}
                        >
                          Minion: minions/{minionId}
                        </span>
                      ))}
                      {workspaceDomains.length > 0 && (
                        <span
                          className="badge badge-sm badge-ghost font-mono"
                          data-testid={`catalog-card-domains-count-${feature.id}`}
                        >
                          {workspaceDomains.length}{" "}
                          {workspaceDomains.length === 1 ? "domain" : "domains"}
                        </span>
                      )}
                      {feature.skills.map((skillId) => (
                        <span
                          key={skillId}
                          className="badge badge-sm badge-ghost font-mono"
                          data-testid={`catalog-card-skill-${feature.id}-${skillId}`}
                        >
                          Skill: {skillId}
                        </span>
                      ))}
                      {requiredOpenlia && (
                        <span
                          className="badge badge-sm badge-ghost font-mono"
                          title="Required OpenLia runtime version"
                        >
                          openlia {requiredOpenlia}
                        </span>
                      )}
                      {requiredTools.map((tool) => (
                        <span
                          key={tool}
                          className="badge badge-sm badge-warning/20 text-warning-content border-warning/40 font-mono"
                          data-testid={`catalog-required-tool-${feature.id}-${tool}`}
                          title={`Requires CLI tool: ${tool}`}
                        >
                          requires tool: {tool}
                        </span>
                      ))}
                    </div>

                    {/* Quick links when installed */}
                    {feature.state === "installed" && (
                      <div className="mt-3 pt-2.5 border-t border-base-content/10 flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-base-content/60 font-medium">
                          Installed artifacts:
                        </span>
                        {minions.map((minionId) => {
                          const installMinionStatus = installResults[
                            feature.id
                          ]?.minions?.find((m) => m.id === minionId);
                          return (
                            <span
                              key={minionId}
                              className="inline-flex items-center gap-1"
                            >
                              {onOpenMinion ? (
                                <button
                                  className="btn btn-xs btn-outline font-mono"
                                  data-testid={`catalog-card-open-minion-${minionId}`}
                                  onClick={() => onOpenMinion(minionId)}
                                  type="button"
                                >
                                  Open minions/{minionId}
                                </button>
                              ) : (
                                <code className="font-mono">
                                  minions/{minionId}
                                </code>
                              )}
                              {installMinionStatus?.configuration_required && (
                                <span className="badge badge-warning badge-xs">
                                  Config required
                                </span>
                              )}
                            </span>
                          );
                        })}
                        {workspaceDomains.map((domainPath) =>
                          onOpenDomain ? (
                            <button
                              key={domainPath}
                              className="btn btn-xs btn-ghost font-mono"
                              data-testid={`catalog-card-open-domain-${domainPath}`}
                              onClick={() => onOpenDomain(domainPath)}
                              type="button"
                            >
                              {domainPath}
                            </button>
                          ) : (
                            <code
                              key={domainPath}
                              className="badge badge-xs badge-ghost font-mono"
                            >
                              {domainPath}
                            </code>
                          ),
                        )}
                        {feature.skills.map((skillId) =>
                          onOpenSkill ? (
                            <button
                              key={skillId}
                              className="btn btn-xs btn-outline font-mono"
                              data-testid={`catalog-card-open-skill-${skillId}`}
                              onClick={() => onOpenSkill(skillId)}
                              type="button"
                            >
                              Skill: {skillId}
                            </button>
                          ) : (
                            <code
                              key={skillId}
                              className="badge badge-xs badge-ghost font-mono"
                            >
                              Skill: {skillId}
                            </code>
                          ),
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

            {/* Right Column: Selected Package Review & Details */}
            {selectedFeature && (
              <aside
                aria-label="Selected package details"
                className="rounded-xl border border-base-content/15 bg-base-200/30 p-5 space-y-5 sticky top-4"
                data-testid="catalog-detail-panel"
              >
                {(() => {
                  const minions = getFeatureMinions(selectedFeature);
                  const workspaceDomains = getWorkspaceDomains(selectedFeature);
                  const requiredOpenlia =
                    selectedFeature.requires?.openlia ??
                    selectedFeature.requires_openlia;
                  const requiredTools = selectedFeature.requires?.tools ?? [];
                  const requiredCoreDomains =
                    selectedFeature.requires?.core_domains ?? [];
                  const requiredFeatures =
                    selectedFeature.requires?.features ?? [];
                  const isInstalling = installingId === selectedFeature.id;

                  return (
                    <>
                      <div className="space-y-2 border-b border-base-content/10 pb-4">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <h2
                              className="text-lg font-bold"
                              data-testid="catalog-detail-title"
                            >
                              {selectedFeature.name}
                            </h2>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-base-content/60 font-mono mt-0.5">
                              <span>id: {selectedFeature.id}</span>
                              <span>•</span>
                              <span>v{selectedFeature.version}</span>
                              {selectedFeature.author && (
                                <>
                                  <span>•</span>
                                  <span>by {selectedFeature.author}</span>
                                </>
                              )}
                              {selectedFeature.license && (
                                <>
                                  <span>•</span>
                                  <span>{selectedFeature.license}</span>
                                </>
                              )}
                            </div>
                          </div>
                          <span
                            className={`badge badge-sm ${
                              selectedFeature.state === "installed"
                                ? "badge-success"
                                : selectedFeature.state === "partial"
                                  ? "badge-warning"
                                  : "badge-ghost"
                            }`}
                          >
                            {selectedFeature.state}
                          </span>
                        </div>
                        <p className="text-sm text-base-content/80">
                          {selectedFeature.description}
                        </p>
                      </div>

                      {/* Package Architecture Distinction */}
                      <div className="rounded-lg border border-base-content/10 bg-base-100 p-3 text-xs space-y-1">
                        <div className="font-semibold">
                          Package Type:{" "}
                          {minions.length > 0
                            ? "Standalone Minion App Package"
                            : "Workspace Domains & Skills Package"}
                        </div>
                        <p className="text-base-content/70">
                          {minions.length > 0
                            ? "This feature installs an interactive Minion app under minions/ with its own dashboard, input schema, and execution entrypoints. Automatic triggers remain disabled until configured."
                            : "This feature installs structured workspace document domains (templates & schemas) and assistant skills. It does not install a standalone Minion app."}
                        </p>
                      </div>

                      {/* Declared Requirements */}
                      <div
                        className="space-y-2"
                        data-testid="catalog-detail-requirements"
                      >
                        <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/60">
                          Declared Requirements
                        </h3>
                        <div className="rounded-lg border border-base-content/10 bg-base-100 p-3 space-y-2 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="text-base-content/70">
                              OpenLia Runtime
                            </span>
                            <code className="font-mono font-semibold">
                              {requiredOpenlia ?? "Any"}
                            </code>
                          </div>
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-base-content/70">
                              Required System Tools
                            </span>
                            {requiredTools.length > 0 ? (
                              <div className="flex flex-wrap gap-1 justify-end">
                                {requiredTools.map((tool) => (
                                  <span
                                    key={tool}
                                    className="badge badge-xs badge-warning font-mono"
                                    data-testid={`catalog-detail-tool-${tool}`}
                                  >
                                    {tool}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-base-content/50">None</span>
                            )}
                          </div>
                          {requiredCoreDomains.length > 0 && (
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-base-content/70">
                                Core Domains
                              </span>
                              <div className="flex flex-wrap gap-1 justify-end">
                                {requiredCoreDomains.map((cd) => (
                                  <span
                                    key={cd}
                                    className="badge badge-xs badge-ghost font-mono"
                                  >
                                    {cd}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {requiredFeatures.length > 0 && (
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-base-content/70">
                                Feature Dependencies
                              </span>
                              <div className="flex flex-wrap gap-1 justify-end">
                                {requiredFeatures.map((dep) => (
                                  <span
                                    key={dep}
                                    className="badge badge-xs badge-outline font-mono"
                                  >
                                    {dep}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Package Contents */}
                      <div
                        className="space-y-3"
                        data-testid="catalog-detail-contents"
                      >
                        <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/60">
                          Package Contents
                        </h3>

                        {/* Minion Apps */}
                        {minions.length > 0 && (
                          <div className="rounded-lg border border-base-content/10 bg-base-100 p-3 space-y-2 text-xs">
                            <div className="font-semibold">
                              Minion Apps ({minions.length})
                            </div>
                            <ul className="space-y-1.5">
                              {minions.map((minionId) => (
                                <li
                                  key={minionId}
                                  className="flex items-center justify-between gap-2"
                                >
                                  <code className="font-mono">
                                    minions/{minionId}
                                  </code>
                                  {selectedFeature.state === "installed" &&
                                    onOpenMinion && (
                                      <button
                                        className="btn btn-xs btn-primary"
                                        onClick={() => onOpenMinion(minionId)}
                                        type="button"
                                      >
                                        Open in Minions
                                      </button>
                                    )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Workspace Domains */}
                        {workspaceDomains.length > 0 && (
                          <div className="rounded-lg border border-base-content/10 bg-base-100 p-3 space-y-2 text-xs">
                            <div className="font-semibold">
                              Workspace Domains ({workspaceDomains.length})
                            </div>
                            <ul className="space-y-2">
                              {workspaceDomains.map((domainPath) => {
                                const detail =
                                  selectedFeature.domain_details?.find(
                                    (d) => d.path === domainPath,
                                  );
                                return (
                                  <li
                                    key={domainPath}
                                    className="flex items-start justify-between gap-2 border-b border-base-content/5 pb-1.5 last:border-b-0 last:pb-0"
                                  >
                                    <div>
                                      <code className="font-mono font-semibold">
                                        {domainPath}
                                      </code>
                                      {detail?.purpose && (
                                        <p className="text-base-content/60 mt-0.5">
                                          {detail.purpose}
                                        </p>
                                      )}
                                    </div>
                                    {selectedFeature.state === "installed" &&
                                      onOpenDomain && (
                                        <button
                                          className="btn btn-xs btn-ghost shrink-0"
                                          onClick={() =>
                                            onOpenDomain(domainPath)
                                          }
                                          type="button"
                                        >
                                          Browse
                                        </button>
                                      )}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}

                        {/* Bundled Skills */}
                        {selectedFeature.skills.length > 0 && (
                          <div className="rounded-lg border border-base-content/10 bg-base-100 p-3 space-y-2 text-xs">
                            <div className="font-semibold">
                              Bundled Skills ({selectedFeature.skills.length})
                            </div>
                            <ul className="space-y-1.5">
                              {selectedFeature.skills.map((skillId) => (
                                <li
                                  key={skillId}
                                  className="flex items-center justify-between gap-2"
                                >
                                  <code className="font-mono">{skillId}</code>
                                  {selectedFeature.state === "installed" &&
                                    onOpenSkill && (
                                      <button
                                        className="btn btn-xs btn-outline"
                                        onClick={() => onOpenSkill(skillId)}
                                        type="button"
                                      >
                                        Open in Skills
                                      </button>
                                    )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>

                      {/* Install Action Footer */}
                      <div className="pt-2 border-t border-base-content/10 flex flex-col gap-2">
                        <button
                          className={`btn btn-sm w-full ${
                            selectedFeature.state === "installed"
                              ? "btn-outline btn-success"
                              : "btn-primary"
                          }`}
                          data-testid="catalog-detail-install-button"
                          disabled={
                            Boolean(installingId) ||
                            selectedFeature.state === "installed"
                          }
                          onClick={() =>
                            void handleInstallFeature(selectedFeature.id)
                          }
                          type="button"
                        >
                          {isInstalling
                            ? `Installing ${selectedFeature.name}...`
                            : selectedFeature.state === "installed"
                              ? `${selectedFeature.name} is Installed`
                              : `Install ${selectedFeature.name}`}
                        </button>
                        {selectedFeature.state === "installed" && (
                          <p className="text-[11px] text-base-content/60 text-center">
                            Already installed in this workspace. To sync or
                            rebase upstream template updates without losing
                            local edits, run{" "}
                            <code className="font-mono">
                              openlia feature install {selectedFeature.id}
                            </code>{" "}
                            in the CLI.
                          </p>
                        )}
                      </div>
                    </>
                  );
                })()}
              </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

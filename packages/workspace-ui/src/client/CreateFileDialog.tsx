import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  WorkspaceDomainInfo,
  WorkspaceDomainRecordsResponse,
  WorkspaceStarterTemplate,
} from "../shared/api";
import { getBuiltinDomainContract } from "../shared/domainContracts";
import type { WorkspaceApi } from "./api";
import {
  type RelationshipOption,
  SchemaRecordForm,
} from "./components/editor/SchemaRecordForm";

export interface CreateFileOptions {
  starter_id?: string | undefined;
  title?: string | undefined;
  frontmatter?: Record<string, unknown> | undefined;
  sections?: Record<string, string> | undefined;
}

export interface CreateFileDialogProps {
  api?: WorkspaceApi | undefined;
  availableDomains: WorkspaceDomainInfo[];
  error?: string | undefined;
  existingPaths?: Set<string> | undefined;
  initialDomain?: string | undefined;
  isCreating: boolean;
  isOpen: boolean;
  onCancel: () => void;
  onCreate: (
    domain: string,
    filename: string,
    options?: CreateFileOptions,
  ) => void;
}

function slugifyTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildFallbackRelationshipOptions(existingPaths?: Set<string>): {
  linked_project: RelationshipOption[];
  linked_goal: RelationshipOption[];
  linked_area: RelationshipOption[];
} {
  const result = {
    linked_project: [] as RelationshipOption[],
    linked_goal: [] as RelationshipOption[],
    linked_area: [] as RelationshipOption[],
  };
  if (!existingPaths) return result;

  for (const p of existingPaths) {
    if (!p.endsWith(".md") || p.endsWith("-template.md")) continue;
    const baseName = (p.split("/").at(-1) ?? p).replace(/\.md$/i, "");
    if (p.startsWith("knowledge/") || p.startsWith("projects/")) {
      result.linked_project.push({ path: p, title: baseName });
    } else if (p.startsWith("goals/")) {
      result.linked_goal.push({ path: p, title: baseName });
    } else if (p.startsWith("areas/")) {
      result.linked_area.push({ path: p, title: baseName });
    }
  }
  return result;
}

export function CreateFileDialog({
  api,
  availableDomains,
  error,
  existingPaths,
  initialDomain,
  isCreating,
  isOpen,
  onCancel,
  onCreate,
}: CreateFileDialogProps) {
  const domainId = useId();
  const starterSelectId = useId();
  const titleId = useId();
  const nameId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const defaultDomain = useMemo(() => {
    if (
      initialDomain &&
      availableDomains.some((d) => d.path === initialDomain)
    ) {
      return initialDomain;
    }
    return availableDomains[0]?.path ?? "tasks";
  }, [availableDomains, initialDomain]);

  const [selectedDomain, setSelectedDomain] = useState(defaultDomain);
  const [fileName, setFileName] = useState("");
  const [fileNameManuallyEdited, setFileNameManuallyEdited] = useState(false);
  const [recordTitle, setRecordTitle] = useState("");
  const [validationError, setValidationError] = useState("");
  const [hasCustomizedForm, setHasCustomizedForm] = useState(false);

  const builtinContract = useMemo(
    () => getBuiltinDomainContract(selectedDomain),
    [selectedDomain],
  );

  const [loadedOverview, setLoadedOverview] =
    useState<WorkspaceDomainRecordsResponse | null>(null);
  const [starterId, setStarterId] = useState<string>("");
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({});
  const [sections, setSections] = useState<Record<string, string>>({});

  const fallbackRelOptions = useMemo(
    () => buildFallbackRelationshipOptions(existingPaths),
    [existingPaths],
  );
  const [relationshipOptions, setRelationshipOptions] =
    useState(fallbackRelOptions);

  const starterTemplates: WorkspaceStarterTemplate[] = useMemo(
    () =>
      loadedOverview?.starter_templates ??
      builtinContract?.starter_templates ??
      [],
    [loadedOverview, builtinContract],
  );

  const activeStarter = useMemo(
    () =>
      starterTemplates.find((s) => s.id === starterId) ?? starterTemplates[0],
    [starterTemplates, starterId],
  );

  const initializeContractState = useCallback(
    (
      domainPath: string,
      overview: WorkspaceDomainRecordsResponse | null,
      explicitStarterId?: string,
    ) => {
      const builtin = getBuiltinDomainContract(domainPath);
      const starters =
        overview?.starter_templates ?? builtin?.starter_templates ?? [];
      const chosenStarter =
        (explicitStarterId
          ? starters.find((s) => s.id === explicitStarterId)
          : undefined) ?? starters[0];

      setStarterId(chosenStarter?.id ?? "");
      setFrontmatter({
        ...(builtin?.template_defaults ?? {}),
        ...(overview?.template_defaults ?? {}),
        ...(chosenStarter?.template_defaults ?? {}),
      });
      setSections({
        ...(builtin?.template_sections ?? {}),
        ...(overview?.template_sections ?? {}),
        ...(chosenStarter?.template_sections ?? {}),
      });
    },
    [],
  );

  useEffect(() => {
    if (isOpen) {
      setSelectedDomain(defaultDomain);
      setFileName("");
      setFileNameManuallyEdited(false);
      setRecordTitle("");
      setValidationError("");
      setHasCustomizedForm(false);
      setLoadedOverview(null);
      initializeContractState(defaultDomain, null);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }
  }, [isOpen, defaultDomain, initializeContractState]);

  useEffect(() => {
    if (!isOpen) return;
    initializeContractState(selectedDomain, null);
    if (!api) return;

    let cancelled = false;
    api
      .loadDomainOverview(selectedDomain)
      .then((res) => {
        if (cancelled) return;
        setLoadedOverview(res);
        setFrontmatter((prev) => ({
          ...(res.template_defaults ?? {}),
          ...prev,
        }));
        setSections((prev) => ({
          ...(res.template_sections ?? {}),
          ...prev,
        }));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [api, isOpen, selectedDomain, initializeContractState]);

  useEffect(() => {
    setRelationshipOptions(fallbackRelOptions);
    if (!isOpen || !api) return;

    let cancelled = false;
    Promise.all([
      api.loadDomainOverview("knowledge").catch(() => null),
      api.loadDomainOverview("goals").catch(() => null),
      api.loadDomainOverview("areas").catch(() => null),
    ]).then(([knowledgeRes, goalsRes, areasRes]) => {
      if (cancelled) return;
      const mergeOpts = (
        fallback: RelationshipOption[],
        res: WorkspaceDomainRecordsResponse | null,
      ): RelationshipOption[] => {
        const map = new Map<string, RelationshipOption>();
        for (const item of fallback) map.set(item.path, item);
        for (const rec of res?.records ?? []) {
          map.set(rec.path, { path: rec.path, title: rec.title });
        }
        return Array.from(map.values());
      };
      setRelationshipOptions({
        linked_project: mergeOpts(
          fallbackRelOptions.linked_project,
          knowledgeRes,
        ),
        linked_goal: mergeOpts(fallbackRelOptions.linked_goal, goalsRes),
        linked_area: mergeOpts(fallbackRelOptions.linked_area, areasRes),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [api, isOpen, fallbackRelOptions]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }
    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const activeDomainInfo = availableDomains.find(
    (d) => d.path === selectedDomain,
  );

  const activeSchemaJson =
    activeStarter?.schema_json ??
    loadedOverview?.schema_json ??
    builtinContract?.schema_json;

  const activeSectionHeadings =
    activeStarter?.template_headings ??
    loadedOverview?.template_headings ??
    builtinContract?.template_headings ??
    [];

  const allowNestedSubfolders = selectedDomain === "knowledge";
  const cleanName = fileName.trim().replace(/^\/+/, "");
  const normalizedFileName = cleanName
    ? cleanName.toLowerCase().endsWith(".md")
      ? cleanName
      : `${cleanName}.md`
    : "";
  const previewPath = normalizedFileName
    ? `${selectedDomain}/${normalizedFileName}`
    : `${selectedDomain}/...`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cleanName) {
      setValidationError("File name cannot be empty");
      return;
    }
    if (
      (!allowNestedSubfolders && cleanName.includes("/")) ||
      cleanName.includes("\\") ||
      cleanName.includes("..")
    ) {
      setValidationError("File name cannot contain path separators");
      return;
    }
    if (
      cleanName.endsWith("-template.md") ||
      cleanName.endsWith(".schema.json")
    ) {
      setValidationError("Cannot create a template or schema file directly");
      return;
    }
    if (existingPaths?.has(`${selectedDomain}/${normalizedFileName}`)) {
      setValidationError(
        `File "${normalizedFileName}" already exists in ${selectedDomain}`,
      );
      return;
    }

    setValidationError("");
    if (hasCustomizedForm || starterTemplates.length > 0) {
      onCreate(selectedDomain, normalizedFileName, {
        starter_id: activeStarter?.id || undefined,
        title: recordTitle.trim() || undefined,
        frontmatter,
        sections,
      });
    } else {
      onCreate(selectedDomain, normalizedFileName);
    }
  };

  const displayedError = validationError || error;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 overflow-y-auto"
      role="presentation"
    >
      <section
        aria-labelledby="create-file-dialog-title"
        aria-modal="true"
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-base-content/10 bg-base-100 p-6 shadow-2xl space-y-4"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              className="text-base font-semibold"
              id="create-file-dialog-title"
            >
              Create New File
            </h2>
            <p className="mt-1 text-xs text-base-content/60">
              Create a record initialized with this domain's template schema.
            </p>
          </div>
          <button
            aria-label="Close"
            className="btn btn-ghost btn-xs btn-square"
            onClick={onCancel}
            type="button"
          >
            ✕
          </button>
        </div>

        {displayedError && (
          <div
            className="alert alert-error text-xs p-3 rounded-lg"
            role="alert"
          >
            <span>{displayedError}</span>
          </div>
        )}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold" htmlFor={domainId}>
                Domain
              </label>
              <select
                className="select select-bordered select-sm mt-1 w-full"
                disabled={isCreating}
                id={domainId}
                onChange={(e) => {
                  const nextDomain = e.target.value;
                  setSelectedDomain(nextDomain);
                  setLoadedOverview(null);
                  initializeContractState(nextDomain, null);
                  setValidationError("");
                }}
                value={selectedDomain}
              >
                {availableDomains.map((domain) => (
                  <option key={domain.path} value={domain.path}>
                    {domain.label} ({domain.path}/)
                  </option>
                ))}
              </select>
              {activeDomainInfo?.purpose && (
                <p className="mt-1 text-[11px] text-base-content/50">
                  {activeDomainInfo.purpose}
                </p>
              )}
            </div>

            {starterTemplates.length > 0 && (
              <div>
                <label
                  className="text-xs font-semibold"
                  htmlFor={starterSelectId}
                >
                  Starter Scaffold
                </label>
                <select
                  aria-label="Starter Scaffold"
                  className="select select-bordered select-sm mt-1 w-full"
                  disabled={isCreating}
                  id={starterSelectId}
                  onChange={(e) => {
                    const nextStarterId = e.target.value;
                    setHasCustomizedForm(true);
                    initializeContractState(
                      selectedDomain,
                      loadedOverview,
                      nextStarterId,
                    );
                  }}
                  value={activeStarter?.id ?? ""}
                >
                  {starterTemplates.map((starter) => (
                    <option key={starter.id} value={starter.id}>
                      {starter.label}
                    </option>
                  ))}
                </select>
                {activeStarter && (
                  <p className="mt-1 text-[11px] text-base-content/50">
                    {activeStarter.description}
                  </p>
                )}
              </div>
            )}
          </div>

          {selectedDomain === "calendar" && (
            <p className="text-xs">
              This creates an event note, not a scheduled appointment.{" "}
              <a
                className="link link-primary"
                href="/projects/calendar"
                target="_blank"
                rel="noreferrer"
              >
                Open Calendar in a new tab to create an appointment
              </a>
              .
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold" htmlFor={nameId}>
                File Name
              </label>
              <input
                ref={inputRef}
                className="input input-bordered input-sm mt-1 w-full font-mono"
                disabled={isCreating}
                id={nameId}
                onChange={(e) => {
                  setFileName(e.target.value);
                  setFileNameManuallyEdited(true);
                  setValidationError("");
                }}
                placeholder={
                  allowNestedSubfolders
                    ? "e.g. project-apollo.md or projects/project-apollo.md"
                    : "e.g. quarterly-review"
                }
                type="text"
                value={fileName}
              />
            </div>

            <div>
              <label className="text-xs font-semibold" htmlFor={titleId}>
                Record Title
              </label>
              <input
                aria-label="Record Title"
                className="input input-bordered input-sm mt-1 w-full"
                disabled={isCreating}
                id={titleId}
                onChange={(e) => {
                  const nextTitle = e.target.value;
                  setRecordTitle(nextTitle);
                  setHasCustomizedForm(true);
                  if (!fileNameManuallyEdited) {
                    setFileName(slugifyTitle(nextTitle));
                  }
                  setValidationError("");
                }}
                placeholder="e.g. Project Apollo"
                type="text"
                value={recordTitle}
              />
            </div>
          </div>

          <div className="rounded-lg border border-base-content/10 bg-base-200/50 p-3 text-xs space-y-1">
            <div className="text-base-content/60 font-medium">Target Path:</div>
            <code className="block text-primary font-mono text-[11px] truncate">
              {previewPath}
            </code>
            {activeDomainInfo?.template_path && (
              <div className="text-[11px] text-base-content/50">
                Template:{" "}
                <span className="font-mono">
                  {activeDomainInfo.template_path}
                </span>
              </div>
            )}
          </div>

          <SchemaRecordForm
            compact
            disabled={isCreating}
            frontmatter={frontmatter}
            onFrontmatterChange={(key, value) => {
              setHasCustomizedForm(true);
              setFrontmatter((prev) => ({ ...prev, [key]: value }));
            }}
            onSectionChange={(heading, content) => {
              setHasCustomizedForm(true);
              setSections((prev) => ({ ...prev, [heading]: content }));
            }}
            relationshipOptions={relationshipOptions}
            schemaJson={activeSchemaJson}
            schemaPath={
              activeDomainInfo?.schema_path ??
              loadedOverview?.domain?.schema_path
            }
            sectionHeadings={activeSectionHeadings}
            sections={sections}
            starterLabel={activeStarter?.label}
            templatePath={
              activeDomainInfo?.template_path ??
              loadedOverview?.domain?.template_path
            }
          />

          <div className="flex justify-end gap-2 pt-2">
            <button
              className="btn btn-ghost btn-sm"
              disabled={isCreating}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={isCreating || !cleanName}
              type="submit"
            >
              {isCreating ? "Creating..." : "Create File"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

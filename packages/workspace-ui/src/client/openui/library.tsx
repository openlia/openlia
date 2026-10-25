import {
  defineAction,
  defineComponent,
  defineFunction,
} from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui";
import { useState } from "react";
import { z } from "zod";
import type { WorkspaceDomainRecordSummary } from "../../shared/api";
import { projectOpenUIProps } from "../../shared/project";
import { FinanceOverview } from "./FinanceOverview";
import { useOpenLiaOpenUI } from "./context";

export interface OpenLiaRuntimeData {
  records: WorkspaceDomainRecordSummary[];
  queries?: Record<string, unknown> | undefined;
}

let activeRuntimeData: OpenLiaRuntimeData = {
  records: [],
  queries: {},
};

export function setActiveOpenUIData(data: OpenLiaRuntimeData): void {
  activeRuntimeData = data;
}

function getFieldVal(
  record: WorkspaceDomainRecordSummary,
  field: string,
): unknown {
  if (field === "title") return record.title;
  if (field === "filename") return record.filename;
  if (field === "path") return record.path;
  return record.frontmatter?.[field];
}

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected === undefined || expected === null) {
    return actual !== undefined && actual !== null && actual !== "";
  }
  if (Array.isArray(expected)) {
    return expected.some((item) => matchesValue(actual, item));
  }
  if (Array.isArray(actual)) {
    return actual.some(
      (item) => String(item).toLowerCase() === String(expected).toLowerCase(),
    );
  }
  if (actual === undefined || actual === null) return false;
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

export function evaluateCountBy(
  records: WorkspaceDomainRecordSummary[],
  field: string,
  value?: unknown,
): number {
  if (!field) return records.length;
  return records.filter((r) => matchesValue(getFieldVal(r, field), value))
    .length;
}

export function evaluateGroupCount(
  records: WorkspaceDomainRecordSummary[],
  field: string,
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of records) {
    const val = getFieldVal(r, field);
    if (Array.isArray(val)) {
      for (const item of val) {
        const key = String(item || "unspecified");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    } else {
      const key =
        val !== undefined && val !== null && val !== ""
          ? String(val)
          : "unspecified";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries()).map(([label, count]) => ({
    label,
    count,
  }));
}

export function evaluateFilterRecords(
  records: WorkspaceDomainRecordSummary[],
  field: string,
  value?: unknown,
): WorkspaceDomainRecordSummary[] {
  if (!field) return records;
  return records.filter((r) => matchesValue(getFieldVal(r, field), value));
}

export function evaluateSumBy(
  records: WorkspaceDomainRecordSummary[],
  field: string,
): number {
  let total = 0;
  for (const r of records) {
    const num = Number(getFieldVal(r, field));
    if (Number.isFinite(num)) total += num;
  }
  return total;
}

// --- Components ---

export const Grid = defineComponent({
  name: "Grid",
  description:
    "Responsive multi-column grid layout for metric cards and widgets",
  props: projectOpenUIProps.Grid,
  component: ({ props, renderNode }) => {
    const cols = props.columns ?? 3;
    const colClass =
      cols === 1
        ? "grid-cols-1"
        : cols === 2
          ? "grid-cols-1 sm:grid-cols-2"
          : cols === 4
            ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
            : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
    return (
      <div className={`grid gap-3 ${colClass}`}>
        {renderNode(props.children)}
      </div>
    );
  },
});

export const DomainHeader = defineComponent({
  name: "DomainHeader",
  description:
    "Project overview header with title, description, and record count",
  props: projectOpenUIProps.DomainHeader,
  component: ({ props }) => {
    const { title, description, recordCount } = props;
    const {
      project,
      domainPath,
      domainInfo,
      records = [],
      onCreateRecord,
    } = useOpenLiaOpenUI();
    const count =
      recordCount ??
      project?.record_count ??
      domainInfo?.record_count ??
      records.length;
    const desc = description ?? project?.description ?? domainInfo?.purpose;

    return (
      <div className="flex flex-col gap-2 rounded-xl border border-base-content/10 bg-base-100 p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold tracking-tight text-base-content">
              {title}
            </h2>
            <span className="badge badge-neutral badge-sm font-mono">
              {count} {count === 1 ? "record" : "records"}
            </span>
          </div>
          {onCreateRecord && (
            <button
              className="btn btn-primary btn-xs font-medium"
              onClick={() =>
                onCreateRecord(project?.path ?? domainPath ?? domainInfo?.path)
              }
              type="button"
            >
              + New Record
            </button>
          )}
        </div>
        {desc && (
          <p className="text-sm text-base-content/70 leading-relaxed max-w-3xl">
            {desc}
          </p>
        )}
      </div>
    );
  },
});

export const MetricCard = defineComponent({
  name: "MetricCard",
  description: "Single KPI metric card displaying a headline number and label",
  props: projectOpenUIProps.MetricCard,
  component: ({ props }) => {
    const { label, value, subtext, tone = "neutral" } = props;
    const toneClasses: Record<string, string> = {
      neutral: "border-base-content/10",
      primary: "border-primary/40 bg-primary/5",
      success: "border-success/40 bg-success/5",
      warning: "border-warning/40 bg-warning/5",
      error: "border-error/40 bg-error/5",
    };

    const valueTone: Record<string, string> = {
      neutral: "text-base-content",
      primary: "text-primary",
      success: "text-success",
      warning: "text-warning",
      error: "text-error",
    };

    const selectedToneClass =
      toneClasses[tone ?? "neutral"] ?? toneClasses.neutral;
    const selectedValueTone = valueTone[tone ?? "neutral"] ?? valueTone.neutral;

    return (
      <div
        className={`flex flex-col justify-between rounded-xl border p-4 shadow-xs bg-base-100 ${selectedToneClass}`}
      >
        <span className="text-xs font-medium uppercase tracking-wider text-base-content/60">
          {label}
        </span>
        <div className="my-1">
          <span
            className={`text-2xl font-bold tracking-tight ${selectedValueTone}`}
          >
            {value}
          </span>
        </div>
        {subtext && (
          <span className="text-xs text-base-content/50">{subtext}</span>
        )}
      </div>
    );
  },
});

export const RecordKanban = defineComponent({
  name: "RecordKanban",
  description:
    "Interactive Kanban board grouping project records by a frontmatter enum field",
  props: projectOpenUIProps.RecordKanban,
  component: ({ props }) => {
    const { groupBy = "status", columns, title } = props;
    const {
      records = [],
      manifest,
      onOpenRecord,
      onUpdateRecordFrontmatter,
    } = useOpenLiaOpenUI();

    const editableFields = new Set(
      manifest?.logic?.mutations?.editable_fields ?? ["status"],
    );
    const canMutateGroup =
      Boolean(onUpdateRecordFrontmatter) && editableFields.has(groupBy);

    const discoveredKeys = Array.from(
      new Set(
        records.map((r) => {
          const val = r.frontmatter?.[groupBy];
          return val !== undefined && val !== null && val !== ""
            ? String(val)
            : "unspecified";
        }),
      ),
    );

    const cols = columns && columns.length > 0 ? columns : discoveredKeys;
    const [error, setError] = useState("");
    const [updatingPath, setUpdatingPath] = useState<string | null>(null);

    return (
      <div className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
        {title && (
          <h3 className="text-sm font-semibold uppercase tracking-wider text-base-content/70">
            {title}
          </h3>
        )}
        <div className="flex gap-4 overflow-x-auto pb-4 pt-1">
          {cols.map((colKey) => {
            const colRecords = records.filter((r) => {
              const val = r.frontmatter?.[groupBy];
              const normalized =
                val !== undefined && val !== null && val !== ""
                  ? String(val).toLowerCase()
                  : "unspecified";
              return normalized === colKey.toLowerCase();
            });

            return (
              <div
                key={colKey}
                className="flex flex-col min-w-[250px] max-w-[320px] flex-1 rounded-xl border border-base-content/10 bg-base-200/40 p-3"
              >
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-base-content/80">
                    {colKey}
                  </span>
                  <span className="badge badge-sm badge-ghost font-mono">
                    {colRecords.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2 min-h-[88px]">
                  {colRecords.length === 0 ? (
                    <div className="grid h-20 place-items-center rounded-lg border border-dashed border-base-content/15 text-xs italic text-base-content/40">
                      Empty
                    </div>
                  ) : (
                    colRecords.map((r) => (
                      // biome-ignore lint/a11y/useSemanticElements: Kanban card contains nested quick-action buttons
                      <div
                        key={r.path}
                        role="button"
                        tabIndex={0}
                        className="group flex flex-col gap-2 rounded-lg border border-base-content/10 bg-base-100 p-3 shadow-xs hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer text-left w-full"
                        onClick={() => onOpenRecord?.(r.path)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onOpenRecord?.(r.path);
                          }
                        }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm font-medium text-base-content group-hover:text-primary transition-colors line-clamp-2">
                            {r.title || r.filename}
                          </span>
                          {r.validation && !r.validation.valid && (
                            <span
                              className="badge badge-error badge-xs"
                              title={
                                r.validation.errors?.join("; ") || "Invalid"
                              }
                            >
                              !
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          {Boolean(r.frontmatter?.priority) && (
                            <span className="badge badge-outline badge-xs font-medium">
                              {String(r.frontmatter.priority)}
                            </span>
                          )}
                          {Boolean(
                            r.frontmatter?.due ??
                              r.frontmatter?.due_date ??
                              r.frontmatter?.target_date,
                          ) && (
                            <span className="text-[11px] text-base-content/60 font-mono">
                              {String(
                                r.frontmatter?.due ??
                                  r.frontmatter?.due_date ??
                                  r.frontmatter?.target_date,
                              )}
                            </span>
                          )}
                        </div>

                        {canMutateGroup && onUpdateRecordFrontmatter && (
                          <div className="mt-1 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {cols
                              .filter(
                                (c) =>
                                  c !== "unspecified" &&
                                  c.toLowerCase() !== colKey.toLowerCase(),
                              )
                              .slice(0, 2)
                              .map((nextCol) => (
                                <button
                                  key={nextCol}
                                  className="btn btn-ghost btn-xs text-[10px] h-5 min-h-0 px-1.5 border border-base-content/15"
                                  disabled={updatingPath === r.path}
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    setUpdatingPath(r.path);
                                    setError("");
                                    try {
                                      await onUpdateRecordFrontmatter(r.path, {
                                        [groupBy]: nextCol,
                                      });
                                    } catch (err) {
                                      setError(
                                        err instanceof Error
                                          ? err.message
                                          : "Save failed",
                                      );
                                    } finally {
                                      setUpdatingPath(null);
                                    }
                                  }}
                                  type="button"
                                >
                                  → {nextCol}
                                </button>
                              ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
});

export const RecordTable = defineComponent({
  name: "RecordTable",
  description:
    "Interactive table of project records with search, inline status mutation, and open action",
  props: projectOpenUIProps.RecordTable,
  component: ({ props }) => {
    const {
      columns: rawColumns,
      filterStatus: explicitFilterStatus,
      filterPriority,
      query: queryName,
      limit,
      title,
    } = props;
    const columns = Array.isArray(rawColumns) ? rawColumns : undefined;
    const filterStatus =
      explicitFilterStatus ??
      (typeof rawColumns === "string" ? rawColumns : undefined);
    const {
      records = [],
      queries = {},
      manifest,
      schemaJson,
      onOpenRecord,
      onUpdateRecordFrontmatter,
    } = useOpenLiaOpenUI();
    const [search, setSearch] = useState("");
    const [updatingPath, setUpdatingPath] = useState<string | null>(null);

    const statusField = manifest?.data?.status_field ?? "status";
    const editableFields = new Set(
      manifest?.logic?.mutations?.editable_fields ?? ["status"],
    );
    const canEditStatus =
      Boolean(onUpdateRecordFrontmatter) && editableFields.has(statusField);

    // Discover enum options for statusField from schemaJson if available
    const statusOptions: string[] = (() => {
      const prop = (
        schemaJson?.properties as
          | Record<string, Record<string, unknown>>
          | undefined
      )?.[statusField];
      if (prop && Array.isArray(prop.enum)) {
        return prop.enum.map(String);
      }
      return [];
    })();

    let baseRecords = records;
    if (queryName && Array.isArray(queries[queryName])) {
      baseRecords = queries[queryName] as WorkspaceDomainRecordSummary[];
    }

    let filtered = baseRecords;
    if (filterStatus) {
      filtered = filtered.filter(
        (r) =>
          String(r.frontmatter?.[statusField] ?? "").toLowerCase() ===
          filterStatus.toLowerCase(),
      );
    }
    if (filterPriority) {
      filtered = filtered.filter(
        (r) =>
          String(r.frontmatter?.priority ?? "").toLowerCase() ===
          filterPriority.toLowerCase(),
      );
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.filename.toLowerCase().includes(q) ||
          Object.values(r.frontmatter ?? {}).some((v) =>
            String(v ?? "")
              .toLowerCase()
              .includes(q),
          ),
      );
    }
    if (limit && limit > 0) {
      filtered = filtered.slice(0, limit);
    }

    // Dynamic columns or sensible defaults
    const extraColumns =
      columns && columns.length > 0
        ? columns.filter((c) => c !== "title" && c !== statusField)
        : ["priority", "due"];

    return (
      <div className="flex flex-col rounded-xl border border-base-content/10 bg-base-100 shadow-xs overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-content/10 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-base-content">
              {title || "Records"}
            </h3>
            <span className="badge badge-ghost badge-xs font-mono">
              {filtered.length}
            </span>
          </div>
          <input
            aria-label="Filter records"
            className="input input-xs input-bordered w-44 sm:w-56"
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter records..."
            type="search"
            value={search}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="table table-sm w-full">
            <thead>
              <tr className="border-b border-base-content/10 bg-base-200/50 text-xs uppercase tracking-wider text-base-content/60">
                <th>Title</th>
                <th>{statusField}</th>
                {extraColumns.map((col) => (
                  <th key={col}>{col.replaceAll("_", " ")}</th>
                ))}
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td
                    className="py-6 text-center text-xs italic text-base-content/50"
                    colSpan={3 + extraColumns.length}
                  >
                    No matching records found.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => {
                  const statusVal = String(r.frontmatter?.[statusField] ?? "");
                  return (
                    <tr
                      key={r.path}
                      className="hover:bg-base-200/30 cursor-pointer"
                      onClick={() => onOpenRecord?.(r.path)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onOpenRecord?.(r.path);
                        }
                      }}
                      tabIndex={0}
                    >
                      <td className="font-medium text-base-content">
                        <div className="flex items-center gap-2">
                          <span>{r.title || r.filename}</span>
                          {r.validation && !r.validation.valid && (
                            <span
                              className="badge badge-error badge-xs"
                              title={
                                r.validation.errors?.join("; ") || "Invalid"
                              }
                            >
                              Invalid
                            </span>
                          )}
                        </div>
                      </td>
                      <td
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {canEditStatus &&
                        statusOptions.length > 0 &&
                        onUpdateRecordFrontmatter ? (
                          <select
                            aria-label={`Change ${statusField} for ${r.title || r.filename}`}
                            className="select select-bordered select-xs font-mono text-xs"
                            disabled={updatingPath === r.path}
                            onChange={async (e) => {
                              const nextStatus = e.target.value;
                              setUpdatingPath(r.path);
                              try {
                                await onUpdateRecordFrontmatter(r.path, {
                                  [statusField]: nextStatus,
                                });
                              } finally {
                                setUpdatingPath(null);
                              }
                            }}
                            value={statusVal}
                          >
                            {!statusOptions.includes(statusVal) &&
                              statusVal && (
                                <option value={statusVal}>{statusVal}</option>
                              )}
                            {statusOptions.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        ) : statusVal ? (
                          <span className="badge badge-neutral badge-xs">
                            {statusVal}
                          </span>
                        ) : (
                          <span className="text-xs text-base-content/40">
                            —
                          </span>
                        )}
                      </td>
                      {extraColumns.map((col) => {
                        const rawVal =
                          r.frontmatter?.[col] ??
                          (col === "due"
                            ? (r.frontmatter?.due_date ??
                              r.frontmatter?.target_date ??
                              r.frontmatter?.review_after)
                            : undefined);
                        return (
                          <td
                            key={col}
                            className="text-xs text-base-content/75"
                          >
                            {Array.isArray(rawVal)
                              ? rawVal.join(", ")
                              : rawVal !== undefined &&
                                  rawVal !== null &&
                                  rawVal !== ""
                                ? String(rawVal)
                                : "—"}
                          </td>
                        );
                      })}
                      <td className="text-right">
                        <button
                          className="btn btn-ghost btn-xs text-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenRecord?.(r.path);
                          }}
                          type="button"
                        >
                          Open →
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  },
});

export function normalizeOpenUIProgram(content: string): string {
  return content.replace(/@Query\s*\(/g, "@GetQuery(");
}

// --- Functions ---

export function buildOpenLiaFunctions(getData: () => OpenLiaRuntimeData) {
  const CountByFn = defineFunction({
    name: "CountBy",
    description: "Count records matching a frontmatter field value",
    params: z.object({
      field: z.string().describe("Frontmatter key name"),
      value: z.any().optional().describe("Target value to match"),
    }),
    returns: z.number(),
    fn: ({ field, value }) => evaluateCountBy(getData().records, field, value),
  });

  const GroupCountFn = defineFunction({
    name: "GroupCount",
    description:
      "Group records by a frontmatter key and return label-count pairs",
    params: z.object({
      field: z.string().describe("Frontmatter key name"),
    }),
    returns: z.array(
      z.object({
        label: z.string(),
        count: z.number(),
      }),
    ),
    fn: ({ field }) => evaluateGroupCount(getData().records, field),
  });

  const FilterRecordsFn = defineFunction({
    name: "FilterRecords",
    description: "Filter project records by a frontmatter field value",
    params: z.object({
      field: z.string().describe("Frontmatter key name"),
      value: z.any().optional().describe("Value to match"),
    }),
    returns: z.array(z.any()),
    fn: ({ field, value }) =>
      evaluateFilterRecords(getData().records, field, value),
  });

  const SumByFn = defineFunction({
    name: "SumBy",
    description: "Sum numeric frontmatter values across records",
    params: z.object({
      field: z.string().describe("Numeric frontmatter key name"),
    }),
    returns: z.number(),
    fn: ({ field }) => evaluateSumBy(getData().records, field),
  });

  const GetQueryFn = defineFunction({
    name: "GetQuery",
    description: "Read a pre-computed named query from project-manifest.toml",
    params: z.object({
      name: z.string().describe("Query name defined in [data.queries]"),
    }),
    returns: z.any(),
    fn: ({ name }) => getData().queries?.[name] ?? 0,
  });

  return [
    CountByFn,
    GroupCountFn,
    FilterRecordsFn,
    SumByFn,
    GetQueryFn,
  ] as const;
}

export const [CountBy, GroupCount, FilterRecords, SumBy, GetQuery] =
  buildOpenLiaFunctions(() => activeRuntimeData);

// --- Actions ---

export const OpenRecord = defineAction({
  name: "OpenRecord",
  description: "Navigate to a record within Workspace UI",
  params: z.object({
    path: z.string().describe("Relative path to the record file"),
  }),
});

export const CreateDomainRecord = defineAction({
  name: "CreateDomainRecord",
  description: "Open the create file dialog pre-populated for a project",
  params: z.object({
    domain: z.string().describe("Project path"),
  }),
});

export const UpdateFrontmatter = defineAction({
  name: "UpdateFrontmatter",
  description: "Update a single frontmatter field for a record",
  params: z.object({
    path: z.string().describe("Record path"),
    field: z.string().describe("Frontmatter key"),
    value: z.any().describe("New field value"),
  }),
});

// --- Extended OpenLia Library ---

export const openliaComponents = [
  Grid,
  DomainHeader,
  MetricCard,
  RecordKanban,
  RecordTable,
  FinanceOverview,
];

export const openliaFunctions = [
  CountBy,
  GroupCount,
  FilterRecords,
  SumBy,
  GetQuery,
];

export const openliaActions = [
  OpenRecord,
  CreateDomainRecord,
  UpdateFrontmatter,
];

export const openliaLibrary = openuiLibrary.extend({
  components: { add: openliaComponents },
  functions: { add: openliaFunctions },
  actions: { add: openliaActions },
});

export function createOpenLiaLibrary(data: OpenLiaRuntimeData) {
  return openuiLibrary.extend({
    components: { add: openliaComponents },
    functions: { add: [...buildOpenLiaFunctions(() => data)] },
    actions: { add: openliaActions },
  });
}

import {
  defineAction,
  defineComponent,
  defineFunction,
} from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui";
import { useId, useState } from "react";
import { z } from "zod";
import { domainOpenUIProps } from "../../shared/domainOpenUI";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  DomainCollection,
  RecordProfile,
  RecordSectionView,
} from "./domainComponents";
import { FinanceOverview } from "./FinanceOverview";
import { useOpenLiaOpenUI } from "./context";
import {
  extractMarkdownChecklist,
  extractMarkdownSection,
  parseMarkdownRecord,
} from "./recordMutator";

// --- Components ---

export const DomainHeader = defineComponent({
  name: "DomainHeader",
  description:
    "Domain overview hero header with title, description, and action buttons",
  props: domainOpenUIProps.DomainHeader,
  component: ({ props }) => {
    const { title, description, recordCount } = props;
    const { domainPath, domainInfo, onCreateRecord, onEditOpenUI } =
      useOpenLiaOpenUI();
    const count = recordCount ?? domainInfo?.record_count ?? 0;
    const desc = description ?? domainInfo?.purpose;

    return (
      <div className="flex flex-col gap-2 rounded-xl border border-base-content/10 bg-base-100 p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight text-base-content">
              {title}
            </h1>
            <span className="badge badge-neutral badge-sm font-mono">
              {count} {count === 1 ? "record" : "records"}
            </span>
            {domainInfo?.kind && (
              <span className="badge badge-outline badge-xs uppercase tracking-wider text-base-content/60">
                {domainInfo.kind}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onEditOpenUI && (
              <button
                className="btn btn-ghost btn-xs text-base-content/70 hover:text-base-content"
                onClick={() => onEditOpenUI(domainInfo?.dashboard_openui_path)}
                title="Edit domain dashboard layout (.openui)"
                type="button"
              >
                Edit UI (.openui)
              </button>
            )}
            {onCreateRecord && (
              <button
                className="btn btn-primary btn-xs font-medium"
                onClick={() => onCreateRecord(domainPath ?? domainInfo?.path)}
                type="button"
              >
                + New Record
              </button>
            )}
          </div>
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
  props: domainOpenUIProps.MetricCard,
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
        className={`flex flex-col justify-between rounded-xl border p-4 shadow-sm bg-base-100 ${selectedToneClass}`}
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
    "Interactive Kanban board grouping domain records by a frontmatter enum field",
  props: domainOpenUIProps.RecordKanban,
  component: ({ props }) => {
    const { groupBy = "status", columns, title } = props;
    const {
      records = [],
      onOpenRecord,
      onUpdateRecordFrontmatter,
    } = useOpenLiaOpenUI();

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
    const [updating, setUpdating] = useState(false);

    return (
      <div className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
        {title && (
          <h2 className="text-sm font-semibold uppercase tracking-wider text-base-content/70">
            {title}
          </h2>
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
                className="flex flex-col min-w-[260px] max-w-[320px] flex-1 rounded-xl border border-base-content/10 bg-base-200/40 p-3"
              >
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-base-content/80">
                    {colKey}
                  </span>
                  <span className="badge badge-sm badge-ghost font-mono">
                    {colRecords.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2 min-h-[100px]">
                  {colRecords.length === 0 ? (
                    <div className="grid h-24 place-items-center rounded-lg border border-dashed border-base-content/15 text-xs italic text-base-content/40">
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

                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          {Boolean(r.frontmatter?.priority) && (
                            <span className="badge badge-outline badge-xs font-medium">
                              {String(r.frontmatter.priority)}
                            </span>
                          )}
                          {Boolean(r.frontmatter?.due_date) && (
                            <span className="text-[11px] text-base-content/50">
                              📅 {String(r.frontmatter.due_date)}
                            </span>
                          )}
                          {Array.isArray(r.frontmatter?.tags) &&
                            (r.frontmatter.tags as string[])
                              .slice(0, 2)
                              .map((t: string) => (
                                <span
                                  key={t}
                                  className="badge badge-ghost badge-xs text-base-content/60"
                                >
                                  #{t}
                                </span>
                              ))}
                        </div>

                        {onUpdateRecordFrontmatter && (
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
                                  disabled={updating}
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    setUpdating(true);
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
                                      setUpdating(false);
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
    "Tabular list of domain records with status badges, tags, and open shortcuts",
  props: domainOpenUIProps.RecordTable,
  component: ({ props }) => {
    const { filterStatus, filterPriority, limit, title } = props;
    const { records = [], onOpenRecord } = useOpenLiaOpenUI();

    let filtered = records;
    if (filterStatus) {
      filtered = filtered.filter(
        (r) =>
          String(r.frontmatter?.status ?? "").toLowerCase() ===
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
    if (limit && limit > 0) {
      filtered = filtered.slice(0, limit);
    }

    return (
      <div className="flex flex-col gap-2 rounded-xl border border-base-content/10 bg-base-100 shadow-sm overflow-hidden">
        {title && (
          <div className="border-b border-base-content/10 px-4 py-3">
            <h2 className="text-sm font-semibold text-base-content">{title}</h2>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="table table-sm w-full">
            <thead>
              <tr className="border-b border-base-content/10 bg-base-200/50 text-xs uppercase tracking-wider text-base-content/60">
                <th>Title</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Due / Review</th>
                <th>Tags</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td
                    className="py-6 text-center text-xs italic text-base-content/50"
                    colSpan={6}
                  >
                    No matching records found.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
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
                            title={r.validation.errors?.join("; ") || "Invalid"}
                          >
                            Invalid
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      {r.frontmatter?.status ? (
                        <span className="badge badge-neutral badge-xs">
                          {String(r.frontmatter.status)}
                        </span>
                      ) : (
                        <span className="text-xs text-base-content/40">—</span>
                      )}
                    </td>
                    <td>
                      {r.frontmatter?.priority ? (
                        <span className="badge badge-outline badge-xs">
                          {String(r.frontmatter.priority)}
                        </span>
                      ) : (
                        <span className="text-xs text-base-content/40">—</span>
                      )}
                    </td>
                    <td className="text-xs text-base-content/70">
                      {String(
                        r.frontmatter?.due_date ??
                          r.frontmatter?.target_completion ??
                          r.frontmatter?.review_after ??
                          "—",
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {Array.isArray(r.frontmatter?.tags) &&
                          (r.frontmatter.tags as string[])
                            .slice(0, 3)
                            .map((t: string) => (
                              <span
                                key={t}
                                className="badge badge-ghost badge-xs text-base-content/60"
                              >
                                #{t}
                              </span>
                            ))}
                      </div>
                    </td>
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
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  },
});

export const RecordHeaderCard = defineComponent({
  name: "RecordHeaderCard",
  description: "Hero header for a single Markdown record visual view",
  props: domainOpenUIProps.RecordHeaderCard,
  component: ({ props }) => {
    const { title, status, priority, dueDate } = props;
    const { currentRecordPath, currentRecordContent, onEditOpenUI } =
      useOpenLiaOpenUI();

    const parsed = currentRecordContent
      ? parseMarkdownRecord(currentRecordContent)
      : null;

    const displayTitle =
      title ||
      parsed?.title ||
      parsed?.metadata?.title?.toString() ||
      currentRecordPath?.split("/").pop() ||
      "Document";

    const displayStatus =
      status || (parsed?.metadata?.status as string | undefined);
    const displayPriority =
      priority || (parsed?.metadata?.priority as string | undefined);
    const displayDue =
      dueDate ||
      (parsed?.metadata?.due_date as string | undefined) ||
      (parsed?.metadata?.target_completion as string | undefined);

    return (
      <div className="flex flex-col gap-3 rounded-xl border border-base-content/10 bg-base-100 p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-base-content/50">
              {currentRecordPath}
            </span>
          </div>
          {onEditOpenUI && (
            <button
              className="btn btn-ghost btn-xs text-base-content/60 hover:text-base-content"
              onClick={() => onEditOpenUI()}
              title="Edit visual template (.openui)"
              type="button"
            >
              Edit Visual View (.openui)
            </button>
          )}
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-base-content">
          {displayTitle}
        </h1>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {displayStatus && (
            <span className="badge badge-neutral badge-sm font-medium">
              {displayStatus}
            </span>
          )}
          {displayPriority && (
            <span className="badge badge-outline badge-sm font-medium">
              {displayPriority}
            </span>
          )}
          {displayDue && (
            <span className="badge badge-ghost badge-sm text-base-content/70">
              📅 {displayDue}
            </span>
          )}
          {Array.isArray(parsed?.metadata?.tags) &&
            (parsed.metadata.tags as string[]).map((t: string) => (
              <span key={t} className="badge badge-ghost badge-xs">
                #{t}
              </span>
            ))}
        </div>
      </div>
    );
  },
});

export const FrontmatterEditorCard = defineComponent({
  name: "FrontmatterEditorCard",
  description: "Interactive editor form for record metadata frontmatter fields",
  props: domainOpenUIProps.FrontmatterEditorCard,
  component: ({ props }) => {
    const { title = "Properties", fields } = props;
    const {
      currentRecordPath,
      currentRecordContent,
      schemaJson,
      onUpdateRecordFrontmatter,
    } = useOpenLiaOpenUI();

    const parsed = currentRecordContent
      ? parseMarkdownRecord(currentRecordContent)
      : null;
    const meta = parsed?.metadata ?? {};

    const [formState, setFormState] = useState<Record<string, unknown>>({});
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState("");
    const formId = useId();

    const schemaProperties =
      (schemaJson?.properties as
        | Record<string, Record<string, unknown>>
        | undefined) ?? {};

    const keysToShow =
      fields && fields.length > 0
        ? fields
        : Object.keys(schemaProperties).length > 0
          ? Object.keys(schemaProperties).filter((k) => k !== "$schema")
          : Object.keys(meta).filter((k) => k !== "$schema");

    const handleSave = async () => {
      if (!currentRecordPath || !onUpdateRecordFrontmatter) return;
      setSaving(true);
      setSaveError("");
      try {
        await onUpdateRecordFrontmatter(currentRecordPath, formState);
        setFormState({});
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : "Save failed");
      } finally {
        setSaving(false);
      }
    };

    return (
      <div className="flex flex-col gap-3 rounded-xl border border-base-content/10 bg-base-100 p-4 shadow-sm">
        <div className="flex items-center justify-between border-b border-base-content/10 pb-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/70">
            {title}
          </h2>
          {onUpdateRecordFrontmatter && (
            <button
              className="btn btn-primary btn-xs font-medium"
              disabled={saving}
              onClick={handleSave}
              type="button"
            >
              {saving ? "Saving..." : "Save Properties"}
            </button>
          )}
        </div>
        {saveError && (
          <p role="alert" className="text-error">
            {saveError}
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
          {keysToShow.map((key) => {
            const fieldSchema = schemaProperties[key] ?? {};
            const enumOptions =
              (fieldSchema.enum as unknown[] | undefined)?.filter(
                (value): value is string => typeof value === "string",
              ) ?? [];
            const isArray =
              fieldSchema.type === "array" || Array.isArray(meta[key]);
            const val = Object.hasOwn(formState, key)
              ? formState[key]
              : meta[key];
            const types = Array.isArray(fieldSchema.type)
              ? fieldSchema.type
              : [fieldSchema.type];
            const isNumber =
              types.includes("number") || types.includes("integer");
            const inputId = `${formId}-${key}`;

            return (
              <div key={key} className="flex flex-col gap-1">
                <label
                  className="text-xs font-medium text-base-content/70 capitalize"
                  htmlFor={inputId}
                >
                  {key.replace(/_/g, " ")}
                </label>
                {enumOptions.length > 0 ? (
                  <select
                    className="select select-bordered select-xs w-full bg-base-200/50"
                    id={inputId}
                    onChange={(e) =>
                      setFormState((prev) => ({
                        ...prev,
                        [key]:
                          e.target.value ||
                          (types.includes("null") ? null : undefined),
                      }))
                    }
                    value={(val as string) ?? ""}
                  >
                    <option value="">(Select {key})</option>
                    {enumOptions.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : isArray ? (
                  <input
                    className="input input-bordered input-xs w-full bg-base-200/50"
                    id={inputId}
                    onChange={(e) => {
                      const tags = e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean);
                      setFormState((prev) => ({ ...prev, [key]: tags }));
                    }}
                    placeholder="tag1, tag2..."
                    type="text"
                    value={Array.isArray(val) ? val.join(", ") : ""}
                  />
                ) : (
                  <input
                    className="input input-bordered input-xs w-full bg-base-200/50"
                    id={inputId}
                    onChange={(e) =>
                      setFormState((prev) => ({
                        ...prev,
                        [key]:
                          e.target.value === ""
                            ? types.includes("null")
                              ? null
                              : undefined
                            : isNumber
                              ? Number(e.target.value)
                              : e.target.value,
                      }))
                    }
                    type={
                      isNumber
                        ? "number"
                        : fieldSchema.format === "date"
                          ? "date"
                          : "text"
                    }
                    step={isNumber ? "any" : undefined}
                    value={val !== undefined && val !== null ? String(val) : ""}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  },
});

export const ChecklistSection = defineComponent({
  name: "ChecklistSection",
  description:
    "Interactive checklist bound to a Markdown section heading (- [ ] / - [x])",
  props: domainOpenUIProps.ChecklistSection,
  component: ({ props }) => {
    const { heading, title, allowAdd = true } = props;
    const {
      currentRecordPath,
      currentRecordContent = "",
      onToggleChecklistItem,
      onAddChecklistItem,
    } = useOpenLiaOpenUI();

    const items = extractMarkdownChecklist(currentRecordContent, heading);
    const [newItemText, setNewItemText] = useState("");
    const [adding, setAdding] = useState(false);

    const [error, setError] = useState("");
    const [toggling, setToggling] = useState(false);
    const handleToggle = async (itemIndex: number, currentChecked: boolean) => {
      if (!currentRecordPath || !onToggleChecklistItem) return;
      setToggling(true);
      setError("");
      try {
        await onToggleChecklistItem(
          currentRecordPath,
          heading,
          itemIndex,
          !currentChecked,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      } finally {
        setToggling(false);
      }
    };

    const handleAdd = async (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      const clean = newItemText.trim();
      if (!clean || !currentRecordPath || !onAddChecklistItem) return;
      setAdding(true);
      setError("");
      try {
        await onAddChecklistItem(currentRecordPath, heading, clean);
        setNewItemText("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      } finally {
        setAdding(false);
      }
    };

    const completed = items.filter((i) => i.checked).length;
    const progress = items.length > 0 ? (completed / items.length) * 100 : 0;

    return (
      <div className="flex flex-col gap-3 rounded-xl border border-base-content/10 bg-base-100 p-4 shadow-sm">
        <div className="flex items-center justify-between border-b border-base-content/10 pb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/80">
              {title || heading}
            </h2>
            <span className="badge badge-sm badge-ghost font-mono">
              {completed}/{items.length}
            </span>
          </div>
          {items.length > 0 && (
            <div className="w-24">
              <progress
                className="progress progress-primary w-full h-1.5"
                max="100"
                value={progress}
              />
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          {items.length === 0 ? (
            <div className="py-3 text-xs italic text-base-content/40">
              No tasks listed under "## {heading}".
            </div>
          ) : (
            items.map((item) => (
              <label
                key={item.index}
                className="flex items-start gap-2.5 rounded-lg p-1.5 hover:bg-base-200/50 cursor-pointer transition-colors"
              >
                <input
                  checked={item.checked}
                  disabled={toggling || !onToggleChecklistItem}
                  className="checkbox checkbox-primary checkbox-xs mt-0.5"
                  onChange={() => handleToggle(item.index, item.checked)}
                  type="checkbox"
                />
                <span
                  className={`text-sm text-base-content leading-snug flex-1 ${item.checked ? "line-through text-base-content/40" : ""}`}
                >
                  {item.text}
                </span>
              </label>
            ))
          )}
        </div>

        {allowAdd && onAddChecklistItem && (
          <form className="flex items-center gap-2 pt-1" onSubmit={handleAdd}>
            <input
              className="input input-bordered input-xs flex-1 bg-base-200/50"
              disabled={adding}
              onChange={(e) => setNewItemText(e.target.value)}
              placeholder={`Add task to ${heading}...`}
              type="text"
              value={newItemText}
            />
            <button
              className="btn btn-ghost btn-xs text-primary font-medium"
              disabled={adding || !newItemText.trim()}
              type="submit"
            >
              + Add
            </button>
          </form>
        )}
      </div>
    );
  },
});

export const MarkdownSectionCard = defineComponent({
  name: "MarkdownSectionCard",
  description:
    "Renders the body content of a specific Markdown ## Heading section",
  props: domainOpenUIProps.MarkdownSectionCard,
  component: ({ props }) => {
    const { heading, title } = props;
    const {
      currentRecordContent = "",
      onUpdateSectionContent,
      currentRecordPath,
    } = useOpenLiaOpenUI();
    const sectionBody = extractMarkdownSection(currentRecordContent, heading);
    const [error, setError] = useState("");

    return (
      <div className="flex flex-col gap-2 rounded-xl border border-base-content/10 bg-base-100 p-4 shadow-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/80 border-b border-base-content/10 pb-2">
          {title || heading}
        </h2>
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
        {sectionBody ? (
          <div className="prose prose-sm max-w-none text-base-content/80 whitespace-pre-wrap leading-relaxed">
            {sectionBody}
          </div>
        ) : (
          <div className="flex items-center justify-between py-2 text-xs italic text-base-content/40">
            <span>Section not present in this record.</span>
            {onUpdateSectionContent && currentRecordPath && (
              <button
                className="btn btn-ghost btn-xs text-primary"
                onClick={async () => {
                  setError("");
                  try {
                    await onUpdateSectionContent(
                      currentRecordPath,
                      heading,
                      "(Write section content here)",
                    );
                  } catch (err) {
                    setError(
                      err instanceof Error ? err.message : "Save failed",
                    );
                  }
                }}
                type="button"
              >
                + Add Section
              </button>
            )}
          </div>
        )}
      </div>
    );
  },
});

export const ClaimProvenanceCard = defineComponent({
  name: "ClaimProvenanceCard",
  description:
    "Structured card for knowledge claims provenance, confidence, and temporal validity",
  props: domainOpenUIProps.ClaimProvenanceCard,
  component: ({ props }) => {
    const {
      kind,
      status,
      confidence,
      sourceRef,
      validFrom,
      validUntil,
      reviewAfter,
    } = props;
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-base-content/10 bg-base-100 p-4 shadow-sm">
        <div className="flex items-center justify-between border-b border-base-content/10 pb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-base-content/70">
            Claim Provenance & Validity
          </span>
          {status && (
            <span className="badge badge-neutral badge-xs uppercase font-medium">
              {status}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          {kind && (
            <div>
              <span className="text-base-content/50 block">Kind</span>
              <span className="font-medium text-base-content">{kind}</span>
            </div>
          )}
          {confidence !== undefined && (
            <div>
              <span className="text-base-content/50 block">Confidence</span>
              <span className="font-medium text-base-content">
                {confidence}
              </span>
            </div>
          )}
          {sourceRef && (
            <div className="col-span-2">
              <span className="text-base-content/50 block">Source Ref</span>
              <span className="font-mono text-primary truncate block">
                {sourceRef}
              </span>
            </div>
          )}
          {(validFrom || validUntil) && (
            <div className="col-span-2">
              <span className="text-base-content/50 block">
                Temporal Validity
              </span>
              <span className="font-medium text-base-content">
                {validFrom ?? "Origin"} → {validUntil ?? "Indefinite"}
              </span>
            </div>
          )}
          {reviewAfter && (
            <div>
              <span className="text-base-content/50 block">Review After</span>
              <span className="font-medium text-warning">{reviewAfter}</span>
            </div>
          )}
        </div>
      </div>
    );
  },
});

export const DecisionMatrixCard = defineComponent({
  name: "DecisionMatrixCard",
  description:
    "Visual decision summary displaying recommendation, chosen option, and criteria",
  props: domainOpenUIProps.DecisionMatrixCard,
  component: ({ props }) => {
    const { currentRecordContent = "" } = useOpenLiaOpenUI();
    // A template's rationale section can contain an undecided placeholder.
    // Never turn that prose into a green "Chosen" badge automatically.
    const chosenOption = props.chosenOption;
    const recommendation =
      props.recommendation ??
      extractMarkdownSection(currentRecordContent, "Recommendation");
    const options = props.options ?? [];
    const comparison = extractMarkdownSection(
      currentRecordContent,
      "Options Considered",
    );
    const criteria = extractMarkdownSection(
      currentRecordContent,
      "Criteria And Weights",
    );
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-base-content/10 bg-base-100 p-4 shadow-sm">
        <div className="flex items-center justify-between border-b border-base-content/10 pb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-base-content/70">
            Decision Matrix
          </span>
          {chosenOption && (
            <span className="badge badge-success badge-sm font-medium">
              Chosen: {chosenOption}
            </span>
          )}
        </div>
        {recommendation && (
          <div className="rounded-lg bg-base-200/60 p-3 text-sm text-base-content/90">
            <span className="font-semibold block text-xs text-base-content/60 uppercase mb-1">
              Recommendation
            </span>
            {recommendation}
          </div>
        )}
        {options.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-1">
            <span className="text-xs font-medium text-base-content/60">
              Evaluated Options:
            </span>
            <div className="flex flex-wrap gap-2">
              {options.map((opt) => (
                <span
                  key={opt}
                  className={`badge badge-sm ${opt === chosenOption ? "badge-primary" : "badge-outline"}`}
                >
                  {opt}
                </span>
              ))}
            </div>
          </div>
        )}
        {comparison && (
          <div className="prose prose-sm max-w-none overflow-x-auto">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {comparison}
            </ReactMarkdown>
          </div>
        )}
        {criteria && (
          <div className="prose prose-sm max-w-none overflow-x-auto">
            <h3>Criteria and weights</h3>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {criteria}
            </ReactMarkdown>
          </div>
        )}
      </div>
    );
  },
});

// --- Functions ---

export const CountBy = defineFunction({
  name: "CountBy",
  description: "Count records matching a frontmatter field value",
  params: z.object({
    field: z.string().describe("Frontmatter key name"),
    value: z.any().describe("Target value to match"),
  }),
  returns: z.number(),
  fn: () => 0,
});

export const GroupCount = defineFunction({
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
  fn: () => [],
});

export const FilterRecords = defineFunction({
  name: "FilterRecords",
  description: "Filter domain records by a frontmatter field value",
  params: z.object({
    field: z.string().describe("Frontmatter key name"),
    value: z.any().describe("Value to match"),
  }),
  returns: z.array(z.any()),
  fn: () => [],
});

export const SumBy = defineFunction({
  name: "SumBy",
  description: "Sum numeric frontmatter values across records",
  params: z.object({
    field: z.string().describe("Numeric frontmatter key name"),
  }),
  returns: z.number(),
  fn: () => 0,
});

export const Section = defineFunction({
  name: "Section",
  description: "Extract the content of a specific ## Heading section",
  params: z.object({
    heading: z.string().describe("Markdown ## heading name"),
  }),
  returns: z.string(),
  fn: () => "",
});

export const Checklist = defineFunction({
  name: "Checklist",
  description: "Extract checklist items under a specific ## Heading section",
  params: z.object({
    heading: z.string().describe("Markdown ## heading name"),
  }),
  returns: z.array(z.any()),
  fn: () => [],
});

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
  description: "Open the create file dialog pre-populated for a domain",
  params: z.object({
    domain: z.string().describe("Domain path"),
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

export const ToggleChecklistItem = defineAction({
  name: "ToggleChecklistItem",
  description: "Toggle a checklist item in a Markdown section",
  params: z.object({
    path: z.string().describe("Record path"),
    heading: z.string().optional().describe("Section heading"),
    lineIndex: z.number().describe("Zero-based task index"),
    checked: z.boolean().optional().describe("New checkbox state"),
  }),
});

// --- Extended OpenLia Library ---

export const openliaComponents = [
  DomainHeader,
  MetricCard,
  RecordKanban,
  RecordTable,
  RecordHeaderCard,
  FrontmatterEditorCard,
  ChecklistSection,
  MarkdownSectionCard,
  ClaimProvenanceCard,
  DecisionMatrixCard,
  DomainCollection,
  RecordSectionView,
  RecordProfile,
  FinanceOverview,
];

export const openliaFunctions = [
  CountBy,
  GroupCount,
  FilterRecords,
  SumBy,
  Section,
  Checklist,
];

export const openliaActions = [
  OpenRecord,
  CreateDomainRecord,
  UpdateFrontmatter,
  ToggleChecklistItem,
];

export const openliaLibrary = openuiLibrary.extend({
  components: { add: openliaComponents },
  functions: { add: openliaFunctions },
  actions: { add: openliaActions },
});

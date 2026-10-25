import { defineComponent } from "@openuidev/react-lang";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { domainOpenUIProps } from "../../shared/domainOpenUI";
import { useOpenLiaOpenUI } from "./context";
import {
  contactRecency,
  monitorHealth,
  purchaseTotals,
  safeWebURL,
  text,
  tripAlerts,
} from "./domainData";
import { extractMarkdownSection, parseMarkdownRecord } from "./recordMutator";

const cardClass =
  "rounded-xl border border-base-content/10 bg-base-100 p-4 shadow-sm";

export const DomainCollection = defineComponent({
  name: "DomainCollection",
  description:
    "Searchable domain-specific trip timeline, contact directory, watch grid, or purchase pipeline",
  props: domainOpenUIProps.DomainCollection,
  component: ({ props: { kind } }) => {
    const {
      records = [],
      schemaJson,
      onOpenRecord,
      onUpdateRecordFrontmatter,
    } = useOpenLiaOpenUI();
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState("");
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState("");
    const filterKey =
      kind === "people"
        ? "relationship"
        : kind === "shopping"
          ? "category"
          : "status";
    const options = [
      ...new Set(
        records.map((r) => text(r.frontmatter[filterKey])).filter(Boolean),
      ),
    ].sort();
    const visible = records.filter(
      (r) =>
        `${r.title} ${Object.values(r.frontmatter).map(text).join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (!filter || text(r.frontmatter[filterKey]) === filter),
    );
    if (kind === "travel")
      visible.sort((a, b) =>
        (text(a.frontmatter.start_date) || "9999").localeCompare(
          text(b.frontmatter.start_date) || "9999",
        ),
      );
    const properties = schemaJson?.properties as
      | Record<string, { enum?: unknown[] }>
      | undefined;
    const states = (properties?.status?.enum ?? []).filter(
      (s): s is string => typeof s === "string",
    );
    const groups =
      kind === "shopping"
        ? [
            ...new Set([
              ...states,
              ...visible.map(
                (r) => text(r.frontmatter.status) || "unspecified",
              ),
            ]),
          ]
        : [""];
    const totals = purchaseTotals(visible);
    return (
      <section aria-label={`${kind} overview`} className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <input
            aria-label={`Search ${kind}`}
            className="input input-bordered input-sm"
            placeholder={`Search ${kind}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label={`Filter by ${filterKey}`}
            className="select select-bordered select-sm"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">All {filterKey} values</option>
            {options.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </div>
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
        {kind === "shopping" && (
          <div className={cardClass}>
            <h2 className="font-semibold">Budget tracking</h2>
            {totals.size === 0 ? (
              <p>
                Budget unknown — add budget, actual_price, and currency to track
                purchases.
              </p>
            ) : (
              [...totals].map(([currency, total]) => (
                <p key={currency}>
                  {currency}: budget{" "}
                  {total.budgetCount
                    ? total.budget.toLocaleString()
                    : "unknown"}{" "}
                  · purchased{" "}
                  {total.spentCount ? total.spent.toLocaleString() : "unknown"}{" "}
                  · {total.count} records with amounts
                </p>
              ))
            )}
            <p className="text-xs text-base-content/60">
              Only explicitly recorded amounts are included; currencies are not
              combined.
            </p>
          </div>
        )}
        {visible.length === 0 && <p>No matching records.</p>}
        <div
          className={
            kind === "shopping"
              ? "flex gap-4 overflow-x-auto"
              : "flex flex-col gap-4"
          }
        >
          {groups.map((group) => (
            <div
              key={group}
              className={
                kind === "shopping"
                  ? "min-w-64 flex-1 space-y-3"
                  : "grid gap-3 md:grid-cols-2"
              }
            >
              {group && <h2 className="font-semibold">{group}</h2>}
              {visible
                .filter(
                  (r) =>
                    !group ||
                    (text(r.frontmatter.status) || "unspecified") === group,
                )
                .map((record) => {
                  const fm = record.frontmatter;
                  const source = safeWebURL(fm.source);
                  return (
                    <article key={record.path} className={cardClass}>
                      <button
                        type="button"
                        className="text-left font-semibold text-primary"
                        onClick={() => onOpenRecord?.(record.path)}
                      >
                        {record.title}
                      </button>
                      {kind === "travel" && (
                        <>
                          <p>{text(fm.destination) || "Destination unknown"}</p>
                          <p>
                            {text(fm.start_date) || "Unknown start"} –{" "}
                            {text(fm.end_date) || "Unknown end"}
                          </p>
                          <p>{text(fm.status) || "Status unknown"}</p>
                          {tripAlerts(fm).map((alert) => (
                            <span
                              key={alert}
                              className="badge badge-warning m-1"
                            >
                              {alert}
                            </span>
                          ))}
                        </>
                      )}
                      {kind === "people" && (
                        <>
                          <p>
                            {text(fm.role)} {text(fm.organization)}
                          </p>
                          <span className="badge badge-outline">
                            {text(fm.relationship) || "Relationship unknown"}
                          </span>
                          <p>{contactRecency(fm.last_contacted)}</p>
                        </>
                      )}
                      {kind === "monitors" && (
                        <>
                          <p>Lifecycle: {text(fm.status) || "unknown"}</p>
                          <p>
                            Health:{" "}
                            <span className="badge badge-outline">
                              {monitorHealth(fm)}
                            </span>
                          </p>
                          <p>
                            Frequency: {text(fm.check_frequency) || "unknown"}
                          </p>
                          <p>
                            Last checked: {text(fm.last_checked) || "unknown"}
                          </p>
                          {source ? (
                            <a
                              className="link"
                              href={source}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Inspect source
                            </a>
                          ) : (
                            <p>{text(fm.source) || "Source unknown"}</p>
                          )}
                        </>
                      )}
                      {kind === "shopping" && (
                        <>
                          <p>{text(fm.category) || "Category unknown"}</p>
                          <p>
                            Budget: {text(fm.budget) || "unknown"}{" "}
                            {text(fm.currency)}
                          </p>
                          <select
                            aria-label={`Status for ${record.title}`}
                            className="select select-bordered select-sm mt-2"
                            value={text(fm.status)}
                            disabled={
                              !onUpdateRecordFrontmatter || pending !== null
                            }
                            onChange={async (e) => {
                              setError("");
                              setPending(record.path);
                              try {
                                await onUpdateRecordFrontmatter?.(record.path, {
                                  status: e.target.value,
                                });
                              } catch (err) {
                                setError(
                                  err instanceof Error
                                    ? err.message
                                    : "Save failed",
                                );
                              } finally {
                                setPending(null);
                              }
                            }}
                          >
                            <option value="" disabled>
                              Unspecified
                            </option>
                            {[
                              ...new Set(
                                [...states, text(fm.status)].filter(Boolean),
                              ),
                            ].map((state) => (
                              <option key={state}>{state}</option>
                            ))}
                          </select>
                        </>
                      )}
                    </article>
                  );
                })}
            </div>
          ))}
        </div>
      </section>
    );
  },
});

export const RecordSectionView = defineComponent({
  name: "RecordSectionView",
  description:
    "Editable Markdown schedule, booking cards, comparison table, timeline, or details; legacy prose remains readable",
  props: domainOpenUIProps.RecordSectionView,
  component: ({ props: { heading, kind, title } }) => {
    const {
      currentRecordContent = "",
      currentRecordPath,
      onUpdateSectionContent,
    } = useOpenLiaOpenUI();
    const section = extractMarkdownSection(currentRecordContent, heading);
    const [draft, setDraft] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    return (
      <section className={cardClass} data-view={kind}>
        <div className="flex justify-between gap-3">
          <h2 className="font-semibold">{title || heading}</h2>
          {onUpdateSectionContent && currentRecordPath && draft === null && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => {
                setDraft(section);
                setError("");
              }}
            >
              Edit {title || heading}
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
        {draft !== null ? (
          <form
            className="space-y-2"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!currentRecordPath || !onUpdateSectionContent) return;
              setSaving(true);
              setError("");
              try {
                await onUpdateSectionContent(currentRecordPath, heading, draft);
                setDraft(null);
              } catch (err) {
                setError(err instanceof Error ? err.message : "Save failed");
              } finally {
                setSaving(false);
              }
            }}
          >
            <textarea
              aria-label={heading}
              className="textarea textarea-bordered min-h-40 w-full font-mono"
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary btn-xs"
              disabled={saving}
            >
              Save section
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={saving}
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
          </form>
        ) : section ? (
          <div
            className={`prose prose-sm max-w-none overflow-x-auto domain-${kind}`}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) =>
                  safeWebURL(href) ? (
                    <a
                      href={safeWebURL(href)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {children}
                    </a>
                  ) : (
                    <span>{children}</span>
                  ),
              }}
            >
              {section}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-base-content/60">
            No {title || heading} recorded.
          </p>
        )}
      </section>
    );
  },
});

const profileFields = {
  travel: ["destination", "start_date", "end_date", "purpose", "status"],
  people: [
    "relationship",
    "organization",
    "role",
    "location",
    "timezone",
    "last_contacted",
  ],
  monitors: [
    "status",
    "source",
    "check_frequency",
    "last_checked",
    "alert_channel",
  ],
  shopping: [
    "category",
    "classification",
    "budget",
    "target_price",
    "actual_price",
    "currency",
    "vendor_url",
  ],
  accounts: [
    "account_type",
    "ledger_account",
    "institution_label",
    "currencies",
    "last_reconciled",
  ],
};

export const RecordProfile = defineComponent({
  name: "RecordProfile",
  description:
    "Domain profile with explicit unknowns, safe vendor/source links, and related workspace records",
  props: domainOpenUIProps.RecordProfile,
  component: ({ props: { kind } }) => {
    const { currentRecordContent = "", onOpenRecord } = useOpenLiaOpenUI();
    const { metadata } = parseMarkdownRecord(currentRecordContent);
    return (
      <section className={cardClass}>
        <h2 className="font-semibold">
          {kind === "people"
            ? "Contact profile"
            : kind === "accounts"
              ? "Account overview"
              : `${kind} details`}
        </h2>
        <dl className="grid grid-cols-2 gap-2 mt-3">
          {profileFields[kind].map((key) => {
            const value = Array.isArray(metadata[key])
              ? metadata[key].map(text).join(", ")
              : text(metadata[key]);
            const url = ["source", "vendor_url"].includes(key)
              ? safeWebURL(value)
              : undefined;
            return (
              <div key={key}>
                <dt className="text-xs uppercase text-base-content/60">
                  {key.replaceAll("_", " ")}
                </dt>
                <dd>
                  {url ? (
                    <a
                      className="link"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {value}
                    </a>
                  ) : (
                    value || "Unknown"
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        {kind === "monitors" && <p>Health: {monitorHealth(metadata)}</p>}
        {Array.isArray(metadata.linked_records) && (
          <div className="mt-3">
            <h3>Linked meetings / projects</h3>
            {metadata.linked_records
              .filter((path): path is string => typeof path === "string")
              .map((path) => (
                <button
                  type="button"
                  key={path}
                  className="btn btn-link btn-xs"
                  onClick={() => onOpenRecord?.(path)}
                >
                  {path}
                </button>
              ))}
          </div>
        )}
      </section>
    );
  },
});

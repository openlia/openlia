import { useId } from "react";

export interface RelationshipOption {
  path: string;
  title: string;
}

export interface SchemaPropertyDefinition {
  type?: string | string[];
  enum?: Array<string | null>;
  format?: string;
  minLength?: number;
  items?: {
    type?: string;
    minLength?: number;
  };
}

export interface SchemaRecordFormProps {
  schemaJson?: Record<string, unknown> | undefined;
  templatePath?: string | undefined;
  schemaPath?: string | undefined;
  starterLabel?: string | undefined;
  frontmatter: Record<string, unknown>;
  sections: Record<string, string>;
  sectionHeadings: string[];
  disabled?: boolean | undefined;
  compact?: boolean | undefined;
  relationshipOptions?: {
    linked_project?: RelationshipOption[];
    linked_goal?: RelationshipOption[];
    linked_area?: RelationshipOption[];
  };
  onFrontmatterChange: (key: string, value: unknown) => void;
  onSectionChange: (heading: string, content: string) => void;
}

function isNullableProperty(prop: SchemaPropertyDefinition): boolean {
  if (Array.isArray(prop.type) && prop.type.includes("null")) {
    return true;
  }
  if (Array.isArray(prop.enum) && prop.enum.includes(null)) {
    return true;
  }
  return false;
}

function isArrayProperty(
  prop: SchemaPropertyDefinition,
  currentValue: unknown,
): boolean {
  if (prop.type === "array") return true;
  if (Array.isArray(prop.type) && prop.type.includes("array")) return true;
  return Array.isArray(currentValue);
}

function isDateProperty(key: string, prop: SchemaPropertyDefinition): boolean {
  if (prop.format === "date") return true;
  return (
    key.endsWith("_date") ||
    key === "target_completion" ||
    key === "last_reviewed"
  );
}

function isRelationshipField(
  key: string,
): key is "linked_project" | "linked_goal" | "linked_area" {
  return (
    key === "linked_project" || key === "linked_goal" || key === "linked_area"
  );
}

function formatFieldLabel(key: string): string {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function SchemaRecordForm({
  schemaJson,
  templatePath,
  schemaPath,
  starterLabel,
  frontmatter,
  sections,
  sectionHeadings,
  disabled = false,
  compact = false,
  relationshipOptions,
  onFrontmatterChange,
  onSectionChange,
}: SchemaRecordFormProps) {
  const formIdPrefix = useId();

  const rawProperties =
    schemaJson &&
    typeof schemaJson.properties === "object" &&
    schemaJson.properties !== null &&
    !Array.isArray(schemaJson.properties)
      ? (schemaJson.properties as Record<string, SchemaPropertyDefinition>)
      : {};

  const requiredFields = new Set<string>(
    Array.isArray(schemaJson?.required)
      ? schemaJson.required.filter(
          (item): item is string =>
            typeof item === "string" && item !== "$schema",
        )
      : [],
  );

  const fieldKeys = Array.from(
    new Set([
      ...Object.keys(rawProperties).filter((k) => k !== "$schema"),
      ...Object.keys(frontmatter).filter((k) => k !== "$schema"),
    ]),
  );

  const orderedHeadings = Array.from(
    new Set([...sectionHeadings, ...Object.keys(sections)]),
  );

  return (
    <div className="space-y-4" data-testid="schema-record-form">
      {(templatePath ||
        schemaPath ||
        starterLabel ||
        requiredFields.size > 0) && (
        <div className="rounded-lg border border-base-content/10 bg-base-200/40 p-3 text-xs space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-base-content/80">
              Record Contract
            </span>
            {starterLabel && (
              <span className="badge badge-primary badge-outline badge-xs">
                {starterLabel}
              </span>
            )}
          </div>
          {templatePath && (
            <div className="text-[11px] text-base-content/60">
              Template: <code className="font-mono">{templatePath}</code>
            </div>
          )}
          {schemaPath && (
            <div className="text-[11px] text-base-content/60">
              Schema: <code className="font-mono">{schemaPath}</code>
            </div>
          )}
          {requiredFields.size > 0 && (
            <div className="text-[11px] text-base-content/60">
              Required fields:{" "}
              <code className="font-mono">
                {Array.from(requiredFields).join(", ")}
              </code>
            </div>
          )}
        </div>
      )}

      {fieldKeys.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
              Frontmatter Fields
            </h3>
            <span className="text-[11px] text-base-content/50">
              {fieldKeys.length} {fieldKeys.length === 1 ? "field" : "fields"}
            </span>
          </div>
          <div
            className={`grid gap-3 ${
              compact
                ? "grid-cols-1 sm:grid-cols-2"
                : "grid-cols-1 md:grid-cols-2"
            }`}
          >
            {fieldKeys.map((key) => {
              const prop = rawProperties[key] ?? {};
              const nullable = isNullableProperty(prop);
              const isRequired = requiredFields.has(key);
              const value = frontmatter[key];
              const inputId = `${formIdPrefix}-field-${key}`;
              const enumValues = Array.isArray(prop.enum)
                ? prop.enum.filter((v): v is string => typeof v === "string")
                : [];

              return (
                <div
                  className="rounded-lg border border-base-content/10 bg-base-100 p-2.5 space-y-1"
                  key={key}
                >
                  <div className="flex items-center justify-between gap-1">
                    <label
                      className="text-xs font-medium flex items-center gap-1.5"
                      htmlFor={inputId}
                    >
                      <span>{formatFieldLabel(key)}</span>
                      <code className="text-[10px] font-mono text-base-content/50">
                        ({key})
                      </code>
                    </label>
                    <div className="flex items-center gap-1">
                      {isRequired && (
                        <span className="badge badge-ghost badge-xs text-[10px]">
                          required
                        </span>
                      )}
                      {nullable && (
                        <span className="text-[10px] text-base-content/40">
                          optional
                        </span>
                      )}
                    </div>
                  </div>

                  {enumValues.length > 0 ? (
                    <select
                      aria-label={key}
                      className="select select-bordered select-xs w-full font-mono"
                      disabled={disabled}
                      id={inputId}
                      onChange={(e) => {
                        const raw = e.target.value;
                        onFrontmatterChange(
                          key,
                          raw === "" && nullable ? null : raw,
                        );
                      }}
                      value={typeof value === "string" ? value : ""}
                    >
                      {nullable && (
                        <option value="">(unselected / null)</option>
                      )}
                      {enumValues.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : isArrayProperty(prop, value) ? (
                    <div className="space-y-1">
                      <input
                        aria-label={key}
                        className="input input-bordered input-xs w-full font-mono"
                        disabled={disabled}
                        id={inputId}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const items = raw
                            .split(",")
                            .map((item) => item.trim())
                            .filter(Boolean);
                          onFrontmatterChange(key, items);
                        }}
                        placeholder="comma-separated values (e.g. pkm, roadmap)"
                        type="text"
                        value={
                          Array.isArray(value)
                            ? value.map(String).join(", ")
                            : ""
                        }
                      />
                    </div>
                  ) : isRelationshipField(key) ? (
                    <div className="space-y-1">
                      <input
                        aria-label={key}
                        className="input input-bordered input-xs w-full font-mono"
                        disabled={disabled}
                        id={inputId}
                        list={`${inputId}-datalist`}
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          onFrontmatterChange(key, raw === "" ? null : raw);
                        }}
                        placeholder={
                          key === "linked_project"
                            ? "e.g. knowledge/project-apollo.md"
                            : key === "linked_goal"
                              ? "e.g. goals/launch-openlia.md"
                              : "e.g. areas/engineering.md"
                        }
                        type="text"
                        value={typeof value === "string" ? value : ""}
                      />
                      <datalist id={`${inputId}-datalist`}>
                        {(relationshipOptions?.[key] ?? []).map((opt) => (
                          <option key={opt.path} value={opt.path}>
                            {opt.title}
                          </option>
                        ))}
                      </datalist>
                      {(relationshipOptions?.[key]?.length ?? 0) > 0 && (
                        <select
                          aria-label={`Select ${key}`}
                          className="select select-bordered select-xs w-full text-[11px]"
                          disabled={disabled}
                          onChange={(e) => {
                            const selected = e.target.value;
                            onFrontmatterChange(
                              key,
                              selected === "" ? null : selected,
                            );
                          }}
                          value={typeof value === "string" ? value : ""}
                        >
                          <option value="">
                            Choose existing {key.replace("linked_", "")} (or
                            type path above)...
                          </option>
                          {(relationshipOptions?.[key] ?? []).map((opt) => (
                            <option key={opt.path} value={opt.path}>
                              {opt.title} ({opt.path})
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ) : isDateProperty(key, prop) ? (
                    <input
                      aria-label={key}
                      className="input input-bordered input-xs w-full font-mono"
                      disabled={disabled}
                      id={inputId}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        onFrontmatterChange(
                          key,
                          raw === "" && nullable ? null : raw,
                        );
                      }}
                      type="date"
                      value={typeof value === "string" ? value : ""}
                    />
                  ) : (
                    <input
                      aria-label={key}
                      className="input input-bordered input-xs w-full font-mono"
                      disabled={disabled}
                      id={inputId}
                      onChange={(e) => {
                        const raw = e.target.value;
                        onFrontmatterChange(
                          key,
                          raw.trim() === "" && nullable ? null : raw,
                        );
                      }}
                      placeholder={
                        key === "chosen_option"
                          ? "Leave empty while status is proposed"
                          : nullable
                            ? "Unselected (null)"
                            : `Enter ${key}...`
                      }
                      type="text"
                      value={typeof value === "string" ? value : ""}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {orderedHeadings.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
              Template Sections
            </h3>
            <span className="text-[11px] text-base-content/50">
              {orderedHeadings.map((h) => `## ${h}`).join(" · ")}
            </span>
          </div>
          <div className="space-y-2.5">
            {orderedHeadings.map((heading) => {
              const sectionId = `${formIdPrefix}-section-${heading}`;
              return (
                <div
                  className="rounded-lg border border-base-content/10 bg-base-100 p-2.5 space-y-1.5"
                  key={heading}
                >
                  <label
                    className="text-xs font-semibold font-mono text-primary block"
                    htmlFor={sectionId}
                  >
                    ## {heading}
                  </label>
                  <textarea
                    aria-label={`Section ${heading}`}
                    className="textarea textarea-bordered textarea-xs w-full font-mono text-xs min-h-[3.5rem]"
                    disabled={disabled}
                    id={sectionId}
                    onChange={(e) => onSectionChange(heading, e.target.value)}
                    placeholder={`Content for ## ${heading}...`}
                    rows={compact ? 2 : 3}
                    value={sections[heading] ?? ""}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import type {
  FinanceContextResponse,
  FinanceCreateMapping,
  FinanceReport,
  FinanceMappingValidation,
} from "../../../shared/finance";
import { mappingLinkState } from "./context";

export function FinanceAccountEditor({
  data,
  journal,
  report,
  onCancel,
  onSave,
  onValidate,
}: {
  data: FinanceContextResponse;
  journal: string;
  report: FinanceReport | null;
  onCancel: () => void;
  onSave: (input: FinanceCreateMapping) => Promise<void>;
  onValidate?:
    | ((input: FinanceCreateMapping) => Promise<FinanceMappingValidation>)
    | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [requestId] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState("");
  const [fields, setFields] = useState<Record<string, unknown>>(() => {
    const defaults = structuredClone(data.contract.defaults);
    if ("id" in defaults && defaults.id === null) defaults.id = requestId;
    if (
      "journal_path" in
        ((data.contract.schemaJson.properties as Record<string, unknown>) ??
          {}) &&
      !defaults.journal_path &&
      journal
    )
      defaults.journal_path = journal;
    return defaults;
  });
  const [body, setBody] = useState(data.contract.body);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [validation, setValidation] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const properties = (data.contract.schemaJson.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set(
    Array.isArray(data.contract.schemaJson.required)
      ? (data.contract.schemaJson.required as string[])
      : [],
  );
  const set = (key: string, value: unknown) =>
    setFields((current) => ({ ...current, [key]: value }));
  const linkedReport =
    report?.status === "ok" && report.scope.journal === fields.journal_path
      ? report
      : null;
  return (
    <dialog
      ref={dialog}
      className="modal backdrop:bg-black/70"
      aria-labelledby={`${id}-heading`}
      onCancel={(event) => {
        event.preventDefault();
        if (!savingRef.current) onCancel();
      }}
    >
      <form
        className="modal-box max-w-2xl bg-base-100 space-y-4"
        onChange={() => setValidation("")}
        onSubmit={async (event) => {
          event.preventDefault();
          if (savingRef.current) return;
          setError("");
          if (
            !title.trim() ||
            typeof fields.ledger_account !== "string" ||
            !fields.ledger_account.trim()
          ) {
            setError(
              "Display name and ledger account are required for a useful mapping.",
            );
            return;
          }
          savingRef.current = true;
          setSaving(true);
          try {
            await onSave({
              path: data.path,
              requestId,
              contractRevision: data.contract.revision,
              title: title.trim(),
              fields,
              body,
            });
          } catch (caught) {
            setError(
              caught instanceof Error
                ? caught.message
                : "Mapping could not be saved.",
            );
          } finally {
            savingRef.current = false;
            setSaving(false);
          }
        }}
      >
        <h2 id={`${id}-heading`} className="text-lg font-semibold">
          New account mapping
        </h2>
        <div className="rounded-lg bg-base-200 p-3 text-sm">
          Saves account details only. Does not create a journal, declare a
          ledger account, post an opening balance, or change an external
          account. Cancel writes nothing.
        </div>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        {validation && (
          <p role="status" className="text-sm">
            {validation}
          </p>
        )}
        <fieldset disabled={saving} className="space-y-3">
          <label className="block text-sm">
            Display name
            <input
              className="input input-bordered w-full"
              value={title}
              maxLength={200}
              required
              onChange={(event) => {
                setTitle(event.target.value);
                setBody((current) =>
                  current.replace(/^#\s+.*$/m, () => `# ${event.target.value}`),
                );
              }}
            />
          </label>
          <p className="text-xs opacity-70">
            Use non-secret labels. Do not enter full account numbers,
            credentials, tokens, or raw statements. Fields below come from the
            installed schema; null defaults are valid only where that schema
            permits them.
          </p>
          {Object.entries(properties).map(([key, spec]) => {
            const label =
              key === "journal_path"
                ? "Ledger scope / main journal"
                : key.replaceAll("_", " ");
            const fieldId = `${id}-${key}`;
            const value = Object.hasOwn(fields, key) ? fields[key] : undefined;
            const types = Array.isArray(spec.type) ? spec.type : [spec.type];
            const nullable = types.includes("null");
            const empty = nullable ? null : undefined;
            const enums = Array.isArray(spec.enum) ? spec.enum : null;
            const stringArray =
              types.includes("array") &&
              spec.items &&
              typeof spec.items === "object" &&
              (spec.items as Record<string, unknown>).type === "string";
            const jsonField =
              types.includes("object") ||
              Boolean(spec.$ref || spec.anyOf || spec.oneOf || spec.allOf) ||
              (types.includes("array") && !stringArray);
            const enumIndex =
              enums?.findIndex(
                (item) => JSON.stringify(item) === JSON.stringify(value),
              ) ?? -1;
            return (
              <div key={key}>
                <label htmlFor={fieldId} className="block text-sm font-medium">
                  {label}
                  {required.has(key) ? " (schema-required key)" : ""}
                </label>
                {enums ? (
                  <select
                    id={fieldId}
                    className="select select-bordered w-full"
                    value={String(enumIndex)}
                    onChange={(event) =>
                      set(key, enums[Number(event.target.value)])
                    }
                  >
                    <option value="-1" disabled>
                      Not specified
                    </option>
                    {enums.map((item, index) => (
                      <option key={JSON.stringify(item)} value={index}>
                        {item === null
                          ? "Not specified (null)"
                          : typeof item === "object"
                            ? JSON.stringify(item)
                            : String(item)}
                      </option>
                    ))}
                  </select>
                ) : stringArray ? (
                  <textarea
                    id={fieldId}
                    className="textarea textarea-bordered w-full"
                    value={Array.isArray(value) ? value.join("\n") : ""}
                    onChange={(event) =>
                      set(
                        key,
                        event.target.value
                          .split("\n")
                          .map((item) => item.trim())
                          .filter(Boolean),
                      )
                    }
                    placeholder="One value per line"
                  />
                ) : jsonField ? (
                  <textarea
                    id={fieldId}
                    className="textarea textarea-bordered w-full font-mono"
                    value={
                      typeof value === "string"
                        ? value
                        : JSON.stringify(value ?? null, null, 2)
                    }
                    onChange={(event) => {
                      try {
                        set(key, JSON.parse(event.target.value));
                      } catch {
                        set(key, event.target.value);
                      }
                    }}
                  />
                ) : types.includes("boolean") ? (
                  <select
                    id={fieldId}
                    className="select select-bordered w-full"
                    value={
                      value === undefined || value === null ? "" : String(value)
                    }
                    onChange={(event) =>
                      set(
                        key,
                        event.target.value === ""
                          ? empty
                          : event.target.value === "true",
                      )
                    }
                  >
                    <option value="">Not specified</option>
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </select>
                ) : (
                  <input
                    id={fieldId}
                    className="input input-bordered w-full"
                    type={spec.format === "date" ? "date" : "text"}
                    value={
                      value === null || value === undefined ? "" : String(value)
                    }
                    list={
                      key === "journal_path"
                        ? `${id}-journals`
                        : key === "ledger_account"
                          ? `${id}-accounts`
                          : undefined
                    }
                    onChange={(event) => {
                      const raw = event.target.value;
                      const numeric = Number(raw);
                      set(
                        key,
                        raw === ""
                          ? empty
                          : (types.includes("number") ||
                                types.includes("integer")) &&
                              Number.isFinite(numeric) &&
                              Math.abs(numeric) <= Number.MAX_SAFE_INTEGER
                            ? numeric
                            : raw,
                      );
                    }}
                  />
                )}
                {typeof spec.description === "string" && (
                  <p className="text-xs opacity-60">{spec.description}</p>
                )}
              </div>
            );
          })}
          <datalist id={`${id}-journals`}>
            {data.journals.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
          <datalist id={`${id}-accounts`}>
            {linkedReport?.accounts.map((account) => (
              <option key={account.name} value={account.name}>
                {account.used ? "Used in journal" : "Declared, no postings"}
              </option>
            ))}
          </datalist>
          <p role="status" className="text-sm">
            Ledger link: {mappingLinkState(fields, report)}. An intended journal
            path is allowed; saving this mapping never creates that file.
          </p>
          {typeof fields.journal_path === "string" &&
            data.includedJournals.includes(fields.journal_path) && (
              <p className="text-warning text-sm">
                This path is an included source file. Prefer its main journal to
                map the account across payroll, bank, and other included files.
              </p>
            )}
          <label className="block text-sm">
            Mapping and reconciliation notes (Markdown)
            <textarea
              className="textarea textarea-bordered w-full min-h-52 font-mono text-xs"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
        </fieldset>
        <details>
          <summary className="cursor-pointer text-xs">
            Inspect installed template and schema
          </summary>
          <p className="text-xs break-all">
            Template: {data.contract.templatePath}
            <br />
            Schema: {data.contract.schemaPath}
          </p>
          <pre className="overflow-auto max-h-64 text-xs">
            {JSON.stringify(data.contract.schemaJson, null, 2)}
          </pre>
        </details>
        <p className="text-xs break-all">
          Save target: {data.path}/accounts/{requestId}.md
        </p>
        <div className="modal-action flex-wrap">
          <button
            type="button"
            className="btn btn-sm"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </button>
          {onValidate && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={saving || !title.trim()}
              onClick={async () => {
                if (savingRef.current) return;
                setError("");
                setValidation("");
                savingRef.current = true;
                setSaving(true);
                try {
                  const result = await onValidate({
                    path: data.path,
                    requestId,
                    contractRevision: data.contract.revision,
                    title: title.trim(),
                    fields,
                    body,
                  });
                  if (result.valid)
                    setValidation(
                      "Current draft conforms to the installed contract. Nothing has been saved.",
                    );
                  else setError(result.errors.join("; "));
                } catch (caught) {
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : "Draft validation failed",
                  );
                } finally {
                  savingRef.current = false;
                  setSaving(false);
                }
              }}
            >
              Validate draft (no save)
            </button>
          )}
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={saving || !data.contract.available || !title.trim()}
          >
            {saving ? "Validating / saving…" : "Save account mapping"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

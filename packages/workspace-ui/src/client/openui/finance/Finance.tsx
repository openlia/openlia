import { defineComponent } from "@openuidev/react-lang";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  financeOpenUIProps,
  type FinanceContextResponse,
  type FinanceCreateMapping,
  type FinanceReport,
  type FinanceReportRequest,
} from "../../../shared/finance";
import { ApiError } from "../../api";
import { notifyWorkspaceFileChange } from "../../workspaceFileChanges";
import { useOpenLiaOpenUI } from "../context";
import { FinanceContext } from "./context";
import { FinanceAccountEditor } from "./FinanceAccountEditor";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409)
      return "The account contract or destination changed. Cancel, reload, and retry; no record was overwritten.";
    if (error.payload?.error === "finance_mapping_invalid")
      return "The record does not satisfy the installed account template/schema. Check all fields and preserve its required note sections.";
    if (error.payload?.error === "contract_unavailable")
      return "The installed account contract is unavailable. Repair or update the Finance feature.";
    return "Finance request failed. Check the account fields, workspace paths, and session.";
  }
  return error instanceof Error ? error.message : "Finance request failed.";
}
function shiftMonth(month: string, amount: number) {
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 7);
}

export function FinanceView({
  children,
  journal: configuredJournal,
}: {
  children: ReactNode;
  journal?: string | undefined;
}) {
  const {
    financeApi: api,
    project,
    domainPath,
    onOpenRecord,
  } = useOpenLiaOpenUI();
  const path = project?.path ?? domainPath ?? "finance";
  const [data, setData] = useState<FinanceContextResponse | null>(null);
  const [report, setReport] = useState<FinanceReport | null>(null);
  const [journal, setJournal] = useState("");
  const [currency, setCurrency] = useState<string | null>(null);
  const month = new Date().toISOString().slice(0, 7);
  const [from, setFrom] = useState(shiftMonth(month, -5));
  const [through, setThrough] = useState(month);
  const [prefix, setPrefix] = useState("");
  const [scope, setScope] = useState<FinanceReportRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const initialized = useRef("");
  const initialRange = useRef({ from, through });
  initialRange.current = { from, through };
  useEffect(() => {
    void refresh;
    let active = true;
    setLoading(true);
    setError("");
    if (!api) {
      setError("Finance API is unavailable in this renderer.");
      setLoading(false);
      return;
    }
    api
      .loadFinanceContext(path)
      .then((next) => {
        if (!active) return;
        setData(next);
        const contextKey = `${path}:${configuredJournal ?? ""}`;
        if (initialized.current !== contextKey) {
          const selected = configuredJournal
            ? configuredJournal.startsWith(`${path}/`)
              ? configuredJournal
              : `${path}/${configuredJournal}`
            : (next.suggestedJournal ?? "");
          setJournal(selected);
          setScope(
            selected
              ? {
                  path,
                  journal: selected,
                  from: `${initialRange.current.from}-01`,
                  to: `${shiftMonth(initialRange.current.through, 1)}-01`,
                  accountPrefix: "",
                }
              : null,
          );
          initialized.current = contextKey;
        }
      })
      .catch((caught) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, path, refresh, configuredJournal]);
  useEffect(() => {
    let active = true;
    setReport(null);
    setReportLoading(Boolean(scope));
    if (!scope || !api) {
      setCurrency(null);
      return;
    }
    api
      .loadFinanceReport(scope)
      .then((next) => {
        if (!active) return;
        setReport(next);
        setCurrency((current) =>
          current !== null && next.commodities.includes(current)
            ? current
            : next.commodities.length === 1
              ? (next.commodities[0] ?? null)
              : null,
        );
      })
      .catch((caught) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setReportLoading(false);
      });
    return () => {
      active = false;
    };
  }, [scope, api]);
  const save = async (input: FinanceCreateMapping) => {
    if (!api) throw new Error("Finance API unavailable");
    try {
      const validation = await api.validateFinanceMapping(input);
      if (!validation.valid) throw new Error(validation.errors.join("; "));
      const result = await api.createFinanceMapping(input);
      setEditing(false);
      setNotice(
        [
          `Saved account mapping: ${result.mapping.title}. Journal files were not changed.`,
          ...result.warnings,
        ].join(" "),
      );
      setData((current) =>
        current
          ? {
              ...current,
              mappings: [
                ...current.mappings.filter(
                  (mapping) => mapping.path !== result.mapping.path,
                ),
                result.mapping,
              ],
            }
          : current,
      );
      notifyWorkspaceFileChange(result.mapping.path);
    } catch (caught) {
      throw new Error(errorMessage(caught));
    }
  };
  return (
    <section aria-label="Finance workspace" className="space-y-4">
      <header className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="font-bold text-lg">Personal Finance</h2>
          <p className="text-xs opacity-70">
            Read-only ledger reports · Account creation saves mappings only
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-sm btn-outline"
            disabled={
              !scope || !onOpenRecord || !data?.journals.includes(scope.journal)
            }
            onClick={() => {
              if (scope) onOpenRecord?.(scope.journal);
            }}
          >
            Open main journal
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={editing || loading}
            onClick={() => {
              setRefresh((value) => value + 1);
              if (scope) setScope({ ...scope });
            }}
          >
            Reload Finance
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={loading || !data?.contract.available}
            onClick={() => setEditing(true)}
          >
            New account
          </button>
        </div>
      </header>
      {loading && (
        <p role="status">Loading Finance contracts and account mappings…</p>
      )}
      {error && (
        <p role="alert" className="text-error text-sm">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-success text-sm">
          {notice}
        </p>
      )}
      {data && (
        <>
          {[...data.warnings, ...data.contract.errors].map((warning) => (
            <p key={warning} className="text-warning text-sm">
              {warning}
            </p>
          ))}
          <form
            className="flex flex-wrap items-end gap-3 rounded-lg border border-base-content/10 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              setError("");
              if (!journal) {
                setScope(null);
                return;
              }
              if (
                !/^\d{4}-\d{2}$/.test(from) ||
                !/^\d{4}-\d{2}$/.test(through) ||
                from > through ||
                Date.parse(`${shiftMonth(through, 1)}-01`) -
                  Date.parse(`${from}-01`) >
                  732 * 86400000
              ) {
                setError("Choose a valid range of at most 24 whole months.");
                return;
              }
              setScope({
                path,
                journal,
                from: `${from}-01`,
                to: `${shiftMonth(through, 1)}-01`,
                accountPrefix: prefix.trim(),
              });
            }}
          >
            <label className="text-xs">
              Ledger scope / main journal
              <select
                className="select select-bordered select-sm block max-w-80"
                value={journal}
                onChange={(event) => setJournal(event.target.value)}
              >
                <option value="">No journal selected</option>
                {data.journals.map((item) => (
                  <option key={item} value={item}>
                    {item}
                    {data.includedJournals.includes(item)
                      ? " (included file; partial scope)"
                      : ""}
                  </option>
                ))}
                {journal && !data.journals.includes(journal) && (
                  <option value={journal}>{journal} (unavailable)</option>
                )}
              </select>
            </label>
            <label className="text-xs">
              From month
              <input
                className="input input-bordered input-sm block"
                type="month"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                required
              />
            </label>
            <label className="text-xs">
              Through month
              <input
                className="input input-bordered input-sm block"
                type="month"
                value={through}
                onChange={(event) => setThrough(event.target.value)}
                required
              />
            </label>
            <label className="text-xs">
              Account prefix (optional)
              <input
                className="input input-bordered input-sm block"
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                placeholder="All accounts"
              />
            </label>
            <button
              type="submit"
              className="btn btn-sm"
              disabled={reportLoading}
            >
              Apply report scope
            </button>
            <label className="text-xs">
              Currency / commodity
              <select
                className="select select-bordered select-sm block"
                value={
                  currency === null
                    ? "-1"
                    : String(report?.commodities.indexOf(currency) ?? -1)
                }
                onChange={(event) =>
                  setCurrency(
                    report?.commodities[Number(event.target.value)] ?? null,
                  )
                }
              >
                <option value="-1">Choose one; never combined</option>
                {report?.commodities.map((item, position) => (
                  <option key={item} value={position}>
                    {item || "(unitless)"}
                  </option>
                ))}
              </select>
            </label>
          </form>
          {!scope && (
            <p className="text-sm">
              Select one unambiguous main journal for reports. Account mappings
              can be created without a journal; no journal will be created.
            </p>
          )}
          {scope && data.includedJournals.includes(scope.journal) && (
            <p role="alert" className="text-warning text-sm">
              This is an included source file, not the complete ledger root.
              These reports can omit other files and prior history; select the
              main journal for the combined account.
            </p>
          )}
          {reportLoading && (
            <p role="status">Validating and reading native hledger reports…</p>
          )}
          {report && (
            <>
              <p
                className={
                  report.status === "ok"
                    ? "text-xs opacity-70"
                    : "text-sm text-warning"
                }
                role={report.status === "ok" ? undefined : "alert"}
              >
                {report.message}
              </p>
              <details className="text-xs">
                <summary className="cursor-pointer">
                  Report scope and source files
                </summary>
                <p>
                  {report.scope.journal} · {report.scope.from} ≤ date &lt;{" "}
                  {report.scope.to} ·{" "}
                  {report.scope.accountPrefix || "All accounts"} · unvalued
                  quantities
                </p>
                <ul>
                  {report.files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
                {report.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
                <pre className="overflow-auto max-h-48">
                  {report.commands.join("\n")}
                </pre>
              </details>
            </>
          )}
          <FinanceContext.Provider
            value={{
              data,
              report,
              currency,
              loading: reportLoading,
              newAccount: () => setEditing(true),
              openFile: onOpenRecord,
            }}
          >
            {children}
          </FinanceContext.Provider>
          {editing && (
            <FinanceAccountEditor
              data={data}
              journal={journal}
              report={report}
              onCancel={() => setEditing(false)}
              onSave={save}
              onValidate={
                api ? (input) => api.validateFinanceMapping(input) : undefined
              }
            />
          )}
        </>
      )}
    </section>
  );
}
export const Finance = defineComponent({
  name: "Finance",
  description:
    "Read-only native hledger scope and local account-mapping creation, composed by the Finance feature",
  props: financeOpenUIProps.Finance,
  component: ({ props, renderNode }) => (
    <FinanceView journal={props.journal}>
      {renderNode(props.children)}
    </FinanceView>
  ),
});

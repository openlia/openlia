import { useCallback, useEffect, useRef, useState } from "react";
import type { FinanceCheckResponse } from "../../shared/finance";
import { subscribeWorkspaceFileChanges } from "../workspaceFileChanges";
import { useOpenLiaOpenUI } from "./context";

const labels: Record<FinanceCheckResponse["status"], string> = {
  passed: "hledger check passed for this snapshot",
  failed: "hledger check failed for this snapshot",
  unavailable: "hledger is unavailable",
  timed_out: "Journal check timed out",
  blocked: "Journal check blocked",
  stale: "Journal check is stale — recheck current files",
  error: "Journal check could not complete",
};

export function FinanceValidationCard({ path }: { path: string }) {
  const { financeApi, onOpenRecord } = useOpenLiaOpenUI();
  const [result, setResult] = useState<FinanceCheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const resultRef = useRef(result);
  const mounted = useRef(true);
  const checkingRef = useRef(false);
  const sequence = useRef(0);
  const changesDuringCheck = useRef(new Set<string>());
  const update = useCallback((next: FinanceCheckResponse | null) => {
    if (!mounted.current) return;
    resultRef.current = next;
    setResult(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    checkingRef.current = false;
    changesDuringCheck.current.clear();
    setChecking(false);
    setError("");
    update(null);
    let active = true;
    let freshnessPending = false;
    const stale = (previous: FinanceCheckResponse, message: string) => {
      if (
        !active ||
        resultRef.current !== previous ||
        previous.status === "stale"
      )
        return;
      update({
        ...previous,
        status: "stale",
        diagnostics: [
          ...previous.diagnostics,
          { code: "snapshot_stale", message },
        ],
      });
    };
    const unsubscribe = subscribeWorkspaceFileChanges((changedPath) => {
      if (checkingRef.current) changesDuringCheck.current.add(changedPath);
      const previous = resultRef.current;
      if (previous?.files.some((file) => file.path === changedPath))
        stale(
          previous,
          "A checked workspace file was saved. Recheck the current journal.",
        );
    });
    const refreshFreshness = async () => {
      const previous = resultRef.current;
      if (
        !financeApi ||
        !previous?.fingerprint ||
        !["passed", "failed"].includes(previous.status) ||
        checkingRef.current ||
        freshnessPending
      )
        return;
      freshnessPending = true;
      try {
        const freshness = await financeApi.checkFinanceJournalFreshness(
          path,
          previous.fingerprint,
        );
        if (!freshness.current)
          stale(
            previous,
            "The journal or its dependencies changed. Recheck the current files.",
          );
      } catch {
        stale(
          previous,
          "Could not confirm snapshot freshness. Recheck before relying on this result.",
        );
      } finally {
        freshnessPending = false;
      }
    };
    const onFocus = () => {
      void refreshFreshness();
    };
    const onVisibility = () => {
      if (!document.hidden) void refreshFreshness();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshFreshness();
    }, 15000);
    return () => {
      active = false;
      mounted.current = false;
      sequence.current++;
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [financeApi, path, update]);

  const check = async () => {
    if (!financeApi || checkingRef.current) return;
    const request = ++sequence.current;
    checkingRef.current = true;
    changesDuringCheck.current.clear();
    setChecking(true);
    setError("");
    update(null);
    try {
      const next = await financeApi.checkFinanceJournal(path);
      if (!mounted.current || request !== sequence.current) return;
      if (next.path !== path)
        throw new Error("The check returned an unexpected journal scope.");
      if (
        next.files.some((file) => changesDuringCheck.current.has(file.path))
      ) {
        update({
          ...next,
          status: "stale",
          diagnostics: [
            ...next.diagnostics,
            {
              code: "snapshot_stale",
              message:
                "A journal dependency was saved while checking. Recheck current files.",
            },
          ],
        });
      } else update(next);
    } catch (caught) {
      if (mounted.current && request === sequence.current)
        setError(
          caught instanceof Error
            ? caught.message
            : "Journal check could not complete.",
        );
    } finally {
      if (mounted.current && request === sequence.current) {
        checkingRef.current = false;
        setChecking(false);
      }
    }
  };

  return (
    <section
      aria-label="Journal validation"
      className="rounded-lg border border-base-content/15 p-3 space-y-2"
    >
      <div className="flex flex-wrap justify-between items-center gap-2">
        <h3 className="font-semibold">Journal validation</h3>
        <button
          type="button"
          className="btn btn-primary btn-xs"
          disabled={checking || !financeApi}
          onClick={check}
        >
          {checking
            ? "Checking journal…"
            : result
              ? "Recheck journal"
              : "Check journal"}
        </button>
      </div>
      <p
        role="status"
        className={
          result?.status === "passed" ? "text-success" : "text-base-content/80"
        }
      >
        {checking
          ? "Checking an isolated, read-only snapshot…"
          : result
            ? labels[result.status]
            : "Not checked"}
      </p>
      {!financeApi && <p>Validation is unavailable in this view.</p>}
      <p className="text-xs text-base-content/60">
        Validation checks journal syntax and accounting checks only. Preview
        metrics remain non-authoritative. No transactions are posted or
        reconciled.
      </p>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {result && (
        <>
          <p className="text-xs">
            Checked at {new Date(result.checked_at).toLocaleString()}
            {result.engine_version ? ` · ${result.engine_version}` : ""}
          </p>
          {result.fingerprint && (
            <p className="text-xs break-all">
              Snapshot: <code>{result.fingerprint}</code>
            </p>
          )}
          {result.diagnostics.map((diagnostic) => (
            <div
              key={`${diagnostic.code}:${diagnostic.path ?? ""}:${diagnostic.line ?? ""}:${diagnostic.message}`}
              className="text-sm"
            >
              <p className="whitespace-pre-wrap break-words">
                {diagnostic.message}
              </p>
              {diagnostic.path && (
                <button
                  type="button"
                  className="btn btn-link btn-xs"
                  onClick={() => onOpenRecord?.(diagnostic.path!)}
                >
                  {diagnostic.path}
                  {diagnostic.line ? `:${diagnostic.line}` : ""}
                </button>
              )}
            </div>
          ))}
          {result.files.length > 0 && (
            <details className="text-xs">
              <summary>{result.files.length} captured journal files</summary>
              <ul>
                {result.files.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className="btn btn-link btn-xs"
                      onClick={() => onOpenRecord?.(file.path)}
                    >
                      {file.path}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

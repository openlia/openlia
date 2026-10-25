export const financeCheckStatuses = [
  "passed",
  "failed",
  "unavailable",
  "timed_out",
  "blocked",
  "stale",
  "error",
] as const;

export interface FinanceCheckDiagnostic {
  code: string;
  message: string;
  path?: string | undefined;
  line?: number | undefined;
}

export interface FinanceCheckResponse {
  schema: 1;
  path: string;
  status: (typeof financeCheckStatuses)[number];
  checked_at: string;
  engine_version?: string | undefined;
  fingerprint: string | null;
  files: Array<{ path: string; revision: string }>;
  diagnostics: FinanceCheckDiagnostic[];
}

export interface FinanceCheckFreshnessResponse {
  schema: 1;
  current: boolean;
  fingerprint: string | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isFinanceCheckResponse(
  value: unknown,
): value is FinanceCheckResponse {
  return (
    object(value) &&
    value.schema === 1 &&
    typeof value.path === "string" &&
    financeCheckStatuses.some((status) => status === value.status) &&
    typeof value.checked_at === "string" &&
    (value.engine_version === undefined ||
      typeof value.engine_version === "string") &&
    (value.fingerprint === null || typeof value.fingerprint === "string") &&
    Array.isArray(value.files) &&
    value.files.every(
      (file) =>
        object(file) &&
        typeof file.path === "string" &&
        typeof file.revision === "string",
    ) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(
      (diagnostic) =>
        object(diagnostic) &&
        typeof diagnostic.code === "string" &&
        typeof diagnostic.message === "string" &&
        (diagnostic.path === undefined ||
          typeof diagnostic.path === "string") &&
        (diagnostic.line === undefined ||
          (typeof diagnostic.line === "number" &&
            Number.isInteger(diagnostic.line) &&
            diagnostic.line > 0)),
    )
  );
}

export function isFinanceCheckFreshnessResponse(
  value: unknown,
): value is FinanceCheckFreshnessResponse {
  return (
    object(value) &&
    value.schema === 1 &&
    typeof value.current === "boolean" &&
    (value.fingerprint === null || typeof value.fingerprint === "string")
  );
}

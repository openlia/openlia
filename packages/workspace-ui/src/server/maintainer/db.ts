import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type MaintainerSeverity = "error" | "warning" | "info";
export type MaintainerCategory = "contract" | "suggestion";
export type MaintainerFixStrategy = "deterministic" | "agent" | "manual";
export type MaintainerIssueState = "open" | "ignored" | "resolved";

export interface MaintainerCandidateFinding {
  issue_id: string;
  workspace_id: string;
  relative_path: string;
  rule_code: string;
  severity: MaintainerSeverity;
  category: MaintainerCategory;
  subject: string;
  message: string;
  explanation: string;
  contract_path?: string | undefined;
  contract_fingerprint: string;
  fix_strategy: MaintainerFixStrategy;
  checked_revision: string;
}

export interface MaintainerFindingRecord {
  issue_id: string;
  workspace_id: string;
  relative_path: string;
  rule_code: string;
  severity: MaintainerSeverity;
  category: MaintainerCategory;
  subject: string;
  message: string;
  explanation: string;
  contract_path?: string | undefined;
  contract_fingerprint: string;
  fix_strategy: MaintainerFixStrategy;
  state: MaintainerIssueState;
  present: boolean;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at?: string | undefined;
  last_checked_revision: string;
  ignored_at?: string | undefined;
  ignored_by?: string | undefined;
  ignore_reason?: string | undefined;
  restored_at?: string | undefined;
}

export interface MaintainerFixAttemptRecord {
  id: string;
  issue_id: string;
  relative_path: string;
  actor: string;
  before_revision: string;
  after_revision?: string | undefined;
  status: string;
  summary?: string | undefined;
  created_at: string;
}

export interface MaintainerScanStateRecord {
  workspace_id: string;
  last_scan_at: string;
  coverage_status: "complete" | "partial";
  files_scanned: number;
  files_skipped: number;
  scan_errors: string[];
}

interface RawFindingJoinRow {
  issue_id: string;
  workspace_id: string;
  relative_path: string;
  rule_code: string;
  severity: MaintainerSeverity;
  category: MaintainerCategory;
  subject: string;
  message: string;
  explanation: string;
  contract_path: string | null;
  contract_fingerprint: string;
  fix_strategy: MaintainerFixStrategy;
  present: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  last_checked_revision: string;
  ignore_active: number | null;
  ignore_actor: string | null;
  ignore_reason: string | null;
  ignore_updated_at: string | null;
  ignore_restored_at: string | null;
}

export class MaintainerDB {
  readonly dbPath: string;
  private db: Database;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS findings (
        issue_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        rule_code TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        explanation TEXT NOT NULL,
        contract_path TEXT,
        contract_fingerprint TEXT NOT NULL,
        fix_strategy TEXT NOT NULL,
        present INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_at TEXT,
        last_checked_revision TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_findings_path ON findings(workspace_id, relative_path);
      CREATE INDEX IF NOT EXISTS idx_findings_present ON findings(workspace_id, present);

      CREATE TABLE IF NOT EXISTS ignore_decisions (
        issue_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        rule_code TEXT NOT NULL,
        subject TEXT NOT NULL,
        contract_fingerprint TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        actor TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        restored_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_ignore_decisions_path ON ignore_decisions(workspace_id, relative_path);

      CREATE TABLE IF NOT EXISTS fix_attempts (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        actor TEXT NOT NULL,
        before_revision TEXT NOT NULL,
        after_revision TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_fix_attempts_issue ON fix_attempts(issue_id);

      CREATE TABLE IF NOT EXISTS scan_state (
        workspace_id TEXT PRIMARY KEY,
        last_scan_at TEXT NOT NULL,
        coverage_status TEXT NOT NULL,
        files_scanned INTEGER NOT NULL,
        files_skipped INTEGER NOT NULL,
        scan_errors_json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    try {
      this.db.close();
    } catch {}
  }

  /**
   * Reconciles all findings for a single relative file path at a checked revision.
   * Existing findings for this file that are no longer present become resolved (present = 0)
   * without erasing any ignore_decisions row.
   */
  reconcileFileFindings(
    workspaceId: string,
    relativePath: string,
    checkedRevision: string,
    candidates: MaintainerCandidateFinding[],
    nowIso: string = new Date().toISOString(),
  ): MaintainerFindingRecord[] {
    const normalizedPath = relativePath.replaceAll("\\", "/");
    const activeIds = new Set(candidates.map((c) => c.issue_id));

    const tx = this.db.transaction(() => {
      const upsertStmt = this.db.prepare(`
        INSERT INTO findings (
          issue_id, workspace_id, relative_path, rule_code, severity, category,
          subject, message, explanation, contract_path, contract_fingerprint,
          fix_strategy, present, first_seen_at, last_seen_at, resolved_at, last_checked_revision
        ) VALUES (
          $issue_id, $workspace_id, $relative_path, $rule_code, $severity, $category,
          $subject, $message, $explanation, $contract_path, $contract_fingerprint,
          $fix_strategy, 1, $now, $now, NULL, $checked_revision
        )
        ON CONFLICT(issue_id) DO UPDATE SET
          severity = excluded.severity,
          category = excluded.category,
          message = excluded.message,
          explanation = excluded.explanation,
          contract_path = excluded.contract_path,
          fix_strategy = excluded.fix_strategy,
          present = 1,
          last_seen_at = excluded.last_seen_at,
          resolved_at = NULL,
          last_checked_revision = excluded.last_checked_revision
      `);

      for (const c of candidates) {
        upsertStmt.run({
          $issue_id: c.issue_id,
          $workspace_id: workspaceId,
          $relative_path: normalizedPath,
          $rule_code: c.rule_code,
          $severity: c.severity,
          $category: c.category,
          $subject: c.subject,
          $message: c.message,
          $explanation: c.explanation,
          $contract_path: c.contract_path ?? null,
          $contract_fingerprint: c.contract_fingerprint,
          $fix_strategy: c.fix_strategy,
          $now: nowIso,
          $checked_revision: checkedRevision,
        });
      }

      const existingRows = this.db
        .prepare(
          `SELECT issue_id FROM findings WHERE workspace_id = ? AND relative_path = ? AND present = 1`,
        )
        .all(workspaceId, normalizedPath) as Array<{ issue_id: string }>;

      const resolveStmt = this.db.prepare(`
        UPDATE findings
        SET present = 0, resolved_at = ?, last_checked_revision = ?
        WHERE issue_id = ?
      `);

      for (const row of existingRows) {
        if (!activeIds.has(row.issue_id)) {
          resolveStmt.run(nowIso, checkedRevision, row.issue_id);
        }
      }
    });

    tx();
    return this.listFindings({ workspaceId, relativePath: normalizedPath });
  }

  /**
   * Marks any active findings for a deleted or moved file as resolved while
   * preserving ignore_decisions history.
   */
  markFileDeleted(
    workspaceId: string,
    relativePath: string,
    nowIso: string = new Date().toISOString(),
  ): void {
    const normalizedPath = relativePath.replaceAll("\\", "/");
    this.db
      .prepare(
        `UPDATE findings
         SET present = 0, resolved_at = ?
         WHERE workspace_id = ? AND relative_path = ? AND present = 1`,
      )
      .run(nowIso, workspaceId, normalizedPath);
  }

  /**
   * Records a file-and-issue scoped ignore decision.
   */
  ignoreIssue(params: {
    issueId: string;
    actor?: string | undefined;
    reason?: string | undefined;
    nowIso?: string | undefined;
  }): MaintainerFindingRecord | null {
    const nowIso = params.nowIso ?? new Date().toISOString();
    const actor = params.actor ?? "user";
    const finding = this.getFinding(params.issueId);
    if (!finding) return null;

    this.db
      .prepare(`
        INSERT INTO ignore_decisions (
          issue_id, workspace_id, relative_path, rule_code, subject,
          contract_fingerprint, active, actor, reason, created_at, updated_at, restored_at
        ) VALUES (
          $issue_id, $workspace_id, $relative_path, $rule_code, $subject,
          $contract_fingerprint, 1, $actor, $reason, $now, $now, NULL
        )
        ON CONFLICT(issue_id) DO UPDATE SET
          active = 1,
          actor = excluded.actor,
          reason = excluded.reason,
          updated_at = excluded.updated_at,
          restored_at = NULL
      `)
      .run({
        $issue_id: finding.issue_id,
        $workspace_id: finding.workspace_id,
        $relative_path: finding.relative_path,
        $rule_code: finding.rule_code,
        $subject: finding.subject,
        $contract_fingerprint: finding.contract_fingerprint,
        $actor: actor,
        $reason: params.reason ?? null,
        $now: nowIso,
      });

    return this.getFinding(params.issueId);
  }

  /**
   * Restores a previously ignored finding so it returns to Open (if present) or Resolved (if no longer present).
   */
  restoreIssue(
    issueId: string,
    nowIso: string = new Date().toISOString(),
  ): MaintainerFindingRecord | null {
    this.db
      .prepare(`
        UPDATE ignore_decisions
        SET active = 0, updated_at = ?, restored_at = ?
        WHERE issue_id = ?
      `)
      .run(nowIso, nowIso, issueId);

    return this.getFinding(issueId);
  }

  getFinding(issueId: string): MaintainerFindingRecord | null {
    const row = this.db
      .prepare(`
        SELECT
          f.*,
          i.active AS ignore_active,
          i.actor AS ignore_actor,
          i.reason AS ignore_reason,
          i.updated_at AS ignore_updated_at,
          i.restored_at AS ignore_restored_at
        FROM findings f
        LEFT JOIN ignore_decisions i ON i.issue_id = f.issue_id
        WHERE f.issue_id = ?
      `)
      .get(issueId) as RawFindingJoinRow | null;

    return row ? this.mapRow(row) : null;
  }

  listFindings(filter?: {
    workspaceId?: string | undefined;
    relativePath?: string | undefined;
    state?: MaintainerIssueState | undefined;
    category?: MaintainerCategory | undefined;
  }): MaintainerFindingRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter?.workspaceId) {
      clauses.push("f.workspace_id = ?");
      params.push(filter.workspaceId);
    }
    if (filter?.relativePath) {
      clauses.push("f.relative_path = ?");
      params.push(filter.relativePath.replaceAll("\\", "/"));
    }
    if (filter?.category) {
      clauses.push("f.category = ?");
      params.push(filter.category);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`
        SELECT
          f.*,
          i.active AS ignore_active,
          i.actor AS ignore_actor,
          i.reason AS ignore_reason,
          i.updated_at AS ignore_updated_at,
          i.restored_at AS ignore_restored_at
        FROM findings f
        LEFT JOIN ignore_decisions i ON i.issue_id = f.issue_id
        ${whereSql}
        ORDER BY f.relative_path ASC, f.rule_code ASC, f.subject ASC
      `)
      .all(...params) as RawFindingJoinRow[];

    const mapped = rows.map((r) => this.mapRow(r));
    if (filter?.state) {
      return mapped.filter((m) => m.state === filter.state);
    }
    return mapped;
  }

  recordFixAttempt(params: {
    issueId: string;
    relativePath: string;
    actor: string;
    beforeRevision: string;
    afterRevision?: string | undefined;
    status: string;
    summary?: string | undefined;
    nowIso?: string | undefined;
  }): MaintainerFixAttemptRecord {
    const id = `fix_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const createdAt = params.nowIso ?? new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO fix_attempts (
          id, issue_id, relative_path, actor, before_revision, after_revision, status, summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        params.issueId,
        params.relativePath.replaceAll("\\", "/"),
        params.actor,
        params.beforeRevision,
        params.afterRevision ?? null,
        params.status,
        params.summary ?? null,
        createdAt,
      );

    return {
      id,
      issue_id: params.issueId,
      relative_path: params.relativePath.replaceAll("\\", "/"),
      actor: params.actor,
      before_revision: params.beforeRevision,
      ...(params.afterRevision ? { after_revision: params.afterRevision } : {}),
      status: params.status,
      ...(params.summary ? { summary: params.summary } : {}),
      created_at: createdAt,
    };
  }

  recordScanState(state: MaintainerScanStateRecord): void {
    this.db
      .prepare(`
        INSERT INTO scan_state (
          workspace_id, last_scan_at, coverage_status, files_scanned, files_skipped, scan_errors_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          last_scan_at = excluded.last_scan_at,
          coverage_status = excluded.coverage_status,
          files_scanned = excluded.files_scanned,
          files_skipped = excluded.files_skipped,
          scan_errors_json = excluded.scan_errors_json
      `)
      .run(
        state.workspace_id,
        state.last_scan_at,
        state.coverage_status,
        state.files_scanned,
        state.files_skipped,
        JSON.stringify(state.scan_errors),
      );
  }

  getScanState(workspaceId: string): MaintainerScanStateRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM scan_state WHERE workspace_id = ?`)
      .get(workspaceId) as {
      workspace_id: string;
      last_scan_at: string;
      coverage_status: "complete" | "partial";
      files_scanned: number;
      files_skipped: number;
      scan_errors_json: string;
    } | null;

    if (!row) return null;
    let scanErrors: string[] = [];
    try {
      const parsed = JSON.parse(row.scan_errors_json);
      if (Array.isArray(parsed)) {
        scanErrors = parsed.map(String);
      }
    } catch {}
    return {
      workspace_id: row.workspace_id,
      last_scan_at: row.last_scan_at,
      coverage_status:
        row.coverage_status === "partial" ? "partial" : "complete",
      files_scanned: row.files_scanned,
      files_skipped: row.files_skipped,
      scan_errors: scanErrors,
    };
  }

  private mapRow(row: RawFindingJoinRow): MaintainerFindingRecord {
    const present = row.present === 1;
    const isIgnored = row.ignore_active === 1;
    const state: MaintainerIssueState = !present
      ? "resolved"
      : isIgnored
        ? "ignored"
        : "open";

    return {
      issue_id: row.issue_id,
      workspace_id: row.workspace_id,
      relative_path: row.relative_path,
      rule_code: row.rule_code,
      severity: row.severity,
      category: row.category,
      subject: row.subject,
      message: row.message,
      explanation: row.explanation,
      ...(row.contract_path ? { contract_path: row.contract_path } : {}),
      contract_fingerprint: row.contract_fingerprint,
      fix_strategy: row.fix_strategy,
      state,
      present,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      ...(row.resolved_at ? { resolved_at: row.resolved_at } : {}),
      last_checked_revision: row.last_checked_revision,
      ...(isIgnored && row.ignore_updated_at
        ? { ignored_at: row.ignore_updated_at }
        : {}),
      ...(isIgnored && row.ignore_actor
        ? { ignored_by: row.ignore_actor }
        : {}),
      ...(isIgnored && row.ignore_reason
        ? { ignore_reason: row.ignore_reason }
        : {}),
      ...(row.ignore_restored_at
        ? { restored_at: row.ignore_restored_at }
        : {}),
    };
  }
}

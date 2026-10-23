import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import YAML from "yaml";
import {
  extractHeadings,
  findDomainTemplate,
  isSimilarHeading,
  parseRecordFrontmatter,
} from "./validator";
import type {
  MigrationActionResponse,
  MigrationDetailResponse,
  MigrationFeedbackItem,
  MigrationFeedbackRequest,
  MigrationListResponse,
  MigrationProgress,
  MigrationRecoveryInfo,
  MigrationRevisionSummary,
  MigrationSourceItem,
  MigrationSummary,
} from "../shared/api";

export interface MigrationServiceOptions {
  workspaceRoot: string;
  migrationsRoot?: string;
}

function computeMigrationProgress(
  db: Database,
  migrationId: string,
): MigrationProgress | undefined {
  try {
    const jobCounts = db
      .query(
        `SELECT state, COUNT(*) as count FROM jobs WHERE migration_id = ? GROUP BY state`,
      )
      .all(migrationId) as { state: string; count: number }[];

    const counts: Record<string, number> = {};
    for (const jc of jobCounts) {
      counts[jc.state] = jc.count;
    }

    const succeeded = (counts.succeeded ?? 0) + (counts.no_change ?? 0);
    const running = counts.running ?? 0;
    const pending = counts.pending ?? 0;
    const failed =
      (counts.failed ?? 0) + (counts.blocked ?? 0) + (counts.skipped ?? 0);
    const completed = succeeded + failed;
    const total = completed + running + pending;
    const percent = total > 0 ? Math.floor((succeeded * 100) / total) : 0;

    let currentFile: string | undefined;
    const runningJob = db
      .query(
        `SELECT s.relative_path
         FROM jobs j
         JOIN sources s ON j.source_id = s.id
         WHERE j.migration_id = ? AND j.state = 'running'
         ORDER BY j.updated_at DESC LIMIT 1`,
      )
      .get(migrationId) as { relative_path: string } | null;
    if (runningJob?.relative_path) {
      currentFile = runningJob.relative_path;
    }

    const completedJobs = db
      .query(
        `SELECT updated_at FROM jobs
         WHERE migration_id = ? AND state = 'succeeded'
         ORDER BY updated_at ASC`,
      )
      .all(migrationId) as { updated_at: string }[];

    let avgDurationSec = 80;
    if (completedJobs.length >= 2) {
      let totalDiff = 0;
      let validIntervals = 0;
      for (let i = 1; i < completedJobs.length; i++) {
        const prev = new Date(completedJobs[i - 1]!.updated_at).getTime();
        const curr = new Date(completedJobs[i]!.updated_at).getTime();
        const diff = (curr - prev) / 1000;
        if (diff > 0 && diff < 600) {
          totalDiff += diff;
          validIntervals++;
        }
      }
      if (validIntervals > 0) {
        avgDurationSec = Math.max(30, Math.floor(totalDiff / validIntervals));
      }
    }

    const remainingCount = pending + running;
    let etaSeconds: number | undefined;
    let estimatedFinishAt: string | undefined;
    if (remainingCount > 0 && running > 0) {
      etaSeconds = remainingCount * avgDurationSec;
      estimatedFinishAt = new Date(
        Date.now() + etaSeconds * 1000,
      ).toISOString();
    }

    return {
      total,
      completed,
      succeeded,
      running,
      pending,
      failed,
      percent,
      current_file: currentFile,
      avg_duration_sec: avgDurationSec,
      eta_seconds: etaSeconds,
      estimated_finish_at: estimatedFinishAt,
    };
  } catch {
    return undefined;
  }
}

export class MigrationService {
  readonly workspaceRoot: string;
  readonly migrationsRoot: string;

  constructor(options: MigrationServiceOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.migrationsRoot = resolve(
      options.migrationsRoot ??
        process.env.OPENLIA_MIGRATIONS_ROOT ??
        join(this.workspaceRoot, "..", ".openlia", "workspace-migrations"),
    );
  }

  list(): MigrationListResponse {
    if (!existsSync(this.migrationsRoot)) {
      return { schema: 2, migrations: [] };
    }

    const entries = readdirSync(this.migrationsRoot, { withFileTypes: true });
    const migrations: MigrationSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const migDir = join(this.migrationsRoot, entry.name);
      const sqlitePath = join(migDir, "migration.sqlite");
      const statusJsonPath = join(migDir, "status.json");

      if (existsSync(sqlitePath)) {
        try {
          const db = new Database(sqlitePath, { readonly: true });
          const row = db
            .query(
              `SELECT id, schema, state, stop_intent, baseline_manifest, active_revision_id, created_at, updated_at
               FROM migrations WHERE id = ?`,
            )
            .get(entry.name) as Record<string, unknown> | null;

          if (row) {
            const countSources = db
              .query(
                `SELECT COUNT(*) as count FROM sources WHERE migration_id = ?`,
              )
              .get(entry.name) as { count: number } | null;
            const countRevs = db
              .query(
                `SELECT COUNT(*) as count FROM revisions WHERE migration_id = ?`,
              )
              .get(entry.name) as { count: number } | null;

            const progress = computeMigrationProgress(db, entry.name);

            migrations.push({
              active_revision_id:
                (row.active_revision_id as string) || undefined,
              baseline_manifest: (row.baseline_manifest as string) || undefined,
              created_at:
                (row.created_at as string) || new Date().toISOString(),
              id: row.id as string,
              progress,
              schema: Number(row.schema) || 2,
              state: (row.state as string) || "unknown",
              stop_intent: Boolean(row.stop_intent),
              total_revisions: countRevs?.count ?? 0,
              total_sources: countSources?.count ?? 0,
              updated_at:
                (row.updated_at as string) || new Date().toISOString(),
            });
          }
          db.close();
        } catch {
          // ignore unreadable SQLite
        }
      } else if (existsSync(statusJsonPath)) {
        try {
          const raw = JSON.parse(readFileSync(statusJsonPath, "utf-8"));
          migrations.push({
            created_at: raw.created_at || new Date().toISOString(),
            id: raw.id || entry.name,
            schema: 1,
            state: raw.status || "unknown",
            stop_intent: false,
            total_revisions: 0,
            total_sources: raw.plan_summary?.total_files || 0,
            updated_at: raw.updated_at || new Date().toISOString(),
          });
        } catch {
          // ignore unreadable status.json
        }
      }
    }

    migrations.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    return { schema: 2, migrations };
  }

  detail(migrationId: string): MigrationDetailResponse {
    const migDir = join(this.migrationsRoot, migrationId);
    const sqlitePath = join(migDir, "migration.sqlite");

    if (!existsSync(sqlitePath)) {
      throw new Error(`Migration ${migrationId} not found`);
    }

    const db = new Database(sqlitePath, { readonly: true });
    let migrationRow: Record<string, unknown> | null = null;
    let sources: MigrationSourceItem[] = [];
    let revisions: MigrationRevisionSummary[] = [];
    let feedback: MigrationFeedbackItem[] = [];

    try {
      migrationRow = db
        .query(
          `SELECT id, schema, state, stop_intent, baseline_manifest, active_revision_id, created_at, updated_at
           FROM migrations WHERE id = ?`,
        )
        .get(migrationId) as Record<string, unknown> | null;

      if (!migrationRow) {
        throw new Error(`Migration ${migrationId} record not found`);
      }

      let hasJobsTable = false;
      let summaryCol = "NULL";
      let errorCol = "NULL";
      try {
        const tableCheck = db
          .query(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'`,
          )
          .get() as { name?: string } | null;
        hasJobsTable = Boolean(tableCheck?.name);
        if (hasJobsTable) {
          const colCheck = db.query(`PRAGMA table_info(jobs)`).all() as {
            name: string;
          }[];
          const colNames = new Set(colCheck.map((c) => c.name));
          if (colNames.has("result_summary")) summaryCol = "j.result_summary";
          if (colNames.has("error_message")) errorCol = "j.error_message";
        }
      } catch {}

      const sourceQuery = hasJobsTable
        ? `SELECT s.id, s.relative_path, s.byte_size, s.encoding, s.detected_type, s.eligibility, s.reason, s.dependencies, s.order_index,
                  j.state as job_state, j.attempts as job_attempts, j.max_attempts as job_max_attempts, ${summaryCol} as job_summary, ${errorCol} as job_error
           FROM sources s
           LEFT JOIN jobs j ON j.source_id = s.id AND j.migration_id = s.migration_id
           WHERE s.migration_id = ? ORDER BY s.order_index ASC`
        : `SELECT s.id, s.relative_path, s.byte_size, s.encoding, s.detected_type, s.eligibility, s.reason, s.dependencies, s.order_index,
                  NULL as job_state, NULL as job_attempts, NULL as job_max_attempts, NULL as job_summary, NULL as job_error
           FROM sources s WHERE s.migration_id = ? ORDER BY s.order_index ASC`;

      const sourceRows = db.query(sourceQuery).all(migrationId) as Record<
        string,
        unknown
      >[];

      sources = sourceRows.map((r) => ({
        byte_size: Number(r.byte_size) || 0,
        dependencies: r.dependencies
          ? JSON.parse(r.dependencies as string)
          : undefined,
        detected_type: (r.detected_type as string) || "unknown",
        eligibility: (r.eligibility as any) || "eligible",
        encoding: (r.encoding as string) || "utf-8",
        id: r.id as string,
        order_index: Number(r.order_index) || 0,
        reason: (r.reason as string) || undefined,
        relative_path: r.relative_path as string,
        job_state: (r.job_state as string) || undefined,
        job_attempts:
          r.job_attempts !== null && r.job_attempts !== undefined
            ? Number(r.job_attempts)
            : undefined,
        job_max_attempts:
          r.job_max_attempts !== null && r.job_max_attempts !== undefined
            ? Number(r.job_max_attempts)
            : undefined,
        job_summary: (r.job_summary as string) || undefined,
        job_error: (r.job_error as string) || undefined,
      }));

      let hasUnresolvedQuestions = false;
      try {
        const revCols = db.query(`PRAGMA table_info(revisions)`).all() as {
          name: string;
        }[];
        hasUnresolvedQuestions = revCols.some(
          (c) => c.name === "unresolved_questions",
        );
      } catch {}
      const unresCol = hasUnresolvedQuestions
        ? "unresolved_questions"
        : "NULL as unresolved_questions";

      const revRows = db
        .query(
          `SELECT id, migration_id, revision_num, baseline_hash, commit_hash, tree_hash, patch_hash, summary, changed_files, findings, ${unresCol}, created_at
           FROM revisions WHERE migration_id = ? ORDER BY revision_num ASC`,
        )
        .all(migrationId) as Record<string, unknown>[];

      revisions = revRows.map((r) => ({
        baseline_hash: r.baseline_hash as string,
        changed_files: r.changed_files
          ? JSON.parse(r.changed_files as string)
          : [],
        commit_hash: r.commit_hash as string,
        created_at: r.created_at as string,
        findings: r.findings ? JSON.parse(r.findings as string) : undefined,
        unresolved_questions: r.unresolved_questions
          ? JSON.parse(r.unresolved_questions as string)
          : undefined,
        id: r.id as string,
        migration_id: r.migration_id as string,
        patch_hash: r.patch_hash as string,
        revision_num: Number(r.revision_num) || 1,
        summary: (r.summary as string) || "",
        tree_hash: r.tree_hash as string,
      }));

      const feedbackRows = db
        .query(
          `SELECT id, migration_id, revision_id, target_path, source_id, line_number, comment, status, created_at
           FROM feedback WHERE migration_id = ? ORDER BY created_at ASC`,
        )
        .all(migrationId) as Record<string, unknown>[];

      feedback = feedbackRows.map((r) => ({
        comment: r.comment as string,
        created_at: r.created_at as string,
        id: r.id as string,
        line_number: r.line_number ? Number(r.line_number) : undefined,
        migration_id: r.migration_id as string,
        revision_id: r.revision_id as string,
        source_id: (r.source_id as string) || undefined,
        status: (r.status as any) || "submitted",
        target_path: (r.target_path as string) || undefined,
      }));
    } finally {
      db.close();
    }

    // Generate authoritative git diff from proposal-repo if available
    let active_diff = "";
    const proposalRepoDir = join(migDir, "proposal-repo");
    const baselineCommit = (migrationRow.baseline_manifest as string) || "";
    const latestRevision =
      revisions.length > 0 ? revisions[revisions.length - 1] : null;

    if (
      existsSync(proposalRepoDir) &&
      baselineCommit &&
      latestRevision?.commit_hash
    ) {
      try {
        const proc = Bun.spawnSync(
          [
            "git",
            `--git-dir=${join(proposalRepoDir, ".git")}`,
            `--work-tree=${proposalRepoDir}`,
            "-c",
            "safe.directory=*",
            "diff",
            "--no-renames",
            baselineCommit,
            latestRevision.commit_hash,
          ],
          { stderr: "pipe", stdout: "pipe" },
        );
        if (proc.exitCode === 0) {
          active_diff = new TextDecoder().decode(proc.stdout);
        }
      } catch {
        // fallback to empty diff
      }
    }

    // Inspect Docker container or running process for true worker health
    let workerStatus: "running" | "sleeping" | "crashed" = "sleeping";
    const containerName = `openlia-mig-runner-${migrationId}`;
    try {
      const inspectProc = Bun.spawnSync([
        "docker",
        "inspect",
        "--format",
        "{{.State.Status}}",
        containerName,
      ]);
      if (inspectProc.exitCode === 0) {
        const statusStr = inspectProc.stdout.toString().trim();
        if (statusStr === "running") {
          workerStatus = "running";
        }
      }
    } catch {
      // ignore
    }

    if (workerStatus === "sleeping" && migrationRow.state === "processing") {
      // In processing state without active container -> running or starting supervisor
      workerStatus = "running";
    }

    let progress: MigrationProgress | undefined;
    try {
      const dbProg = new Database(sqlitePath, { readonly: true });
      progress = computeMigrationProgress(dbProg, migrationId);
      dbProg.close();
    } catch {
      // ignore
    }

    let recovery: MigrationRecoveryInfo | undefined = undefined;
    const journalPath = join(migDir, "apply", "journal.json");
    if (migrationRow.state === "recovery_required" || existsSync(journalPath)) {
      try {
        if (existsSync(journalPath)) {
          const jData = JSON.parse(readFileSync(journalPath, "utf-8"));
          recovery = {
            required: migrationRow.state === "recovery_required",
            journal_status: jData.status,
            operations_count: Array.isArray(jData.operations)
              ? jData.operations.length
              : 0,
            error_message: jData.error_message,
          };
        } else if (migrationRow.state === "recovery_required") {
          recovery = {
            required: true,
            error_message: "Migration requires recovery",
          };
        }
      } catch {
        // ignore
      }
    }

    return {
      active_diff: active_diff || undefined,
      feedback,
      migration: {
        active_revision_id:
          (migrationRow.active_revision_id as string) || undefined,
        baseline_manifest:
          (migrationRow.baseline_manifest as string) || undefined,
        created_at:
          (migrationRow.created_at as string) || new Date().toISOString(),
        id: migrationRow.id as string,
        progress,
        schema: Number(migrationRow.schema) || 2,
        state: (migrationRow.state as string) || "unknown",
        stop_intent: Boolean(migrationRow.stop_intent),
        total_revisions: revisions.length,
        total_sources: sources.length,
        updated_at:
          (migrationRow.updated_at as string) || new Date().toISOString(),
      },
      recovery,
      revisions,
      schema: 2,
      sources,
      worker_status: workerStatus,
    };
  }

  addFeedback(
    migrationId: string,
    req: MigrationFeedbackRequest,
  ): MigrationActionResponse {
    const migDir = join(this.migrationsRoot, migrationId);
    const sqlitePath = join(migDir, "migration.sqlite");

    if (!existsSync(sqlitePath)) {
      throw new Error(`Migration ${migrationId} not found`);
    }

    let comment = req.comment;
    if (req.request_changes && !comment.startsWith("[CHANGES REQUESTED]")) {
      comment = `[CHANGES REQUESTED] ${comment}`;
    }

    const openliaBin = this.getOpenliaBin();
    const args = [
      openliaBin,
      "workspace-migrate",
      "feedback",
      "--migration-id",
      migrationId,
      "--comment",
      comment,
      "--revision",
      req.revision_id,
      "--json",
    ];
    if (req.target_path) {
      args.push("--target-path", req.target_path);
    }

    try {
      const proc = Bun.spawnSync(args, { env: this.getExecEnv() });
      if (proc.exitCode === 0) {
        const stdout = proc.stdout.toString();
        try {
          const parsed = JSON.parse(stdout);
          return {
            migration_id: migrationId,
            ok: true,
            state: parsed.state,
          };
        } catch {
          return { migration_id: migrationId, ok: true };
        }
      }
    } catch {
      // fallback
    }

    // Direct SQLite fallback for isolated unit-test environments without operator binary
    const db = new Database(sqlitePath);
    try {
      const id = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      db.query(
        `INSERT INTO feedback (id, migration_id, revision_id, target_path, source_id, line_number, comment, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        migrationId,
        req.revision_id,
        req.target_path ?? null,
        null,
        req.line_number ?? null,
        comment,
        "submitted",
        now,
      );

      const isChangesRequested = comment.startsWith("[CHANGES REQUESTED]");
      if (isChangesRequested) {
        db.query(
          `UPDATE migrations SET state = 'revising', updated_at = ? WHERE id = ?`,
        ).run(now, migrationId);
      } else {
        db.query(`UPDATE migrations SET updated_at = ? WHERE id = ?`).run(
          now,
          migrationId,
        );
      }

      const res: MigrationActionResponse = {
        migration_id: migrationId,
        ok: true,
      };
      if (isChangesRequested) {
        res.state = "revising";
      }
      return res;
    } finally {
      db.close();
    }
  }

  approve(
    migrationId: string,
    revisionId: string,
    patchHash?: string,
  ): MigrationActionResponse {
    const migDir = join(this.migrationsRoot, migrationId);
    const sqlitePath = join(migDir, "migration.sqlite");

    if (!existsSync(sqlitePath)) {
      throw new Error(`Migration ${migrationId} not found`);
    }

    let actualPatchHash = patchHash;
    if (!actualPatchHash) {
      const db = new Database(sqlitePath, { readonly: true });
      try {
        const rev = db
          .query(
            `SELECT patch_hash FROM revisions WHERE id = ? AND migration_id = ?`,
          )
          .get(revisionId, migrationId) as Record<string, unknown> | null;

        if (!rev) {
          throw new Error(`Revision ${revisionId} not found`);
        }
        actualPatchHash = (rev.patch_hash as string) || "";
      } finally {
        db.close();
      }
    }

    // Find openlia / openlia-operator binary
    const openliaBin = this.getOpenliaBin();

    // Invoke operator apply through CLI binary
    const proc = Bun.spawnSync(
      [
        openliaBin,
        "workspace-migrate",
        "apply",
        "--migration-id",
        migrationId,
        "--revision",
        revisionId,
        "--patch-hash",
        actualPatchHash || "",
        "--json",
      ],
      {
        env: this.getExecEnv(),
      },
    );

    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString();
      const stdout = proc.stdout.toString();
      let errMsg =
        stderr || stdout || `Apply exited with code ${proc.exitCode}`;
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) errMsg = parsed.error;
      } catch {
        // ignore
      }
      throw new Error(`Apply failed: ${errMsg}`);
    }

    return {
      migration_id: migrationId,
      ok: true,
      revision_id: revisionId,
      state: "applied",
    };
  }

  recover(
    migrationId: string,
    action: string = "inspect",
  ): MigrationActionResponse {
    const openliaBin = this.getOpenliaBin();
    const proc = Bun.spawnSync(
      [
        openliaBin,
        "workspace-migrate",
        "recover",
        "--migration-id",
        migrationId,
        "--action",
        action,
        "--json",
      ],
      {
        env: this.getExecEnv(),
      },
    );

    if (proc.exitCode !== 0) {
      const err =
        proc.stderr.toString() ||
        proc.stdout.toString() ||
        `Recover failed with code ${proc.exitCode}`;
      throw new Error(err);
    }
    const stdout = proc.stdout.toString();
    let parsed: any = {};
    try {
      parsed = JSON.parse(stdout);
    } catch {}
    return {
      migration_id: migrationId,
      ok: true,
      recovery: parsed,
      state: parsed.status,
    };
  }

  retryJobs(migrationId: string): MigrationActionResponse {
    const openliaBin = this.getOpenliaBin();
    const proc = Bun.spawnSync(
      [
        openliaBin,
        "workspace-migrate",
        "retry-jobs",
        "--migration-id",
        migrationId,
        "--json",
      ],
      {
        env: this.getExecEnv(),
      },
    );

    if (proc.exitCode !== 0) {
      const err =
        proc.stderr.toString() ||
        proc.stdout.toString() ||
        `Retry jobs failed with code ${proc.exitCode}`;
      throw new Error(err);
    }
    return { migration_id: migrationId, ok: true, state: "processing" };
  }

  private getExecEnv(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      OPENLIA_WORKSPACE_ROOT: this.workspaceRoot,
      OPENLIA_MIGRATIONS_ROOT: this.migrationsRoot,
      OPENLIA_DATA_ROOT:
        process.env.OPENLIA_DATA_ROOT ?? join(this.workspaceRoot, ".."),
      OPENLIA_RUNTIME_ROOT:
        process.env.OPENLIA_RUNTIME_ROOT ?? "/var/lib/openlia",
    };
  }

  private getOpenliaBin(): string {
    const candidates = [
      process.env.OPENLIA_BIN,
      "/usr/local/bin/openlia-operator",
      "/usr/local/bin/openlia",
      "/usr/local/lib/openlia/openlia-operator-amd64",
      "/usr/local/lib/openlia/openlia-operator-arm64",
      join(this.workspaceRoot, "..", "..", "openlia"),
      join(this.workspaceRoot, "..", "..", "openlia-operator"),
      join(this.workspaceRoot, "..", "openlia"),
      join(process.cwd(), "openlia"),
      join(process.cwd(), "..", "..", "openlia"),
    ];

    for (const c of candidates) {
      if (c && existsSync(c)) {
        return c;
      }
    }
    return "openlia-operator";
  }

  stop(migrationId: string): MigrationActionResponse {
    const openliaBin = this.getOpenliaBin();
    const proc = Bun.spawnSync(
      [
        openliaBin,
        "workspace-migrate",
        "stop",
        "--migration-id",
        migrationId,
        "--json",
      ],
      {
        env: this.getExecEnv(),
      },
    );

    if (proc.exitCode !== 0) {
      const err =
        proc.stderr.toString() ||
        proc.stdout.toString() ||
        `Stop failed with code ${proc.exitCode}`;
      throw new Error(err);
    }
    return { migration_id: migrationId, ok: true, state: "stopped" };
  }

  resume(migrationId: string): MigrationActionResponse {
    const openliaBin = this.getOpenliaBin();
    // Launch worker in background on resume
    Bun.spawn(
      [
        openliaBin,
        "workspace-migrate",
        "resume",
        "--migration-id",
        migrationId,
        "--json",
      ],
      {
        env: this.getExecEnv(),
      },
    );
    return { migration_id: migrationId, ok: true, state: "processing" };
  }

  wake(migrationId: string): MigrationActionResponse {
    const openliaBin = this.getOpenliaBin();
    // Wake worker in background
    Bun.spawn(
      [
        openliaBin,
        "workspace-migrate",
        "worker",
        "--migration-id",
        migrationId,
        "--json",
      ],
      {
        env: this.getExecEnv(),
      },
    );
    return { migration_id: migrationId, ok: true };
  }

  discard(migrationId: string): MigrationActionResponse {
    const openliaBin = this.getOpenliaBin();
    const proc = Bun.spawnSync(
      [
        openliaBin,
        "workspace-migrate",
        "discard",
        "--migration-id",
        migrationId,
        "--json",
      ],
      {
        env: this.getExecEnv(),
      },
    );

    if (proc.exitCode !== 0) {
      const err =
        proc.stderr.toString() ||
        proc.stdout.toString() ||
        `Discard failed with code ${proc.exitCode}`;
      throw new Error(err);
    }
    return { migration_id: migrationId, ok: true, state: "discarded" };
  }

  createTemplateFixMigration(
    relativePathValue: unknown,
    currentContentValue?: unknown,
  ): { migration_id: string } {
    if (typeof relativePathValue !== "string" || !relativePathValue.trim()) {
      throw new Error("path must be a non-empty string");
    }
    const relPath = relativePathValue.replaceAll("\\", "/").replace(/^\/+/, "");
    const liveFileAbsolute = resolve(this.workspaceRoot, relPath);

    let contentToFix = "";
    if (typeof currentContentValue === "string") {
      contentToFix = currentContentValue;
    } else if (existsSync(liveFileAbsolute)) {
      contentToFix = readFileSync(liveFileAbsolute, "utf-8");
    } else {
      throw new Error(`file ${relPath} does not exist`);
    }

    const domain = findDomainTemplate(this.workspaceRoot, relPath);
    if (!domain) {
      throw new Error(`no domain template found for ${relPath}`);
    }

    const templateAbsolute = resolve(
      this.workspaceRoot,
      domain.templateRelativePath,
    );
    if (!existsSync(templateAbsolute)) {
      throw new Error(
        `template file not found: ${domain.templateRelativePath}`,
      );
    }

    const templateContent = readFileSync(templateAbsolute, "utf-8");
    const templateParsed = parseRecordFrontmatter(templateContent);
    const fileParsed = parseRecordFrontmatter(contentToFix);

    // 1. Reconcile frontmatter
    let fixedMetadata: Record<string, unknown> = {};
    if (fileParsed.metadata) {
      fixedMetadata = { ...fileParsed.metadata };
    }

    // Merge required schema fields or template defaults
    if (existsSync(domain.schemaAbsolutePath)) {
      try {
        const schema = JSON.parse(
          readFileSync(domain.schemaAbsolutePath, "utf-8"),
        );
        const properties = schema?.properties || {};
        const required = Array.isArray(schema?.required) ? schema.required : [];

        for (const reqKey of required) {
          if (reqKey === "$schema") continue;
          if (!(reqKey in fixedMetadata)) {
            if (templateParsed.metadata && reqKey in templateParsed.metadata) {
              fixedMetadata[reqKey] = templateParsed.metadata[reqKey];
            } else if (properties[reqKey]?.default !== undefined) {
              fixedMetadata[reqKey] = properties[reqKey].default;
            } else {
              fixedMetadata[reqKey] = null;
            }
          }
        }
      } catch {}
    }

    // Ensure $schema is included if template includes it
    if (templateParsed.metadata?.$schema && !fixedMetadata.$schema) {
      fixedMetadata.$schema = templateParsed.metadata.$schema;
    }

    // 2. Reconcile markdown headings
    const templateHeadings = extractHeadings(templateContent);
    const expectedSections = templateHeadings
      .filter((h) => h.level === 2)
      .map((h) => h.text.trim())
      .filter(Boolean);

    let body = fileParsed.body;
    const bodyLines = body.split(/\r?\n/);

    // Ensure level-1 title exists
    const fileHeadings = extractHeadings(body);
    const fileL1 = fileHeadings.filter((h) => h.level === 1);
    if (fileL1.length === 0) {
      const titleName = basename(relPath, ".md")
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      bodyLines.unshift(`# ${titleName}`, "");
    }

    // Fix misspelled headings in lines
    for (const expected of expectedSections) {
      const exactMatch = fileHeadings.some(
        (h) =>
          h.level === 2 &&
          h.text.trim().toLowerCase() === expected.toLowerCase(),
      );
      if (!exactMatch) {
        const typo = fileHeadings.find(
          (h) => h.level === 2 && isSimilarHeading(expected, h.text.trim()),
        );
        if (typo) {
          for (let i = 0; i < bodyLines.length; i++) {
            const line = bodyLines[i]!;
            const m = line.match(/^[ \t]{0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/);
            if (m && m[1]?.trim() === typo.text.trim()) {
              bodyLines[i] = `## ${expected}`;
              break;
            }
          }
        } else {
          bodyLines.push("", `## ${expected}`, "");
        }
      }
    }

    const fixedBody = bodyLines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const yamlStr = YAML.stringify(fixedMetadata).trim();
    const fixedContent = `---\n${yamlStr}\n---\n\n${fixedBody}\n`;

    // 3. Create Migration
    const now = new Date().toISOString();
    const dateTag =
      now.slice(0, 10).replace(/-/g, "") +
      "-" +
      now.slice(11, 19).replace(/:/g, "");
    const randomSuffix = Math.random().toString(36).slice(2, 6);
    const migrationId = `mig-${dateTag}-${randomSuffix}`;

    const migDir = join(this.migrationsRoot, migrationId);
    mkdirSync(migDir, { recursive: true });
    const propRepoDir = join(migDir, "proposal-repo");
    mkdirSync(propRepoDir, { recursive: true });

    // Initialize Git proposal repo
    const runGit = (args: string[]) => {
      const proc = Bun.spawnSync(["git", "-c", "safe.directory=*", ...args], {
        cwd: propRepoDir,
      });
      if (proc.exitCode !== 0) {
        throw new Error(
          `git ${args[0]} failed: ${proc.stderr.toString() || proc.stdout.toString()}`,
        );
      }
      return proc.stdout.toString().trim();
    };

    runGit(["init"]);
    runGit(["config", "user.name", "OpenLia Migration"]);
    runGit(["config", "user.email", "migration@openlia.local"]);

    // Write baseline
    const repoFilePath = join(propRepoDir, relPath);
    mkdirSync(dirname(repoFilePath), { recursive: true });

    let baselineContent = "";
    if (existsSync(liveFileAbsolute)) {
      baselineContent = readFileSync(liveFileAbsolute, "utf-8");
    } else {
      baselineContent = contentToFix;
    }

    writeFileSync(repoFilePath, baselineContent, "utf-8");
    runGit(["add", "-A"]);
    runGit([
      "commit",
      "--allow-empty",
      "-m",
      "baseline: initial snapshot from live workspace",
    ]);
    const baselineHash = runGit(["rev-parse", "HEAD"]);

    // Write proposal commit: fixed content
    writeFileSync(repoFilePath, fixedContent, "utf-8");
    runGit(["add", "-A"]);
    runGit([
      "commit",
      "-m",
      `fix(template): conform ${relPath} to ${domain.templateRelativePath}`,
    ]);
    const commitHash = runGit(["rev-parse", "HEAD"]);
    const treeHash = runGit(["rev-parse", `${commitHash}^{tree}`]);
    const diff = runGit(["diff", baselineHash, commitHash]);

    const patchHash = createHash("sha256").update(diff).digest("hex");
    const oldHash = createHash("sha256").update(baselineContent).digest("hex");
    const newHash = createHash("sha256").update(fixedContent).digest("hex");

    const changedFiles = [
      {
        old_hash: oldHash,
        new_hash: newHash,
        path: relPath,
        status: "modified",
      },
    ];

    // Initialize SQLite database
    const sqlitePath = join(migDir, "migration.sqlite");
    const db = new Database(sqlitePath);
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS migrations (
          id TEXT PRIMARY KEY,
          schema INTEGER NOT NULL,
          state TEXT NOT NULL,
          saved_phase TEXT,
          stop_intent INTEGER NOT NULL DEFAULT 0,
          baseline_manifest TEXT,
          active_revision_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          error_message TEXT
        );
        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY,
          migration_id TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          byte_hash TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          encoding TEXT NOT NULL,
          detected_type TEXT NOT NULL,
          eligibility TEXT NOT NULL,
          reason TEXT,
          dependencies TEXT,
          order_index INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          migration_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS revisions (
          id TEXT PRIMARY KEY,
          migration_id TEXT NOT NULL,
          revision_num INTEGER NOT NULL,
          baseline_hash TEXT NOT NULL,
          commit_hash TEXT NOT NULL,
          tree_hash TEXT NOT NULL,
          patch_hash TEXT NOT NULL,
          parent_rev_id TEXT,
          summary TEXT,
          changed_files TEXT,
          findings TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS feedback (
          id TEXT PRIMARY KEY,
          migration_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          target_path TEXT,
          source_id TEXT,
          line_number INTEGER,
          comment TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS apply_journal (
          id TEXT PRIMARY KEY,
          migration_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          patch_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          operations TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      const revisionId = `rev-1-${migrationId}`;
      db.query(`
        INSERT INTO migrations (id, schema, state, baseline_manifest, active_revision_id, created_at, updated_at)
        VALUES (?, 2, 'ready_for_review', ?, ?, ?, ?)
      `).run(migrationId, baselineHash, revisionId, now, now);

      db.query(`
        INSERT INTO sources (id, migration_id, relative_path, byte_hash, byte_size, encoding, detected_type, eligibility, order_index)
        VALUES ('src-1', ?, ?, ?, ?, 'utf-8', 'markdown', 'eligible', 0)
      `).run(
        migrationId,
        relPath,
        oldHash,
        Buffer.byteLength(baselineContent, "utf-8"),
      );

      db.query(`
        INSERT INTO revisions (id, migration_id, revision_num, baseline_hash, commit_hash, tree_hash, patch_hash, summary, changed_files, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revisionId,
        migrationId,
        baselineHash,
        commitHash,
        treeHash,
        patchHash,
        `Fix template headings and schema conformance for ${relPath}`,
        JSON.stringify(changedFiles),
        now,
      );
    } finally {
      db.close();
    }

    return { migration_id: migrationId };
  }
}

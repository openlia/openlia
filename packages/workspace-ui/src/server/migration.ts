import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type {
  MigrationActionResponse,
  MigrationDetailResponse,
  MigrationFeedbackItem,
  MigrationFeedbackRequest,
  MigrationListResponse,
  MigrationProgress,
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

    const db = new Database(sqlitePath);
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

      const sourceRows = db
        .query(
          `SELECT id, relative_path, byte_size, encoding, detected_type, eligibility, reason, dependencies, order_index
           FROM sources WHERE migration_id = ? ORDER BY order_index ASC`,
        )
        .all(migrationId) as Record<string, unknown>[];

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
      }));

      const revRows = db
        .query(
          `SELECT id, migration_id, revision_num, baseline_hash, commit_hash, tree_hash, patch_hash, summary, changed_files, findings, created_at
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
        req.comment,
        "submitted",
        now,
      );

      const isChangesRequested = req.comment.startsWith("[CHANGES REQUESTED]");
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

      if (isChangesRequested) {
        // Automatically wake worker to process revision
        try {
          const openliaBin = this.getOpenliaBin();
          Bun.spawn([
            openliaBin,
            "workspace-migrate",
            "worker",
            "--migration-id",
            migrationId,
            "--json",
          ]);
        } catch {
          // ignore background launch error
        }
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

  approve(migrationId: string, revisionId: string): MigrationActionResponse {
    const migDir = join(this.migrationsRoot, migrationId);
    const sqlitePath = join(migDir, "migration.sqlite");

    if (!existsSync(sqlitePath)) {
      throw new Error(`Migration ${migrationId} not found`);
    }

    const db = new Database(sqlitePath);
    try {
      const now = new Date().toISOString();
      const rev = db
        .query(`SELECT * FROM revisions WHERE id = ? AND migration_id = ?`)
        .get(revisionId, migrationId) as Record<string, unknown> | null;

      if (!rev) {
        throw new Error(`Revision ${revisionId} not found`);
      }

      const patchHash = (rev.patch_hash as string) || "";

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
          patchHash,
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
    } finally {
      db.close();
    }
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
}

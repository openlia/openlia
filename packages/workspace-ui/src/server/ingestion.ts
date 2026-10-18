import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import type {
  DocumentPasswordProfile,
  IngestionArtifact,
  IngestionCallbackStatus,
  IngestionDetailResponse,
  IngestionListItem,
  IngestionLiveAction,
  IngestionLiveEvent,
  IngestionLiveJob,
  IngestionOverviewResponse,
  PasswordSuggestion,
  SourceBacklink,
  SourceDocument,
  SourceExtractionItem,
  SourceRetryRequest,
  SourceRetryResponse,
  SourceSearchResponse,
  SourceSearchResultItem,
  SourceUpdateRequest,
  SourceUploadResponse,
} from "../shared/api";
import { suggestPasswordProfiles } from "../shared/passwordSuggester";

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const profileIdRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const forbiddenLabelRe =
  /(oauth|api[ _-]?key|token|private[ _-]?key|session|cookie|service[ _-]?credential)/i;
const maxSnapshotBytes = 20 * 1024 * 1024;
const liveStaleAfterSeconds = 15;

interface IntakeRecord extends Record<string, unknown> {
  intake_id: string;
  source_id: string;
  version_id: string;
  captured_at: string;
  kind: string;
  operation: string;
  requested_outputs: string[];
  status: string | null;
  job_id?: string | null;
  last_error?: string | null;
  callback: Record<string, unknown>;
}

interface SourceRecord extends Record<string, unknown> {
  id: string;
  title: string;
  kind: string;
  document_type?: string | null;
  correspondent?: string | null;
  document_date?: string | null;
  tags?: string[];
  summary?: string | null;
  processing?: {
    status: string;
    last_job_id?: string | null;
    updated_at?: string | null;
    error?: string | null;
    error_code?: string | null;
    error_summary?: string | null;
  };
  review?: {
    status: string;
    reasons: string[];
    reviewed_at?: string | null;
  };
  lifecycle?: string;
  status?: string | null;
  captured_at?: string | null;
  password_profile?: string | null;
  origin?: Record<string, unknown>;
  versions?: Array<Record<string, unknown>>;
  custom_fields?: Record<string, unknown>;
}

interface LiveSnapshot {
  schema: 1;
  generated_at: number;
  job_counts: Record<string, number>;
  jobs: IngestionLiveJob[];
  events: IngestionLiveEvent[];
  actions: IngestionLiveAction[];
}

interface LiveState {
  snapshot?: LiveSnapshot;
  available: boolean;
  stale: boolean;
  generatedAt?: number;
  ageSeconds?: number;
  error?: string;
}

export interface IngestionServiceOptions {
  workspaceRoot: string;
  ingestionRoot?: string;
  ingestionUrl?: string;
}

function normalizeBlobRelpath(rel: string): string {
  const clean = rel.trim().replace(/^\/+/, "");
  if (clean.startsWith("sources/artifacts/")) {
    return `blobs/${clean.slice("sources/artifacts/".length)}`;
  }
  return clean;
}

export class IngestionService {
  readonly workspaceRoot: string;
  readonly ingestionRoot: string;
  readonly ingestionUrl: string | undefined;
  private db: Database | null = null;
  private migratedLegacy = false;

  constructor(options: IngestionServiceOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.ingestionRoot = resolve(
      options.ingestionRoot ??
        process.env.OPENLIA_INGESTION_ROOT ??
        join(this.workspaceRoot, "..", "ingestion"),
    );
    this.ingestionUrl =
      (options.ingestionUrl ?? process.env.OPENLIA_INGESTION_URL ?? "")
        .trim()
        .replace(/\/+$/, "") || undefined;
  }

  private resolveDbPath(): string {
    if (!existsSync(this.ingestionRoot)) {
      mkdirSync(this.ingestionRoot, { recursive: true });
    }
    const legacyPath = join(this.ingestionRoot, "queue.sqlite");
    const vaultPath = join(this.ingestionRoot, "vault.sqlite");
    return existsSync(legacyPath) && !existsSync(vaultPath)
      ? legacyPath
      : vaultPath;
  }

  private getDb(): Database | null {
    if (this.db) {
      if (!this.migratedLegacy) {
        this.migratedLegacy = true;
        this.migrateLegacyWorkspaceRecords(this.db);
      }
      return this.db;
    }
    let db: Database | undefined;
    try {
      const dbPath = this.resolveDbPath();
      db = new Database(dbPath);
      db.run("PRAGMA busy_timeout = 30000;");
      db.run("PRAGMA journal_mode = WAL;");
      db.run("PRAGMA synchronous = FULL;");
      db.run(`
        CREATE TABLE IF NOT EXISTS sources (
            source_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            document_type TEXT,
            correspondent TEXT,
            document_date TEXT,
            tags_json TEXT NOT NULL DEFAULT '[]',
            summary TEXT,
            custom_fields_json TEXT NOT NULL DEFAULT '{}',
            processing_status TEXT NOT NULL DEFAULT 'captured',
            last_job_id TEXT,
            processing_error_code TEXT,
            processing_error_summary TEXT,
            review_status TEXT NOT NULL DEFAULT 'unreviewed',
            review_reasons_json TEXT NOT NULL DEFAULT '[]',
            reviewed_at TEXT,
            lifecycle TEXT NOT NULL DEFAULT 'active',
            sensitivity TEXT NOT NULL DEFAULT 'personal',
            origin_json TEXT NOT NULL DEFAULT '{}',
            password_profile TEXT,
            record_json TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS source_versions (
            source_id TEXT NOT NULL,
            version_id TEXT NOT NULL,
            original_artifact_id TEXT,
            filename TEXT,
            content_sha256 TEXT,
            media_type TEXT,
            size_bytes INTEGER,
            blob_relpath TEXT,
            received_at TEXT,
            PRIMARY KEY (source_id, version_id)
        );
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS extractions (
            extraction_id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            version_id TEXT NOT NULL,
            artifact_id TEXT,
            role TEXT NOT NULL,
            media_type TEXT,
            blob_relpath TEXT,
            manifest_relpath TEXT,
            content_text TEXT,
            coverage_json TEXT NOT NULL DEFAULT '{}',
            warnings_json TEXT NOT NULL DEFAULT '[]',
            complete INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS intakes (
            intake_id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            version_id TEXT,
            kind TEXT NOT NULL,
            operation TEXT NOT NULL,
            status TEXT NOT NULL,
            job_id TEXT,
            last_error TEXT,
            record_json TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
      `);
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(
            source_id UNINDEXED,
            title,
            correspondent,
            document_type,
            tags,
            summary,
            content,
            document_date UNINDEXED,
            review_status UNINDEXED,
            processing_status UNINDEXED,
            lifecycle UNINDEXED,
            tokenize = 'porter unicode61'
        );
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS jobs (
            job_id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            intake_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            version_id TEXT,
            operation TEXT NOT NULL,
            requested_outputs TEXT NOT NULL,
            state TEXT NOT NULL,
            lease_owner TEXT,
            lease_generation INTEGER NOT NULL DEFAULT 0,
            lease_expires_at REAL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at REAL,
            error_code TEXT,
            error_summary TEXT,
            password_profile TEXT,
            continuation TEXT NOT NULL,
            result TEXT,
            heartbeat_at REAL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
      `);
      const columns = db.query("PRAGMA table_info(jobs)").all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === "lease_generation")) {
        db.run(
          "ALTER TABLE jobs ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0",
        );
      }
      this.db = db;
      if (!this.migratedLegacy) {
        this.migratedLegacy = true;
        this.migrateLegacyWorkspaceRecords(db);
      }
      return db;
    } catch {
      db?.close();
      return null;
    }
  }

  private migrateLegacyWorkspaceRecords(db: Database): void {
    const recordsDir = join(this.workspaceRoot, "sources", "records");
    if (existsSync(recordsDir)) {
      for (const name of readdirSync(recordsDir)) {
        if (!name.endsWith(".md") || name.startsWith("source-template"))
          continue;
        const doc = this.readFrontmatter(join(recordsDir, name));
        if (!this.isSource(doc)) continue;
        const existing = db
          .query("SELECT 1 FROM sources WHERE source_id = ?")
          .get(doc.id);
        if (existing) continue;

        let extractedText = "";
        for (const ver of doc.versions ?? []) {
          const verId = stringOrNull(ver.id);
          if (!verId) continue;
          const origRef = stringOrNull(ver.original_ref);
          if (origRef) {
            const legacyAbs = join(this.workspaceRoot, origRef);
            const newRel = normalizeBlobRelpath(origRef);
            if (existsSync(legacyAbs)) {
              const targetAbs = join(this.ingestionRoot, newRel);
              mkdirSync(join(targetAbs, ".."), { recursive: true });
              const data = readFileSync(legacyAbs);
              writeFileSync(targetAbs, data);
              ver.size_bytes = data.byteLength;
              ver.filename = ver.filename ?? basename(legacyAbs);
            }
            ver.original_ref = newRel;
          }

          const legacyExtRoot = join(
            this.workspaceRoot,
            "sources",
            "artifacts",
            doc.id,
            verId,
            "extractions",
          );
          if (existsSync(legacyExtRoot)) {
            for (const extId of orderedExtractionIds(legacyExtRoot, ver)) {
              const extDir = join(legacyExtRoot, extId);
              if (!statSync(extDir, { throwIfNoEntry: false })?.isDirectory())
                continue;
              const manifest = this.readJson(join(extDir, "manifest.json"));
              for (const child of readdirSync(extDir)) {
                const childAbs = join(extDir, child);
                if (!statSync(childAbs, { throwIfNoEntry: false })?.isFile())
                  continue;
                const relTarget = `blobs/${doc.id}/${verId}/extractions/${extId}/${child}`;
                const targetAbs = join(this.ingestionRoot, relTarget);
                mkdirSync(join(targetAbs, ".."), { recursive: true });
                const bytes = readFileSync(childAbs);
                writeFileSync(targetAbs, bytes);
                if (child !== "manifest.json") {
                  const textVal = bytes.toString("utf8");
                  if (!extractedText) extractedText = textVal;
                  db.run(
                    `INSERT OR REPLACE INTO extractions (
                      extraction_id, source_id, version_id, artifact_id, role,
                      media_type, blob_relpath, manifest_relpath, content_text,
                      coverage_json, warnings_json, complete, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                      extId,
                      doc.id,
                      verId,
                      stringOrNull(manifest?.artifact_id) ?? `art_${extId}`,
                      stringOrNull(manifest?.role) ??
                        basename(child, extname(child)),
                      stringOrNull(manifest?.media_type) ?? "text/markdown",
                      relTarget,
                      `blobs/${doc.id}/${verId}/extractions/${extId}/manifest.json`,
                      textVal.slice(0, 100000),
                      JSON.stringify(manifest?.coverage ?? {}),
                      JSON.stringify(manifest?.warnings ?? []),
                      manifest?.complete === false ? 0 : 1,
                      doc.captured_at ?? new Date().toISOString(),
                    ],
                  );
                }
              }
            }
          }
        }
        this.saveSourceToVault(doc, db, extractedText);
      }
    }

    const intakesDir = join(this.workspaceRoot, "inbox", "ingestion");
    if (existsSync(intakesDir)) {
      for (const name of readdirSync(intakesDir)) {
        if (!name.startsWith("intake_") || !name.endsWith(".md")) continue;
        const intake = this.readFrontmatter(join(intakesDir, name));
        if (!this.isIntake(intake)) continue;
        const existing = db
          .query("SELECT 1 FROM intakes WHERE intake_id = ?")
          .get(intake.intake_id);
        if (!existing) {
          this.saveIntakeToVault(intake, db);
        }
      }
    }
  }

  private saveSourceToVault(
    source: SourceRecord,
    db?: Database | null,
    extractedContent?: string,
  ): void {
    const nowIso = new Date().toISOString();
    const fallbackDir = join(this.ingestionRoot, "sources");
    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(
      join(fallbackDir, `${source.id}.json`),
      JSON.stringify(source, null, 2),
      "utf8",
    );

    const activeDb = db ?? this.getDb();
    if (!activeDb) return;

    const processing = source.processing ?? { status: "captured" };
    const review = source.review ?? { status: "unreviewed", reasons: [] };
    const capturedAt = source.captured_at ?? nowIso;

    activeDb.run(
      `INSERT INTO sources (
        source_id, kind, title, document_type, correspondent, document_date,
        tags_json, summary, custom_fields_json, processing_status, last_job_id,
        processing_error_code, processing_error_summary, review_status,
        review_reasons_json, reviewed_at, lifecycle, sensitivity, origin_json,
        password_profile, record_json, captured_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        kind=excluded.kind,
        title=excluded.title,
        document_type=excluded.document_type,
        correspondent=excluded.correspondent,
        document_date=excluded.document_date,
        tags_json=excluded.tags_json,
        summary=excluded.summary,
        custom_fields_json=excluded.custom_fields_json,
        processing_status=excluded.processing_status,
        last_job_id=excluded.last_job_id,
        processing_error_code=excluded.processing_error_code,
        processing_error_summary=excluded.processing_error_summary,
        review_status=excluded.review_status,
        review_reasons_json=excluded.review_reasons_json,
        reviewed_at=excluded.reviewed_at,
        lifecycle=excluded.lifecycle,
        origin_json=excluded.origin_json,
        password_profile=excluded.password_profile,
        record_json=excluded.record_json,
        updated_at=excluded.updated_at`,
      [
        source.id,
        source.kind ?? "file",
        source.title ?? "Untitled source",
        source.document_type ?? null,
        source.correspondent ?? null,
        source.document_date ?? null,
        JSON.stringify(source.tags ?? []),
        source.summary ?? null,
        JSON.stringify(source.custom_fields ?? {}),
        processing.status ?? source.status ?? "captured",
        processing.last_job_id ?? null,
        processing.error_code ?? null,
        processing.error_summary ?? processing.error ?? null,
        review.status ?? "unreviewed",
        JSON.stringify(review.reasons ?? []),
        review.reviewed_at ?? null,
        source.lifecycle ?? "active",
        "personal",
        JSON.stringify(source.origin ?? {}),
        source.password_profile ?? null,
        JSON.stringify(source),
        capturedAt,
        nowIso,
      ],
    );

    for (const ver of source.versions ?? []) {
      const verId = stringOrNull(ver.id);
      if (!verId) continue;
      activeDb.run(
        `INSERT INTO source_versions (
          source_id, version_id, original_artifact_id, filename,
          content_sha256, media_type, size_bytes, blob_relpath, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, version_id) DO UPDATE SET
          original_artifact_id=excluded.original_artifact_id,
          filename=COALESCE(excluded.filename, source_versions.filename),
          content_sha256=excluded.content_sha256,
          media_type=excluded.media_type,
          size_bytes=COALESCE(excluded.size_bytes, source_versions.size_bytes),
          blob_relpath=excluded.blob_relpath,
          received_at=excluded.received_at`,
        [
          source.id,
          verId,
          stringOrNull(ver.original_artifact_id),
          stringOrNull(ver.filename),
          stringOrNull(ver.content_sha256),
          stringOrNull(ver.media_type),
          numberOrUndefined(ver.size_bytes) ?? null,
          stringOrNull(ver.original_ref),
          stringOrNull(ver.received_at) ?? capturedAt,
        ],
      );
    }

    try {
      const existingFts = activeDb
        .query("SELECT content FROM source_fts WHERE source_id = ? LIMIT 1")
        .get(source.id) as { content?: string } | null;
      let contentToIndex = extractedContent ?? existingFts?.content ?? "";
      const cfEntries = Object.entries(source.custom_fields ?? {}).filter(
        ([, v]) => v !== null && v !== undefined && v !== "",
      );
      if (cfEntries.length > 0) {
        const cfText = cfEntries.map(([k, v]) => `${k}: ${v}`).join(" ");
        if (!contentToIndex.includes(cfText)) {
          contentToIndex = `${contentToIndex}\n${cfText}`.trim();
        }
      }
      activeDb.run("DELETE FROM source_fts WHERE source_id = ?", [source.id]);
      activeDb.run(
        `INSERT INTO source_fts (
          source_id, title, correspondent, document_type, tags, summary,
          content, document_date, review_status, processing_status, lifecycle
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          source.id,
          source.title ?? "",
          source.correspondent ?? "",
          source.document_type ?? "",
          (source.tags ?? []).join(" "),
          source.summary ?? "",
          contentToIndex.slice(0, 50000),
          source.document_date ?? "",
          review.status ?? "unreviewed",
          processing.status ?? "complete",
          source.lifecycle ?? "active",
        ],
      );
    } catch {
      // Ignore FTS sync failure
    }
  }

  private saveIntakeToVault(intake: IntakeRecord, db?: Database | null): void {
    const nowIso = new Date().toISOString();
    const fallbackDir = join(this.ingestionRoot, "intakes");
    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(
      join(fallbackDir, `${intake.intake_id}.json`),
      JSON.stringify(intake, null, 2),
      "utf8",
    );

    const activeDb = db ?? this.getDb();
    if (!activeDb) return;
    activeDb.run(
      `INSERT INTO intakes (
        intake_id, source_id, version_id, kind, operation,
        status, job_id, last_error, record_json, captured_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(intake_id) DO UPDATE SET
        version_id=excluded.version_id,
        status=excluded.status,
        job_id=excluded.job_id,
        last_error=excluded.last_error,
        record_json=excluded.record_json,
        updated_at=excluded.updated_at`,
      [
        intake.intake_id,
        intake.source_id,
        intake.version_id,
        intake.kind,
        intake.operation,
        intake.status ?? "captured",
        intake.job_id ?? null,
        intake.last_error ?? null,
        JSON.stringify(intake),
        intake.captured_at ?? nowIso,
        nowIso,
      ],
    );
  }

  overview(
    searchValue?: string,
    statusValue?: string,
    offset = 0,
    limit = 50,
  ): IngestionOverviewResponse {
    const live = this.readLiveState();
    const records = this.listRecords();
    const search = searchValue?.trim().toLowerCase() ?? "";
    const status = statusValue?.trim().toLowerCase() ?? "";
    const allItems = records.map((record) =>
      this.listItem(record, live.snapshot),
    );
    const items = allItems.filter((item) => {
      if (status && item.status.toLowerCase() !== status) return false;
      if (!search) return true;
      return [item.intake_id, item.source_id, item.source_title, item.kind]
        .join(" ")
        .toLowerCase()
        .includes(search);
    });
    const counts: Record<string, number> = {};
    for (const item of allItems) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    }
    const page = items.slice(offset, offset + limit);
    return {
      schema: 1,
      ...this.liveResponseFields(live),
      counts,
      queue_counts: live.snapshot?.job_counts ?? {},
      intakes: page,
      total: items.length,
      offset,
      limit,
      truncated: offset + page.length < items.length,
    };
  }

  detail(intakeId: string): IngestionDetailResponse {
    if (!safeId.test(intakeId)) throw new Error("invalid ingestion intake id");
    const record = this.readIntake(intakeId);
    if (!record) throw new Error("ingestion intake was not found");
    const live = this.readLiveState();
    const source = this.readSource(record.source_id);
    const item = this.listItem(record, live.snapshot, source);
    return {
      schema: 1,
      ...this.liveResponseFields(live),
      intake: item,
      source: {
        id: source?.id ?? record.source_id,
        title: source?.title ?? item.source_title,
        kind: source?.kind ?? record.kind,
        status: source?.status ?? null,
        captured_at: source?.captured_at ?? null,
        origin: source?.origin ?? {},
        versions: source?.versions ?? [],
      },
      artifacts: source ? this.artifacts(source) : [],
    };
  }

  searchSources(options: {
    query?: string | undefined;
    tags?: string[] | undefined;
    correspondent?: string | undefined;
    document_type?: string | undefined;
    review_status?: string | undefined;
    processing_status?: string | undefined;
    lifecycle?: string | undefined;
    date_from?: string | undefined;
    date_to?: string | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  }): SourceSearchResponse {
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const db = this.getDb();

    if (!db) {
      return this.fallbackSearchSources(options);
    }

    try {
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      const queryText = (options.query ?? "").trim();
      if (queryText) {
        const ftsTokens = queryText
          .replace(/[^\p{L}\p{N}_\s-]/gu, " ")
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => `"${t.replace(/"/g, '""')}*"`);
        if (ftsTokens.length > 0) {
          conditions.push("source_fts MATCH ?");
          params.push(ftsTokens.join(" "));
        }
      }

      if (options.tags && options.tags.length > 0) {
        for (const t of options.tags) {
          conditions.push("tags LIKE ?");
          params.push(`%${t.trim()}%`);
        }
      }

      if (options.correspondent) {
        conditions.push("correspondent = ?");
        params.push(options.correspondent.trim());
      }

      if (options.document_type) {
        conditions.push("document_type = ?");
        params.push(options.document_type.trim());
      }

      if (options.processing_status) {
        conditions.push("processing_status = ?");
        params.push(options.processing_status.trim());
      }

      if (options.lifecycle) {
        conditions.push("lifecycle = ?");
        params.push(options.lifecycle.trim());
      }

      if (options.date_from) {
        conditions.push("document_date >= ?");
        params.push(options.date_from);
      }

      if (options.date_to) {
        conditions.push("document_date <= ?");
        params.push(options.date_to);
      }

      const reviewFacetConditions = [...conditions];
      const reviewFacetParams = [...params];
      if (options.review_status) {
        if (options.review_status.trim() === "needs-review") {
          conditions.push("review_status IN (?, ?)");
          params.push("needs-review", "unreviewed");
        } else {
          conditions.push("review_status = ?");
          params.push(options.review_status.trim());
        }
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const facetSql = `
        SELECT
          source_id,
          title,
          correspondent,
          document_type,
          document_date,
          tags,
          summary,
          review_status,
          processing_status,
          lifecycle
        FROM source_fts
        ${whereClause}
      `;
      const allRows = db.query(facetSql).all(...params) as Array<{
        source_id: string;
        title: string;
        correspondent: string | null;
        document_type: string | null;
        document_date: string | null;
        tags: string | null;
        summary: string | null;
        review_status: string;
        processing_status: string;
        lifecycle: string;
      }>;
      const reviewFacetWhere =
        reviewFacetConditions.length > 0
          ? `WHERE ${reviewFacetConditions.join(" AND ")}`
          : "";
      const reviewFacetRows = db
        .query(
          `SELECT review_status, COUNT(*) AS count
           FROM source_fts ${reviewFacetWhere}
           GROUP BY review_status`,
        )
        .all(...reviewFacetParams) as Array<{
        review_status: string | null;
        count: number;
      }>;

      const tagCounts: Record<string, number> = {};
      const correspondentCounts: Record<string, number> = {};
      const typeCounts: Record<string, number> = {};
      const reviewCounts: Record<string, number> = {};
      const processingCounts: Record<string, number> = {};

      for (const r of allRows) {
        if (r.tags) {
          for (const t of r.tags.split(/\s+/).filter(Boolean)) {
            tagCounts[t] = (tagCounts[t] ?? 0) + 1;
          }
        }
        if (r.correspondent) {
          correspondentCounts[r.correspondent] =
            (correspondentCounts[r.correspondent] ?? 0) + 1;
        }
        if (r.document_type) {
          typeCounts[r.document_type] = (typeCounts[r.document_type] ?? 0) + 1;
        }
        const proc = r.processing_status || "captured";
        processingCounts[proc] = (processingCounts[proc] ?? 0) + 1;
      }
      for (const row of reviewFacetRows) {
        const reviewStatus = row.review_status || "unreviewed";
        reviewCounts[reviewStatus] = Number(row.count);
      }

      const snippetExpr = queryText
        ? "snippet(source_fts, -1, '<mark>', '</mark>', '...', 25) AS snippet, bm25(source_fts) AS rank"
        : "NULL AS snippet, 0.0 AS rank";
      const orderBy = queryText ? "ORDER BY rank ASC" : "ORDER BY rowid DESC";

      const querySql = `
        SELECT
          source_id,
          title,
          correspondent,
          document_type,
          document_date,
          tags,
          summary,
          review_status,
          processing_status,
          lifecycle,
          ${snippetExpr}
        FROM source_fts
        ${whereClause}
        ${orderBy}
        LIMIT ? OFFSET ?
      `;

      const pagedRows = db
        .query(querySql)
        .all(...params, limit, offset) as Array<{
        source_id: string;
        title: string;
        correspondent: string | null;
        document_type: string | null;
        document_date: string | null;
        tags: string | null;
        summary: string | null;
        review_status: string;
        processing_status: string;
        lifecycle: string;
        snippet: string | null;
        rank: number;
      }>;

      const matches: SourceSearchResultItem[] = pagedRows.map((r) => ({
        source_id: r.source_id,
        title: r.title,
        correspondent: r.correspondent,
        document_type: r.document_type,
        document_date: r.document_date,
        tags: r.tags ? r.tags.split(/\s+/).filter(Boolean) : [],
        summary: r.summary,
        review_status: r.review_status,
        processing_status: r.processing_status,
        lifecycle: r.lifecycle,
        snippet: r.snippet,
        rank: Number(r.rank ?? 0),
        canonical_uri: `openlia://source/${r.source_id}`,
        markdown_citation: `[${r.title}](openlia://source/${r.source_id})`,
      }));

      return {
        schema: 1,
        total: allRows.length,
        offset,
        limit,
        matches,
        facets: {
          tags: tagCounts,
          correspondents: correspondentCounts,
          document_types: typeCounts,
          review_status: reviewCounts,
          processing_status: processingCounts,
        },
      };
    } catch {
      return this.fallbackSearchSources(options);
    }
  }

  private fallbackSearchSources(options: {
    query?: string | undefined;
    tags?: string[] | undefined;
    correspondent?: string | undefined;
    document_type?: string | undefined;
    review_status?: string | undefined;
    processing_status?: string | undefined;
    lifecycle?: string | undefined;
    date_from?: string | undefined;
    date_to?: string | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  }): SourceSearchResponse {
    const allDocs = this.listAllSources();
    const q = (options.query ?? "").toLowerCase();
    const matchesFilter = (
      doc: SourceRecord,
      includeReview: boolean,
    ): boolean => {
      if (options.correspondent && doc.correspondent !== options.correspondent)
        return false;
      if (options.document_type && doc.document_type !== options.document_type)
        return false;
      if (includeReview && options.review_status) {
        const reviewStatus = doc.review?.status ?? "unreviewed";
        const matchesReviewScope =
          options.review_status === "needs-review"
            ? reviewStatus === "needs-review" || reviewStatus === "unreviewed"
            : reviewStatus === options.review_status;
        if (!matchesReviewScope) return false;
      }
      if (
        options.processing_status &&
        (doc.processing?.status ?? "complete") !== options.processing_status
      )
        return false;
      if (
        options.lifecycle &&
        (doc.lifecycle ?? "active") !== options.lifecycle
      )
        return false;
      if (options.tags && options.tags.length > 0) {
        const docTags = new Set(doc.tags ?? []);
        if (!options.tags.some((t) => docTags.has(t))) return false;
      }
      if (q) {
        const combined = [
          doc.title,
          doc.correspondent,
          doc.document_type,
          ...(doc.tags ?? []),
          doc.summary,
          ...Object.entries(doc.custom_fields ?? {}).map(
            ([k, v]) => `${k} ${v}`,
          ),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!combined.includes(q)) return false;
      }
      return true;
    };
    const reviewFacetDocs = allDocs.filter((doc) => matchesFilter(doc, false));
    const filtered = allDocs.filter((doc) => matchesFilter(doc, true));

    const tagCounts: Record<string, number> = {};
    const correspondentCounts: Record<string, number> = {};
    const typeCounts: Record<string, number> = {};
    const reviewCounts: Record<string, number> = {};
    const processingCounts: Record<string, number> = {};

    for (const d of filtered) {
      for (const t of d.tags ?? []) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
      if (d.correspondent)
        correspondentCounts[d.correspondent] =
          (correspondentCounts[d.correspondent] ?? 0) + 1;
      if (d.document_type)
        typeCounts[d.document_type] = (typeCounts[d.document_type] ?? 0) + 1;
      const proc = d.processing?.status ?? "complete";
      processingCounts[proc] = (processingCounts[proc] ?? 0) + 1;
    }
    for (const d of reviewFacetDocs) {
      const reviewStatus = d.review?.status ?? "unreviewed";
      reviewCounts[reviewStatus] = (reviewCounts[reviewStatus] ?? 0) + 1;
    }

    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const paged = filtered.slice(offset, offset + limit);

    const matches: SourceSearchResultItem[] = paged.map((d) => ({
      source_id: d.id,
      title: d.title,
      correspondent: d.correspondent ?? null,
      document_type: d.document_type ?? null,
      document_date: d.document_date ?? null,
      tags: d.tags ?? [],
      summary: d.summary ?? null,
      review_status: d.review?.status ?? "unreviewed",
      processing_status: d.processing?.status ?? "complete",
      lifecycle: d.lifecycle ?? "active",
      snippet: null,
      rank: 0,
      canonical_uri: `openlia://source/${d.id}`,
      markdown_citation: `[${d.title}](openlia://source/${d.id})`,
    }));

    return {
      schema: 1,
      total: filtered.length,
      offset,
      limit,
      matches,
      facets: {
        tags: tagCounts,
        correspondents: correspondentCounts,
        document_types: typeCounts,
        review_status: reviewCounts,
        processing_status: processingCounts,
      },
    };
  }

  getSource(sourceId: string): SourceDocument {
    if (!safeId.test(sourceId)) throw new Error("invalid source id");
    const record = this.readSource(sourceId);
    if (!record || !record.id) throw new Error("source record not found");

    let extractedText = "";
    const extractions: SourceExtractionItem[] = [];
    const versions = record.versions ?? [];
    const latestVersion =
      versions.length > 0 ? versions[versions.length - 1] : null;
    const versionId = latestVersion?.id as string | undefined;

    if (versionId) {
      for (const baseRoot of [
        join(this.ingestionRoot, "blobs", sourceId, versionId, "extractions"),
        join(
          this.workspaceRoot,
          "sources",
          "artifacts",
          sourceId,
          versionId,
          "extractions",
        ),
      ]) {
        if (!existsSync(baseRoot)) continue;
        for (const extId of orderedExtractionIds(baseRoot, latestVersion)) {
          if (!safeId.test(extId)) continue;
          if (extractions.some((e) => e.extraction_id === extId)) continue;
          const extDir = join(baseRoot, extId);
          if (statSync(extDir, { throwIfNoEntry: false })?.isDirectory()) {
            extractions.push({
              extraction_id: extId,
              version_id: versionId,
              path: `blobs/${sourceId}/${versionId}/extractions/${extId}`,
            });
            for (const candidate of [
              "text.md",
              "transcript.md",
              "tables.json",
            ]) {
              const cp = join(extDir, candidate);
              if (existsSync(cp) && !extractedText) {
                try {
                  extractedText = readFileSync(cp, "utf8");
                } catch {
                  // Ignore read error
                }
              }
            }
          }
        }
      }
    }

    const backlinks = this.findBacklinks(sourceId);

    return {
      id: record.id,
      title: record.title ?? "Source Document",
      kind: record.kind ?? "file",
      document_type: record.document_type ?? null,
      correspondent: record.correspondent ?? null,
      document_date: record.document_date ?? null,
      tags: record.tags ?? [],
      summary: record.summary ?? null,
      processing: {
        status: (record.processing?.status as any) ?? "complete",
        last_job_id: record.processing?.last_job_id ?? null,
        error: record.processing?.error ?? null,
        error_code: record.processing?.error_code ?? null,
        error_summary:
          record.processing?.error_summary ?? record.processing?.error ?? null,
      },
      review: {
        status: (record.review?.status as any) ?? "unreviewed",
        reasons: record.review?.reasons ?? [],
        reviewed_at: record.review?.reviewed_at ?? null,
      },
      lifecycle: (record.lifecycle as any) ?? "active",
      captured_at: record.captured_at ?? new Date().toISOString(),
      password_profile: record.password_profile ?? null,
      origin: record.origin ?? {},
      versions: record.versions ?? [],
      custom_fields: record.custom_fields ?? {},
      canonical_uri: `openlia://source/${sourceId}`,
      markdown_citation: `[${record.title ?? "Source Document"}](openlia://source/${sourceId})`,
      backlinks,
      content: extractedText ? extractedText.slice(0, 50000) : null,
      extractions,
    };
  }

  downloadSourceOriginal(
    sourceId: string,
    versionId?: string | null,
  ): {
    absolute: string;
    filename: string;
    size: number;
    mediaType: string;
  } {
    if (!safeId.test(sourceId)) throw new Error("invalid source id");
    const record = this.readSource(sourceId);
    if (!record) throw new Error("source record not found");
    const versions = record.versions ?? [];
    const selected = versionId
      ? versions.find((v) => v.id === versionId)
      : versions[versions.length - 1];
    if (!selected) throw new Error("source version not found");
    const origRef = stringOrNull(selected.original_ref);
    if (!origRef) throw new Error("source original file not found");
    const abs = this.resolveBlobAbsolutePath(origRef);
    if (!abs || !existsSync(abs)) {
      throw new Error("source original file not found");
    }
    const stat = statSync(abs);
    const filename = stringOrNull(selected.filename) ?? basename(abs);
    const mediaType =
      stringOrNull(selected.media_type) ||
      Bun.file(filename).type ||
      "application/octet-stream";
    return {
      absolute: abs,
      filename,
      size: stat.size,
      mediaType,
    };
  }

  private resolveBlobAbsolutePath(rel: string): string | null {
    const normalized = normalizeBlobRelpath(rel);
    const vaultCandidate = resolve(this.ingestionRoot, normalized);
    if (
      vaultCandidate.startsWith(this.ingestionRoot + sep) &&
      existsSync(vaultCandidate)
    ) {
      return vaultCandidate;
    }
    const legacyCandidate = resolve(
      this.workspaceRoot,
      rel.replace(/^\/+/, ""),
    );
    if (
      legacyCandidate.startsWith(this.workspaceRoot + sep) &&
      existsSync(legacyCandidate)
    ) {
      return legacyCandidate;
    }
    return null;
  }

  updateSource(sourceId: string, updates: SourceUpdateRequest): SourceDocument {
    if (!safeId.test(sourceId)) throw new Error("invalid source id");
    const record = this.readSource(sourceId);
    if (!record || !record.id) throw new Error("source record not found");

    if (updates.title !== undefined) record.title = updates.title;
    if (updates.correspondent !== undefined)
      record.correspondent = updates.correspondent;
    if (updates.document_type !== undefined)
      record.document_type = updates.document_type;
    if (updates.document_date !== undefined)
      record.document_date = updates.document_date;
    if (updates.summary !== undefined) record.summary = updates.summary;
    if (updates.password_profile !== undefined) {
      record.password_profile = updates.password_profile
        ? updates.password_profile.trim()
        : null;
    }
    if (updates.lifecycle !== undefined) record.lifecycle = updates.lifecycle;
    if (updates.tags !== undefined) {
      record.tags = updates.tags
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    }
    if (updates.custom_fields !== undefined) {
      const merged: Record<string, unknown> = {
        ...(record.custom_fields ?? {}),
      };
      for (const [k, v] of Object.entries(updates.custom_fields)) {
        if (v === null || v === undefined || v === "") {
          delete merged[k];
        } else {
          merged[k] = v;
        }
      }
      record.custom_fields = merged;
    }
    if (updates.review) {
      record.review = {
        status: updates.review.status ?? record.review?.status ?? "unreviewed",
        reasons: updates.review.reasons ?? record.review?.reasons ?? [],
        reviewed_at:
          updates.review.status === "reviewed"
            ? new Date().toISOString()
            : (record.review?.reviewed_at ?? null),
      };
    }

    this.saveSourceToVault(record);
    return this.getSource(sourceId);
  }

  upload(
    file: { name: string; data: Uint8Array },
    options?:
      | {
          title?: string | undefined;
          kind?: string | undefined;
          password_profile?: string | null | undefined;
        }
      | undefined,
  ): SourceUploadResponse {
    const rawExt = extname(file.name).toLowerCase();
    const sourceId = `src_${randomBytes(6).toString("hex")}`;
    const versionId = "ver_001";
    const jobId = `job_${randomBytes(6).toString("hex")}`;
    const intakeId = `intake_${randomBytes(6).toString("hex")}`;
    const artifactId = `art_${randomBytes(6).toString("hex")}`;
    const nowIso = new Date().toISOString();
    const nowEpoch = Date.now() / 1000;
    const passwordProfile = options?.password_profile
      ? options.password_profile.trim()
      : null;

    let kind = options?.kind;
    if (!kind) {
      if (rawExt === ".pdf") kind = "pdf";
      else if (rawExt === ".xlsx" || rawExt === ".xls") kind = "excel";
      else if (rawExt === ".csv") kind = "csv";
      else if (
        [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"].includes(
          rawExt,
        )
      )
        kind = "image";
      else if (
        [".txt", ".md", ".json", ".log", ".yaml", ".yml"].includes(rawExt)
      )
        kind = "text";
      else kind = "file";
    }
    if (
      !["chat", "text", "file", "pdf", "image", "excel", "csv"].includes(kind)
    ) {
      throw new Error("unsupported upload kind");
    }

    const title = options?.title ?? (basename(file.name, rawExt) || file.name);

    // 1. Write original blob into the Ingestion Vault (zero writes to workspaceRoot!)
    const extension = /^\.[a-z0-9]{1,12}$/.test(rawExt) ? rawExt : ".bin";
    const artifactRel = `blobs/${sourceId}/${versionId}/original${extension}`;
    const artifactAbs = join(this.ingestionRoot, artifactRel);
    mkdirSync(join(this.ingestionRoot, "blobs", sourceId, versionId), {
      recursive: true,
    });
    writeFileSync(artifactAbs, file.data);

    const sourceRecord: SourceRecord = {
      $schema: "./source-template.schema.json",
      id: sourceId,
      title,
      kind,
      document_type: null,
      correspondent: null,
      document_date: null,
      tags: [],
      summary: null,
      status: "captured",
      processing: {
        status: "captured",
        last_job_id: null,
        updated_at: nowIso,
        error: null,
      },
      review: {
        status: "unreviewed",
        reasons: [],
      },
      lifecycle: "active",
      captured_at: nowIso,
      sensitivity: "personal",
      password_profile: passwordProfile,
      custom_fields: {},
      authorization: { scope: "ingestion", source: "direct-request" },
      origin: {
        channel: "workspace-ui",
        source_url: null,
        provider: null,
        provider_item_id: null,
        message_id: null,
      },
      versions: [
        {
          id: versionId,
          original_artifact_id: artifactId,
          filename: file.name,
          content_sha256: createHash("sha256").update(file.data).digest("hex"),
          media_type: Bun.file(file.name).type || "application/octet-stream",
          size_bytes: file.data.byteLength,
          original_ref: artifactRel,
          received_at: nowIso,
          retained: true,
          extractions: [],
        },
      ],
    };

    const continuation = {
      next_action: "triage",
      conversation_ref: null,
      request_ref: null,
    };
    const intake: IntakeRecord = {
      $schema: "./ingestion-template.schema.json",
      intake_id: intakeId,
      source_id: sourceId,
      version_id: versionId,
      captured_at: nowIso,
      kind,
      operation: "extract",
      requested_outputs: ["text"],
      status: "captured",
      job_id: null,
      continuation,
      authorization: sourceRecord.authorization,
      artifact_refs: [artifactId],
      extraction_refs: [],
      candidate_ids: [],
      record_refs: [],
      retry_count: 0,
      last_error: null,
      unresolved_questions: [],
      callback: { event_id: null, delivery_status: "not_required" },
    };

    const initialContent =
      kind === "text" || [".txt", ".md", ".json", ".csv"].includes(rawExt)
        ? new TextDecoder().decode(file.data.slice(0, 50000))
        : "";

    this.saveSourceToVault(sourceRecord, undefined, initialContent);
    this.saveIntakeToVault(intake);

    const db = this.getDb();
    try {
      if (!db) throw new Error("ingestion queue is unavailable");
      db.transaction(() => {
        db.run(
          `INSERT INTO jobs (
            job_id, idempotency_key, intake_id, source_id, version_id,
            operation, requested_outputs, state, attempts, next_attempt_at,
            created_at, updated_at, continuation, password_profile
          ) VALUES (?, ?, ?, ?, ?, 'extract', '["text"]', 'queued', 0, ?, ?, ?, ?, ?)`,
          [
            jobId,
            `upload_${sourceId}_${versionId}`,
            intakeId,
            sourceId,
            versionId,
            nowEpoch,
            nowEpoch,
            nowEpoch,
            JSON.stringify(continuation),
            passwordProfile,
          ],
        );
        intake.status = "queued";
        intake.job_id = jobId;
        sourceRecord.processing = {
          status: "queued",
          last_job_id: jobId,
          updated_at: nowIso,
          error: null,
        };
        this.saveSourceToVault(sourceRecord, db, initialContent);
        this.saveIntakeToVault(intake, db);
      }).immediate();
    } catch (error) {
      intake.status = "captured";
      intake.job_id = null;
      intake.last_error = "queue_submission_failed";
      sourceRecord.processing = {
        status: "captured",
        last_job_id: null,
        updated_at: nowIso,
        error: "queue_submission_failed",
      };
      this.saveSourceToVault(sourceRecord, db, initialContent);
      this.saveIntakeToVault(intake, db);
      throw new Error(
        `ingestion queue submission failed; retained source ${sourceId} and intake ${intakeId} in vault for recovery`,
        { cause: error },
      );
    }

    return {
      schema: 1,
      ok: true,
      source_id: sourceId,
      version_id: versionId,
      job_id: jobId,
      title,
    };
  }

  retrySource(
    sourceId: string,
    request?: SourceRetryRequest,
  ): SourceRetryResponse {
    if (!safeId.test(sourceId)) throw new Error("invalid source id");
    const record = this.readSource(sourceId);
    if (!record) throw new Error("source record not found");

    const profileId =
      request?.password_profile?.trim() || request?.profile_id?.trim() || null;
    if (request?.password && profileId) {
      this.savePasswordProfile(
        profileId,
        request.label?.trim() || `Unlock ${record.title || sourceId}`,
        request.password,
      );
    } else if (profileId) {
      const profiles = this.listPasswordProfiles();
      if (!profiles.some((p) => p.profile_id === profileId)) {
        throw new Error("password profile was not found");
      }
    }

    const db = this.getDb();
    if (!db) throw new Error("ingestion queue is unavailable");
    const nowEpoch = Date.now() / 1000;
    const nowIso = new Date().toISOString();

    const existingJob = db
      .query(
        "SELECT job_id, intake_id FROM jobs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(sourceId) as { job_id: string; intake_id: string } | null;

    let jobId = existingJob?.job_id;
    const intake = this.listRecords().find((r) => r.source_id === sourceId);
    const intakeId =
      existingJob?.intake_id ||
      intake?.intake_id ||
      `intake_${randomBytes(6).toString("hex")}`;
    const versionId =
      stringOrNull(
        (record.versions ?? [])[
          record.versions?.length ? record.versions.length - 1 : 0
        ]?.id,
      ) ?? "ver_001";

    if (jobId) {
      db.run(
        `UPDATE jobs SET
          state = 'queued',
          password_profile = COALESCE(?, password_profile),
          error_code = NULL,
          error_summary = NULL,
          next_attempt_at = ?,
          updated_at = ?
         WHERE job_id = ?`,
        [profileId, nowEpoch, nowEpoch, jobId],
      );
    } else {
      jobId = `job_${randomBytes(6).toString("hex")}`;
      db.run(
        `INSERT INTO jobs (
          job_id, idempotency_key, intake_id, source_id, version_id,
          operation, requested_outputs, password_profile, state, attempts,
          next_attempt_at, created_at, updated_at, continuation
        ) VALUES (?, ?, ?, ?, ?, 'extract', '["text"]', ?, 'queued', 0, ?, ?, ?, '{}')`,
        [
          jobId,
          `retry_${sourceId}_${Date.now()}`,
          intakeId,
          sourceId,
          versionId,
          profileId,
          nowEpoch,
          nowEpoch,
          nowEpoch,
        ],
      );
    }

    if (profileId) {
      record.password_profile = profileId;
    }
    record.status = "queued";
    record.processing = {
      status: "queued",
      last_job_id: jobId,
      updated_at: nowIso,
      error: null,
      error_code: null,
      error_summary: null,
    };
    this.saveSourceToVault(record, db);

    if (intake) {
      intake.status = "queued";
      intake.job_id = jobId;
      intake.last_error = null;
      this.saveIntakeToVault(intake, db);
    }

    return {
      schema: 1,
      ok: true,
      source_id: sourceId,
      job_id: jobId,
      state: "queued",
    };
  }

  private readPasswordEntries(passwordPath: string): Map<
    string,
    {
      label: string;
      password?: string;
      description?: string;
      hint?: string;
      patterns?: string[];
    }
  > {
    const entries = new Map<
      string,
      {
        label: string;
        password?: string;
        description?: string;
        hint?: string;
        patterns?: string[];
      }
    >();
    if (!existsSync(passwordPath)) return entries;
    try {
      const content = readFileSync(passwordPath, "utf8");
      let currentId: string | null = null;
      let currentData: any = {};
      const pushEntry = () => {
        if (currentId && currentData.label) {
          entries.set(currentId, { ...currentData });
        }
      };

      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        const sectionMatch = line.match(/^\[profiles\.([A-Za-z0-9._-]+)\]$/);
        if (sectionMatch?.[1]) {
          pushEntry();
          currentId = sectionMatch[1];
          currentData = {};
          continue;
        }
        if (!currentId) continue;
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        const rawVal = line.slice(eqIdx + 1).trim();
        let parsedVal: unknown;
        try {
          parsedVal = JSON.parse(rawVal);
        } catch {
          parsedVal = rawVal.replace(/^["']|["']$/g, "");
        }
        if (key === "label" && typeof parsedVal === "string") {
          currentData.label = parsedVal;
        } else if (key === "password" && typeof parsedVal === "string") {
          currentData.password = parsedVal;
        } else if (key === "description" && typeof parsedVal === "string") {
          currentData.description = parsedVal;
        } else if (key === "hint" && typeof parsedVal === "string") {
          currentData.hint = parsedVal;
        } else if (key === "patterns" && Array.isArray(parsedVal)) {
          currentData.patterns = parsedVal.filter((p) => typeof p === "string");
        }
      }
      pushEntry();
      return entries;
    } catch {
      return entries;
    }
  }

  private writePasswordEntries(
    passwordPath: string,
    entries: Map<
      string,
      {
        label: string;
        password?: string;
        description?: string;
        hint?: string;
        patterns?: string[];
      }
    >,
  ): void {
    const lines = ["version = 1", ""];
    for (const key of [...entries.keys()].sort()) {
      const entry = entries.get(key)!;
      lines.push(`[profiles.${key}]`);
      lines.push(`label = ${JSON.stringify(entry.label)}`);
      lines.push(`password = ${JSON.stringify(entry.password ?? "")}`);
      if (entry.description) {
        lines.push(`description = ${JSON.stringify(entry.description)}`);
      }
      if (entry.hint) {
        lines.push(`hint = ${JSON.stringify(entry.hint)}`);
      }
      if (entry.patterns && entry.patterns.length > 0) {
        lines.push(`patterns = ${JSON.stringify(entry.patterns)}`);
      }
      lines.push("");
    }
    writeFileSync(passwordPath, lines.join("\n"), { mode: 0o600 });
    try {
      chmodSync(passwordPath, 0o600);
    } catch {
      // Ignore chmod error on non-POSIX
    }
  }

  listPasswordProfiles(): DocumentPasswordProfile[] {
    const passwordPath = join(this.ingestionRoot, "document-passwords.toml");
    const entries = this.readPasswordEntries(passwordPath);
    const profiles: DocumentPasswordProfile[] = [];
    for (const [profile_id, entry] of entries.entries()) {
      profiles.push({
        profile_id,
        label: entry.label,
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.hint ? { hint: entry.hint } : {}),
        ...(entry.patterns ? { patterns: entry.patterns } : {}),
      });
    }
    return profiles.sort((a, b) => a.profile_id.localeCompare(b.profile_id));
  }

  suggestPasswordProfiles(input: {
    filename?: string | undefined;
    title?: string | undefined;
    correspondent?: string | undefined;
    message?: string | undefined;
  }): PasswordSuggestion[] {
    const profiles = this.listPasswordProfiles();
    return suggestPasswordProfiles(input, profiles);
  }

  savePasswordProfile(
    profileId: string,
    label: string,
    password?: string | null,
    description?: string,
    hint?: string,
    patterns?: string[],
  ): DocumentPasswordProfile {
    if (!profileIdRe.test(profileId)) {
      throw new Error("profile_id must be a safe identifier");
    }
    if (!label.trim() || forbiddenLabelRe.test(label)) {
      throw new Error("profile label is empty or names a service credential");
    }

    mkdirSync(this.ingestionRoot, { recursive: true });
    const passwordPath = join(this.ingestionRoot, "document-passwords.toml");
    const existingEntries = this.readPasswordEntries(passwordPath);

    const existing = existingEntries.get(profileId);
    const effectivePassword = password?.trim() || existing?.password;
    if (!effectivePassword) {
      throw new Error("document password must not be empty");
    }

    const cleanPatterns = patterns
      ?.map((p) => p.trim())
      .filter((p) => p.length > 0);
    existingEntries.set(profileId, {
      label: label.trim(),
      password: effectivePassword,
      ...(description?.trim() ? { description: description.trim() } : {}),
      ...(hint?.trim() ? { hint: hint.trim() } : {}),
      ...(cleanPatterns && cleanPatterns.length > 0
        ? { patterns: cleanPatterns }
        : {}),
    });

    this.writePasswordEntries(passwordPath, existingEntries);

    return {
      profile_id: profileId,
      label: label.trim(),
      ...(description?.trim() ? { description: description.trim() } : {}),
      ...(hint?.trim() ? { hint: hint.trim() } : {}),
      ...(cleanPatterns && cleanPatterns.length > 0
        ? { patterns: cleanPatterns }
        : {}),
    };
  }

  deletePasswordProfile(profileId: string): boolean {
    if (!profileIdRe.test(profileId)) {
      throw new Error("profile_id must be a safe identifier");
    }
    const passwordPath = join(this.ingestionRoot, "document-passwords.toml");
    if (!existsSync(passwordPath)) {
      return false;
    }
    const existingEntries = this.readPasswordEntries(passwordPath);
    if (!existingEntries.has(profileId)) {
      return false;
    }
    existingEntries.delete(profileId);
    this.writePasswordEntries(passwordPath, existingEntries);
    return true;
  }

  findBacklinks(sourceId: string): SourceBacklink[] {
    const backlinks: SourceBacklink[] = [];
    const targetTokens = [
      `openlia://source/${sourceId}`,
      `openlia://sources/${sourceId}`,
    ];

    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        if (
          dir === this.workspaceRoot &&
          ["sources", "node_modules"].includes(entry.name)
        )
          continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (
          [".md", ".rem", ".hledger", ".journal", ".yaml", ".json"].some(
            (ext) => entry.name.endsWith(ext),
          )
        ) {
          try {
            const rel = relative(this.workspaceRoot, fullPath);
            if (rel.startsWith("inbox/ingestion/")) continue;
            const content = readFileSync(fullPath, "utf8");
            if (targetTokens.some((tok) => content.includes(tok))) {
              const parts = rel.split("/");
              const domain =
                (parts.length > 1 ? parts[0] : "workspace") || "workspace";
              let lineNo = 1;
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line && targetTokens.some((tok) => line.includes(tok))) {
                  lineNo = i + 1;
                  break;
                }
              }
              backlinks.push({
                path: rel,
                domain,
                filename: entry.name,
                line_number: lineNo,
              });
            }
          } catch {
            // Ignore unreadable files
          }
        }
      }
    };

    walk(this.workspaceRoot);
    return backlinks.sort((a, b) => a.path.localeCompare(b.path));
  }

  rebuildFts(): { indexed: number } {
    const db = this.getDb();
    if (!db) return { indexed: 0 };
    const allDocs = this.listAllSources();

    db.run("DELETE FROM source_fts;");
    let count = 0;

    for (const doc of allDocs) {
      if (!doc || !doc.id) continue;
      const fullDoc = this.getSource(doc.id);
      this.saveSourceToVault(doc, db, fullDoc.content ?? "");
      count++;
    }

    return { indexed: count };
  }

  private listAllSources(): SourceRecord[] {
    const byId = new Map<string, SourceRecord>();
    const db = this.getDb();
    if (db) {
      try {
        const rows = db
          .query("SELECT record_json FROM sources ORDER BY captured_at DESC")
          .all() as Array<{ record_json: string }>;
        for (const r of rows) {
          try {
            const parsed = JSON.parse(r.record_json);
            if (this.isSource(parsed)) byId.set(parsed.id, parsed);
          } catch {}
        }
      } catch {}
    }

    const fallbackDir = join(this.ingestionRoot, "sources");
    if (existsSync(fallbackDir)) {
      for (const name of readdirSync(fallbackDir)) {
        if (!name.endsWith(".json")) continue;
        const parsed = this.readJson(join(fallbackDir, name));
        if (this.isSource(parsed) && !byId.has(parsed.id)) {
          byId.set(parsed.id, parsed);
        }
      }
    }

    const legacyDir = join(this.workspaceRoot, "sources", "records");
    if (existsSync(legacyDir)) {
      for (const name of readdirSync(legacyDir)) {
        if (!name.endsWith(".md") || name.startsWith("source-template"))
          continue;
        const parsed = this.readFrontmatter(join(legacyDir, name));
        if (this.isSource(parsed) && !byId.has(parsed.id)) {
          byId.set(parsed.id, parsed);
        }
      }
    }

    return [...byId.values()];
  }

  private listRecords(): IntakeRecord[] {
    const byId = new Map<string, IntakeRecord>();
    const db = this.getDb();
    if (db) {
      try {
        const rows = db
          .query("SELECT record_json FROM intakes ORDER BY captured_at DESC")
          .all() as Array<{ record_json: string }>;
        for (const r of rows) {
          try {
            const parsed = JSON.parse(r.record_json);
            if (this.isIntake(parsed)) byId.set(parsed.intake_id, parsed);
          } catch {}
        }
      } catch {}
    }

    const fallbackDir = join(this.ingestionRoot, "intakes");
    if (existsSync(fallbackDir)) {
      for (const name of readdirSync(fallbackDir)) {
        if (!name.endsWith(".json")) continue;
        const parsed = this.readJson(join(fallbackDir, name));
        if (this.isIntake(parsed) && !byId.has(parsed.intake_id)) {
          byId.set(parsed.intake_id, parsed);
        }
      }
    }

    const legacyDir = join(this.workspaceRoot, "inbox", "ingestion");
    if (existsSync(legacyDir)) {
      for (const name of readdirSync(legacyDir)) {
        if (!name.startsWith("intake_") || !name.endsWith(".md")) continue;
        const record = this.readFrontmatter(join(legacyDir, name));
        if (this.isIntake(record) && !byId.has(record.intake_id)) {
          byId.set(record.intake_id, record);
        }
      }
    }

    return [...byId.values()].sort((left, right) =>
      right.captured_at.localeCompare(left.captured_at),
    );
  }

  private readIntake(intakeId: string): IntakeRecord | null {
    if (!safeId.test(intakeId)) return null;
    const db = this.getDb();
    if (db) {
      try {
        const row = db
          .query("SELECT record_json FROM intakes WHERE intake_id = ?")
          .get(intakeId) as { record_json: string } | null;
        if (row?.record_json) {
          const parsed = JSON.parse(row.record_json);
          if (this.isIntake(parsed)) return parsed;
        }
      } catch {}
    }
    const fallbackPath = join(
      this.ingestionRoot,
      "intakes",
      `${intakeId}.json`,
    );
    if (existsSync(fallbackPath)) {
      const parsed = this.readJson(fallbackPath);
      if (this.isIntake(parsed)) return parsed;
    }
    const record = this.readFrontmatter(
      join(this.workspaceRoot, "inbox", "ingestion", `${intakeId}.md`),
    );
    return this.isIntake(record) ? record : null;
  }

  private readSource(sourceId: string): SourceRecord | null {
    if (!safeId.test(sourceId)) return null;
    const db = this.getDb();
    if (db) {
      try {
        const row = db
          .query("SELECT record_json FROM sources WHERE source_id = ?")
          .get(sourceId) as { record_json: string } | null;
        if (row?.record_json) {
          const parsed = JSON.parse(row.record_json);
          if (this.isSource(parsed)) return parsed;
        }
      } catch {}
    }
    const fallbackPath = join(
      this.ingestionRoot,
      "sources",
      `${sourceId}.json`,
    );
    if (existsSync(fallbackPath)) {
      const parsed = this.readJson(fallbackPath);
      if (this.isSource(parsed)) return parsed;
    }
    const record = this.readFrontmatter(
      join(this.workspaceRoot, "sources", "records", `${sourceId}.md`),
    );
    return this.isSource(record) ? record : null;
  }

  private listItem(
    record: IntakeRecord,
    snapshot?: LiveSnapshot,
    sourceOverride?: SourceRecord | null,
  ): IngestionListItem {
    const source = sourceOverride ?? this.readSource(record.source_id);
    const job = snapshot?.jobs.find(
      (candidate) => candidate.intake_id === record.intake_id,
    );
    const event = job
      ? snapshot?.events.find((candidate) => candidate.job_id === job.job_id)
      : undefined;
    const action = event
      ? snapshot?.actions.find(
          (candidate) => candidate.event_id === event.event_id,
        )
      : snapshot?.actions.find(
          (candidate) => candidate.intake_id === record.intake_id,
        );
    const callbackRecord = record.callback ?? {};
    const callback: IngestionCallbackStatus = {
      event_id: stringOrNull(callbackRecord.event_id),
      durable_status: stringOrNull(callbackRecord.delivery_status),
      delivery_state: event?.delivery_state ?? null,
      attempts: event?.attempts,
      last_error: event?.last_error ?? null,
      delivered_at: event?.delivered_at ?? null,
      acknowledged_at: event?.acknowledged_at ?? null,
    };
    return {
      intake_id: record.intake_id,
      source_id: record.source_id,
      version_id: record.version_id,
      captured_at: record.captured_at,
      kind: record.kind,
      operation: record.operation,
      requested_outputs: record.requested_outputs,
      status: displayStatus(record.status, job?.state),
      durable_status: record.status,
      source_title: source?.title ?? "Untitled source",
      source_status: source?.status ?? null,
      source_url: stringOrNull(source?.origin?.source_url),
      source_record_path: `openlia://source/${record.source_id}`,
      intake_record_path: `vault://intakes/${record.intake_id}`,
      job,
      event,
      action,
      callback,
    };
  }

  private artifacts(source: SourceRecord): IngestionArtifact[] {
    const artifacts: IngestionArtifact[] = [];
    for (const version of source.versions ?? []) {
      const versionId = stringOrNull(version.id);
      if (!versionId || !safeId.test(versionId)) continue;
      const originalPath = stringOrNull(version.original_ref);
      if (originalPath) {
        artifacts.push({
          artifact_id: stringOrUndefined(version.original_artifact_id),
          path: originalPath,
          role: "original",
          warnings: [],
        });
      }
      for (const extractionRoot of [
        join(this.ingestionRoot, "blobs", source.id, versionId, "extractions"),
        join(
          this.workspaceRoot,
          "sources",
          "artifacts",
          source.id,
          versionId,
          "extractions",
        ),
      ]) {
        if (!existsSync(extractionRoot)) continue;
        for (const extractionId of readdirSync(extractionRoot)) {
          if (!safeId.test(extractionId)) continue;
          const extractionDirectory = join(extractionRoot, extractionId);
          if (
            !statSync(extractionDirectory, {
              throwIfNoEntry: false,
            })?.isDirectory()
          )
            continue;
          const manifestPath = join(extractionDirectory, "manifest.json");
          const manifest = this.readJson(manifestPath);
          for (const name of readdirSync(extractionDirectory)) {
            if (name === "manifest.json") continue;
            const path = `blobs/${source.id}/${versionId}/extractions/${extractionId}/${name}`;
            if (artifacts.some((a) => a.path === path)) continue;
            artifacts.push({
              artifact_id: stringOrUndefined(manifest?.artifact_id),
              path,
              role: stringOrNull(manifest?.role) ?? name,
              manifest_path: existsSync(manifestPath)
                ? `blobs/${source.id}/${versionId}/extractions/${extractionId}/manifest.json`
                : undefined,
              size_bytes: numberOrUndefined(manifest?.size_bytes),
              complete: booleanOrUndefined(manifest?.complete),
              warnings: arrayOfStrings(manifest?.warnings),
            });
          }
        }
      }
    }
    return artifacts;
  }

  private readLiveState(): LiveState {
    const path = join(this.ingestionRoot, "status.json");
    if (!existsSync(path)) return { available: false, stale: false };
    try {
      if (statSync(path).size > maxSnapshotBytes) {
        return {
          available: false,
          stale: false,
          error: "status_snapshot_too_large",
        };
      }
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isLiveSnapshot(value)) {
        return {
          available: false,
          stale: false,
          error: "invalid_status_snapshot",
        };
      }
      const ageSeconds = Math.max(0, Date.now() / 1000 - value.generated_at);
      return {
        snapshot: value,
        available: true,
        stale: ageSeconds > liveStaleAfterSeconds,
        generatedAt: value.generated_at,
        ageSeconds,
      };
    } catch {
      return {
        available: false,
        stale: false,
        error: "status_snapshot_unavailable",
      };
    }
  }

  private liveResponseFields(live: LiveState) {
    return {
      live_available: live.available,
      live_stale: live.stale,
      ...(live.generatedAt === undefined
        ? {}
        : { live_generated_at: live.generatedAt }),
      ...(live.ageSeconds === undefined
        ? {}
        : { live_age_seconds: live.ageSeconds }),
      ...(live.error === undefined ? {} : { live_error: live.error }),
    };
  }

  private readFrontmatter(path: string): Record<string, unknown> | null {
    try {
      const content = readFileSync(path, "utf8");
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!match?.[1]) return null;
      const value: unknown = YAML.parse(match[1]);
      return isObject(value) ? value : null;
    } catch {
      return null;
    }
  }

  private readJson(path: string): Record<string, unknown> | null {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      return isObject(value) ? value : null;
    } catch {
      return null;
    }
  }

  private isIntake(
    value: Record<string, unknown> | null,
  ): value is IntakeRecord {
    return (
      value !== null &&
      typeof value.intake_id === "string" &&
      safeId.test(value.intake_id) &&
      typeof value.source_id === "string" &&
      safeId.test(value.source_id) &&
      typeof value.version_id === "string" &&
      safeId.test(value.version_id) &&
      typeof value.captured_at === "string" &&
      typeof value.kind === "string" &&
      typeof value.operation === "string" &&
      Array.isArray(value.requested_outputs) &&
      value.requested_outputs.every((item) => typeof item === "string") &&
      (typeof value.status === "string" || value.status === null) &&
      isObject(value.callback)
    );
  }

  private isSource(
    value: Record<string, unknown> | null,
  ): value is SourceRecord {
    return (
      value !== null &&
      typeof value.id === "string" &&
      typeof value.title === "string" &&
      typeof value.kind === "string"
    );
  }
}

function displayStatus(
  durableStatus: string | null,
  liveState?: string,
): string {
  switch (liveState) {
    case "running":
      return "processing";
    case "completed":
      return "complete";
    case "partial":
      return "partial";
    case "queued":
    case "retryable-failure":
    case "awaiting-unlock":
    case "waiting-for-password":
    case "failed":
      return liveState;
    default:
      return durableStatus ?? "unknown";
  }
}

function isLiveSnapshot(value: unknown): value is LiveSnapshot {
  return (
    isObject(value) &&
    value.schema === 1 &&
    typeof value.generated_at === "number" &&
    Number.isFinite(value.generated_at) &&
    isObject(value.job_counts) &&
    Array.isArray(value.jobs) &&
    Array.isArray(value.events) &&
    Array.isArray(value.actions)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function orderedExtractionIds(
  root: string,
  version: Record<string, unknown> | null | undefined,
): string[] {
  const directoryIds = readdirSync(root).filter((id) => safeId.test(id));
  const declaredIds = arrayOfStrings(version?.extractions).filter((id) =>
    safeId.test(id),
  );
  const declared = new Set(declaredIds);
  return [
    ...declaredIds.reverse(),
    ...directoryIds.reverse().filter((id) => !declared.has(id)),
  ];
}

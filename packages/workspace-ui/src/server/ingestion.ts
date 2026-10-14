import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import YAML from "yaml";
import type {
  IngestionArtifact,
  IngestionCallbackStatus,
  IngestionDetailResponse,
  IngestionLiveAction,
  IngestionLiveEvent,
  IngestionLiveJob,
  IngestionListItem,
  IngestionOverviewResponse,
  SourceBacklink,
  SourceDocument,
  SourceExtractionItem,
  SourceSearchFacets,
  SourceSearchResponse,
  SourceSearchResultItem,
  SourceUpdateRequest,
  SourceUploadResponse,
} from "../shared/api";

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
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
}

export class IngestionService {
  readonly workspaceRoot: string;
  readonly ingestionRoot: string;
  private db: Database | null = null;

  constructor(options: IngestionServiceOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.ingestionRoot = resolve(
      options.ingestionRoot ?? join(this.workspaceRoot, "..", "ingestion"),
    );
  }

  private getDb(): Database | null {
    if (this.db) return this.db;
    try {
      if (!existsSync(this.ingestionRoot)) {
        mkdirSync(this.ingestionRoot, { recursive: true });
      }
      const dbPath = join(this.ingestionRoot, "queue.sqlite");
      this.db = new Database(dbPath);
      this.db.run("PRAGMA journal_mode = WAL;");
      this.db.run(`
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
            tokenize = 'unicode61 remove_diacritics 2'
        );
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS jobs (
            job_id TEXT PRIMARY KEY,
            idempotency_key TEXT UNIQUE,
            intake_id TEXT,
            source_id TEXT,
            version_id TEXT,
            operation TEXT,
            requested_outputs TEXT,
            state TEXT,
            lease_owner TEXT,
            lease_expires_at REAL,
            attempts INTEGER,
            next_attempt_at REAL,
            error_code TEXT,
            error_summary TEXT,
            password_profile TEXT,
            continuation TEXT,
            result TEXT,
            heartbeat_at REAL,
            created_at REAL,
            updated_at REAL
        );
      `);
      return this.db;
    } catch {
      return null;
    }
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
        // Prepare FTS5 search query
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

      if (options.review_status) {
        conditions.push("review_status = ?");
        params.push(options.review_status.trim());
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

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Fetch all matching rows for facets and counts
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
        const rev = r.review_status || "unreviewed";
        reviewCounts[rev] = (reviewCounts[rev] ?? 0) + 1;
        const proc = r.processing_status || "captured";
        processingCounts[proc] = (processingCounts[proc] ?? 0) + 1;
      }

      // Fetch paginated results
      const snippetExpr = queryText
        ? "snippet(source_fts, 6, '<mark>', '</mark>', '...', 25) AS snippet, bm25(source_fts) AS rank"
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
    const recordsDir = join(this.workspaceRoot, "sources", "records");
    if (!existsSync(recordsDir)) {
      return {
        schema: 1,
        total: 0,
        offset: options.offset ?? 0,
        limit: options.limit ?? 20,
        matches: [],
        facets: {
          tags: {},
          correspondents: {},
          document_types: {},
          review_status: {},
          processing_status: {},
        },
      };
    }

    const allDocs: SourceRecord[] = [];
    for (const name of readdirSync(recordsDir)) {
      if (!name.endsWith(".md") || name.startsWith("source-template")) continue;
      const doc = this.readFrontmatter(
        join(recordsDir, name),
      ) as SourceRecord | null;
      if (doc && doc.id) allDocs.push(doc);
    }

    const q = (options.query ?? "").toLowerCase();
    const filtered = allDocs.filter((doc) => {
      if (options.correspondent && doc.correspondent !== options.correspondent)
        return false;
      if (options.document_type && doc.document_type !== options.document_type)
        return false;
      if (
        options.review_status &&
        (doc.review?.status ?? "unreviewed") !== options.review_status
      )
        return false;
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
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!combined.includes(q)) return false;
      }
      return true;
    });

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
      const rev = d.review?.status ?? "unreviewed";
      reviewCounts[rev] = (reviewCounts[rev] ?? 0) + 1;
      const proc = d.processing?.status ?? "complete";
      processingCounts[proc] = (processingCounts[proc] ?? 0) + 1;
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
    const filePath = join(
      this.workspaceRoot,
      "sources",
      "records",
      `${sourceId}.md`,
    );
    if (!existsSync(filePath)) throw new Error("source record not found");

    const record = this.readFrontmatter(filePath) as SourceRecord | null;
    if (!record || !record.id) throw new Error("corrupt source record");

    let extractedText = "";
    const extractions: SourceExtractionItem[] = [];
    const versions = record.versions ?? [];
    const latestVersion =
      versions.length > 0 ? versions[versions.length - 1] : null;
    const versionId = latestVersion?.id as string | undefined;

    if (versionId) {
      const extRoot = join(
        this.workspaceRoot,
        "sources",
        "artifacts",
        sourceId,
        versionId,
        "extractions",
      );
      if (existsSync(extRoot)) {
        for (const extId of readdirSync(extRoot)) {
          if (!safeId.test(extId)) continue;
          const extDir = join(extRoot, extId);
          if (statSync(extDir, { throwIfNoEntry: false })?.isDirectory()) {
            extractions.push({
              extraction_id: extId,
              version_id: versionId,
              path: `sources/artifacts/${sourceId}/${versionId}/extractions/${extId}`,
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
        error_code: record.processing?.error_code ?? null,
        error_summary: record.processing?.error_summary ?? null,
      },
      review: {
        status: (record.review?.status as any) ?? "unreviewed",
        reasons: record.review?.reasons ?? [],
        reviewed_at: record.review?.reviewed_at ?? null,
      },
      lifecycle: (record.lifecycle as any) ?? "active",
      captured_at: record.captured_at ?? new Date().toISOString(),
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

  updateSource(sourceId: string, updates: SourceUpdateRequest): SourceDocument {
    if (!safeId.test(sourceId)) throw new Error("invalid source id");
    const filePath = join(
      this.workspaceRoot,
      "sources",
      "records",
      `${sourceId}.md`,
    );
    if (!existsSync(filePath)) throw new Error("source record not found");

    const content = readFileSync(filePath, "utf8");
    const match = content.match(
      /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/,
    );
    if (!match?.[1]) throw new Error("corrupt source record");

    const record = YAML.parse(match[1]) as SourceRecord;
    const body = match[2] ?? "";

    if (updates.title !== undefined) record.title = updates.title;
    if (updates.correspondent !== undefined)
      record.correspondent = updates.correspondent;
    if (updates.document_type !== undefined)
      record.document_type = updates.document_type;
    if (updates.document_date !== undefined)
      record.document_date = updates.document_date;
    if (updates.summary !== undefined) record.summary = updates.summary;
    if (updates.lifecycle !== undefined) record.lifecycle = updates.lifecycle;
    if (updates.tags !== undefined) {
      record.tags = updates.tags
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    }
    if (updates.custom_fields !== undefined) {
      record.custom_fields = {
        ...(record.custom_fields ?? {}),
        ...updates.custom_fields,
      };
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

    const updatedYaml = YAML.stringify(record);
    const updatedFileContent = `---\n${updatedYaml}---\n${body}`;
    writeFileSync(filePath, updatedFileContent, "utf8");

    // Upsert into SQLite FTS
    const db = this.getDb();
    if (db) {
      try {
        db.run("DELETE FROM source_fts WHERE source_id = ?", [sourceId]);
        db.run(
          `INSERT INTO source_fts (
            source_id, title, correspondent, document_type, tags, summary,
            content, document_date, review_status, processing_status, lifecycle
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sourceId,
            record.title ?? "",
            record.correspondent ?? "",
            record.document_type ?? "",
            (record.tags ?? []).join(" "),
            record.summary ?? "",
            "",
            record.document_date ?? "",
            record.review?.status ?? "unreviewed",
            record.processing?.status ?? "complete",
            record.lifecycle ?? "active",
          ],
        );
      } catch {
        // Continue if DB sync fails
      }
    }

    return this.getSource(sourceId);
  }

  upload(
    file: { name: string; data: Uint8Array },
    options?:
      | { title?: string | undefined; kind?: string | undefined }
      | undefined,
  ): SourceUploadResponse {
    const rawExt = extname(file.name).toLowerCase();
    const sourceId = `src_${randomBytes(6).toString("hex")}`;
    const versionId = "ver_001";
    const jobId = `job_${randomBytes(6).toString("hex")}`;
    const nowIso = new Date().toISOString();
    const nowEpoch = Date.now() / 1000;

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

    const title = options?.title ?? (basename(file.name, rawExt) || file.name);

    // 1. Write original artifact
    const artifactRel = `sources/artifacts/${sourceId}/${versionId}/${file.name}`;
    const artifactAbs = join(this.workspaceRoot, artifactRel);
    mkdirSync(
      join(this.workspaceRoot, "sources", "artifacts", sourceId, versionId),
      {
        recursive: true,
      },
    );
    writeFileSync(artifactAbs, file.data);

    // 2. Write source record
    const sourceRecord: SourceRecord = {
      schema: 1,
      id: sourceId,
      title,
      kind,
      document_type: null,
      correspondent: null,
      document_date: null,
      tags: [],
      summary: null,
      processing: {
        status: "queued",
        last_job_id: jobId,
      },
      review: {
        status: "unreviewed",
        reasons: [],
      },
      lifecycle: "active",
      captured_at: nowIso,
      origin: {
        capture_method: "upload",
        filename: file.name,
      },
      versions: [
        {
          id: versionId,
          captured_at: nowIso,
          original_ref: artifactRel,
          extractions: [],
        },
      ],
    };

    const recordDir = join(this.workspaceRoot, "sources", "records");
    mkdirSync(recordDir, { recursive: true });
    const recordFile = join(recordDir, `${sourceId}.md`);
    writeFileSync(
      recordFile,
      `---\n${YAML.stringify(sourceRecord)}---\n\n# ${title}\n`,
      "utf8",
    );

    // 3. Insert job into SQLite jobs table
    const db = this.getDb();
    if (db) {
      try {
        db.run(
          `INSERT INTO jobs (
            job_id, idempotency_key, intake_id, source_id, version_id,
            operation, requested_outputs, state, attempts, next_attempt_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'extract', '["text"]', 'queued', 0, ?, ?, ?)`,
          [
            jobId,
            `upload_${sourceId}_${versionId}`,
            null,
            sourceId,
            versionId,
            nowEpoch,
            nowEpoch,
            nowEpoch,
          ],
        );

        let initialContent = "";
        try {
          if (
            kind === "text" ||
            [".txt", ".md", ".json", ".csv"].includes(rawExt)
          ) {
            initialContent = new TextDecoder().decode(
              file.data.slice(0, 50000),
            );
          }
        } catch {}

        // 4. Upsert into FTS
        db.run(
          `INSERT INTO source_fts (
            source_id, title, correspondent, document_type, tags, summary,
            content, document_date, review_status, processing_status, lifecycle
          ) VALUES (?, ?, '', '', '', '', ?, '', 'unreviewed', 'queued', 'active')`,
          [sourceId, title, initialContent],
        );
      } catch {
        // Continue
      }
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
    const recordsDir = join(this.workspaceRoot, "sources", "records");
    if (!existsSync(recordsDir)) return { indexed: 0 };

    db.run("DELETE FROM source_fts;");
    let count = 0;

    for (const name of readdirSync(recordsDir)) {
      if (!name.endsWith(".md") || name.startsWith("source-template")) continue;
      const doc = this.readFrontmatter(
        join(recordsDir, name),
      ) as SourceRecord | null;
      if (!doc || !doc.id) continue;

      let extractedText = "";
      const versions = doc.versions ?? [];
      const latestVersion =
        versions.length > 0 ? versions[versions.length - 1] : null;
      const versionId = latestVersion?.id as string | undefined;

      if (versionId) {
        const extRoot = join(
          this.workspaceRoot,
          "sources",
          "artifacts",
          doc.id,
          versionId,
          "extractions",
        );
        if (existsSync(extRoot)) {
          for (const extId of readdirSync(extRoot)) {
            const extDir = join(extRoot, extId);
            for (const candidate of [
              "text.md",
              "transcript.md",
              "tables.json",
            ]) {
              const cp = join(extDir, candidate);
              if (existsSync(cp) && !extractedText) {
                try {
                  extractedText = readFileSync(cp, "utf8");
                } catch {}
              }
            }
          }
        }
      }

      db.run(
        `INSERT INTO source_fts (
          source_id, title, correspondent, document_type, tags, summary,
          content, document_date, review_status, processing_status, lifecycle
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          doc.id,
          doc.title ?? "",
          doc.correspondent ?? "",
          doc.document_type ?? "",
          (doc.tags ?? []).join(" "),
          doc.summary ?? "",
          extractedText.slice(0, 50000),
          doc.document_date ?? "",
          doc.review?.status ?? "unreviewed",
          doc.processing?.status ?? "complete",
          doc.lifecycle ?? "active",
        ],
      );
      count++;
    }

    return { indexed: count };
  }

  private listRecords(): IntakeRecord[] {
    const directory = join(this.workspaceRoot, "inbox", "ingestion");
    if (!existsSync(directory)) return [];
    const records: IntakeRecord[] = [];
    for (const name of readdirSync(directory)) {
      if (!name.startsWith("intake_") || !name.endsWith(".md")) continue;
      const record = this.readFrontmatter(join(directory, name));
      if (this.isIntake(record)) records.push(record);
    }
    return records.sort((left, right) =>
      right.captured_at.localeCompare(left.captured_at),
    );
  }

  private readIntake(intakeId: string): IntakeRecord | null {
    const record = this.readFrontmatter(
      join(this.workspaceRoot, "inbox", "ingestion", `${intakeId}.md`),
    );
    return this.isIntake(record) ? record : null;
  }

  private readSource(sourceId: string): SourceRecord | null {
    if (!safeId.test(sourceId)) return null;
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
      source_record_path: `sources/records/${record.source_id}.md`,
      intake_record_path: `inbox/ingestion/${record.intake_id}.md`,
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
      const extractionRoot = join(
        this.workspaceRoot,
        "sources",
        "artifacts",
        source.id,
        versionId,
        "extractions",
      );
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
          const path = `sources/artifacts/${source.id}/${versionId}/extractions/${extractionId}/${name}`;
          artifacts.push({
            artifact_id: stringOrUndefined(manifest?.artifact_id),
            path,
            role: stringOrNull(manifest?.role) ?? name,
            manifest_path: existsSync(manifestPath)
              ? `sources/artifacts/${source.id}/${versionId}/extractions/${extractionId}/manifest.json`
              : undefined,
            size_bytes: numberOrUndefined(manifest?.size_bytes),
            complete: booleanOrUndefined(manifest?.complete),
            warnings: arrayOfStrings(manifest?.warnings),
          });
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

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkspaceHandler } from "./app";

let root = "";
let ingestionRoot = "";
let handler: ReturnType<typeof createWorkspaceHandler>;

function request(path: string): Promise<Response> {
  return handler(new Request(`http://localhost${path}`));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openlia-ingestion-ui-"));
  ingestionRoot = mkdtempSync(join(tmpdir(), "openlia-ingestion-runtime-"));
  mkdirSync(join(root, "inbox", "ingestion"), { recursive: true });
  mkdirSync(join(root, "sources", "records"), { recursive: true });
  for (const [directory, template] of [
    ["sources/records", "source-template"],
    ["inbox/ingestion", "ingestion-template"],
  ]) {
    for (const extension of ["md", "schema.json"]) {
      const path = `${directory}/${template}.${extension}`;
      copyFileSync(
        join(import.meta.dir, "../../../../workspace-template", path),
        join(root, path),
      );
    }
  }
  mkdirSync(
    join(
      root,
      "sources",
      "artifacts",
      "src_1",
      "ver_1",
      "extractions",
      "ext_1",
    ),
    { recursive: true },
  );
  writeFileSync(
    join(root, "inbox", "ingestion", "intake_1.md"),
    `---
intake_id: intake_1
source_id: src_1
version_id: ver_1
captured_at: "2026-10-10T10:00:00Z"
kind: pdf
operation: extract
requested_outputs:
  - text
status: processing
callback:
  event_id: evt_1
  delivery_status: pending
---
# Intake
`,
  );
  writeFileSync(
    join(root, "sources", "records", "src_1.md"),
    `---
id: src_1
kind: pdf
title: Quarterly statement
status: captured
captured_at: "2026-10-10T10:00:00Z"
origin:
  channel: chat
versions:
  - id: ver_1
    original_artifact_id: art_original
    original_ref: sources/artifacts/src_1/ver_1/original.pdf
    extractions:
      - ext_1
---
# Source
`,
  );
  writeFileSync(
    join(root, "sources", "artifacts", "src_1", "ver_1", "original.pdf"),
    "original",
  );
  writeFileSync(
    join(
      root,
      "sources",
      "artifacts",
      "src_1",
      "ver_1",
      "extractions",
      "ext_1",
      "text.md",
    ),
    "extracted",
  );
  writeFileSync(
    join(
      root,
      "sources",
      "artifacts",
      "src_1",
      "ver_1",
      "extractions",
      "ext_1",
      "manifest.json",
    ),
    JSON.stringify({
      artifact_id: "art_text",
      role: "text",
      complete: true,
      warnings: [],
    }),
  );
  writeFileSync(
    join(ingestionRoot, "status.json"),
    JSON.stringify({
      schema: 1,
      generated_at: Date.now() / 1000,
      instance_id: "runtime_1",
      job_counts: { running: 1 },
      jobs: [
        {
          job_id: "job_1",
          intake_id: "intake_1",
          source_id: "src_1",
          version_id: "ver_1",
          operation: "extract",
          requested_outputs: ["text"],
          state: "running",
          attempts: 1,
          error_code: null,
          error_summary: null,
          heartbeat_at: Date.now() / 1000,
          lease_expires_at: Date.now() / 1000 + 90,
          next_attempt_at: null,
          created_at: Date.now() / 1000,
          updated_at: Date.now() / 1000,
        },
      ],
      events: [
        {
          event_id: "evt_1",
          job_id: "job_1",
          event_type: "ingestion.completed",
          delivery_state: "awaiting_ack",
          attempts: 1,
          last_error: null,
          delivered_at: Date.now() / 1000,
          acknowledged_at: null,
          created_at: Date.now() / 1000,
          updated_at: Date.now() / 1000,
        },
      ],
      actions: [],
    }),
  );
  handler = createWorkspaceHandler({ ingestionRoot, workspaceRoot: root });
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
  rmSync(ingestionRoot, { force: true, recursive: true });
});

describe("ingestion HTTP endpoints", () => {
  test("joins durable intake records with live runtime state", async () => {
    const response = await request("/api/workspace/ingestion");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      live_available: boolean;
      intakes: Array<Record<string, unknown>>;
    };
    expect(payload.live_available).toBe(true);
    expect(payload.intakes[0]).toMatchObject({
      intake_id: "intake_1",
      source_title: "Quarterly statement",
      status: "processing",
      job: { state: "running", job_id: "job_1" },
      callback: { delivery_state: "awaiting_ack" },
    });
  });

  test("returns source artifacts and records for an intake detail", async () => {
    const response = await request("/api/workspace/ingestion/intake_1");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      source: { title: string };
      artifacts: Array<{ path: string }>;
    };
    expect(payload.source.title).toBe("Quarterly statement");
    expect(
      payload.artifacts.map((item: { path: string }) => item.path),
    ).toEqual([
      "blobs/src_1/ver_1/original.pdf",
      "blobs/src_1/ver_1/extractions/ext_1/text.md",
    ]);
  });

  test("falls back to durable records when runtime state is unavailable", async () => {
    rmSync(join(ingestionRoot, "status.json"));
    const response = await request("/api/workspace/ingestion");
    const payload = (await response.json()) as {
      live_available: boolean;
      intakes: Array<{ status: string }>;
    };
    expect(payload.live_available).toBe(false);
    expect(payload.intakes[0]?.status).toBe("processing");
  });

  test("gets source document with extractions, citation, and backlinks", async () => {
    // Write a note referencing the source
    mkdirSync(join(root, "tasks"), { recursive: true });
    writeFileSync(
      join(root, "tasks", "review-taxes.md"),
      "# Tax review\nSee [Quarterly statement](openlia://source/src_1) for details.\n",
    );

    const response = await request("/api/workspace/ingestion/sources/src_1");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      id: string;
      title: string;
      canonical_uri: string;
      content: string;
      backlinks: Array<{ path: string; domain: string }>;
      extractions: Array<{ extraction_id: string }>;
    };
    expect(payload.id).toBe("src_1");
    expect(payload.title).toBe("Quarterly statement");
    expect(payload.canonical_uri).toBe("openlia://source/src_1");
    expect(payload.content).toBe("extracted");
    expect(payload.extractions.length).toBe(1);
    expect(payload.backlinks.length).toBe(1);
    expect(payload.backlinks[0]?.path).toBe("tasks/review-taxes.md");
    expect(payload.backlinks[0]?.domain).toBe("tasks");
  });

  test("updates source document metadata, custom fields, and review status", async () => {
    const patchRes = await handler(
      new Request("http://localhost/api/workspace/ingestion/sources/src_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          correspondent: "ACME Corp",
          document_type: "statement",
          tags: ["finance", "q3"],
          custom_fields: {
            invoice_number: "INV-2026-01",
            total_amount: 1450.0,
          },
          review: {
            status: "reviewed",
            reasons: [],
          },
        }),
      }),
    );
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as {
      correspondent: string;
      document_type: string;
      tags: string[];
      custom_fields: Record<string, unknown>;
      review: { status: string };
    };
    expect(updated.correspondent).toBe("ACME Corp");
    expect(updated.document_type).toBe("statement");
    expect(updated.tags).toEqual(["finance", "q3"]);
    expect(updated.custom_fields).toEqual({
      invoice_number: "INV-2026-01",
      total_amount: 1450,
    });
    expect(updated.review.status).toBe("reviewed");
  });

  test("uploads text document into the Ingestion Vault without writing workspace files", async () => {
    const uploadRes = await handler(
      new Request("http://localhost/api/workspace/ingestion/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Service Contract",
          content: "Service agreement terms and conditions for 2026",
          kind: "text",
        }),
      }),
    );
    expect(uploadRes.status).toBe(200);
    const uploadPayload = (await uploadRes.json()) as {
      ok: boolean;
      source_id: string;
      version_id: string;
      job_id: string;
    };
    expect(uploadPayload.ok).toBe(true);
    expect(uploadPayload.source_id.startsWith("src_")).toBe(true);
    expect(uploadPayload.job_id.startsWith("job_")).toBe(true);

    // Zero workspace footprint: no new files written into workspace/sources/records or inbox/ingestion
    expect(
      existsSync(join(root, `sources/records/${uploadPayload.source_id}.md`)),
    ).toBe(false);

    const db = new Database(join(ingestionRoot, "vault.sqlite"), {
      readonly: true,
    });
    const job = db
      .query("SELECT * FROM jobs WHERE job_id = ?")
      .get(uploadPayload.job_id) as {
      intake_id: string;
      continuation: string;
      lease_generation: number;
    };
    expect(job.intake_id.startsWith("intake_")).toBe(true);
    expect(JSON.parse(job.continuation).next_action).toBe("triage");
    expect(job.lease_generation).toBe(0);
    expect(existsSync(join(root, `inbox/ingestion/${job.intake_id}.md`))).toBe(
      false,
    );

    const sourceRow = db
      .query("SELECT record_json FROM sources WHERE source_id = ?")
      .get(uploadPayload.source_id) as { record_json: string };
    db.close();
    const source = JSON.parse(sourceRow.record_json);
    const original = readFileSync(
      join(ingestionRoot, source.versions[0].original_ref),
    );
    expect(source.versions[0].content_sha256).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
    expect(source.versions[0].media_type).toBe("text/plain;charset=utf-8");

    // Verify it is searchable
    const searchRes = await request(
      `/api/workspace/ingestion/search?q=agreement`,
    );
    expect(searchRes.status).toBe(200);
    const searchPayload = (await searchRes.json()) as {
      total: number;
      matches: Array<{ source_id: string; title: string }>;
    };
    expect(searchPayload.total).toBeGreaterThanOrEqual(1);
    expect(
      searchPayload.matches.some(
        (m) => m.source_id === uploadPayload.source_id,
      ),
    ).toBe(true);

    const needsReviewRes = await request(
      "/api/workspace/ingestion/search?review_status=needs-review&lifecycle=active",
    );
    expect(needsReviewRes.status).toBe(200);
    const needsReviewPayload = (await needsReviewRes.json()) as {
      total: number;
      matches: Array<{ source_id: string; review_status: string }>;
      facets: { review_status: Record<string, number> };
    };
    expect(needsReviewPayload.total).toBeGreaterThanOrEqual(1);
    expect(
      needsReviewPayload.matches.some(
        (m) =>
          m.source_id === uploadPayload.source_id &&
          m.review_status === "unreviewed",
      ),
    ).toBe(true);

    const markNeedsReviewRes = await handler(
      new Request(
        `http://localhost/api/workspace/ingestion/sources/${uploadPayload.source_id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            review: { status: "needs-review", reasons: ["OCR warning"] },
          }),
        },
      ),
    );
    expect(markNeedsReviewRes.status).toBe(200);

    const markReviewedRes = await handler(
      new Request(
        `http://localhost/api/workspace/ingestion/sources/${uploadPayload.source_id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            review: { status: "reviewed", reasons: [] },
          }),
        },
      ),
    );
    expect(markReviewedRes.status).toBe(200);
  });

  test("uploads an image, streams raw original with HTTP Range support, and supports password unlock retry", async () => {
    const data = readFileSync(
      join(import.meta.dir, "../../../../tests/fixtures/ingestion/sample.jpg"),
    );
    const form = new FormData();
    form.append(
      "files",
      new File([data], "receipt.jpg", { type: "image/jpeg" }),
    );
    const response = await handler(
      new Request("http://localhost/api/workspace/ingestion/upload", {
        method: "POST",
        body: form,
      }),
    );
    expect(response.status).toBe(200);
    const upload = (await response.json()) as { source_id: string };
    expect(
      existsSync(join(root, `sources/records/${upload.source_id}.md`)),
    ).toBe(false);

    const detailRes = await request(
      `/api/workspace/ingestion/sources/${upload.source_id}`,
    );
    expect(detailRes.status).toBe(200);
    const source = (await detailRes.json()) as {
      kind: string;
      versions: Array<{
        media_type: string;
        content_sha256: string;
        original_ref: string;
      }>;
    };
    expect(source.kind).toBe("image");
    expect(source.versions[0]?.media_type).toBe("image/jpeg");
    expect(source.versions[0]?.content_sha256).toBe(
      createHash("sha256").update(data).digest("hex"),
    );
    expect(
      readFileSync(join(ingestionRoot, source.versions[0]!.original_ref)),
    ).toEqual(data);

    // Stream raw original with HTTP Range header
    const rangeRes = await handler(
      new Request(
        `http://localhost/api/workspace/ingestion/sources/${upload.source_id}/raw`,
        {
          headers: { Range: "bytes=0-15" },
        },
      ),
    );
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("content-range")).toBe(
      `bytes 0-15/${data.byteLength}`,
    );
    const sliceBytes = new Uint8Array(await rangeRes.arrayBuffer());
    expect(sliceBytes).toEqual(new Uint8Array(data.subarray(0, 16)));

    // Save a password profile and retry source extraction
    const savePassRes = await handler(
      new Request("http://localhost/api/workspace/ingestion/passwords", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile_id: "statement_pin",
          label: "Statement PIN",
          password: "secret-password",
        }),
      }),
    );
    expect(savePassRes.status).toBe(200);

    const listPassRes = await request("/api/workspace/ingestion/passwords");
    expect(listPassRes.status).toBe(200);
    const passList = (await listPassRes.json()) as {
      profiles: Array<{ profile_id: string; label: string }>;
    };
    expect(passList.profiles).toEqual([
      {
        profile_id: "statement_pin",
        label: "Statement PIN",
      },
    ]);

    const retryRes = await handler(
      new Request(
        `http://localhost/api/workspace/ingestion/sources/${upload.source_id}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile_id: "statement_pin" }),
        },
      ),
    );
    expect(retryRes.status).toBe(200);
    const retryPayload = (await retryRes.json()) as {
      ok: boolean;
      job_id: string;
    };
    expect(retryPayload.ok).toBe(true);
    expect(retryPayload.job_id.startsWith("job_")).toBe(true);
  });

  test.each([
    "unavailable",
    "insert failure",
  ])("reports queue %s and retains a recoverable intake in the Vault", async (failure) => {
    if (failure === "unavailable") {
      writeFileSync(join(ingestionRoot, "vault.sqlite"), "not a database");
    } else {
      await request("/api/workspace/ingestion/search");
      const db = new Database(join(ingestionRoot, "vault.sqlite"));
      db.run(`CREATE TRIGGER reject_upload BEFORE INSERT ON jobs
          BEGIN SELECT RAISE(ABORT, 'queue submission rejected'); END`);
      db.close();
    }
    const response = await handler(
      new Request("http://localhost/api/workspace/ingestion/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Retain this document", kind: "text" }),
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "upload_failed",
    });

    if (failure === "unavailable") {
      const recoveryIntakesDir = join(ingestionRoot, "intakes");
      const intakeName = readdirSync(recoveryIntakesDir).find(
        (name) => name.startsWith("intake_") && name !== "intake_1.json",
      );
      expect(intakeName).toBeDefined();
      const intake = JSON.parse(
        readFileSync(join(recoveryIntakesDir, intakeName!), "utf8"),
      );
      expect(intake.status).toBe("captured");
      expect(intake.job_id).toBeNull();
      expect(intake.last_error).toBe("queue_submission_failed");
      const source = JSON.parse(
        readFileSync(
          join(ingestionRoot, "sources", `${intake.source_id}.json`),
          "utf8",
        ),
      );
      expect(source.processing.status).toBe("captured");
      expect(
        readFileSync(
          join(ingestionRoot, source.versions[0].original_ref),
          "utf8",
        ),
      ).toBe("Retain this document");
    } else {
      const db = new Database(join(ingestionRoot, "vault.sqlite"), {
        readonly: true,
      });
      const intakeRow = db
        .query(
          "SELECT record_json FROM intakes WHERE intake_id != 'intake_1' LIMIT 1",
        )
        .get() as { record_json: string } | null;
      expect(intakeRow).not.toBeNull();
      const intake = JSON.parse(intakeRow!.record_json);
      expect(intake.status).toBe("captured");
      expect(intake.job_id).toBeNull();
      expect(intake.last_error).toBe("queue_submission_failed");
      const sourceRow = db
        .query("SELECT record_json FROM sources WHERE source_id = ?")
        .get(intake.source_id) as { record_json: string } | null;
      db.close();
      expect(sourceRow).not.toBeNull();
      const source = JSON.parse(sourceRow!.record_json);
      expect(source.processing.status).toBe("captured");
      expect(
        readFileSync(
          join(ingestionRoot, source.versions[0].original_ref),
          "utf8",
        ),
      ).toBe("Retain this document");
    }
  });

  test("uploads protected fixtures with assigned passwords, suggests profiles, and updates metadata", async () => {
    const pdfFixturePath = resolve(
      import.meta.dir,
      "../../../../tests/fixtures/ingestion/sample_protected.pdf",
    );
    const xlsxFixturePath = resolve(
      import.meta.dir,
      "../../../../tests/fixtures/ingestion/sample_protected.xlsx",
    );
    expect(existsSync(pdfFixturePath)).toBe(true);
    expect(existsSync(xlsxFixturePath)).toBe(true);

    const pdfBytes = readFileSync(pdfFixturePath);
    const xlsxBytes = readFileSync(xlsxFixturePath);

    // 1. Save a password profile with description, hint, and patterns
    const saveRes = await handler(
      new Request("http://localhost/api/workspace/ingestion/passwords", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile_id: "pdf_vault_profile",
          label: "PDF Vault Key",
          password: "openlia",
          description: "Vault key for encrypted PDF reports and audits",
          hint: "Vault unlock passphrase",
          patterns: ["*protected*.pdf", "*report*"],
        }),
      }),
    );
    expect(saveRes.status).toBe(200);

    // 2. Query smart suggestion endpoint
    const suggestRes = await request(
      "/api/workspace/ingestion/passwords/suggest?filename=sample_protected.pdf",
    );
    expect(suggestRes.status).toBe(200);
    const suggestBody = (await suggestRes.json()) as {
      ok: boolean;
      suggestions: Array<{
        profile: { profile_id: string; hint?: string };
        score: number;
      }>;
    };
    expect(suggestBody.ok).toBe(true);
    expect(suggestBody.suggestions.length).toBeGreaterThan(0);
    expect(suggestBody.suggestions[0]!.profile.profile_id).toBe(
      "pdf_vault_profile",
    );
    expect(suggestBody.suggestions[0]!.profile.hint).toBe(
      "Vault unlock passphrase",
    );
    expect(suggestBody.suggestions[0]!.score).toBeGreaterThanOrEqual(50);

    // 3. Upload sample_protected.pdf with pre-assigned password_profile
    const pdfForm = new FormData();
    pdfForm.append(
      "file",
      new Blob([pdfBytes], { type: "application/pdf" }),
      "sample_protected.pdf",
    );
    pdfForm.append("password_profile", "pdf_vault_profile");

    const uploadPdfRes = await handler(
      new Request("http://localhost/api/workspace/ingestion/upload", {
        method: "POST",
        body: pdfForm,
      }),
    );
    expect(uploadPdfRes.status).toBe(200);
    const pdfUpload = (await uploadPdfRes.json()) as {
      ok: boolean;
      source_id: string;
      job_id: string;
    };
    expect(pdfUpload.ok).toBe(true);

    // Verify source and job in DB have password_profile
    const sourceRes = await request(
      `/api/workspace/ingestion/sources/${pdfUpload.source_id}`,
    );
    const sourceData = (await sourceRes.json()) as {
      password_profile?: string;
    };
    expect(sourceData.password_profile).toBe("pdf_vault_profile");

    const db = new Database(join(ingestionRoot, "vault.sqlite"), {
      readonly: true,
    });
    const jobRow = db
      .query("SELECT password_profile FROM jobs WHERE job_id = ?")
      .get(pdfUpload.job_id) as { password_profile: string } | null;
    db.close();
    expect(jobRow?.password_profile).toBe("pdf_vault_profile");

    // 4. Upload sample_protected.xlsx with inline password creation
    const xlsxForm = new FormData();
    xlsxForm.append(
      "file",
      new Blob([xlsxBytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "sample_protected.xlsx",
    );
    xlsxForm.append("password", "openlia");
    xlsxForm.append("password_label", "Protected Financials");
    xlsxForm.append("password_hint", "Excel master key");
    xlsxForm.append("password_description", "Quarterly protected excel sheets");

    const uploadXlsxRes = await handler(
      new Request("http://localhost/api/workspace/ingestion/upload", {
        method: "POST",
        body: xlsxForm,
      }),
    );
    expect(uploadXlsxRes.status).toBe(200);
    const xlsxUpload = (await uploadXlsxRes.json()) as {
      ok: boolean;
      source_id: string;
      job_id: string;
    };
    expect(xlsxUpload.ok).toBe(true);

    const xlsxSourceRes = await request(
      `/api/workspace/ingestion/sources/${xlsxUpload.source_id}`,
    );
    const xlsxSourceData = (await xlsxSourceRes.json()) as {
      password_profile?: string;
      kind: string;
    };
    expect(xlsxSourceData.kind).toBe("excel");
    expect(xlsxSourceData.password_profile).toBe("protected_financials");

    // 5. Test updating password_profile via PATCH /sources/:id
    const patchRes = await handler(
      new Request(
        `http://localhost/api/workspace/ingestion/sources/${pdfUpload.source_id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password_profile: "protected_financials" }),
        },
      ),
    );
    expect(patchRes.status).toBe(200);
    const patchedData = (await patchRes.json()) as {
      password_profile?: string;
    };
    expect(patchedData.password_profile).toBe("protected_financials");

    // 6. Test multipart upload with per-file password mappings
    const multiForm = new FormData();
    multiForm.append(
      "files",
      new Blob([Buffer.from("file 1 content")], { type: "text/plain" }),
      "batch_doc1.txt",
    );
    multiForm.append(
      "files",
      new Blob([Buffer.from("file 2 content")], { type: "text/plain" }),
      "batch_doc2.txt",
    );
    multiForm.append(
      "file_password_profiles",
      JSON.stringify({ "batch_doc1.txt": "pdf_vault_profile" }),
    );
    multiForm.append(
      "file_passwords",
      JSON.stringify({ "batch_doc2.txt": "batch_secret_2" }),
    );

    const multiUploadRes = await handler(
      new Request("http://localhost/api/workspace/ingestion/upload", {
        method: "POST",
        body: multiForm,
      }),
    );
    expect(multiUploadRes.status).toBe(200);
    const multiUploadPayload = (await multiUploadRes.json()) as any;
    expect(multiUploadPayload.ok).toBe(true);
    expect(multiUploadPayload.uploads.length).toBe(2);

    const doc1Source = (await (
      await request(
        `/api/workspace/ingestion/sources/${multiUploadPayload.uploads[0].source_id}`,
      )
    ).json()) as any;
    expect(doc1Source.password_profile).toBe("pdf_vault_profile");

    const doc2Source = (await (
      await request(
        `/api/workspace/ingestion/sources/${multiUploadPayload.uploads[1].source_id}`,
      )
    ).json()) as any;
    expect(doc2Source.password_profile).toBeDefined();
    expect(doc2Source.password_profile.startsWith("cred_")).toBe(true);
  });

  test("supports document password profile CRUD operations (create, update without password, delete)", async () => {
    // 1. Create a password profile
    const createRes = await handler(
      new Request("http://localhost/api/workspace/ingestion/passwords", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile_id: "crud_profile",
          label: "Initial Label",
          password: "my-secure-password",
          description: "Initial description",
          hint: "Initial hint",
          patterns: ["*initial*"],
        }),
      }),
    );
    expect(createRes.status).toBe(200);
    const createData = (await createRes.json()) as any;
    expect(createData.ok).toBe(true);
    expect(createData.profile.label).toBe("Initial Label");

    // 2. Update without password (retain existing password)
    const updateRes = await handler(
      new Request("http://localhost/api/workspace/ingestion/passwords", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile_id: "crud_profile",
          label: "Updated Label",
          description: "Updated description",
          hint: "Updated hint",
          patterns: ["*updated*"],
        }),
      }),
    );
    expect(updateRes.status).toBe(200);
    const updateData = (await updateRes.json()) as any;
    expect(updateData.profile.label).toBe("Updated Label");
    expect(updateData.profile.hint).toBe("Updated hint");

    // Verify TOML kept the password
    const tomlPath = join(ingestionRoot, "document-passwords.toml");
    const tomlContent = readFileSync(tomlPath, "utf8");
    expect(tomlContent).toContain('password = "my-secure-password"');
    expect(tomlContent).toContain('label = "Updated Label"');

    // 3. Delete the profile
    const deleteRes = await handler(
      new Request(
        "http://localhost/api/workspace/ingestion/passwords/crud_profile",
        {
          method: "DELETE",
        },
      ),
    );
    expect(deleteRes.status).toBe(200);
    const deleteData = (await deleteRes.json()) as any;
    expect(deleteData.ok).toBe(true);
    expect(deleteData.deleted).toBe("crud_profile");

    // 4. Verify gone from list
    const listRes = await handler(
      new Request("http://localhost/api/workspace/ingestion/passwords"),
    );
    const listData = (await listRes.json()) as any;
    expect(
      listData.profiles.some((p: any) => p.profile_id === "crud_profile"),
    ).toBe(false);

    // 5. Deleting nonexistent profile returns 404
    const notFoundRes = await handler(
      new Request(
        "http://localhost/api/workspace/ingestion/passwords/crud_profile",
        {
          method: "DELETE",
        },
      ),
    );
    expect(notFoundRes.status).toBe(404);
  });

  test("supports version replacement, soft archive filtering, and cascade deletion with backlink annotations", async () => {
    // 1. Initial upload
    const v1Res = await handler(
      new Request("http://localhost/api/workspace/ingestion/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Master Service Agreement v1",
          title: "MSA Contract",
          kind: "text",
        }),
      }),
    );
    expect(v1Res.status).toBe(200);
    const v1Data = (await v1Res.json()) as any;
    expect(v1Data.ok).toBe(true);
    const sourceId = v1Data.source_id;
    const v1Id = v1Data.version_id;

    // Create a workspace markdown note citing the document with pinned version
    const notePath = join(root, "contracts.md");
    writeFileSync(
      notePath,
      `# Legal\nReview [MSA Agreement](openlia://source/${sourceId}#${v1Id}/p1).\n`,
    );

    // 2. Upload replacement version without purge
    const v2Res = await handler(
      new Request("http://localhost/api/workspace/ingestion/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Master Service Agreement v2 terms",
          target_source_id: sourceId,
          kind: "text",
        }),
      }),
    );
    expect(v2Res.status).toBe(200);
    const v2Data = (await v2Res.json()) as any;
    expect(v2Data.replaced_existing).toBe(true);
    expect(v2Data.source_id).toBe(sourceId);
    expect(v2Data.version_id).not.toBe(v1Id);
    expect(v2Data.stale_backlinks.length).toBe(1);
    expect(v2Data.stale_backlinks[0].pinned_version_id).toBe(v1Id);

    // Verify both versions exist
    const docRes = await handler(
      new Request(
        `http://localhost/api/workspace/ingestion/sources/${sourceId}`,
      ),
    );
    expect(docRes.status).toBe(200);
    const docData = (await docRes.json()) as any;
    expect(docData.versions.length).toBe(2);

    // Version-specific reads must return the selected extraction, not latest content.
    for (const [versionId, content] of [
      [v1Id, "extracted content from version one"],
      [v2Data.version_id, "extracted content from version two"],
    ]) {
      const extractionDir = join(
        ingestionRoot,
        "blobs",
        sourceId,
        versionId,
        "extractions",
        `ext_${versionId}`,
      );
      mkdirSync(extractionDir, { recursive: true });
      writeFileSync(join(extractionDir, "text.md"), content);
    }
    const selectedV1Res = await handler(
      new Request(
        `http://localhost/api/workspace/ingestion/sources/${sourceId}?version_id=${v1Id}`,
      ),
    );
    expect(selectedV1Res.status).toBe(200);
    expect(((await selectedV1Res.json()) as any).content).toContain(
      "extracted content from version one",
    );

    // 3. Test soft-archiving & search filtering
    const searchActive = await handler(
      new Request("http://localhost/api/workspace/ingestion/search?query=MSA"),
    );
    const activeData = (await searchActive.json()) as any;
    expect(activeData.total).toBe(1);

    // Archive document
    const archiveRes = await handler(
      new Request(
        `http://localhost/api/workspace/ingestion/sources/${sourceId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lifecycle: "archived" }),
        },
      ),
    );
    expect(archiveRes.status).toBe(200);

    // Default search hides archived
    const searchDefault = await handler(
      new Request("http://localhost/api/workspace/ingestion/search?query=MSA"),
    );
    expect(((await searchDefault.json()) as any).total).toBe(0);

    // Explicit search includes archived
    const searchAll = await handler(
      new Request(
        "http://localhost/api/workspace/ingestion/search?query=MSA&lifecycle=all",
      ),
    );
    expect(((await searchAll.json()) as any).total).toBe(1);

    // Restore to active
    await handler(
      new Request(
        `http://localhost/api/workspace/ingestion/sources/${sourceId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lifecycle: "active" }),
        },
      ),
    );

    // 4. Cascade delete source
    const crossOriginDelete = await handler(
      new Request(
        `http://localhost/api/workspace/ingestion/sources/${sourceId}`,
        {
          method: "DELETE",
          headers: { Origin: "https://untrusted.example" },
        },
      ),
    );
    expect(crossOriginDelete.status).toBe(403);
    expect(await crossOriginDelete.json()).toMatchObject({
      error: "origin_not_allowed",
    });

    const deleteRes = await handler(
      new Request(
        `http://localhost/api/workspace/ingestion/sources/${sourceId}?annotate_backlinks=true`,
        {
          method: "DELETE",
        },
      ),
    );
    expect(deleteRes.status).toBe(200);
    const deleteData = (await deleteRes.json()) as any;
    expect(deleteData.ok).toBe(true);
    expect(deleteData.deleted).toBe(true);
    expect(deleteData.annotated_files).toContain("contracts.md");

    // Workspace note has been annotated
    const updatedNote = readFileSync(notePath, "utf8");
    expect(updatedNote).toContain(`(deleted source: ${sourceId})`);
    expect(updatedNote).not.toContain(`openlia://source/${sourceId}`);

    // Source is 404
    const getDeleted = await handler(
      new Request(
        `http://localhost/api/workspace/ingestion/sources/${sourceId}`,
      ),
    );
    expect(getDeleted.status).toBe(404);

    // Blobs directory completely removed
    const sourceBlobDir = join(ingestionRoot, "blobs", sourceId);
    expect(existsSync(sourceBlobDir)).toBe(false);

    const missingDelete = await handler(
      new Request(
        "http://localhost/api/workspace/ingestion/sources/src_missing_source",
        { method: "DELETE" },
      ),
    );
    expect(missingDelete.status).toBe(404);
  });
});

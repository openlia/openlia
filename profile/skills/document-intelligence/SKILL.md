---
name: document-intelligence
description: Capture, unlock, OCR, search, and inspect evidence documents in the OpenLia Ingestion Vault across embedded and standalone deployments.
version: 0.2.0
platforms: [macos, linux]
required_environment_variables: []
required_credential_files: []
metadata:
  hermes:
    tags: [personal-os, documents, ingestion, ocr, vault]
    category: productivity
---

# Document Intelligence

## When to Use

- Use when a user shares a file, PDF, receipt, statement, spreadsheet, image, or URL via a messaging platform (Telegram, Discord, Slack) or chat and wants it durably captured, unlocked, extracted, or searched.
- Use when a captured PDF or document is password-protected (`awaiting-unlock` / `password_required`) and needs smart password profile resolution or user-assisted password setup.
- Use when inspecting multi-page documents, OCR transcripts, tables, or structured `custom_fields` in the Ingestion Vault before handing off to [Inbox Triage](openlia://skills/inbox-triage) or [Personal Finance](openlia://skills/personal-finance).

## Operating Model & Dual-Mode Boundary

- **Separation Principle**: Retained source files, extracted Markdown/tables, and password profiles live permanently in the **Ingestion Vault** (`OPENLIA_INGESTION_ROOT` or a standalone remote Ingestion service via `OPENLIA_INGESTION_URL`). They do **not** create binary or raw files inside `/opt/data/workspace`.
- **Single Tool Surface**: Always use the `openlia-ingestion` plugin tools (`ingestion_capture`, `ingestion_status`, `ingestion_suggest_passwords`, `retry_ingestion_with_password_profile`, `save_document_password`, `list_document_password_profiles`, `delete_document_password_profile`, `ingestion_search`, `ingestion_get_document`, `ingestion_update_document`, `ingestion_tag`). Whether Ingestion runs embedded in-process or as a separately hosted standalone HTTP service, the plugin transparently handles file transfer, authentication, and local workspace backlink resolution.
- **Canonical Citations**: Reference Vault sources in workspace notes, reviews, and `hledger` journals using canonical URIs:
  - Markdown: `[Document Title](openlia://source/{source_id}#{version_id}/p{page})`
  - hledger comment: `; source: openlia://source/{source_id}#{version_id}/p{page}`

## Procedures

### 1. Single-Turn Conversational Capture

When a user shares a file, image, or document in chat:
1. Call `ingestion_capture` with:
   - `kind`: `"pdf"`, `"image"`, `"excel"`, `"csv"`, `"file"`, `"text"`, or `"youtube"`
   - `file_path`: local attachment path (or `content` / `url`)
   - `title`: descriptive title or filename
   - `correspondent`: sender or institution if known (e.g. `"Vietcombank"`, `"ACME Corp"`)
   - `request_ref`: user's message text or caption (used for smart password matching)
   - `wait_seconds=15`: waits inline for fast extraction and auto-tagging to complete in a single turn
   - `auto_unlock=True`: automatically tests the top high-confidence password profile (`score >= 70`) when filename/correspondent/message hints match
2. Inspect the returned `state`:
   - **`completed` or `partial`**: Extraction and auto-tagging (`tags`, `summary`, `custom_fields`, `canonical_uri`, `markdown_citation`) are immediately available in the response. Proceed directly to answering the user or handing off to domain workflows.
   - **`awaiting-unlock`**: Proceed to **Smart Password Resolution** below.
   - **`queued` or `processing`**: The document is large and still processing in the background. Inform the user that capture is durable (`source_id`) and check progress later with `ingestion_status(source_id=...)`.

### 2. Smart Password Resolution (`awaiting-unlock`)

Never store raw passwords in workspace Markdown files, chat summaries, or memory. Always use named password profiles in the Vault (`save_document_password`).

1. **Inspect `password_suggestions`**: When `ingestion_capture` or `ingestion_status` returns `state: "awaiting-unlock"`, it automatically includes `password_suggestions` ranked by glob pattern match, Levenshtein filename/correspondent similarity, and description/hint keyword overlap:
   - **High confidence (`score >= 70`)**: Automatically call `retry_ingestion_with_password_profile(source_id=..., profile_id=top_suggestion["profile_id"], wait_seconds=15)` and report which profile unlocked the document.
   - **Medium confidence (`40 <= score < 70`)**: If `auto_unlock` was not used or the top profile failed with `password_invalid`, present the top candidate `label` and safe `hint` to the user (or test the next candidate if clearly requested).
   - **No match (`suggestions` empty or `score < 40`)**: Ask the user for the password or which profile to use. If existing profiles exist (`list_document_password_profiles`), mention their labels and non-sensitive `hint` values.
2. **Saving a New or Updated Password Profile**:
   - When the user provides a password in chat, immediately call `save_document_password`:
     - `profile_id`: stable slug (e.g. `"vcb_statement"`, `"payroll_payslip"`)
     - `label`: human-readable label (e.g. `"VCB Statement Password"`)
     - `password`: the raw secret (only when creating or rotating the secret; omit `password` when updating only metadata)
     - `description`: when OpenLia should use this profile (e.g. `"Monthly Vietcombank e-statement and credit card PDFs"`)
     - `hint`: safe memory reminder for the user that **never** reveals the secret (e.g. `"6-digit DOB DDMMYY"`)
     - `patterns`: filename globs (e.g. `["*VCB*.pdf", "*vietcombank*"]`)
   - Then call `retry_ingestion_with_password_profile(source_id=..., profile_id=..., wait_seconds=15)` to unlock and extract the document in the same turn.

### 3. Multi-Page Document Inspection

Avoid loading entire 50-page transcripts into model context at once:
1. Call `ingestion_get_document(source_id=..., include_content=False)` or `ingestion_get_document(source_id=..., page=1)` first.
2. Read `page_count` and `page_outline` (which lists every page number, character length, and preview snippet) along with `summary` and `custom_fields`.
3. Fetch only the relevant pages via `ingestion_get_document(source_id=..., page=N, max_chars=20000)`.

### 4. Domain Handoffs & Review Lifecycle

- **Personal Finance Handoff**: When `tags` include `"finance"` or `document_type` is `"invoice"`, `"receipt"`, `"statement"`, or `"payslip"`, hand off to [Personal Finance](openlia://skills/personal-finance). Use `custom_fields` (`total_amount`, `currency`, `due_date`, `invoice_number`, `account_hint`) and page slices to stage or post transactions with `; source: openlia://source/{source_id}#{version_id}/p{page}`.
- **Inbox Triage Handoff**: When the document contains tasks, events, decisions, or durable claims requiring review, follow [Inbox Triage](openlia://skills/inbox-triage) and cite `[Title](openlia://source/{source_id}#{version_id}/p{page})`.
- **Closing Review**: Once a document's domain records are filed or reviewed, mark it reviewed via `ingestion_update_document(source_id=..., review={"status": "reviewed"})`.

## Pitfalls

- Never write raw document passwords to workspace files, `inbox/` notes, or Hermes memory.
- Never copy raw PDFs, images, or full OCR dumps into `/opt/data/workspace` unless the user explicitly asks to export a file; cite `openlia://source/{source_id}` instead.
- Never expose a password value in `hint` or `description` fields; `hint` is displayed in plaintext in the UI and chat prompts.
- Do not poll `ingestion_status` in a tight loop when `wait_seconds` already timed out on a slow job; report the `job_id` and `source_id` and check on the next turn.

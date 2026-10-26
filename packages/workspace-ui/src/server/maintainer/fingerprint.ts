import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Computes a cosmetic-insensitive fingerprint of the contract semantics
 * relevant to a specific rule and subject.
 *
 * Unrelated edits to a record or cosmetic edits to a template/schema
 * preserve this fingerprint so file-specific ignores remain stable.
 * Semantic changes to the governing rule produce a new fingerprint.
 */
export function computeContractFingerprint(params: {
  ruleCode: string;
  subject: string;
  templateSchemaRef?: string | undefined;
  templateSections?: string[] | undefined;
  schemaPropertyRule?: unknown;
  manifestTarget?: string | undefined;
}): string {
  const {
    ruleCode,
    subject,
    templateSchemaRef,
    templateSections,
    schemaPropertyRule,
    manifestTarget,
  } = params;

  if (ruleCode.startsWith("WM-FM-")) {
    return sha256Hex(
      `frontmatter:${ruleCode}:${templateSchemaRef ?? "none"}`,
    ).slice(0, 16);
  }

  if (ruleCode === "WM-TEMPLATE-SECTION-MISSING") {
    return sha256Hex(`template-section:${subject.trim().toLowerCase()}`).slice(
      0,
      16,
    );
  }

  if (ruleCode.startsWith("WM-TEMPLATE-")) {
    const normalizedSections = (templateSections ?? [])
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return sha256Hex(
      `template:${ruleCode}:${templateSchemaRef ?? ""}:${JSON.stringify(normalizedSections)}`,
    ).slice(0, 16);
  }

  if (ruleCode.startsWith("WM-SCHEMA-")) {
    return sha256Hex(
      `schema:${ruleCode}:${subject}:${JSON.stringify(schemaPropertyRule ?? null)}`,
    ).slice(0, 16);
  }

  if (
    ruleCode.startsWith("WM-MANIFEST-") ||
    ruleCode.startsWith("WM-OPENUI-")
  ) {
    return sha256Hex(
      `project:${ruleCode}:${subject}:${manifestTarget ?? ""}`,
    ).slice(0, 16);
  }

  return sha256Hex(`rule:${ruleCode}:${subject}`).slice(0, 16);
}

/**
 * Deterministic issue identity:
 * workspace + exact relative file path + rule + affected subject + relevant contract semantics
 */
export function computeIssueId(params: {
  workspaceId: string;
  relativePath: string;
  ruleCode: string;
  subject: string;
  contractFingerprint: string;
}): string {
  const normalizedPath = params.relativePath
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  const payload = JSON.stringify([
    params.workspaceId,
    normalizedPath,
    params.ruleCode,
    params.subject,
    params.contractFingerprint,
  ]);
  return `wm_${sha256Hex(payload).slice(0, 32)}`;
}

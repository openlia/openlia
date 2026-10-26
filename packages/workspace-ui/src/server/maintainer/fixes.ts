import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import YAML from "yaml";
import {
  extractHeadings,
  findDomainTemplate,
  isSimilarHeading,
  parseRecordFrontmatter,
} from "../validator";
import { revision, WorkspaceError } from "../workspace";
import type { MaintainerFindingRecord } from "./db";
import type { MaintainerService } from "./engine";

export interface MaintainerFixPreview {
  schema: 1;
  issue_id: string;
  path: string;
  rule_code: string;
  subject: string;
  fix_strategy: "deterministic" | "agent" | "manual";
  deterministically_fixable: boolean;
  current_revision: string;
  before_content: string;
  after_content: string;
  summary: string;
  agent_prompt: string;
}

export interface MaintainerFixApplyResult {
  schema: 1;
  ok: true;
  issue_id: string;
  path: string;
  before_revision: string;
  after_revision: string;
  summary: string;
  finding: MaintainerFindingRecord | null;
  file_findings: MaintainerFindingRecord[];
}

export function buildAgentFixPrompt(
  finding: MaintainerFindingRecord,
  currentRevision: string,
): string {
  const lines = [
    `Please fix this Workspace Maintainer finding in \`${finding.relative_path}\`:`,
    `- Issue ID: \`${finding.issue_id}\``,
    `- Rule: \`${finding.rule_code}\` (subject: \`${finding.subject}\`)`,
    `- Finding: ${finding.message}`,
    ...(finding.contract_path
      ? [`- Governing Contract: \`${finding.contract_path}\``]
      : []),
    `- Checked Revision: \`${currentRevision}\``,
    "",
    "Instructions:",
    `1. Read \`${finding.relative_path}\`${finding.contract_path && finding.contract_path !== finding.relative_path ? ` and \`${finding.contract_path}\`` : ""} first.`,
    "2. Apply the minimal scoped edit needed to resolve this finding while preserving all existing user content and facts.",
    "3. Do not invent personal facts; if a required field value is unknown, use a sensible template default or ask.",
  ];
  return lines.join("\n");
}

function extractTemplateSectionSnippet(
  templateBody: string,
  sectionHeading: string,
): string {
  const lines = templateBody.split(/\r?\n/);
  const targetLower = sectionHeading.trim().toLowerCase();
  let capturing = false;
  const captured: string[] = [];

  for (const line of lines) {
    const match = line.match(/^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (match?.[1] && match[2]) {
      const level = match[1].length;
      const text = match[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
      if (capturing) {
        if (level <= 2) break;
      } else if (level === 2 && text.toLowerCase() === targetLower) {
        capturing = true;
        captured.push(`## ${sectionHeading}`);
        continue;
      }
    } else if (capturing) {
      captured.push(line);
    }
  }

  if (captured.length === 0) {
    return `## ${sectionHeading}\n`;
  }
  return `${captured.join("\n").trimEnd()}\n`;
}

function deriveTitle(
  relativePath: string,
  metadata: Record<string, unknown> | null,
  body: string,
): string {
  const l1 = extractHeadings(body).find((h) => h.level === 1)?.text.trim();
  if (l1) return l1;
  if (typeof metadata?.title === "string" && metadata.title.trim()) {
    return metadata.title.trim();
  }
  const base = basename(relativePath, ".md")
    .replace(/-template$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return base
    ? base.replace(/\b\w/g, (c) => c.toUpperCase())
    : "Untitled Record";
}

function computeDeterministicTransform(
  workspaceRoot: string,
  finding: MaintainerFindingRecord,
  content: string,
): { afterContent: string; summary: string } | null {
  const root = resolve(workspaceRoot);
  const relPath = finding.relative_path;
  const domain = findDomainTemplate(root, relPath);
  const templateAbs = domain?.templateRelativePath
    ? resolve(root, domain.templateRelativePath)
    : null;
  const templateContent =
    templateAbs && existsSync(templateAbs)
      ? readFileSync(templateAbs, "utf8")
      : "";
  const parsedTemplate = templateContent
    ? parseRecordFrontmatter(templateContent)
    : { body: "", hasFrontmatter: false, metadata: null };

  // 1. WM-TEMPLATE-SECTION-MISSING (rename typo heading or insert missing section)
  if (finding.rule_code === "WM-TEMPLATE-SECTION-MISSING") {
    const expectedHeading = finding.subject;
    const lines = content.split(/\r?\n/);

    // Check if there is a misspelled level-2 heading in body (outside code blocks)
    let inFrontmatter = false;
    let fmFenceCount = 0;
    let inCodeBlock = false;
    let renamedTypo: string | null = null;

    const updatedLines = lines.map((line, idx) => {
      if (idx === 0 && line.trim() === "---") {
        inFrontmatter = true;
        fmFenceCount = 1;
        return line;
      }
      if (inFrontmatter) {
        if (line.trim() === "---") {
          fmFenceCount++;
          if (fmFenceCount === 2) inFrontmatter = false;
        }
        return line;
      }
      if (/^[ \t]{0,3}(`{3,}|~{3,})/.test(line)) {
        inCodeBlock = !inCodeBlock;
        return line;
      }
      if (inCodeBlock || renamedTypo) return line;

      const h2Match = line.match(/^[ \t]{0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/);
      if (h2Match?.[1]) {
        const actualText = h2Match[1].trim();
        if (
          actualText.toLowerCase() !== expectedHeading.toLowerCase() &&
          isSimilarHeading(expectedHeading, actualText)
        ) {
          renamedTypo = actualText;
          return `## ${expectedHeading}`;
        }
      }
      return line;
    });

    if (renamedTypo) {
      return {
        afterContent: updatedLines.join("\n"),
        summary: `Renamed misspelled section '## ${renamedTypo}' to '## ${expectedHeading}'`,
      };
    }

    // Otherwise append the missing section snippet
    const snippet = extractTemplateSectionSnippet(
      parsedTemplate.body,
      expectedHeading,
    );
    const trimmedContent = content.trimEnd();
    const afterContent = `${trimmedContent}\n\n${snippet}`;
    return {
      afterContent,
      summary: `Added missing section '## ${expectedHeading}' from template`,
    };
  }

  // 2. WM-TEMPLATE-TITLE (insert level-1 title)
  if (finding.rule_code === "WM-TEMPLATE-TITLE") {
    const parsed = parseRecordFrontmatter(content);
    const title = deriveTitle(relPath, parsed.metadata, parsed.body);
    if (parsed.hasFrontmatter) {
      const fmMatch = content.match(
        /^(---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))([\s\S]*)$/,
      );
      if (fmMatch) {
        const prefix = fmMatch[1]!;
        const rest = (fmMatch[2] ?? "").replace(/^\r?\n+/, "");
        const afterContent = rest
          ? `${prefix}\n# ${title}\n\n${rest}`
          : `${prefix}\n# ${title}\n`;
        return {
          afterContent,
          summary: `Added level-one title '# ${title}'`,
        };
      }
    }
    const trimmed = content.replace(/^\r?\n+/, "");
    return {
      afterContent: trimmed ? `# ${title}\n\n${trimmed}` : `# ${title}\n`,
      summary: `Added level-one title '# ${title}'`,
    };
  }

  // 3. WM-FM-MISSING (prepend YAML frontmatter from folder template)
  if (finding.rule_code === "WM-FM-MISSING") {
    const baseMeta: Record<string, unknown> = parsedTemplate.metadata
      ? structuredClone(parsedTemplate.metadata)
      : {};
    const title = deriveTitle(relPath, null, content);
    if ("title" in baseMeta || Object.keys(baseMeta).length === 0) {
      baseMeta.title = title;
    }
    const yamlBlock = YAML.stringify(baseMeta).trimEnd();
    const trimmed = content.replace(/^\r?\n+/, "");
    return {
      afterContent: `---\n${yamlBlock}\n---\n\n${trimmed}`,
      summary: `Added starter YAML frontmatter conforming to ${domain?.templateRelativePath ?? "folder template"}`,
    };
  }

  // 4. WM-SCHEMA-REQUIRED (insert missing required frontmatter key)
  if (finding.rule_code === "WM-SCHEMA-REQUIRED") {
    const prop = finding.subject;
    const parsed = parseRecordFrontmatter(content);
    if (!parsed.hasFrontmatter || !parsed.metadata) return null;

    let defaultValue: unknown = "";
    if (parsedTemplate.metadata && prop in parsedTemplate.metadata) {
      defaultValue = structuredClone(parsedTemplate.metadata[prop]);
    } else if (prop === "title") {
      defaultValue = deriveTitle(relPath, parsed.metadata, parsed.body);
    } else if (domain?.schemaAbsolutePath && existsSync(domain.schemaAbsolutePath)) {
      try {
        const rawSchema = JSON.parse(
          readFileSync(domain.schemaAbsolutePath, "utf8"),
        );
        const propDef = rawSchema?.properties?.[prop] as
          | Record<string, unknown>
          | undefined;
        if (propDef) {
          if ("default" in propDef) {
            defaultValue = propDef.default;
          } else if (Array.isArray(propDef.enum) && propDef.enum.length > 0) {
            defaultValue = propDef.enum[0];
          } else if (propDef.type === "array") {
            defaultValue = [];
          } else if (propDef.type === "boolean") {
            defaultValue = false;
          } else if (
            propDef.type === "number" ||
            propDef.type === "integer"
          ) {
            defaultValue = 0;
          } else if (propDef.format === "date") {
            defaultValue = new Date().toISOString().slice(0, 10);
          }
        }
      } catch {}
    }

    const nextMeta: Record<string, unknown> = {
      ...parsed.metadata,
      [prop]: defaultValue,
    };
    const yamlBlock = YAML.stringify(nextMeta).trimEnd();
    const rest = parsed.body.replace(/^\r?\n/, "");
    return {
      afterContent: `---\n${yamlBlock}\n---\n${rest ? `\n${rest}` : ""}`,
      summary: `Added required frontmatter property '${prop}: ${JSON.stringify(defaultValue)}'`,
    };
  }

  return null;
}

export function previewFix(
  service: MaintainerService,
  issueId: string,
): MaintainerFixPreview {
  const finding = service.db.getFinding(issueId);
  if (!finding) {
    throw new WorkspaceError(
      `finding not found: ${issueId}`,
      404,
      "finding_not_found",
    );
  }

  const absPath = resolve(service.workspaceRoot, finding.relative_path);
  if (
    !absPath.startsWith(service.workspaceRoot + sep) ||
    !existsSync(absPath) ||
    !lstatSync(absPath).isFile()
  ) {
    throw new WorkspaceError(
      `file not found for finding: ${finding.relative_path}`,
      404,
      "not_found",
    );
  }

  const bytes = readFileSync(absPath);
  const currentRev = revision(bytes);
  const beforeContent = new TextDecoder("utf-8").decode(bytes);
  const agentPrompt = buildAgentFixPrompt(finding, currentRev);

  const deterministic = computeDeterministicTransform(
    service.workspaceRoot,
    finding,
    beforeContent,
  );

  if (deterministic && deterministic.afterContent !== beforeContent) {
    return {
      schema: 1,
      issue_id: finding.issue_id,
      path: finding.relative_path,
      rule_code: finding.rule_code,
      subject: finding.subject,
      fix_strategy: "deterministic",
      deterministically_fixable: true,
      current_revision: currentRev,
      before_content: beforeContent,
      after_content: deterministic.afterContent,
      summary: deterministic.summary,
      agent_prompt: agentPrompt,
    };
  }

  return {
    schema: 1,
    issue_id: finding.issue_id,
    path: finding.relative_path,
    rule_code: finding.rule_code,
    subject: finding.subject,
    fix_strategy: finding.fix_strategy,
    deterministically_fixable: false,
    current_revision: currentRev,
    before_content: beforeContent,
    after_content: beforeContent,
    summary: `Use Fix with Lia to resolve ${finding.rule_code} (${finding.subject})`,
    agent_prompt: agentPrompt,
  };
}

export function applyDeterministicFix(
  service: MaintainerService,
  params: {
    issueId: string;
    expectedRevision: string;
    actor?: string | undefined;
  },
): MaintainerFixApplyResult {
  const preview = previewFix(service, params.issueId);
  if (params.expectedRevision !== preview.current_revision) {
    throw new WorkspaceError(
      "revision conflict",
      409,
      "revision_conflict",
      preview.current_revision,
    );
  }
  if (!preview.deterministically_fixable) {
    throw new WorkspaceError(
      `finding ${params.issueId} requires agent or manual resolution`,
      400,
      "not_deterministically_fixable",
    );
  }

  const absPath = resolve(service.workspaceRoot, preview.path);
  const parentDir = dirname(absPath);
  const info = lstatSync(absPath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new WorkspaceError("not a regular file", 400, "not_a_file");
  }

  const nextBytes = new TextEncoder().encode(preview.after_content);
  const tempPath = join(
    parentDir,
    `.${basename(absPath)}.openlia-fix-${randomUUID()}.tmp`,
  );
  const fd = openSync(tempPath, "wx", info.mode & 0o777);
  try {
    writeSync(fd, nextBytes);
    fsyncSync(fd);
  } catch (err) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw err;
  } finally {
    closeSync(fd);
  }

  try {
    const checkBytes = readFileSync(absPath);
    const checkRev = revision(checkBytes);
    if (checkRev !== preview.current_revision) {
      throw new WorkspaceError(
        "revision conflict",
        409,
        "revision_conflict",
        checkRev,
      );
    }
    renameSync(tempPath, absPath);
  } catch (err) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw err;
  }

  const afterRev = revision(nextBytes);

  // Revalidate the file to verify whether the finding is actually resolved
  const fileFindings = service.validateAndReconcilePaths([preview.path]);
  const updatedFinding = service.db.getFinding(params.issueId);

  service.db.recordFixAttempt({
    issueId: params.issueId,
    relativePath: preview.path,
    actor: params.actor ?? "user",
    beforeRevision: preview.current_revision,
    afterRevision: afterRev,
    status: updatedFinding?.state === "resolved" ? "resolved" : "applied",
    summary: preview.summary,
  });

  return {
    schema: 1,
    ok: true,
    issue_id: params.issueId,
    path: preview.path,
    before_revision: preview.current_revision,
    after_revision: afterRev,
    summary: preview.summary,
    finding: updatedFinding,
    file_findings: fileFindings.filter((f) => f.relative_path === preview.path),
  };
}

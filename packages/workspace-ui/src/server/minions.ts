import { execFile } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import type {
  MinionCreateRequest,
  MinionDetail,
  MinionDetailResponse,
  MinionQuickAction,
  MinionRunRequest,
  MinionRunResponse,
  MinionRuntime,
  MinionsListResponse,
  MinionSummary,
  WorkspaceFileMetadata,
} from "../shared/api";
import { openUIErrors } from "../shared/openui";
import { extractHeadings, parseRecordFrontmatter } from "./validator";
import {
  DEFAULT_MAX_EDITABLE_BYTES,
  protectedPath,
  revision,
  WorkspaceError,
} from "./workspace";

const MINION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const IGNORED_MINION_DIRS = new Set([
  "node_modules",
  "__pycache__",
  ".venv",
  ".pytest_cache",
  ".git",
]);

const DATA_EXTENSIONS = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".hledger",
  ".journal",
  ".rem",
  ".remind",
  ".md",
  ".markdown",
  ".txt",
]);

const CODE_EXTENSIONS = new Set([".py", ".ts", ".js", ".mjs", ".sh", ".bash"]);

export interface MinionServiceOptions {
  workspaceRoot: string;
  maxEditableBytes?: number | undefined;
  timeoutMs?: number | undefined;
}

export function validateMinionId(id: unknown): string {
  if (typeof id !== "string" || !MINION_ID_PATTERN.test(id.trim())) {
    throw new WorkspaceError(
      "invalid minion identifier (expected lowercase alphanumeric and hyphens)",
      400,
      "invalid_minion_id",
    );
  }
  return id.trim();
}

function humanizeMinionId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isTestFilePath(relFromMinion: string): boolean {
  const normalized = relFromMinion.replaceAll("\\", "/");
  const base = normalized.split("/").pop()?.toLowerCase() ?? "";
  if (normalized.startsWith("tests/")) return true;
  return (
    base.startsWith("test_") ||
    base.endsWith("_test.py") ||
    base.endsWith(".test.ts") ||
    base.endsWith(".test.js") ||
    base.endsWith(".spec.ts")
  );
}

function parseReadmeMetadata(
  readmeContent: string,
  fallbackId: string,
): {
  name: string;
  description: string;
  icon?: string | undefined;
  quickActions: MinionQuickAction[];
} {
  const fallbackName = humanizeMinionId(fallbackId);
  let name = fallbackName;
  let description = `Autonomous Minion in minions/${fallbackId}`;
  let icon: string | undefined;
  const quickActions: MinionQuickAction[] = [];

  const { metadata, body } = parseRecordFrontmatter(readmeContent);
  if (metadata) {
    if (typeof metadata.name === "string" && metadata.name.trim()) {
      name = metadata.name.trim();
    }
    if (
      typeof metadata.description === "string" &&
      metadata.description.trim()
    ) {
      description = metadata.description.trim();
    }
    if (typeof metadata.icon === "string" && metadata.icon.trim()) {
      icon = metadata.icon.trim();
    }
    if (Array.isArray(metadata.quick_actions)) {
      for (const raw of metadata.quick_actions) {
        if (
          raw &&
          typeof raw === "object" &&
          typeof (raw as Record<string, unknown>).id === "string" &&
          typeof (raw as Record<string, unknown>).label === "string"
        ) {
          const item = raw as Record<string, unknown>;
          quickActions.push({
            id: String(item.id).trim(),
            label: String(item.label).trim(),
            ...(typeof item.description === "string"
              ? { description: item.description }
              : {}),
            ...(typeof item.placeholder === "string"
              ? { placeholder: item.placeholder }
              : {}),
            ...(Array.isArray(item.args)
              ? { args: item.args.map((a) => String(a)) }
              : {}),
          });
        }
      }
    }
  }

  const headings = extractHeadings(body);
  const h1 = headings.find((h) => h.level === 1);
  if (name === fallbackName && h1?.text.trim()) {
    name = h1.text.trim();
  }
  if (description.startsWith("Autonomous Minion in ")) {
    const paragraph = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(
        (l) =>
          l.length > 0 &&
          !l.startsWith("#") &&
          !l.startsWith("```") &&
          !l.startsWith("---"),
      );
    if (paragraph) description = paragraph;
  }

  return { name, description, icon, quickActions };
}

export class MinionService {
  readonly workspaceRoot: string;
  readonly maxEditableBytes: number;
  readonly timeoutMs: number;

  constructor(options: MinionServiceOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.maxEditableBytes =
      options.maxEditableBytes ?? DEFAULT_MAX_EDITABLE_BYTES;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private minionsRoot(): string {
    return join(this.workspaceRoot, "minions");
  }

  private resolveMinionDir(id: string): string {
    const validId = validateMinionId(id);
    const dir = resolve(this.minionsRoot(), validId);
    if (!dir.startsWith(this.minionsRoot() + sep)) {
      throw new WorkspaceError(
        "invalid minion path",
        400,
        "invalid_minion_path",
      );
    }
    return dir;
  }

  private fileMetadata(absPath: string): WorkspaceFileMetadata | null {
    try {
      const info: Stats = lstatSync(absPath);
      if (info.isSymbolicLink() || !info.isFile()) return null;
      const rel = relative(this.workspaceRoot, absPath).replaceAll("\\", "/");
      if (protectedPath(rel)) return null;
      const bytes = readFileSync(absPath);
      return {
        path: rel,
        size: info.size,
        modified_at: info.mtime.toISOString(),
        editable: info.size <= this.maxEditableBytes,
        revision: revision(bytes),
      };
    } catch {
      return null;
    }
  }

  private collectDirectoryFiles(
    dirAbs: string,
    minionRootAbs: string,
  ): Array<{ relToMinion: string; meta: WorkspaceFileMetadata }> {
    const results: Array<{ relToMinion: string; meta: WorkspaceFileMetadata }> =
      [];
    if (!existsSync(dirAbs)) return results;
    let entries: Dirent<string>[] = [];
    try {
      entries = readdirSync(dirAbs, { encoding: "utf8", withFileTypes: true });
    } catch {
      return results;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED_MINION_DIRS.has(entry.name)) {
        continue;
      }
      const abs = join(dirAbs, entry.name);
      try {
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          results.push(...this.collectDirectoryFiles(abs, minionRootAbs));
        } else if (st.isFile()) {
          const meta = this.fileMetadata(abs);
          if (meta) {
            const relToMinion = relative(minionRootAbs, abs).replaceAll(
              "\\",
              "/",
            );
            results.push({ relToMinion, meta });
          }
        }
      } catch {
        continue;
      }
    }
    return results;
  }

  private inspectMinion(id: string, dirAbs: string): MinionDetail | null {
    try {
      const st = lstatSync(dirAbs);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    } catch {
      return null;
    }

    const readmeAbs = join(dirAbs, "README.md");
    const mainPyAbs = join(dirAbs, "main.py");
    const mainTsAbs = join(dirAbs, "main.ts");
    const hasReadme =
      existsSync(readmeAbs) &&
      !lstatSync(readmeAbs).isSymbolicLink() &&
      lstatSync(readmeAbs).isFile();
    const hasMainPy =
      existsSync(mainPyAbs) &&
      !lstatSync(mainPyAbs).isSymbolicLink() &&
      lstatSync(mainPyAbs).isFile();
    const hasMainTs =
      existsSync(mainTsAbs) &&
      !lstatSync(mainTsAbs).isSymbolicLink() &&
      lstatSync(mainTsAbs).isFile();

    if (!hasReadme || (!hasMainPy && !hasMainTs)) {
      return null;
    }

    const runtime: MinionRuntime = hasMainPy ? "python" : "typescript";
    const entrypoint: "main.py" | "main.ts" = hasMainPy ? "main.py" : "main.ts";
    let dependencyFile: "requirements.txt" | "package.json" | undefined;
    if (existsSync(join(dirAbs, "requirements.txt"))) {
      dependencyFile = "requirements.txt";
    } else if (existsSync(join(dirAbs, "package.json"))) {
      dependencyFile = "package.json";
    }

    const readmeContent = readFileSync(readmeAbs, "utf-8");
    const parsedMeta = parseReadmeMetadata(readmeContent, id);

    const allFiles = this.collectDirectoryFiles(dirAbs, dirAbs);
    const uiFiles: string[] = [];
    const uiContents: Record<string, string> = {};
    const renderErrors: string[] = [];
    const dataFiles: WorkspaceFileMetadata[] = [];
    const codeFiles: WorkspaceFileMetadata[] = [];
    const testFiles: WorkspaceFileMetadata[] = [];

    for (const { relToMinion, meta } of allFiles) {
      const lower = relToMinion.toLowerCase();
      const ext = lower.includes(".")
        ? lower.slice(lower.lastIndexOf("."))
        : "";

      if (lower.endsWith(".openui")) {
        uiFiles.push(relToMinion);
        try {
          const rawUi = readFileSync(join(dirAbs, relToMinion), "utf-8");
          uiContents[relToMinion] = rawUi;
          for (const err of openUIErrors(rawUi)) {
            renderErrors.push(`${relToMinion}: ${err}`);
          }
        } catch {}
        continue;
      }

      if (isTestFilePath(relToMinion)) {
        testFiles.push(meta);
        continue;
      }

      if (
        relToMinion === "main.py" ||
        relToMinion === "main.ts" ||
        relToMinion === "requirements.txt" ||
        relToMinion === "package.json" ||
        relToMinion.startsWith("scripts/") ||
        CODE_EXTENSIONS.has(ext)
      ) {
        codeFiles.push(meta);
        continue;
      }

      if (lower === "readme.md") {
        continue;
      }

      if (
        relToMinion.startsWith("data/") ||
        (DATA_EXTENSIONS.has(ext) &&
          lower !== "package-lock.json" &&
          lower !== "tsconfig.json" &&
          !lower.endsWith(".schema.json") &&
          !lower.endsWith("-template.md"))
      ) {
        dataFiles.push(meta);
      }
    }

    uiFiles.sort((a, b) => {
      if (a === "ui.openui") return -1;
      if (b === "ui.openui") return 1;
      return a.localeCompare(b);
    });

    const primaryUiFile = uiFiles[0];
    const renderable = uiFiles.length > 0 && renderErrors.length === 0;

    return {
      id,
      path: `minions/${id}`,
      name: parsedMeta.name,
      description: parsedMeta.description,
      ...(parsedMeta.icon ? { icon: parsedMeta.icon } : {}),
      runtime,
      entrypoint,
      ...(dependencyFile ? { dependency_file: dependencyFile } : {}),
      ui_files: uiFiles,
      ...(primaryUiFile ? { primary_ui_file: primaryUiFile } : {}),
      data_file_count: dataFiles.length,
      script_file_count: codeFiles.length,
      test_file_count: testFiles.length,
      renderable,
      ...(renderErrors.length > 0 ? { render_errors: renderErrors } : {}),
      quick_actions: parsedMeta.quickActions,
      readme_content: readmeContent,
      ui_contents: uiContents,
      data_files: dataFiles,
      code_files: codeFiles,
      test_files: testFiles,
    };
  }

  private toSummary(detail: MinionDetail): MinionSummary {
    const {
      readme_content: _r,
      ui_contents: _u,
      data_files: _d,
      code_files: _c,
      test_files: _t,
      ...summary
    } = detail;
    return summary;
  }

  listMinions(): MinionsListResponse {
    const root = this.minionsRoot();
    if (!existsSync(root)) {
      return { schema: 1, minions: [] };
    }
    let entries: Dirent<string>[] = [];
    try {
      entries = readdirSync(root, { encoding: "utf8", withFileTypes: true });
    } catch {
      return { schema: 1, minions: [] };
    }
    const minions: MinionSummary[] = [];
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        !MINION_ID_PATTERN.test(entry.name) ||
        !entry.isDirectory()
      ) {
        continue;
      }
      const detail = this.inspectMinion(entry.name, join(root, entry.name));
      if (detail) {
        minions.push(this.toSummary(detail));
      }
    }
    return { schema: 1, minions };
  }

  getMinion(id: string): MinionDetailResponse {
    const dir = this.resolveMinionDir(id);
    const detail = this.inspectMinion(validateMinionId(id), dir);
    if (!detail) {
      throw new WorkspaceError("minion not found", 404, "minion_not_found");
    }
    return { schema: 1, minion: detail };
  }

  createMinion(req: Partial<MinionCreateRequest>): MinionDetailResponse {
    const id = validateMinionId(req.id);
    const name =
      typeof req.name === "string" && req.name.trim()
        ? req.name.trim()
        : humanizeMinionId(id);
    const description =
      typeof req.description === "string" && req.description.trim()
        ? req.description.trim()
        : `Track and manage ${name.toLowerCase()} entries with quick input and OpenUI views.`;
    const runtime: MinionRuntime =
      req.runtime === "typescript" ? "typescript" : "python";

    const dir = this.resolveMinionDir(id);
    if (existsSync(dir)) {
      throw new WorkspaceError(
        "minion already exists",
        409,
        "minion_already_exists",
      );
    }

    mkdirSync(join(dir, "data"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });

    const readmeFrontmatter = YAML.stringify({
      name,
      description,
      quick_actions: [
        {
          id: "add",
          label: "Add Entry",
          placeholder: `Add new item to ${name}...`,
        },
      ],
    }).trim();

    const readmeContent = `---\n${readmeFrontmatter}\n---\n# ${name}\n\n${description}\n\n## Usage\n\n- **Quick Input**: Submit an item from the Minions tab or run \`${runtime === "python" ? "python3 main.py --input '<text>'" : "bun main.ts --input '<text>'"}\`.\n- **Data**: Stored under \`data/\`.\n- **UI**: Rendered from \`ui.openui\`.\n`;
    writeFileSync(join(dir, "README.md"), readmeContent, "utf-8");

    const starterItems = [
      {
        date: new Date().toISOString().slice(0, 10),
        item: `Sample ${name} entry`,
        status: "active",
      },
    ];
    writeFileSync(
      join(dir, "data", "items.json"),
      `${JSON.stringify(starterItems, null, 2)}\n`,
      "utf-8",
    );

    const starterUi = `Table(title: ${JSON.stringify(name)}, columns: [{key: "date", label: "Date"}, {key: "item", label: "Item"}, {key: "status", label: "Status"}], rows: ${JSON.stringify(starterItems)})\n`;
    writeFileSync(join(dir, "ui.openui"), starterUi, "utf-8");

    if (runtime === "python") {
      writeFileSync(
        join(dir, "requirements.txt"),
        "# Add Python dependencies for this Minion\n",
        "utf-8",
      );
      const mainPy = `#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "items.json"
UI_FILE = ROOT / "ui.openui"
TITLE = ${JSON.stringify(name)}


def load_items() -> list[dict[str, str]]:
    if not DATA_FILE.exists():
        return []
    return json.loads(DATA_FILE.read_text(encoding="utf-8"))


def save_items(items: list[dict[str, str]]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(items, indent=2, ensure_ascii=False) + "\\n", encoding="utf-8")


def render_ui(items: list[dict[str, str]]) -> str:
    cols = '[{key: "date", label: "Date"}, {key: "item", label: "Item"}, {key: "status", label: "Status"}]'
    rows = json.dumps(items, ensure_ascii=False)
    content = f'Table(title: {json.dumps(TITLE)}, columns: {cols}, rows: {rows})\\n'
    UI_FILE.write_text(content, encoding="utf-8")
    return content


def add_entry(text: str, today: str | None = None) -> list[dict[str, str]]:
    items = load_items()
    items.append({
        "date": today or dt.date.today().isoformat(),
        "item": text.strip(),
        "status": "active",
    })
    save_items(items)
    render_ui(items)
    return items


def main() -> int:
    parser = argparse.ArgumentParser(description=TITLE)
    parser.add_argument("--action", default="add")
    parser.add_argument("--input", default="")
    args = parser.parse_args()

    text = args.input.strip()
    if text:
        items = add_entry(text)
        print(f"Added entry ({len(items)} total): {text}")
    else:
        items = load_items()
        render_ui(items)
        print(f"Refreshed UI ({len(items)} entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
      writeFileSync(join(dir, "main.py"), mainPy, "utf-8");

      const testPy = `import unittest
import main


class MinionMainTests(unittest.TestCase):
    def test_load_and_render(self):
        items = main.load_items()
        self.assertIsInstance(items, list)
        ui = main.render_ui(items)
        self.assertIn("Table(", ui)


if __name__ == "__main__":
    unittest.main()
`;
      writeFileSync(join(dir, "tests", "test_main.py"), testPy, "utf-8");
    } else {
      writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify(
          {
            name: `minion-${id}`,
            version: "0.1.0",
            private: true,
            type: "module",
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const mainTs = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MinionItem {
  date: string;
  item: string;
  status: string;
}

const ROOT = import.meta.dir;
const DATA_FILE = join(ROOT, "data", "items.json");
const UI_FILE = join(ROOT, "ui.openui");
const TITLE = ${JSON.stringify(name)};

export function loadItems(): MinionItem[] {
  if (!existsSync(DATA_FILE)) return [];
  return JSON.parse(readFileSync(DATA_FILE, "utf-8")) as MinionItem[];
}

export function saveItems(items: MinionItem[]): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(items, null, 2) + "\\n", "utf-8");
}

export function renderUi(items: MinionItem[]): string {
  const cols = '[{key: "date", label: "Date"}, {key: "item", label: "Item"}, {key: "status", label: "Status"}]';
  const content = \`Table(title: \${JSON.stringify(TITLE)}, columns: \${cols}, rows: \${JSON.stringify(items)})\\n\`;
  writeFileSync(UI_FILE, content, "utf-8");
  return content;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf("--input");
  const input = (inputIdx >= 0 ? args[inputIdx + 1] : process.env.OPENLIA_MINION_INPUT) ?? "";
  const items = loadItems();
  if (input.trim()) {
    items.push({
      date: new Date().toISOString().slice(0, 10),
      item: input.trim(),
      status: "active",
    });
    saveItems(items);
    renderUi(items);
    console.log(\`Added entry (\${items.length} total): \${input.trim()}\`);
  } else {
    renderUi(items);
    console.log(\`Refreshed UI (\${items.length} entries)\`);
  }
}
`;
      writeFileSync(join(dir, "main.ts"), mainTs, "utf-8");

      const testTs = `import { expect, test } from "bun:test";
import { loadItems, renderUi } from "../main";

test("loads items and renders OpenUI table", () => {
  const items = loadItems();
  expect(Array.isArray(items)).toBe(true);
  const ui = renderUi(items);
  expect(ui).toContain("Table(");
});
`;
      writeFileSync(join(dir, "tests", "main.test.ts"), testTs, "utf-8");
    }

    return this.getMinion(id);
  }

  private resolvePythonBin(dirAbs: string): string {
    const localVenvPy = join(dirAbs, ".venv", "bin", "python");
    if (existsSync(localVenvPy)) return localVenvPy;
    const hermesPy = "/opt/hermes/.venv/bin/python";
    if (existsSync(hermesPy)) return hermesPy;
    return "python3";
  }

  private execSubprocess(
    cmd: string,
    args: string[],
    cwd: string,
    extraEnv: Record<string, string> = {},
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }> {
    const start = Date.now();
    return new Promise((resolvePromise) => {
      execFile(
        cmd,
        args,
        {
          cwd,
          env: {
            ...process.env,
            ...extraEnv,
          },
          timeout: this.timeoutMs,
          maxBuffer: 256 * 1024,
        },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - start;
          if (!err) {
            resolvePromise({
              exitCode: 0,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              durationMs,
            });
            return;
          }
          const anyErr = err as {
            code?: number | string;
            killed?: boolean;
            message?: string;
          };
          const exitCode = anyErr.killed
            ? 124
            : typeof anyErr.code === "number"
              ? anyErr.code
              : 1;
          const stderrStr = String(stderr ?? "");
          resolvePromise({
            exitCode,
            stdout: String(stdout ?? ""),
            stderr:
              stderrStr ||
              (typeof anyErr.message === "string"
                ? anyErr.message
                : "execution_failed"),
            durationMs,
          });
        },
      );
    });
  }

  async installMinionDependencies(id: string): Promise<MinionRunResponse> {
    const dir = this.resolveMinionDir(id);
    const { minion: before } = this.getMinion(id);

    let result: {
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    };

    if (before.runtime === "python") {
      const reqFile = join(dir, "requirements.txt");
      if (!existsSync(reqFile)) {
        result = {
          exitCode: 0,
          stdout: "No requirements.txt found; nothing to install.",
          stderr: "",
          durationMs: 0,
        };
      } else {
        const lines = readFileSync(reqFile, "utf-8")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith("#"));
        if (lines.length === 0) {
          result = {
            exitCode: 0,
            stdout: "requirements.txt has no active package specifiers.",
            stderr: "",
            durationMs: 0,
          };
        } else {
          const venvDir = join(dir, ".venv");
          if (!existsSync(join(venvDir, "bin", "pip"))) {
            await this.execSubprocess("python3", ["-m", "venv", ".venv"], dir);
          }
          const pipBin = existsSync(join(venvDir, "bin", "pip"))
            ? join(venvDir, "bin", "pip")
            : "pip3";
          result = await this.execSubprocess(
            pipBin,
            ["install", "-r", "requirements.txt"],
            dir,
          );
        }
      }
    } else {
      const pkgFile = join(dir, "package.json");
      if (!existsSync(pkgFile)) {
        result = {
          exitCode: 0,
          stdout: "No package.json found; nothing to install.",
          stderr: "",
          durationMs: 0,
        };
      } else {
        result = await this.execSubprocess("bun", ["install"], dir);
      }
    }

    const { minion } = this.getMinion(id);
    return {
      schema: 1,
      ok: result.exitCode === 0,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.durationMs,
      minion,
    };
  }

  async runMinion(
    id: string,
    req: MinionRunRequest = {},
  ): Promise<MinionRunResponse> {
    const dir = this.resolveMinionDir(id);
    const { minion: before } = this.getMinion(id);

    const cliArgs: string[] = [];
    if (typeof req.action === "string" && req.action.trim()) {
      cliArgs.push("--action", req.action.trim());
    }
    if (typeof req.input === "string" && req.input.trim()) {
      cliArgs.push("--input", req.input.trim());
    }
    if (Array.isArray(req.args)) {
      for (const arg of req.args) {
        if (typeof arg === "string") cliArgs.push(arg);
      }
    }

    const extraEnv: Record<string, string> = {
      OPENLIA_WORKSPACE_ROOT: this.workspaceRoot,
      OPENLIA_MINION_ID: before.id,
      ...(typeof req.action === "string"
        ? { OPENLIA_MINION_ACTION: req.action }
        : {}),
      ...(typeof req.input === "string"
        ? { OPENLIA_MINION_INPUT: req.input }
        : {}),
    };

    const cmd =
      before.runtime === "python" ? this.resolvePythonBin(dir) : "bun";
    const result = await this.execSubprocess(
      cmd,
      [before.entrypoint, ...cliArgs],
      dir,
      extraEnv,
    );

    const { minion } = this.getMinion(id);
    return {
      schema: 1,
      ok: result.exitCode === 0,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.durationMs,
      minion,
    };
  }

  async testMinion(id: string): Promise<MinionRunResponse> {
    const dir = this.resolveMinionDir(id);
    const { minion: before } = this.getMinion(id);

    const extraEnv: Record<string, string> = {
      OPENLIA_WORKSPACE_ROOT: this.workspaceRoot,
      OPENLIA_MINION_ID: before.id,
      PYTHONPATH: dir,
    };

    let result: {
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    };

    if (before.runtime === "python") {
      const pyBin = this.resolvePythonBin(dir);
      const startDir = existsSync(join(dir, "tests")) ? "tests" : ".";
      result = await this.execSubprocess(
        pyBin,
        ["-m", "unittest", "discover", "-s", startDir, "-p", "test*.py"],
        dir,
        extraEnv,
      );
    } else {
      result = await this.execSubprocess("bun", ["test"], dir, extraEnv);
    }

    const { minion } = this.getMinion(id);
    return {
      schema: 1,
      ok: result.exitCode === 0,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.durationMs,
      minion,
    };
  }
}

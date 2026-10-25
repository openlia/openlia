import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  FinanceCheckFreshnessResponse,
  FinanceCheckResponse,
} from "../shared/finance";
import { protectedPath, revision, WorkspaceError } from "./workspace";

export interface FinanceProcessResult {
  exitCode: number;
  output: string;
  timedOut?: boolean;
  outputLimited?: boolean;
  signal?: string | null;
}

export interface FinanceProcessOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type FinanceRunner = (
  command: string[],
  options: FinanceProcessOptions,
) => Promise<FinanceProcessResult>;

export interface FinanceCheckOptions {
  executable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxSnapshotBytes?: number;
  // Dependency injection for deterministic timeout, race, and missing-engine tests.
  runner?: FinanceRunner;
}

export const runFinanceProcess: FinanceRunner = async (command, options) => {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let outputLimited = false;
  let bytes = 0;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        const remaining = Math.max(0, options.maxOutputBytes - bytes);
        if (remaining) chunks.push(chunk.subarray(0, remaining));
        bytes += chunk.length;
        if (bytes > options.maxOutputBytes && !outputLimited) {
          outputLimited = true;
          child.kill("SIGKILL");
        }
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      read(child.stdout),
      read(child.stderr),
      child.exited,
    ]);
    return {
      exitCode,
      output: `${stdout}${stderr}`,
      timedOut,
      outputLimited,
      signal: child.signalCode,
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
};

class BlockedJournal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
    readonly line?: number,
  ) {
    super(message);
  }
}

interface SnapshotFile {
  path: string;
  revision: string;
  name: string;
  content: string;
  expandedFiles: number;
}
interface Snapshot {
  files: SnapshotFile[];
  fingerprint: string;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export class FinanceCheckService {
  private readonly root: string;
  private readonly options: Required<FinanceCheckOptions>;
  private active = false;

  constructor(workspaceRoot: string, options: FinanceCheckOptions = {}) {
    this.root = realpathSync(workspaceRoot);
    this.options = {
      executable: options.executable ?? "hledger",
      timeoutMs: options.timeoutMs ?? 10000,
      maxOutputBytes: options.maxOutputBytes ?? 32768,
      maxSnapshotBytes: options.maxSnapshotBytes ?? 4 * 1024 * 1024,
      runner: options.runner ?? runFinanceProcess,
    };
  }

  private safePath(value: string): string {
    if (
      !value ||
      value.length > 1024 ||
      isAbsolute(value) ||
      value.includes("\\") ||
      hasControlCharacters(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..") ||
      protectedPath(value)
    ) {
      throw new BlockedJournal(
        "blocked_path",
        "Journal paths must be non-protected, workspace-relative paths.",
      );
    }
    if (![".hledger", ".journal"].includes(extname(value).toLowerCase())) {
      throw new BlockedJournal(
        "unsupported_format",
        "Only plain .hledger and .journal files are supported.",
        value,
      );
    }
    return value;
  }

  private read(
    path: string,
    budget: number,
  ): { content: string; revision: string; bytes: number } {
    this.safePath(path);
    const absolute = resolve(this.root, path);
    let fd: number | undefined;
    const checkLocation = () => {
      let parent = this.root;
      for (const part of path.split("/")) {
        parent = join(parent, part);
        if (lstatSync(parent).isSymbolicLink())
          throw new BlockedJournal(
            "blocked_symlink",
            "Journal dependencies must not traverse symlinks.",
            path,
          );
      }
      if (!realpathSync(absolute).startsWith(this.root + sep))
        throw new BlockedJournal(
          "blocked_path",
          "Journal dependency escapes the workspace.",
          path,
        );
    };
    try {
      checkLocation();
      fd = openSync(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = fstatSync(fd);
      checkLocation();
      const openedPath = lstatSync(absolute);
      if (openedPath.dev !== before.dev || openedPath.ino !== before.ino)
        throw new BlockedJournal(
          "changed_during_capture",
          "Journal path changed while opening the snapshot. Retry the check.",
          path,
        );
      if (!before.isFile())
        throw new BlockedJournal(
          "not_a_file",
          "Journal dependency is not a regular file.",
          path,
        );
      if (before.size > Math.min(budget, 1024 * 1024))
        throw new BlockedJournal(
          "snapshot_limit",
          "Journal snapshot exceeds its size limit.",
          path,
        );
      // Read at most the budget, even if another process grows the file.
      const buffer = Buffer.alloc(
        Math.min(before.size, budget, 1024 * 1024) + 1,
      );
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(
          fd,
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!count) break;
        length += count;
      }
      if (length > Math.min(budget, 1024 * 1024))
        throw new BlockedJournal(
          "snapshot_limit",
          "Journal snapshot exceeds its size limit.",
          path,
        );
      checkLocation();
      const after = lstatSync(absolute);
      const current = fstatSync(fd);
      if (
        after.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== current.size ||
        before.mtimeMs !== current.mtimeMs ||
        before.ctimeMs !== current.ctimeMs ||
        !realpathSync(absolute).startsWith(this.root + sep)
      ) {
        throw new BlockedJournal(
          "changed_during_capture",
          "Journal changed while capturing the snapshot. Retry the check.",
          path,
        );
      }
      const bytes = buffer.subarray(0, length);
      const content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      if (bytes.includes(0))
        throw new BlockedJournal(
          "unsupported_format",
          "Binary journal files are not supported.",
          path,
        );
      return { content, revision: revision(bytes), bytes: length };
    } catch (error) {
      if (error instanceof BlockedJournal) throw error;
      throw new BlockedJournal(
        "unreadable_dependency",
        "Journal dependency is missing, unreadable, or not valid UTF-8.",
        path,
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private capture(path: string): Snapshot {
    this.safePath(path);
    const files = new Map<string, SnapshotFile>();
    let bytes = 0;
    let expandedFiles = 0;
    const visit = (filePath: string, ancestors: Set<string>): SnapshotFile => {
      if (ancestors.has(filePath))
        throw new BlockedJournal(
          "include_cycle",
          "Journal includes contain a cycle.",
          filePath,
        );
      const existing = files.get(filePath);
      // Bound expanded input too: a small DAG of repeated includes can otherwise
      // expand exponentially even when the number of distinct files is small.
      expandedFiles += existing?.expandedFiles ?? 1;
      if (expandedFiles > 50)
        throw new BlockedJournal(
          "snapshot_limit",
          "Journal expanded include count exceeds its limit.",
          filePath,
        );
      if (existing) return existing;
      if (files.size >= 50 || ancestors.size >= 32)
        throw new BlockedJournal(
          "snapshot_limit",
          "Journal include count or depth exceeds its limit.",
          filePath,
        );
      const source = this.read(filePath, this.options.maxSnapshotBytes - bytes);
      bytes += source.bytes;
      const file = {
        path: filePath,
        revision: source.revision,
        name: `file${files.size}.journal`,
        content: "",
        expandedFiles: 1,
      };
      files.set(filePath, file);
      const stack = new Set([...ancestors, filePath]);
      // Inspect includes conservatively, including those in block comments.
      // No native include is allowed to reach the engine unreviewed.
      file.content = source.content
        .split(/(\r\n|\n|\r)/)
        .map((line, index) => {
          if (index % 2 !== 0) return line;
          const directive = line.match(/^(\s*include\b)(.*)$/i);
          if (!directive) return line;
          const target = directive[2]?.trim() ?? "";
          if (
            !target ||
            /[?*\[\]{}:$"'~\\]/.test(target) ||
            hasControlCharacters(target) ||
            isAbsolute(target)
          ) {
            throw new BlockedJournal(
              "unsupported_include",
              "Only literal, relative plain-journal includes are supported; use unquoted filenames. Globs, format prefixes, and absolute paths are blocked.",
              filePath,
              Math.floor(index / 2) + 1,
            );
          }
          const childPath = posix.normalize(
            posix.join(posix.dirname(filePath), target),
          );
          const dependency = visit(childPath, stack);
          file.expandedFiles += dependency.expandedFiles;
          return `${directive[1]} ${dependency.name}`;
        })
        .join("");
      return file;
    };
    visit(path, new Set());
    const captured = [...files.values()];
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          captured
            .map(({ path, revision }) => ({ path, revision }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ),
      )
      .digest("hex");
    return { files: captured, fingerprint: `sha256:${fingerprint}` };
  }

  freshness(path: string, fingerprint: string): FinanceCheckFreshnessResponse {
    try {
      const snapshot = this.capture(path);
      return {
        schema: 1,
        current: snapshot.fingerprint === fingerprint,
        fingerprint: snapshot.fingerprint,
      };
    } catch {
      return { schema: 1, current: false, fingerprint: null };
    }
  }

  async check(path: string): Promise<FinanceCheckResponse> {
    const result: FinanceCheckResponse = {
      schema: 1,
      path,
      status: "blocked",
      checked_at: new Date().toISOString(),
      fingerprint: null,
      files: [],
      diagnostics: [],
    };
    if (this.active)
      return {
        ...result,
        diagnostics: [
          {
            code: "check_busy",
            message: "Another journal check is running. Retry shortly.",
          },
        ],
      };
    this.active = true;
    let temporary: string | undefined;
    try {
      const snapshot = this.capture(path);
      result.fingerprint = snapshot.fingerprint;
      result.files = snapshot.files.map(({ path, revision }) => ({
        path,
        revision,
      }));
      temporary = mkdtempSync(join(tmpdir(), "openlia-hledger-check-"));
      const cwd = join(temporary, "journal");
      const home = join(temporary, "home");
      mkdirSync(cwd, { mode: 0o700 });
      mkdirSync(home, { mode: 0o700 });
      for (const file of snapshot.files)
        writeFileSync(join(cwd, file.name), file.content, { mode: 0o400 });
      const deadline = Date.now() + this.options.timeoutMs;
      const run = (args: string[]) =>
        this.options.runner([this.options.executable, ...args], {
          cwd,
          timeoutMs: Math.max(1, deadline - Date.now()),
          maxOutputBytes: this.options.maxOutputBytes,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: home,
            XDG_CONFIG_HOME: home,
            TMPDIR: temporary!,
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            NO_COLOR: "1",
          },
        });
      const version = await run(["--version"]);
      if (this.processLimit(version, result)) return result;
      if (
        version.exitCode !== 0 ||
        !/^hledger\b/i.test(version.output.trim())
      ) {
        return {
          ...result,
          status: "unavailable",
          diagnostics: [
            {
              code: "engine_unavailable",
              message: "A working hledger executable is unavailable.",
            },
          ],
        };
      }
      result.engine_version = stripVTControlCharacters(version.output)
        .trim()
        .slice(0, 256);
      // Older packaged hledger versions predate config files. Probe the actual
      // capability rather than passing an unsupported --no-conf flag to them.
      const help = await run(["--help"]);
      if (this.processLimit(help, result)) return result;
      if (help.exitCode !== 0)
        return {
          ...result,
          status: "unavailable",
          diagnostics: [
            {
              code: "engine_unavailable",
              message: "Could not inspect hledger capabilities.",
            },
          ],
        };
      const checked = await run([
        ...(help.output.includes("--no-conf") ? ["--no-conf"] : []),
        "-f",
        snapshot.files[0]!.name,
        "check",
      ]);
      if (this.processLimit(checked, result)) return result;
      result.status = checked.signal
        ? "error"
        : checked.exitCode === 0
          ? "passed"
          : checked.exitCode > 0
            ? "failed"
            : "error";
      let message = stripVTControlCharacters(checked.output)
        .replaceAll(cwd + sep, "")
        .replaceAll(temporary, "[snapshot]")
        .trim();
      let diagnosticPath = path;
      let diagnosticLine: number | undefined;
      for (const file of snapshot.files) {
        const location = message.match(
          new RegExp(`\\b${file.name.replace(".", "\\.")}:(\\d+)`),
        );
        if (location) {
          diagnosticPath = file.path;
          diagnosticLine = Number(location[1]);
        }
        message = message.replaceAll(file.name, file.path);
      }
      if (message || result.status !== "passed")
        result.diagnostics.push({
          code: "hledger_check",
          message:
            message || "hledger did not complete the check successfully.",
          path: diagnosticPath,
          ...(diagnosticLine ? { line: diagnosticLine } : {}),
        });
      if (!this.freshness(path, snapshot.fingerprint).current) {
        result.status = "stale";
        result.diagnostics.push({
          code: "snapshot_changed",
          message:
            "The journal or an included file changed during validation. Recheck the current files.",
        });
      }
      result.checked_at = new Date().toISOString();
      return result;
    } catch (error) {
      result.checked_at = new Date().toISOString();
      if (error instanceof BlockedJournal) {
        result.status = "blocked";
        result.diagnostics = [
          {
            code: error.code,
            message: error.message,
            ...(error.path ? { path: error.path } : {}),
            ...(error.line ? { line: error.line } : {}),
          },
        ];
      } else {
        const missing =
          error instanceof Error && "code" in error && error.code === "ENOENT";
        result.status = missing ? "unavailable" : "error";
        result.diagnostics = [
          {
            code: missing ? "engine_unavailable" : "check_error",
            message: missing
              ? "hledger is not installed or its configured executable is unavailable."
              : "Journal validation could not complete. Retry the check.",
          },
        ];
      }
      return result;
    } finally {
      try {
        if (temporary) rmSync(temporary, { recursive: true, force: true });
      } finally {
        this.active = false;
      }
    }
  }

  private processLimit(
    process: FinanceProcessResult,
    result: FinanceCheckResponse,
  ): boolean {
    result.checked_at = new Date().toISOString();
    if (process.timedOut) {
      result.status = "timed_out";
      result.diagnostics = [
        {
          code: "check_timeout",
          message:
            "hledger exceeded the validation time limit. No current validation result is available.",
        },
      ];
      return true;
    }
    if (process.outputLimited) {
      result.status = "blocked";
      result.diagnostics = [
        {
          code: "output_limit",
          message:
            "hledger exceeded the diagnostic output limit; validation is inconclusive.",
        },
      ];
      return true;
    }
    return false;
  }
}

export function financeRequest(value: unknown): {
  path: string;
  fingerprint?: string;
} {
  if (
    !value ||
    typeof value !== "object" ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !value.path ||
    value.path.length > 1024 ||
    Object.keys(value).some((key) => !["path", "fingerprint"].includes(key))
  ) {
    throw new WorkspaceError(
      "invalid finance request",
      400,
      "invalid_finance_request",
    );
  }
  if (
    "fingerprint" in value &&
    (typeof value.fingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(value.fingerprint))
  )
    throw new WorkspaceError(
      "invalid fingerprint",
      400,
      "invalid_finance_request",
    );
  return {
    path: value.path,
    ...("fingerprint" in value
      ? { fingerprint: value.fingerprint as string }
      : {}),
  };
}

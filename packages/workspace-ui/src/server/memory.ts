import { closeSync, constants, fchmodSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import type {
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceTreeEntry,
  WorkspaceWriteResponse,
} from "../shared/api";
import { MEMORY_FILENAMES, memoryDocumentPath } from "../shared/memory";
import { revision, WorkspaceError, WorkspaceService } from "./workspace";

const LOCK_EX = 2;
const LOCK_UN = 8;
const LOCK_NB = 4;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const memoryLimits: Record<string, number> = {
  "USER.md": 1_375,
  "MEMORY.md": 2_200,
};
const libc = dlopen(
  process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
  {
    flock: {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  },
);

function acquireLock(fd: number): void {
  const started = Date.now();
  while (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    if (Date.now() - started >= LOCK_TIMEOUT_MS) {
      throw new WorkspaceError(
        "memory file is temporarily unavailable",
        503,
        "memory_locked",
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
  }
}

export class MemoryFileService {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly memoriesRoot: string | undefined,
  ) {}

  private service(name: unknown): WorkspaceService {
    if (!this.workspace.settings().enable_memory_editing) {
      throw new WorkspaceError(
        "memory editing is disabled",
        403,
        "memory_editing_disabled",
      );
    }
    if (
      typeof name !== "string" ||
      !MEMORY_FILENAMES.some((file) => file === name)
    ) {
      throw new WorkspaceError("invalid memory file", 400, "invalid_path");
    }
    if (!this.memoriesRoot) {
      throw new WorkspaceError(
        "memories root is not configured",
        503,
        "memory_unavailable",
      );
    }
    // Never follow a symlink at the configured root either.
    try {
      if (!lstatSync(this.memoriesRoot).isDirectory()) {
        throw new WorkspaceError(
          "invalid memories root",
          403,
          "protected_path",
        );
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(
        "memories root is unavailable",
        503,
        "memory_unavailable",
      );
    }
    try {
      if (lstatSync(join(this.memoriesRoot, name)).isSymbolicLink()) {
        throw new WorkspaceError(
          "memory symlinks are not supported",
          403,
          "symlink_not_allowed",
        );
      }
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    return new WorkspaceService({
      workspaceRoot: this.memoriesRoot,
      maxEditableBytes: this.workspace.maxEditableBytes,
    });
  }

  available(): boolean {
    if (!this.memoriesRoot) return false;
    try {
      return lstatSync(this.memoriesRoot).isDirectory();
    } catch {
      return false;
    }
  }

  private withLock<T>(name: string, operation: () => T): T {
    if (!this.memoriesRoot) {
      throw new WorkspaceError(
        "memories root is not configured",
        503,
        "memory_unavailable",
      );
    }
    const lockPath = join(this.memoriesRoot, `${name}.lock`);
    let fd: number;
    try {
      fd = openSync(
        lockPath,
        constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ELOOP") {
        throw new WorkspaceError(
          "memory lock symlinks are not supported",
          403,
          "symlink_not_allowed",
        );
      }
      throw new WorkspaceError(
        "memory file is temporarily unavailable",
        503,
        "memory_locked",
      );
    }
    let locked = false;
    try {
      fchmodSync(fd, 0o600);
      acquireLock(fd);
      locked = true;
      return operation();
    } finally {
      if (locked) libc.symbols.flock(fd, LOCK_UN);
      closeSync(fd);
    }
  }

  private missing(name: string): WorkspaceFile {
    return {
      schema: 1,
      source: "memory",
      missing: true,
      path: memoryDocumentPath(name),
      content: "",
      revision: revision(new Uint8Array()),
      size: 0,
      modified_at: "",
      editable: true,
    };
  }

  metadata(name: unknown): WorkspaceFileMetadata {
    const service = this.service(name);
    try {
      return {
        ...service.metadata(name),
        path: memoryDocumentPath(name as string),
        source: "memory",
      };
    } catch (error) {
      if (error instanceof WorkspaceError && error.status === 404)
        return this.missing(name as string);
      throw error;
    }
  }

  entries(): WorkspaceTreeEntry[] {
    if (!this.workspace.settings().enable_memory_editing || !this.memoriesRoot)
      return [];
    return MEMORY_FILENAMES.flatMap((name) => {
      try {
        return [{ ...this.metadata(name), kind: "file" as const }];
      } catch {
        return [];
      }
    });
  }

  read(name: unknown): WorkspaceFile {
    const service = this.service(name);
    try {
      return {
        ...service.read(name),
        path: memoryDocumentPath(name as string),
        source: "memory",
      };
    } catch (error) {
      if (error instanceof WorkspaceError && error.status === 404)
        return this.missing(name as string);
      throw error;
    }
  }

  write(
    name: unknown,
    content: unknown,
    expectedRevision: unknown,
  ): WorkspaceWriteResponse {
    const filename = name as string;
    this.service(filename);
    if (typeof content !== "string") {
      throw new WorkspaceError(
        "content must be a string",
        400,
        "invalid_content",
      );
    }
    const characterCount = [...content].length;
    const limit = memoryLimits[filename];
    if (limit === undefined) {
      throw new WorkspaceError("invalid memory file", 400, "invalid_path");
    }
    if (characterCount > limit) {
      throw new WorkspaceError(
        `${filename} exceeds the Hermes memory limit of ${limit} characters`,
        413,
        "memory_too_large",
      );
    }
    return this.withLock(filename, () => {
      const service = this.service(filename);
      return {
        ...service.write(filename, content, expectedRevision),
        path: memoryDocumentPath(filename),
        source: "memory",
        missing: false,
      };
    });
  }
}

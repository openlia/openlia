import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WorkspaceError } from "./workspace";

// The same stdlib-only engine runs inside Hermes. Its store is in the shared
// workspace Git directory, not either container's private runtime directory.
export class CheckpointService {
  constructor(private readonly workspaceRoot: string) {}

  async call(input: Record<string, unknown>): Promise<object> {
    if (!existsSync(resolve(this.workspaceRoot, ".git"))) {
      if (input.action === "list") return { proposals: [] };
      throw new WorkspaceError(
        "Git is not configured",
        400,
        "workspace_git_not_configured",
      );
    }
    let script = "/opt/openlia/git_proposals.py";
    if (!existsSync(script)) {
      // Source-mode tests and local bundled previews have different depths.
      let directory = import.meta.dir;
      for (let depth = 0; depth < 7; depth++) {
        const candidate = join(
          directory,
          "profile/plugins/openlia-workspace-git/git_proposals.py",
        );
        if (existsSync(candidate)) {
          script = candidate;
          break;
        }
        directory = dirname(directory);
      }
    }
    if (!existsSync(script))
      throw new WorkspaceError(
        "Checkpoint service unavailable",
        503,
        "checkpoint_service_unavailable",
      );
    const child = Bun.spawn(["python3", script, this.workspaceRoot], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, , exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    let result: { ok: boolean; result: object; error: string; status: number };
    try {
      result = JSON.parse(output);
    } catch {
      throw new WorkspaceError(
        "Checkpoint service unavailable",
        503,
        "checkpoint_service_unavailable",
      );
    }
    if (exit !== 0 || !result.ok) {
      throw new WorkspaceError(
        "Checkpoint operation failed",
        result.status || 500,
        result.error || "checkpoint_operation_failed",
      );
    }
    return result.result;
  }
}

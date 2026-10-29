import type { WorkspaceApi } from "../api";
import { navigateRoute } from "../route";

export interface OpenLiaToolContext {
  api: WorkspaceApi;
  domainPath?: string | undefined;
  currentRecordPath?: string | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}

export function createOpenLiaToolProvider(
  ctx: OpenLiaToolContext,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return {
    async openRecord(args: Record<string, unknown>) {
      const path =
        typeof args.path === "string" ? args.path.replace(/^\/+/, "") : "";
      if (!path) return;
      if (ctx.onOpenFile) {
        ctx.onOpenFile(path);
        return;
      }
      navigateRoute({ path, tab: "documents" });
    },
  };
}

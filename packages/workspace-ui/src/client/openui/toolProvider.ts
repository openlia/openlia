import type { WorkspaceApi } from "../api";

export interface OpenLiaToolContext {
  api: WorkspaceApi;
  domainPath?: string | undefined;
  currentRecordPath?: string | undefined;
}

export function createOpenLiaToolProvider(
  ctx: OpenLiaToolContext,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return {
    async openRecord(args: Record<string, unknown>) {
      const path = typeof args.path === "string" ? args.path : "";
      if (path && typeof window !== "undefined") {
        window.location.href = `/files/${encodeURIComponent(path.replace(/^\/+/, ""))}`;
      }
    },
    async createRecord(args: Record<string, unknown>) {
      const domain =
        typeof args.domain === "string" ? args.domain : (ctx.domainPath ?? "");
      return ctx.api.loadDomainOverview(domain);
    },
    async updateFrontmatter(args: Record<string, unknown>) {
      const path = typeof args.path === "string" ? args.path : "";
      const updates =
        args.updates && typeof args.updates === "object"
          ? (args.updates as Record<string, unknown>)
          : {};
      const doc = await ctx.api.loadFile(path);
      return { doc, updates };
    },
  };
}

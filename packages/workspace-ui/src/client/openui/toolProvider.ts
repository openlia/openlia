import type { WorkspaceApi } from "../api";

export interface OpenLiaToolContext {
  api: WorkspaceApi;
  domainPath?: string | undefined;
  currentRecordPath?: string | undefined;
}

export function createOpenLiaToolProvider(ctx: OpenLiaToolContext) {
  return {
    async openRecord(path: string) {
      if (typeof window !== "undefined") {
        window.location.href = `/files/${encodeURIComponent(path.replace(/^\/+/, ""))}`;
      }
    },
    async createRecord(domain: string) {
      return ctx.api.loadDomainOverview(domain);
    },
    async updateFrontmatter(path: string, updates: Record<string, unknown>) {
      const doc = await ctx.api.loadFile(path);
      return { doc, updates };
    },
  };
}

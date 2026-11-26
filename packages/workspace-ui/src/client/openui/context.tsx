import { createContext, useContext } from "react";
import type { DocumentScope } from "../../shared/api";
import { httpWorkspaceApi, type WorkspaceApi } from "../api";
import { resolveRelativePath } from "../openliaLinks";

export interface OpenLiaOpenUIContextValue {
  api?: WorkspaceApi | undefined;
  filePath?: string | undefined;
  scope?: DocumentScope | undefined;
  onNavigateLink?: ((href: string) => void) | undefined;
}

const OpenLiaOpenUIContext = createContext<OpenLiaOpenUIContextValue>({
  api: httpWorkspaceApi,
  scope: "workspace",
});

export const OpenLiaOpenUIProvider = OpenLiaOpenUIContext.Provider;

export function useOpenLiaOpenUI(): OpenLiaOpenUIContextValue {
  return useContext(OpenLiaOpenUIContext);
}

export function resolveOpenUISourcePath(
  source: string,
  currentFilePath?: string | undefined,
  currentScope: DocumentScope = "workspace",
): { path: string; scope: DocumentScope } {
  const trimmed = source.trim();
  if (trimmed.startsWith("openlia://")) {
    try {
      const uri = new URL(trimmed);
      const host = uri.host.toLowerCase();
      const targetScope: DocumentScope =
        host === "skills" || host === "skill"
          ? "skills"
          : host === "agent"
            ? "agent"
            : "workspace";
      const path = decodeURIComponent(uri.pathname.replace(/^\/+/, ""));
      return { path, scope: targetScope };
    } catch {
      // Fallback below
    }
  }
  if (trimmed.startsWith("/")) {
    return { path: trimmed.replace(/^\/+/, ""), scope: currentScope };
  }
  const resolved = currentFilePath
    ? resolveRelativePath(trimmed, currentFilePath)
    : trimmed.replace(/^\.\//, "");
  return { path: resolved, scope: currentScope };
}

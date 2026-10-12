import { useQuery } from "@tanstack/react-query";
import { useWorkspaceApi } from "./ApiContext";

export const workspaceKeys = {
  all: ["workspace"] as const,
  tree: () => [...workspaceKeys.all, "tree"] as const,
  session: () => [...workspaceKeys.all, "session"] as const,
  git: () => [...workspaceKeys.all, "git"] as const,
  activity: () => [...workspaceKeys.all, "activity"] as const,
  diagnostics: () => [...workspaceKeys.all, "diagnostics"] as const,
  settings: () => [...workspaceKeys.all, "settings"] as const,
  systemInfo: () => [...workspaceKeys.all, "systemInfo"] as const,
  file: (path: string) => [...workspaceKeys.all, "file", path] as const,
  fileMetadata: (path: string) =>
    [...workspaceKeys.all, "fileMetadata", path] as const,
  skills: () => [...workspaceKeys.all, "skills"] as const,
  skillDetail: (id: string) => [...workspaceKeys.all, "skill", id] as const,
  skillFile: (id: string, path: string) =>
    [...workspaceKeys.all, "skillFile", id, path] as const,
  migrations: () => [...workspaceKeys.all, "migrations"] as const,
  migrationDetail: (id: string) =>
    [...workspaceKeys.all, "migration", id] as const,
  ingestion: () => [...workspaceKeys.all, "ingestion"] as const,
  ingestionDetail: (id: string) =>
    [...workspaceKeys.all, "ingestion", id] as const,
};

export function useWorkspaceTree(options?: { enabled?: boolean }) {
  const api = useWorkspaceApi();
  return useQuery({
    queryKey: workspaceKeys.tree(),
    queryFn: () => api.loadTree(),
    enabled: options?.enabled ?? true,
    staleTime: 3000,
  });
}

export function useWorkspaceGit(options?: { enabled?: boolean }) {
  const api = useWorkspaceApi();
  return useQuery({
    queryKey: workspaceKeys.git(),
    queryFn: () => api.loadGitStatus().catch(() => null),
    enabled: options?.enabled ?? true,
    staleTime: 3000,
  });
}

export function useWorkspaceActivity(options?: { enabled?: boolean }) {
  const api = useWorkspaceApi();
  return useQuery({
    queryKey: workspaceKeys.activity(),
    queryFn: () => api.loadActivity().catch(() => null),
    enabled: options?.enabled ?? true,
    staleTime: 5000,
  });
}

export function useWorkspaceDiagnostics(options?: { enabled?: boolean }) {
  const api = useWorkspaceApi();
  return useQuery({
    queryKey: workspaceKeys.diagnostics(),
    queryFn: () => api.loadDiagnostics().catch(() => null),
    enabled: options?.enabled ?? true,
    staleTime: 5000,
  });
}

export function useWorkspaceSettings(options?: { enabled?: boolean }) {
  const api = useWorkspaceApi();
  return useQuery({
    queryKey: workspaceKeys.settings(),
    queryFn: () => api.loadSettings().catch(() => null),
    enabled: options?.enabled ?? true,
    staleTime: 10000,
  });
}

export function useWorkspaceSkills(options?: { enabled?: boolean }) {
  const api = useWorkspaceApi();
  return useQuery({
    queryKey: workspaceKeys.skills(),
    queryFn: () =>
      api.loadSkills().catch(() => ({
        categories: [],
        schema: 1 as const,
        skills: [],
      })),
    enabled: options?.enabled ?? true,
    staleTime: 5000,
  });
}

export function useWorkspaceMigrations(options?: { enabled?: boolean }) {
  const api = useWorkspaceApi();
  return useQuery({
    queryKey: workspaceKeys.migrations(),
    queryFn: () => api.loadMigrations().catch(() => []),
    enabled: options?.enabled ?? true,
    staleTime: 3000,
  });
}

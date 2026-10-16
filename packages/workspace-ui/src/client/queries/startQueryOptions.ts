import { queryOptions } from "@tanstack/react-query";
import { workspaceClientApi } from "../runtimeApi";
import { workspaceKeys } from "./useWorkspaceQueries";

export function workspaceSessionQueryOptions(
  api = workspaceClientApi,
  scenario?: string,
) {
  return queryOptions({
    queryKey: [...workspaceKeys.session(), scenario ?? "default"],
    queryFn: () => api.loadSession(),
    staleTime: 30_000,
  });
}

export function workspaceTreeQueryOptions(
  api = workspaceClientApi,
  scenario?: string,
) {
  return queryOptions({
    queryKey: [...workspaceKeys.tree(), scenario ?? "default"],
    queryFn: () => api.loadTree(),
    staleTime: 3_000,
  });
}

import { createContext, useContext } from "react";
import type { WorkspaceApi } from "../api";

export const ApiContext = createContext<WorkspaceApi | null>(null);

export function useWorkspaceApi(): WorkspaceApi {
  const api = useContext(ApiContext);
  if (!api) {
    throw new Error("useWorkspaceApi must be used within an ApiContext.Provider");
  }
  return api;
}

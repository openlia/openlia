import { useQueryClient } from "@tanstack/react-query";
import { useLoaderData } from "@tanstack/react-router";
import { ApiContext } from "../client/queries/ApiContext";
import { App } from "../client/App";
import { workspaceClientApi } from "../client/runtimeApi";

export function WorkspaceRoute() {
  const { session, tree } = useLoaderData({ from: "__root__" });
  const queryClient = useQueryClient();

  return (
    <ApiContext.Provider value={workspaceClientApi}>
      <App
        api={workspaceClientApi}
        queryClient={queryClient}
        {...(session
          ? {
              initialData: {
                session,
                ...(tree ? { tree } : {}),
              },
            }
          : {})}
      />
    </ApiContext.Provider>
  );
}

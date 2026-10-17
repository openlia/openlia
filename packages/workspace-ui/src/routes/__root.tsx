import type { ReactNode } from "react";
import {
  HeadContent,
  Scripts,
  useRouter,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { installWorkspaceRouter } from "../client/route";
import { createWorkspaceClientApi } from "../client/runtimeApi";
import { WorkspaceRoute } from "./-WorkspaceRoute";
import {
  workspaceSessionQueryOptions,
  workspaceTreeQueryOptions,
} from "../client/queries/startQueryOptions";
import "../client/styles.css";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  ssr: "data-only",
  staleTime: Infinity,
  loader: async ({ context, location }) => {
    const scenario = new URL(
      String(location.href),
      "http://localhost",
    ).searchParams.get("scenario");
    if (scenario === "error" || scenario === "loading") {
      return { session: undefined, tree: undefined };
    }
    const api = createWorkspaceClientApi(scenario);
    try {
      const session = await context.queryClient.ensureQueryData(
        workspaceSessionQueryOptions(api, scenario ?? undefined),
      );
      const tree =
        session.auth_required && !session.authenticated
          ? undefined
          : await context.queryClient.ensureQueryData(
              workspaceTreeQueryOptions(api, scenario ?? undefined),
            );
      return { session, tree };
    } catch {
      return { session: undefined, tree: undefined };
    }
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      { title: "OpenLia Workspace" },
    ],
  }),
  shellComponent: RootShell,
  pendingComponent: PendingWorkspace,
  component: RootComponent,
});

function RootShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <HeadContent />
      </head>
      <body className="bg-base-300">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function PendingWorkspace() {
  return (
    <main className="grid min-h-dvh place-items-center bg-base-300 p-4 text-base-content">
      <p className="text-sm text-base-content/60">Loading workspace...</p>
    </main>
  );
}

function RootComponent() {
  const router = useRouter();
  installWorkspaceRouter(router);

  // Keep the workspace mounted while child routes update the URL.
  return <WorkspaceRoute />;
}

import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { routeTree } from "./routeTree.gen";

const currentCspNonce = createIsomorphicFn()
  .client(() => undefined)
  .server(async () => (await import("./server/cspContext")).currentCspNonce());

export async function getRouter() {
  const nonce =
    typeof window === "undefined"
      ? ((await currentCspNonce()) ?? globalThis.crypto.randomUUID())
      : globalThis.crypto.randomUUID();

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  const router = createRouter({
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    routeTree,
    ssr: { nonce },
    scrollRestoration: true,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

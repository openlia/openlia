import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { buildContentSecurityPolicy } from "./cspPolicy";
import { withCspNonce } from "./server/cspContext";

const securityMiddleware = createMiddleware().server(({ next }) => {
  const nonce = globalThis.crypto.randomUUID();
  setResponseHeader("Cache-Control", "no-store");
  setResponseHeader(
    "Content-Security-Policy",
    buildContentSecurityPolicy(nonce),
  );
  setResponseHeader("Referrer-Policy", "no-referrer");
  setResponseHeader("X-Content-Type-Options", "nosniff");
  return withCspNonce(nonce, next);
});

const csrfMiddleware = createCsrfMiddleware({
  filter: (context) => context.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [securityMiddleware, csrfMiddleware],
}));

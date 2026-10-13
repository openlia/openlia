import { join, resolve } from "node:path";
import { createWorkspaceHandler } from "./app";

function portFromEnvironment(value: string | undefined): number {
  const port = Number(value ?? "8089");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      "OPENLIA_WORKSPACE_UI_PORT must be an integer between 1 and 65535",
    );
  }
  return port;
}

const workspaceRoot = resolve(
  process.env.OPENLIA_WORKSPACE_ROOT ?? "/workspace",
);
const skillsRoot = process.env.OPENLIA_SKILLS_ROOT
  ? resolve(process.env.OPENLIA_SKILLS_ROOT)
  : resolve(workspaceRoot, "..", "skills");
const ingestionRoot = process.env.OPENLIA_INGESTION_ROOT
  ? resolve(process.env.OPENLIA_INGESTION_ROOT)
  : undefined;
const migrationsRoot = process.env.OPENLIA_MIGRATIONS_ROOT
  ? resolve(process.env.OPENLIA_MIGRATIONS_ROOT)
  : undefined;
const bind = process.env.OPENLIA_WORKSPACE_UI_BIND ?? "127.0.0.1";
const port = portFromEnvironment(process.env.OPENLIA_WORKSPACE_UI_PORT);
const authRequired = process.env.OPENLIA_WORKSPACE_UI_AUTH_REQUIRED === "true";
const passwordHashFile = process.env.OPENLIA_WORKSPACE_UI_PASSWORD_HASH_FILE;
const rawAllowedEmails = process.env.OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS ?? "";
const allowedEmails = rawAllowedEmails
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);
const firebaseProjectId = process.env.OPENLIA_WORKSPACE_UI_FIREBASE_PROJECT_ID;
const firebaseApiKey = process.env.OPENLIA_WORKSPACE_UI_FIREBASE_API_KEY;
const firebaseAuthDomain =
  process.env.OPENLIA_WORKSPACE_UI_FIREBASE_AUTH_DOMAIN;
const firebaseAppId = process.env.OPENLIA_WORKSPACE_UI_FIREBASE_APP_ID;

const isFirebase = Boolean(firebaseProjectId && allowedEmails.length > 0);
const authProvider = isFirebase
  ? "firebase"
  : authRequired
    ? "password"
    : "none";

const firebaseConfig =
  firebaseProjectId && firebaseApiKey && firebaseAuthDomain
    ? {
        apiKey: firebaseApiKey,
        authDomain: firebaseAuthDomain,
        projectId: firebaseProjectId,
        ...(firebaseAppId ? { appId: firebaseAppId } : {}),
      }
    : undefined;

const handler = createWorkspaceHandler({
  allowedEmails,
  authProvider,
  authRequired: authRequired || isFirebase,
  ...(firebaseConfig ? { firebaseConfig } : {}),
  ...(process.env.OPENLIA_MEMORIES_ROOT
    ? { memoriesRoot: resolve(process.env.OPENLIA_MEMORIES_ROOT) }
    : {}),
  ...(ingestionRoot ? { ingestionRoot } : {}),
  ...(migrationsRoot ? { migrationsRoot } : {}),
  passwordHashFile,
  publicOrigin: process.env.OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN,
  sessionDatabasePath:
    process.env.OPENLIA_WORKSPACE_UI_SESSION_DB ??
    "/var/lib/openlia/sessions.sqlite",
  skillsRoot,
  staticRoot: join(import.meta.dir, "public"),
  systemInfo: {
    hermes_version:
      process.env.OPENLIA_HERMES_VERSION ?? process.env.HERMES_BASE_TAG,
    locho_version: process.env.OPENLIA_LOCHO_VERSION,
    openlia_hash: process.env.OPENLIA_REVISION,
    openlia_version: process.env.OPENLIA_VERSION,
  },
  workspaceRoot,
});
const server = Bun.serve({
  fetch(request, instance) {
    return handler(request, instance.requestIP(request)?.address ?? "global");
  },
  hostname: bind,
  port,
});

console.log(`workspace-ui listening on ${bind}:${port}`);

export { server };

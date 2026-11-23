import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AuthProvider } from "../shared/api";
import { createWorkspaceHandler } from "./app";

function releaseIdentityFromImage(): string | undefined {
  try {
    const value = readFileSync("/opt/openlia/release.sha256", "utf8").trim();
    return value || undefined;
  } catch {
    return process.env.OPENLIA_RELEASE_SHA256 || undefined;
  }
}

export function createConfiguredWorkspaceHandler() {
  const workspaceRoot = resolve(
    process.env.OPENLIA_WORKSPACE_ROOT ?? "/opt/data/workspace",
  );

  const explicitDataRoots = [
    process.env.OPENLIA_DATA_ROOT,
    process.env.OPENLIA_PROFILE_ROOT,
  ].filter((item): item is string => Boolean(item?.trim()));
  const explicitDataRoot = explicitDataRoots.find((dir) => existsSync(dir));

  const dataRootCandidates = [
    "/opt/data",
    resolve(workspaceRoot, ".."),
    resolve(workspaceRoot, "../profile"),
  ];
  const dataRoot =
    explicitDataRoot ??
    dataRootCandidates.find(
      (dir) =>
        existsSync(join(dir, "SOUL.md")) ||
        existsSync(join(dir, "AGENTS.md")) ||
        existsSync(join(dir, "memories")),
    );

  const skillsCandidates = [
    process.env.OPENLIA_WORKSPACE_UI_SKILLS_ROOT,
    process.env.OPENLIA_SKILLS_ROOT,
    "/skills",
    "/opt/data/skills",
    resolve(workspaceRoot, "../skills"),
  ].filter((item): item is string => Boolean(item));
  const skillsRoot =
    skillsCandidates.find((dir) => existsSync(dir)) ??
    resolve(workspaceRoot, "../skills");

  const staticCandidates = [
    process.env.OPENLIA_WORKSPACE_UI_STATIC_ROOT,
    typeof import.meta.dir === "string"
      ? join(import.meta.dir, "client")
      : undefined,
    typeof import.meta.dir === "string"
      ? resolve(import.meta.dir, "../../dist/client")
      : undefined,
  ].filter((item): item is string => Boolean(item));

  const staticRoot = staticCandidates.find((dir) => existsSync(dir));
  const releaseSha256 = releaseIdentityFromImage();

  const oidcIssuer = (
    process.env.OPENLIA_WORKSPACE_UI_OIDC_ISSUER ??
    process.env.HERMES_DASHBOARD_OIDC_ISSUER ??
    ""
  ).trim();
  const oidcClientId = (
    process.env.OPENLIA_WORKSPACE_UI_OIDC_CLIENT_ID ??
    process.env.HERMES_DASHBOARD_OIDC_CLIENT_ID ??
    ""
  ).trim();
  const oidcClientSecret = (
    process.env.OPENLIA_WORKSPACE_UI_OIDC_CLIENT_SECRET ??
    process.env.HERMES_DASHBOARD_OIDC_CLIENT_SECRET ??
    ""
  ).trim();
  const oidcScopes = (
    process.env.OPENLIA_WORKSPACE_UI_OIDC_SCOPES ??
    process.env.HERMES_DASHBOARD_OIDC_SCOPES ??
    "openid profile email"
  ).trim();
  const publicOrigin = (
    process.env.OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN ?? ""
  ).trim();

  const username = (
    process.env.OPENLIA_WORKSPACE_UI_USERNAME ??
    process.env.HERMES_DASHBOARD_BASIC_AUTH_USERNAME ??
    ""
  ).trim();
  const password =
    process.env.OPENLIA_WORKSPACE_UI_PASSWORD ??
    process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD ??
    "";
  const passwordHash = process.env.OPENLIA_WORKSPACE_UI_PASSWORD_HASH;
  const passwordHashFile = process.env.OPENLIA_WORKSPACE_UI_PASSWORD_HASH_FILE;

  const hasOidc = Boolean(oidcIssuer && oidcClientId);
  const hasPassword = Boolean(password || passwordHash || passwordHashFile);
  const bind = (process.env.OPENLIA_WORKSPACE_UI_BIND ?? "127.0.0.1")
    .trim()
    .toLowerCase();
  const isLoopbackBind =
    bind === "" ||
    bind === "127.0.0.1" ||
    bind === "localhost" ||
    bind === "::1" ||
    bind === "[::1]";

  const explicitAuthRequired =
    process.env.OPENLIA_WORKSPACE_UI_AUTH_REQUIRED?.trim().toLowerCase();
  const authRequired =
    explicitAuthRequired === "false"
      ? false
      : explicitAuthRequired === "true"
        ? true
        : hasOidc || hasPassword || !isLoopbackBind;

  const authProvider: AuthProvider = !authRequired
    ? "none"
    : hasOidc
      ? "oidc"
      : "password";

  const rawAllowedEmails =
    process.env.OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS ??
    process.env.HERMES_DASHBOARD_ALLOWED_EMAILS ??
    "";
  const allowedEmails = rawAllowedEmails
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const allowAnyOidcEmail =
    process.env.OPENLIA_WORKSPACE_UI_ALLOW_ANY_OIDC_EMAIL === "true";

  const explicitTrustProxy = process.env.OPENLIA_WORKSPACE_UI_TRUST_PROXY;
  const trustProxy =
    explicitTrustProxy === "true"
      ? true
      : explicitTrustProxy === "false"
        ? false
        : undefined;

  const defaultSessionDb = existsSync("/var/lib/openlia")
    ? "/var/lib/openlia/sessions.sqlite"
    : join(homedir(), ".openlia", "cache", "workspace-ui", "sessions.sqlite");

  return createWorkspaceHandler({
    workspaceRoot,
    ...(dataRoot ? { dataRoot } : {}),
    skillsRoot,
    ...(staticRoot ? { staticRoot } : {}),
    ...(releaseSha256 ? { releaseSha256 } : {}),
    authRequired,
    authProvider,
    username,
    password,
    passwordHash,
    passwordHashFile,
    ...(hasOidc
      ? {
          oidcConfig: {
            issuer: oidcIssuer,
            clientId: oidcClientId,
            ...(oidcClientSecret ? { clientSecret: oidcClientSecret } : {}),
            scopes: oidcScopes,
            ...(publicOrigin ? { publicUrl: publicOrigin } : {}),
          },
        }
      : {}),
    allowedEmails,
    allowAnyOidcEmail,
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(trustProxy !== undefined ? { trustProxy } : {}),
    sessionDatabasePath:
      process.env.OPENLIA_WORKSPACE_UI_SESSION_DB ?? defaultSessionDb,
  });
}

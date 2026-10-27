import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
  const staticRoot =
    typeof import.meta.dir === "string"
      ? join(import.meta.dir, "public")
      : undefined;
  const releaseSha256 = releaseIdentityFromImage();
  const authRequired =
    process.env.OPENLIA_WORKSPACE_UI_AUTH_REQUIRED === "true";
  const passwordHashFile = process.env.OPENLIA_WORKSPACE_UI_PASSWORD_HASH_FILE;
  const rawAllowedEmails =
    process.env.OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS ?? "";
  const allowedEmails = rawAllowedEmails
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const firebaseProjectId =
    process.env.OPENLIA_WORKSPACE_UI_FIREBASE_PROJECT_ID;
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

  return createWorkspaceHandler({
    ...(process.env.OPENLIA_HERMES_API_URL && process.env.API_SERVER_KEY
      ? {
          chat: {
            url: process.env.OPENLIA_HERMES_API_URL,
            key: process.env.API_SERVER_KEY,
            databasePath: join(
              process.env.OPENLIA_RUNTIME_ROOT ??
                homedir() + "/.openlia/cache/workspace-ui",
              "chat.sqlite",
            ),
          },
        }
      : {}),
    allowedEmails,
    authProvider,
    authRequired: authRequired || isFirebase,
    ...(firebaseConfig ? { firebaseConfig } : {}),
    ...(process.env.OPENLIA_MEMORIES_ROOT
      ? { memoriesRoot: resolve(process.env.OPENLIA_MEMORIES_ROOT) }
      : {}),
    ...(ingestionRoot ? { ingestionRoot } : {}),
    ...(migrationsRoot ? { migrationsRoot } : {}),
    ...(releaseSha256 ? { releaseSha256 } : {}),
    passwordHashFile,
    publicOrigin: process.env.OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN,
    sessionDatabasePath:
      process.env.OPENLIA_WORKSPACE_UI_SESSION_DB ??
      "/var/lib/openlia/sessions.sqlite",
    sharesDatabasePath:
      process.env.OPENLIA_WORKSPACE_UI_SHARES_DB ??
      (process.env.OPENLIA_RUNTIME_ROOT === "/var/lib/openlia" ||
      existsSync("/var/lib/openlia")
        ? "/var/lib/openlia/shares.sqlite"
        : join(
            homedir(),
            ".openlia",
            "cache",
            "workspace-ui",
            "shares.sqlite",
          )),
    skillsRoot,
    ...(staticRoot ? { staticRoot } : {}),
    systemInfo: {
      hermes_version:
        process.env.OPENLIA_HERMES_VERSION ?? process.env.HERMES_BASE_TAG,
      locho_version: process.env.OPENLIA_LOCHO_VERSION,
      openlia_hash: process.env.OPENLIA_REVISION,
      openlia_version: process.env.OPENLIA_VERSION,
    },
    workspaceRoot,
    ...(process.env.OPENLIA_USAGE_ROOT
      ? { usageRoot: resolve(process.env.OPENLIA_USAGE_ROOT) }
      : {}),
    cronRoot: process.env.OPENLIA_CRON_ROOT
      ? resolve(process.env.OPENLIA_CRON_ROOT)
      : resolve(workspaceRoot, "..", "cron"),
    ...(process.env.OPENLIA_BACKUP_SCHEDULE
      ? { backupSchedule: process.env.OPENLIA_BACKUP_SCHEDULE }
      : {}),
    backupScheduleEnabled:
      process.env.OPENLIA_BACKUP_SCHEDULE_ENABLED === "true" ||
      process.env.OPENLIA_BACKUP_SCHEDULE_ENABLED === undefined,
    ...(process.env.OPENLIA_WORKSPACE_GIT_SCHEDULE
      ? { workspaceGitSchedule: process.env.OPENLIA_WORKSPACE_GIT_SCHEDULE }
      : {}),
    ...(process.env.OPENLIA_TIMEZONE
      ? { timezone: process.env.OPENLIA_TIMEZONE }
      : {}),
  });
}

import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

const sessionCookie = "openlia_workspace_session";
const defaultIdleTimeoutMs = 7 * 24 * 60 * 60 * 1000;
const defaultAbsoluteTimeoutMs = 30 * 24 * 60 * 60 * 1000;
const attemptWindowMs = 60 * 1000;
const blockDurationMs = 30 * 1000;
const maxFailures = 5;
const maxAttemptEntries = 10_000;
const maxSessionEntries = 1_024;

interface SessionRow {
  created_at: number;
  last_seen_at: number;
}

interface AuthStateRow {
  verifier_hash: string;
}

interface Attempt {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

import type { FirebaseClientConfig } from "../shared/api";
import { verifyFirebaseIdToken } from "./firebaseAuth";

export type AuthProvider = "password" | "firebase" | "none";

export interface AuthenticatorOptions {
  required: boolean;
  authProvider?: AuthProvider | undefined;
  allowedEmails?: string[] | undefined;
  firebaseConfig?: FirebaseClientConfig | undefined;
  firebaseJwksUrl?: string | undefined;
  passwordHash?: string | undefined;
  passwordHashFile?: string | undefined;
  secureCookies?: boolean | undefined;
  sessionDatabasePath?: string | undefined;
  idleTimeoutMs?: number | undefined;
  absoluteTimeoutMs?: number | undefined;
}

export type LoginResult =
  | { kind: "ok"; cookie: string }
  | { kind: "invalid" }
  | { kind: "rate_limited" }
  | { kind: "disabled" }
  | { kind: "forbidden_user"; email?: string | undefined }
  | { kind: "unverified_email" };

export class Authenticator {
  readonly required: boolean;
  readonly secureCookies: boolean;
  readonly authProvider: AuthProvider;
  readonly allowedEmails: ReadonlySet<string>;
  readonly firebaseConfig?: FirebaseClientConfig | undefined;
  private readonly firebaseJwksUrl?: string | undefined;
  private readonly passwordHash: string;
  private readonly database: Database | undefined;
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly attempts = new Map<string, Attempt>();
  private verificationInProgress = false;

  constructor(options: AuthenticatorOptions) {
    this.required = options.required;
    this.secureCookies = options.secureCookies ?? false;
    this.authProvider =
      options.authProvider ?? (options.required ? "password" : "none");
    const emails = new Set<string>();
    if (options.allowedEmails) {
      for (const email of options.allowedEmails) {
        const trimmed = email.toLowerCase().trim();
        if (trimmed) emails.add(trimmed);
      }
    }
    this.allowedEmails = emails;
    this.firebaseConfig = options.firebaseConfig;
    this.firebaseJwksUrl = options.firebaseJwksUrl;
    this.idleTimeoutMs = positiveTimeout(
      options.idleTimeoutMs ?? defaultIdleTimeoutMs,
      "idle session timeout",
    );
    this.absoluteTimeoutMs = positiveTimeout(
      options.absoluteTimeoutMs ?? defaultAbsoluteTimeoutMs,
      "absolute session timeout",
    );
    this.passwordHash =
      options.passwordHash ??
      (options.passwordHashFile
        ? readFileSync(options.passwordHashFile, "utf8").trim()
        : "");
    if (
      this.required &&
      this.authProvider === "password" &&
      !isSupportedArgon2idHash(this.passwordHash)
    ) {
      throw new Error(
        "workspace-ui password verifier is missing or unsupported",
      );
    }
    if (this.required && this.authProvider === "firebase") {
      if (this.allowedEmails.size === 0 || !this.firebaseConfig?.projectId) {
        throw new Error(
          "workspace-ui firebase authentication requires allowedEmails and firebaseConfig.projectId",
        );
      }
    }
    if (this.required) {
      const databasePath = options.sessionDatabasePath ?? ":memory:";
      if (databasePath !== ":memory:") {
        mkdirSync(dirname(databasePath), { mode: 0o700, recursive: true });
      }
      this.database = new Database(databasePath);
      if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
      this.database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS auth_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          verifier_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_last_seen_idx
          ON sessions(last_seen_at);
      `);
      this.reconcileVerifier();
    }
  }

  sessionResponse(request: Request) {
    return {
      schema: 1 as const,
      auth_required: this.required,
      authenticated: !this.required || this.isAuthenticated(request),
      auth_provider: this.authProvider,
      ...(this.authProvider === "firebase"
        ? {
            firebase_config: this.firebaseConfig,
          }
        : {}),
    };
  }

  isAuthenticated(request: Request): boolean {
    if (!this.required) return true;
    const database = this.database;
    if (!database) return false;
    const now = Date.now();
    this.pruneSessions(now);
    const token = readCookie(request.headers.get("cookie"));
    if (!token) return false;
    const key = digestToken(token);
    const row = database
      .query(
        "SELECT created_at, last_seen_at FROM sessions WHERE token_hash = ?",
      )
      .get(key) as SessionRow | null;
    const session = row
      ? { createdAt: row.created_at, lastSeenAt: row.last_seen_at }
      : undefined;
    if (!session) return false;
    if (
      now - session.lastSeenAt > this.idleTimeoutMs ||
      now - session.createdAt > this.absoluteTimeoutMs
    ) {
      database.query("DELETE FROM sessions WHERE token_hash = ?").run(key);
      return false;
    }
    database
      .query("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
      .run(now, key);
    return true;
  }

  async login(
    password: string,
    clientKey: string,
    secureCookies = this.secureCookies,
  ): Promise<LoginResult> {
    if (!this.required) return { kind: "ok", cookie: "" };
    if (this.authProvider === "firebase") return { kind: "disabled" };
    const now = Date.now();
    let attempt = this.attempts.get(clientKey);
    if (attempt && attempt.blockedUntil > now) return { kind: "rate_limited" };
    if (attempt && now - attempt.firstFailureAt >= attemptWindowMs) {
      this.attempts.delete(clientKey);
      attempt = undefined;
    }
    if (this.verificationInProgress) return { kind: "rate_limited" };
    this.verificationInProgress = true;
    let valid = false;
    try {
      valid = await Bun.password.verify(
        password,
        this.passwordHash,
        "argon2id",
      );
    } catch {
      valid = false;
    } finally {
      this.verificationInProgress = false;
    }
    if (!valid) {
      this.recordFailure(clientKey, now);
      const blockedUntil = this.attempts.get(clientKey)?.blockedUntil ?? 0;
      return {
        kind: blockedUntil > now ? "rate_limited" : "invalid",
      };
    }
    this.attempts.delete(clientKey);
    return this.createSession(now, secureCookies);
  }

  async loginWithFirebase(
    idToken: string,
    clientKey: string,
    secureCookies = this.secureCookies,
  ): Promise<LoginResult> {
    if (!this.required) return { kind: "ok", cookie: "" };
    if (
      this.authProvider !== "firebase" ||
      !this.firebaseConfig?.projectId ||
      this.allowedEmails.size === 0
    ) {
      return { kind: "disabled" };
    }
    const now = Date.now();
    let attempt = this.attempts.get(clientKey);
    if (attempt && attempt.blockedUntil > now) return { kind: "rate_limited" };
    if (attempt && now - attempt.firstFailureAt >= attemptWindowMs) {
      this.attempts.delete(clientKey);
      attempt = undefined;
    }

    let payload: import("./firebaseAuth").FirebaseTokenPayload;
    try {
      payload = await verifyFirebaseIdToken(
        idToken,
        this.firebaseConfig.projectId,
        this.firebaseJwksUrl,
      );
    } catch {
      this.recordFailure(clientKey, now);
      const blockedUntil = this.attempts.get(clientKey)?.blockedUntil ?? 0;
      return { kind: blockedUntil > now ? "rate_limited" : "invalid" };
    }

    const tokenEmail = payload.email?.toLowerCase().trim();

    if (!tokenEmail || !this.allowedEmails.has(tokenEmail)) {
      this.recordFailure(clientKey, now);
      return { kind: "forbidden_user", email: payload.email };
    }

    if (!payload.email_verified) {
      this.recordFailure(clientKey, now);
      return { kind: "unverified_email" };
    }

    this.attempts.delete(clientKey);
    return this.createSession(now, secureCookies);
  }

  private createSession(now: number, secureCookies: boolean): LoginResult {
    const database = this.database;
    if (!database) return { kind: "invalid" };
    const token = randomBytes(32).toString("base64url");
    const tokenHash = digestToken(token);
    this.pruneSessions(now);
    const count = database
      .query("SELECT COUNT(*) AS count FROM sessions")
      .get() as { count: number };
    if (count.count >= maxSessionEntries) {
      database
        .query(
          "DELETE FROM sessions WHERE token_hash = (SELECT token_hash FROM sessions ORDER BY created_at ASC LIMIT 1)",
        )
        .run();
    }
    database
      .query(
        "INSERT INTO sessions (token_hash, created_at, last_seen_at) VALUES (?, ?, ?)",
      )
      .run(tokenHash, now, now);
    return { kind: "ok", cookie: this.cookie(token, secureCookies) };
  }

  logout(request: Request, secureCookies = this.secureCookies): string {
    const token = readCookie(request.headers.get("cookie"));
    if (token)
      this.database
        ?.query("DELETE FROM sessions WHERE token_hash = ?")
        .run(digestToken(token));
    return this.clearCookie(secureCookies);
  }

  private reconcileVerifier(): void {
    const database = this.database;
    if (!database) return;
    const sortedEmails = Array.from(this.allowedEmails).sort().join(",");
    const verifierString =
      this.authProvider === "firebase"
        ? `firebase:${this.firebaseConfig?.projectId}:${sortedEmails}`
        : this.passwordHash;
    const verifierHash = digestToken(verifierString);
    const current = database
      .query("SELECT verifier_hash FROM auth_state WHERE id = 1")
      .get() as AuthStateRow | null;
    if (current?.verifier_hash === verifierHash) return;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.query("DELETE FROM sessions").run();
      database
        .query(
          "INSERT INTO auth_state (id, verifier_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET verifier_hash = excluded.verifier_hash",
        )
        .run(verifierHash);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private recordFailure(clientKey: string, now: number): void {
    let attempt = this.attempts.get(clientKey);
    if (!attempt || now - attempt.firstFailureAt >= attemptWindowMs) {
      attempt = { failures: 0, firstFailureAt: now, blockedUntil: 0 };
      this.attempts.set(clientKey, attempt);
    }
    attempt.failures += 1;
    if (attempt.failures >= maxFailures)
      attempt.blockedUntil = now + blockDurationMs;
    if (this.attempts.size > maxAttemptEntries) {
      const oldest = this.attempts.keys().next().value;
      if (oldest) this.attempts.delete(oldest);
    }
  }

  private pruneSessions(now: number): void {
    this.database
      ?.query("DELETE FROM sessions WHERE last_seen_at < ? OR created_at < ?")
      .run(now - this.idleTimeoutMs, now - this.absoluteTimeoutMs);
  }

  private cookie(token: string, secureCookies: boolean): string {
    const secure = secureCookies ? "; Secure" : "";
    return `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${this.absoluteTimeoutMs / 1000}${secure}`;
  }

  private clearCookie(secureCookies: boolean): string {
    const secure = secureCookies ? "; Secure" : "";
    return `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  }
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer`);
  return value;
}

function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readCookie(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name === sessionCookie) return value.join("=") || undefined;
  }
  return undefined;
}

function isSupportedArgon2idHash(value: string): boolean {
  const parts = value.split("$");
  if (
    parts.length !== 6 ||
    parts[0] !== "" ||
    parts[1] !== "argon2id" ||
    parts[2] !== "v=19"
  )
    return false;
  const params = new Map(
    (parts[3] ?? "").split(",").map((item) => {
      const [key, value] = item.split("=");
      return [key ?? "", value ?? ""] as const;
    }),
  );
  const memory = Number(params.get("m"));
  const time = Number(params.get("t"));
  const parallelism = Number(params.get("p"));
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const key = Buffer.from(parts[5] ?? "", "base64");
  return (
    Number.isInteger(memory) &&
    memory >= 32 * 1024 &&
    memory <= 128 * 1024 &&
    Number.isInteger(time) &&
    time >= 2 &&
    time <= 5 &&
    Number.isInteger(parallelism) &&
    parallelism >= 1 &&
    parallelism <= 4 &&
    salt.length >= 16 &&
    key.length === 32
  );
}

export { sessionCookie };

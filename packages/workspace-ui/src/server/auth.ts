import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthProvider, AuthSessionResponse } from "../shared/api";

const sessionCookie = "openlia_workspace_session";
const oidcStateCookie = "openlia_workspace_oidc_state";
const defaultIdleTimeoutMs = 7 * 24 * 60 * 60 * 1000;
const defaultAbsoluteTimeoutMs = 30 * 24 * 60 * 60 * 1000;
const oidcStateTimeoutMs = 10 * 60 * 1000;
const attemptWindowMs = 60 * 1000;
const blockDurationMs = 30 * 1000;
const maxFailures = 5;
const maxAttemptEntries = 10_000;
const maxSessionEntries = 1_024;
const maxPendingOidcStates = 512;

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

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string | undefined;
  scopes?: string | undefined;
  publicUrl?: string | undefined;
}

interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface JwkKey {
  kty: string;
  alg?: string;
  use?: string;
  kid?: string;
  n?: string;
  e?: string;
}

interface PendingOidcState {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

export interface AuthenticatorOptions {
  required: boolean;
  authProvider?: AuthProvider | undefined;
  username?: string | undefined;
  password?: string | undefined;
  passwordHash?: string | undefined;
  passwordHashFile?: string | undefined;
  oidcConfig?: OidcConfig | undefined;
  allowedEmails?: string[] | undefined;
  secureCookies?: boolean | undefined;
  sessionDatabasePath?: string | undefined;
  idleTimeoutMs?: number | undefined;
  absoluteTimeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export type LoginResult =
  | { kind: "ok"; cookie: string }
  | { kind: "invalid" }
  | { kind: "rate_limited" }
  | { kind: "disabled" }
  | { kind: "forbidden_user"; email?: string | undefined };

export type OidcCallbackResult =
  | { kind: "ok"; cookie: string; clearStateCookie: string }
  | {
      kind: "error";
      status: number;
      code: string;
      message: string;
      clearStateCookie: string;
    };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Buffer(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function constantTimeEquals(a: string, b: string): boolean {
  const hashA = sha256Buffer(a);
  const hashB = sha256Buffer(b);
  return timingSafeEqual(hashA, hashB) && a.length === b.length;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function parseCookie(request: Request, targetName: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === targetName) {
      const value = rest.join("=").trim();
      return value || undefined;
    }
  }
  return undefined;
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

export class Authenticator {
  readonly required: boolean;
  readonly secureCookies: boolean;
  readonly authProvider: AuthProvider;
  readonly username: string;
  readonly oidcConfig?: OidcConfig | undefined;
  readonly allowedEmails: ReadonlySet<string>;
  private readonly password: string;
  private readonly passwordHash: string;
  private readonly database: Database | undefined;
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly attempts = new Map<string, Attempt>();
  private readonly pendingOidcStates = new Map<string, PendingOidcState>();
  private readonly fetchImpl: typeof fetch;
  private discoveryCache: {
    doc: OidcDiscoveryDocument;
    expiresAt: number;
  } | null = null;
  private jwksCache: {
    keys: Map<string, CryptoKey>;
    expiresAt: number;
  } | null = null;

  constructor(options: AuthenticatorOptions) {
    this.required = options.required;
    this.secureCookies = options.secureCookies ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;

    const emails = new Set<string>();
    if (options.allowedEmails) {
      for (const email of options.allowedEmails) {
        const trimmed = email.toLowerCase().trim();
        if (trimmed) emails.add(trimmed);
      }
    }
    this.allowedEmails = emails;

    this.oidcConfig = options.oidcConfig;
    this.username = (options.username ?? "").trim();
    this.password = options.password ?? "";
    this.passwordHash =
      options.passwordHash ??
      (options.passwordHashFile
        ? readFileSync(options.passwordHashFile, "utf8").trim()
        : "");

    if (options.authProvider) {
      this.authProvider = options.authProvider;
    } else if (!this.required) {
      this.authProvider = "none";
    } else if (this.oidcConfig?.issuer && this.oidcConfig?.clientId) {
      this.authProvider = "oidc";
    } else {
      this.authProvider = "password";
    }

    this.idleTimeoutMs = positiveTimeout(
      options.idleTimeoutMs ?? defaultIdleTimeoutMs,
      "idle session timeout",
    );
    this.absoluteTimeoutMs = positiveTimeout(
      options.absoluteTimeoutMs ?? defaultAbsoluteTimeoutMs,
      "absolute session timeout",
    );

    if (this.required && this.authProvider === "password") {
      if (!this.password && !this.passwordHash) {
        throw new Error("workspace-ui password credential is missing");
      }
    }
    if (this.required && this.authProvider === "oidc") {
      if (!this.oidcConfig?.issuer || !this.oidcConfig?.clientId) {
        throw new Error(
          "workspace-ui OIDC authentication requires issuer and clientId",
        );
      }
    }

    if (this.required) {
      const databasePath = options.sessionDatabasePath ?? ":memory:";
      if (databasePath !== ":memory:") {
        mkdirSync(dirname(databasePath), { mode: 0o700, recursive: true });
      }
      this.database = new Database(databasePath);
      if (databasePath !== ":memory:") {
        chmodSync(databasePath, 0o600);
      }
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

  private reconcileVerifier(): void {
    if (!this.database) return;
    const rawVerifier =
      this.authProvider === "oidc"
        ? `oidc:${this.oidcConfig?.issuer ?? ""}:${this.oidcConfig?.clientId ?? ""}`
        : `password:${this.username}:${this.password}:${this.passwordHash}`;
    const verifierHash = sha256Hex(rawVerifier);
    const existing = this.database
      .query<AuthStateRow, []>(
        "SELECT verifier_hash FROM auth_state WHERE id = 1",
      )
      .get();
    if (!existing) {
      this.database
        .query("INSERT INTO auth_state (id, verifier_hash) VALUES (1, ?)")
        .run(verifierHash);
      return;
    }
    if (existing.verifier_hash !== verifierHash) {
      this.database.exec("DELETE FROM sessions;");
      this.database
        .query("UPDATE auth_state SET verifier_hash = ? WHERE id = 1")
        .run(verifierHash);
    }
  }

  sessionResponse(request: Request): AuthSessionResponse {
    return {
      schema: 1,
      auth_required: this.required,
      authenticated: !this.required || this.isAuthenticated(request),
      auth_provider: this.authProvider,
      ...(this.authProvider === "oidc" && this.oidcConfig?.issuer
        ? { oidc_issuer: this.oidcConfig.issuer }
        : {}),
      ...(this.authProvider === "password" && this.username
        ? { username_required: false }
        : {}),
    };
  }

  isAuthenticated(request: Request): boolean {
    if (!this.required) return true;
    const database = this.database;
    if (!database) return false;
    const token = parseCookie(request, sessionCookie);
    if (!token) return false;

    const now = Date.now();
    this.pruneExpiredSessions(now);
    const tokenHash = sha256Hex(token);
    const row = database
      .query<SessionRow, [string]>(
        "SELECT created_at, last_seen_at FROM sessions WHERE token_hash = ?",
      )
      .get(tokenHash);
    if (!row) return false;

    if (
      now - row.last_seen_at > this.idleTimeoutMs ||
      now - row.created_at > this.absoluteTimeoutMs
    ) {
      database
        .query("DELETE FROM sessions WHERE token_hash = ?")
        .run(tokenHash);
      return false;
    }

    database
      .query("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
      .run(now, tokenHash);
    return true;
  }

  async login(
    passwordInput: string | undefined,
    clientAddress = "global",
    usernameInput?: string | undefined,
  ): Promise<LoginResult> {
    if (!this.required || this.authProvider !== "password") {
      return { kind: "disabled" };
    }
    const now = Date.now();
    if (this.isRateLimited(clientAddress, now)) {
      return { kind: "rate_limited" };
    }
    if (!passwordInput) {
      this.recordFailure(clientAddress, now);
      return { kind: "invalid" };
    }
    if (
      this.username &&
      usernameInput !== undefined &&
      usernameInput.trim() !== "" &&
      !constantTimeEquals(usernameInput.trim(), this.username)
    ) {
      this.recordFailure(clientAddress, now);
      return { kind: "invalid" };
    }

    let valid = false;
    if (this.password) {
      valid = constantTimeEquals(passwordInput, this.password);
    } else if (this.passwordHash) {
      try {
        valid = await Bun.password.verify(passwordInput, this.passwordHash);
      } catch {
        valid = false;
      }
    }

    if (!valid) {
      this.recordFailure(clientAddress, now);
      return { kind: "invalid" };
    }

    this.attempts.delete(clientAddress);
    const cookie = this.createSessionCookie(now);
    return { kind: "ok", cookie };
  }

  logout(request: Request): string {
    if (this.database) {
      const token = parseCookie(request, sessionCookie);
      if (token) {
        this.database
          .query("DELETE FROM sessions WHERE token_hash = ?")
          .run(sha256Hex(token));
      }
    }
    return this.serializeSessionCookie("", 0);
  }

  async beginOidcLogin(
    request: Request,
    publicOrigin?: string | undefined,
  ): Promise<{ redirectUrl: string; stateCookie: string }> {
    if (!this.required || this.authProvider !== "oidc" || !this.oidcConfig) {
      throw new Error("OIDC authentication is not enabled");
    }
    const discovery = await this.fetchOidcDiscovery();
    const now = Date.now();
    this.prunePendingOidcStates(now);

    const state = base64UrlEncode(randomBytes(24));
    const nonce = base64UrlEncode(randomBytes(24));
    const codeVerifier = base64UrlEncode(randomBytes(32));
    const codeChallenge = base64UrlEncode(
      createHash("sha256").update(codeVerifier).digest(),
    );

    const redirectUri = this.resolveOidcRedirectUri(request, publicOrigin);
    if (this.pendingOidcStates.size >= maxPendingOidcStates) {
      const oldestKey = this.pendingOidcStates.keys().next().value;
      if (oldestKey) this.pendingOidcStates.delete(oldestKey);
    }
    this.pendingOidcStates.set(state, {
      state,
      nonce,
      codeVerifier,
      redirectUri,
      createdAt: now,
    });

    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", this.oidcConfig.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set(
      "scope",
      this.oidcConfig.scopes?.trim() || "openid profile email",
    );
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("nonce", nonce);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    return {
      redirectUrl: authUrl.toString(),
      stateCookie: this.serializeOidcStateCookie(
        state,
        Math.floor(oidcStateTimeoutMs / 1000),
      ),
    };
  }

  async completeOidcCallback(request: Request): Promise<OidcCallbackResult> {
    const clearStateCookie = this.serializeOidcStateCookie("", 0);
    if (!this.required || this.authProvider !== "oidc" || !this.oidcConfig) {
      return {
        kind: "error",
        status: 400,
        code: "oidc_disabled",
        message: "OIDC authentication is not enabled",
        clearStateCookie,
      };
    }

    const url = new URL(request.url);
    const errorParam = url.searchParams.get("error");
    if (errorParam) {
      return {
        kind: "error",
        status: 401,
        code: "oidc_provider_error",
        message:
          url.searchParams.get("error_description") ||
          `OIDC provider returned error: ${errorParam}`,
        clearStateCookie,
      };
    }

    const stateParam = url.searchParams.get("state") ?? "";
    const codeParam = url.searchParams.get("code") ?? "";
    const cookieState = parseCookie(request, oidcStateCookie) ?? "";

    const now = Date.now();
    this.prunePendingOidcStates(now);

    if (
      !stateParam ||
      !codeParam ||
      !cookieState ||
      !constantTimeEquals(stateParam, cookieState)
    ) {
      return {
        kind: "error",
        status: 400,
        code: "invalid_oidc_state",
        message: "Invalid or expired OIDC login state",
        clearStateCookie,
      };
    }

    const pending = this.pendingOidcStates.get(stateParam);
    this.pendingOidcStates.delete(stateParam);
    if (!pending || now - pending.createdAt > oidcStateTimeoutMs) {
      return {
        kind: "error",
        status: 400,
        code: "invalid_oidc_state",
        message: "OIDC login session has expired",
        clearStateCookie,
      };
    }

    let discovery: OidcDiscoveryDocument;
    try {
      discovery = await this.fetchOidcDiscovery();
    } catch {
      return {
        kind: "error",
        status: 502,
        code: "oidc_discovery_failed",
        message: "Could not reach OIDC discovery endpoint",
        clearStateCookie,
      };
    }

    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code: codeParam,
      redirect_uri: pending.redirectUri,
      client_id: this.oidcConfig.clientId,
      code_verifier: pending.codeVerifier,
    });
    if (this.oidcConfig.clientSecret) {
      tokenParams.set("client_secret", this.oidcConfig.clientSecret);
    }

    let idToken = "";
    try {
      const tokenRes = await this.fetchImpl(discovery.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: tokenParams.toString(),
      });
      if (!tokenRes.ok) {
        return {
          kind: "error",
          status: 401,
          code: "oidc_token_exchange_failed",
          message: "Failed to exchange OIDC authorization code",
          clearStateCookie,
        };
      }
      const tokenData = (await tokenRes.json()) as { id_token?: string };
      idToken = tokenData.id_token ?? "";
    } catch {
      return {
        kind: "error",
        status: 502,
        code: "oidc_token_exchange_failed",
        message: "OIDC token request failed",
        clearStateCookie,
      };
    }

    if (!idToken) {
      return {
        kind: "error",
        status: 401,
        code: "missing_id_token",
        message: "OIDC provider did not return an ID token",
        clearStateCookie,
      };
    }

    let claims: {
      iss?: string;
      aud?: string | string[];
      exp?: number;
      iat?: number;
      sub?: string;
      nonce?: string;
      email?: string;
      email_verified?: boolean;
    };
    try {
      claims = await this.verifyOidcIdToken(
        idToken,
        discovery,
        this.oidcConfig.clientId,
        pending.nonce,
      );
    } catch (err) {
      return {
        kind: "error",
        status: 401,
        code: "invalid_id_token",
        message:
          err instanceof Error ? err.message : "ID token verification failed",
        clearStateCookie,
      };
    }

    if (this.allowedEmails.size > 0) {
      const email = (claims.email ?? "").toLowerCase().trim();
      if (!email || !this.allowedEmails.has(email)) {
        return {
          kind: "error",
          status: 403,
          code: "forbidden_user",
          message: "Your account is not authorized to access this workspace",
          clearStateCookie,
        };
      }
      if (claims.email_verified === false) {
        return {
          kind: "error",
          status: 403,
          code: "unverified_email",
          message: "Your email address must be verified by the OIDC provider",
          clearStateCookie,
        };
      }
    }

    const sessionCookieHeader = this.createSessionCookie(now, "Lax");
    return {
      kind: "ok",
      cookie: sessionCookieHeader,
      clearStateCookie,
    };
  }

  private resolveOidcRedirectUri(
    request: Request,
    publicOrigin?: string | undefined,
  ): string {
    const base =
      this.oidcConfig?.publicUrl?.trim() ||
      publicOrigin?.trim() ||
      new URL(request.url).origin;
    return `${base.replace(/\/+$/, "")}/api/auth/oidc/callback`;
  }

  private async fetchOidcDiscovery(): Promise<OidcDiscoveryDocument> {
    const now = Date.now();
    if (this.discoveryCache && now < this.discoveryCache.expiresAt) {
      return this.discoveryCache.doc;
    }
    const issuer = (this.oidcConfig?.issuer ?? "").replace(/\/+$/, "");
    const url = `${issuer}/.well-known/openid-configuration`;
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`OIDC discovery failed with status ${response.status}`);
    }
    const doc = (await response.json()) as OidcDiscoveryDocument;
    if (
      !doc.authorization_endpoint ||
      !doc.token_endpoint ||
      !doc.jwks_uri ||
      !doc.issuer
    ) {
      throw new Error("Incomplete OIDC discovery document");
    }
    this.discoveryCache = {
      doc,
      expiresAt: now + 3600 * 1000,
    };
    return doc;
  }

  private async fetchJwksKeys(
    jwksUri: string,
  ): Promise<Map<string, CryptoKey>> {
    const now = Date.now();
    if (this.jwksCache && now < this.jwksCache.expiresAt) {
      return this.jwksCache.keys;
    }
    const response = await this.fetchImpl(jwksUri);
    if (!response.ok) {
      throw new Error(`JWKS fetch failed with status ${response.status}`);
    }
    const body = (await response.json()) as { keys?: JwkKey[] };
    const map = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty === "RSA" && jwk.kid && jwk.n && jwk.e) {
        try {
          const key = await crypto.subtle.importKey(
            "jwk",
            jwk,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
          map.set(jwk.kid, key);
        } catch {
          // ignore unsupported key
        }
      }
    }
    if (map.size === 0) {
      throw new Error("No valid RSA signing keys found in JWKS");
    }
    this.jwksCache = {
      keys: map,
      expiresAt: now + 3600 * 1000,
    };
    return map;
  }

  private async verifyOidcIdToken(
    token: string,
    discovery: OidcDiscoveryDocument,
    expectedClientId: string,
    expectedNonce: string,
  ) {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new Error("Malformed JWT ID token");
    }
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(headerPart)),
    ) as { alg?: string; kid?: string };
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadPart)),
    ) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
      iat?: number;
      sub?: string;
      nonce?: string;
      email?: string;
      email_verified?: boolean;
    };

    if (header.alg !== "RS256" || !header.kid) {
      throw new Error("Unsupported ID token algorithm or missing kid");
    }
    const keys = await this.fetchJwksKeys(discovery.jwks_uri);
    const key = keys.get(header.kid);
    if (!key) {
      throw new Error("Signing key ID not found in OIDC JWKS");
    }

    const signedBytes = new TextEncoder().encode(
      `${headerPart}.${payloadPart}`,
    );
    const sigBytes = base64UrlDecode(signaturePart);
    const sigBuffer = new Uint8Array(sigBytes.byteLength);
    sigBuffer.set(sigBytes);
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      sigBuffer,
      signedBytes,
    );
    if (!verified) {
      throw new Error("ID token signature verification failed");
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
      throw new Error("ID token has expired");
    }

    const normalizeIssuer = (iss: string) => iss.replace(/\/+$/, "");
    const configuredIssuer = normalizeIssuer(this.oidcConfig?.issuer ?? "");
    const discoveredIssuer = normalizeIssuer(discovery.issuer);
    const tokenIssuer = normalizeIssuer(payload.iss ?? "");
    if (tokenIssuer !== configuredIssuer && tokenIssuer !== discoveredIssuer) {
      throw new Error("ID token issuer mismatch");
    }

    const audiences = Array.isArray(payload.aud)
      ? payload.aud
      : payload.aud
        ? [payload.aud]
        : [];
    if (!audiences.includes(expectedClientId)) {
      throw new Error("ID token audience mismatch");
    }

    if (!payload.nonce || !constantTimeEquals(payload.nonce, expectedNonce)) {
      throw new Error("ID token nonce mismatch");
    }

    if (typeof payload.sub !== "string" || !payload.sub.trim()) {
      throw new Error("ID token subject is missing");
    }

    return payload;
  }

  private createSessionCookie(
    now: number,
    sameSite: "Strict" | "Lax" = "Strict",
  ): string {
    const token = randomBytes(32).toString("base64url");
    if (this.database) {
      this.pruneExpiredSessions(now);
      const countRow = this.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions")
        .get();
      if ((countRow?.count ?? 0) >= maxSessionEntries) {
        this.database.exec(`
          DELETE FROM sessions
          WHERE token_hash IN (
            SELECT token_hash FROM sessions
            ORDER BY last_seen_at ASC
            LIMIT 1
          );
        `);
      }
      this.database
        .query(
          "INSERT INTO sessions (token_hash, created_at, last_seen_at) VALUES (?, ?, ?)",
        )
        .run(sha256Hex(token), now, now);
    }
    const maxAgeSeconds = Math.floor(this.absoluteTimeoutMs / 1000);
    return this.serializeSessionCookie(token, maxAgeSeconds, sameSite);
  }

  private serializeSessionCookie(
    token: string,
    maxAgeSeconds: number,
    sameSite: "Strict" | "Lax" = "Strict",
  ): string {
    const attributes = [
      `${sessionCookie}=${token}`,
      "Path=/",
      "HttpOnly",
      `SameSite=${sameSite}`,
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (this.secureCookies) {
      attributes.push("Secure");
    }
    return attributes.join("; ");
  }

  private serializeOidcStateCookie(
    state: string,
    maxAgeSeconds: number,
  ): string {
    const attributes = [
      `${oidcStateCookie}=${state}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (this.secureCookies) {
      attributes.push("Secure");
    }
    return attributes.join("; ");
  }

  private pruneExpiredSessions(now: number): void {
    if (!this.database) return;
    const minLastSeen = now - this.idleTimeoutMs;
    const minCreated = now - this.absoluteTimeoutMs;
    this.database
      .query("DELETE FROM sessions WHERE last_seen_at < ? OR created_at < ?")
      .run(minLastSeen, minCreated);
  }

  private prunePendingOidcStates(now: number): void {
    for (const [key, item] of this.pendingOidcStates.entries()) {
      if (now - item.createdAt > oidcStateTimeoutMs) {
        this.pendingOidcStates.delete(key);
      }
    }
  }

  private isRateLimited(clientAddress: string, now: number): boolean {
    const attempt = this.attempts.get(clientAddress);
    if (!attempt) return false;
    if (attempt.blockedUntil > now) return true;
    if (now - attempt.firstFailureAt > attemptWindowMs) {
      this.attempts.delete(clientAddress);
      return false;
    }
    return false;
  }

  private recordFailure(clientAddress: string, now: number): void {
    if (
      !this.attempts.has(clientAddress) &&
      this.attempts.size >= maxAttemptEntries
    ) {
      const oldest = this.attempts.keys().next().value;
      if (oldest) this.attempts.delete(oldest);
    }
    const existing = this.attempts.get(clientAddress);
    if (!existing || now - existing.firstFailureAt > attemptWindowMs) {
      this.attempts.set(clientAddress, {
        failures: 1,
        firstFailureAt: now,
        blockedUntil: 0,
      });
      return;
    }
    existing.failures += 1;
    if (existing.failures >= maxFailures) {
      existing.blockedUntil = now + blockDurationMs;
    }
  }
}

export function validMutationOrigin(
  request: Request,
  publicOrigin?: string | undefined,
): boolean {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return false;
  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return false;
  }
  if (publicOrigin) {
    try {
      const expected = new URL(publicOrigin);
      if (originUrl.origin === expected.origin) return true;
    } catch {
      // fall through
    }
  }
  const requestUrl = new URL(request.url);
  if (originUrl.origin === requestUrl.origin) return true;
  const hostHeader = request.headers.get("host");
  if (hostHeader && originUrl.host === hostHeader) return true;
  return false;
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceHandler } from "./app";
import { resolveClientAddress, validMutationOrigin } from "./auth";

function base64UrlEncode(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

describe("Workspace UI Auth (Password & OIDC)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openlia-auth-test-"));
    writeFileSync(join(root, "index.md"), "# Secret Note\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("password authentication gates API access, requires configured username, and rate-limits failures", async () => {
    const handler = createWorkspaceHandler({
      workspaceRoot: root,
      authRequired: true,
      authProvider: "password",
      username: "admin",
      password: "super-secret-password",
      sessionDatabasePath: join(root, ".sessions.sqlite"),
    });

    // Session endpoint reports username_required: true
    const sessionRes = await handler(
      new Request("http://127.0.0.1:8089/api/auth/session"),
    );
    const sessionBody = (await sessionRes.json()) as {
      username_required?: boolean;
      authenticated: boolean;
    };
    expect(sessionBody.authenticated).toBe(false);
    expect(sessionBody.username_required).toBe(true);

    // Unauthenticated tree request -> 401
    const unauthTree = await handler(
      new Request("http://127.0.0.1:8089/api/workspace/tree"),
    );
    expect(unauthTree.status).toBe(401);

    // Correct password but missing username -> 401
    const missingUserLogin = await handler(
      new Request("http://127.0.0.1:8089/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8089",
        },
        body: JSON.stringify({ password: "super-secret-password" }),
      }),
      "10.0.0.1",
    );
    expect(missingUserLogin.status).toBe(401);

    // Wrong password -> 401
    const badLogin = await handler(
      new Request("http://127.0.0.1:8089/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8089",
        },
        body: JSON.stringify({ username: "admin", password: "wrong" }),
      }),
      "10.0.0.1",
    );
    expect(badLogin.status).toBe(401);

    // Correct username and password -> 200 + Set-Cookie
    const okLogin = await handler(
      new Request("http://127.0.0.1:8089/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8089",
        },
        body: JSON.stringify({
          username: "admin",
          password: "super-secret-password",
        }),
      }),
      "10.0.0.1",
    );
    expect(okLogin.status).toBe(200);
    const cookieHeader = okLogin.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain("openlia_workspace_session=");
    const cookiePair = cookieHeader.split(";")[0] ?? "";

    // Authenticated tree request -> 200
    const authTree = await handler(
      new Request("http://127.0.0.1:8089/api/workspace/tree", {
        headers: { Cookie: cookiePair },
      }),
    );
    expect(authTree.status).toBe(200);

    // Rate limiting check on another IP after 5 failures
    for (let i = 0; i < 5; i++) {
      const res = await handler(
        new Request("http://127.0.0.1:8089/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1:8089",
          },
          body: JSON.stringify({ username: "admin", password: "bad" }),
        }),
        "10.0.0.2",
      );
      expect(res.status).toBe(401);
    }
    const rateLimited = await handler(
      new Request("http://127.0.0.1:8089/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8089",
        },
        body: JSON.stringify({
          username: "admin",
          password: "super-secret-password",
        }),
      }),
      "10.0.0.2",
    );
    expect(rateLimited.status).toBe(429);
  });

  test("OIDC authentication fails closed when allowedEmails is empty", () => {
    expect(() =>
      createWorkspaceHandler({
        workspaceRoot: root,
        authRequired: true,
        authProvider: "oidc",
        oidcConfig: {
          issuer: "https://idp.example.com",
          clientId: "openlia-client-id",
        },
        allowedEmails: [],
      }),
    ).toThrow(/OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS/);
  });

  test("OIDC authentication performs discovery, PKCE login redirect, JWKS key rotation refresh, and strict email_verified check", async () => {
    const keyPair1 = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const keyPair2 = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const publicJwk1 = (await crypto.subtle.exportKey(
      "jwk",
      keyPair1.publicKey,
    )) as Record<string, unknown>;
    const publicJwk2 = (await crypto.subtle.exportKey(
      "jwk",
      keyPair2.publicKey,
    )) as Record<string, unknown>;

    let capturedNonce = "";
    let activeKid = "test-key-1";
    let includeEmailVerified: boolean | undefined = true;
    let jwksFetches = 0;

    const mockFetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://idp.example.com/.well-known/openid-configuration") {
        return new Response(
          JSON.stringify({
            issuer: "https://idp.example.com",
            authorization_endpoint: "https://idp.example.com/authorize",
            token_endpoint: "https://idp.example.com/oauth/token",
            jwks_uri: "https://idp.example.com/.well-known/jwks.json",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://idp.example.com/.well-known/jwks.json") {
        jwksFetches += 1;
        return new Response(
          JSON.stringify({
            keys:
              jwksFetches === 1
                ? [
                    {
                      ...publicJwk1,
                      kid: "test-key-1",
                      alg: "RS256",
                      use: "sig",
                    },
                  ]
                : [
                    {
                      ...publicJwk1,
                      kid: "test-key-1",
                      alg: "RS256",
                      use: "sig",
                    },
                    {
                      ...publicJwk2,
                      kid: "test-key-2",
                      alg: "RS256",
                      use: "sig",
                    },
                  ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://idp.example.com/oauth/token") {
        const nowSec = Math.floor(Date.now() / 1000);
        const headerPart = base64UrlEncode(
          Buffer.from(
            JSON.stringify({ alg: "RS256", kid: activeKid, typ: "JWT" }),
          ),
        );
        const payloadPart = base64UrlEncode(
          Buffer.from(
            JSON.stringify({
              iss: "https://idp.example.com",
              aud: "openlia-client-id",
              sub: "user-123",
              email: "owner@example.com",
              ...(includeEmailVerified !== undefined
                ? { email_verified: includeEmailVerified }
                : {}),
              nonce: capturedNonce,
              iat: nowSec,
              exp: nowSec + 3600,
            }),
          ),
        );
        const signingInput = new TextEncoder().encode(
          `${headerPart}.${payloadPart}`,
        );
        const signingKey =
          activeKid === "test-key-2"
            ? keyPair2.privateKey
            : keyPair1.privateKey;
        const signature = await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          signingKey,
          signingInput,
        );
        const idToken = `${headerPart}.${payloadPart}.${base64UrlEncode(new Uint8Array(signature))}`;
        return new Response(JSON.stringify({ id_token: idToken }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const handler = createWorkspaceHandler({
      workspaceRoot: root,
      authRequired: true,
      authProvider: "oidc",
      oidcConfig: {
        issuer: "https://idp.example.com",
        clientId: "openlia-client-id",
        clientSecret: "openlia-client-secret",
        publicUrl: "https://workspace.example.com",
      },
      allowedEmails: ["owner@example.com"],
      fetchImpl: mockFetch,
    });

    // 1. Unauthenticated session response does not leak oidc_issuer, and sets HSTS header for https publicUrl
    const sessionRes = await handler(
      new Request("http://127.0.0.1:8089/api/auth/session"),
    );
    expect(sessionRes.headers.get("strict-transport-security")).toContain(
      "max-age=",
    );
    expect(sessionRes.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const sessionBody = (await sessionRes.json()) as {
      auth_provider: string;
      authenticated: boolean;
      oidc_issuer?: string;
    };
    expect(sessionBody.auth_provider).toBe("oidc");
    expect(sessionBody.authenticated).toBe(false);
    expect(sessionBody.oidc_issuer).toBeUndefined();

    // 2. Start OIDC login flow (ignores spoofed X-Forwarded-Host because publicUrl is set)
    const loginRes = await handler(
      new Request("http://127.0.0.1:8089/auth/oidc/login", {
        headers: {
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "evil.attacker.com",
        },
      }),
    );
    expect(loginRes.status).toBe(302);
    const redirectLocation = new URL(
      loginRes.headers.get("location") ?? "http://localhost",
    );
    expect(redirectLocation.origin).toBe("https://idp.example.com");
    expect(redirectLocation.searchParams.get("redirect_uri")).toBe(
      "https://workspace.example.com/auth/callback",
    );
    expect(redirectLocation.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const state = redirectLocation.searchParams.get("state") ?? "";
    capturedNonce = redirectLocation.searchParams.get("nonce") ?? "";
    const stateCookie =
      (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    // 3. Complete OIDC callback
    const callbackRes = await handler(
      new Request(
        `http://127.0.0.1:8089/auth/callback?code=auth-code-xyz&state=${encodeURIComponent(state)}`,
        {
          headers: { Cookie: stateCookie },
        },
      ),
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe("/");

    const setCookies = callbackRes.headers.getSetCookie();
    const sessionCookieHeader =
      setCookies.find((c) => c.startsWith("openlia_workspace_session=")) ?? "";
    expect(sessionCookieHeader).toContain("Secure");
    const sessionCookie = sessionCookieHeader.split(";")[0] ?? "";
    expect(sessionCookie).toBeTruthy();

    // 4. Verify session is now authenticated and includes oidc_issuer
    const authedSession = await handler(
      new Request("http://127.0.0.1:8089/api/auth/session", {
        headers: { Cookie: sessionCookie },
      }),
    );
    const authedBody = (await authedSession.json()) as {
      authenticated: boolean;
      oidc_issuer?: string;
    };
    expect(authedBody.authenticated).toBe(true);
    expect(authedBody.oidc_issuer).toBe("https://idp.example.com");

    // 5. Simulate IdP key rotation (test-key-2) -> JWKS refreshes on miss and succeeds
    activeKid = "test-key-2";
    const loginRes2 = await handler(
      new Request("http://127.0.0.1:8089/auth/oidc/login"),
    );
    const redirect2 = new URL(
      loginRes2.headers.get("location") ?? "http://localhost",
    );
    const state2 = redirect2.searchParams.get("state") ?? "";
    capturedNonce = redirect2.searchParams.get("nonce") ?? "";
    const stateCookie2 =
      (loginRes2.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const callbackRes2 = await handler(
      new Request(
        `http://127.0.0.1:8089/auth/callback?code=auth-code-2&state=${encodeURIComponent(state2)}`,
        { headers: { Cookie: stateCookie2 } },
      ),
    );
    expect(callbackRes2.status).toBe(302);
    expect(jwksFetches).toBe(2);

    // 6. Rejects token when email_verified is omitted (undefined)
    includeEmailVerified = undefined;
    const loginRes3 = await handler(
      new Request("http://127.0.0.1:8089/auth/oidc/login"),
    );
    const redirect3 = new URL(
      loginRes3.headers.get("location") ?? "http://localhost",
    );
    const state3 = redirect3.searchParams.get("state") ?? "";
    capturedNonce = redirect3.searchParams.get("nonce") ?? "";
    const stateCookie3 =
      (loginRes3.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const callbackRes3 = await handler(
      new Request(
        `http://127.0.0.1:8089/auth/callback?code=auth-code-3&state=${encodeURIComponent(state3)}`,
        { headers: { Cookie: stateCookie3 } },
      ),
    );
    expect(callbackRes3.status).toBe(403);
    const errBody3 = (await callbackRes3.json()) as { error: string };
    expect(errBody3.error).toBe("unverified_email");
  });

  test("validMutationOrigin strictly enforces publicOrigin and does not fall through to forged Host header", () => {
    const forgedReq = new Request(
      "http://127.0.0.1:8089/api/workspace/file/create",
      {
        method: "POST",
        headers: {
          Origin: "http://evil.example.com",
          Host: "evil.example.com",
        },
      },
    );
    expect(
      validMutationOrigin(forgedReq, "https://workspace.example.com"),
    ).toBe(false);

    const validPublicReq = new Request(
      "http://127.0.0.1:8089/api/workspace/file/create",
      {
        method: "POST",
        headers: {
          Origin: "https://workspace.example.com",
          Host: "127.0.0.1:8089",
        },
      },
    );
    expect(
      validMutationOrigin(validPublicReq, "https://workspace.example.com"),
    ).toBe(true);
  });

  test("resolveClientAddress extracts CF-Connecting-IP and X-Forwarded-For only when trustProxy is enabled and peer is local/private", () => {
    const reqWithCf = new Request("http://127.0.0.1:8089/api/auth/login", {
      headers: {
        "CF-Connecting-IP": "203.0.113.42",
        "X-Forwarded-For": "198.51.100.1, 172.18.0.2",
      },
    });

    // When trustProxy is false (e.g. direct VPN without publicOrigin), ignores headers
    expect(resolveClientAddress(reqWithCf, "10.8.0.5", false)).toBe("10.8.0.5");

    // When trustProxy is true and peer is Docker bridge / loopback, uses CF-Connecting-IP
    expect(resolveClientAddress(reqWithCf, "172.18.0.2", true)).toBe(
      "203.0.113.42",
    );
    expect(resolveClientAddress(reqWithCf, "127.0.0.1", true)).toBe(
      "203.0.113.42",
    );

    // When trustProxy is true but TCP peer is an untrusted public IP, ignores spoofed headers
    expect(resolveClientAddress(reqWithCf, "198.51.100.99", true)).toBe(
      "198.51.100.99",
    );
  });
});

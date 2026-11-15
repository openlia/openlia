import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceHandler } from "./app";

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

  test("password authentication gates API access and rate-limits failures", async () => {
    const handler = createWorkspaceHandler({
      workspaceRoot: root,
      authRequired: true,
      authProvider: "password",
      username: "admin",
      password: "super-secret-password",
      sessionDatabasePath: join(root, ".sessions.sqlite"),
    });

    // Unauthenticated tree request -> 401
    const unauthTree = await handler(
      new Request("http://127.0.0.1:8089/api/workspace/tree"),
    );
    expect(unauthTree.status).toBe(401);

    // Wrong password -> 401
    const badLogin = await handler(
      new Request("http://127.0.0.1:8089/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8089",
        },
        body: JSON.stringify({ password: "wrong" }),
      }),
      "10.0.0.1",
    );
    expect(badLogin.status).toBe(401);

    // Correct password -> 200 + Set-Cookie
    const okLogin = await handler(
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
          body: JSON.stringify({ password: "bad" }),
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
        body: JSON.stringify({ password: "super-secret-password" }),
      }),
      "10.0.0.2",
    );
    expect(rateLimited.status).toBe(429);
  });

  test("OIDC authentication performs discovery, PKCE login redirect, and ID token verification", async () => {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const publicJwk = (await crypto.subtle.exportKey(
      "jwk",
      keyPair.publicKey,
    )) as Record<string, unknown>;

    let capturedNonce = "";

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
        return new Response(
          JSON.stringify({
            keys: [
              { ...publicJwk, kid: "test-key-1", alg: "RS256", use: "sig" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://idp.example.com/oauth/token") {
        const nowSec = Math.floor(Date.now() / 1000);
        const headerPart = base64UrlEncode(
          Buffer.from(
            JSON.stringify({ alg: "RS256", kid: "test-key-1", typ: "JWT" }),
          ),
        );
        const payloadPart = base64UrlEncode(
          Buffer.from(
            JSON.stringify({
              iss: "https://idp.example.com",
              aud: "openlia-client-id",
              sub: "user-123",
              email: "owner@example.com",
              email_verified: true,
              nonce: capturedNonce,
              iat: nowSec,
              exp: nowSec + 3600,
            }),
          ),
        );
        const signingInput = new TextEncoder().encode(
          `${headerPart}.${payloadPart}`,
        );
        const signature = await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          keyPair.privateKey,
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
        publicUrl: "http://127.0.0.1:8089",
      },
      allowedEmails: ["owner@example.com"],
      fetchImpl: mockFetch,
    });

    // 1. Check session response reports OIDC provider
    const sessionRes = await handler(
      new Request("http://127.0.0.1:8089/api/auth/session"),
    );
    const sessionBody = (await sessionRes.json()) as {
      auth_provider: string;
      authenticated: boolean;
      oidc_issuer?: string;
    };
    expect(sessionBody.auth_provider).toBe("oidc");
    expect(sessionBody.authenticated).toBe(false);
    expect(sessionBody.oidc_issuer).toBe("https://idp.example.com");

    // 2. Start OIDC login flow
    const loginRes = await handler(
      new Request("http://127.0.0.1:8089/auth/oidc/login"),
    );
    expect(loginRes.status).toBe(302);
    const redirectLocation = new URL(
      loginRes.headers.get("location") ?? "http://localhost",
    );
    expect(redirectLocation.origin).toBe("https://idp.example.com");
    expect(redirectLocation.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8089/auth/callback",
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
    const sessionCookie =
      (
        setCookies.find((c) => c.startsWith("openlia_workspace_session=")) ?? ""
      ).split(";")[0] ?? "";
    expect(sessionCookie).toBeTruthy();

    // 4. Verify session is now authenticated
    const authedSession = await handler(
      new Request("http://127.0.0.1:8089/api/auth/session", {
        headers: { Cookie: sessionCookie },
      }),
    );
    const authedBody = (await authedSession.json()) as {
      authenticated: boolean;
    };
    expect(authedBody.authenticated).toBe(true);
  });
});

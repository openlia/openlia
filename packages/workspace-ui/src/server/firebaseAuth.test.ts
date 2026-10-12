import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearCachedPublicKeys, verifyFirebaseIdToken } from "./firebaseAuth";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function stringToBase64Url(str: string): string {
  return toBase64Url(new TextEncoder().encode(str));
}

describe("verifyFirebaseIdToken", () => {
  let keyPair: CryptoKeyPair;
  let kid: string;
  let mockServer: ReturnType<typeof Bun.serve>;
  let jwksUrl: string;

  beforeEach(async () => {
    clearCachedPublicKeys();

    keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );

    kid = "test-key-id-123";
    const exportedJwk = (await crypto.subtle.exportKey(
      "jwk",
      keyPair.publicKey,
    )) as Record<string, unknown>;
    exportedJwk.kid = kid;
    exportedJwk.alg = "RS256";
    exportedJwk.use = "sig";

    mockServer = Bun.serve({
      fetch() {
        return new Response(JSON.stringify({ keys: [exportedJwk] }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
      port: 0,
    });

    jwksUrl = `http://127.0.0.1:${mockServer.port}/jwks.json`;
  });

  afterEach(() => {
    mockServer.stop();
    clearCachedPublicKeys();
  });

  async function createSignedToken(
    payloadOverrides: Record<string, unknown> = {},
    kidOverride = kid,
  ) {
    const header = {
      alg: "RS256",
      kid: kidOverride,
      typ: "JWT",
    };

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      aud: "my-firebase-project",
      iss: "https://securetoken.google.com/my-firebase-project",
      sub: "user-12345",
      email: "allowed@example.com",
      email_verified: true,
      iat: now - 10,
      exp: now + 3600,
      ...payloadOverrides,
    };

    const headerPart = stringToBase64Url(JSON.stringify(header));
    const payloadPart = stringToBase64Url(JSON.stringify(payload));
    const signedData = new TextEncoder().encode(`${headerPart}.${payloadPart}`);

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      signedData,
    );

    const signaturePart = toBase64Url(new Uint8Array(signature));
    return `${headerPart}.${payloadPart}.${signaturePart}`;
  }

  test("verifies a valid token successfully", async () => {
    const token = await createSignedToken();
    const result = await verifyFirebaseIdToken(
      token,
      "my-firebase-project",
      jwksUrl,
    );

    expect(result.sub).toBe("user-12345");
    expect(result.email).toBe("allowed@example.com");
    expect(result.email_verified).toBe(true);
    expect(result.aud).toBe("my-firebase-project");
  });

  test("rejects token when audience does not match projectId", async () => {
    const token = await createSignedToken({ aud: "different-project" });
    await expect(
      verifyFirebaseIdToken(token, "my-firebase-project", jwksUrl),
    ).rejects.toThrow(
      "Token audience (different-project) does not match project ID (my-firebase-project)",
    );
  });

  test("rejects token when issuer does not match", async () => {
    const token = await createSignedToken({
      iss: "https://securetoken.google.com/other-project",
    });
    await expect(
      verifyFirebaseIdToken(token, "my-firebase-project", jwksUrl),
    ).rejects.toThrow("Token issuer");
  });

  test("rejects expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createSignedToken({ exp: now - 10 });
    await expect(
      verifyFirebaseIdToken(token, "my-firebase-project", jwksUrl),
    ).rejects.toThrow("Token has expired");
  });

  test("rejects token with unknown kid", async () => {
    const token = await createSignedToken({}, "unknown-kid");
    await expect(
      verifyFirebaseIdToken(token, "my-firebase-project", jwksUrl),
    ).rejects.toThrow("Key ID not found in Google public keys");
  });

  test("rejects token with tampered signature", async () => {
    const token = await createSignedToken();
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.tamperedsignature`;
    await expect(
      verifyFirebaseIdToken(tampered, "my-firebase-project", jwksUrl),
    ).rejects.toThrow();
  });
});

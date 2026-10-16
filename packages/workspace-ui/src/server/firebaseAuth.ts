// Verification of Google Firebase ID tokens using standard WebCrypto and Google's public JWKS.

export interface FirebaseTokenPayload {
  sub: string;
  email?: string;
  email_verified?: boolean;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  auth_time?: number;
}

interface JwkKey {
  kty: string;
  alg: string;
  use?: string;
  kid: string;
  n: string;
  e: string;
}

interface JwksResponse {
  keys: JwkKey[];
}

const GOOGLE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let cachedKeys: Map<string, CryptoKey> = new Map();
let cacheExpiresAt = 0;

function parseBase64Url(input: string): Uint8Array {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseJsonPart<T>(part: string): T {
  const bytes = parseBase64Url(part);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

function parseCacheControlMaxAge(header: string | null): number {
  if (!header) return 3600;
  const match = header.match(/max-age=(\d+)/i);
  if (match && match[1]) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 3600;
}

export async function fetchGooglePublicKeys(
  jwksUrl = GOOGLE_JWKS_URL,
): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (cachedKeys.size > 0 && now < cacheExpiresAt) {
    return cachedKeys;
  }

  const response = await fetch(jwksUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch Google JWKS: ${response.status}`);
  }

  const maxAge = parseCacheControlMaxAge(response.headers.get("cache-control"));
  const data = (await response.json()) as JwksResponse;
  if (!data || !Array.isArray(data.keys)) {
    throw new Error("Invalid JWKS response format");
  }

  const newKeyMap = new Map<string, CryptoKey>();
  for (const jwk of data.keys) {
    if (jwk.kty === "RSA" && jwk.kid && jwk.n && jwk.e) {
      try {
        const cryptoKey = await crypto.subtle.importKey(
          "jwk",
          jwk,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        newKeyMap.set(jwk.kid, cryptoKey);
      } catch {
        // Skip keys that fail import
      }
    }
  }

  if (newKeyMap.size === 0) {
    throw new Error("No valid RSA public keys found in Google JWKS");
  }

  cachedKeys = newKeyMap;
  cacheExpiresAt = now + maxAge * 1000;
  return cachedKeys;
}

export function clearCachedPublicKeys(): void {
  cachedKeys.clear();
  cacheExpiresAt = 0;
}

export async function verifyFirebaseIdToken(
  token: string,
  projectId: string,
  jwksUrl = GOOGLE_JWKS_URL,
): Promise<FirebaseTokenPayload> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("Invalid JWT token format");
  }

  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: string; kid?: string; typ?: string };
  let payload: FirebaseTokenPayload;
  try {
    header = parseJsonPart(headerPart);
    payload = parseJsonPart(payloadPart);
  } catch {
    throw new Error("Malformed JWT header or payload");
  }

  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Invalid token algorithm or missing kid");
  }

  const keys = await fetchGooglePublicKeys(jwksUrl);
  const cryptoKey = keys.get(header.kid);
  if (!cryptoKey) {
    throw new Error("Key ID not found in Google public keys");
  }

  const signedData = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const signature = parseBase64Url(signaturePart);
  const signatureBytes = new Uint8Array(signature.byteLength);
  signatureBytes.set(signature);

  const isValid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    signatureBytes,
    signedData,
  );

  if (!isValid) {
    throw new Error("Token signature verification failed");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    throw new Error("Token has expired");
  }

  // Allow up to 5 minutes clock skew
  if (typeof payload.iat !== "number" || payload.iat > nowSeconds + 300) {
    throw new Error("Token issued in the future");
  }

  if (payload.aud !== projectId) {
    throw new Error(
      `Token audience (${payload.aud}) does not match project ID (${projectId})`,
    );
  }

  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  if (payload.iss !== expectedIssuer) {
    throw new Error(
      `Token issuer (${payload.iss}) does not match expected (${expectedIssuer})`,
    );
  }

  if (typeof payload.sub !== "string" || payload.sub.trim() === "") {
    throw new Error("Token subject is missing or empty");
  }

  return payload;
}

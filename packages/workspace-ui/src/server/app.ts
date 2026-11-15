import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type {
  AuthLoginRequest,
  AuthLoginResponse,
  AuthProvider,
  WorkspaceCreateFileRequest,
  WorkspaceDeleteRequest,
  WorkspaceErrorResponse,
  WorkspaceMoveRequest,
  WorkspaceRenameRequest,
  WorkspaceWriteRequest,
} from "../shared/api";
import { Authenticator, type OidcConfig, validMutationOrigin } from "./auth";
import { WorkspaceError, WorkspaceService } from "./workspace";

export interface WorkspaceHandlerOptions {
  workspaceRoot: string;
  staticRoot?: string | undefined;
  maxEditableBytes?: number | undefined;
  maxDownloadBytes?: number | undefined;
  maxTreeEntries?: number | undefined;
  releaseSha256?: string | undefined;
  authRequired?: boolean | undefined;
  authProvider?: AuthProvider | undefined;
  username?: string | undefined;
  password?: string | undefined;
  passwordHash?: string | undefined;
  passwordHashFile?: string | undefined;
  oidcConfig?: OidcConfig | undefined;
  allowedEmails?: string[] | undefined;
  sessionDatabasePath?: string | undefined;
  publicOrigin?: string | undefined;
  secureCookies?: boolean | undefined;
  fetchImpl?: typeof fetch | undefined;
}

const contentTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".map": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".text": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const inlineContentTypes = new Set([
  "application/pdf",
  "audio/flac",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/x-icon",
  "image/webp",
  "text/csv; charset=utf-8",
  "text/plain; charset=utf-8",
  "video/mp4",
  "video/ogg",
  "video/quicktime",
  "video/webm",
]);

const maxLoginRequestBytes = 16 * 1024;
const maxSmallJsonBytes = 32 * 1024;

function securityHeaders(cspNonce?: string): Record<string, string> {
  const styleSource = cspNonce
    ? `'self' 'nonce-${cspNonce}'`
    : "'self' 'unsafe-inline'";
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src ${styleSource}; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(
  payload: object,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      ...securityHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    status,
  });
}

function errorResponse(
  error: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  if (error instanceof WorkspaceError) {
    const payload: WorkspaceErrorResponse = {
      schema: 1,
      ok: false,
      error: error.code,
      message: error.message,
      ...(error.currentRevision
        ? { current_revision: error.currentRevision }
        : {}),
    };
    return json(payload, error.status, extraHeaders);
  }
  const message =
    error instanceof Error ? error.message : "Internal server error";
  return json(
    {
      schema: 1,
      ok: false,
      error: "internal_error",
      message,
    } satisfies WorkspaceErrorResponse,
    500,
    extraHeaders,
  );
}

async function readJsonBody<T>(request: Request, maxBytes: number): Promise<T> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new WorkspaceError(
      "Request body is too large",
      413,
      "payload_too_large",
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new WorkspaceError("Invalid JSON request body", 400, "invalid_json");
  }
}

function encodeContentDispositionFilename(filename: string): string {
  const safeAscii = filename
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

export function createWorkspaceHandler(options: WorkspaceHandlerOptions) {
  const workspace = new WorkspaceService({
    workspaceRoot: options.workspaceRoot,
    maxEditableBytes: options.maxEditableBytes,
    maxDownloadBytes: options.maxDownloadBytes,
    maxTreeEntries: options.maxTreeEntries,
  });

  const authRequired = options.authRequired ?? false;
  const secureCookies =
    options.secureCookies ??
    Boolean(options.publicOrigin?.toLowerCase().startsWith("https://"));

  const auth = new Authenticator({
    required: authRequired,
    authProvider: options.authProvider,
    username: options.username,
    password: options.password,
    passwordHash: options.passwordHash,
    passwordHashFile: options.passwordHashFile,
    oidcConfig: options.oidcConfig,
    allowedEmails: options.allowedEmails,
    sessionDatabasePath: options.sessionDatabasePath,
    secureCookies,
    fetchImpl: options.fetchImpl,
  });

  const staticRoot = options.staticRoot
    ? resolve(options.staticRoot)
    : undefined;

  return async function handleRequest(
    request: Request,
    clientAddress = "global",
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    if (method === "GET" && pathname === "/health") {
      return json({
        schema: 1,
        ok: true,
        ...(options.releaseSha256
          ? { release_sha256: options.releaseSha256 }
          : {}),
      });
    }

    if (
      method === "GET" &&
      (pathname === "/auth/oidc/login" || pathname === "/api/auth/oidc/login")
    ) {
      try {
        const { redirectUrl, stateCookie } = await auth.beginOidcLogin(
          request,
          options.publicOrigin,
        );
        return new Response(null, {
          status: 302,
          headers: {
            ...securityHeaders(),
            Location: redirectUrl,
            "Set-Cookie": stateCookie,
          },
        });
      } catch (err) {
        return errorResponse(err);
      }
    }

    if (
      method === "GET" &&
      (pathname === "/auth/callback" || pathname === "/api/auth/oidc/callback")
    ) {
      const callbackRes = await auth.completeOidcCallback(request);
      if (callbackRes.kind === "error") {
        return json(
          {
            schema: 1,
            ok: false,
            error: callbackRes.code,
            message: callbackRes.message,
          },
          callbackRes.status,
          { "Set-Cookie": callbackRes.clearStateCookie },
        );
      }
      const headers = new Headers(securityHeaders());
      headers.set("Location", "/");
      headers.append("Set-Cookie", callbackRes.clearStateCookie);
      headers.append("Set-Cookie", callbackRes.cookie);
      return new Response(null, {
        status: 302,
        headers,
      });
    }

    if (pathname.startsWith("/api/")) {
      const isMutating =
        method === "POST" ||
        method === "PUT" ||
        method === "DELETE" ||
        method === "PATCH";
      if (isMutating && !validMutationOrigin(request, options.publicOrigin)) {
        return json(
          {
            schema: 1,
            ok: false,
            error: "invalid_origin",
            message: "Cross-origin state-changing requests are not allowed",
          },
          403,
        );
      }

      if (method === "GET" && pathname === "/api/auth/session") {
        return json(auth.sessionResponse(request));
      }

      if (method === "POST" && pathname === "/api/auth/login") {
        try {
          const body = await readJsonBody<AuthLoginRequest>(
            request,
            maxLoginRequestBytes,
          );
          const result = await auth.login(
            body.password,
            clientAddress,
            body.username,
          );
          switch (result.kind) {
            case "ok":
              return json(
                {
                  schema: 1,
                  ok: true,
                  authenticated: true,
                } satisfies AuthLoginResponse,
                200,
                { "Set-Cookie": result.cookie },
              );
            case "rate_limited":
              return json(
                {
                  schema: 1,
                  ok: false,
                  error: "rate_limited",
                  message: "Too many failed login attempts. Try again shortly.",
                },
                429,
              );
            case "disabled":
              return json(
                {
                  schema: 1,
                  ok: false,
                  error: "auth_disabled",
                  message: "Password login is not enabled",
                },
                400,
              );
            default:
              return json(
                {
                  schema: 1,
                  ok: false,
                  error: "invalid_credentials",
                  message: "Invalid password",
                },
                401,
              );
          }
        } catch (err) {
          return errorResponse(err);
        }
      }

      if (method === "POST" && pathname === "/api/auth/logout") {
        const clearCookie = auth.logout(request);
        return json(
          {
            schema: 1,
            ok: true,
            authenticated: false,
          },
          200,
          { "Set-Cookie": clearCookie },
        );
      }

      if (!auth.isAuthenticated(request)) {
        return json(
          {
            schema: 1,
            ok: false,
            error: "unauthenticated",
            message: "Authentication required",
          },
          401,
        );
      }

      try {
        if (method === "GET" && pathname === "/api/workspace/tree") {
          return json(workspace.listTree());
        }

        if (method === "GET" && pathname === "/api/workspace/file") {
          const path = url.searchParams.get("path") ?? "";
          return json(workspace.readFile(path));
        }

        if (method === "GET" && pathname === "/api/workspace/file-info") {
          const path = url.searchParams.get("path") ?? "";
          return json(workspace.readFileMetadata(path));
        }

        if (method === "PUT" && pathname === "/api/workspace/file") {
          const body = await readJsonBody<WorkspaceWriteRequest>(
            request,
            (options.maxEditableBytes ?? 2 * 1024 * 1024) + 64 * 1024,
          );
          if (
            typeof body.path !== "string" ||
            typeof body.content !== "string" ||
            typeof body.expected_revision !== "string"
          ) {
            throw new WorkspaceError(
              "path, content, and expected_revision are required",
              400,
              "invalid_request",
            );
          }
          return json(
            workspace.writeFile(
              body.path,
              body.content,
              body.expected_revision,
            ),
          );
        }

        if (method === "POST" && pathname === "/api/workspace/file/create") {
          const body = await readJsonBody<WorkspaceCreateFileRequest>(
            request,
            (options.maxEditableBytes ?? 2 * 1024 * 1024) + 64 * 1024,
          );
          if (typeof body.path !== "string") {
            throw new WorkspaceError(
              "path is required",
              400,
              "invalid_request",
            );
          }
          return json(workspace.createFile(body.path, body.content ?? ""));
        }

        if (method === "POST" && pathname === "/api/workspace/file/upload") {
          const form = await request.formData();
          const fileEntry = form.get("file");
          const pathEntry = form.get("path");
          if (!(fileEntry instanceof File)) {
            throw new WorkspaceError(
              "Uploaded file is required",
              400,
              "invalid_request",
            );
          }
          const targetPath =
            typeof pathEntry === "string" && pathEntry.trim()
              ? pathEntry.trim()
              : fileEntry.name;
          const bytes = new Uint8Array(await fileEntry.arrayBuffer());
          return json(workspace.uploadFile(targetPath, bytes));
        }

        if (method === "POST" && pathname === "/api/workspace/file/rename") {
          const body = await readJsonBody<WorkspaceRenameRequest>(
            request,
            maxSmallJsonBytes,
          );
          if (
            typeof body.path !== "string" ||
            typeof body.new_name !== "string"
          ) {
            throw new WorkspaceError(
              "path and new_name are required",
              400,
              "invalid_request",
            );
          }
          return json(workspace.renameFile(body.path, body.new_name));
        }

        if (method === "POST" && pathname === "/api/workspace/file/move") {
          const body = await readJsonBody<WorkspaceMoveRequest>(
            request,
            maxSmallJsonBytes,
          );
          if (
            typeof body.path !== "string" ||
            typeof body.destination_dir !== "string"
          ) {
            throw new WorkspaceError(
              "path and destination_dir are required",
              400,
              "invalid_request",
            );
          }
          return json(workspace.moveFile(body.path, body.destination_dir));
        }

        if (method === "DELETE" && pathname === "/api/workspace/file") {
          const body = await readJsonBody<WorkspaceDeleteRequest>(
            request,
            maxSmallJsonBytes,
          );
          if (typeof body.path !== "string") {
            throw new WorkspaceError(
              "path is required",
              400,
              "invalid_request",
            );
          }
          return json(workspace.deleteFile(body.path, body.expected_revision));
        }

        if (
          (method === "GET" || method === "HEAD") &&
          (pathname === "/api/workspace/raw" ||
            pathname === "/api/workspace/download")
        ) {
          const path = url.searchParams.get("path") ?? "";
          const resolved = workspace.resolveDownloadFile(path);
          const ext = extname(resolved.relativePath).toLowerCase();
          const mime = contentTypes[ext] ?? "application/octet-stream";
          const fileName =
            resolved.relativePath.split("/").at(-1) ?? "download";
          const isInline =
            pathname === "/api/workspace/raw" && inlineContentTypes.has(mime);
          const disposition = `${isInline ? "inline" : "attachment"}; ${encodeContentDispositionFilename(fileName)}`;

          return new Response(
            method === "HEAD" ? null : Bun.file(resolved.absolutePath),
            {
              status: 200,
              headers: {
                "Cache-Control": "private, no-store",
                "Content-Security-Policy":
                  "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
                "Content-Type": mime,
                "Content-Disposition": disposition,
                "X-Content-Type-Options": "nosniff",
              },
            },
          );
        }

        return json(
          {
            schema: 1,
            ok: false,
            error: "not_found",
            message: "API route not found",
          },
          404,
        );
      } catch (err) {
        return errorResponse(err);
      }
    }

    // Static assets & SPA fallback
    if (staticRoot && (method === "GET" || method === "HEAD")) {
      let relPath = pathname === "/" ? "index.html" : pathname.slice(1);
      try {
        relPath = decodeURIComponent(relPath);
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      const candidate = resolve(staticRoot, relPath);
      if (
        (candidate === staticRoot || candidate.startsWith(staticRoot + sep)) &&
        existsSync(candidate) &&
        lstatSync(candidate).isFile()
      ) {
        const ext = extname(candidate).toLowerCase();
        if (ext === ".html") {
          const nonce = randomBytes(16).toString("base64");
          const html = readFileSync(candidate, "utf8").replaceAll(
            "__OPENLIA_CSP_NONCE__",
            nonce,
          );
          return new Response(html, {
            headers: {
              ...securityHeaders(nonce),
              "Content-Type": "text/html; charset=utf-8",
            },
          });
        }
        return new Response(Bun.file(candidate), {
          headers: {
            ...securityHeaders(),
            "Cache-Control": pathname.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "no-cache",
            "Content-Type": contentTypes[ext] ?? "application/octet-stream",
          },
        });
      }

      const indexHtmlPath = resolve(staticRoot, "index.html");
      if (existsSync(indexHtmlPath) && lstatSync(indexHtmlPath).isFile()) {
        const nonce = randomBytes(16).toString("base64");
        const html = readFileSync(indexHtmlPath, "utf8").replaceAll(
          "__OPENLIA_CSP_NONCE__",
          nonce,
        );
        return new Response(html, {
          headers: {
            ...securityHeaders(nonce),
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }
    }

    return new Response("Not Found", {
      status: 404,
      headers: securityHeaders(),
    });
  };
}

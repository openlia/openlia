import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type {
  AuthLoginRequest,
  AuthLoginResponse,
  AuthProvider,
  DocumentScope,
  WorkspaceCreateFileRequest,
  WorkspaceDeleteDirectoryRequest,
  WorkspaceDeleteRequest,
  WorkspaceErrorResponse,
  WorkspaceMoveRequest,
  WorkspaceRenameRequest,
  WorkspaceWriteRequest,
} from "../shared/api";
import {
  Authenticator,
  type OidcConfig,
  resolveClientAddress,
  validMutationOrigin,
} from "./auth";
import { AgentService, WorkspaceError, WorkspaceService } from "./workspace";

export interface WorkspaceHandlerOptions {
  workspaceRoot: string;
  dataRoot?: string | undefined;
  skillsRoot?: string | undefined;
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
  allowAnyOidcEmail?: boolean | undefined;
  sessionDatabasePath?: string | undefined;
  publicOrigin?: string | undefined;
  secureCookies?: boolean | undefined;
  trustProxy?: boolean | undefined;
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

function securityHeaders(
  cspNonce?: string,
  secure = false,
): Record<string, string> {
  const styleSource = cspNonce
    ? `'self' 'nonce-${cspNonce}'`
    : "'self' 'unsafe-inline'";
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src ${styleSource}; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`,
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    ...(secure
      ? {
          "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
        }
      : {}),
  };
}

function json(
  payload: object,
  status = 200,
  extraHeaders: Record<string, string> = {},
  secure = false,
): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      ...securityHeaders(undefined, secure),
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    status,
  });
}

function errorResponse(
  error: unknown,
  extraHeaders: Record<string, string> = {},
  secure = false,
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
    return json(payload, error.status, extraHeaders, secure);
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
    secure,
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

  const skills = options.skillsRoot
    ? new WorkspaceService({
        workspaceRoot: options.skillsRoot,
        maxEditableBytes: options.maxEditableBytes,
        maxDownloadBytes: options.maxDownloadBytes,
        maxTreeEntries: options.maxTreeEntries,
      })
    : null;

  const agent = options.dataRoot
    ? new AgentService({
        dataRoot: options.dataRoot,
        maxEditableBytes: options.maxEditableBytes,
        maxDownloadBytes: options.maxDownloadBytes,
        maxTreeEntries: options.maxTreeEntries,
      })
    : null;

  function resolveService(
    scope?: string | null,
    routeScope?: DocumentScope,
  ): { service: WorkspaceService; scope: DocumentScope } {
    if (
      scope !== undefined &&
      scope !== null &&
      scope !== "workspace" &&
      scope !== "skills" &&
      scope !== "agent"
    ) {
      throw new WorkspaceError("Unknown document scope", 400, "invalid_scope");
    }
    if (
      routeScope &&
      routeScope !== "workspace" &&
      scope &&
      scope !== routeScope
    ) {
      throw new WorkspaceError(
        "Route and document scope do not match",
        400,
        "scope_mismatch",
      );
    }
    const effectiveScope: DocumentScope =
      (scope as DocumentScope) ?? routeScope ?? "workspace";
    if (effectiveScope === "skills") {
      if (!skills) {
        throw new WorkspaceError(
          "Skills service is not configured",
          404,
          "skills_unavailable",
        );
      }
      return { service: skills, scope: "skills" };
    }
    if (effectiveScope === "agent") {
      if (!agent) {
        throw new WorkspaceError(
          "Agent service is not configured",
          404,
          "agent_unavailable",
        );
      }
      return { service: agent, scope: "agent" };
    }
    return { service: workspace, scope: "workspace" };
  }

  const authRequired = options.authRequired ?? false;
  const effectivePublicOrigin =
    options.publicOrigin?.trim() || options.oidcConfig?.publicUrl?.trim();
  const secureCookies =
    options.secureCookies ??
    Boolean(effectivePublicOrigin?.toLowerCase().startsWith("https://"));
  const trustProxy = options.trustProxy ?? Boolean(effectivePublicOrigin);

  const auth = new Authenticator({
    required: authRequired,
    authProvider: options.authProvider,
    username: options.username,
    password: options.password,
    passwordHash: options.passwordHash,
    passwordHashFile: options.passwordHashFile,
    oidcConfig: options.oidcConfig,
    allowedEmails: options.allowedEmails,
    allowAnyOidcEmail: options.allowAnyOidcEmail,
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
    const effectiveClientAddress = resolveClientAddress(
      request,
      clientAddress,
      trustProxy,
    );
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    if (method === "GET" && pathname === "/health") {
      return json(
        {
          schema: 1,
          ok: true,
          ...(options.releaseSha256
            ? { release_sha256: options.releaseSha256 }
            : {}),
        },
        200,
        {},
        secureCookies,
      );
    }

    if (
      method === "GET" &&
      (pathname === "/auth/oidc/login" || pathname === "/api/auth/oidc/login")
    ) {
      try {
        const oidcStart = await auth.beginOidcLogin(
          request,
          effectivePublicOrigin,
          effectiveClientAddress,
        );
        if (oidcStart.kind === "rate_limited") {
          return json(
            {
              schema: 1,
              ok: false,
              error: "rate_limited",
              message: "Too many login attempts. Try again shortly.",
            },
            429,
            {},
            secureCookies,
          );
        }
        return new Response(null, {
          status: 302,
          headers: {
            ...securityHeaders(undefined, secureCookies),
            Location: oidcStart.redirectUrl,
            "Set-Cookie": oidcStart.stateCookie,
          },
        });
      } catch (err) {
        return errorResponse(err, {}, secureCookies);
      }
    }

    if (
      method === "GET" &&
      (pathname === "/auth/callback" || pathname === "/api/auth/oidc/callback")
    ) {
      const callbackRes = await auth.completeOidcCallback(
        request,
        effectiveClientAddress,
      );
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
          secureCookies,
        );
      }
      const headers = new Headers(securityHeaders(undefined, secureCookies));
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
      if (isMutating && !validMutationOrigin(request, effectivePublicOrigin)) {
        return json(
          {
            schema: 1,
            ok: false,
            error: "invalid_origin",
            message: "Cross-origin state-changing requests are not allowed",
          },
          403,
          {},
          secureCookies,
        );
      }

      if (method === "GET" && pathname === "/api/auth/session") {
        return json(auth.sessionResponse(request), 200, {}, secureCookies);
      }

      if (method === "POST" && pathname === "/api/auth/login") {
        try {
          const body = await readJsonBody<AuthLoginRequest>(
            request,
            maxLoginRequestBytes,
          );
          const result = await auth.login(
            body.password,
            effectiveClientAddress,
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
        let routeScope: DocumentScope | undefined;
        let apiSubpath = "";

        if (pathname === "/api/skills" || pathname.startsWith("/api/skills/")) {
          routeScope = "skills";
          apiSubpath = pathname.slice("/api/skills".length);
        } else if (
          pathname === "/api/agent" ||
          pathname.startsWith("/api/agent/")
        ) {
          routeScope = "agent";
          apiSubpath = pathname.slice("/api/agent".length);
        } else if (
          pathname === "/api/workspace" ||
          pathname.startsWith("/api/workspace/")
        ) {
          routeScope = "workspace";
          apiSubpath = pathname.slice("/api/workspace".length);
        }

        if (routeScope) {
          const queryScope = url.searchParams.get("scope");

          if (method === "GET" && apiSubpath === "/tree") {
            const { service, scope } = resolveService(queryScope, routeScope);
            const tree = service.listTree();
            return json({
              ...tree,
              scope,
              entries: tree.entries.map((entry) => ({ ...entry, scope })),
            });
          }

          if (method === "GET" && apiSubpath === "/file") {
            const { service, scope } = resolveService(queryScope, routeScope);
            const path = url.searchParams.get("path") ?? "";
            const file = service.readFile(path);
            return json({ ...file, scope });
          }

          if (method === "GET" && apiSubpath === "/file-info") {
            const { service, scope } = resolveService(queryScope, routeScope);
            const path = url.searchParams.get("path") ?? "";
            const meta = service.readFileMetadata(path);
            return json({ ...meta, scope });
          }

          if (method === "PUT" && apiSubpath === "/file") {
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
            const { service, scope } = resolveService(
              body.scope ?? queryScope,
              routeScope,
            );
            const written = service.writeFile(
              body.path,
              body.content,
              body.expected_revision,
            );
            return json({ ...written, scope });
          }

          if (method === "POST" && apiSubpath === "/file/create") {
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
            const { service, scope } = resolveService(
              body.scope ?? queryScope,
              routeScope,
            );
            const created = service.createFile(body.path, body.content ?? "");
            return json({ ...created, scope });
          }

          if (method === "POST" && apiSubpath === "/file/upload") {
            const form = await request.formData();
            const fileEntry = form.get("file");
            const pathEntry = form.get("path");
            const formScope = form.get("scope");
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
            const { service, scope } = resolveService(
              typeof formScope === "string" ? formScope : queryScope,
              routeScope,
            );
            const bytes = new Uint8Array(await fileEntry.arrayBuffer());
            const uploaded = service.uploadFile(targetPath, bytes);
            return json({ ...uploaded, scope });
          }

          if (method === "POST" && apiSubpath === "/file/rename") {
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
            const { service, scope } = resolveService(
              body.scope ?? queryScope,
              routeScope,
            );
            const renamed = service.renameFile(body.path, body.new_name);
            return json({ ...renamed, scope });
          }

          if (method === "POST" && apiSubpath === "/file/move") {
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
            const { service, scope } = resolveService(
              body.scope ?? queryScope,
              routeScope,
            );
            const moved = service.moveFile(body.path, body.destination_dir);
            return json({ ...moved, scope });
          }

          if (method === "DELETE" && apiSubpath === "/file") {
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
            const { service, scope } = resolveService(
              body.scope ?? queryScope,
              routeScope,
            );
            const deleted = service.deleteFile(
              body.path,
              body.expected_revision,
            );
            return json({ ...deleted, scope });
          }

          if (
            method === "DELETE" &&
            (apiSubpath === "/directory" || apiSubpath === "/folder")
          ) {
            const body = await readJsonBody<WorkspaceDeleteDirectoryRequest>(
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
            const { service, scope } = resolveService(
              body.scope ?? queryScope,
              routeScope,
            );
            const deleted = service.deleteDirectory(body.path);
            return json({ ...deleted, scope });
          }

          if (
            (method === "GET" || method === "HEAD") &&
            (apiSubpath === "/raw" || apiSubpath === "/download")
          ) {
            const { service } = resolveService(queryScope, routeScope);
            const path = url.searchParams.get("path") ?? "";
            const resolved = service.resolveDownloadFile(path);
            const ext = extname(resolved.relativePath).toLowerCase();
            const mime = contentTypes[ext] ?? "application/octet-stream";
            const fileName =
              resolved.relativePath.split("/").at(-1) ?? "download";
            const isInline =
              apiSubpath === "/raw" && inlineContentTypes.has(mime);
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
        if (ext === ".map") {
          return new Response("Not Found", {
            status: 404,
            headers: securityHeaders(undefined, secureCookies),
          });
        }
        if (ext === ".html") {
          const nonce = randomBytes(16).toString("base64");
          const html = readFileSync(candidate, "utf8").replaceAll(
            "__OPENLIA_CSP_NONCE__",
            nonce,
          );
          return new Response(html, {
            headers: {
              ...securityHeaders(nonce, secureCookies),
              "Content-Type": "text/html; charset=utf-8",
            },
          });
        }
        return new Response(Bun.file(candidate), {
          headers: {
            ...securityHeaders(undefined, secureCookies),
            "Cache-Control": pathname.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "no-cache",
            "Content-Type": contentTypes[ext] ?? "application/octet-stream",
          },
        });
      }

      if (extname(relPath).toLowerCase() === ".map") {
        return new Response("Not Found", {
          status: 404,
          headers: securityHeaders(undefined, secureCookies),
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
            ...securityHeaders(nonce, secureCookies),
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }
    }

    return new Response("Not Found", {
      status: 404,
      headers: securityHeaders(undefined, secureCookies),
    });
  };
}

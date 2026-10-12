import { randomBytes } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type {
  AuthLoginResponse,
  SkillCreateRequest,
  SkillToggleEnableRequest,
  SkillTogglePinRequest,
  SkillWriteRequest,
  WorkspaceDeleteRequest,
  WorkspaceErrorResponse,
  WorkspaceMoveRequest,
  WorkspaceRenameRequest,
  WorkspaceSystemInfo,
  WorkspaceWriteRequest,
} from "../shared/api";
import { Authenticator } from "./auth";
import { exportArchive } from "./export";
import { IngestionService } from "./ingestion";
import { MigrationService } from "./migration";
import { MemoryFileService } from "./memory";
import { SkillService } from "./skills";
import { WorkspaceError, WorkspaceService } from "./workspace";

export interface WorkspaceHandlerOptions {
  workspaceRoot: string;
  memoriesRoot?: string;
  ingestionRoot?: string;
  migrationsRoot?: string;
  skillsRoot?: string;
  staticRoot?: string;
  maxEditableBytes?: number;
  maxDownloadBytes?: number;
  maxTreeEntries?: number;
  authRequired?: boolean;
  passwordHash?: string | undefined;
  passwordHashFile?: string | undefined;
  sessionDatabasePath?: string | undefined;
  publicOrigin?: string | undefined;
  secureCookies?: boolean | undefined;
  systemInfo?:
    | Partial<
        Record<
          | "openlia_version"
          | "openlia_hash"
          | "hermes_version"
          | "locho_version",
          string | undefined
        >
      >
    | undefined;
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
const maxDeleteRequestBytes = 8 * 1024;

function securityHeaders(cspNonce?: string): Record<string, string> {
  const styleSource = cspNonce ? `'self' 'nonce-${cspNonce}'` : "'self'";
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src ${styleSource}; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
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

function errorResponse(error: unknown): Response {
  if (error instanceof WorkspaceError) {
    const payload: WorkspaceErrorResponse = {
      schema: 1,
      ok: false,
      error: error.code,
    };
    if (error.currentRevision !== undefined)
      payload.current_revision = error.currentRevision;
    return json(payload, error.status);
  }
  return json({ schema: 1, ok: false, error: "request_failed" }, 500);
}

async function staticFile(
  staticRoot: string,
  pathname: string,
): Promise<Response | undefined> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  if (relativePath !== "index.html" && !relativePath.startsWith("assets/"))
    return undefined;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(relativePath);
  } catch {
    return undefined;
  }
  const root = resolve(staticRoot);
  const absolute = resolve(root, decodedPath);
  if (absolute !== root && !absolute.startsWith(root + sep)) return undefined;
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return undefined;
  const extension = absolute.slice(absolute.lastIndexOf(".")).toLowerCase();
  const isIndex = relativePath === "index.html";
  const cspNonce = isIndex ? randomBytes(18).toString("base64") : undefined;
  const headers = {
    ...securityHeaders(cspNonce),
    "Cache-Control":
      relativePath === "index.html"
        ? "no-store"
        : "public, max-age=31536000, immutable",
    "Content-Type": contentTypes[extension] ?? "application/octet-stream",
  };
  if (!isIndex) return new Response(Bun.file(absolute), { headers });

  const html = await Bun.file(absolute).text();
  return new Response(
    html.replaceAll("__OPENLIA_CSP_NONCE__", cspNonce ?? ""),
    { headers },
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ value: unknown; tooLarge: boolean }> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes)
      return { value: null, tooLarge: true };
  }
  if (!request.body) return { value: null, tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { value: null, tooLarge: true };
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      value: JSON.parse(new TextDecoder().decode(bytes)),
      tooLarge: false,
    };
  } catch {
    return { value: null, tooLarge: false };
  }
}

export function createWorkspaceHandler(
  options: WorkspaceHandlerOptions,
): (request: Request, clientKey?: string) => Promise<Response> {
  const service = new WorkspaceService(options);
  const memoryService = new MemoryFileService(service, options.memoriesRoot);
  const ingestionService = new IngestionService(options);
  const migrationService = new MigrationService(options);
  const systemInfo: WorkspaceSystemInfo = {
    hermes_version: options.systemInfo?.hermes_version ?? "Unavailable",
    locho_version: options.systemInfo?.locho_version ?? "Unavailable",
    openlia_hash: options.systemInfo?.openlia_hash ?? "Unavailable",
    openlia_version: options.systemInfo?.openlia_version ?? "Unavailable",
    schema: 1,
  };
  const skillsRoot =
    options.skillsRoot ??
    process.env.OPENLIA_SKILLS_ROOT ??
    join(options.workspaceRoot, "..", "skills");
  const skillService = new SkillService({
    maxEditableBytes: options.maxEditableBytes,
    skillsRoot,
  });
  const staticRoot = options.staticRoot ?? join(import.meta.dir, "public");
  const publicOrigin = normalizeOrigin(options.publicOrigin);
  if (options.publicOrigin && !publicOrigin)
    throw new Error("workspace-ui public origin is invalid");
  const authenticator = new Authenticator({
    passwordHash: options.passwordHash,
    passwordHashFile: options.passwordHashFile,
    required: options.authRequired ?? false,
    sessionDatabasePath: options.sessionDatabasePath,
    secureCookies: options.secureCookies,
  });

  return async (request: Request, clientKey = "global"): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ schema: 1, ok: true, service: "workspace-ui" });
      }
      if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
        return (
          (await staticFile(staticRoot, url.pathname)) ??
          json({ schema: 1, ok: false, error: "not_found" }, 404)
        );
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/" ||
          url.pathname === "/index.html" ||
          url.pathname.startsWith("/files/") ||
          url.pathname.startsWith("/memory/") ||
          url.pathname === "/files" ||
          url.pathname.startsWith("/file/") ||
          url.pathname === "/file" ||
          url.pathname.startsWith("/skills/") ||
          url.pathname === "/skills" ||
          url.pathname.startsWith("/ingestion/") ||
          url.pathname === "/ingestion" ||
          url.pathname.startsWith("/migration/") ||
          url.pathname === "/migration" ||
          url.pathname.startsWith("/git-activity/") ||
          url.pathname === "/git-activity" ||
          url.pathname === "/configuration")
      ) {
        return (
          (await staticFile(staticRoot, "/")) ??
          json({ schema: 1, ok: false, error: "not_found" }, 404)
        );
      }
      if (request.method === "GET" && url.pathname === "/api/auth/session") {
        return json(authenticator.sessionResponse(request));
      }
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 1, ok: false, error: "origin_not_allowed" },
            403,
          );
        const bodyResult = await readJson(request, maxLoginRequestBytes);
        if (bodyResult.tooLarge)
          return json(
            { schema: 1, ok: false, error: "request_too_large" },
            413,
          );
        const body: unknown = bodyResult.value;
        if (!isObject(body) || typeof body.password !== "string")
          return json({ schema: 1, ok: false, error: "invalid_login" }, 400);
        const result = await authenticator.login(
          body.password,
          clientKey,
          secureRequest(request, url, publicOrigin),
        );
        if (result.kind === "rate_limited")
          return json({ schema: 1, ok: false, error: "rate_limited" }, 429);
        if (result.kind === "invalid")
          return json({ schema: 1, ok: false, error: "invalid_login" }, 401);
        const payload: AuthLoginResponse = { schema: 1, ok: true };
        return json(
          payload,
          200,
          result.cookie ? { "Set-Cookie": result.cookie } : {},
        );
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 1, ok: false, error: "origin_not_allowed" },
            403,
          );
        return json({ schema: 1, ok: true }, 200, {
          "Set-Cookie": authenticator.logout(
            request,
            secureRequest(request, url, publicOrigin),
          ),
        });
      }
      if (
        (url.pathname.startsWith("/api/workspace/") ||
          url.pathname.startsWith("/api/memory/") ||
          url.pathname.startsWith("/api/skills/") ||
          url.pathname.startsWith("/api/system/")) &&
        !authenticator.isAuthenticated(request)
      ) {
        return json(
          { schema: 1, ok: false, error: "authentication_required" },
          401,
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/workspace/settings"
      ) {
        return json(service.settings());
      }
      if (
        request.method === "PUT" &&
        url.pathname === "/api/workspace/settings"
      ) {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 1, ok: false, error: "origin_not_allowed" },
            403,
          );
        const body = await readJson(request, maxLoginRequestBytes);
        if (body.tooLarge || !isObject(body.value))
          return json({ schema: 1, ok: false, error: "invalid_settings" }, 400);
        if (
          body.value.enable_memory_editing === true &&
          !service.settings().enable_memory_editing &&
          !memoryService.available()
        ) {
          return json(
            { schema: 1, ok: false, error: "memory_unavailable" },
            503,
          );
        }
        return json(service.updateSettings(body.value));
      }
      if (request.method === "GET" && url.pathname === "/api/system/info") {
        return json(systemInfo);
      }
      if (request.method === "GET" && url.pathname === "/api/workspace/tree") {
        const tree = service.tree();
        return json({
          ...tree,
          entries: [...tree.entries, ...memoryService.entries()],
        });
      }
      if (request.method === "GET" && url.pathname === "/api/memory/file") {
        return json(memoryService.read(url.searchParams.get("name")));
      }
      if (request.method === "GET" && url.pathname === "/api/memory/metadata") {
        return json(memoryService.metadata(url.searchParams.get("name")));
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/api/memory/download" ||
          url.pathname === "/api/memory/raw")
      ) {
        const name = url.searchParams.get("name");
        const file = memoryService.read(name);
        return new Response(file.content, {
          headers: {
            ...securityHeaders(),
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `${url.pathname.endsWith("download") ? "attachment" : "inline"}; filename="${name}"`,
          },
        });
      }
      if (request.method === "PUT" && url.pathname === "/api/memory/file") {
        if (!sameOrigin(request, url, publicOrigin)) {
          return json(
            { schema: 1, ok: false, error: "origin_not_allowed" },
            403,
          );
        }
        const body = await readJson(
          request,
          service.maxEditableBytes * 6 + maxDeleteRequestBytes,
        );
        if (body.tooLarge)
          return json(
            { schema: 1, ok: false, error: "request_too_large" },
            413,
          );
        if (!isObject(body.value))
          return json({ schema: 1, ok: false, error: "invalid_request" }, 400);
        return json(
          memoryService.write(
            body.value.name,
            body.value.content,
            body.value.expected_revision,
          ),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/workspace/file") {
        return json(service.read(url.searchParams.get("path")));
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/workspace/metadata"
      ) {
        return json(service.metadata(url.searchParams.get("path")));
      }
      if (request.method === "GET" && url.pathname === "/api/workspace/raw") {
        const file = service.download(url.searchParams.get("path"));
        const extension = file.path
          .slice(file.path.lastIndexOf("."))
          .toLowerCase();
        const contentType =
          contentTypes[extension] ?? "application/octet-stream";
        const disposition = inlineContentTypes.has(contentType)
          ? "inline"
          : "attachment";
        const range = parseByteRange(request.headers.get("range"), file.size);
        const headers: Record<string, string> = {
          ...securityHeaders(),
          "Content-Security-Policy":
            "default-src 'none'; frame-ancestors 'self'",
          "Content-Disposition": `${disposition}; filename="${file.filename}"`,
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
        };
        if (range) {
          headers["Content-Length"] = String(range.end - range.start + 1);
          headers["Content-Range"] =
            `bytes ${range.start}-${range.end}/${file.size}`;
          return new Response(
            Bun.file(file.absolute).slice(range.start, range.end + 1),
            { headers, status: 206 },
          );
        }
        headers["Content-Length"] = String(file.size);
        return new Response(Bun.file(file.absolute), { headers });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/workspace/download"
      ) {
        const file = service.download(url.searchParams.get("path"));
        return new Response(Bun.file(file.absolute), {
          headers: {
            ...securityHeaders(),
            "Content-Disposition": `attachment; filename="${file.filename}"`,
            "Content-Type": "application/octet-stream",
          },
        });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/workspace/export"
      ) {
        const zipBytes = exportArchive({
          maxDownloadBytes: options.maxDownloadBytes,
          memoriesRoot: options.memoriesRoot,
          skillsRoot,
          workspaceRoot: options.workspaceRoot,
        });
        const dateStr = new Date().toISOString().slice(0, 10);
        return new Response(zipBytes, {
          headers: {
            ...securityHeaders(),
            "Content-Disposition": `attachment; filename="openlia-workspace-${dateStr}.zip"`,
            "Content-Type": "application/zip",
          },
        });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/workspace/git/status"
      ) {
        return json(await service.gitStatus());
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/workspace/activity"
      ) {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam
          ? Math.max(1, Math.min(100, Number(limitParam) || 20))
          : 20;
        return json(await service.activity(limit));
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/workspace/ingestion"
      ) {
        const limit = Math.max(
          1,
          Math.min(100, Number(url.searchParams.get("limit") ?? "50") || 50),
        );
        const offset = Math.max(
          0,
          Math.min(100_000, Number(url.searchParams.get("offset") ?? "0") || 0),
        );
        return json(
          ingestionService.overview(
            url.searchParams.get("q") ?? undefined,
            url.searchParams.get("status") ?? undefined,
            offset,
            limit,
          ),
        );
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/api/workspace/ingestion/")
      ) {
        try {
          const intakeId = decodeURIComponent(
            url.pathname.slice("/api/workspace/ingestion/".length),
          );
          return json(ingestionService.detail(intakeId));
        } catch (error) {
          if (error instanceof Error && error.message.includes("not found")) {
            return json({ schema: 1, ok: false, error: "not_found" }, 404);
          }
          return json(
            { schema: 1, ok: false, error: "invalid_ingestion" },
            400,
          );
        }
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/workspace/migration"
      ) {
        return json(migrationService.list());
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/api/workspace/migration/")
      ) {
        try {
          const migrationId = decodeURIComponent(
            url.pathname.slice("/api/workspace/migration/".length),
          );
          return json(migrationService.detail(migrationId));
        } catch (error) {
          if (error instanceof Error && error.message.includes("not found")) {
            return json({ schema: 2, ok: false, error: "not_found" }, 404);
          }
          return json(
            { schema: 2, ok: false, error: "invalid_migration" },
            400,
          );
        }
      }
      if (
        request.method === "POST" &&
        url.pathname.startsWith("/api/workspace/migration/") &&
        url.pathname.endsWith("/feedback")
      ) {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 2, ok: false, error: "origin_not_allowed" },
            403,
          );
        const prefix = "/api/workspace/migration/";
        const suffix = "/feedback";
        const migrationId = decodeURIComponent(
          url.pathname.slice(
            prefix.length,
            url.pathname.length - suffix.length,
          ),
        );
        const bodyResult = await readJson(request, 65536);
        if (bodyResult.tooLarge || !bodyResult.value) {
          return json(
            { schema: 2, ok: false, error: "invalid_request_body" },
            400,
          );
        }
        try {
          return json(
            migrationService.addFeedback(migrationId, bodyResult.value as any),
          );
        } catch (error) {
          return json(
            {
              schema: 2,
              ok: false,
              error: error instanceof Error ? error.message : "feedback_error",
            },
            400,
          );
        }
      }
      if (
        request.method === "POST" &&
        url.pathname.startsWith("/api/workspace/migration/") &&
        url.pathname.endsWith("/approve")
      ) {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 2, ok: false, error: "origin_not_allowed" },
            403,
          );
        const prefix = "/api/workspace/migration/";
        const suffix = "/approve";
        const migrationId = decodeURIComponent(
          url.pathname.slice(
            prefix.length,
            url.pathname.length - suffix.length,
          ),
        );
        const bodyResult = await readJson(request, 4096);
        const revisionId = (bodyResult.value as any)?.revision_id;
        if (!revisionId) {
          return json(
            { schema: 2, ok: false, error: "missing_revision_id" },
            400,
          );
        }
        try {
          return json(migrationService.approve(migrationId, revisionId));
        } catch (error) {
          return json(
            {
              schema: 2,
              ok: false,
              error: error instanceof Error ? error.message : "approve_error",
            },
            400,
          );
        }
      }
      if (
        request.method === "POST" &&
        url.pathname.startsWith("/api/workspace/migration/") &&
        url.pathname.endsWith("/discard")
      ) {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 2, ok: false, error: "origin_not_allowed" },
            403,
          );
        const prefix = "/api/workspace/migration/";
        const suffix = "/discard";
        const migrationId = decodeURIComponent(
          url.pathname.slice(
            prefix.length,
            url.pathname.length - suffix.length,
          ),
        );
        try {
          return json(migrationService.discard(migrationId));
        } catch (error) {
          return json(
            {
              schema: 2,
              ok: false,
              error: error instanceof Error ? error.message : "discard_error",
            },
            400,
          );
        }
      }
      if (
        request.method === "POST" &&
        url.pathname.startsWith("/api/workspace/migration/") &&
        url.pathname.endsWith("/stop")
      ) {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 2, ok: false, error: "origin_not_allowed" },
            403,
          );
        const prefix = "/api/workspace/migration/";
        const suffix = "/stop";
        const migrationId = decodeURIComponent(
          url.pathname.slice(
            prefix.length,
            url.pathname.length - suffix.length,
          ),
        );
        try {
          return json(migrationService.stop(migrationId));
        } catch (error) {
          return json(
            {
              schema: 2,
              ok: false,
              error: error instanceof Error ? error.message : "stop_error",
            },
            400,
          );
        }
      }
      if (
        request.method === "POST" &&
        url.pathname.startsWith("/api/workspace/migration/") &&
        url.pathname.endsWith("/resume")
      ) {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 2, ok: false, error: "origin_not_allowed" },
            403,
          );
        const prefix = "/api/workspace/migration/";
        const suffix = "/resume";
        const migrationId = decodeURIComponent(
          url.pathname.slice(
            prefix.length,
            url.pathname.length - suffix.length,
          ),
        );
        try {
          return json(migrationService.resume(migrationId));
        } catch (error) {
          return json(
            {
              schema: 2,
              ok: false,
              error: error instanceof Error ? error.message : "resume_error",
            },
            400,
          );
        }
      }
      if (
        request.method === "POST" &&
        url.pathname.startsWith("/api/workspace/migration/") &&
        url.pathname.endsWith("/wake")
      ) {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 2, ok: false, error: "origin_not_allowed" },
            403,
          );
        const prefix = "/api/workspace/migration/";
        const suffix = "/wake";
        const migrationId = decodeURIComponent(
          url.pathname.slice(
            prefix.length,
            url.pathname.length - suffix.length,
          ),
        );
        try {
          return json(migrationService.wake(migrationId));
        } catch (error) {
          return json(
            {
              schema: 2,
              ok: false,
              error: error instanceof Error ? error.message : "wake_error",
            },
            400,
          );
        }
      }
      if (request.method === "PUT" && url.pathname === "/api/workspace/file") {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 1, ok: false, error: "origin_not_allowed" },
            403,
          );
        const bodyResult = await readJson(
          request,
          (options.maxEditableBytes ?? 2 * 1024 * 1024) + 4096,
        );
        if (bodyResult.tooLarge)
          return json(
            { schema: 1, ok: false, error: "request_too_large" },
            413,
          );
        const body: unknown = bodyResult.value;
        if (!isObject(body))
          return json(
            { schema: 1, ok: false, error: "request_body_must_be_json" },
            400,
          );
        const writeRequest = body as Partial<WorkspaceWriteRequest>;
        return json(
          service.write(
            writeRequest.path,
            writeRequest.content,
            writeRequest.expected_revision,
          ),
        );
      }
      if (
        request.method === "DELETE" &&
        url.pathname === "/api/workspace/file"
      ) {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 1, ok: false, error: "origin_not_allowed" },
            403,
          );
        const bodyResult = await readJson(request, maxDeleteRequestBytes);
        if (bodyResult.tooLarge)
          return json(
            { schema: 1, ok: false, error: "request_too_large" },
            413,
          );
        const body: unknown = bodyResult.value;
        if (!isObject(body))
          return json(
            { schema: 1, ok: false, error: "request_body_must_be_json" },
            400,
          );
        const deleteRequest = body as Partial<WorkspaceDeleteRequest>;
        return json(
          service.delete(deleteRequest.path, deleteRequest.expected_revision),
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/workspace/rename"
      ) {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 1, ok: false, error: "origin_not_allowed" },
            403,
          );
        const bodyResult = await readJson(request, maxDeleteRequestBytes);
        if (bodyResult.tooLarge)
          return json(
            { schema: 1, ok: false, error: "request_too_large" },
            413,
          );
        const body: unknown = bodyResult.value;
        if (!isObject(body))
          return json(
            { schema: 1, ok: false, error: "request_body_must_be_json" },
            400,
          );
        const renameRequest = body as Partial<WorkspaceRenameRequest>;
        return json(
          service.rename(
            renameRequest.path,
            renameRequest.new_name,
            renameRequest.expected_revision,
          ),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/workspace/move") {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 1, ok: false, error: "origin_not_allowed" },
            403,
          );
        const bodyResult = await readJson(request, maxDeleteRequestBytes);
        if (bodyResult.tooLarge)
          return json(
            { schema: 1, ok: false, error: "request_too_large" },
            413,
          );
        const body: unknown = bodyResult.value;
        if (!isObject(body))
          return json(
            { schema: 1, ok: false, error: "request_body_must_be_json" },
            400,
          );
        const moveRequest = body as Partial<WorkspaceMoveRequest>;
        return json(
          service.move(
            moveRequest.source_path,
            moveRequest.destination_path,
            moveRequest.expected_revision,
          ),
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/workspace/diagnostics"
      ) {
        return json(service.diagnostics());
      }
      if (request.method === "GET" && url.pathname === "/api/skills/list") {
        return json(skillService.list());
      }
      if (request.method === "GET" && url.pathname === "/api/skills/detail") {
        return json(skillService.detail(url.searchParams.get("id")));
      }
      if (request.method === "GET" && url.pathname === "/api/skills/file") {
        return json(
          skillService.readFile(
            url.searchParams.get("id"),
            url.searchParams.get("path"),
          ),
        );
      }
      if (request.method === "PUT" && url.pathname === "/api/skills/file") {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 1, ok: false, error: "origin_not_allowed" },
            403,
          );
        const bodyResult = await readJson(
          request,
          (options.maxEditableBytes ?? 2 * 1024 * 1024) + 4096,
        );
        if (bodyResult.tooLarge)
          return json(
            { schema: 1, ok: false, error: "request_too_large" },
            413,
          );
        const body: unknown = bodyResult.value;
        if (!isObject(body))
          return json(
            { schema: 1, ok: false, error: "request_body_must_be_json" },
            400,
          );
        const writeRequest = body as Partial<SkillWriteRequest>;
        return json(
          skillService.writeFile(
            writeRequest.id,
            writeRequest.path,
            writeRequest.content,
            writeRequest.expected_revision,
          ),
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/skills/toggle-enable"
      ) {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 1, ok: false, error: "origin_not_allowed" },
            403,
          );
        const bodyResult = await readJson(request, 4096);
        const body: unknown = bodyResult.value;
        if (!isObject(body) || typeof body.enabled !== "boolean")
          return json({ schema: 1, ok: false, error: "invalid_request" }, 400);
        const req = body as Partial<SkillToggleEnableRequest>;
        skillService.toggleEnable(req.id, Boolean(body.enabled));
        return json({ schema: 1, ok: true });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/skills/toggle-pin"
      ) {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 1, ok: false, error: "origin_not_allowed" },
            403,
          );
        const bodyResult = await readJson(request, 4096);
        const body: unknown = bodyResult.value;
        if (!isObject(body) || typeof body.pinned !== "boolean")
          return json({ schema: 1, ok: false, error: "invalid_request" }, 400);
        const req = body as Partial<SkillTogglePinRequest>;
        skillService.togglePin(req.id, Boolean(body.pinned));
        return json({ schema: 1, ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/skills/create") {
        if (!sameOrigin(request, url, publicOrigin))
          return json(
            { schema: 1, ok: false, error: "origin_not_allowed" },
            403,
          );
        const bodyResult = await readJson(request, 4096);
        const body: unknown = bodyResult.value;
        if (!isObject(body))
          return json({ schema: 1, ok: false, error: "invalid_request" }, 400);
        const req = body as Partial<SkillCreateRequest>;
        const createdId = skillService.create(
          req.name,
          req.category,
          req.description,
        );
        return json({ id: createdId, ok: true, schema: 1 }, 201);
      }
      return json({ schema: 1, ok: false, error: "not_found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

function parseByteRange(
  value: string | null,
  size: number,
): { start: number; end: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size === 0) {
    throw new WorkspaceError("invalid byte range", 416, "invalid_range");
  }
  const startValue = match[1];
  const endValue = match[2];
  let start: number;
  let end: number;
  if (startValue) {
    start = Number(startValue);
    end = endValue ? Number(endValue) : size - 1;
  } else {
    const suffixLength = Number(endValue);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new WorkspaceError("invalid byte range", 416, "invalid_range");
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    throw new WorkspaceError("invalid byte range", 416, "invalid_range");
  }
  return { end: Math.min(end, size - 1), start };
}

function sameOrigin(
  request: Request,
  url: URL,
  publicOrigin: string | undefined,
): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === url.origin) return true;
  if (publicOrigin && origin === publicOrigin) return true;
  return origin === forwardedOrigin(request, url);
}

function secureRequest(
  request: Request,
  url: URL,
  publicOrigin: string | undefined,
): boolean {
  if (url.protocol === "https:") return true;
  if (publicOrigin && request.headers.get("origin") === publicOrigin)
    return true;
  return forwardedOrigin(request, url)?.startsWith("https://") ?? false;
}

function forwardedOrigin(request: Request, url: URL): string | undefined {
  const forwarded = parseForwarded(request.headers.get("forwarded"));
  const protocol =
    firstHeaderValue(request.headers.get("x-forwarded-proto")) ??
    forwarded.proto ??
    url.protocol.slice(0, -1);
  const host =
    firstHeaderValue(request.headers.get("x-forwarded-host")) ??
    forwarded.host ??
    url.host;
  if (protocol !== "http" && protocol !== "https") return undefined;
  try {
    const candidate = new URL(`${protocol}://${host}`);
    if (
      candidate.username ||
      candidate.password ||
      candidate.pathname !== "/" ||
      candidate.search ||
      candidate.hash
    )
      return undefined;
    return candidate.origin;
  } catch {
    return undefined;
  }
}

function firstHeaderValue(value: string | null): string | undefined {
  const first = value?.split(",", 1)[0]?.trim();
  return first || undefined;
}

function parseForwarded(value: string | null): {
  host?: string;
  proto?: string;
} {
  const first = firstHeaderValue(value);
  if (!first) return {};
  const result: { host?: string; proto?: string } = {};
  for (const item of first.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim().toLowerCase();
    const parameter = item
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (key === "host") result.host = parameter;
    if (key === "proto") result.proto = parameter;
  }
  return result;
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const origin = new URL(value);
    if (
      (origin.protocol !== "http:" && origin.protocol !== "https:") ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      return undefined;
    return origin.origin;
  } catch {
    return undefined;
  }
}

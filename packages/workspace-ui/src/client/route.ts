import type { WorkspaceView } from "./components";
import { parseSkillRemainder } from "./openliaLinks";
import {
  isMemoryDocument,
  memoryDocumentPath,
  memoryFilename,
} from "../shared/memory";

export type MainTab =
  | "chat"
  | "documents"
  | "projects"
  | "skills"
  | "shares"
  | "ingestion"
  | "git-activity"
  | "configuration"
  | "schedule"
  | "usage"
  | "migration"
  | "maintainer";

export type ProjectViewTab = "ui" | "files";

export interface WorkspaceRoute {
  tab?: MainTab | undefined;
  path?: string | undefined;
  projectPath?: string | undefined;
  projectView?: ProjectViewTab | undefined;
  view?: WorkspaceView | undefined;
  filter?: string | undefined;
  scenario?: string | undefined;
  skill?: string | undefined;
  skillFile?: string | undefined;
  shareId?: string | undefined;
  ingestionId?: string | undefined;
  migrationId?: string | undefined;
}

const validViews: ReadonlySet<string> = new Set(["edit", "preview", "info"]);
const validProjectViews: ReadonlySet<string> = new Set(["ui", "files"]);

function isValidView(value: string | null): value is WorkspaceView {
  return value !== null && validViews.has(value);
}

function isValidProjectView(value: string | null): value is ProjectViewTab {
  return value !== null && validProjectViews.has(value);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseRoute(
  locationOrUrl: Location | URL | string,
): WorkspaceRoute {
  let url: URL;
  if (typeof locationOrUrl === "string") {
    url = new URL(locationOrUrl, "http://localhost");
  } else if ("origin" in locationOrUrl && locationOrUrl.origin) {
    url = new URL(locationOrUrl.href);
  } else {
    url = new URL(String(locationOrUrl), "http://localhost");
  }

  const pathname = url.pathname;
  let path: string | undefined;
  let projectPath: string | undefined;
  let skill: string | undefined;
  let shareId: string | undefined;
  let tab: MainTab | undefined;
  let parsedSkillFile: string | undefined;
  let ingestionId: string | undefined;
  let migrationId: string | undefined;

  if (url.protocol === "openlia:") {
    const host = url.host.toLowerCase();
    const raw = pathname.replace(/^\/+/, "");
    if (host === "memory") {
      if (raw) path = memoryDocumentPath(safeDecodeURIComponent(raw));
      tab = "documents";
    } else if (host === "workspace") {
      if (raw) path = safeDecodeURIComponent(raw);
      tab = "documents";
    } else if (host === "project" || host === "projects" || host === "domain") {
      if (raw) projectPath = safeDecodeURIComponent(raw).replace(/\/+$/, "");
      tab = "projects";
    } else if (host === "skills") {
      if (raw) {
        const decoded = safeDecodeURIComponent(raw);
        const parsed = parseSkillRemainder(decoded);
        skill = parsed.skillId || undefined;
        parsedSkillFile = parsed.skillFile;
      }
      tab = "skills";
    } else if (host === "shares") {
      tab = "shares";
    } else if (host === "git-activity") {
      tab = "git-activity";
    } else if (
      host === "ingestion" ||
      host === "source" ||
      host === "sources"
    ) {
      if (raw) ingestionId = safeDecodeURIComponent(raw);
      tab = "ingestion";
    } else if (host === "migration") {
      if (raw) migrationId = safeDecodeURIComponent(raw);
      tab = "migration";
    } else if (host === "maintainer") {
      tab = "maintainer";
    } else if (host === "chat") {
      tab = "chat";
    } else if (host === "usage") {
      tab = "usage";
    } else if (host === "schedule" || host === "cron") {
      tab = "schedule";
    } else if (host === "configuration") {
      tab = "configuration";
    }
  } else if (pathname.startsWith("/share/")) {
    const raw = pathname.slice("/share/".length).replace(/\/+$/, "");
    if (raw) shareId = safeDecodeURIComponent(raw);
  } else if (pathname === "/shares" || pathname.startsWith("/shares/")) {
    tab = "shares";
  } else if (pathname.startsWith("/memory/")) {
    path = memoryDocumentPath(
      safeDecodeURIComponent(pathname.slice("/memory/".length)),
    );
    tab = "documents";
  } else if (pathname.startsWith("/projects/")) {
    const raw = pathname.slice("/projects/".length).replace(/\/+$/, "");
    if (raw) projectPath = safeDecodeURIComponent(raw);
    tab = "projects";
  } else if (pathname === "/projects") {
    projectPath = undefined;
    tab = "projects";
  } else if (pathname.startsWith("/files/")) {
    const raw = pathname.slice("/files/".length);
    if (raw) path = safeDecodeURIComponent(raw);
    tab = "documents";
  } else if (pathname === "/files") {
    path = undefined;
    tab = "documents";
  } else if (pathname.startsWith("/file/")) {
    const raw = pathname.slice("/file/".length);
    if (raw) path = safeDecodeURIComponent(raw);
    tab = "documents";
  } else if (pathname === "/file") {
    path = undefined;
    tab = "documents";
  } else if (pathname.startsWith("/skills/")) {
    const raw = pathname.slice("/skills/".length);
    if (raw) skill = safeDecodeURIComponent(raw);
    tab = "skills";
  } else if (pathname === "/skills") {
    skill = undefined;
    tab = "skills";
  } else if (pathname.startsWith("/ingestion/")) {
    const raw = pathname.slice("/ingestion/".length);
    if (raw) ingestionId = safeDecodeURIComponent(raw);
    tab = "ingestion";
  } else if (pathname === "/ingestion") {
    tab = "ingestion";
  } else if (pathname.startsWith("/migration/")) {
    const raw = pathname.slice("/migration/".length);
    if (raw) migrationId = safeDecodeURIComponent(raw);
    tab = "migration";
  } else if (pathname === "/migration") {
    tab = "migration";
  } else if (
    pathname === "/maintainer" ||
    pathname.startsWith("/maintainer/")
  ) {
    tab = "maintainer";
  } else if (
    pathname === "/git-activity" ||
    pathname.startsWith("/git-activity/")
  ) {
    tab = "git-activity";
  } else if (pathname === "/chat") {
    tab = "chat";
  } else if (pathname === "/usage") {
    tab = "usage";
  } else if (pathname === "/schedule" || pathname.startsWith("/schedule/")) {
    tab = "schedule";
  } else if (pathname === "/configuration") {
    tab = "configuration";
  }

  const tabParam = url.searchParams.get("tab");
  if (
    tabParam === "chat" ||
    tabParam === "skills" ||
    tabParam === "shares" ||
    tabParam === "documents" ||
    tabParam === "projects" ||
    tabParam === "ingestion" ||
    tabParam === "git-activity" ||
    tabParam === "configuration" ||
    tabParam === "schedule" ||
    tabParam === "usage" ||
    tabParam === "migration" ||
    tabParam === "maintainer"
  ) {
    tab = tabParam;
  }

  const projectParam = url.searchParams.get("project");
  if (projectParam) {
    projectPath = projectParam.trim().replace(/^\/+|\/+$/g, "");
    tab = "projects";
  }

  const skillParam = url.searchParams.get("skill");
  if (skillParam) {
    skill = skillParam.trim();
    tab = "skills";
  }

  const skillFileParam = url.searchParams.get("skillFile");
  const skillFile = skillFileParam ? skillFileParam.trim() : parsedSkillFile;

  const ingestionParam = url.searchParams.get("ingestion");
  if (ingestionParam) ingestionId = ingestionParam.trim();

  const migrationParam = url.searchParams.get("migration");
  if (migrationParam) migrationId = migrationParam.trim();

  if (!path) {
    const fallbackPath =
      url.searchParams.get("path") ?? url.searchParams.get("file");
    if (fallbackPath) {
      path = fallbackPath.trim();
    }
  }

  if (path) {
    path = path.replace(/^\/+/, "");
  }

  if (projectPath) {
    projectPath = projectPath.replace(/^\/+|\/+$/g, "");
  }

  const viewParam = url.searchParams.get("view");
  const isProjectsContext = tab === "projects" || Boolean(projectPath);
  const view =
    !isProjectsContext && isValidView(viewParam) ? viewParam : undefined;
  const projectView =
    isProjectsContext && isValidProjectView(viewParam) ? viewParam : undefined;

  const filterParam =
    url.searchParams.get("filter") ?? url.searchParams.get("q");
  const filter = filterParam ? filterParam : undefined;

  const scenarioParam = url.searchParams.get("scenario");
  const scenario = scenarioParam ? scenarioParam : undefined;

  return {
    filter,
    ingestionId: ingestionId || undefined,
    migrationId: migrationId || undefined,
    path: path || undefined,
    projectPath: projectPath || undefined,
    projectView,
    scenario,
    shareId: shareId || undefined,
    skill: skill || undefined,
    skillFile,
    tab,
    view,
  };
}

export function buildRouteUrl(route: WorkspaceRoute): string {
  let pathname = "/";
  if (route.shareId) {
    pathname = `/share/${encodeURIComponent(route.shareId)}`;
  } else if (route.tab === "shares") {
    pathname = "/shares";
  } else if (route.tab === "chat") {
    pathname = "/chat";
  } else if (route.tab === "projects" || route.projectPath) {
    if (route.projectPath) {
      const segments = route.projectPath
        .replace(/^\/+|\/+$/g, "")
        .split("/")
        .map(encodeURIComponent);
      pathname = `/projects/${segments.join("/")}`;
    } else {
      pathname = "/projects";
    }
  } else if (route.tab === "usage") {
    pathname = "/usage";
  } else if (route.tab === "schedule") {
    pathname = "/schedule";
  } else if (route.tab === "git-activity") {
    pathname = "/git-activity";
  } else if (route.tab === "configuration") {
    pathname = "/configuration";
  } else if (route.tab === "skills" || route.skill) {
    if (route.skill) {
      const segments = route.skill
        .replace(/^\/+/, "")
        .split("/")
        .map(encodeURIComponent);
      pathname = `/skills/${segments.join("/")}`;
    } else {
      pathname = "/skills";
    }
  } else if (route.tab === "ingestion") {
    pathname = route.ingestionId
      ? `/ingestion/${encodeURIComponent(route.ingestionId)}`
      : "/ingestion";
  } else if (route.tab === "migration") {
    pathname = route.migrationId
      ? `/migration/${encodeURIComponent(route.migrationId)}`
      : "/migration";
  } else if (route.tab === "maintainer") {
    pathname = "/maintainer";
  } else if (route.path && isMemoryDocument(route.path)) {
    pathname = `/memory/${encodeURIComponent(memoryFilename(route.path))}`;
  } else if (route.path) {
    const segments = route.path
      .replace(/^\/+/, "")
      .split("/")
      .map(encodeURIComponent);
    pathname = `/files/${segments.join("/")}`;
  }

  const params = new URLSearchParams();
  if (route.scenario) {
    params.set("scenario", route.scenario);
  }
  if ((route.tab === "projects" || route.projectPath) && route.projectView) {
    params.set("view", route.projectView);
  } else if (route.view) {
    params.set("view", route.view);
  }
  if (route.filter) {
    params.set("filter", route.filter);
  }
  if (route.skillFile) {
    params.set("skillFile", route.skillFile);
  }
  if (route.ingestionId && pathname === "/ingestion") {
    params.set("ingestion", route.ingestionId);
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function navigateRoute(
  route: WorkspaceRoute,
  options?: { replace?: boolean | undefined },
): void {
  if (typeof window === "undefined" || !window.history) return;
  const targetUrl = buildRouteUrl(route);
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (targetUrl === currentUrl) return;

  if (workspaceRouter) {
    if (options?.replace) workspaceRouter.history.replace(targetUrl);
    else workspaceRouter.history.push(targetUrl);
    return;
  }

  if (options?.replace) {
    window.history.replaceState(null, "", targetUrl);
  } else {
    window.history.pushState(null, "", targetUrl);
  }
}

interface WorkspaceRouterHistory {
  history: {
    push(path: string): void;
    replace(path: string): void;
  };
}

let workspaceRouter: WorkspaceRouterHistory | undefined;

export function installWorkspaceRouter(
  router: WorkspaceRouterHistory | undefined,
): void {
  workspaceRouter = router;
}

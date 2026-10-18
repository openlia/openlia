import type {
  AuthLoginResponse,
  AuthSessionResponse,
  DocumentPasswordProfile,
  DocumentPasswordSuggestResponse,
  IngestionDetailResponse,
  IngestionOverviewResponse,
  SkillDetail,
  SourceDocument,
  SourceSearchResponse,
  SourceUploadResponse,
  WorkspaceActivityResponse,
  WorkspaceDeleteResponse,
  WorkspaceDiagnosticsResponse,
  WorkspaceDomainInfo,
  WorkspaceDomainsResponse,
  WorkspaceErrorResponse,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceGitStatus,
  WorkspaceMoveResponse,
  WorkspaceRenameResponse,
  WorkspaceSettings,
  WorkspaceSystemInfo,
  WorkspaceTreeEntry,
  WorkspaceTreeResponse,
  WorkspaceWriteResponse,
} from "../shared/api";
import {
  isMemoryDocument,
  MEMORY_FILENAMES,
  memoryDocumentPath,
} from "../shared/memory";
import { suggestPasswordProfiles } from "../shared/passwordSuggester";
import { ApiError, type WorkspaceApi } from "./api";

export type MockWorkspaceScenario =
  | "default"
  | "auth"
  | "conflict"
  | "empty"
  | "error"
  | "loading";

export interface MockWorkspaceOptions {
  scenario?: MockWorkspaceScenario;
}

const modifiedAt = "2026-09-22T00:00:00.000Z";

export const mockCreatableDomains: WorkspaceDomainInfo[] = [
  {
    path: "tasks",
    label: "Tasks",
    template_path: "tasks/task-template.md",
    purpose: "Concrete actions that can be completed.",
  },
  {
    path: "goals",
    label: "Goals",
    template_path: "goals/goal-template.md",
    purpose: "Outcomes and the reasons they matter.",
  },
  {
    path: "projects",
    label: "Projects",
    template_path: "projects/project-template.md",
    purpose: "Bounded outcomes with milestones, tasks, risks, and decisions.",
  },
  {
    path: "ideas",
    label: "Ideas",
    template_path: "ideas/idea-template.md",
    purpose: "Possible future work and observations.",
  },
  {
    path: "decisions",
    label: "Decisions",
    template_path: "decisions/decision-template.md",
    purpose: "Questions, options, evidence, trade-offs, and outcomes.",
  },
  {
    path: "monitors",
    label: "Monitors",
    template_path: "monitors/monitor-template.md",
    purpose: "Conditions to watch for change over time.",
  },
  {
    path: "areas",
    label: "Areas",
    template_path: "areas/area-template.md",
    purpose: "Ongoing responsibilities without a fixed end date.",
  },
  {
    path: "calendar",
    label: "Calendar",
    template_path: "calendar/event-note-template.md",
    purpose: "Planning notes, meeting agendas, and event context.",
  },
  {
    path: "people",
    label: "People",
    template_path: "people/person-template.md",
    purpose: "Relationship context and person records.",
  },
  {
    path: "shopping",
    label: "Shopping",
    template_path: "shopping/item-template.md",
    purpose: "Product research and purchase candidates.",
  },
  {
    path: "travel",
    label: "Travel",
    template_path: "travel/trip-template.md",
    purpose: "Trips, itineraries, and travel research.",
  },
  {
    path: "finance",
    label: "Finance",
    template_path: "finance/finance-template.md",
    purpose: "Budgets, spending notes, and financial reviews.",
  },
  {
    path: "knowledge/claims",
    label: "Claims",
    template_path: "knowledge/claims/claim-template.md",
    purpose: "Reusable personal claims with provenance and lifecycle metadata.",
  },
];

function error(
  status: number,
  code: string,
  currentRevision?: string,
): ApiError {
  const payload: WorkspaceErrorResponse = {
    schema: 1,
    ok: false,
    error: code,
  };
  if (currentRevision !== undefined) payload.current_revision = currentRevision;
  return new ApiError(status, payload);
}

function metadata(path: string, content: string): WorkspaceFileMetadata {
  return {
    ...(isMemoryDocument(path) ? { source: "memory" as const } : {}),
    editable: true,
    modified_at: modifiedAt,
    path,
    size: new TextEncoder().encode(content).byteLength,
  };
}

export function createMockWorkspaceApi({
  scenario = "default",
}: MockWorkspaceOptions = {}): WorkspaceApi {
  const path = "notes.md";
  let content = "Hello";
  let revision = "sha256:mock-before";
  let saveCount = 0;
  let authenticated = scenario !== "auth";
  let conflictPending = scenario === "conflict";
  let settings: WorkspaceSettings = {
    enable_memory_editing: false,
    hide_configuration_files: true,
    hide_template_schema_files: true,
    schema: 1,
  };
  let entries: WorkspaceTreeEntry[] = [
    { kind: "directory", path: "calendar" },
    {
      ...metadata(
        "calendar/event.md",
        "# Calendar event\n\nA sample event for UI development.\n",
      ),
      kind: "file",
    },
    {
      ...metadata(
        "calendar/reminders.rem",
        `# OpenLia Workspace Calendar
INCLUDE holidays.rem

REM 2026-10-15 AT 10:00 DURATION 1:30 TAG sprint PRIORITY 100 \\
    INFO "Location: 123 Market St, Room 4" \\
    INFO "Map-Url: https://maps.google.com/?q=123+Market+St" \\
    INFO "Video-Link: https://meet.google.com/abc-defg-hij" \\
    INFO "Attendees: Alice <alice@example.com>, Bob, [[Charlie]]" \\
    INFO "Description: Quarterly strategy sync and roadmap review" \\
    INFO "Event-Note: calendar/2026-10-15-q4-sync.md" \\
    MSG Q4 Strategy Sync

REM 2026-10-16 AT 14:00 DURATION 45 TAG 1on1 \\
    INFO "Video-Link: https://meet.google.com/xyz-uvwx-rst" \\
    INFO "Attendees: Sarah" \\
    INFO "Description: Bi-weekly 1:1 check-in" \\
    MSG Sarah 1:1 Sync

REM 2026-10-20 AT 11:00 DURATION 1:00 TAG architecture \\
    INFO "Location: Engineering Lounge" \\
    INFO "Video-Link: https://zoom.us/j/9876543210" \\
    INFO "Attendees: Dave, Elena, Frank" \\
    INFO "Description: API V2 design discussion" \\
    MSG API Architecture Review

REM Mon AT 09:30 DURATION 30 TAG team recurring MSG Weekly Team Standup

REM Fri AT 16:30 DURATION 45 TAG team recurring MSG Friday Demo & Retro
`,
      ),
      kind: "file",
    },
    {
      ...metadata(
        "calendar/holidays.rem",
        `# Company & National Holidays
REM 2026-10-12 MSG Columbus Day / Indigenous Peoples' Day
REM 2026-10-31 TAG social MSG Halloween Celebration
`,
      ),
      kind: "file",
    },
    {
      ...metadata(
        "calendar/2026-10-15-q4-sync.md",
        `# Q4 Strategy Sync Notes

- **Date**: 2026-10-15
- **Time**: 10:00 - 11:30
- **Attendees**: Alice, Bob, Charlie

## Agenda
1. Review Q3 Milestones
2. Finalize Q4 Roadmap
3. Resource allocation
`,
      ),
      kind: "file",
    },
    {
      ...metadata("workspace.yaml", "domains:\n  - inbox\n"),
      kind: "file",
    },
    { kind: "directory", path: "finance" },
    {
      ...metadata(
        "finance/journal.hledger",
        `; Personal Finance Journal
; Currency: VND

2026-07-01 Payslip 2026-07
    assets:cash                                  63710000 VND
    expenses:tax:pit                              4500000 VND
    expenses:payroll:insurance                    3500000 VND
    income:salary:talentnet                     -71710000 VND

2026-07-05 * Phone installment
    expenses:electronics:phone                    4970000 VND
    assets:cash                                 -4970000 VND

2026-07-10 * Household support
    expenses:household:family                    25000000 VND
    assets:cash                                -25000000 VND

2026-07-15 * Ride-hailing & Transport
    expenses:transport:ride_hailing               2010000 VND
    assets:cash                                 -2010000 VND

2026-07-20 * Groceries & Dining
    expenses:food:dining                          3850000 VND
    assets:cash                                 -3850000 VND

2026-08-01 Payslip 2026-08
    assets:cash                                  63710000 VND
    expenses:tax:pit                              4500000 VND
    expenses:payroll:insurance                    3500000 VND
    income:salary:talentnet                     -71710000 VND

2026-08-05 * Phone installment
    expenses:electronics:phone                    4970000 VND
    assets:cash                                 -4970000 VND

2026-08-10 * Household support
    expenses:household:family                    30000000 VND
    assets:cash                                -30000000 VND

2026-08-18 * Ride-hailing & Transport
    expenses:transport:ride_hailing               1990000 VND
    assets:cash                                 -1990000 VND

2026-08-25 * Dining & Utilities
    expenses:food:dining                          4200000 VND
    assets:cash                                 -4200000 VND
`,
      ),
      kind: "file",
    },
    { kind: "directory", path: "projects" },
    {
      ...metadata("projects/project.md", "# Project\n\nA sample project.\n"),
      kind: "file",
    },
    { kind: "directory", path: "tasks" },
    {
      ...metadata("tasks/task.md", "# Task\n\nA sample task.\n"),
      kind: "file",
    },
    { ...metadata(path, content), kind: "file" },
  ];

  const fileContents: Record<string, string> = {
    [memoryDocumentPath("USER.md")]:
      "# User profile\n\nPrefer concise, practical answers.\n",
    [memoryDocumentPath("MEMORY.md")]:
      "# Assistant memory\n\nDurable notes for future sessions.\n",
    "calendar/event.md":
      "# Calendar event\n\nA sample event for UI development.\n",
    "workspace.yaml": "domains:\n  - inbox\n",
    "finance/journal.hledger": `; Personal Finance Journal
; Currency: VND

2026-07-01 Payslip 2026-07
    assets:cash                                  63710000 VND
    expenses:tax:pit                              4500000 VND
    expenses:payroll:insurance                    3500000 VND
    income:salary:talentnet                     -71710000 VND

2026-07-05 * Phone installment
    expenses:electronics:phone                    4970000 VND
    assets:cash                                 -4970000 VND

2026-07-10 * Household support
    expenses:household:family                    25000000 VND
    assets:cash                                -25000000 VND

2026-07-15 * Ride-hailing & Transport
    expenses:transport:ride_hailing               2010000 VND
    assets:cash                                 -2010000 VND

2026-07-20 * Groceries & Dining
    expenses:food:dining                          3850000 VND
    assets:cash                                 -3850000 VND

2026-08-01 Payslip 2026-08
    assets:cash                                  63710000 VND
    expenses:tax:pit                              4500000 VND
    expenses:payroll:insurance                    3500000 VND
    income:salary:talentnet                     -71710000 VND

2026-08-05 * Phone installment
    expenses:electronics:phone                    4970000 VND
    assets:cash                                 -4970000 VND

2026-08-10 * Household support
    expenses:household:family                    30000000 VND
    assets:cash                                -30000000 VND

2026-08-18 * Ride-hailing & Transport
    expenses:transport:ride_hailing               1990000 VND
    assets:cash                                 -1990000 VND

2026-08-25 * Dining & Utilities
    expenses:food:dining                          4200000 VND
    assets:cash                                 -4200000 VND

2025-11-01 Payslip 2025-11
    assets:cash                                  58000000 VND
    income:salary:talentnet                     -58000000 VND

2025-11-15 * Family Support
    expenses:household:family                    20000000 VND
    assets:cash                                -20000000 VND

2024-12-01 Payslip 2024-12
    assets:cash                                  50000000 VND
    income:salary:talentnet                     -50000000 VND

2024-12-15 * Family Support
    expenses:household:family                    15000000 VND
    assets:cash                                -15000000 VND
`,
    "projects/project.md": "# Project\n\nA sample project.\n",
    "tasks/task.md": "# Task\n\nA sample task.\n",
    "calendar/reminders.rem": `# OpenLia Workspace Calendar
INCLUDE holidays.rem

REM 2026-10-15 AT 10:00 DURATION 1:30 TAG sprint PRIORITY 100 \\
    INFO "Location: 123 Market St, Room 4" \\
    INFO "Map-Url: https://maps.google.com/?q=123+Market+St" \\
    INFO "Video-Link: https://meet.google.com/abc-defg-hij" \\
    INFO "Attendees: Alice <alice@example.com>, Bob, [[Charlie]]" \\
    INFO "Description: Quarterly strategy sync and roadmap review" \\
    INFO "Event-Note: calendar/2026-10-15-q4-sync.md" \\
    MSG Q4 Strategy Sync

REM 2026-10-16 AT 14:00 DURATION 45 TAG 1on1 \\
    INFO "Video-Link: https://meet.google.com/xyz-uvwx-rst" \\
    INFO "Attendees: Sarah" \\
    INFO "Description: Bi-weekly 1:1 check-in" \\
    MSG Sarah 1:1 Sync

REM 2026-10-20 AT 11:00 DURATION 1:00 TAG architecture \\
    INFO "Location: Engineering Lounge" \\
    INFO "Video-Link: https://zoom.us/j/9876543210" \\
    INFO "Attendees: Dave, Elena, Frank" \\
    INFO "Description: API V2 design discussion" \\
    MSG API Architecture Review

REM Mon AT 09:30 DURATION 30 TAG team recurring MSG Weekly Team Standup

REM Fri AT 16:30 DURATION 45 TAG team recurring MSG Friday Demo & Retro
`,
    "calendar/holidays.rem": `# Company & National Holidays
REM 2026-10-12 MSG Columbus Day / Indigenous Peoples' Day
REM 2026-10-31 TAG social MSG Halloween Celebration
`,
    "calendar/2026-10-15-q4-sync.md": `# Q4 Strategy Sync Notes

- **Date**: 2026-10-15
- **Time**: 10:00 - 11:30
- **Attendees**: Alice, Bob, Charlie

## Agenda
1. Review Q3 Milestones
2. Finalize Q4 Roadmap
3. Resource allocation
`,
    [path]: content,
  };
  const fileRevisions: Record<string, string> = {
    "calendar/event.md": "sha256:mock-calendar",
    "calendar/reminders.rem": "sha256:mock-reminders",
    "calendar/holidays.rem": "sha256:mock-holidays",
    "calendar/2026-10-15-q4-sync.md": "sha256:mock-q4-sync",
    "workspace.yaml": "sha256:mock-workspace",
    "finance/journal.hledger": "sha256:mock-journal",
    "projects/project.md": "sha256:mock-project",
    "tasks/task.md": "sha256:mock-task",
    [path]: revision,
  };

  const mockSkills: SkillDetail[] = [
    {
      author: undefined,
      bundled: true,
      category: "research",
      description: "Exhaustive multi-source research investigation.",
      enabled: true,
      fileCount: 2,
      files: [
        {
          editable: true,
          modified_at: modifiedAt,
          path: "SKILL.md",
          size: 680,
        },
        {
          editable: true,
          modified_at: modifiedAt,
          path: "templates/report.md",
          size: 240,
        },
      ],
      id: "deep-research",
      lastUsedAt: "2026-09-25T12:00:00.000Z",
      name: "deep-research",
      pinned: true,
      platforms: ["macos", "linux"],
      tags: ["research", "web"],
      useCount: 32,
      version: "1.0.0",
    },
    {
      author: "community",
      bundled: false,
      category: "productivity",
      description: "Notion API + ntn CLI: pages, databases, markdown.",
      enabled: true,
      fileCount: 1,
      files: [
        {
          editable: true,
          modified_at: modifiedAt,
          path: "SKILL.md",
          size: 1200,
        },
      ],
      id: "productivity/notion",
      lastUsedAt: "2026-09-26T08:00:00.000Z",
      license: "MIT",
      name: "notion",
      pinned: false,
      platforms: ["linux", "macos", "windows"],
      prerequisites: { env_vars: ["NOTION_API_KEY"] },
      tags: ["Notion", "Productivity", "Notes"],
      useCount: 45,
      version: "2.0.0",
    },
    {
      author: undefined,
      bundled: true,
      category: "creative",
      description: "Generate polished web mockups and design specs.",
      enabled: true,
      fileCount: 1,
      files: [
        {
          editable: true,
          modified_at: modifiedAt,
          path: "SKILL.md",
          size: 520,
        },
      ],
      id: "creative/claude-design",
      lastUsedAt: "2026-09-23T15:30:00.000Z",
      name: "claude-design",
      pinned: false,
      tags: ["design", "ui"],
      useCount: 19,
      version: "1.1.0",
    },
    {
      author: undefined,
      bundled: true,
      category: "apple",
      description: "Apple Notes extraction and synchronization.",
      enabled: false,
      fileCount: 1,
      files: [
        {
          editable: true,
          modified_at: modifiedAt,
          path: "SKILL.md",
          size: 380,
        },
      ],
      id: "apple/apple-notes",
      name: "apple-notes",
      pinned: false,
      platforms: ["macos"],
      tags: ["apple", "notes"],
      useCount: 3,
      version: "0.9.0",
    },
  ];

  const mockSkillFiles: Record<string, string> = {
    "deep-research:SKILL.md": `---\nname: deep-research\ndescription: Exhaustive multi-source research investigation.\nversion: 1.0.0\nplatforms: [macos, linux]\nmetadata:\n  hermes:\n    tags: [research, web]\n    category: research\n---\n\n# Deep Research\n\nPerform in-depth multi-phase web research.\n`,
    "deep-research:templates/report.md":
      "# Research Report Template\n\n## Overview\n",
    "productivity/notion:SKILL.md": `---\nname: notion\ndescription: "Notion API + ntn CLI: pages, databases, markdown."\nversion: 2.0.0\nauthor: community\nlicense: MIT\nplatforms: [linux, macos, windows]\nprerequisites:\n  env_vars: [NOTION_API_KEY]\nmetadata:\n  hermes:\n    tags: [Notion, Productivity, Notes]\n---\n\n# Notion\n\nInteract with Notion workspaces, databases, and pages.\n`,
    "creative/claude-design:SKILL.md": `---\nname: claude-design\ndescription: Generate polished web mockups and design specs.\nversion: 1.1.0\nmetadata:\n  hermes:\n    tags: [design, ui]\n    category: creative\n---\n\n# Claude Design\n\nDraft UI components and visual guidelines.\n`,
    "apple/apple-notes:SKILL.md": `---\nname: apple-notes\ndescription: Apple Notes extraction and synchronization.\nversion: 0.9.0\nplatforms: [macos]\nmetadata:\n  hermes:\n    tags: [apple, notes]\n    category: apple\n---\n\n# Apple Notes\n\nInteract with Apple Notes.\n`,
  };

  const mockSkillRevisions: Record<string, string> = {
    "deep-research:SKILL.md": "sha256:mock-deep-md",
    "deep-research:templates/report.md": "sha256:mock-deep-tpl",
    "productivity/notion:SKILL.md": "sha256:mock-notion-md",
    "creative/claude-design:SKILL.md": "sha256:mock-claude-md",
    "apple/apple-notes:SKILL.md": "sha256:mock-apple-md",
  };

  const mockPasswordProfiles: DocumentPasswordProfile[] = [
    {
      profile_id: "bank_default",
      label: "Primary Bank PDF",
      description: "Bank statements from primary financial institution",
      hint: "Last 4 digits of account number",
      patterns: ["*bank*", "*statement*"],
    },
  ];

  function requireAuthentication() {
    if (!authenticated) throw error(401, "authentication_required");
  }

  function fileResponse(filePath: string): WorkspaceFile {
    if (isMemoryDocument(filePath) && !settings.enable_memory_editing) {
      throw error(403, "memory_editing_disabled");
    }
    const current = fileContents[filePath];
    if (current === undefined) throw error(404, "not_found");
    return {
      ...metadata(filePath, current),
      content: current,
      revision: fileRevisions[filePath] ?? revision,
      schema: 1,
    };
  }

  function treeResponse(): WorkspaceTreeResponse {
    return {
      entries: [
        ...entries,
        ...(settings.enable_memory_editing
          ? MEMORY_FILENAMES.map((name): WorkspaceTreeEntry => {
              const memoryPath = memoryDocumentPath(name);
              return {
                ...metadata(memoryPath, fileContents[memoryPath] ?? ""),
                kind: "file",
              };
            })
          : []),
      ],
      schema: 1,
      truncated: false,
    };
  }

  return {
    async loadTree() {
      requireAuthentication();
      return scenario === "empty"
        ? { ...treeResponse(), entries: [] }
        : treeResponse();
    },
    async loadSession(): Promise<AuthSessionResponse> {
      if (scenario === "error") throw error(500, "request_failed");
      if (scenario === "loading") await new Promise<void>(() => undefined);
      return {
        auth_required: scenario === "auth",
        authenticated,
        schema: 1,
      };
    },
    async login(password): Promise<AuthLoginResponse> {
      if (!password) throw error(401, "invalid_login");
      authenticated = true;
      return { ok: true, schema: 1 };
    },
    async loginWithFirebase(idToken): Promise<AuthLoginResponse> {
      if (!idToken) throw error(401, "invalid_login");
      authenticated = true;
      return { ok: true, schema: 1 };
    },
    async logout(): Promise<AuthLoginResponse> {
      authenticated = false;
      return { ok: true, schema: 1 };
    },
    async loadFile(requestedPath) {
      requireAuthentication();
      return fileResponse(requestedPath);
    },
    async loadFileMetadata(requestedPath) {
      requireAuthentication();
      if (isMemoryDocument(requestedPath)) return fileResponse(requestedPath);
      const entry = entries.find(
        (item) => item.kind === "file" && item.path === requestedPath,
      );
      if (entry?.kind !== "file") throw error(404, "not_found");
      return {
        ...entry,
        revision: fileRevisions[requestedPath] ?? revision,
      };
    },
    async saveFile(requestedPath, nextContent, expectedRevision) {
      requireAuthentication();
      if (isMemoryDocument(requestedPath) && !settings.enable_memory_editing)
        throw error(403, "memory_editing_disabled");
      if (!(requestedPath in fileContents)) throw error(404, "not_found");
      if (requestedPath === path && conflictPending) {
        conflictPending = false;
        throw error(409, "revision_conflict", "sha256:mock-current");
      }
      const currentRev = fileRevisions[requestedPath] ?? revision;
      if (expectedRevision !== currentRev)
        throw error(409, "revision_conflict", currentRev);
      fileContents[requestedPath] = nextContent;
      if (requestedPath === path) content = nextContent;
      const nextRev = `sha256:mock-${++saveCount}`;
      fileRevisions[requestedPath] = nextRev;
      if (requestedPath === path) revision = nextRev;
      const response: WorkspaceWriteResponse = {
        ...metadata(requestedPath, nextContent),
        ok: true,
        revision: nextRev,
        schema: 1,
      };
      return response;
    },
    async deleteFile(
      requestedPath,
      expectedRevision,
    ): Promise<WorkspaceDeleteResponse> {
      requireAuthentication();
      if (isMemoryDocument(requestedPath)) throw error(403, "protected_path");
      const entryExists = entries.some(
        (item) => item.kind === "file" && item.path === requestedPath,
      );
      const currentContent = fileContents[requestedPath];
      if (currentContent === undefined && !entryExists)
        throw error(404, "not_found");
      const currentRevision = fileRevisions[requestedPath] ?? revision;
      if (expectedRevision !== currentRevision) {
        throw error(409, "revision_conflict", currentRevision);
      }
      delete fileContents[requestedPath];
      delete fileRevisions[requestedPath];
      entries = entries.filter(
        (entry) => !(entry.kind === "file" && entry.path === requestedPath),
      );
      return { ok: true, path: requestedPath, schema: 1 };
    },
    async renameFile(
      requestedPath,
      newName,
      expectedRevision,
    ): Promise<WorkspaceRenameResponse> {
      requireAuthentication();
      if (isMemoryDocument(requestedPath)) throw error(403, "protected_path");
      const currentContent = fileContents[requestedPath];
      if (currentContent === undefined) throw error(404, "not_found");
      const currentRev = fileRevisions[requestedPath] ?? revision;
      if (expectedRevision !== currentRev) {
        throw error(409, "revision_conflict", currentRev);
      }
      const parts = requestedPath.split("/");
      parts[parts.length - 1] = newName;
      const newPath = parts.join("/");
      if (fileContents[newPath] !== undefined) {
        throw error(409, "destination_exists");
      }
      delete fileContents[requestedPath];
      delete fileRevisions[requestedPath];
      fileContents[newPath] = currentContent;
      fileRevisions[newPath] = currentRev;
      entries = entries.map((entry) => {
        if (entry.kind === "file" && entry.path === requestedPath) {
          return { ...entry, path: newPath };
        }
        return entry;
      });
      return {
        ...metadata(newPath, currentContent),
        ok: true,
        previous_path: requestedPath,
        revision: currentRev,
        schema: 1,
      };
    },
    async moveFile(
      sourcePath,
      destinationPath,
      expectedRevision,
    ): Promise<WorkspaceMoveResponse> {
      requireAuthentication();
      if (isMemoryDocument(sourcePath) || isMemoryDocument(destinationPath))
        throw error(403, "protected_path");
      const currentContent = fileContents[sourcePath];
      if (currentContent === undefined) throw error(404, "not_found");
      const currentRev = fileRevisions[sourcePath] ?? revision;
      if (expectedRevision !== currentRev) {
        throw error(409, "revision_conflict", currentRev);
      }
      if (fileContents[destinationPath] !== undefined) {
        throw error(409, "destination_exists");
      }
      delete fileContents[sourcePath];
      delete fileRevisions[sourcePath];
      fileContents[destinationPath] = currentContent;
      fileRevisions[destinationPath] = currentRev;

      // Add parent directory to entries if not already present
      const destDir = destinationPath.split("/").slice(0, -1).join("/");
      if (destDir && !entries.some((e) => e.path === destDir)) {
        entries.push({ kind: "directory", path: destDir });
      }

      entries = entries.map((entry) => {
        if (entry.kind === "file" && entry.path === sourcePath) {
          return { ...entry, path: destinationPath };
        }
        return entry;
      });
      return {
        ...metadata(destinationPath, currentContent),
        ok: true,
        previous_path: sourcePath,
        revision: currentRev,
        schema: 1,
      };
    },
    async loadCreatableDomains(): Promise<WorkspaceDomainsResponse> {
      requireAuthentication();
      return {
        domains: mockCreatableDomains,
        schema: 1,
      };
    },
    async createFile(domain: string, name: string): Promise<WorkspaceFile> {
      requireAuthentication();
      const matched = mockCreatableDomains.find((d) => d.path === domain);
      if (!matched) {
        throw error(403, "domain_not_allowed");
      }
      let filename = name.trim();
      if (!filename.toLowerCase().endsWith(".md")) {
        filename = `${filename}.md`;
      }
      if (
        filename.includes("/") ||
        filename.includes("\\") ||
        filename.includes("..")
      ) {
        throw error(400, "invalid_filename");
      }
      if (
        filename.endsWith("-template.md") ||
        filename.endsWith(".schema.json")
      ) {
        throw error(400, "invalid_filename");
      }
      const newPath = `${matched.path}/${filename}`;
      if (fileContents[newPath] !== undefined) {
        throw error(409, "destination_exists");
      }

      // Starter template content
      const templateContent =
        domain === "tasks"
          ? `---\n$schema: ./task-template.schema.json\nstatus: todo\npriority: medium\ndue_date: null\nlinked_project: null\nlinked_area: null\ncontext_tags: []\ncompleted_at: null\n---\n\n# ${filename.replace(/\.md$/i, "")}\n\n## Action\n`
          : `---\n$schema: ./${domain}-template.schema.json\n---\n\n# ${filename.replace(/\.md$/i, "")}\n`;

      const nextRev = `sha256:mock-${++saveCount}`;
      fileContents[newPath] = templateContent;
      fileRevisions[newPath] = nextRev;

      const newEntry: WorkspaceTreeEntry = {
        ...metadata(newPath, templateContent),
        kind: "file",
      };
      if (
        !entries.some((e) => e.kind === "directory" && e.path === matched.path)
      ) {
        entries.push({ kind: "directory", path: matched.path });
      }
      entries.push(newEntry);

      return {
        ...metadata(newPath, templateContent),
        content: templateContent,
        revision: nextRev,
        schema: 1,
        validation: { errors: [], valid: true },
      };
    },
    async loadDiagnostics(): Promise<WorkspaceDiagnosticsResponse> {
      requireAuthentication();
      return {
        issues: [],
        schema: 1,
        valid: true,
      };
    },
    async loadSettings(): Promise<WorkspaceSettings> {
      requireAuthentication();
      return { ...settings };
    },
    async updateSettings(nextSettings): Promise<WorkspaceSettings> {
      requireAuthentication();
      settings = { ...nextSettings, schema: 1 };
      return { ...settings };
    },
    async loadSystemInfo(): Promise<WorkspaceSystemInfo> {
      requireAuthentication();
      return {
        hermes_version: "v2026.9.14",
        locho_version: "1.2.0",
        openlia_hash: "471234288494f25aca1bce5c2b8355a308",
        openlia_version: "0.1.0",
        schema: 1,
      };
    },
    async loadGitStatus(): Promise<WorkspaceGitStatus> {
      requireAuthentication();
      return {
        branch: "main",
        configured: true,
        dirty: fileContents[path] !== "Hello",
        schema: 1,
      };
    },
    async loadActivity(): Promise<WorkspaceActivityResponse> {
      requireAuthentication();
      if (scenario === "empty") {
        return {
          branch: "main",
          commits: [],
          gitConfigured: true,
          recentFiles: [],
          schema: 1,
          uncommitted: [],
        };
      }
      const isDirty = fileContents[path] !== "Hello";
      const recentFiles: WorkspaceFileMetadata[] = entries
        .filter(
          (e): e is WorkspaceFileMetadata & { kind: "file" } =>
            e.kind === "file",
        )
        .map((f) => ({
          editable: f.editable,
          modified_at: f.modified_at,
          path: f.path,
          size: f.size,
        }))
        .sort(
          (a, b) =>
            new Date(b.modified_at).getTime() -
            new Date(a.modified_at).getTime(),
        );

      return {
        branch: "main",
        commits: [
          {
            author: "OpenLia Agent",
            files: [
              { path: "notes.md", status: "modified" },
              { path: "tasks/task.md", status: "added" },
            ],
            hash: "a1b2c3d4e5f67890123456789abcdef012345678",
            message: "chore: update daily notes and task plan",
            shortHash: "a1b2c3d",
            timestamp: "2026-09-24T18:30:00.000Z",
          },
          {
            author: "OpenLia Agent",
            files: [{ path: "projects/project.md", status: "modified" }],
            hash: "f6e5d4c3b2a10987654321fedcba09876543210f",
            message: "backup: project status milestone",
            shortHash: "f6e5d4c",
            timestamp: "2026-09-23T11:15:00.000Z",
          },
          {
            author: "OpenLia Agent",
            files: [
              { path: "calendar/event.md", status: "added" },
              { path: "notes.md", status: "added" },
            ],
            hash: "123456789abcdef0123456789abcdef012345678",
            message: "chore: initialize OpenLia workspace",
            shortHash: "1234567",
            timestamp: "2026-09-22T00:00:00.000Z",
          },
        ],
        gitConfigured: true,
        recentFiles,
        schema: 1,
        uncommitted: isDirty ? [{ path, status: "modified" }] : [],
      };
    },
    downloadUrl(requestedPath) {
      const current = fileContents[requestedPath];
      if (current === undefined) return "#";
      return `data:text/plain;charset=utf-8,${encodeURIComponent(current)}`;
    },
    rawUrl(requestedPath) {
      const current = fileContents[requestedPath];
      if (current === undefined) return "#";
      return `data:application/octet-stream,${encodeURIComponent(current)}`;
    },
    exportWorkspaceUrl() {
      return "#";
    },
    async downloadWorkspaceExport() {
      requireAuthentication();
    },
    async loadIngestion(): Promise<IngestionOverviewResponse> {
      requireAuthentication();
      const intake = {
        action: undefined,
        callback: {
          acknowledged_at: null,
          attempts: 1,
          delivered_at: 1_758_700_000,
          delivery_state: "awaiting_ack",
          durable_status: "pending",
          event_id: "evt_mock",
          last_error: null,
        },
        captured_at: modifiedAt,
        durable_status: "processing",
        intake_id: "intake_mock",
        intake_record_path: "inbox/ingestion/intake_mock.md",
        job: {
          attempts: 1,
          created_at: 1_758_700_000,
          error_code: null,
          error_summary: null,
          heartbeat_at: 1_758_700_030,
          intake_id: "intake_mock",
          job_id: "job_mock",
          lease_expires_at: 1_758_700_090,
          next_attempt_at: null,
          operation: "extract",
          requested_outputs: ["text"],
          source_id: "src_mock",
          state: "running",
          updated_at: 1_758_700_030,
          version_id: "ver_mock",
        },
        kind: "pdf",
        operation: "extract",
        requested_outputs: ["text"],
        source_id: "src_mock",
        source_record_path: "sources/records/src_mock.md",
        source_status: "captured",
        source_title: "Quarterly statement",
        source_url: null,
        status: "processing",
        version_id: "ver_mock",
      };
      return {
        counts: { processing: 1 },
        intakes: [intake],
        limit: 50,
        live_age_seconds: 1,
        live_available: true,
        live_generated_at: 1_758_700_030,
        live_stale: false,
        offset: 0,
        queue_counts: { running: 1 },
        schema: 1,
        total: 1,
        truncated: false,
      };
    },
    async loadIngestionDetail(): Promise<IngestionDetailResponse> {
      requireAuthentication();
      const overview = await this.loadIngestion();
      const intake = overview.intakes[0];
      if (!intake) throw error(404, "not_found");
      return {
        artifacts: [
          {
            path: "sources/artifacts/src_mock/ver_mock/original.pdf",
            role: "original",
            warnings: [],
          },
        ],
        intake,
        live_age_seconds: overview.live_age_seconds,
        live_available: overview.live_available,
        live_generated_at: overview.live_generated_at,
        live_stale: overview.live_stale,
        schema: 1,
        source: {
          captured_at: modifiedAt,
          id: "src_mock",
          kind: "pdf",
          origin: { channel: "chat" },
          status: "captured",
          title: "Quarterly statement",
          versions: [],
        },
      };
    },

    async searchSources(): Promise<SourceSearchResponse> {
      requireAuthentication();
      return {
        schema: 1,
        total: 1,
        offset: 0,
        limit: 20,
        matches: [
          {
            source_id: "src_mock",
            title: "Quarterly statement",
            correspondent: "ACME Corp",
            document_type: "statement",
            document_date: "2026-10-10",
            tags: ["finance", "statement"],
            summary: "Quarterly statement summary",
            review_status: "needs-review",
            processing_status: "complete",
            lifecycle: "active",
            snippet: "Quarterly statement for <mark>Q3</mark>",
            rank: 1,
            canonical_uri: "openlia://source/src_mock",
            markdown_citation:
              "[Quarterly statement](openlia://source/src_mock)",
          },
        ],
        facets: {
          tags: { finance: 1, statement: 1 },
          correspondents: { "ACME Corp": 1 },
          document_types: { statement: 1 },
          review_status: { "needs-review": 1 },
          processing_status: { complete: 1 },
        },
      };
    },

    async loadSource(sourceId: string): Promise<SourceDocument> {
      requireAuthentication();
      return {
        id: sourceId,
        title: "Quarterly statement",
        kind: "pdf",
        document_type: "statement",
        correspondent: "ACME Corp",
        document_date: "2026-10-10",
        tags: ["finance", "statement"],
        summary: "Quarterly statement summary",
        processing: {
          status: "complete",
          last_job_id: "job_mock",
          error_code: null,
          error_summary: null,
        },
        review: {
          status: "needs-review",
          reasons: ["check-totals"],
          reviewed_at: null,
        },
        lifecycle: "active",
        captured_at: modifiedAt,
        origin: { capture_method: "upload" },
        versions: [],
        canonical_uri: `openlia://source/${sourceId}`,
        markdown_citation: `[Quarterly statement](openlia://source/${sourceId})`,
        content: "Quarterly statement extracted content",
        backlinks: [],
        extractions: [],
      };
    },

    async updateSource(
      sourceId: string,
      updates: any,
    ): Promise<SourceDocument> {
      requireAuthentication();
      const doc = await this.loadSource(sourceId);
      return {
        ...doc,
        ...updates,
      };
    },

    sourceRawUrl(sourceId: string, versionId?: string): string {
      const params = new URLSearchParams();
      if (versionId) params.set("version_id", versionId);
      const query = params.toString();
      return `/api/workspace/ingestion/sources/${encodeURIComponent(sourceId)}/raw${query ? `?${query}` : ""}`;
    },

    async retrySource(sourceId: string) {
      requireAuthentication();
      return {
        schema: 1 as const,
        ok: true as const,
        source_id: sourceId,
        job_id: "job_retry_mock",
        state: "queued",
      };
    },

    async listDocumentPasswords() {
      requireAuthentication();
      return {
        schema: 1 as const,
        ok: true as const,
        profiles: [...mockPasswordProfiles],
      };
    },

    async saveDocumentPassword(
      profileId: string,
      label: string,
      _password?: string,
      description?: string,
      hint?: string,
      patterns?: string[],
    ) {
      requireAuthentication();
      const existingIdx = mockPasswordProfiles.findIndex(
        (p) => p.profile_id === profileId,
      );
      const profile: DocumentPasswordProfile = {
        profile_id: profileId,
        label: label || profileId,
        ...(description ? { description } : {}),
        ...(hint ? { hint } : {}),
        ...(patterns ? { patterns } : {}),
      };
      if (existingIdx >= 0) {
        mockPasswordProfiles[existingIdx] = profile;
      } else {
        mockPasswordProfiles.push(profile);
      }
      return {
        schema: 1 as const,
        ok: true as const,
        profile,
      };
    },

    async deleteDocumentPassword(profileId: string) {
      requireAuthentication();
      const existingIdx = mockPasswordProfiles.findIndex(
        (p) => p.profile_id === profileId,
      );
      if (existingIdx >= 0) {
        mockPasswordProfiles.splice(existingIdx, 1);
        return {
          schema: 1 as const,
          ok: true as const,
          deleted: profileId,
        };
      }
      return {
        schema: 1 as const,
        ok: false as const,
      };
    },

    async suggestDocumentPasswords(params: {
      filename?: string;
      title?: string;
      correspondent?: string;
      message?: string;
    }): Promise<DocumentPasswordSuggestResponse> {
      requireAuthentication();
      const list = await this.listDocumentPasswords();
      const suggestions = suggestPasswordProfiles(params, list.profiles);
      return {
        schema: 1,
        ok: true,
        suggestions,
      };
    },

    async uploadDocument(): Promise<SourceUploadResponse> {
      requireAuthentication();
      return {
        schema: 1,
        ok: true,
        source_id: "src_uploaded",
        version_id: "ver_001",
        job_id: "job_uploaded",
        title: "Uploaded Document",
      };
    },

    async uploadDocumentJson(): Promise<SourceUploadResponse> {
      requireAuthentication();
      return {
        schema: 1,
        ok: true,
        source_id: "src_uploaded_json",
        version_id: "ver_001",
        job_id: "job_uploaded_json",
        title: "Uploaded Document",
      };
    },

    async loadSkills() {
      requireAuthentication();
      return {
        categories: Array.from(
          new Set(mockSkills.map((s) => s.category)),
        ).sort(),
        schema: 1,
        skills: mockSkills.map((s) => ({
          author: s.author,
          bundled: s.bundled,
          category: s.category,
          description: s.description,
          enabled: s.enabled,
          fileCount: s.files.length,
          id: s.id,
          lastUsedAt: s.lastUsedAt,
          name: s.name,
          pinned: s.pinned,
          tags: s.tags,
          useCount: s.useCount,
          version: s.version,
        })),
      };
    },
    async loadSkillDetail(id) {
      requireAuthentication();
      const found = mockSkills.find((s) => s.id === id);
      if (!found) throw error(404, "skill_not_found");
      return { schema: 1, skill: { ...found } };
    },
    async loadSkillFile(id, filePath) {
      requireAuthentication();
      const key = `${id}:${filePath}`;
      const fileContent = mockSkillFiles[key];
      if (fileContent === undefined) throw error(404, "not_found");
      return {
        content: fileContent,
        editable: true,
        id,
        modified_at: modifiedAt,
        path: filePath,
        revision: mockSkillRevisions[key] ?? "sha256:mock-skill-rev",
        schema: 1,
        size: new TextEncoder().encode(fileContent).byteLength,
      };
    },
    async saveSkillFile(id, filePath, nextContent, expectedRev) {
      requireAuthentication();
      const key = `${id}:${filePath}`;
      const currentRev = mockSkillRevisions[key] ?? "sha256:mock-skill-rev";
      if (expectedRev !== currentRev) {
        throw error(409, "revision_conflict", currentRev);
      }
      mockSkillFiles[key] = nextContent;
      const nextRev = `sha256:mock-skill-${++saveCount}`;
      mockSkillRevisions[key] = nextRev;
      return {
        id,
        modified_at: new Date().toISOString(),
        ok: true,
        path: filePath,
        revision: nextRev,
        schema: 1,
        size: new TextEncoder().encode(nextContent).byteLength,
      };
    },
    async toggleSkillEnable(id, enabled) {
      requireAuthentication();
      const found = mockSkills.find((s) => s.id === id);
      if (found) found.enabled = enabled;
      return { ok: true, schema: 1 };
    },
    async toggleSkillPin(id, pinned) {
      requireAuthentication();
      const found = mockSkills.find((s) => s.id === id);
      if (found) found.pinned = pinned;
      return { ok: true, schema: 1 };
    },
    async createSkill(request) {
      requireAuthentication();
      const id = request.category
        ? `${request.category}/${request.name}`
        : request.name;
      const newSkill: (typeof mockSkills)[0] = {
        bundled: false,
        category: request.category || "standalone",
        description: request.description,
        enabled: true,
        fileCount: 1,
        files: [
          {
            editable: true,
            modified_at: new Date().toISOString(),
            path: "SKILL.md",
            size: 100,
          },
        ],
        id,
        name: request.name,
        pinned: false,
        tags: [],
        useCount: 0,
        version: "0.1.0",
      };
      mockSkills.push(newSkill);
      const key = `${id}:SKILL.md`;
      mockSkillFiles[key] =
        `---\nname: ${request.name}\ndescription: ${request.description}\nversion: 0.1.0\n---\n\n# ${request.name}\n\n${request.description}\n`;
      mockSkillRevisions[key] = "sha256:mock-created";
      return { id, ok: true, schema: 1 };
    },
    async loadMigrations() {
      return [
        {
          id: "mig-mock-1",
          schema: 2,
          state: "ready_for_review",
          stop_intent: false,
          total_revisions: 1,
          total_sources: 2,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];
    },
    async loadMigrationDetail(id: string) {
      return {
        schema: 2 as const,
        migration: {
          id,
          schema: 2,
          state: "ready_for_review",
          stop_intent: false,
          total_revisions: 1,
          total_sources: 2,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        sources: [
          {
            id: "src-1",
            relative_path: "notes.md",
            byte_size: 100,
            encoding: "utf-8",
            detected_type: "markdown",
            eligibility: "eligible" as const,
            order_index: 1,
          },
        ],
        revisions: [
          {
            id: "rev-1",
            migration_id: id,
            revision_num: 1,
            baseline_hash: "base-1",
            commit_hash: "commit-1",
            tree_hash: "tree-1",
            patch_hash: "patch-1",
            summary: "Mock initial revision",
            changed_files: [{ path: "notes.md", status: "added" as const }],
            created_at: new Date().toISOString(),
          },
        ],
        active_diff:
          "diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,1 @@\n+# Mock Note\n",
        feedback: [],
        worker_status: "sleeping" as const,
      };
    },
    async submitMigrationFeedback(id: string, req) {
      return { ok: true, migration_id: id };
    },
    async approveMigration(id: string, revisionId: string) {
      return {
        ok: true,
        migration_id: id,
        revision_id: revisionId,
        state: "applied",
      };
    },
    async discardMigration(id: string) {
      return { ok: true, migration_id: id, state: "discarded" };
    },
    async stopMigration(id: string) {
      return { ok: true, migration_id: id, state: "stopped" };
    },
    async resumeMigration(id: string) {
      return { ok: true, migration_id: id, state: "processing" };
    },
    async wakeMigration(id: string) {
      return { ok: true, migration_id: id };
    },
  };
}

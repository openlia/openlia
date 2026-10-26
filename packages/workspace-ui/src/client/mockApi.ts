import type {
  AuthLoginResponse,
  AuthSessionResponse,
  ConsequentialPermissionsResponse,
  DocumentPasswordProfile,
  DocumentPasswordSuggestResponse,
  IngestionDetailResponse,
  IngestionOverviewResponse,
  MaintainerFinding,
  MaintainerFixApplyResponse,
  MaintainerFixPreviewResponse,
  MaintainerOverviewResponse,
  PublicShareFileEntry,
  PublicShareResponse,
  ShareCreateRequest,
  ShareDeleteResponse,
  ShareExpirationPreset,
  ShareKind,
  ShareListResponse,
  ShareMutationResponse,
  ShareSkillMetadata,
  ShareSummary,
  ShareSyncStatus,
  ShareUpdateRequest,
  SkillDetail,
  SourceDocument,
  SourceSearchResponse,
  SourceUploadResponse,
  WorkspaceActivityResponse,
  WorkspaceDeleteResponse,
  WorkspaceDiagnosticsResponse,
  WorkspaceDomainInfo,
  WorkspaceDomainRecordsResponse,
  WorkspaceDomainsResponse,
  WorkspaceErrorResponse,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceFixDomainTemplateResponse,
  WorkspaceFixTemplateResponse,
  WorkspaceGitStatus,
  WorkspaceMoveResponse,
  WorkspaceProjectResponse,
  WorkspaceProjectsResponse,
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
import type {
  CreateCronJobInput,
  CronOverviewResponse,
  HermesCronJob,
  UpdateCronJobInput,
} from "../shared/cron";
import { suggestPasswordProfiles } from "../shared/passwordSuggester";
import { ApiError, type WorkspaceApi } from "./api";
import { mockUsage } from "./usageMock";
import { createChatMock } from "./chatMock";
import { parseMarkdownRecord } from "./openui/recordMutator";
import { notifyWorkspaceFileChange } from "./workspaceFileChanges";

export type MockWorkspaceScenario =
  | "default"
  | "auth"
  | "conflict"
  | "empty"
  | "error"
  | "loading";

export interface MockWorkspaceOptions {
  scenario?: MockWorkspaceScenario;
  files?: Record<string, string>;
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
  files,
}: MockWorkspaceOptions = {}): WorkspaceApi {
  const usageData = mockUsage();
  if (scenario === "empty") usageData.rows = [];
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
    ...(files
      ? Object.entries(files).map(([fPath, fContent]) => ({
          ...metadata(fPath, fContent),
          kind: "file" as const,
        }))
      : []),
  ];

  const fileContents: Record<string, string> = {
    ...(files ?? {}),
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

  interface MockStoredShare {
    id: string;
    kind: ShareKind;
    target_path: string;
    title: string;
    created_at: string;
    updated_at: string;
    expires_at: string | null;
    expiration_preset: ShareExpirationPreset;
    snapshot_revision: string;
    media_type: string;
    skill_metadata?: ShareSkillMetadata | undefined;
    files: PublicShareFileEntry[];
  }

  const mockShares: MockStoredShare[] = [];
  let mockShareSeq = 0;

  function computeMockSkillRevision(skillId: string): string | null {
    const skill = mockSkills.find((s) => s.id === skillId);
    if (!skill) return null;
    return skill.files
      .map(
        (f) =>
          `${f.path}:${mockSkillRevisions[`${skillId}:${f.path}`] ?? "rev"}`,
      )
      .join("|");
  }

  function toMockShareSummary(item: MockStoredShare): ShareSummary {
    const currentRevision =
      item.kind === "workspace"
        ? fileContents[item.target_path] !== undefined
          ? (fileRevisions[item.target_path] ?? revision)
          : null
        : computeMockSkillRevision(item.target_path);
    const status: ShareSyncStatus =
      currentRevision === null
        ? "source_missing"
        : currentRevision === item.snapshot_revision
          ? "up_to_date"
          : "stale";
    const totalBytes = item.files.reduce((acc, f) => acc + f.size, 0);
    return {
      id: item.id,
      kind: item.kind,
      target_path: item.target_path,
      title: item.title,
      created_at: item.created_at,
      updated_at: item.updated_at,
      expires_at: item.expires_at,
      expiration_preset: item.expiration_preset,
      snapshot_revision: item.snapshot_revision,
      current_revision: currentRevision,
      status,
      file_count: item.files.length,
      total_bytes: totalBytes,
      media_type: item.media_type,
      ...(item.skill_metadata ? { skill_metadata: item.skill_metadata } : {}),
    };
  }

  function captureMockShareData(
    kind: ShareKind,
    targetPath: string,
  ): {
    title: string;
    snapshot_revision: string;
    media_type: string;
    skill_metadata?: ShareSkillMetadata | undefined;
    files: PublicShareFileEntry[];
  } {
    const cleanTarget = targetPath.replace(/^\/+/, "");
    if (kind === "workspace") {
      if (isMemoryDocument(cleanTarget)) throw error(403, "protected_path");
      const text = fileContents[cleanTarget];
      if (text === undefined) throw error(404, "not_found");
      const rev = fileRevisions[cleanTarget] ?? revision;
      const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
      const title = heading || (cleanTarget.split("/").at(-1) ?? cleanTarget);
      const files: PublicShareFileEntry[] = [
        {
          path: cleanTarget,
          size: new TextEncoder().encode(text).byteLength,
          modified_at: modifiedAt,
          media_type: cleanTarget.endsWith(".md")
            ? "text/markdown; charset=utf-8"
            : "text/plain; charset=utf-8",
          editable: true,
          content: text,
        },
      ];
      if (
        cleanTarget === "calendar/reminders.rem" &&
        fileContents["calendar/holidays.rem"]
      ) {
        const incText = fileContents["calendar/holidays.rem"];
        files.push({
          path: "calendar/holidays.rem",
          size: new TextEncoder().encode(incText).byteLength,
          modified_at: modifiedAt,
          media_type: "text/plain; charset=utf-8",
          editable: true,
          content: incText,
        });
      }
      return {
        title,
        snapshot_revision: rev,
        media_type: files[0]?.media_type ?? "text/plain; charset=utf-8",
        files,
      };
    }

    const skill = mockSkills.find((s) => s.id === cleanTarget);
    if (!skill) throw error(404, "skill_not_found");
    const files: PublicShareFileEntry[] = skill.files.map((f) => {
      const fContent = mockSkillFiles[`${skill.id}:${f.path}`] ?? "";
      return {
        path: f.path,
        size: new TextEncoder().encode(fContent).byteLength,
        modified_at: f.modified_at,
        media_type: f.path.endsWith(".md")
          ? "text/markdown; charset=utf-8"
          : "text/plain; charset=utf-8",
        editable: true,
        content: fContent,
      };
    });
    return {
      title: skill.name,
      snapshot_revision:
        computeMockSkillRevision(skill.id) ?? "sha256:mock-skill",
      media_type: "application/x-openlia-skill",
      skill_metadata: {
        name: skill.name,
        category: skill.category,
        description: skill.description,
        version: skill.version,
        author: skill.author,
        license: skill.license,
        tags: skill.tags ?? [],
        platforms: skill.platforms ?? [],
        prerequisites: skill.prerequisites,
      },
      files,
    };
  }

  function computeMockExpiresAt(preset: ShareExpirationPreset): string | null {
    if (preset === "never") return null;
    const days =
      preset === "1d" ? 1 : preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
    return new Date(Date.now() + days * 86400 * 1000).toISOString();
  }

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
    async checkFinanceJournal(path) {
      requireAuthentication();
      return {
        schema: 1,
        path,
        status: "unavailable",
        checked_at: new Date().toISOString(),
        fingerprint: null,
        files: [],
        diagnostics: [
          {
            code: "mock_engine",
            message: "hledger validation is unavailable in demo mode.",
          },
        ],
      };
    },
    async checkFinanceJournalFreshness() {
      requireAuthentication();
      return { schema: 1, current: false, fingerprint: null };
    },
    async loadTree() {
      requireAuthentication();
      return scenario === "empty"
        ? { ...treeResponse(), entries: [] }
        : treeResponse();
    },
    chat: createChatMock(),
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
      notifyWorkspaceFileChange(requestedPath);
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
    async loadDomainOverview(
      domainPath: string,
    ): Promise<WorkspaceDomainRecordsResponse> {
      requireAuthentication();
      const clean = domainPath.replace(/^\/+|\/+$/g, "");
      const matched = mockCreatableDomains.find((d) => d.path === clean) ?? {
        path: clean,
        label: clean.split("/").at(-1) ?? clean,
      };
      const prefix = `${clean}/`;
      const records = Object.entries(fileContents)
        .filter(
          ([p]) =>
            p.startsWith(prefix) &&
            p.endsWith(".md") &&
            !p.endsWith("-template.md") &&
            !p.slice(prefix.length).includes("/"),
        )
        .map(([p, text]) => {
          const fname = p.slice(prefix.length);
          const parsed = parseMarkdownRecord(text);
          return {
            path: p,
            filename: fname,
            title: parsed.title || fname.replace(/\.md$/i, ""),
            modified_at: modifiedAt,
            size: new TextEncoder().encode(text).byteLength,
            revision: fileRevisions[p] ?? revision,
            frontmatter: parsed.metadata,
            sections: Object.keys(parsed.sections),
            excerpt: parsed.body.trim().slice(0, 140),
            validation: { valid: true, errors: [] },
          };
        });

      let schemaJson: Record<string, unknown> | undefined;
      const schemaEntry = Object.entries(fileContents).find(
        ([p]) => p.startsWith(prefix) && p.endsWith(".schema.json"),
      );
      if (schemaEntry) {
        try {
          schemaJson = JSON.parse(schemaEntry[1]);
        } catch {}
      }

      let templateHeadings: string[] | undefined;
      const templateEntry = Object.entries(fileContents).find(
        ([p]) => p.startsWith(prefix) && p.endsWith("-template.md"),
      );
      if (templateEntry) {
        const parsedTmpl = parseMarkdownRecord(templateEntry[1]);
        templateHeadings = Object.keys(parsedTmpl.sections);
      }

      return {
        schema: 1,
        domain: {
          ...matched,
          record_count: records.length,
          invalid_record_count: 0,
        },
        records,
        schema_json: schemaJson,
        template_headings: templateHeadings,
      };
    },
    async loadProjects(): Promise<WorkspaceProjectsResponse> {
      requireAuthentication();
      const projects = [
        {
          path: "tasks",
          id: "tasks",
          name: "Tasks",
          description: "Concrete actions that can be completed.",
          icon: "check-square",
          manifest_path: "tasks/project-manifest.toml",
          ui_path: "tasks/ui.openui",
          template_path: "tasks/task-template.md",
          schema_path: "tasks/task-template.schema.json",
          skills: ["workspace-template-customization"],
          record_count: Object.keys(fileContents).filter(
            (p) =>
              p.startsWith("tasks/") &&
              p.endsWith(".md") &&
              !p.endsWith("-template.md"),
          ).length,
          invalid_record_count: 0,
        },
        {
          path: "goals",
          id: "goals",
          name: "Goals",
          description: "Outcomes and the reasons they matter.",
          icon: "target",
          manifest_path: "goals/project-manifest.toml",
          ui_path: "goals/ui.openui",
          template_path: "goals/goal-template.md",
          schema_path: "goals/goal-template.schema.json",
          skills: ["workspace-template-customization"],
          record_count: Object.keys(fileContents).filter(
            (p) =>
              p.startsWith("goals/") &&
              p.endsWith(".md") &&
              !p.endsWith("-template.md"),
          ).length,
          invalid_record_count: 0,
        },
      ];
      return { schema: 1, projects };
    },
    async loadProject(projectPath: string): Promise<WorkspaceProjectResponse> {
      requireAuthentication();
      const clean = projectPath.replace(/^\/+|\/+$/g, "");
      const overview = await this.loadDomainOverview(clean);
      const manifestRaw =
        fileContents[`${clean}/project-manifest.toml`] ??
        `version = 1\n\n[project]\nid = "${clean}"\nname = "${overview.domain.label}"\n\n[data]\ntemplate = "${overview.domain.template_path?.split("/").at(-1) ?? ""}"\n\n[ui]\nentry = "ui.openui"\n`;
      const uiContent =
        fileContents[`${clean}/ui.openui`] ??
        `root = Stack([DomainHeader("${overview.domain.label}", "${overview.domain.purpose ?? ""}"), RecordTable()])\n`;
      return {
        schema: 1,
        project: {
          path: clean,
          id: clean,
          name: overview.domain.label,
          description: overview.domain.purpose,
          manifest_path: `${clean}/project-manifest.toml`,
          ui_path: `${clean}/ui.openui`,
          template_path: overview.domain.template_path,
          schema_path: overview.domain.schema_path,
          skills: overview.domain.skills ?? [],
          record_count: overview.records.length,
          invalid_record_count: overview.domain.invalid_record_count ?? 0,
        },
        manifest: {
          version: 1,
          project: {
            id: clean,
            name: overview.domain.label,
            description: overview.domain.purpose,
          },
          data: {
            template: overview.domain.template_path?.split("/").at(-1),
            schema: overview.domain.schema_path?.split("/").at(-1),
            status_field: "status",
          },
          ui: { entry: "ui.openui" },
          logic: {
            skills: ["workspace-template-customization"],
            mutations: {
              editable_fields: ["status", "priority", "due"],
            },
          },
        },
        manifest_raw: manifestRaw,
        ui_content: uiContent,
        records: overview.records,
        queries: {},
        schema_json: overview.schema_json,
        template_headings: overview.template_headings,
        project_files: [],
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
    async fixTemplateIssues(
      path: string,
      content?: string,
    ): Promise<WorkspaceFixTemplateResponse> {
      requireAuthentication();
      return {
        schema: 1,
        ok: true,
        migration_id: `mig-mock-${Date.now()}`,
      };
    },
    async fixDomainTemplateIssues(
      domain: string,
    ): Promise<WorkspaceFixDomainTemplateResponse> {
      requireAuthentication();
      return {
        schema: 1,
        ok: true,
        migration_id: `mig-mock-${domain}-${Date.now()}`,
        fixed_count: 1,
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
    async loadUsage(reference) {
      return structuredClone({
        ...usageData,
        rows: reference ? [] : usageData.rows,
      });
    },
    async saveUsageOverride(provider, model, rates) {
      let price = usageData.prices.find(
        (p) => p.provider === provider && p.model === model,
      );
      if (!price) {
        price = {
          provider,
          model,
          rates: null,
          automatic_rates: null,
          source: "unavailable",
          checked_at: null,
          stale: false,
          overridden: false,
        };
        usageData.prices.push(price);
      }
      price.rates = rates ?? price.automatic_rates;
      price.overridden = rates !== null;
      price.source = rates ? "custom_override" : "official_docs_snapshot";
      for (const row of usageData.rows.filter(
        (r) => r.provider === provider && r.model === model,
      )) {
        let cost = 0;
        let known = true;
        for (const key of [
          "input_tokens",
          "output_tokens",
          "cache_read_tokens",
          "cache_write_tokens",
        ] as const) {
          const rate = price.rates?.[key];
          if (row[key] && rate == null) known = false;
          else cost += (row[key] * Number(rate ?? 0)) / 1e6;
        }
        row.cost = known ? cost : null;
        row.partial_cost = !known;
      }
      return { schema: 1, ok: true };
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
        hermes_version: "v0.22.4",
        locho_version: "1.3.0-beta.2",
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
    async loadCheckpointProposals() {
      return { proposals: [] };
    },
    async approveCheckpoint() {
      throw new Error("Checkpoint confirmation is unavailable in preview");
    },
    async dismissCheckpoint() {
      throw new Error("Checkpoint dismissal is unavailable in preview");
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

    async loadSource(
      sourceId: string,
      _versionId?: string,
    ): Promise<SourceDocument> {
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

    async deleteSource(
      sourceId: string,
      options?: { annotate_backlinks?: boolean },
    ) {
      requireAuthentication();
      return {
        schema: 1 as const,
        ok: true as const,
        source_id: sourceId,
        deleted: true,
        backlinks: [],
        annotated_files: options?.annotate_backlinks !== false ? [] : undefined,
      };
    },

    async cancelSource(sourceId: string, _reason?: string) {
      requireAuthentication();
      return {
        schema: 1 as const,
        ok: true as const,
        source_id: sourceId,
        cancelled: true,
        cancelled_jobs: ["job_mock_cancelled"],
      };
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
    async approveMigration(
      id: string,
      revisionId: string,
      _patchHash?: string,
    ) {
      return {
        ok: true,
        migration_id: id,
        revision_id: revisionId,
        state: "applied",
      };
    },
    async recoverMigration(id: string, action?: string) {
      return {
        ok: true,
        migration_id: id,
        state: "ready_for_review",
        recovery: { action },
      };
    },
    async retryMigrationJobs(id: string) {
      return { ok: true, migration_id: id, state: "processing" };
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
    async loadCronJobs(): Promise<CronOverviewResponse> {
      return {
        schema: 1,
        jobs: [
          {
            id: "openlia-workspace-git",
            name: "openlia-workspace-git",
            prompt:
              "Run the workspace-git skill to review workspace changes and create appropriate structured Git commits for each changed area. If there are no changes, make no commit.",
            schedule: {
              kind: "cron",
              expr: "0 4 * * *",
              display: "0 4 * * *",
            },
            skills: ["workspace-git"],
            state: "scheduled",
            created_at: "2026-10-01T04:00:00Z",
            updated_at: "2026-10-01T04:00:00Z",
          },
          {
            id: "daily-briefing-sample",
            name: "Morning Briefing",
            prompt: "Run /daily-briefing within assistant-policy.yaml",
            schedule: {
              kind: "cron",
              expr: "0 9 * * *",
              display: "0 9 * * *",
            },
            skills: ["daily-briefing"],
            state: "paused",
            created_at: "2026-10-10T09:00:00Z",
            updated_at: "2026-10-10T09:00:00Z",
          },
        ],
        system: {
          backup: {
            schedule: "20 4 * * *",
            enabled: true,
            timezone: "Asia/Ho_Chi_Minh",
          },
          workspace_git: {
            schedule: "0 4 * * *",
            job_found: true,
          },
        },
        policy: {
          enabled: true,
          allowed_actions: ["generate_reports"],
          report_destination: "inbox/daily-briefing",
        },
      };
    },
    async createCronJob(input: CreateCronJobInput) {
      const newJob: HermesCronJob = {
        id: `mock-${Date.now()}`,
        name: input.name,
        prompt: input.prompt,
        schedule: {
          kind: "cron",
          expr: input.schedule,
          display: input.schedule,
        },
        skills: input.skills ?? [],
        state: input.paused ? "paused" : "scheduled",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return { schema: 1, ok: true as const, job: newJob };
    },
    async updateCronJob(id: string, input: UpdateCronJobInput) {
      const job: HermesCronJob = {
        id,
        name: input.name ?? "Updated Job",
        prompt: input.prompt ?? "Updated Prompt",
        schedule: {
          kind: "cron",
          expr: input.schedule ?? "0 0 * * *",
          display: input.schedule ?? "0 0 * * *",
        },
        skills: input.skills ?? [],
        state: input.state ?? "scheduled",
        updated_at: new Date().toISOString(),
      };
      return { schema: 1, ok: true as const, job };
    },
    async toggleCronJob(id: string, paused?: boolean) {
      const job: HermesCronJob = {
        id,
        name: "Toggled Job",
        prompt: "Prompt",
        schedule: "0 4 * * *",
        state: paused ? "paused" : "scheduled",
        updated_at: new Date().toISOString(),
      };
      return { schema: 1, ok: true as const, job };
    },
    async deleteCronJob(id: string) {
      return { schema: 1, ok: true as const, id };
    },
    async listShares(filter): Promise<ShareListResponse> {
      requireAuthentication();
      const targetFilter = filter?.targetPath?.replace(/^\/+/, "");
      const filtered = mockShares.filter((s) => {
        if (filter?.kind && s.kind !== filter.kind) return false;
        if (targetFilter && s.target_path !== targetFilter) return false;
        return true;
      });
      return {
        schema: 1,
        ok: true,
        shares: filtered.map(toMockShareSummary),
      };
    },
    async createShare(req: ShareCreateRequest): Promise<ShareMutationResponse> {
      requireAuthentication();
      const preset: ShareExpirationPreset = req.expires_in ?? "30d";
      const captured = captureMockShareData(req.kind, req.target_path);
      const nowIso = new Date().toISOString();
      const id = `mockshare_${String(++mockShareSeq).padStart(22, "0")}`;
      const stored: MockStoredShare = {
        id,
        kind: req.kind,
        target_path: req.target_path.replace(/^\/+/, ""),
        title: captured.title,
        created_at: nowIso,
        updated_at: nowIso,
        expires_at: computeMockExpiresAt(preset),
        expiration_preset: preset,
        snapshot_revision: captured.snapshot_revision,
        media_type: captured.media_type,
        skill_metadata: captured.skill_metadata,
        files: captured.files,
      };
      mockShares.unshift(stored);
      return {
        schema: 1,
        ok: true,
        share: toMockShareSummary(stored),
      };
    },
    async updateShare(
      id: string,
      req: ShareUpdateRequest,
    ): Promise<ShareMutationResponse> {
      requireAuthentication();
      const found = mockShares.find((s) => s.id === id);
      if (!found) throw error(404, "share_not_found");
      if (req.action === "sync") {
        const captured = captureMockShareData(found.kind, found.target_path);
        found.title = captured.title;
        found.snapshot_revision = captured.snapshot_revision;
        found.media_type = captured.media_type;
        found.skill_metadata = captured.skill_metadata;
        found.files = captured.files;
      }
      if (req.expires_in) {
        found.expiration_preset = req.expires_in;
        found.expires_at = computeMockExpiresAt(req.expires_in);
      }
      found.updated_at = new Date().toISOString();
      return {
        schema: 1,
        ok: true,
        share: toMockShareSummary(found),
      };
    },
    async syncShare(
      id: string,
      expiresIn?: ShareExpirationPreset,
    ): Promise<ShareMutationResponse> {
      requireAuthentication();
      const found = mockShares.find((s) => s.id === id);
      if (!found) throw error(404, "share_not_found");
      const captured = captureMockShareData(found.kind, found.target_path);
      found.title = captured.title;
      found.snapshot_revision = captured.snapshot_revision;
      found.media_type = captured.media_type;
      found.skill_metadata = captured.skill_metadata;
      found.files = captured.files;
      if (expiresIn) {
        found.expiration_preset = expiresIn;
        found.expires_at = computeMockExpiresAt(expiresIn);
      }
      found.updated_at = new Date().toISOString();
      return {
        schema: 1,
        ok: true,
        share: toMockShareSummary(found),
      };
    },
    async deleteShare(id: string): Promise<ShareDeleteResponse> {
      requireAuthentication();
      const idx = mockShares.findIndex((s) => s.id === id);
      if (idx < 0) throw error(404, "share_not_found");
      mockShares.splice(idx, 1);
      return { schema: 1, ok: true, id };
    },
    async getPublicShare(id: string): Promise<PublicShareResponse> {
      const found = mockShares.find((s) => s.id === id);
      if (!found) throw error(404, "share_not_found");
      const primary =
        found.kind === "workspace"
          ? (found.files.find((f) => f.path === found.target_path) ??
            found.files[0])
          : (found.files.find((f) => f.path === "SKILL.md") ?? found.files[0]);
      const totalBytes = found.files.reduce((acc, f) => acc + f.size, 0);
      return {
        schema: 1,
        ok: true,
        share: {
          id: found.id,
          kind: found.kind,
          target_path: found.target_path,
          title: found.title,
          created_at: found.created_at,
          updated_at: found.updated_at,
          expires_at: found.expires_at,
          expiration_preset: found.expiration_preset,
          snapshot_revision: found.snapshot_revision,
          file_count: found.files.length,
          total_bytes: totalBytes,
          media_type: found.media_type,
          editable: primary ? primary.editable : true,
          ...(primary?.content !== undefined
            ? { content: primary.content }
            : {}),
          ...(found.skill_metadata
            ? { skill_metadata: found.skill_metadata }
            : {}),
          files: found.files,
        },
      };
    },
    publicShareRawUrl: (id: string, filePath?: string) => {
      const q = filePath
        ? `?${new URLSearchParams({ path: filePath }).toString()}`
        : "";
      return `/api/public/share/${encodeURIComponent(id)}/raw${q}`;
    },
    publicShareDownloadUrl: (id: string, filePath?: string) => {
      const q = filePath
        ? `?${new URLSearchParams({ path: filePath }).toString()}`
        : "";
      return `/api/public/share/${encodeURIComponent(id)}/download${q}`;
    },
    publicShareSkillDownloadUrl: (id: string) =>
      `/api/public/share/skill/${encodeURIComponent(id)}/download`,
    async loadMaintainerOverview(): Promise<MaintainerOverviewResponse> {
      requireAuthentication();
      return {
        schema: 1,
        workspace_id: "ws_mock",
        counts: {
          open: 0,
          ignored: 0,
          resolved: 0,
          suggestions: 0,
          collections: 3,
        },
        scan_state: {
          workspace_id: "ws_mock",
          last_scan_at: new Date().toISOString(),
          coverage_status: "complete",
          files_scanned: 5,
          files_skipped: 0,
          scan_errors: [],
        },
        collections: [
          {
            path: "tasks",
            label: "Tasks",
            kind: "core",
            template_path: "tasks/task-template.md",
            inferred_purpose: "Concrete actions that can be completed.",
            record_count: 1,
            open_finding_count: 0,
            ignored_finding_count: 0,
          },
        ],
        open_findings: [],
        ignored_findings: [],
        resolved_findings: [],
        suggestions: [],
      };
    },
    async runMaintainerAudit(): Promise<MaintainerOverviewResponse> {
      return this.loadMaintainerOverview();
    },
    async ignoreMaintainerIssue(issueId: string, _reason?: string) {
      requireAuthentication();
      return {
        schema: 1 as const,
        ok: true as const,
        issue_id: issueId,
        state: "ignored" as const,
        finding: null,
      };
    },
    async restoreMaintainerIssue(issueId: string) {
      requireAuthentication();
      const dummy: MaintainerFinding = {
        issue_id: issueId,
        workspace_id: "ws_mock",
        relative_path: "tasks/example.md",
        rule_code: "WM-TEMPLATE-SECTION-MISSING",
        severity: "warning",
        category: "contract",
        subject: "Notes",
        message: "Missing template section: ## Notes",
        explanation: "Record is missing ## Notes",
        contract_fingerprint: "cfp_mock",
        fix_strategy: "deterministic",
        state: "open",
        present: true,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        last_checked_revision: "sha256:mock",
      };
      return {
        schema: 1 as const,
        ok: true as const,
        issue_id: issueId,
        state: "open" as const,
        finding: dummy,
      };
    },
    async previewMaintainerFix(
      issueId: string,
    ): Promise<MaintainerFixPreviewResponse> {
      requireAuthentication();
      return {
        schema: 1,
        issue_id: issueId,
        path: "tasks/example.md",
        rule_code: "WM-TEMPLATE-SECTION-MISSING",
        subject: "Notes",
        fix_strategy: "deterministic",
        deterministically_fixable: true,
        current_revision: "sha256:mock",
        before_content: "# Example\n",
        after_content: "# Example\n\n## Notes\n",
        summary: "Append missing section '## Notes'",
        agent_prompt: "Fix missing Notes section in tasks/example.md",
      };
    },
    async applyMaintainerFix(
      issueId: string,
      expectedRevision: string,
    ): Promise<MaintainerFixApplyResponse> {
      requireAuthentication();
      return {
        schema: 1,
        ok: true,
        issue_id: issueId,
        path: "tasks/example.md",
        before_revision: expectedRevision,
        after_revision: "sha256:mock-after",
        summary: "Append missing section '## Notes'",
        finding: null,
        file_findings: [],
      };
    },
    async loadPermissions(): Promise<ConsequentialPermissionsResponse> {
      requireAuthentication();
      return {
        schema: 1,
        version: 1,
        permissions: {
          destructive: {
            delete_records: "ask",
            overwrite_records: "ask",
          },
          external: {
            send_messages: "ask",
            make_purchases: "deny",
            modify_external_accounts: "deny",
            ingest_external_content: "allow",
          },
          scheduled_work: {
            run_briefings: "allow",
            run_audits: "allow",
            run_monitors: "allow",
          },
        },
      };
    },
    async updatePermissions(
      permissions: ConsequentialPermissionsResponse["permissions"],
    ): Promise<ConsequentialPermissionsResponse> {
      requireAuthentication();
      return {
        schema: 1,
        version: 1,
        permissions,
      };
    },
  };
}

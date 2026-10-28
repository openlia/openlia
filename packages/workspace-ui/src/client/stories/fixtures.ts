import { fn } from "storybook/test";
import type {
  MaintainerFinding,
  WorkspaceFile,
  WorkspaceDomainRecordSummary,
} from "../../shared/api";
import type { CalendarEvent } from "../../shared/calendar";
import type { ChatMessage } from "../../shared/chat";
import { ApiError, type WorkspaceApi } from "../api";
import { createMockWorkspaceApi } from "../mockApi";

export const action = (name: string) => fn().mockName(name);
export const markdown =
  "# Project review\n\nA small **local-first** workspace.\n\n## Next steps\n- [x] Review the calendar\n- [ ] Collect feedback\n\n| View | Status |\n| --- | --- |\n| Month | Ready |\n| Week | Ready |\n\n```ts\nconst localOnly = true;\n```\n";
export const file: WorkspaceFile = {
  schema: 1,
  path: "projects/review.md",
  content: markdown,
  size: markdown.length,
  revision: "sha256:storybook",
  modified_at: "2026-10-27T09:00:00Z",
  editable: true,
  validation: { valid: true, errors: [] },
};
const recordFields = {
  sections: ["Next steps"],
  excerpt: "Review the project.",
  revision: "sha256:storybook",
  size: 120,
  modified_at: "2026-10-27T09:00:00Z",
};
export const records: WorkspaceDomainRecordSummary[] = [
  {
    ...recordFields,
    path: "tasks/review.md",
    filename: "review.md",
    title: "Review calendar",
    frontmatter: { status: "todo", priority: "high", due: "2026-10-27" },
  },
  {
    ...recordFields,
    path: "tasks/tests.md",
    filename: "tests.md",
    title: "Verify browser journey",
    frontmatter: { status: "in-progress", priority: "medium" },
  },
  {
    ...recordFields,
    path: "tasks/ship.md",
    filename: "ship.md",
    title: "Publish components",
    frontmatter: { status: "done", priority: "low" },
  },
];

const event = (
  id: string,
  title: string,
  start: string,
  end: string,
  rest: Partial<CalendarEvent> = {},
): CalendarEvent => ({
  id,
  occurrenceId: `${id}:${start}`,
  title,
  start,
  end,
  allDay: false,
  timezone: "UTC",
  sourcePath: "calendar/reminders.rem",
  sourceLine: 1,
  notifications: "off",
  agenda: "Review scope, decisions, and next steps.",
  attendees: ["Alex", "Sam"],
  location: "Studio",
  ...rest,
});
export const primaryCalendarEvent = event(
  "review",
  "Design review",
  "2026-10-27T09:00:00Z",
  "2026-10-27T10:30:00Z",
);
export const calendarEvents: CalendarEvent[] = [
  primaryCalendarEvent,
  event(
    "overlap",
    "Client check-in",
    "2026-10-27T09:30:00Z",
    "2026-10-27T10:00:00Z",
    { location: "Remote" },
  ),
  event("trip", "Conference", "2026-10-26", "2026-10-29", { allDay: true }),
  event(
    "overnight",
    "Overnight support",
    "2026-10-28T23:30:00Z",
    "2026-10-29T01:00:00Z",
  ),
  ...Array.from({ length: 4 }, (_, i) =>
    event(
      `extra-${i}`,
      `Follow-up ${i + 1}`,
      `2026-10-27T${12 + i}:00:00Z`,
      `2026-10-27T${13 + i}:00:00Z`,
    ),
  ),
];
export const chatMessages: ChatMessage[] = [
  { id: 1, role: "user", content: "Help me review the Calendar UI." },
  {
    id: 2,
    role: "assistant",
    content: "I’ll inspect the project notes.",
    tool_calls: [{ id: "read-1" }],
  },
  {
    id: 3,
    role: "tool",
    tool_name: "read_file",
    content: "Month, Week, and Timeline components are available.",
  },
  {
    id: 4,
    role: "assistant",
    content:
      "## Review checklist\n\n- Verify explicit timezones.\n- Confirm notifications are off.\n- Reopen a saved appointment.",
  },
];
export const finding: MaintainerFinding = {
  issue_id: "storybook-finding",
  workspace_id: "ws_storybook",
  relative_path: file.path,
  rule_code: "record.required",
  severity: "warning",
  category: "contract",
  subject: "status",
  message: "Required status field is missing.",
  explanation: "The local template requires a status field.",
  contract_path: "projects/item-template.md",
  contract_fingerprint: "fixture",
  fix_strategy: "deterministic",
  state: "open",
  present: true,
  first_seen_at: "2026-10-27T09:00:00Z",
  last_seen_at: "2026-10-27T09:00:00Z",
  last_checked_revision: file.revision,
};

export function createStoryApi(
  calendarState: "populated" | "empty" | "loading" | "error" = "populated",
): WorkspaceApi {
  const api = createMockWorkspaceApi({ files: { [file.path]: markdown } });
  let events = calendarState === "empty" ? [] : structuredClone(calendarEvents);
  let version = 0;
  const response = () => ({
    schema: 1 as const,
    events: structuredClone(events),
    revision: `sha256:story-${version}`,
    timezone: "UTC",
  });
  api.loadCalendar = fn(async () => {
    if (calendarState === "loading") return new Promise<never>(() => {});
    if (calendarState === "error")
      throw new ApiError(503, {
        schema: 1,
        ok: false,
        error: "calendar_unavailable",
      });
    return response();
  });
  api.createCalendarEvent = fn(async (input) => {
    if (input.expectedRevision !== `sha256:story-${version}`)
      throw new ApiError(409, {
        schema: 1,
        ok: false,
        error: "revision_conflict",
      });
    events = [
      ...events,
      event(
        `openlia-ui-${input.requestId}`,
        input.title,
        input.start,
        input.end,
        {
          timezone: input.timezone,
          agenda: input.agenda,
          attendees: input.attendees,
          location: input.location,
        },
      ),
    ];
    version++;
    return response();
  });
  const textUrl = (path: string) =>
    `data:text/plain;charset=utf-8,${encodeURIComponent(`Storybook fixture: ${path}\n${markdown}`)}`;
  api.rawUrl = textUrl;
  api.downloadUrl = textUrl;
  api.publicShareRawUrl = (_id, path) => textUrl(path ?? file.path);
  api.publicShareDownloadUrl = (_id, path) => textUrl(path ?? file.path);
  api.publicShareSkillDownloadUrl = (id) => textUrl(id);
  api.previewMaintainerFix = fn(async () => ({
    schema: 1 as const,
    issue_id: finding.issue_id,
    path: file.path,
    rule_code: finding.rule_code,
    subject: "status",
    fix_strategy: "deterministic" as const,
    deterministically_fixable: true,
    current_revision: file.revision,
    before_content: markdown,
    after_content: `---\nstatus: todo\n---\n${markdown}`,
    summary: "Add the required status field",
    agent_prompt: "",
  }));
  return api;
}

/** A new in-memory workspace for every story render, never a singleton backend. */
export async function loadStoryData() {
  const api = createStoryApi();
  const [
    tree,
    activity,
    diagnostics,
    git,
    settings,
    systemInfo,
    skills,
    ingestion,
    sourceSearch,
    source,
    migrations,
    migrationDetail,
  ] = await Promise.all([
    api.loadTree(),
    api.loadActivity(),
    api.loadDiagnostics(),
    api.loadGitStatus(),
    api.loadSettings(),
    api.loadSystemInfo(),
    api.loadSkills(),
    api.loadIngestion(),
    api.searchSources(),
    api.loadSource("src_mock"),
    api.loadMigrations(),
    api.loadMigrationDetail("mig-mock-1"),
  ]);
  const skillId = skills.skills[0]?.id ?? "";
  const sourceItem = sourceSearch.matches[0];
  if (!sourceItem) throw new Error("Storybook source fixture is missing");
  const skill = (await api.loadSkillDetail(skillId)).skill;
  const skillFile = await api.loadSkillFile(skillId, "SKILL.md");
  const share = (
    await api.createShare({
      kind: "workspace",
      target_path: file.path,
      expires_in: "7d",
    })
  ).share;
  return {
    api,
    tree,
    activity,
    diagnostics,
    git,
    settings,
    systemInfo,
    skills,
    skill,
    skillFile,
    ingestion,
    sourceSearch,
    sourceItem,
    source,
    migrations,
    migrationDetail,
    share,
  };
}
export type StoryData = Awaited<ReturnType<typeof loadStoryData>>;
export const storyLoader = async () => ({ story: await loadStoryData() });
export const storyData = (loaded: Record<string, unknown>) =>
  loaded.story as StoryData;

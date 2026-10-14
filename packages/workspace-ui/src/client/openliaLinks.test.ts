import { describe, expect, test } from "vitest";
import type { SkillSummary, WorkspaceTreeEntry } from "../shared/api";
import {
  buildCanonicalSkillUri,
  buildCanonicalWorkspaceUri,
  buildSkillLink,
  buildWorkspaceLink,
  copyToClipboard,
  filterGoToSuggestions,
  parseSkillRemainder,
  resolveLinkTarget,
  resolveRelativePath,
} from "./openliaLinks";

const mockSkills: SkillSummary[] = [
  {
    bundled: true,
    category: "",
    description: "Conduct a weekly review of projects and goals",
    enabled: true,
    fileCount: 1,
    id: "weekly-review",
    name: "weekly-review",
    pinned: true,
    tags: [],
    useCount: 0,
  },
  {
    bundled: true,
    category: "",
    description: "Exhaustive multi-source research investigation",
    enabled: true,
    fileCount: 1,
    id: "deep-research",
    name: "deep-research",
    pinned: false,
    tags: [],
    useCount: 0,
  },
  {
    bundled: false,
    category: "productivity",
    description: "Notion integration",
    enabled: true,
    fileCount: 1,
    id: "productivity/notion",
    name: "notion",
    pinned: false,
    tags: [],
    useCount: 0,
  },
];

const mockTree: WorkspaceTreeEntry[] = [
  {
    editable: true,
    kind: "file",
    modified_at: "2026-09-22T00:00:00Z",
    path: "goals/career.md",
    size: 100,
  },
  {
    editable: true,
    kind: "file",
    modified_at: "2026-09-22T00:00:00Z",
    path: "projects/website.md",
    size: 100,
  },
  {
    editable: true,
    kind: "file",
    modified_at: "2026-09-22T00:00:00Z",
    path: "inbox/2026-09-note.md",
    size: 100,
  },
  {
    editable: true,
    kind: "file",
    modified_at: "2026-09-22T00:00:00Z",
    path: "calendar/lunch meeting.md",
    size: 100,
  },
  { kind: "directory", path: "projects" },
];

describe("parseSkillRemainder", () => {
  test("parses standalone skill without file", () => {
    const res = parseSkillRemainder("weekly-review", ["weekly-review"]);
    expect(res).toEqual({ skillId: "weekly-review", skillFile: undefined });
  });

  test("parses standalone skill with file", () => {
    const res = parseSkillRemainder("weekly-review/templates/review.md", [
      "weekly-review",
    ]);
    expect(res).toEqual({
      skillId: "weekly-review",
      skillFile: "templates/review.md",
    });
  });

  test("parses categorized skill without file", () => {
    const res = parseSkillRemainder("productivity/notion", [
      "productivity/notion",
    ]);
    expect(res).toEqual({
      skillId: "productivity/notion",
      skillFile: undefined,
    });
  });

  test("parses categorized skill with file", () => {
    const res = parseSkillRemainder("productivity/notion/references/guide.md", [
      "productivity/notion",
    ]);
    expect(res).toEqual({
      skillId: "productivity/notion",
      skillFile: "references/guide.md",
    });
  });

  test("falls back to heuristic when not in known skills", () => {
    expect(parseSkillRemainder("custom-skill")).toEqual({
      skillId: "custom-skill",
      skillFile: undefined,
    });
    expect(parseSkillRemainder("custom-skill/SKILL.md")).toEqual({
      skillId: "custom-skill",
      skillFile: "SKILL.md",
    });
    expect(parseSkillRemainder("cat/my-skill")).toEqual({
      skillId: "cat/my-skill",
      skillFile: undefined,
    });
    expect(parseSkillRemainder("cat/my-skill/SKILL.md")).toEqual({
      skillId: "cat/my-skill",
      skillFile: "SKILL.md",
    });
  });
});

describe("resolveLinkTarget", () => {
  test("resolves openlia://workspace/<path>", () => {
    const res = resolveLinkTarget("openlia://workspace/projects/website.md", {
      skills: mockSkills,
      tree: mockTree,
    });
    expect(res).toEqual({
      exists: true,
      kind: "workspace",
      label: "projects/website.md",
      path: "projects/website.md",
    });
  });

  test("resolves openlia://workspace/<path> with url encoding and leading slashes", () => {
    const res = resolveLinkTarget(
      "openlia://workspace///calendar/lunch%20meeting.md",
      {
        skills: mockSkills,
        tree: mockTree,
      },
    );
    expect(res).toEqual({
      exists: true,
      kind: "workspace",
      label: "calendar/lunch meeting.md",
      path: "calendar/lunch meeting.md",
    });
  });

  test("resolves unknown workspace path with exists=false", () => {
    const res = resolveLinkTarget("openlia://workspace/notes/nonexistent.md", {
      skills: mockSkills,
      tree: mockTree,
    });
    expect(res).toEqual({
      exists: false,
      kind: "workspace",
      label: "notes/nonexistent.md",
      path: "notes/nonexistent.md",
    });
  });

  test("resolves openlia://skills/<skill-id>", () => {
    const res = resolveLinkTarget("openlia://skills/weekly-review", {
      skills: mockSkills,
      tree: mockTree,
    });
    expect(res).toEqual({
      exists: true,
      kind: "skill",
      label: "weekly-review",
      skillFile: undefined,
      skillId: "weekly-review",
    });
  });

  test("resolves openlia://skills/<skill-id>/<file>", () => {
    const res = resolveLinkTarget(
      "openlia://skills/weekly-review/templates/weekly-review.md",
      {
        skills: mockSkills,
        tree: mockTree,
      },
    );
    expect(res).toEqual({
      exists: true,
      kind: "skill",
      label: "weekly-review (templates/weekly-review.md)",
      skillFile: "templates/weekly-review.md",
      skillId: "weekly-review",
    });
  });

  test("resolves openlia://skills/<category>/<name> for categorized skills", () => {
    const res = resolveLinkTarget(
      "openlia://skills/productivity/notion/references/guide.md",
      {
        skills: mockSkills,
        tree: mockTree,
      },
    );
    expect(res).toEqual({
      exists: true,
      kind: "skill",
      label: "productivity/notion (references/guide.md)",
      skillFile: "references/guide.md",
      skillId: "productivity/notion",
    });
  });

  test("resolves query params in openlia://skills", () => {
    const res = resolveLinkTarget(
      "openlia://skills/weekly-review?skillFile=scripts/review.py",
      {
        skills: mockSkills,
        tree: mockTree,
      },
    );
    expect(res).toEqual({
      exists: true,
      kind: "skill",
      label: "weekly-review (scripts/review.py)",
      skillFile: "scripts/review.py",
      skillId: "weekly-review",
    });
  });

  test("resolves openlia://source/<id> and openlia://sources/<id>", () => {
    const res = resolveLinkTarget("openlia://source/src_abc123");
    expect(res).toEqual({
      exists: true,
      kind: "ingestion",
      sourceId: "src_abc123",
      label: "Source / src_abc123",
      versionId: undefined,
      page: undefined,
    });

    const resPage = resolveLinkTarget(
      "openlia://source/src_abc123#ver_001/p2",
    );
    expect(resPage).toEqual({
      exists: true,
      kind: "ingestion",
      sourceId: "src_abc123",
      versionId: "ver_001",
      page: 2,
      label: "Source / src_abc123 (p. 2)",
    });

    const resPlural = resolveLinkTarget("openlia://sources/src_xyz789");
    expect(resPlural).toEqual({
      exists: true,
      kind: "ingestion",
      sourceId: "src_xyz789",
      label: "Source / src_xyz789",
      versionId: undefined,
      page: undefined,
    });

    const resPath = resolveLinkTarget("/ingestion/src_abc123");
    expect(resPath).toEqual({
      exists: true,
      kind: "ingestion",
      sourceId: "src_abc123",
      label: "Source / src_abc123",
    });
  });

  test("resolveRelativePath calculates normalized target path", () => {
    expect(
      resolveRelativePath("./architecture.md", "projects/website/readme.md"),
    ).toBe("projects/website/architecture.md");
    expect(
      resolveRelativePath("../roadmap.md", "projects/website/readme.md"),
    ).toBe("projects/roadmap.md");
    expect(
      resolveRelativePath("../../tasks.md", "projects/website/specs/api.md"),
    ).toBe("projects/tasks.md");
    expect(resolveRelativePath("./inbox.md", "root.md")).toBe("inbox.md");
  });

  test("resolves relative paths with currentFilePath context", () => {
    const res = resolveLinkTarget("./architecture.md", {
      currentFilePath: "projects/website/readme.md",
      tree: [
        ...mockTree,
        {
          kind: "file",
          path: "projects/website/architecture.md",
          editable: true,
          modified_at: "2026-09-22T00:00:00Z",
          size: 100,
        },
      ],
    });
    expect(res).toEqual({
      exists: true,
      kind: "workspace",
      label: "projects/website/architecture.md",
      path: "projects/website/architecture.md",
    });

    const resParent = resolveLinkTarget("../website.md", {
      currentFilePath: "projects/archive/old.md",
      tree: mockTree,
    });
    expect(resParent).toEqual({
      exists: true,
      kind: "workspace",
      label: "projects/website.md",
      path: "projects/website.md",
    });
  });

  test("resolves web routes /files/<path> and /skills/<path>", () => {
    expect(
      resolveLinkTarget("/files/projects/website.md", { tree: mockTree }),
    ).toEqual({
      exists: true,
      kind: "workspace",
      label: "projects/website.md",
      path: "projects/website.md",
    });

    expect(
      resolveLinkTarget(
        "http://localhost:3000/skills/weekly-review?skillFile=SKILL.md",
        {
          skills: mockSkills,
        },
      ),
    ).toEqual({
      exists: true,
      kind: "skill",
      label: "weekly-review (SKILL.md)",
      skillFile: "SKILL.md",
      skillId: "weekly-review",
    });
  });

  test("resolves relative path inputs", () => {
    expect(
      resolveLinkTarget("projects/website.md", { tree: mockTree }),
    ).toEqual({
      exists: true,
      kind: "workspace",
      label: "projects/website.md",
      path: "projects/website.md",
    });

    expect(resolveLinkTarget("weekly-review", { skills: mockSkills })).toEqual({
      exists: true,
      kind: "skill",
      label: "weekly-review",
      skillId: "weekly-review",
    });
  });

  test("resolves document target by filename or stem when path is omitted", () => {
    // Exact filename with extension
    expect(resolveLinkTarget("website.md", { tree: mockTree })).toEqual({
      exists: true,
      kind: "workspace",
      label: "projects/website.md",
      path: "projects/website.md",
    });
    expect(resolveLinkTarget("career.md", { tree: mockTree })).toEqual({
      exists: true,
      kind: "workspace",
      label: "goals/career.md",
      path: "goals/career.md",
    });

    // Stem without extension
    expect(resolveLinkTarget("website", { tree: mockTree })).toEqual({
      exists: true,
      kind: "workspace",
      label: "projects/website.md",
      path: "projects/website.md",
    });
    expect(resolveLinkTarget("career", { tree: mockTree })).toEqual({
      exists: true,
      kind: "workspace",
      label: "goals/career.md",
      path: "goals/career.md",
    });

    // Path without extension
    expect(resolveLinkTarget("projects/website", { tree: mockTree })).toEqual({
      exists: true,
      kind: "workspace",
      label: "projects/website.md",
      path: "projects/website.md",
    });

    // Unprefixed files/ path
    expect(
      resolveLinkTarget("files/projects/website.md", { tree: mockTree }),
    ).toEqual({
      exists: true,
      kind: "workspace",
      label: "projects/website.md",
      path: "projects/website.md",
    });

    // Query parameter path
    expect(
      resolveLinkTarget("/?path=projects/website.md", { tree: mockTree }),
    ).toEqual({
      exists: true,
      kind: "workspace",
      label: "projects/website.md",
      path: "projects/website.md",
    });
    expect(
      resolveLinkTarget(
        "https://workspace.example.com/?path=projects/website.md",
        { tree: mockTree },
      ),
    ).toEqual({
      exists: true,
      kind: "workspace",
      label: "projects/website.md",
      path: "projects/website.md",
    });
  });

  test("returns null for arbitrary search terms without extension or slash that do not match", () => {
    expect(
      resolveLinkTarget("randomnonexistentquery", {
        skills: mockSkills,
        tree: mockTree,
      }),
    ).toBeNull();
  });
});

describe("filterGoToSuggestions", () => {
  test("returns default suggestions when query is empty", () => {
    const suggestions = filterGoToSuggestions("", {
      skills: mockSkills,
      tree: mockTree,
    });
    expect(suggestions.length).toBeGreaterThan(0);
    // Pinned skill should appear first
    expect(suggestions[0]?.title).toBe("weekly-review");
  });

  test("filters suggestions matching document names and skill names", () => {
    const docMatches = filterGoToSuggestions("website", {
      skills: mockSkills,
      tree: mockTree,
    });
    expect(docMatches).toHaveLength(1);
    expect(docMatches[0]?.title).toBe("projects/website.md");
    expect(docMatches[0]?.kind).toBe("workspace");

    const skillMatches = filterGoToSuggestions("research", {
      skills: mockSkills,
      tree: mockTree,
    });
    expect(skillMatches).toHaveLength(1);
    expect(skillMatches[0]?.title).toBe("deep-research");
    expect(skillMatches[0]?.kind).toBe("skill");
  });
});

describe("buildCanonicalWorkspaceUri and buildCanonicalSkillUri", () => {
  test("buildCanonicalWorkspaceUri formats canonical openlia://workspace/... URIs", () => {
    expect(buildCanonicalWorkspaceUri("tasks.md")).toBe(
      "openlia://workspace/tasks.md",
    );
    expect(buildCanonicalWorkspaceUri("/projects/roadmap.md")).toBe(
      "openlia://workspace/projects/roadmap.md",
    );
    expect(buildCanonicalWorkspaceUri("///nested/doc.txt")).toBe(
      "openlia://workspace/nested/doc.txt",
    );
  });

  test("buildCanonicalSkillUri formats canonical openlia://skills/... URIs", () => {
    expect(buildCanonicalSkillUri("inbox-triage")).toBe(
      "openlia://skills/inbox-triage",
    );
    expect(buildCanonicalSkillUri("/system/developer/")).toBe(
      "openlia://skills/system/developer",
    );
    expect(
      buildCanonicalSkillUri("weekly-review", "templates/weekly-review.md"),
    ).toBe("openlia://skills/weekly-review/templates/weekly-review.md");
    expect(buildCanonicalSkillUri("agent-browser", "/scripts/run.sh")).toBe(
      "openlia://skills/agent-browser/scripts/run.sh",
    );
  });
});

describe("buildWorkspaceLink and buildSkillLink", () => {
  test("buildWorkspaceLink normalizes path and formats as web URL", () => {
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "";
    expect(buildWorkspaceLink("tasks.md")).toBe(`${origin}/files/tasks.md`);
    expect(buildWorkspaceLink("/projects/roadmap.md")).toBe(
      `${origin}/files/projects/roadmap.md`,
    );
    expect(buildWorkspaceLink("///nested/doc.txt")).toBe(
      `${origin}/files/nested/doc.txt`,
    );
    expect(
      buildWorkspaceLink("tasks.md", "https://workspace.example.com"),
    ).toBe("https://workspace.example.com/files/tasks.md");
    expect(buildWorkspaceLink("tasks.md", "")).toBe("/files/tasks.md");
  });

  test("buildSkillLink formats skill link and optional skill file as web URL", () => {
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "";
    expect(buildSkillLink("agent-browser")).toBe(
      `${origin}/skills/agent-browser`,
    );
    expect(buildSkillLink("/system/developer/")).toBe(
      `${origin}/skills/system/developer`,
    );
    expect(buildSkillLink("agent-browser", "templates/example.md")).toBe(
      `${origin}/skills/agent-browser/templates/example.md`,
    );
    expect(buildSkillLink("agent-browser", "/scripts/run.sh")).toBe(
      `${origin}/skills/agent-browser/scripts/run.sh`,
    );
    expect(
      buildSkillLink(
        "agent-browser",
        "templates/example.md",
        "https://workspace.example.com",
      ),
    ).toBe(
      "https://workspace.example.com/skills/agent-browser/templates/example.md",
    );
    expect(buildSkillLink("agent-browser", undefined, "")).toBe(
      "/skills/agent-browser",
    );
  });
});

describe("copyToClipboard", () => {
  test("uses navigator.clipboard.writeText when available", async () => {
    let copiedText = "";
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copiedText = text;
        },
      },
    });

    try {
      const result = await copyToClipboard("openlia://workspace/test.md");
      expect(result).toBe(true);
      expect(copiedText).toBe("openlia://workspace/test.md");
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  test("falls back to document.execCommand when navigator.clipboard is unavailable", async () => {
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });

    let executedCommand = "";
    const originalExecCommand = document.execCommand;
    document.execCommand = (command: string) => {
      executedCommand = command;
      return true;
    };

    try {
      const result = await copyToClipboard("openlia://skills/my-skill");
      expect(result).toBe(true);
      expect(executedCommand).toBe("copy");
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
      document.execCommand = originalExecCommand;
    }
  });
});

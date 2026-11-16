import { describe, expect, it } from "vitest";
import type { WorkspaceTreeEntry } from "../shared/api";
import { resolveWorkspaceImageSrc } from "./components/editor/MarkdownPreview";
import {
  buildCanonicalDocumentUri,
  buildDocumentLink,
  resolveLinkTarget,
} from "./openliaLinks";

const workspaceTree: WorkspaceTreeEntry[] = [
  { editable: true, kind: "file", path: "weather/SKILL.md" },
  { editable: true, kind: "file", path: "notes/start.md" },
];

const skillsTree: WorkspaceTreeEntry[] = [
  {
    editable: true,
    kind: "file",
    path: "weather/SKILL.md",
    scope: "skills",
  },
  {
    editable: true,
    kind: "file",
    path: "weather/helpers.md",
    scope: "skills",
  },
];

describe("scoped workspace links", () => {
  it("resolves explicit skill and workspace URIs against their own trees", () => {
    expect(
      resolveLinkTarget("openlia://skills/weather/SKILL.md", {
        skillsTree,
        tree: workspaceTree,
      }),
    ).toMatchObject({
      exists: true,
      kind: "skills",
      path: "weather/SKILL.md",
      scope: "skills",
    });

    expect(
      resolveLinkTarget("openlia://workspace/weather/SKILL.md", {
        skillsTree,
        tree: workspaceTree,
      }),
    ).toMatchObject({
      exists: true,
      kind: "workspace",
      path: "weather/SKILL.md",
      scope: "workspace",
    });
  });

  it("keeps relative links in the current skills scope", () => {
    expect(
      resolveLinkTarget("./helpers.md", {
        currentFilePath: "weather/SKILL.md",
        currentScope: "skills",
        skillsTree,
        tree: workspaceTree,
      }),
    ).toMatchObject({
      exists: true,
      kind: "skills",
      path: "weather/helpers.md",
      scope: "skills",
    });
  });

  it("builds skill web and canonical links", () => {
    expect(
      buildDocumentLink(
        "weather/SKILL.md",
        "skills",
        "https://workspace.example.test/",
      ),
    ).toBe("https://workspace.example.test/skills/weather/SKILL.md");
    expect(buildCanonicalDocumentUri("weather/SKILL.md", "skills")).toBe(
      "openlia://skills/weather/SKILL.md",
    );
  });

  it("loads embedded images from the URI's scope, not the current document scope", () => {
    const rawUrl = (path: string, scope = "workspace") =>
      `/api/${scope}/raw?${new URLSearchParams({ path })}`;

    expect(
      resolveWorkspaceImageSrc(
        "openlia://skills/weather/chart.png",
        "notes/readme.md",
        rawUrl,
        "workspace",
      ),
    ).toBe("/api/skills/raw?path=weather%2Fchart.png");

    expect(
      resolveWorkspaceImageSrc(
        "../shared/image.png",
        "weather/SKILL.md",
        rawUrl,
        "skills",
      ),
    ).toBe("/api/skills/raw?path=shared%2Fimage.png");
  });
});

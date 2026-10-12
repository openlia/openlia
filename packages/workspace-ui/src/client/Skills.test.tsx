import { act, fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import type { SkillDetail, SkillSummary } from "../shared/api";
import { CreateSkillModal } from "./CreateSkillModal";
import { buildSkillLink } from "./openliaLinks";
import { SkillDetailPane } from "./SkillDetailPane";
import { SkillsNavigator } from "./SkillsNavigator";

describe("SkillsNavigator", () => {
  const sampleSkills: SkillSummary[] = [
    {
      author: "OpenLia Team",
      bundled: false,
      category: "productivity",
      description: "Manage tasks and projects in Notion",
      enabled: true,
      fileCount: 3,
      id: "productivity/notion",
      lastUsedAt: "2026-09-26T10:00:00Z",
      name: "notion",
      pinned: true,
      tags: ["notion", "productivity"],
      useCount: 12,
      version: "1.0.0",
    },
    {
      author: "Security Team",
      bundled: true,
      category: "standalone",
      description: "Conduct an exhaustive research investigation",
      enabled: false,
      fileCount: 1,
      id: "deep-research",
      name: "deep-research",
      pinned: false,
      tags: ["security"],
      useCount: 5,
    },
  ];

  it("renders skills list and categories", () => {
    render(
      <SkillsNavigator
        categories={["productivity", "standalone"]}
        filter=""
        loading={false}
        onCreateClick={vi.fn()}
        onFilterChange={vi.fn()}
        onSelectSkill={vi.fn()}
        onTogglePin={vi.fn()}
        selectedSkillId="productivity/notion"
        skills={sampleSkills}
      />,
    );

    expect(screen.getAllByText("notion").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("deep-research")).toBeDefined();
  });

  it("triggers onSelectSkill when clicked", () => {
    const handleSelect = vi.fn();
    render(
      <SkillsNavigator
        categories={["productivity", "standalone"]}
        filter=""
        loading={false}
        onCreateClick={vi.fn()}
        onFilterChange={vi.fn()}
        onSelectSkill={handleSelect}
        onTogglePin={vi.fn()}
        selectedSkillId={null}
        skills={sampleSkills}
      />,
    );

    const researchSkillBtn = screen.getByText("deep-research");
    fireEvent.click(researchSkillBtn);
    expect(handleSelect).toHaveBeenCalledWith("deep-research");
  });

  it("triggers onTogglePin when pin button clicked", () => {
    const handleTogglePin = vi.fn();
    render(
      <SkillsNavigator
        categories={["productivity", "standalone"]}
        filter=""
        loading={false}
        onCreateClick={vi.fn()}
        onFilterChange={vi.fn()}
        onSelectSkill={vi.fn()}
        onTogglePin={handleTogglePin}
        selectedSkillId={null}
        skills={sampleSkills}
      />,
    );

    const pinBtn = screen.getByLabelText("Unpin skill");
    fireEvent.click(pinBtn);
    expect(handleTogglePin).toHaveBeenCalledWith("productivity/notion", false);
  });
});

describe("SkillDetailPane", () => {
  const sampleDetail: SkillDetail = {
    author: "OpenLia Team",
    bundled: false,
    category: "productivity",
    description: "Manage tasks and projects in Notion",
    enabled: true,
    fileCount: 2,
    files: [
      {
        editable: true,
        modified_at: "2026-09-26T10:00:00Z",
        path: "SKILL.md",
        size: 120,
      },
      {
        editable: true,
        modified_at: "2026-09-26T10:00:00Z",
        path: "scripts/sync.py",
        size: 540,
      },
    ],
    id: "productivity/notion",
    license: "MIT",
    name: "notion",
    pinned: true,
    prerequisites: {
      credential_files: ["~/.notion/token"],
      env_vars: ["NOTION_API_KEY"],
    },
    tags: ["notion", "productivity"],
    useCount: 12,
    version: "1.0.0",
  };

  it("renders detail header and sub-tabs", () => {
    render(
      <SkillDetailPane
        activeSubTab="overview"
        draftContent="# Notion Skill"
        isSaving={false}
        onDraftChange={vi.fn()}
        onResetFile={vi.fn()}
        onSaveFile={vi.fn()}
        onSelectFile={vi.fn()}
        onSubTabChange={vi.fn()}
        onToggleEnable={vi.fn()}
        onTogglePin={vi.fn()}
        onViewChange={vi.fn()}
        selectedFile={null}
        skill={sampleDetail}
        view="preview"
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "notion" }),
    ).toBeDefined();
    expect(screen.getByText("NOTION_API_KEY")).toBeDefined();
    expect(screen.getByText("~/.notion/token")).toBeDefined();
    expect(screen.getByText("Active")).toBeDefined();
  });

  it("switches sub-tabs and edits file content in instructions tab", () => {
    const handleDraftChange = vi.fn();
    const handleSave = vi.fn();
    render(
      <SkillDetailPane
        activeSubTab="instructions"
        draftContent="# Notion Instructions"
        isSaving={false}
        onDraftChange={handleDraftChange}
        onResetFile={vi.fn()}
        onSaveFile={handleSave}
        onSelectFile={vi.fn()}
        onSubTabChange={vi.fn()}
        onToggleEnable={vi.fn()}
        onTogglePin={vi.fn()}
        onViewChange={vi.fn()}
        selectedFile={{
          content: "# Notion Original",
          editable: true,
          id: "productivity/notion",
          modified_at: "2026-09-26T10:00:00Z",
          path: "SKILL.md",
          revision: "rev-1",
          schema: 1,
          size: 120,
        }}
        skill={sampleDetail}
        view="edit"
      />,
    );

    const editor = screen.getByRole("textbox");
    const view = EditorView.findFromDOM(editor);
    if (!view) throw new Error("CodeMirror view was not found");
    act(() => {
      view.dispatch({
        changes: {
          from: 0,
          insert: "# Changed Instructions",
          to: view.state.doc.length,
        },
      });
    });
    expect(handleDraftChange).toHaveBeenCalledWith("# Changed Instructions");

    const saveBtn = screen.getByText("Save");
    fireEvent.click(saveBtn);
    expect(handleSave).toHaveBeenCalled();
  });

  it("copies skill link when header copy button is clicked", async () => {
    let copiedText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copiedText = text;
        },
      },
    });

    render(
      <SkillDetailPane
        activeSubTab="instructions"
        draftContent="# Notion"
        isSaving={false}
        onDraftChange={vi.fn()}
        onResetFile={vi.fn()}
        onSaveFile={vi.fn()}
        onSelectFile={vi.fn()}
        onSubTabChange={vi.fn()}
        onToggleEnable={vi.fn()}
        onTogglePin={vi.fn()}
        onViewChange={vi.fn()}
        selectedFile={null}
        skill={sampleDetail}
        view="preview"
      />,
    );

    const expectedSkillLink = buildSkillLink(sampleDetail.id);
    const copyBtn = screen.getByRole("button", {
      name: `Copy link (${expectedSkillLink})`,
    });
    expect(copyBtn).toBeDefined();
    fireEvent.click(copyBtn);
    expect(copiedText).toBe(expectedSkillLink);
  });

  it("copies skill file link when file copy button is clicked in files tab", async () => {
    let copiedText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copiedText = text;
        },
      },
    });

    render(
      <SkillDetailPane
        activeSubTab="files"
        draftContent="echo 'hello'"
        isSaving={false}
        onDraftChange={vi.fn()}
        onResetFile={vi.fn()}
        onSaveFile={vi.fn()}
        onSelectFile={vi.fn()}
        onSubTabChange={vi.fn()}
        onToggleEnable={vi.fn()}
        onTogglePin={vi.fn()}
        onViewChange={vi.fn()}
        selectedFile={{
          content: "echo 'hello'",
          editable: true,
          id: sampleDetail.id,
          modified_at: "2026-09-22T00:00:00.000Z",
          path: "scripts/run.sh",
          revision: "rev1",
          schema: 1,
          size: 12,
        }}
        skill={sampleDetail}
        view="edit"
      />,
    );

    const expectedFileLink = buildSkillLink(sampleDetail.id, "scripts/run.sh");
    const copyFileBtn = screen.getByRole("button", {
      name: `Copy link (${expectedFileLink})`,
    });
    expect(copyFileBtn).toBeDefined();
    fireEvent.click(copyFileBtn);
    expect(copiedText).toBe(expectedFileLink);
  });
});

describe("CreateSkillModal", () => {
  it("validates skill name and invokes onCreate", () => {
    const handleCreate = vi.fn().mockResolvedValue(undefined);
    const handleClose = vi.fn();

    render(
      <CreateSkillModal
        categories={["productivity", "apple"]}
        isOpen={true}
        onClose={handleClose}
        onCreate={handleCreate}
      />,
    );

    expect(screen.getByText("Create New Skill")).toBeDefined();
    const nameInput = screen.getByPlaceholderText("e.g. invoice-parser");
    const descInput = screen.getByPlaceholderText(
      "Summarize what this skill does and when Hermes should invoke it...",
    );

    fireEvent.change(nameInput, { target: { value: "INVALID NAME!" } });
    const submitBtn = screen.getByRole("button", { name: "Create Skill" });
    fireEvent.click(submitBtn);

    expect(
      screen.getByText(
        "Skill name must be lowercase kebab-case (e.g. 'my-awesome-skill').",
      ),
    ).toBeDefined();

    fireEvent.change(nameInput, { target: { value: "my-new-skill" } });
    fireEvent.change(descInput, { target: { value: "My awesome new skill" } });
    fireEvent.click(submitBtn);

    expect(handleCreate).toHaveBeenCalledWith(
      "my-new-skill",
      "",
      "My awesome new skill",
    );
  });
});

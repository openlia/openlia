import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { CreateSkillModal } from "../CreateSkillModal";
import { SkillDetailPane, type SkillSubTab } from "../SkillDetailPane";
import { SkillsNavigator } from "../SkillsNavigator";
import { action, storyData, storyLoader } from "./fixtures";
import { PageFrame } from "./frames";

const meta = {
  title: "Skills/Library",
  loaders: [storyLoader],
  parameters: {
    componentExports: [
      "CreateSkillModal.tsx#CreateSkillModal",
      "SkillDetailPane.tsx#SkillDetailPane",
      "SkillsNavigator.tsx#SkillsNavigator",
    ],
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Navigator: Story = {
  render: function NavigatorStory(_args, { loaded }) {
    const data = storyData(loaded);
    const [filter, setFilter] = useState("");
    const [selected, select] = useState<string | null>(data.skill.id);
    return (
      <div className="w-80 h-[650px]">
        <SkillsNavigator
          skills={data.skills.skills}
          categories={data.skills.categories}
          selectedSkillId={selected}
          onSelectSkill={select}
          filter={filter}
          onFilterChange={setFilter}
          onCreateClick={action("createSkill")}
          onTogglePin={action("togglePin")}
        />
      </div>
    );
  },
};
export const Details: Story = {
  render: function DetailsStory(_args, { loaded }) {
    const data = storyData(loaded);
    const [tab, setTab] = useState<SkillSubTab>("instructions");
    const [draft, setDraft] = useState(data.skillFile.content);
    const [view, setView] = useState<"edit" | "preview" | "info">("preview");
    return (
      <PageFrame>
        <SkillDetailPane
          skill={data.skill}
          activeSubTab={tab}
          onSubTabChange={setTab}
          selectedFile={data.skillFile}
          draftContent={draft}
          onDraftChange={setDraft}
          onSelectFile={action("selectFile")}
          onSaveFile={action("saveSkill")}
          onResetFile={() => setDraft(data.skillFile.content)}
          isSaving={false}
          onToggleEnable={action("toggleEnable")}
          onTogglePin={action("togglePin")}
          view={view}
          onViewChange={setView}
          onShare={action("shareSkill")}
        />
      </PageFrame>
    );
  },
};
export const Create: Story = {
  parameters: { docs: { story: { inline: false } } },
  render: function CreateStory(_args, { loaded }) {
    const data = storyData(loaded);
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Create skill
        </button>
        <CreateSkillModal
          isOpen={open}
          categories={data.skills.categories}
          onClose={() => setOpen(false)}
          onCreate={async (...args) => {
            action("createSkill")(...args);
            setOpen(false);
          }}
        />
      </>
    );
  },
};

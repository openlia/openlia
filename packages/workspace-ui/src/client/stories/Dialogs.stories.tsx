import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { CreateFileDialog } from "../CreateFileDialog";
import { RenameFileDialog } from "../RenameFileDialog";
import { MoveFileDialog } from "../MoveFileDialog";
import { GoToModal } from "../GoToModal";
import { DeleteFileDialog } from "../components/common/DeleteFileDialog";
import { DirtyDraftDialog } from "../components/common/DirtyDraftDialog";
import { mockCreatableDomains } from "../mockApi";
import { action, file, storyData, storyLoader } from "./fixtures";

const meta = {
  title: "Documents/Dialogs",
  loaders: [storyLoader],
  parameters: {
    componentExports: [
      "CreateFileDialog.tsx#CreateFileDialog",
      "RenameFileDialog.tsx#RenameFileDialog",
      "MoveFileDialog.tsx#MoveFileDialog",
      "GoToModal.tsx#GoToModal",
      "components/common/DeleteFileDialog.tsx#DeleteFileDialog",
      "components/common/DirtyDraftDialog.tsx#DirtyDraftDialog",
    ],
    docs: {
      story: { inline: false },
      description: {
        component:
          "Review each dialog in Canvas. Actions are logged; files are never changed.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const CreateFile: Story = {
  render: function CreateStory() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          New file
        </button>
        <CreateFileDialog
          isOpen={open}
          isCreating={false}
          availableDomains={mockCreatableDomains}
          initialDomain="calendar"
          onCancel={() => setOpen(false)}
          onCreate={(...args) => {
            action("createFile")(...args);
            setOpen(false);
          }}
        />
      </>
    );
  },
};
export const Rename: Story = {
  render: () => (
    <RenameFileDialog
      filePath={file.path}
      renaming={false}
      onCancel={action("cancel")}
      onRename={action("rename")}
    />
  ),
};
export const RenameConflict: Story = {
  render: () => (
    <RenameFileDialog
      filePath={file.path}
      renaming={false}
      error="A file with this name already exists."
      onCancel={action("cancel")}
      onRename={action("rename")}
    />
  ),
};
export const Move: Story = {
  render: () => (
    <MoveFileDialog
      filePath={file.path}
      directories={["projects", "archive", "tasks"]}
      moving={false}
      onCancel={action("cancel")}
      onMove={action("move")}
    />
  ),
};
export const Delete: Story = {
  render: () => (
    <DeleteFileDialog
      filePath={file.path}
      dirty={false}
      deleting={false}
      onCancel={action("cancel")}
      onConfirm={action("confirmDelete")}
    />
  ),
};
export const DirtyDraft: Story = {
  render: () => (
    <DirtyDraftDialog
      actionLabel="open another document"
      saving={false}
      onCancel={action("cancel")}
      onDiscard={action("discard")}
      onSave={action("save")}
    />
  ),
};
export const GoTo: Story = {
  render: (_args, { loaded }) => {
    const data = storyData(loaded);
    return (
      <GoToModal
        isOpen
        onClose={action("close")}
        tree={data.tree.entries}
        skills={data.skills.skills}
        onNavigateWorkspace={action("navigateWorkspace")}
        onNavigateSkill={action("navigateSkill")}
      />
    );
  },
};

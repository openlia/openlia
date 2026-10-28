import type { Meta, StoryObj } from "@storybook/react-vite";
import { ShareModal } from "../ShareModal";
import { SharePublicView } from "../SharePublicView";
import { SharedLinksSection } from "../SharedLinksSection";
import { action, file, storyData, storyLoader } from "./fixtures";
import { PageFrame } from "./frames";

const meta = {
  title: "Workspace/Sharing",
  loaders: [storyLoader],
  parameters: {
    componentExports: [
      "ShareModal.tsx#ShareModal",
      "SharePublicView.tsx#SharePublicView",
      "SharedLinksSection.tsx#SharedLinksSection",
    ],
    docs: {
      description: {
        component:
          "Shared links are synthetic, local snapshots. Creating or deleting one changes only the story's in-memory API.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const ShareDialog: Story = {
  parameters: { docs: { story: { inline: false } } },
  render: (_args, { loaded }) => (
    <ShareModal
      api={storyData(loaded).api}
      isOpen
      onClose={action("close")}
      kind="workspace"
      targetPath={file.path}
      title="Project review"
    />
  ),
};
export const SharedLinks: Story = {
  render: (_args, { loaded }) => (
    <PageFrame>
      <SharedLinksSection
        api={storyData(loaded).api}
        onOpenWorkspaceDocument={action("openDocument")}
        onOpenSkill={action("openSkill")}
      />
    </PageFrame>
  ),
};
export const PublicSnapshot: Story = {
  render: (_args, { loaded }) => {
    const data = storyData(loaded);
    return <SharePublicView api={data.api} shareId={data.share.id} />;
  },
};

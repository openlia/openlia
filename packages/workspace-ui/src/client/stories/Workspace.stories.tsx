import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { ActivitySection } from "../ActivitySection";
import { GitActivitySection } from "../GitActivitySection";
import { CheckpointProposals } from "../CheckpointProposals";
import { WorkspaceHeader } from "../components/layout/WorkspaceHeader";
import { ConfigurationPage } from "../ConfigurationPage";
import { SchedulePage } from "../SchedulePage";
import { UsagePage, UsagePricingOverrides } from "../UsagePage";
import { UsageSummary } from "../UsageSummary";
import { MaintainerPage } from "../MaintainerPage";
import { MaintainerFixModal } from "../MaintainerFixModal";
import { MinionsPage } from "../MinionsPage";
import { MigrationSection } from "../migration/MigrationSection";
import { action, file, finding, storyData, storyLoader } from "./fixtures";
import { PageFrame } from "./frames";
import type { CheckpointProposal } from "../../shared/checkpoints";

const meta = {
  title: "Workspace/Features",
  loaders: [storyLoader],
  parameters: {
    layout: "fullscreen",
    componentExports: [
      "ActivitySection.tsx#ActivitySection",
      "GitActivitySection.tsx#GitActivitySection",
      "CheckpointProposals.tsx#CheckpointProposals",
      "components/layout/WorkspaceHeader.tsx#WorkspaceHeader",
      "ConfigurationPage.tsx#ConfigurationPage",
      "SchedulePage.tsx#SchedulePage",
      "UsagePage.tsx#UsagePage",
      "UsagePage.tsx#UsagePricingOverrides",
      "UsageSummary.tsx#UsageSummary",
      "MaintainerPage.tsx#MaintainerPage",
      "MaintainerFixModal.tsx#MaintainerFixModal",
      "MinionsPage.tsx#MinionsPage",
      "migration/MigrationSection.tsx#MigrationSection",
    ],
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Header: Story = {
  render: function HeaderStory(_args, { loaded }) {
    const data = storyData(loaded);
    const ref = useRef<HTMLButtonElement>(null);
    return (
      <WorkspaceHeader
        authRequired
        file={file}
        git={data.git}
        filesButtonRef={ref}
        onOpenFiles={action("openFiles")}
        onSignOut={action("signOut")}
        onTabChange={action("tab")}
      />
    );
  },
};
export const Activity: Story = {
  render: (_args, { loaded }) => {
    const data = storyData(loaded);
    return (
      <ActivitySection
        activity={data.activity}
        diagnostics={data.diagnostics}
        loading={false}
        onOpenFile={action("openFile")}
        onOpenGitActivity={action("git")}
        onOpenMaintainer={action("maintainer")}
      />
    );
  },
};
export const GitActivity: Story = {
  render: (_args, { loaded }) => {
    const data = storyData(loaded);
    return (
      <GitActivitySection
        activity={data.activity}
        git={data.git}
        loading={false}
        onOpenFile={action("openFile")}
        onRefresh={action("refresh")}
      />
    );
  },
};
export const Checkpoints: Story = {
  render: function CheckpointStory() {
    const [api] = useState(() => {
      let proposal: CheckpointProposal = {
        id: "a".repeat(32),
        revision: 1,
        snapshot_id: "b".repeat(64),
        base_head: "c".repeat(40),
        status: "pending",
        created_at: "2026-10-27",
        updated_at: "2026-10-27",
        session_id: null,
        commits: [
          {
            message: "backup: review calendar",
            rationale: "Keep UI feedback together",
            files: [file.path],
          },
        ],
        files: [
          {
            path: file.path,
            oid: "d".repeat(40),
            mode: "100644",
            diff: "+ Review the calendar views",
          },
        ],
        excluded: [],
        hashes: [],
      };
      return {
        loadCheckpointProposals: async () => ({
          proposals: [structuredClone(proposal)],
        }),
        approveCheckpoint: async () => {
          action("mockApproveCheckpoint")();
          proposal = { ...proposal, status: "applied", hashes: ["mock-hash"] };
          return structuredClone(proposal);
        },
        dismissCheckpoint: async () => {
          proposal = { ...proposal, status: "dismissed" };
          return structuredClone(proposal);
        },
      };
    });
    return <CheckpointProposals api={api} onAskLia={action("askLia")} />;
  },
};
export const Configuration: Story = {
  render: function ConfigurationStory(_args, { loaded }) {
    const data = storyData(loaded);
    const [settings, setSettings] = useState(data.settings);
    return (
      <PageFrame>
        <ConfigurationPage
          api={data.api}
          settings={settings}
          systemInfo={data.systemInfo}
          error=""
          exporting={false}
          savingSettings={false}
          onExport={action("export")}
          onSettingsChange={(key, value) =>
            setSettings((current) => ({ ...current, [key]: value }))
          }
          onOpenSchedule={action("schedule")}
        />
      </PageFrame>
    );
  },
};
export const Schedule: Story = {
  render: (_args, { loaded }) => (
    <PageFrame>
      <SchedulePage
        api={storyData(loaded).api}
        onOpenDocument={action("openDocument")}
      />
    </PageFrame>
  ),
};
export const Usage: Story = {
  render: (_args, { loaded }) => (
    <PageFrame>
      <UsagePage api={storyData(loaded).api} />
    </PageFrame>
  ),
};
export const PricingOverrides: Story = {
  render: (_args, { loaded }) => (
    <UsagePricingOverrides api={storyData(loaded).api} />
  ),
};
export const UsageReference: Story = {
  render: (_args, { loaded }) => (
    <UsageSummary api={storyData(loaded).api} reference="mig-mock-1" />
  ),
};
export const Maintainer: Story = {
  render: (_args, { loaded }) => (
    <PageFrame>
      <MaintainerPage
        api={storyData(loaded).api}
        onOpenFile={action("openFile")}
        onAskLia={action("askLia")}
      />
    </PageFrame>
  ),
};
export const FixPreview: Story = {
  parameters: { docs: { story: { inline: false } } },
  render: (_args, { loaded }) => (
    <MaintainerFixModal
      api={storyData(loaded).api}
      finding={finding}
      onClose={action("close")}
      onApplied={action("applied")}
    />
  ),
};
export const Minions: Story = {
  render: (_args, { loaded }) => (
    <PageFrame>
      <MinionsPage
        api={storyData(loaded).api}
        selectedMinionId="sample-minion"
        onSelectMinion={action("selectMinion")}
        onOpenFile={action("openFile")}
        onNavigateLink={action("navigateLink")}
        onAskLia={action("askLia")}
      />
    </PageFrame>
  ),
};
export const Migrations: Story = {
  render: (_args, { loaded }) => {
    const data = storyData(loaded);
    return (
      <PageFrame>
        <MigrationSection
          migrationDetail={null}
          migrationsList={data.migrations}
          loading={false}
          onSelectMigration={action("selectMigration")}
          onRefresh={action("refresh")}
          onWakeWorker={action("wakeWorker")}
          onStop={action("stop")}
          onResume={action("resume")}
          onApprove={async (...args) => {
            action("approve")(...args);
          }}
          onDiscard={async () => {
            action("discard")();
          }}
          onSubmitFeedback={async (...args) => {
            action("feedback")(...args);
          }}
        />
      </PageFrame>
    );
  },
};
export const MigrationReview: Story = {
  render: (_args, { loaded }) => {
    const data = storyData(loaded);
    return (
      <PageFrame>
        <MigrationSection
          migrationDetail={data.migrationDetail}
          migrationsList={data.migrations}
          loading={false}
          onSelectMigration={action("selectMigration")}
          onRefresh={action("refresh")}
          onWakeWorker={action("wakeWorker")}
          onStop={action("stop")}
          onResume={action("resume")}
          onApprove={async (...args) => {
            action("approve")(...args);
          }}
          onDiscard={async () => {
            action("discard")();
          }}
          onSubmitFeedback={async (...args) => {
            action("feedback")(...args);
          }}
        />
      </PageFrame>
    );
  },
};

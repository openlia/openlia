import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ChatComposer } from "../ChatComposer";
import { ChatHeader } from "../ChatHeader";
import { ChatNavigation } from "../ChatNavigation";
import { ChatMarkdown } from "../ChatMarkdown";
import { ChatTranscript } from "../ChatTranscript";
import { ChatPage } from "../ChatPage";
import { ChatExecution } from "../ChatExecution";
import { createChatMock } from "../chatMock";
import { action, chatMessages, markdown } from "./fixtures";
import { PageFrame } from "./frames";

const meta = {
  title: "Chat/Conversation",
  parameters: {
    layout: "fullscreen",
    componentExports: [
      "ChatComposer.tsx#ChatComposer",
      "ChatHeader.tsx#ChatHeader",
      "ChatNavigation.tsx#ChatNavigation",
      "ChatMarkdown.tsx#ChatMarkdown",
      "ChatTranscript.tsx#ChatTranscript",
      "ChatPage.tsx#ChatPage",
      "ChatExecution.tsx#ChatExecution",
    ],
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const session = {
  id: "story-chat",
  title: "Review Calendar components",
  source: "hermes_browser",
  writable: true,
  pinned: true,
};
export const Header: Story = {
  render: () => (
    <ChatHeader
      session={session}
      busy={false}
      active={false}
      onOpenConversations={action("openConversations")}
      onAction={action("sessionAction")}
    />
  ),
};
export const Transcript: Story = {
  render: () => <ChatTranscript messages={chatMessages} />,
};
export const Markdown: Story = {
  render: () => (
    <ChatMarkdown content={`${markdown}\nInline math: $E = mc^2$`} />
  ),
};
export const Composer: Story = {
  render: function ComposerStory() {
    const [draft, setDraft] = useState("");
    const [model, setModel] = useState("local-demo");
    return (
      <ChatComposer
        draft={draft}
        onDraft={setDraft}
        model={model}
        onModel={setModel}
        models={[{ id: "local-demo" }, { id: "review-model" }]}
        run={null}
        active={false}
        busy={false}
        disabled={false}
        canSteer={false}
        canStop={false}
        onSend={() => {
          action("send")(draft);
          setDraft("");
        }}
        onSteer={action("steer")}
        onStop={action("stop")}
      />
    );
  },
};
export const ActiveComposer: Story = {
  render: () => (
    <ChatComposer
      draft="Focus on accessibility"
      onDraft={action("draft")}
      model="local-demo"
      onModel={action("model")}
      models={[{ id: "local-demo" }]}
      run={{ run_id: "run-1", status: "running" }}
      active
      busy={false}
      disabled={false}
      canSteer
      canStop
      onSend={action("send")}
      onSteer={action("steer")}
      onStop={action("stop")}
    />
  ),
};
export const Navigation: Story = {
  render: function NavigationStory() {
    const [filter, setFilter] = useState("");
    return (
      <div className="h-[600px]">
        <ChatNavigation
          sessions={[
            session,
            {
              ...session,
              id: "other",
              title: "Prepare weekly agenda",
              pinned: false,
            },
          ]}
          selectedId={session.id}
          other={false}
          filter={filter}
          onFilter={setFilter}
          hasMore={false}
          loading={false}
          busy={false}
          ready
          drawerOpen
          onClose={action("close")}
          onSelect={action("selectSession")}
          onNew={action("newSession")}
          onSource={action("source")}
          onMore={action("more")}
        />
      </div>
    );
  },
};
export const FullConversation: Story = {
  render: function ConversationStory() {
    const [api] = useState(createChatMock);
    return (
      <PageFrame>
        <ChatPage api={api} />
      </PageFrame>
    );
  },
};

const recordedFailure = {
  run_id: "run-synthetic-failed",
  status: "failed",
  request_id: "request-1",
  status_source: "recorded" as const,
  submitted_at: Date.parse("2026-10-27T09:00:00Z"),
  status_observed_at: Date.parse("2026-10-27T09:01:00Z"),
};
export const FailedExecution: Story = {
  render: () => (
    <ChatExecution
      run={recordedFailure}
      history={[recordedFailure]}
      hasMore={false}
      busy={false}
      historyError=""
      onRefresh={action("refreshExecution")}
      onRefreshRun={action("refreshRun")}
      onMore={action("earlierExecutions")}
    />
  ),
};
export const UnknownExecution: Story = {
  render: () => (
    <ChatExecution
      run={{
        run_id: "",
        status: "unknown",
        status_source: "unconfirmed",
        request_id: "request-2",
      }}
      history={[recordedFailure]}
      hasMore
      busy={false}
      historyError=""
      onRefresh={action("refreshExecution")}
      onRefreshRun={action("refreshRun")}
      onMore={action("earlierExecutions")}
    />
  ),
};

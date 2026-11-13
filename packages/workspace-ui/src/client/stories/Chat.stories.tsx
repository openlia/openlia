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

const completedRun = {
  run_id: "run_bd130d362d24404cb122991f0d8582a3",
  status: "completed",
  request_id: "request-completed",
  status_source: "hermes" as const,
  submitted_at: Date.parse("2026-11-12T16:45:16Z"),
  status_observed_at: Date.parse("2026-11-12T17:35:34Z"),
};

export const CompletedExecution: Story = {
  render: () => (
    <div className="p-4 bg-base-100">
      <ChatExecution
        run={completedRun}
        history={[
          completedRun,
          {
            ...completedRun,
            run_id: "run_prev_01",
            submitted_at: Date.parse("2026-11-12T14:10:00Z"),
            status_observed_at: Date.parse("2026-11-12T14:15:20Z"),
          },
          recordedFailure,
        ]}
        hasMore={false}
        busy={false}
        historyError=""
        onRefresh={action("refreshExecution")}
        onRefreshRun={action("refreshRun")}
        onMore={action("earlierExecutions")}
      />
    </div>
  ),
};

export const CompletedExecutionExpanded: Story = {
  render: () => (
    <div className="p-4 bg-base-100">
      <ChatExecution
        run={completedRun}
        history={[
          completedRun,
          {
            ...completedRun,
            run_id: "run_prev_01",
            submitted_at: Date.parse("2026-11-12T14:10:00Z"),
            status_observed_at: Date.parse("2026-11-12T14:15:20Z"),
          },
          recordedFailure,
        ]}
        hasMore={false}
        busy={false}
        historyError=""
        defaultOpen
        onRefresh={action("refreshExecution")}
        onRefreshRun={action("refreshRun")}
        onMore={action("earlierExecutions")}
      />
    </div>
  ),
};

export const RunningExecution: Story = {
  render: () => (
    <div className="p-4 bg-base-100">
      <ChatExecution
        run={{
          run_id: "run_running_live",
          status: "running",
          request_id: "request-running",
          status_source: "hermes",
          submitted_at: Date.now() - 42000,
        }}
        history={[completedRun]}
        hasMore={false}
        busy={false}
        historyError=""
        onRefresh={action("refreshExecution")}
        onRefreshRun={action("refreshRun")}
        onMore={action("earlierExecutions")}
      />
    </div>
  ),
};

export const FailedExecution: Story = {
  render: () => (
    <div className="p-4 bg-base-100">
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
    </div>
  ),
};

export const UnknownExecution: Story = {
  render: () => (
    <div className="p-4 bg-base-100">
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
    </div>
  ),
};

const realisticTurnMessages = [
  {
    id: 101,
    role: "user" as const,
    content:
      "File google-docs/service-account.json trong workspace đã được cho phép sử dụng theo policy của OpenLia. Bạn hãy dùng python3 /opt/data/skills/google-docs/scripts/gdocs.py để cập nhật thực đơn 2 tuần vào file Google Docs Sample File (ID: 1hn8zUNCj7NMQSgL_8kAlnFbhpKTenQp53SNqGvSFCbg) nhé.",
  },
  {
    id: 102,
    role: "assistant" as const,
    content:
      "Đã cập nhật Google Docs bằng bảng thực đơn 2 tuần, từ 16–29/11/2026. Bảng có 14 ngày, ba cột Ngày/Trưa/Tối; mình cũng thêm ghi chú về khẩu phần, dị ứng, lactose và nêm nhạt. Nội dung cũ được giữ lại, và mình đã đọc lại để xác minh bảng cùng ghi chú.\n\nMở tài liệu: https://docs.google.com/document/d/1hn8zUNCj7NMQSgL_8kAlnFbhpKTenQp53SNqGvSFCbg/edit",
    tool_calls: Array.from({ length: 22 }, (_, i) => ({
      id: `tool-${i + 1}`,
      type: "function" as const,
      function: {
        name: i === 0 ? "read_file" : i === 1 ? "exec" : "write_file",
        arguments: JSON.stringify({ step: i + 1 }),
      },
    })),
  },
];

const realisticHistory = [
  completedRun,
  ...Array.from({ length: 6 }, (_, i) => ({
    ...completedRun,
    run_id: `run_prev_0${i + 1}`,
    submitted_at: Date.parse("2026-11-12T14:10:00Z") - i * 3600000,
    status_observed_at: Date.parse("2026-11-12T14:15:20Z") - i * 3600000,
  })),
];

export const RealisticTurn_BothCollapsed: Story = {
  render: () => (
    <div className="p-4 bg-base-100 max-w-[52rem] mx-auto">
      <ChatTranscript messages={realisticTurnMessages} />
      <ChatExecution
        run={completedRun}
        history={realisticHistory}
        hasMore={false}
        busy={false}
        historyError=""
        onRefresh={action("refreshExecution")}
        onRefreshRun={action("refreshRun")}
        onMore={action("earlierExecutions")}
      />
    </div>
  ),
};

export const RealisticTurn_ExecutionExpanded: Story = {
  render: () => (
    <div className="p-4 bg-base-100 max-w-[52rem] mx-auto">
      <ChatTranscript messages={realisticTurnMessages} />
      <ChatExecution
        run={completedRun}
        history={realisticHistory}
        hasMore={false}
        busy={false}
        historyError=""
        defaultOpen
        onRefresh={action("refreshExecution")}
        onRefreshRun={action("refreshRun")}
        onMore={action("earlierExecutions")}
      />
    </div>
  ),
};

export const RealisticTurn_ToolsExpanded: Story = {
  render: () => (
    <div className="p-4 bg-base-100 max-w-[52rem] mx-auto">
      <ChatTranscript messages={realisticTurnMessages} defaultOpenTools />
      <ChatExecution
        run={completedRun}
        history={realisticHistory}
        hasMore={false}
        busy={false}
        historyError=""
        onRefresh={action("refreshExecution")}
        onRefreshRun={action("refreshRun")}
        onMore={action("earlierExecutions")}
      />
    </div>
  ),
};

export const RealisticTurn_BothExpanded: Story = {
  render: () => (
    <div className="p-4 bg-base-100 max-w-[52rem] mx-auto">
      <ChatTranscript messages={realisticTurnMessages} defaultOpenTools />
      <ChatExecution
        run={completedRun}
        history={realisticHistory}
        hasMore={false}
        busy={false}
        historyError=""
        defaultOpen
        onRefresh={action("refreshExecution")}
        onRefreshRun={action("refreshRun")}
        onMore={action("earlierExecutions")}
      />
    </div>
  ),
};

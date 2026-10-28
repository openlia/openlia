import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { MarkdownPreview } from "../components/editor/MarkdownPreview";
import { FrontmatterBlock } from "../FrontmatterBlock";
import { CodeEditor } from "../CodeEditor";
import { DocumentInspector } from "../features/documents/DocumentInspector";
import { DocumentPane } from "../features/documents/DocumentPane";
import { FileNavigator } from "../features/documents/FileNavigator";
import { action, file, markdown, storyData, storyLoader } from "./fixtures";
import { PageFrame } from "./frames";

const meta = {
  title: "Documents/Reading and editing",
  loaders: [storyLoader],
  parameters: {
    componentExports: [
      "components/editor/MarkdownPreview.tsx#MarkdownPreview",
      "components/editor/SchemaRecordForm.tsx#SchemaRecordForm",
      "FrontmatterBlock.tsx#FrontmatterBlock",
      "CodeEditor.tsx#CodeEditor",
      "features/documents/DocumentInspector.tsx#DocumentInspector",
      "features/documents/DocumentPane.tsx#DocumentPane",
      "features/documents/FileNavigator.tsx#FileNavigator",
    ],
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Markdown: Story = {
  render: () => (
    <MarkdownPreview content={markdown} onNavigateLink={action("navigate")} />
  ),
};
export const Frontmatter: Story = {
  render: () => (
    <FrontmatterBlock
      data={{
        title: "Design review",
        status: "active",
        tags: ["calendar", "ui"],
        attendees: ["Alex", "Sam"],
      }}
      rawYaml={
        "title: Design review\nstatus: active\ntags: [calendar, ui]\nattendees: [Alex, Sam]"
      }
    />
  ),
};
export const MarkdownEditor: Story = {
  render: function Editor() {
    const [value, setValue] = useState(markdown);
    return (
      <CodeEditor
        filePath="review.md"
        value={value}
        onChange={setValue}
        minHeight="360px"
      />
    );
  },
};
export const JsonEditor: Story = {
  render: function Editor() {
    const [value, setValue] = useState(
      '{\n  "timezone": "UTC",\n  "notifications": false\n}',
    );
    return (
      <CodeEditor
        filePath="settings.json"
        value={value}
        onChange={setValue}
        minHeight="260px"
      />
    );
  },
};
export const ReadOnlyEditor: Story = {
  render: () => (
    <CodeEditor
      filePath="calendar/reminders.rem"
      value="REM 2026-10-27 AT 09:00 NOQUEUE MSG Review"
      onChange={action("change")}
      readOnly
      minHeight="160px"
    />
  ),
};
export const Inspector: Story = {
  render: () => (
    <DocumentInspector
      file={file}
      draft={markdown}
      diff={["+ Collect component feedback"]}
    />
  ),
};
function Pane({
  loading = false,
  error = "",
  conflict = "",
}: {
  loading?: boolean;
  error?: string;
  conflict?: string;
}) {
  const [draft, setDraft] = useState(markdown);
  const [view, setView] = useState<"edit" | "preview" | "info">("preview");
  return (
    <PageFrame>
      <DocumentPane
        file={file}
        draft={draft}
        onDraftChange={setDraft}
        view={view}
        onViewChange={setView}
        conflict={conflict}
        deleting={false}
        diff={[]}
        documentError={error}
        fileLoading={loading}
        saving={false}
        onCloseFiles={action("closeFiles")}
        onDelete={action("delete")}
        onDownload={action("download")}
        onOpenDetails={action("details")}
        onRetry={action("retry")}
        onSave={action("save")}
      />
    </PageFrame>
  );
}
export const Document: Story = { render: () => <Pane /> };
export const LoadingDocument: Story = { render: () => <Pane loading /> };
export const FailedDocument: Story = {
  render: () => (
    <Pane error="Could not load the document. Retry to continue." />
  ),
};
export const RevisionConflict: Story = {
  render: () => (
    <Pane conflict="This document changed. Review the latest revision before saving." />
  ),
};
export const Navigator: Story = {
  render: function NavigatorStory(_args, { loaded }) {
    const data = storyData(loaded);
    const [filter, setFilter] = useState("");
    return (
      <div className="h-[650px] w-80 border border-base-content/10">
        <FileNavigator
          entries={data.tree.entries}
          filter={filter}
          onFilterChange={setFilter}
          loading={false}
          mobileOpen
          onClose={action("close")}
          onOpenFile={action("openFile")}
          onOpenProject={action("openProject")}
          onCreateFile={action("createFile")}
          onRetry={action("retry")}
          selectedPath="notes.md"
          truncated={false}
          workspaceError=""
        />
      </div>
    );
  },
};

import { Renderer } from "@openuidev/react-lang";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { OpenLiaOpenUIProvider } from "../openui/context";
import {
  createOpenLiaLibrary,
  normalizeOpenUIProgram,
} from "../openui/library";
import { OpenUIDiagnostics } from "../openui/OpenUIDiagnostics";
import { OpenUIErrorBoundary } from "../openui/OpenUIErrorBoundary";
import { action, records } from "./fixtures";
import type { WorkspaceDomainRecordSummary } from "../../shared/api";

const meta = {
  title: "OpenUI/Component library",
  parameters: {
    componentExports: [
      "openui/library.tsx#Grid",
      "openui/library.tsx#DomainHeader",
      "openui/library.tsx#MetricCard",
      "openui/library.tsx#RecordTable",
      "openui/library.tsx#RecordKanban",
      "openui/OpenUIDiagnostics.tsx#OpenUIDiagnostics",
      "openui/OpenUIErrorBoundary.tsx#OpenUIErrorBoundary",
    ],
    docs: {
      description: {
        component:
          "Custom OpenLia components rendered through the real OpenUI interpreter, plus a representative upstream gallery.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Program({
  content,
  empty = false,
}: {
  content: string;
  empty?: boolean;
}) {
  const [items, setItems] = useState<WorkspaceDomainRecordSummary[]>(
    empty ? [] : structuredClone(records),
  );
  const library = createOpenLiaLibrary({
    records: items,
    queries: { active_count: items.length },
  });
  return (
    <OpenLiaOpenUIProvider
      value={{
        records: items,
        domainPath: "tasks",
        queries: { active_count: items.length },
        onOpenRecord: action("openRecord"),
        onCreateRecord: action("createRecord"),
        onUpdateRecordFrontmatter: (path, updates) =>
          setItems((current) =>
            current.map((item) =>
              item.path === path
                ? { ...item, frontmatter: { ...item.frontmatter, ...updates } }
                : item,
            ),
          ),
      }}
    >
      <OpenUIErrorBoundary uiPath="tasks/ui.openui" onEditUI={action("editUI")}>
        <Renderer
          library={library}
          response={normalizeOpenUIProgram(content)}
        />
      </OpenUIErrorBoundary>
    </OpenLiaOpenUIProvider>
  );
}
export const Header: Story = {
  render: () => (
    <Program content='root = DomainHeader("Tasks", "Concrete next actions.")' />
  ),
};
export const MetricsAndGrid: Story = {
  render: () => (
    <Program content='root = Grid([MetricCard("Active", @Query("active_count")), MetricCard("Completed", 12, "This week", "success"), MetricCard("Needs review", 2, "Check required fields", "warning")], 3)' />
  ),
};
export const Table: Story = {
  render: () => (
    <Program content='root = RecordTable(["title", "status", "priority", "due"])' />
  ),
};
export const Kanban: Story = {
  render: () => (
    <Program content='root = RecordKanban("status", ["todo", "in-progress", "done"])' />
  ),
};
export const EmptyTable: Story = {
  render: () => <Program empty content="root = RecordTable()" />,
};
export const Dashboard: Story = {
  render: () => (
    <Program content='root = Stack([DomainHeader("Tasks"), Grid([MetricCard("Active", @Query("active_count")), MetricCard("Completed", 12)], 2), RecordKanban("status", ["todo", "in-progress", "done"]), RecordTable(["title", "status"])])' />
  ),
};
export const ValidDiagnostics: Story = {
  render: () => <OpenUIDiagnostics content="root = CalendarMonth()" />,
};
export const InvalidDiagnostics: Story = {
  render: () => <OpenUIDiagnostics content="root = UnknownWidget()" />,
};
export const UpstreamGallery: Story = {
  render: () => (
    <Program content='root = Stack([Card([CardHeader("Upstream OpenUI", "A representative gallery"), TextContent("Use these with OpenLia components."), Callout("Local preview", "No API calls or external side effects.", "info")]), Tabs([TabItem("overview", "Overview", [TextContent("Overview content")]), TabItem("notes", "Notes", [MarkDownRenderer("## Notes\\nReusable Markdown content")])]), Accordion([AccordionItem("details", "Details", [TextContent("Expandable details")])])])' />
  ),
};
export const ErrorBoundary: Story = {
  render: () => (
    <OpenUIErrorBoundary uiPath="tasks/ui.openui" onEditUI={action("editUI")}>
      <p>
        Healthy child content. Parser errors can be explored with Invalid
        diagnostics.
      </p>
    </OpenUIErrorBoundary>
  ),
};

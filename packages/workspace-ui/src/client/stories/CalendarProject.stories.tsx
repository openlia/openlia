import type { Meta, StoryObj } from "@storybook/react-vite";
import { Renderer } from "@openuidev/react-lang";
import { useState } from "react";
import { CalendarView } from "../openui/calendar/Calendar";
import { CalendarMonthView } from "../openui/calendar/CalendarMonth";
import { OpenLiaOpenUIProvider } from "../openui/context";
import { openliaLibrary } from "../openui/library";
import { action, createStoryApi } from "./fixtures";

const meta = {
  title: "Calendar/Project composition",
  parameters: {
    componentExports: [
      "openui/calendar/Calendar.tsx#CalendarView",
      "openui/calendar/Calendar.tsx#Calendar",
    ],
    docs: {
      description: {
        component:
          "The actual OpenUI Calendar template, with an editable, in-memory appointment API. No native evaluator or workspace is used.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const program =
  'root = Calendar([Tabs([TabItem("month", "Month", [CalendarMonth()]), TabItem("week", "Week", [CalendarWeek()]), TabItem("timeline", "Timeline", [GanttChart()])])])';

function Project({
  state = "populated",
}: {
  state?: "populated" | "empty" | "loading" | "error";
}) {
  const [api] = useState(() => createStoryApi(state));
  return (
    <OpenLiaOpenUIProvider
      value={{
        calendarApi: api,
        domainPath: "calendar",
        onOpenRecord: action("openRecord"),
      }}
    >
      <div className="p-4">
        <Renderer library={openliaLibrary} response={program} />
      </div>
    </OpenLiaOpenUIProvider>
  );
}
export const ThreeTabs: Story = { render: () => <Project /> };
export const Empty: Story = { render: () => <Project state="empty" /> };
export const Loading: Story = { render: () => <Project state="loading" /> };
export const MissingEvaluator: Story = {
  render: () => <Project state="error" />,
};
export const MissingRuntimeContext: Story = {
  render: () => (
    <CalendarView>
      <CalendarMonthView />
    </CalendarView>
  ),
};

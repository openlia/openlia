import type { Meta, StoryObj } from "@storybook/react-vite";
import { GanttChartView } from "../openui/calendar/GanttChart";
import { CalendarFrame } from "./frames";

const meta = {
  title: "Calendar/Timeline controls",
  component: GanttChartView,
  args: { title: "Event-duration timeline", zoom: "week", groupBy: "none" },
  argTypes: {
    title: { control: "text" },
    zoom: { control: "select", options: ["day", "week", "month"] },
    groupBy: { control: "select", options: ["none", "source", "location"] },
    items: { control: "object" },
  },
  render: (args) => (
    <CalendarFrame>
      <GanttChartView key={`${args.zoom}:${args.groupBy}`} {...args} />
    </CalendarFrame>
  ),
} satisfies Meta<typeof GanttChartView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CalendarEvents: Story = {};
export const GenericItems: Story = {
  args: {
    items: [
      {
        id: "trip",
        title: "Conference",
        start: "2026-10-26",
        end: "2026-10-29",
        group: "Travel",
      },
      {
        id: "design",
        title: "Design review",
        start: "2026-10-27T09:00:00Z",
        end: "2026-10-27T10:30:00Z",
        group: "Meetings",
      },
    ],
  },
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { CalendarMonthView } from "../openui/calendar/CalendarMonth";
import { CalendarWeekView } from "../openui/calendar/CalendarWeek";
import { GanttChartView } from "../openui/calendar/GanttChart";
import { CalendarNavigation } from "../openui/calendar/CalendarNavigation";
import { CalendarFrame } from "./frames";
import { primaryCalendarEvent } from "./fixtures";

const meta = {
  title: "Calendar/Views",
  component: CalendarMonthView,
  args: { title: "Month" },
  argTypes: { title: { control: "text" } },
  parameters: {
    componentExports: [
      "openui/calendar/CalendarMonth.tsx#CalendarMonthView",
      "openui/calendar/CalendarMonth.tsx#CalendarMonth",
      "openui/calendar/CalendarWeek.tsx#CalendarWeekView",
      "openui/calendar/CalendarWeek.tsx#CalendarWeek",
      "openui/calendar/GanttChart.tsx#GanttChartView",
      "openui/calendar/GanttChart.tsx#GanttChart",
      "openui/calendar/CalendarNavigation.tsx#CalendarNavigation",
    ],
    docs: {
      description: {
        component:
          "Separate reusable views sharing a selected date and event details. Dates are fixed at 27 October 2026; navigation and selection work without Remind.",
      },
    },
  },
} satisfies Meta<typeof CalendarMonthView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Month: Story = {
  render: (args) => (
    <CalendarFrame>
      <CalendarMonthView {...args} />
    </CalendarFrame>
  ),
};
export const EmptyMonth: Story = {
  render: () => (
    <CalendarFrame events={[]}>
      <CalendarMonthView />
    </CalendarFrame>
  ),
};
export const WeekWithOverlaps: Story = {
  render: () => (
    <CalendarFrame>
      <CalendarWeekView />
    </CalendarFrame>
  ),
};
export const Timeline: Story = {
  render: () => (
    <CalendarFrame>
      <GanttChartView />
    </CalendarFrame>
  ),
};
export const GroupedTimeline: Story = {
  render: () => (
    <CalendarFrame>
      <GanttChartView groupBy="location" zoom="month" />
    </CalendarFrame>
  ),
};
export const Timezone: Story = {
  render: () => (
    <CalendarFrame timezone="Asia/Ho_Chi_Minh">
      <CalendarWeekView />
    </CalendarFrame>
  ),
};
export const DaylightSaving: Story = {
  render: () => (
    <CalendarFrame
      date="2026-11-01"
      timezone="America/New_York"
      events={[
        {
          ...primaryCalendarEvent,
          start: "2026-11-01T05:30:00Z",
          end: "2026-11-01T07:30:00Z",
          title: "Crossing the repeated hour",
        },
      ]}
    >
      <GanttChartView zoom="day" />
    </CalendarFrame>
  ),
};
export const StandaloneTimeline: Story = {
  render: () => (
    <GanttChartView
      items={[
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
      ]}
    />
  ),
};
export const Navigation: Story = {
  render: function NavigationStory() {
    const [date, setDate] = useState("2026-10-27");
    return (
      <CalendarNavigation
        title="Month"
        date={date}
        timezone="UTC"
        period="month"
        navigate={setDate}
      />
    );
  },
};

export const SelectAppointment: Story = {
  render: () => (
    <CalendarFrame>
      <CalendarMonthView />
    </CalendarFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "09:00 Design review" }),
    );
    const dialog = await within(document.body).findByRole("dialog", {
      name: "Appointment details dialog",
    });
    await expect(
      within(dialog).getByText("Review scope, decisions, and next steps."),
    ).toBeVisible();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close details" }),
    );
  },
};

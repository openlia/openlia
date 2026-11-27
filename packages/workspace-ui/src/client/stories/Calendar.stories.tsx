import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { CalendarView } from "../openui/calendar/Calendar";
import { CalendarEventDetails } from "../openui/calendar/CalendarEventDetails";
import { CalendarEventEditor } from "../openui/calendar/CalendarEventEditor";
import { CalendarMonthView } from "../openui/calendar/CalendarMonth";
import { CalendarWeekView } from "../openui/calendar/CalendarWeek";
import { GanttChartView } from "../openui/calendar/GanttChart";
import {
  primaryCalendarEvent,
  storyInlineCalendarEvents,
  storyShortAndInstantCalendarEvents,
} from "./fixtures";

const meta = {
  title: "OpenUI/Calendar",
  component: CalendarMonthView,
  args: {
    title: "October 2026 Schedule",
    timezone: "UTC",
    date: "2026-10-27",
    events: storyInlineCalendarEvents,
  },
  argTypes: {
    title: { control: "text" },
    timezone: { control: "text" },
    date: { control: "text" },
  },
} satisfies Meta<typeof CalendarMonthView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MonthViewInline: Story = {};

export const MonthViewRemindSource: Story = {
  render: () => (
    <CalendarMonthView
      title="Team Schedule (Remind .rem Source)"
      source="./reminders.rem"
      timezone="UTC"
      date="2026-10-27"
    />
  ),
};

export const MonthViewJsonSource: Story = {
  render: () => (
    <CalendarMonthView
      title="Events (External .json Source)"
      source="./events.json"
      timezone="UTC"
      date="2026-10-27"
    />
  ),
};

export const EmptyMonth: Story = {
  args: {
    title: "Empty Month",
    events: [],
  },
};

export const WeekViewWithOverlaps: Story = {
  render: () => (
    <CalendarWeekView
      title="Sprint Week (Overlapping Timed Events & All-Day Lane)"
      timezone="UTC"
      date="2026-10-27"
      events={storyInlineCalendarEvents}
    />
  ),
};

export const WeekViewTimezone: Story = {
  render: () => (
    <CalendarWeekView
      title="Sprint Week (Asia/Ho_Chi_Minh)"
      timezone="Asia/Ho_Chi_Minh"
      date="2026-10-27"
      events={storyInlineCalendarEvents}
    />
  ),
};

export const WeekViewShortAndInstantEvents: Story = {
  render: () => (
    <CalendarWeekView
      title="Lịch vĩ mô tuần tới · giờ Việt Nam"
      timezone="Asia/Ho_Chi_Minh"
      date="2026-11-30"
      events={storyShortAndInstantCalendarEvents}
    />
  ),
};

export const GanttWeekZoom: Story = {
  render: () => (
    <GanttChartView
      title="Sprint Timeline (Week Zoom)"
      zoom="week"
      timezone="UTC"
      date="2026-10-27"
      events={storyInlineCalendarEvents}
    />
  ),
};

export const GanttMonthGrouped: Story = {
  render: () => (
    <GanttChartView
      title="Q4 Roadmap (Month Zoom · Grouped)"
      zoom="month"
      groupBy="group"
      timezone="UTC"
      date="2026-10-27"
      events={storyInlineCalendarEvents}
    />
  ),
};

export const GanttJsonSource: Story = {
  render: () => (
    <GanttChartView
      title="Q4 Delivery Roadmap (External .json Source)"
      source="./roadmap.json"
      zoom="month"
      groupBy="group"
    />
  ),
};

export const MultiViewContainer: Story = {
  render: () => (
    <CalendarView
      timezone="UTC"
      date="2026-10-27"
      events={storyInlineCalendarEvents}
    >
      <div className="space-y-6">
        <CalendarMonthView title="Month View" />
        <CalendarWeekView title="Week View" />
        <GanttChartView
          title="Gantt Timeline View"
          zoom="week"
          groupBy="group"
        />
      </div>
    </CalendarView>
  ),
};

export const AppointmentDetailsModal: Story = {
  render: function DetailsStory() {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setOpen(true)}
        >
          Open Appointment Details Modal
        </button>
        {open && (
          <CalendarEventDetails
            event={primaryCalendarEvent}
            timezone="Asia/Ho_Chi_Minh"
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    );
  },
};

export const AppointmentEditorModal: Story = {
  render: function EditorStory() {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setOpen(true)}
        >
          Open New Appointment Editor
        </button>
        {open && (
          <CalendarEventEditor
            date="2026-10-27"
            timezone="Asia/Ho_Chi_Minh"
            source="reports/reminders.rem"
            revision="sha256:story"
            onCancel={() => setOpen(false)}
            onSave={async () => {
              setOpen(false);
            }}
          />
        )}
      </div>
    );
  },
};

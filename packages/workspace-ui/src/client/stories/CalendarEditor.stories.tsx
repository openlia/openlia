import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { CalendarEventEditor } from "../openui/calendar/CalendarEventEditor";
import { CalendarEventDetails } from "../openui/calendar/CalendarEventDetails";
import { action, primaryCalendarEvent } from "./fixtures";

const meta = {
  title: "Calendar/Appointment editor",
  parameters: {
    componentExports: [
      "openui/calendar/CalendarEventEditor.tsx#CalendarEventEditor",
      "openui/calendar/CalendarEventDetails.tsx#CalendarEventDetails",
    ],
    docs: {
      description: {
        component:
          "Native dialogs require a single-story Canvas (not simultaneous inline Docs). Saves and file navigation are mock actions only.",
      },
      story: { inline: false },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Editor({ conflict = false }: { conflict?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setOpen(true)}
      >
        New appointment
      </button>
      {open && (
        <CalendarEventEditor
          date="2026-10-27"
          timezone="Asia/Ho_Chi_Minh"
          source="calendar/reminders.rem"
          revision="sha256:story"
          onCancel={() => {
            action("cancel")();
            setOpen(false);
          }}
          onSave={async (event) => {
            action("saveAppointment")(event);
            if (conflict)
              throw new Error("Calendar changed. Reload before saving.");
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
export const UnsavedDraft: Story = { render: () => <Editor /> };
export const SaveConflict: Story = { render: () => <Editor conflict /> };
export const Details: Story = {
  render: function DetailsStory() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Open details
        </button>
        {open && (
          <CalendarEventDetails
            event={primaryCalendarEvent}
            timezone="Asia/Ho_Chi_Minh"
            onClose={() => setOpen(false)}
            onOpenFile={action("openFile")}
          />
        )}
      </>
    );
  },
};
export const InvalidChronology: Story = {
  render: () => <Editor />,
  play: async () => {
    const dialog = within(
      await within(document.body).findByRole("dialog", {
        name: "New appointment",
      }),
    );
    await userEvent.type(dialog.getByLabelText("Title"), "Review");
    const end = dialog.getByLabelText("End");
    await userEvent.clear(end);
    await userEvent.type(end, "2026-10-27T08:00");
    await userEvent.click(
      dialog.getByRole("button", { name: "Save appointment" }),
    );
    await expect(await dialog.findByRole("alert")).toHaveTextContent(
      "End must be after start.",
    );
  },
};

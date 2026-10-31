import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ActionMenu } from "../components/common/ActionMenu";
import { ResponsiveDrawer } from "../components/common/ResponsiveDrawer";

const meta = {
  title: "Foundations/Mobile layout",
  parameters: {
    layout: "fullscreen",
    componentExports: [
      "components/common/ActionMenu.tsx#ActionMenu",
      "components/common/ResponsiveDrawer.tsx#ResponsiveDrawer",
    ],
  },
  globals: { viewport: { value: "mobile", isRotated: false } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Navigator: Story = {
  render: function NavigatorStory() {
    const [open, setOpen] = useState(false);
    return (
      <div className="workspace-app">
        <header className="workspace-header">
          <button
            className="btn btn-ghost"
            type="button"
            onClick={(event) => {
              event.currentTarget.focus();
              setOpen(true);
            }}
          >
            Browse files
          </button>
          <h1 className="workspace-title">Project notes</h1>
        </header>
        <div className="workspace-layout xl:grid-cols-[20rem_1fr]">
          <ResponsiveDrawer
            title="Files"
            open={open}
            onClose={() => setOpen(false)}
          >
            <nav className="p-3 grid gap-2" aria-label="Example files">
              {["Project notes", "Research", "Weekly review"].map((name) => (
                <button
                  className="btn btn-ghost justify-start"
                  key={name}
                  type="button"
                  onClick={() => setOpen(false)}
                >
                  {name}
                </button>
              ))}
            </nav>
          </ResponsiveDrawer>
          <article className="p-4">
            <h2 className="text-xl font-semibold">One focused workspace</h2>
            <p className="mt-3">
              Open the drawer to choose a file. Escape, the close button, or the
              backdrop returns to this page.
            </p>
          </article>
        </div>
      </div>
    );
  },
};

export const OverflowActions: Story = {
  render: () => (
    <div className="workspace-document h-dvh p-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="truncate text-lg font-semibold">
          A document with a very long name
        </h1>
        <ActionMenu label="Example actions">
          <button type="button">Share</button>
          <button type="button">Copy link</button>
          <button type="button">Download</button>
          <button type="button" className="text-error">
            Delete
          </button>
        </ActionMenu>
      </div>
      <p className="mt-4 text-sm text-base-content/60">
        Secondary actions stay out of the reading area.
      </p>
    </div>
  ),
};

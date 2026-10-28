import type { Meta, StoryObj } from "@storybook/react-vite";
import { CopyLinkButton } from "../components/common/CopyLinkButton";
import { action } from "./fixtures";

const meta = {
  title: "Foundations/Controls",
  component: CopyLinkButton,
  argTypes: {
    link: { control: "text" },
    label: { control: "text" },
    iconOnly: { control: "boolean" },
  },
  args: {
    link: "openlia://workspace/projects/review.md",
    label: "Copy link",
    onClick: action("copyLink"),
  },
  tags: ["autodocs"],
  parameters: {
    componentExports: ["components/common/CopyLinkButton.tsx#CopyLinkButton"],
  },
} satisfies Meta<typeof CopyLinkButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CopyLink: Story = {};
export const IconOnly: Story = { args: { iconOnly: true } };
export const ButtonsAndBadges: Story = {
  render: () => (
    <div className="p-4 space-y-6">
      <h1 className="text-2xl font-bold">Workspace design vocabulary</h1>
      <p className="text-sm text-base-content/60">
        The actual DaisyUI dark theme used by the app. These are native
        primitives, not a duplicate design system.
      </p>
      <div className="flex flex-wrap gap-2">
        {[
          { label: "Primary", className: "badge-primary" },
          { label: "Secondary", className: "badge-secondary" },
          { label: "Success", className: "badge-success" },
          { label: "Warning", className: "badge-warning" },
          { label: "Error", className: "badge-error" },
        ].map((tone) => (
          <div
            key={tone.label}
            className="rounded border border-base-content/10 p-3"
          >
            <span className={`badge ${tone.className}`}>{tone.label}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary"
          onClick={action("primary")}
        >
          Primary
        </button>
        <button type="button" className="btn btn-outline">
          Secondary
        </button>
        <button type="button" className="btn btn-ghost">
          Ghost
        </button>
        <button type="button" className="btn" disabled>
          Disabled
        </button>
      </div>
      <label className="block text-sm">
        Example input
        <input
          className="input input-bordered block mt-1"
          placeholder="Review a component"
        />
      </label>
      <div className="alert alert-warning">
        Warnings should state the next safe action.
      </div>
    </div>
  ),
};

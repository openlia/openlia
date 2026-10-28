import type { Meta, StoryObj } from "@storybook/react-vite";
import { App } from "../App";
import { storyData, storyLoader } from "./fixtures";

const meta = {
  title: "Compositions/Workspace",
  loaders: [storyLoader],
  parameters: {
    layout: "fullscreen",
    componentExports: ["App.tsx#App"],
    docs: {
      description: {
        component:
          "The full workspace with an isolated mock API. Use feature stories for focused review; navigation here stays inside the preview iframe.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const LocalWorkspace: Story = {
  render: (_args, { loaded }) => <App api={storyData(loaded).api} />,
};

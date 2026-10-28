import type { Preview } from "@storybook/react-vite";
import MockDate from "mockdate";
import "../src/client/styles.css";
import "../src/client/chat.css";
import "@openuidev/react-ui/index.css";
import { installStoryNetworkGuard } from "../src/client/stories/networkGuard";

MockDate.set("2026-10-27T09:00:00.000Z");
installStoryNetworkGuard();

const preview: Preview = {
  tags: ["autodocs"],
  beforeEach: () => {
    delete document.documentElement.dataset.storybookFinished;
  },
  afterEach: () => {
    document.documentElement.dataset.storybookFinished = "true";
  },
  parameters: {
    layout: "padded",
    controls: { expanded: true },
    a11y: { test: "todo" },
    viewport: {
      options: {
        desktop: {
          name: "Desktop",
          styles: { width: "1440px", height: "1000px" },
          type: "desktop",
        },
        mobile: {
          name: "Mobile",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
    options: {
      storySort: {
        order: [
          "Foundations",
          "Calendar",
          "OpenUI",
          "Documents",
          "Chat",
          "Skills",
          "Ingestion",
          "Workspace",
          "Compositions",
        ],
      },
    },
  },
  decorators: [
    (Story) => (
      <div
        data-story-ready
        data-theme="dark"
        className="min-h-[240px] bg-base-100 text-base-content"
      >
        <Story />
      </div>
    ),
  ],
};

export default preview;

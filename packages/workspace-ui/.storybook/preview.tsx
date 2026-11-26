import { ThemeProvider } from "@openuidev/react-ui";
import type { Preview } from "@storybook/react-vite";
import MockDate from "mockdate";
import "../src/client/styles.css";
import "@openuidev/react-ui/index.css";
import { CHART_THEME } from "../src/client/openui/charts/palette";
import { OpenLiaOpenUIProvider } from "../src/client/openui/context";
import { storyMockApi } from "../src/client/stories/fixtures";

MockDate.set("2026-10-27T09:00:00.000Z");

const preview: Preview = {
  tags: ["autodocs"],
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
        landscapeMobile: {
          name: "Landscape phone",
          styles: { width: "844px", height: "390px" },
          type: "mobile",
        },
      },
    },
    options: {
      storySort: {
        order: ["OpenUI", ["Calendar", "Charts", "Markdown Blocks"]],
      },
    },
  },
  decorators: [
    (Story) => (
      <ThemeProvider
        mode="dark"
        darkTheme={CHART_THEME}
        lightTheme={CHART_THEME}
      >
        <OpenLiaOpenUIProvider
          value={{
            api: storyMockApi,
            filePath: "reports/overview.md",
            scope: "workspace",
          }}
        >
          <div
            data-story-ready
            data-theme="dark"
            className="min-h-[240px] bg-base-100 p-4 text-base-content"
          >
            <Story />
          </div>
        </OpenLiaOpenUIProvider>
      </ThemeProvider>
    ),
  ],
};

export default preview;

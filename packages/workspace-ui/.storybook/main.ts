import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "node:url";

const config: StorybookConfig = {
  stories: ["../src/client/**/*.stories.tsx"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: {
    name: "@storybook/react-vite",
    options: {
      builder: {
        viteConfigPath: fileURLToPath(
          new URL("./vite.config.ts", import.meta.url),
        ),
      },
    },
  },
  core: { disableTelemetry: true },
};

export default config;

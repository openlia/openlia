import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  testDir: `${root}/storybook-tests`,
  outputDir: `${root}/.playwright/storybook`,
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  // Storybook's supported test-runner UA pauses animations during assertions,
  // including DaisyUI's deliberately non-finishing scroll-driven modal animation.
  use: {
    baseURL: "http://127.0.0.1:6007",
    timezoneId: "UTC",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        userAgent: `${devices["Desktop Chrome"]?.userAgent} StorybookTestRunner`,
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        userAgent: `${devices["iPhone 13"]?.userAgent} StorybookTestRunner`,
      },
    },
  ],
  webServer: {
    command: "bun scripts/serve-storybook.ts",
    cwd: root,
    url: "http://127.0.0.1:6007",
    reuseExistingServer: false,
  },
});

import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const workspace = process.env.OPENLIA_INTEGRATION_WORKSPACE;
const state = process.env.OPENLIA_INTEGRATION_STATE;
if (!workspace || !state) {
  throw new Error(
    "Use scripts/test_templates_integration.py to create an isolated catalog workspace",
  );
}
const baseURL = `http://127.0.0.1:${process.env.OPENLIA_WORKSPACE_UI_DEV_PORT ?? "5173"}`;

export default defineConfig({
  testDir: `${packageRoot}/e2e`,
  testMatch: "calendar.spec.ts",
  outputDir: `${packageRoot}/.playwright/templates-results`,
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: `${packageRoot}/.playwright/templates-report`,
      },
    ],
  ],
  use: {
    baseURL,
    colorScheme: "light",
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    timezoneId: "UTC",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { height: 1000, width: 1440 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
  webServer: {
    command: "bun run dev:real",
    cwd: packageRoot,
    reuseExistingServer: false,
    timeout: 120_000,
    url: baseURL,
    env: {
      OPENLIA_WORKSPACE_ROOT: workspace,
      OPENLIA_SKILLS_ROOT: `${state}/skills`,
      OPENLIA_MEMORIES_ROOT: `${state}/memories`,
      OPENLIA_CRON_ROOT: `${state}/cron`,
      OPENLIA_INGESTION_ROOT: `${state}/ingestion`,
      WORKSPACE_UI_E2E_FIXTURE: "false",
      WORKSPACE_UI_E2E_MODE: "real",
    },
  },
});

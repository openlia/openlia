import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const realWorkspace = process.env.WORKSPACE_UI_E2E_MODE === "real";
const baseURL = "http://127.0.0.1:5173";
const e2eWorkspace = `${packageRoot}/.e2e-workspace`;
const e2eSkills = `${packageRoot}/.e2e-skills`;

export default defineConfig({
  testDir: `${packageRoot}/e2e`,
  outputDir: `${packageRoot}/.playwright/results`,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: `${packageRoot}/.playwright/report`,
      },
    ],
  ],
  use: {
    baseURL,
    colorScheme: "light",
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    timezoneId: "UTC",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 1,
        viewport: { height: 1000, width: 1440 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    command: realWorkspace ? "bun run dev:real" : "bun run dev",
    cwd: packageRoot,
    reuseExistingServer: false,
    timeout: 120_000,
    url: baseURL,
    ...(realWorkspace
      ? {
          env: {
            OPENLIA_SKILLS_ROOT: e2eSkills,
            OPENLIA_WORKSPACE_ROOT: e2eWorkspace,
            WORKSPACE_UI_E2E_FIXTURE: "true",
          },
        }
      : {}),
  },
});

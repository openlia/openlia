import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const outputDir = "/Users/quangtran/.gemini/antigravity-cli/brain/84078949-9a4a-4dae-aad2-c3df776e2062/screenshots";
mkdirSync(outputDir, { recursive: true });

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1500, height: 960 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  console.log("1. Navigating and logging into Workspace UI...");
  await page.goto("http://127.0.0.1:8089/");
  await page.waitForTimeout(1000);

  const pwdInput = page.locator('input[type="password"]');
  if (await pwdInput.isVisible()) {
    console.log("   Entering password...");
    await pwdInput.fill("password@123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForTimeout(2000);
  }

  // Screenshot 1: Projects Dashboard (OpenUI Domain Dashboard with Kanban & Table)
  console.log("2. Capturing 01_projects_domain_dashboard.png...");
  await page.goto("http://127.0.0.1:8089/files/projects");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outputDir, "01_projects_domain_dashboard.png") });

  // Screenshot 2: Project Apollo Visual Record View (OpenUI Record view with Checklist & Frontmatter cards)
  console.log("3. Capturing 02_project_apollo_visual_record.png...");
  await page.goto("http://127.0.0.1:8089/files/projects/project-apollo.md?view=visual");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outputDir, "02_project_apollo_visual_record.png") });

  // Screenshot 3: Project Apollo Markdown/Code Mode
  console.log("4. Capturing 03_project_apollo_code_editor.png...");
  await page.goto("http://127.0.0.1:8089/files/projects/project-apollo.md");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outputDir, "03_project_apollo_code_editor.png") });

  // Screenshot 4: Tasks Domain Dashboard
  console.log("5. Capturing 04_tasks_domain_dashboard.png...");
  await page.goto("http://127.0.0.1:8089/files/tasks");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outputDir, "04_tasks_domain_dashboard.png") });

  // Screenshot 5: Calendar Meeting Event Note
  console.log("6. Capturing 05_calendar_meeting_event.png...");
  await page.goto("http://127.0.0.1:8089/files/calendar/2026-10-25-q4-product-roadmap-planning.md");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outputDir, "05_calendar_meeting_event.png") });

  // Screenshot 6: Inbox Ingestion Proposals (Live Ingestion Review)
  console.log("7. Capturing 06_inbox_ingestion_review.png...");
  await page.goto("http://127.0.0.1:8089/files/inbox/2026-10-25-flight-and-gear-watches.md");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outputDir, "06_inbox_ingestion_review.png") });

  // Screenshot 7: E2E Comparison UI - Scenario 01 (Alex - Freelance Nomad)
  console.log("8. Capturing 07_e2e_comparison_scenario_01.png...");
  await page.goto("http://127.0.0.1:8099/");
  await page.waitForTimeout(2000);
  const alexItem = page.locator('.scenario-item:has-text("Alex")');
  if (await alexItem.isVisible()) {
    await alexItem.click();
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: join(outputDir, "07_e2e_comparison_scenario_01.png") });

  // Screenshot 8: E2E Comparison UI - Scenario 02 (Jordan - Knowledge Worker PKM)
  console.log("9. Capturing 08_e2e_comparison_scenario_02.png...");
  const jordanItem = page.locator('.scenario-item:has-text("Jordan")');
  if (await jordanItem.isVisible()) {
    await jordanItem.click();
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: join(outputDir, "08_e2e_comparison_scenario_02.png") });

  await browser.close();
  console.log("Done! All review screenshots captured in:", outputDir);
}

run().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});

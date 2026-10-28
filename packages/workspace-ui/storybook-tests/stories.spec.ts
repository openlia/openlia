import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

interface Entry {
  id: string;
  title: string;
  name: string;
  type: string;
}
const index = JSON.parse(
  readFileSync(
    new URL("../.storybook-static/index.json", import.meta.url),
    "utf8",
  ),
) as { entries: Record<string, Entry> };
for (const story of Object.values(index.entries).filter(
  (entry) => entry.type === "story",
)) {
  test(`${story.title} / ${story.name}`, async ({ page }) => {
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        (url.origin !== "http://127.0.0.1:6007" ||
          /^\/(api|_server)\//.test(url.pathname))
      ) {
        requests.push(url.pathname);
        await route.abort();
        return;
      }
      await route.continue();
    });
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    await expect(page.locator("[data-story-ready]")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-storybook-finished",
      "true",
    );
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-storybook-blocked-request",
    );
    await expect(page.locator(".sb-errordisplay")).not.toBeVisible();
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
  });
}

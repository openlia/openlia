import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openUIRecipes } from "../src/shared/openuiRecipes";

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
    if (
      story.id === "openui-inline-markdown--calendar" ||
      story.id === "openui-inline-markdown--inline-calendar"
    ) {
      const month = page.getByRole("region", { name: "Month calendar" });
      await expect(month).toHaveAttribute("aria-busy", "false");
      const table = month.getByRole("table", { name: "Calendar month dates" });
      await expect(table).toHaveCSS("display", "table");
      await expect(table).toHaveCSS("table-layout", "fixed");

      // Long appointment titles must not change the seven column widths.
      if (story.id === "openui-inline-markdown--calendar")
        await table
          .getByRole("button")
          .first()
          .evaluate((button) => {
            button.textContent = "A very long appointment title ".repeat(20);
          });
      const widths = await table
        .getByRole("columnheader")
        .evaluateAll((cells) =>
          cells.map((cell) => cell.getBoundingClientRect().width),
        );
      expect(widths).toHaveLength(7);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);

      const layout = await table.evaluate((element) => {
        const wrapper = element.parentElement;
        if (!wrapper) throw new Error("Calendar scroll wrapper is missing");
        return {
          table: element.getBoundingClientRect().width,
          wrapper: wrapper.clientWidth,
          overflow: getComputedStyle(wrapper).overflowX,
        };
      });
      expect(layout.table).toBeGreaterThanOrEqual(560);
      expect(layout.table).toBeGreaterThanOrEqual(layout.wrapper - 1);
      expect(layout.overflow).toBe("auto");
    }
    if (story.id === "openui-inline-markdown--inline-calendar") {
      await expect(page.getByText("Inline events · read-only")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "New appointment" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Reload calendar" }),
      ).toHaveCount(0);
      await expect(page.getByTestId("inline-openui-error")).toHaveCount(0);
      const month = page.getByRole("region", { name: "Month calendar" });
      await expect(
        month
          .getByRole("cell", { name: "2026-10-28", exact: true })
          .getByRole("button", { name: "Conference" }),
      ).toHaveCount(1);
      await expect(
        month
          .getByRole("cell", { name: "2026-10-29", exact: true })
          .getByRole("button", { name: "Conference" }),
      ).toHaveCount(0);
      await month.getByRole("button", { name: /09:00 Project review/ }).click();
      const details = page.getByRole("region", { name: "Appointment details" });
      await expect(details).toContainText("Review milestones");
      await expect(details).toContainText("Alice, Bob");
      await expect(details).not.toContainText("NOQUEUE");
      await expect(details).not.toContainText("Source:");
      await expect(
        details.getByRole("button", { name: "Open calendar source" }),
      ).toHaveCount(0);
      await details.getByRole("button", { name: "Close details" }).click();
      await page.getByLabel("Display timezone").fill("Asia/Ho_Chi_Minh");
      await page.getByLabel("Display timezone").press("Tab");
      await expect(
        month.getByRole("button", { name: /16:00 Project review/ }),
      ).toHaveCount(1);
      await month.getByRole("button", { name: "Next month" }).click();
      await expect(month).toContainText("2026-11-01");
      await month.getByRole("button", { name: "Today", exact: true }).click();
      await expect(month).toContainText("2026-10-27");
      const week = page.getByRole("region", { name: "Week calendar" });
      await expect(
        week.getByRole("button", { name: "Conference", exact: true }),
      ).toHaveCount(3);
      const review = week.getByRole("button", { name: /16:00 Project review/ });
      await expect(review).toHaveAttribute("style", /width: 50%/);
      const timeline = page.getByRole("region", {
        name: "Event duration timeline",
      });
      await expect(
        timeline.getByRole("heading", { name: "Inline events", exact: true }),
      ).toHaveCount(1);
      await timeline.getByLabel("Timeline zoom").selectOption("month");
      await timeline
        .getByRole("button", { name: /Open Project review/ })
        .click();
      await expect(details).toContainText("Asia/Ho_Chi_Minh");
      await details.getByRole("button", { name: "Close details" }).click();
      expect(requests).toEqual([]);
    }
    if (story.id === "openui-inline-markdown--empty-inline-calendar") {
      await expect(page.getByText("Inline events · read-only")).toBeVisible();
      await expect(page.getByText("No events in this range.")).toHaveCount(1);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "New appointment" }),
      ).toHaveCount(0);
    }
    if (story.id === "openui-inline-markdown--authoring-recipes") {
      await expect(page.getByTestId("inline-openui-block")).toHaveCount(
        openUIRecipes.length,
      );
      await expect(page.getByTestId("inline-openui-error")).toHaveCount(0);
      await expect(
        page.getByRole("alert", { name: "OpenUI render error" }),
      ).toHaveCount(0);
      await expect(page.getByRole("cell", { name: "Phở bò" })).toBeVisible();
      await page.getByRole("tab", { name: "Details", exact: true }).click();
      await expect(
        page.getByText("More information", { exact: true }),
      ).toBeVisible();
    }
  });
}

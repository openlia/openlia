import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./screenshot";

test.describe("native Calendar project", () => {
  test.skip(
    process.env.WORKSPACE_UI_E2E_MODE !== "real",
    "Requires the real workspace backend and native Remind",
  );

  test("inspects a draft safely, saves, reloads, and reopens across three views", async ({
    page,
  }, testInfo) => {
    const title = `Appointment UI ${crypto.randomUUID()}`;
    const today = new Date().toISOString().slice(0, 10);
    await page.goto("/files/calendar/overview.md");
    await expect(
      page.getByRole("button", { name: "New appointment", exact: true }),
    ).toBeEnabled();
    const writes: string[] = [];
    page.on("request", (request) => {
      // TanStack Start transports API calls through a server-function POST.
      const body = request.postData() ?? "";
      if (
        request.method() === "POST" &&
        body.includes("requestId") &&
        body.includes(title)
      )
        writes.push(body);
    });
    await page
      .getByRole("button", { name: "New appointment", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "New appointment" });
    await expect(dialog.getByLabel("Start", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("End", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Appointment timezone")).toBeVisible();
    await expect(
      dialog.getByLabel("Notifications — off (delivery unavailable)"),
    ).not.toBeChecked();
    await expect(
      dialog.getByLabel("Send invitations — off (delivery unavailable)"),
    ).toBeDisabled();
    await captureScreenshot(page, testInfo, "calendar-unsaved-appointment");
    await dialog
      .getByLabel("Notifications — off (delivery unavailable)")
      .scrollIntoViewIfNeeded();
    await expect(
      dialog.getByLabel("Notifications — off (delivery unavailable)"),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "calendar-safe-defaults");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(writes).toHaveLength(0);

    await page
      .getByRole("button", { name: "New appointment", exact: true })
      .click();
    await dialog.getByLabel("Title", { exact: true }).fill(title);
    await dialog.getByLabel("Appointment timezone").fill("Asia/Ho_Chi_Minh");
    await dialog.getByLabel("Start", { exact: true }).fill(`${today}T09:00`);
    await dialog.getByLabel("End", { exact: true }).fill(`${today}T10:30`);
    await dialog
      .getByLabel("Agenda", { exact: true })
      .fill("Verify browser persistence — no invitations");
    await dialog.getByLabel("Attendees (one per line)").fill("Alice\nBob");
    await dialog
      .getByRole("button", { name: "Save appointment", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toHaveLength(1);
    await expect(
      page.getByRole("region", { name: "Appointment details" }),
    ).toContainText(title);

    await page.reload();
    await expect(
      page.getByRole("button", { name: "New appointment", exact: true }),
    ).toBeEnabled();
    await page.getByRole("tab", { name: "Month", exact: true }).click();
    const month = page.getByRole("region", { name: "Month calendar" });
    const overflow = month
      .getByRole("cell", { name: today, exact: true })
      .locator("summary");
    if (await overflow.count()) await overflow.click();
    await month.getByRole("button", { name: new RegExp(title) }).click();
    const details = page.getByRole("region", { name: "Appointment details" });
    await expect(details).toContainText(
      "Verify browser persistence — no invitations",
    );
    await expect(details).toContainText("Asia/Ho_Chi_Minh");
    await expect(details).toContainText("09:00");
    await expect(details).toContainText("10:30");
    await expect(details).toContainText("Alice, Bob");
    await expect(details).toContainText("Off (NOQUEUE)");
    await expect(details).toContainText("No invitations sent by this UI");
    await captureScreenshot(page, testInfo, "calendar-appointment-reopened");
    await details
      .getByRole("button", { name: "Close details", exact: true })
      .click();
    await month.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "calendar-month");
    await page.getByRole("tab", { name: "Week", exact: true }).click();
    const weekEvent = page
      .getByRole("region", { name: "Week calendar" })
      .getByRole("button", { name: new RegExp(title) });
    await weekEvent.scrollIntoViewIfNeeded();
    await expect(weekEvent).toBeVisible();
    await captureScreenshot(page, testInfo, "calendar-week");
    await weekEvent.click();
    await expect(details).toBeVisible();
    await expect(details).toContainText(title);
    await details
      .getByRole("button", { name: "Close details", exact: true })
      .click();
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    const timelineEvent = page
      .getByRole("region", { name: "Event duration timeline" })
      .getByRole("button", { name: `Open ${title}` });
    await expect(timelineEvent).toBeVisible();
    await captureScreenshot(page, testInfo, "calendar-timeline");
    await timelineEvent.click();
    await expect(details).toBeVisible();
    await expect(details).toContainText(title);
  });
});

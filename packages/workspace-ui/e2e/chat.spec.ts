import { expect, test } from "@playwright/test";

test("native chat navigation, history, and conversation actions", async ({
  page,
}) => {
  await page.goto("/chat");
  if ((page.viewportSize()?.width ?? 1440) < 768)
    await page
      .getByRole("button", { name: "Open conversations", exact: true })
      .click();
  await page.getByRole("button", { name: "Getting started with Lia" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Lia" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message Lia" })
    .fill("Help with my workspace");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText("This is a mock reply.", { exact: false }),
  ).toBeVisible({ timeout: 10000 });
  await page.getByLabel("Conversation options").click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Conversation title" })
    .fill("Workspace planning");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace planning" }),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 1440) < 768)
    await page
      .getByRole("button", { name: "Open conversations", exact: true })
      .click();
  await page
    .getByRole("combobox", { name: "Conversation source" })
    .selectOption("other");
  await page.getByRole("button", { name: "Telegram conversation" }).click();
  await expect(
    page.getByText("Read-only history from another Hermes interface."),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Lia" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Delete", exact: true }),
  ).toHaveCount(0);
});

test("tool-heavy chat keeps the conversation readable on desktop and mobile", async ({
  page,
}, testInfo) => {
  await page.goto("/chat?conversation=demo-tools");
  const transcript = page.getByRole("region", {
    name: "Conversation messages",
  });
  await expect(page.getByText("Used 3 tools", { exact: true })).toBeVisible();
  await expect(transcript.getByRole("article")).toHaveCount(2);
  await expect(
    page.getByText("Used 3 tools").locator(".."),
  ).not.toHaveAttribute("open", "");
  const bounds = await transcript.boundingBox();
  expect(bounds?.height ?? 0).toBeGreaterThan(
    (page.viewportSize()?.height ?? 1000) * 0.5,
  );
  const input = page.getByRole("textbox", { name: "Message Lia" });
  const composer = input.locator("xpath=ancestor::form");
  expect((await composer.boundingBox())?.height ?? 1000).toBeLessThan(135);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `.playwright/screenshots/chat-${testInfo.project.name}.png`,
    fullPage: true,
  });
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    const trigger = page.getByRole("button", {
      name: "Open conversations",
      exact: true,
    });
    await trigger.click();
    await expect(
      page.getByRole("dialog", { name: "Conversations" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Conversations" }),
    ).not.toBeVisible();
    await expect(trigger).toBeFocused();
  }
  await page.getByText("Used 3 tools", { exact: true }).click();
  await expect(page.getByText("Tool calls (3)")).toBeVisible();
});

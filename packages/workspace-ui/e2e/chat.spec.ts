import { expect, test } from "@playwright/test";

test("native chat navigation, history, and conversation actions", async ({
  page,
}) => {
  await page.goto("/chat");
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
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Conversation title" })
    .fill("Workspace planning");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace planning" }),
  ).toBeVisible();
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

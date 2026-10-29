import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const fixtureName = `inline-openui-${randomUUID()}`;
const fixtureRoot = resolve(
  import.meta.dirname,
  "../.e2e-workspace",
  fixtureName,
);

test.describe("inline Markdown OpenUI", () => {
  test.skip(
    process.env.WORKSPACE_UI_E2E_MODE !== "real",
    "Requires the real workspace backend",
  );
  test.beforeAll(() => {
    mkdirSync(fixtureRoot, { recursive: true });
    writeFileSync(
      join(fixtureRoot, "menu.md"),
      '# Thực đơn ngày 29/10/2026\n\nBefore the menu.\n\n```openui\nTable(title: "Thực đơn", columns: [{key: "dish", label: "Món ăn"}], rows: [{dish: "Phở bò"}])\n```\n\n```openui\nCardHeader(titel: "Invalid")\n```\n\nAfter the menu.\n',
    );
  });
  test.afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  test("renders row tables and isolates malformed blocks", async ({ page }) => {
    await page.goto(`/files/${fixtureName}/menu.md`);
    await expect(
      page.getByRole("heading", { name: "Thực đơn ngày 29/10/2026" }),
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: "Phở bò" })).toBeVisible();
    await expect(page.getByTestId("inline-openui-block")).toHaveCount(1);
    await expect(page.getByTestId("inline-openui-error")).toContainText(
      "titel",
    );
    await expect(page.getByText("After the menu.")).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Workspace navigation" })
        .getByRole("button", { name: "Projects", exact: true }),
    ).toHaveCount(0);
  });
});

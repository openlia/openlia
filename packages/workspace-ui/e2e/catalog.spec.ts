import { expect, type Locator, type Page, test } from "@playwright/test";
import { captureScreenshot } from "./screenshot";

const realWorkspace = process.env.WORKSPACE_UI_E2E_MODE === "real";

async function personalAppsAvailable(page: Page): Promise<boolean> {
  if (!realWorkspace) return true;
  const response = await page.request.get("/api/features");
  expect(response.ok()).toBe(true);
  const catalog = await response.json();
  return ["personal-finance", "personal-health"].every((id) =>
    catalog.features.some(
      (feature: { id: string; minions?: string[] }) =>
        feature.id === id && feature.minions?.includes(id),
    ),
  );
}

async function visibleLocator(locator: Locator): Promise<Locator> {
  return locator.locator("visible=true").first();
}

async function switchWorkspaceTab(page: Page, tabName: string): Promise<void> {
  const navMenuBtn = page.getByRole("button", {
    exact: true,
    name: "Open workspace navigation",
  });
  if (await navMenuBtn.isVisible()) {
    await navMenuBtn.click();
  }
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { exact: true, name: tabName })
    .click();
}

async function openFilesContainer(page: Page): Promise<Locator> {
  const filesButton = page.getByRole("button", {
    exact: true,
    name: "Open files drawer",
  });
  if (await filesButton.isVisible()) {
    await filesButton.click();
    const dialog = page.getByRole("dialog", { name: "Workspace files" });
    await expect(dialog).toBeVisible();
    return dialog;
  }
  return page.getByLabel("Workspace files").first();
}

async function openSkillsDrawerIfNeeded(page: Page): Promise<void> {
  const skillsButton = page.getByRole("button", {
    exact: true,
    name: "Open skills drawer",
  });
  if (await skillsButton.isVisible()) {
    await skillsButton.click();
  }
}

test.describe("feature catalog and installation", () => {
  test("signs in, installs gym-tracker, personal-finance, and personal-health sequentially, preserves state across reload, and verifies installed artifacts", async ({
    page,
  }, testInfo) => {
    // 1. Sign in (when auth gate is active) and open the catalog
    await page.goto(realWorkspace ? "/" : "/?scenario=auth");

    const passwordInput = page.getByLabel("Password");
    await expect(
      passwordInput.or(page.locator(".workspace-header")),
    ).toBeVisible();
    if (await passwordInput.isVisible()) {
      await passwordInput.fill(
        process.env.OPENLIA_WORKSPACE_UI_PASSWORD ??
          "local-playwright-password",
      );
      await page.getByRole("button", { name: "Sign in" }).click();
    }

    await expect(page.locator(".workspace-header")).toBeVisible();
    const personalApps = await personalAppsAvailable(page);
    await switchWorkspaceTab(page, "Catalog");
    await expect(page).toHaveURL(/\/catalog$/);
    await expect(page.getByTestId("catalog-page")).toBeVisible();

    // Verify all three catalog features and their requirements/distinctions are displayed
    const gymCard = page.getByTestId("catalog-feature-card-gym-tracker");
    const financeCard = page.getByTestId(
      "catalog-feature-card-personal-finance",
    );
    const healthCard = page.getByTestId("catalog-feature-card-personal-health");

    await expect(gymCard).toBeVisible();
    await expect(financeCard).toBeVisible();
    await expect(healthCard).toBeVisible();

    await expect(
      page.getByTestId("catalog-package-kind-gym-tracker"),
    ).toHaveText("Minion App Package");
    await expect(
      page.getByTestId("catalog-package-kind-personal-finance"),
    ).toHaveText(
      personalApps ? "Minion App Package" : "Domains & Skills Package",
    );
    await expect(
      page.getByTestId("catalog-package-kind-personal-health"),
    ).toHaveText(
      personalApps ? "Minion App Package" : "Domains & Skills Package",
    );

    // Verify declared hledger requirement on personal-finance
    await expect(
      page.getByTestId("catalog-required-tool-personal-finance-hledger"),
    ).toContainText("hledger");

    await captureScreenshot(page, testInfo, "catalog-initial-browse");

    // 2. Install gym-tracker, personal-finance, and personal-health sequentially
    for (const featureId of [
      "gym-tracker",
      "personal-finance",
      "personal-health",
    ]) {
      const statusBadge = page.getByTestId(
        `catalog-feature-status-${featureId}`,
      );
      const currentStatus = (await statusBadge.textContent())?.trim();
      if (currentStatus !== "Installed") {
        await page.getByTestId(`catalog-install-${featureId}`).click();
        await expect(page.getByTestId("catalog-install-result")).toBeVisible();
        await expect(
          page.getByTestId(`catalog-install-result-${featureId}`),
        ).toBeVisible();
      }
      await expect(statusBadge).toHaveText("Installed");
      await captureScreenshot(page, testInfo, `catalog-installed-${featureId}`);
    }

    // 3. Reload and verify each feature remains installed
    await page.reload();
    await expect(page.getByTestId("catalog-page")).toBeVisible();
    for (const featureId of [
      "gym-tracker",
      "personal-finance",
      "personal-health",
    ]) {
      await expect(
        page.getByTestId(`catalog-feature-status-${featureId}`),
      ).toHaveText("Installed");
    }
    await captureScreenshot(page, testInfo, "catalog-after-reload");

    // 4a. Verify gym-tracker Minion is discoverable in Minions tab
    await switchWorkspaceTab(page, "Minions");
    await expect(page).toHaveURL(/\/minions/);

    const browseMinionsBtn = page.getByRole("button", {
      name: /Browse minions/i,
    });
    if (await browseMinionsBtn.isVisible()) {
      await browseMinionsBtn.click();
    }

    const gymMinionItem = await visibleLocator(
      page.getByTestId("minion-item-gym-tracker"),
    );
    await expect(gymMinionItem).toBeVisible();
    await gymMinionItem.click();
    await expect(
      page.getByRole("heading", { name: /Gym Tracker|gym-tracker/i }).first(),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "catalog-verified-gym-tracker");

    // 4b. Both new apps are discoverable, and their portable document contracts
    // remain accessible without seeding any instance data.
    for (const id of ["personal-finance", "personal-health"]) {
      if (!personalApps) continue;
      await switchWorkspaceTab(page, "Minions");
      if (await browseMinionsBtn.isVisible()) await browseMinionsBtn.click();
      const item = await visibleLocator(page.getByTestId(`minion-item-${id}`));
      await expect(item).toBeVisible();
      await item.click();
      await expect(
        page
          .getByRole("region", { name: "Minion workspace" })
          .getByRole("heading", {
            name: new RegExp(id.replaceAll("-", "[ -]"), "i"),
          })
          .first(),
      ).toBeVisible();
    }
    await switchWorkspaceTab(page, "Documents");
    const filesContainer = await openFilesContainer(page);
    const expand = async (path: string) => {
      const directory = filesContainer.getByTestId(
        `workspace-directory-${path}`,
      );
      await expect(directory).toBeVisible();
      if ((await directory.getAttribute("aria-expanded")) !== "true")
        await directory.click();
    };
    if (personalApps) await expand("minions");
    for (const [id, collections] of [
      ["personal-finance", ["intake", "accounts", "portfolios", "reviews"]],
      [
        "personal-health",
        ["profiles", "history", "conditions", "treatments", "reviews"],
      ],
    ] as const) {
      if (personalApps) await expand(`minions/${id}`);
      const path = personalApps
        ? `minions/${id}/templates`
        : id.replace("personal-", "");
      await expand(path);
      for (const collection of collections) {
        await expect(
          filesContainer.getByTestId(
            `workspace-directory-${path}/${collection}`,
          ),
        ).toBeVisible();
      }
    }
    await captureScreenshot(page, testInfo, "catalog-verified-domains");

    // Close mobile files drawer if open before switching tabs
    const closeFilesDrawer = page
      .getByRole("dialog", { name: "Workspace files" })
      .getByRole("button", { name: "Close" });
    if (await closeFilesDrawer.isVisible()) {
      await closeFilesDrawer.click();
    }

    // 4c. Verify personal-finance and personal-health skills in Skills tab
    await switchWorkspaceTab(page, "Skills");
    await expect(page).toHaveURL(/\/skills/);
    await openSkillsDrawerIfNeeded(page);
    await expect(
      await visibleLocator(page.getByTestId("skill-item-personal-finance")),
    ).toBeVisible();
    await expect(
      await visibleLocator(page.getByTestId("skill-item-personal-health")),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "catalog-verified-skills");
  });

  test("real personal app forms preserve confirmed finance and person-scoped health input after reload", async ({
    page,
  }) => {
    test.skip(
      !realWorkspace,
      "Requires the isolated real-backend catalog workspace",
    );
    await page.goto("/");
    test.skip(
      !(await personalAppsAvailable(page)),
      "Selected catalog does not declare personal apps; run the paired catalog revision for app acceptance",
    );
    test.setTimeout(60_000);
    const selectValue = async (name: string, value: string) => {
      const control = page.locator(`[name="${name}"]`).first();
      if (
        (await control.count()) &&
        (await control.evaluate((element) => element.tagName === "SELECT"))
      ) {
        await control.selectOption(value);
      } else {
        const labels: Record<string, string> = {
          action: "Action",
          proposal_id: "Proposal",
          record_type: "Record type",
          relationship_to_user: "Relationship (profiles only)",
        };
        const choices: Record<string, string> = {
          confirm: "Confirm posting",
          profile: "Profile",
          measurement: "Measurement",
          self: "Self",
        };
        const label = labels[name];
        if (!label) throw new Error(`Unknown form control: ${name}`);
        const combo = page
          .getByText(label, { exact: true })
          .locator("..")
          .getByRole("combobox");
        await combo.click();
        await page
          .getByRole("option", { name: choices[value] ?? value, exact: true })
          .click();
      }
    };
    const section = async (name: "input" | "dashboard") => {
      const compact = page.getByRole("combobox", {
        name: "Minion section",
        exact: true,
      });
      const control = compact
        .or(page.getByTestId(`minion-tab-${name}`))
        .locator("visible=true")
        .first();
      await expect(control).toBeVisible();
      if (await control.evaluate((element) => element.tagName === "SELECT"))
        await control.selectOption(name);
      else await control.click();
    };
    const openApp = async (id: string) => {
      await page.goto(`/minions/${id}`);
      await expect(
        page.getByRole("region", { name: "Minion workspace" }),
      ).toBeVisible();
      await section("input");
    };
    const submit = async (id: string, button: string) => {
      const pending = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/minions/${id}/input`) &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: button, exact: true }).click();
      const response = await pending;
      const body = await response.json();
      expect(response.ok(), JSON.stringify(body)).toBe(true);
      expect(body.ok, body.stderr).toBe(true);
      return body;
    };
    const journalUrl =
      "/api/workspace/file?" +
      new URLSearchParams({
        path: "minions/personal-finance/data/journal.hledger",
      });
    const original = await page.request.get(journalUrl);
    const before = original.ok() ? await original.text() : "";
    const description = `Synthetic browser posting ${crypto.randomUUID()}`;
    await openApp("personal-finance");
    for (const [name, value] of Object.entries({
      date: "2026-10-02",
      description,
      amount: "1.01",
      commodity: "USD",
      debit_account: "expenses:test",
      credit_account: "assets:test",
    })) {
      await page.locator(`input[name="${name}"]`).fill(value);
    }
    const preview = await submit("personal-finance", "Validate & Preview");
    const identifier = JSON.parse(preview.stdout).proposal_id;
    const untouched = await page.request.get(journalUrl);
    expect(untouched.ok() ? await untouched.text() : "").toBe(before);
    await section("dashboard");
    await expect(page.getByTestId("minion-openui-dashboard")).toContainText(
      description,
    );
    await selectValue("action", "confirm");
    await selectValue("proposal_id", identifier);
    await page.locator('input[name="confirmation"]').fill("POST");
    await submit("personal-finance", "Apply selected action");
    const posted = await page.request.get(journalUrl);
    expect(await posted.text()).toContain(description);
    await page.reload();
    await expect(page.getByTestId("minion-openui-dashboard")).toContainText(
      description,
    );
    await page
      .getByRole("button", { name: "Open main journal", exact: true })
      .click();
    await expect(page).toHaveURL(
      /\/files\/minions\/personal-finance\/data\/journal\.hledger(?:\?|$)/,
    );

    const person = `synthetic-${crypto.randomUUID().slice(0, 8)}`;
    await openApp("personal-health");
    await selectValue("record_type", "profile");
    await page.locator('input[name="person_id"]').fill(person);
    await page
      .locator('input[name="title"]')
      .fill(`Synthetic Person ${person}`);
    await selectValue("relationship_to_user", "self");
    await submit("personal-health", "Save health record");
    await section("input");
    await selectValue("record_type", "measurement");
    await page.locator('input[name="person_id"]').fill(person);
    await page
      .locator('input[name="title"]')
      .fill(`Synthetic measurement ${person}`);
    await page.locator('input[name="event_date"]').fill("2026-10");
    await page.locator('input[name="value"]').fill("0.10");
    await page.locator('input[name="unit"]').fill("mg");
    await submit("personal-health", "Save health record");
    await section("dashboard");
    await expect(page.getByTestId("minion-openui-dashboard")).toContainText(
      `${person} (self)`,
    );
    await expect(page.getByTestId("minion-openui-dashboard")).toContainText(
      "0.10 mg",
    );
    await page.reload();
    await expect(page.getByTestId("minion-openui-dashboard")).toContainText(
      `Synthetic measurement ${person}`,
    );
    for (const id of ["personal-finance", "personal-health"]) {
      const response = await page.request.get(`/api/minions/${id}`);
      const body = await response.json();
      expect(body.minion.config.trigger).toEqual({ on_new_entry: false });
    }
  });
});

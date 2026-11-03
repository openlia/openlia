import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ApiError } from "./api";
import { CatalogPage } from "./CatalogPage";
import { createMockWorkspaceApi } from "./mockApi";

test("lists all three Minion App packages and shows requirements including hledger", async () => {
  const api = createMockWorkspaceApi();
  render(
    <CatalogPage
      api={api}
      onOpenMinion={vi.fn()}
      onOpenDomain={vi.fn()}
      onOpenSkill={vi.fn()}
    />,
  );

  const gymCard = await screen.findByTestId("catalog-feature-card-gym-tracker");
  const financeCard = await screen.findByTestId(
    "catalog-feature-card-personal-finance",
  );
  const healthCard = await screen.findByTestId(
    "catalog-feature-card-personal-health",
  );

  expect(gymCard).toHaveTextContent("Minion App Package");
  expect(gymCard).toHaveTextContent("Available");
  expect(gymCard).toHaveTextContent("Minion: minions/gym-tracker");

  expect(financeCard).toHaveTextContent("Minion App Package");
  expect(financeCard).toHaveTextContent("requires tool: hledger");
  expect(financeCard).toHaveTextContent("Minion: minions/personal-finance");
  expect(financeCard).toHaveTextContent("Skill: personal-finance");

  expect(healthCard).toHaveTextContent("Minion App Package");
  expect(healthCard).toHaveTextContent("Minion: minions/personal-health");
  expect(healthCard).toHaveTextContent("Skill: personal-health");

  // Select personal-finance and verify detail panel contents and requirements
  fireEvent.click(screen.getByTestId("catalog-select-personal-finance"));
  const detailPanel = screen.getByTestId("catalog-detail-panel");
  expect(detailPanel).toHaveTextContent("minions/personal-finance");
  expect(detailPanel).toHaveTextContent("hledger");
});

test("installs features, displays installation results, and navigates to installed artifacts", async () => {
  const api = createMockWorkspaceApi();
  const onOpenMinion = vi.fn();
  const onOpenDomain = vi.fn();
  const onOpenSkill = vi.fn();
  const onFeatureInstalled = vi.fn();

  render(
    <CatalogPage
      api={api}
      onOpenMinion={onOpenMinion}
      onOpenDomain={onOpenDomain}
      onOpenSkill={onOpenSkill}
      onFeatureInstalled={onFeatureInstalled}
    />,
  );

  const installGymBtn = await screen.findByTestId(
    "catalog-install-gym-tracker",
  );
  fireEvent.click(installGymBtn);

  const resultBanner = await screen.findByTestId("catalog-install-result");
  expect(resultBanner).toHaveTextContent(
    "Successfully installed package gym-tracker",
  );
  expect(
    screen.getByTestId("catalog-feature-status-gym-tracker"),
  ).toHaveTextContent("Installed");
  expect(onFeatureInstalled).toHaveBeenCalledTimes(1);

  fireEvent.click(
    within(resultBanner).getByTestId(
      "catalog-open-installed-minion-gym-tracker",
    ),
  );
  expect(onOpenMinion).toHaveBeenCalledWith("gym-tracker");

  // Install personal-finance and verify domain/skill links
  fireEvent.click(screen.getByTestId("catalog-install-personal-finance"));
  await waitFor(() =>
    expect(screen.getByTestId("catalog-install-result")).toHaveTextContent(
      "Successfully installed package personal-finance",
    ),
  );
  expect(
    screen.getByTestId("catalog-feature-status-personal-finance"),
  ).toHaveTextContent("Installed");

  fireEvent.click(
    within(screen.getByTestId("catalog-install-result")).getByTestId(
      "catalog-open-installed-minion-personal-finance",
    ),
  );
  expect(onOpenMinion).toHaveBeenCalledWith("personal-finance");

  fireEvent.click(
    within(screen.getByTestId("catalog-install-result")).getByTestId(
      "catalog-open-installed-skill-personal-finance",
    ),
  );
  expect(onOpenSkill).toHaveBeenCalledWith("personal-finance");
});

test("surfaces configuration_required warning in install result when an installed Minion requires user configuration", async () => {
  const api = createMockWorkspaceApi();
  vi.spyOn(api, "installFeature").mockResolvedValueOnce({
    schema: 1,
    ok: true,
    feature_id: "gym-tracker",
    installed_domains: ["minions/gym-tracker"],
    installed_skills: [],
    policy_updated: true,
    minions: [
      {
        id: "gym-tracker",
        configuration_required: true,
      },
    ],
  });
  const onOpenMinion = vi.fn();

  render(
    <CatalogPage
      api={api}
      onOpenMinion={onOpenMinion}
      onOpenDomain={vi.fn()}
      onOpenSkill={vi.fn()}
    />,
  );

  fireEvent.click(await screen.findByTestId("catalog-install-gym-tracker"));
  expect(
    await screen.findByTestId("catalog-install-config-required-gym-tracker"),
  ).toHaveTextContent("Config required");
  expect(
    screen.getByTestId("catalog-open-installed-minion-gym-tracker"),
  ).toHaveTextContent("Configure Minion");
});

test("explains CLI conflict errors and dependency failures clearly without overwriting local state", async () => {
  const api = createMockWorkspaceApi();
  vi.spyOn(api, "installFeature")
    .mockRejectedValueOnce(
      new ApiError(409, {
        schema: 1,
        ok: false,
        error: "minion_install_requires_cli",
        message:
          "minion gym-tracker is already present in this workspace; use the managed CLI to update or replace it without losing state",
      }),
    )
    .mockRejectedValueOnce(
      new ApiError(409, {
        schema: 1,
        ok: false,
        error: "unsupported_required_tool",
        message: "personal-finance requires unsupported runtime tool: hledger",
      }),
    );

  render(
    <CatalogPage
      api={api}
      onOpenMinion={vi.fn()}
      onOpenDomain={vi.fn()}
      onOpenSkill={vi.fn()}
    />,
  );

  fireEvent.click(await screen.findByTestId("catalog-install-gym-tracker"));
  const errorAlert = await screen.findByTestId("catalog-install-error");
  expect(errorAlert).toHaveTextContent(
    "Existing Minion App Conflict — Managed CLI Required",
  );
  expect(errorAlert).toHaveTextContent("openlia feature install gym-tracker");

  fireEvent.click(screen.getByTestId("catalog-install-personal-finance"));
  await waitFor(() =>
    expect(screen.getByTestId("catalog-install-error")).toHaveTextContent(
      "Requirement / Compatibility Check Failed",
    ),
  );
  expect(screen.getByTestId("catalog-install-error")).toHaveTextContent(
    "personal-finance requires unsupported runtime tool: hledger",
  );
});

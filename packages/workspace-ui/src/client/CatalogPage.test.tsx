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

test("lists catalog packages and shows requirements including hledger", async () => {
  const api = createMockWorkspaceApi();
  render(
    <CatalogPage api={api} onOpenDomain={vi.fn()} onOpenSkill={vi.fn()} />,
  );

  const financeCard = await screen.findByTestId(
    "catalog-feature-card-personal-finance",
  );
  const healthCard = await screen.findByTestId(
    "catalog-feature-card-personal-health",
  );

  expect(financeCard).toHaveTextContent("Domains & Skills Package");
  expect(financeCard).toHaveTextContent("requires tool: hledger");
  expect(financeCard).toHaveTextContent("Skill: personal-finance");

  expect(healthCard).toHaveTextContent("Domains & Skills Package");
  expect(healthCard).toHaveTextContent("Skill: personal-health");

  // Select personal-finance and verify detail panel contents and requirements
  fireEvent.click(screen.getByTestId("catalog-select-personal-finance"));
  const detailPanel = screen.getByTestId("catalog-detail-panel");
  expect(detailPanel).toHaveTextContent("finance");
  expect(detailPanel).toHaveTextContent("hledger");
});

test("installs features, displays installation results, and navigates to installed artifacts", async () => {
  const api = createMockWorkspaceApi();
  const onOpenDomain = vi.fn();
  const onOpenSkill = vi.fn();
  const onFeatureInstalled = vi.fn();

  render(
    <CatalogPage
      api={api}
      onOpenDomain={onOpenDomain}
      onOpenSkill={onOpenSkill}
      onFeatureInstalled={onFeatureInstalled}
    />,
  );

  const installHealthBtn = await screen.findByTestId(
    "catalog-install-personal-health",
  );
  fireEvent.click(installHealthBtn);

  const resultBanner = await screen.findByTestId("catalog-install-result");
  expect(resultBanner).toHaveTextContent(
    "Successfully installed package personal-health",
  );
  expect(
    screen.getByTestId("catalog-feature-status-personal-health"),
  ).toHaveTextContent("Installed");
  expect(onFeatureInstalled).toHaveBeenCalledTimes(1);

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
      "catalog-open-installed-skill-personal-finance",
    ),
  );
  expect(onOpenSkill).toHaveBeenCalledWith("personal-finance");
});

test("explains CLI conflict errors and dependency failures clearly without overwriting local state", async () => {
  const api = createMockWorkspaceApi();
  vi.spyOn(api, "installFeature")
    .mockRejectedValueOnce(
      new ApiError(409, {
        schema: 1,
        ok: false,
        error: "skill_install_requires_cli",
        message:
          "skill personal-finance is already present in this workspace; use the managed CLI to update or replace it without losing state",
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
    <CatalogPage api={api} onOpenDomain={vi.fn()} onOpenSkill={vi.fn()} />,
  );

  fireEvent.click(
    await screen.findByTestId("catalog-install-personal-finance"),
  );
  const errorAlert = await screen.findByTestId("catalog-install-error");
  expect(errorAlert).toHaveTextContent(
    "Existing Skill Conflict — Managed CLI Required",
  );
  expect(errorAlert).toHaveTextContent(
    "openlia feature install personal-finance",
  );

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

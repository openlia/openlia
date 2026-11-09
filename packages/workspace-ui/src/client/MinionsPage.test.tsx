import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { MinionsPage } from "./MinionsPage";
import { createMockWorkspaceApi } from "./mockApi";

function renderMinion(api = createMockWorkspaceApi()) {
  render(
    <MinionsPage
      api={api}
      selectedMinionId="sample-minion"
      onSelectMinion={vi.fn()}
      onOpenFile={vi.fn()}
    />,
  );
  return api;
}

test("keeps quick entry and minion details in the scrollable workspace panel", async () => {
  renderMinion();
  const scrollPanel = await screen.findByTestId("minion-scroll-content");

  expect(
    within(scrollPanel).getByRole("textbox", { name: "Quick input" }),
  ).toBeInTheDocument();
  expect(
    within(scrollPanel).getByText("sample-minion minion"),
  ).toBeInTheDocument();
  expect(scrollPanel).not.toContainElement(
    screen.getByTestId("minion-tab-dashboard"),
  );
});

test("Ctrl+Enter submits multiline input without trimming the draft", async () => {
  const api = createMockWorkspaceApi();
  const submit = vi.spyOn(api, "submitMinionInput");
  renderMinion(api);
  const input = await screen.findByRole("textbox", { name: "Quick input" });
  expect(input.tagName).toBe("TEXTAREA");
  expect(input).toHaveAttribute("rows", "3");
  const text = "\n  First paragraph\n\nSecond paragraph\n";
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  await waitFor(() =>
    expect(submit).toHaveBeenCalledExactlyOnceWith("sample-minion", {
      action: "add",
      input: text,
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Quick input" })).toHaveValue(
      "",
    ),
  );
});

test("structured input remains disabled after the response until form reset and refresh finish", async () => {
  const api = renderMinion();
  await screen.findByTestId("minion-tab-input");
  fireEvent.click(screen.getByTestId("minion-tab-input"));
  const form = await screen.findByTestId("minion-openui-input");
  fireEvent.change(within(form).getByRole("textbox"), {
    target: { value: "First entry" },
  });
  const listing = await api.listMinions();
  let finishRefresh!: (value: typeof listing) => void;
  const refresh = vi.spyOn(api, "listMinions").mockReturnValue(
    new Promise((resolve) => {
      finishRefresh = resolve;
    }),
  );
  const submit = vi.spyOn(api, "submitMinionInput");
  fireEvent.click(within(form).getByRole("button", { name: "Submit Entry" }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(screen.getByTestId("minion-openui-input")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(
    within(screen.getByTestId("minion-openui-input")).getByRole("button", {
      name: "Submit Entry",
    }),
  ).toBeDisabled();
  expect(
    within(screen.getByTestId("minion-openui-input")).getByRole("textbox"),
  ).toBeDisabled();
  expect(submit).toHaveBeenCalledTimes(1);
  finishRefresh(listing);
  await waitFor(() =>
    expect(screen.getByTestId("minion-openui-input")).toHaveAttribute(
      "aria-busy",
      "false",
    ),
  );
  expect(
    within(screen.getByTestId("minion-openui-input")).getByRole("textbox"),
  ).toHaveValue("");
  expect(
    within(screen.getByTestId("minion-openui-input")).getByRole("button", {
      name: "Submit Entry",
    }),
  ).toBeEnabled();
});

test("Cmd+Enter preserves a failed draft and does not submit during IME composition", async () => {
  const api = createMockWorkspaceApi();
  const submit = vi
    .spyOn(api, "submitMinionInput")
    .mockRejectedValue(new Error("Input rejected"));
  renderMinion(api);
  const input = await screen.findByRole("textbox", { name: "Quick input" });
  fireEvent.change(input, { target: { value: "First line\nSecond line" } });
  fireEvent.keyDown(input, { key: "Enter", metaKey: true, isComposing: true });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter", metaKey: true });
  await screen.findByText("Input rejected");
  expect(input).toHaveValue("First line\nSecond line");
  expect(submit).toHaveBeenCalledTimes(1);
});

test("the submit button follows the selected action and empty heartbeat still works", async () => {
  const api = createMockWorkspaceApi();
  const { minion } = await api.getMinion("sample-minion");
  vi.spyOn(api, "getMinion").mockResolvedValue({
    schema: 1,
    minion: {
      ...minion,
      quick_actions: [
        { id: "add", label: "Add Entry" },
        { id: "heartbeat", label: "Run Heartbeat" },
      ],
    },
  });
  const heartbeat = vi.spyOn(api, "runMinionHeartbeat");
  renderMinion(api);
  expect(
    await screen.findByRole("button", { name: "Add Entry" }),
  ).toBeEnabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Input action" }), {
    target: { value: "heartbeat" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run Heartbeat" }));
  await waitFor(() =>
    expect(heartbeat).toHaveBeenCalledExactlyOnceWith("sample-minion"),
  );
});

test("surfaces configuration_required state in sidebar and detail view with Configure Minion action", async () => {
  const api = createMockWorkspaceApi();
  const { minion } = await api.getMinion("sample-minion");
  vi.spyOn(api, "listMinions").mockResolvedValue({
    schema: 1,
    minions: [{ ...minion, configuration_required: true }],
  });
  vi.spyOn(api, "getMinion").mockResolvedValue({
    schema: 1,
    minion: {
      ...minion,
      configuration_required: true,
    },
  });
  const onOpenCatalog = vi.fn();
  render(
    <MinionsPage
      api={api}
      selectedMinionId="sample-minion"
      onSelectMinion={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenCatalog={onOpenCatalog}
    />,
  );

  expect(
    await screen.findByTestId("minion-config-required-badge-sample-minion"),
  ).toHaveTextContent("Config required");
  expect(
    await screen.findByTestId("minion-config-required-banner"),
  ).toHaveTextContent("Configuration required");

  fireEvent.click(screen.getByTestId("minion-configure-now"));
  expect(await screen.findByTestId("minion-save-config")).toBeInTheDocument();

  fireEvent.click(screen.getByTestId("minions-browse-catalog"));
  expect(onOpenCatalog).toHaveBeenCalledTimes(1);
});

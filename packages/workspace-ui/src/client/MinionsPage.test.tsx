import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

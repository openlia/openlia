import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "./ChatPage";
import { ChatMarkdown } from "./ChatMarkdown";
import { createChatMock } from "./chatMock";
import type { ChatApi, ChatRun } from "../shared/chat";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

async function open(api: ChatApi) {
  render(<ChatPage api={api} />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Getting started with Lia/ }),
  );
  await screen.findByRole("textbox", { name: "Message Lia" });
  await waitFor(() =>
    expect(screen.queryByText("Loading conversation…")).toBeNull(),
  );
}

describe("Workspace chat", () => {
  it("keeps drafts across navigation and sends a stable retry identity", async () => {
    const api = createChatMock();
    const send = vi
      .spyOn(api, "send")
      .mockRejectedValueOnce(new Error("Connection lost"));
    await open(api);
    fireEvent.change(screen.getByRole("textbox", { name: "Message Lia" }), {
      target: { value: "Keep this draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Connection lost");
    expect(sessionStorage.getItem("chat-draft:demo-chat")).toBe(
      "Keep this draft",
    );
    const originalKey = send.mock.calls[0]?.[2];
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]?.[2]).toBe(originalKey);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message Lia" })).toHaveValue(
        "",
      ),
    );
  });
  it("does not show mutation controls for other Hermes sessions", async () => {
    const api = createChatMock();
    await open(api);
    fireEvent.change(
      screen.getByRole("combobox", { name: "Conversation source" }),
      { target: { value: "other" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Telegram conversation/ }),
    );
    await screen.findByText("Read-only history from another Hermes interface.");
    expect(screen.queryByRole("textbox", { name: "Message Lia" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
  it("deduplicates replay events and never stops an agent on unmount", async () => {
    const api = createChatMock();
    const run: ChatRun = {
      run_id: "running-1",
      status: "running",
      session_id: "demo-chat",
    };
    api.activeRun = async () => ({ run });
    api.run = async () => run;
    api.events = async (_id, _seq, _signal, receive) => {
      receive({
        event: "message.delta",
        delta: "Unique streaming reply",
        seq: 0,
      });
      receive({
        event: "message.delta",
        delta: "Unique streaming reply",
        seq: 0,
      });
    };
    const control = vi.spyOn(api, "control");
    await open(api);
    await screen.findByText("Unique streaming reply");
    expect(
      screen.queryByText("Unique streaming replyUnique streaming reply"),
    ).toBeNull();
    cleanup();
    expect(control).not.toHaveBeenCalled();
  });
  it("renders exact approval choices and forwards their request identity", async () => {
    const api = createChatMock();
    const run: ChatRun = {
      run_id: "approval-run",
      status: "waiting_for_approval",
      session_id: "demo-chat",
      approval: {
        command: "rm important-file",
        choices: ["once", "deny"],
        request_id: "approval-id",
      },
    };
    api.activeRun = async () => ({ run });
    api.run = async () => run;
    api.events = async () => {};
    const control = vi.spyOn(api, "control").mockResolvedValue({});
    await open(api);
    fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith("approval-run", "approval", {
        choice: "once",
        request_id: "approval-id",
      }),
    );
    expect(screen.queryByRole("button", { name: "Allow always" })).toBeNull();
  });
  it("requires an explicit delete confirmation", async () => {
    const api = createChatMock();
    const remove = vi.spyOn(api, "delete");
    await open(api);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("demo-chat"));
  });
  it("does not execute raw HTML, render tracking images, or allow script links", async () => {
    const { container } = render(
      <ChatMarkdown
        content={
          "<script>alert(1)</script>\n\n![tracker](https://tracking.invalid/image)\n\n[bad](javascript:alert(1))\n\n```javascript\nconst answer = 42;\n```"
        }
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    await waitFor(() =>
      expect(container.querySelector(".token.keyword")?.textContent).toBe(
        "const",
      ),
    );
  });
});

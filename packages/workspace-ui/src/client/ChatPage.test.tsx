import {
  act,
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
import type { ChatApi, ChatEvent, ChatRun } from "../shared/chat";

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
  it("restores failed execution status after reopening without a Lia response or resend", async () => {
    const api = createChatMock();
    const run: ChatRun = {
      run_id: "saved-failure",
      status: "failed",
      status_source: "recorded",
    };
    api.activeRun = async () => ({ run });
    api.messages = async () => ({
      data: [{ id: 1, role: "user", content: "Save the synthetic trip" }],
      session_id: "demo-chat",
    });
    const send = vi.spyOn(api, "send");
    await open(api);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Execution failed"),
    );
    expect(screen.getByText("Save the synthetic trip")).toBeVisible();
    expect(
      screen.getByText(/tools may already have changed workspace records/),
    ).toBeVisible();
    cleanup();
    render(<ChatPage api={api} />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Execution failed"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh execution status" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Execution failed"),
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps the saved transcript readable and disables sending when run lookup fails", async () => {
    const api = createChatMock();
    api.activeRun = async () => {
      throw new Error("hermes_unavailable");
    };
    const send = vi.spyOn(api, "send");
    await open(api);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Execution outcome unknown",
      ),
    );
    expect(
      screen.getByText(/Hello! Ask me about your workspace/),
    ).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Message Lia" }), {
      target: { value: "Do not submit" },
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(send).not.toHaveBeenCalled();
  });
  it("shows older failed runs after a later turn completed", async () => {
    const api = createChatMock();
    const latest: ChatRun = { run_id: "later-run", status: "completed" };
    api.activeRun = async () => ({ run: latest });
    api.runs = async () => ({
      data: [
        latest,
        { run_id: "earlier-run", status: "failed", status_source: "recorded" },
      ],
      has_more: false,
      next_offset: 2,
    });
    const send = vi.spyOn(api, "send");
    await open(api);
    fireEvent.click(await screen.findByText("Execution history (2)"));
    expect(screen.getByText("earlier-run")).toBeVisible();
    expect(screen.getByText("Execution failed")).toBeVisible();
    expect(send).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByLabelText("Conversation options"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("demo-chat"));
  });
  it("shows an actionable message when approval is unsupported", async () => {
    const api = createChatMock();
    const capabilities = await api.capabilities();
    api.capabilities = async () => ({
      ...capabilities,
      features: { ...capabilities.features, run_approval_response: false },
    });
    const run: ChatRun = {
      run_id: "unsupported",
      status: "waiting_for_approval",
      approval: {
        description: "Delete projects/old.md",
        request_id: "request-1",
        choices: ["once", "deny"],
      },
    };
    api.activeRun = async () => ({ run });
    api.run = async () => run;
    api.events = async () => {};
    await open(api);
    await screen.findByText(/Update and recreate both Hermes and Workspace UI/);
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.getByText("Delete projects/old.md")).toBeInTheDocument();
  });
  it("does not invent choices or submit approvals without exact request identity", async () => {
    const api = createChatMock();
    let run: ChatRun = {
      run_id: "incomplete",
      status: "waiting_for_approval",
      approval: { choices: ["once", "deny"] },
    };
    api.activeRun = async () => ({ run });
    api.run = async () => run;
    api.events = async () => {};
    const control = vi.spyOn(api, "control");
    await open(api);
    await screen.findByText(/cannot provide an actionable approval/);
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    cleanup();
    run = { ...run, approval: { request_id: "request-1" } };
    render(<ChatPage api={api} />);
    await screen.findByText(/cannot provide an actionable approval/);
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(control).not.toHaveBeenCalled();
  });
  it("reconciles approval events without clearing a newer request", async () => {
    const api = createChatMock();
    const run: ChatRun = { run_id: "event-run", status: "running" };
    api.activeRun = async () => ({ run });
    api.run = async () => run;
    let receive!: (event: ChatEvent) => void;
    api.events = async (_id, _seq, _signal, onEvent) => {
      receive = onEvent;
    };
    const control = vi.spyOn(api, "control").mockResolvedValue({});
    await open(api);
    await waitFor(() => expect(receive).toBeTypeOf("function"));
    act(() => {
      receive({
        event: "approval.request",
        seq: 0,
        request_id: "new-request",
        description: "Review the new action",
        choices: ["once", "deny"],
      });
      receive({
        event: "approval.responded",
        seq: 1,
        request_id: "old-request",
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith("event-run", "approval", {
        choice: "once",
        request_id: "new-request",
      }),
    );
  });
  it("restores pending approval on reopen and resumes the same run without resending", async () => {
    const api = createChatMock();
    let run: ChatRun = {
      run_id: "resume-run",
      status: "waiting_for_approval",
      approval: {
        request_id: "request-1",
        description: "Overwrite projects/note.md",
        choices: ["once", "deny"],
      },
    };
    api.activeRun = async () => ({ run });
    api.run = async () => run;
    api.events = async () => {};
    const send = vi.spyOn(api, "send");
    const control = vi.spyOn(api, "control").mockImplementation(async () => {
      run = { ...run, status: "running" };
      delete run.approval;
      return {};
    });
    await open(api);
    await screen.findByRole("button", { name: "Allow once" });
    cleanup();
    render(<ChatPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith("resume-run", "approval", {
        choice: "deny",
        request_id: "request-1",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Approval requested")).toBeNull(),
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("prevents duplicate approval submissions while a response is pending", async () => {
    const api = createChatMock();
    const run: ChatRun = {
      run_id: "dedupe-run",
      status: "waiting_for_approval",
      approval: { request_id: "request-1", choices: ["once", "deny"] },
    };
    api.activeRun = async () => ({ run });
    api.run = async () => run;
    api.events = async () => {};
    let finish!: (value: unknown) => void;
    const control = vi.spyOn(api, "control").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await open(api);
    const button = await screen.findByRole("button", { name: "Allow once" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(control).toHaveBeenCalledTimes(1);
    finish({});
    await waitFor(() => expect(button).not.toBeDisabled());
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

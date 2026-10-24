import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatTranscript, groupChatMessages } from "./ChatTranscript";
import type { ChatMessage } from "../shared/chat";

afterEach(cleanup);
const messages: ChatMessage[] = [
  { id: 1, role: "user", content: "Hello" },
  { id: 2, role: "assistant", content: "" },
  {
    id: 3,
    role: "assistant",
    content: "Looking at your project.",
    tool_calls: [{ id: "call-1" }, { id: "call-2" }],
  },
  { id: 4, role: "tool", tool_name: "read_file", content: "File content one" },
  {
    id: 5,
    role: "tool",
    tool_name: "search_files",
    content: "Found project notes",
  },
  { id: 6, role: "assistant", content: "Here is the answer." },
  { id: 7, role: "assistant", content: "diagnostic", display_kind: "hidden" },
  { id: 8, role: "system", content: "System prompt" },
];

describe("chat turn presentation", () => {
  it("groups tool events with the assistant turn without changing stored messages", () => {
    const snapshot = structuredClone(messages);
    const turns = groupChatMessages(messages);
    expect(turns).toHaveLength(2);
    expect(turns[1]?.messages.map((m) => m.id)).toEqual([3, 4, 5, 6]);
    expect(messages).toEqual(snapshot);
  });
  it("collapses tools by default and only shows copy actions for visible text", () => {
    const { container } = render(<ChatTranscript messages={messages} />);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    const summary = screen.getByText("Used 2 tools");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(container.querySelectorAll(".chat-copy")).toHaveLength(2);
    expect(screen.queryByText("diagnostic")).toBeNull();
    expect(screen.queryByText("System prompt")).toBeNull();
    fireEvent.click(summary);
    const toolGroup = summary.closest("details");
    if (!toolGroup) throw new Error("Missing tool activity group");
    expect(within(toolGroup).getByText("read file")).toBeInTheDocument();
    expect(screen.getByText("Here is the answer.")).toBeInTheDocument();
  });
  it("retains tool-only and reasoning-only turns without empty copy buttons", () => {
    render(
      <ChatTranscript
        messages={[
          {
            id: "tool",
            role: "tool",
            tool_name: "read_file",
            content: "Result at page boundary",
          },
          { id: "user", role: "user", content: "Next question" },
          {
            id: "thought",
            role: "assistant",
            content: null,
            reasoning: "Stored reasoning",
          },
        ]}
      />,
    );
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByText("Used 1 tool")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Copy/ })).toHaveLength(1);
  });
});

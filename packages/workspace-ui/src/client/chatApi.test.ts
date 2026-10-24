import { describe, expect, it } from "vitest";
import { readChatEvents } from "./chatApi";
import type { ChatEvent } from "../shared/chat";

describe("chat SSE decoding", () => {
  it("handles split UTF-8, CRLF, multiline data, comments, and event names", async () => {
    const bytes = new TextEncoder().encode(
      ': keepalive\r\n\r\nid: 0\r\ndata: {"event":"message.delta",\r\ndata: "delta":"héllo","seq":0}\r\n\r\nevent: tool.started\ndata: {"tool":"read"}\n\n',
    );
    const received: ChatEvent[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    await readChatEvents(new Response(body), (event) => received.push(event));
    expect(received).toEqual([
      { event: "message.delta", delta: "héllo", seq: 0 },
      { event: "tool.started", tool: "read" },
    ]);
  });
  it("does not accept failed streams as successful replies", async () => {
    await expect(
      readChatEvents(new Response("unauthorized", { status: 401 }), () => {}),
    ).rejects.toThrow("401");
  });
});

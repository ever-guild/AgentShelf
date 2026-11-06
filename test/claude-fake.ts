// A stand-in for the Claude API at the HTTP level, so tests run the real SDK and the real adapter.
// It speaks the streaming format the adapter asks for. It proves how the code behaves against the
// documented API, and says nothing about how a real model reads a real photo.

type Block =
  | { type: "text"; text: string }
  | { type: "thinking" }
  | { type: "fallback"; from: string; to: string };

export type FakeMessage = {
  blocks: Block[];
  stopReason?: string;
  model?: string;
};

type Reply =
  | { kind: "message"; message: FakeMessage }
  | { kind: "status"; status: number; errorType: string }
  | { kind: "network" };

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...(data as object) })}\n\n`;
}

export function streamBody(message: FakeMessage): string {
  const events = [
    event("message_start", {
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: message.model ?? "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 1 },
      },
    }),
  ];
  message.blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push(
        event("content_block_start", { index, content_block: { type: "text", text: "" } }),
        event("content_block_delta", { index, delta: { type: "text_delta", text: block.text } }),
      );
    } else if (block.type === "thinking") {
      events.push(
        event("content_block_start", {
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
      );
    } else {
      events.push(
        event("content_block_start", {
          index,
          content_block: { type: "fallback", from: { model: block.from }, to: { model: block.to } },
        }),
      );
    }
    events.push(event("content_block_stop", { index }));
  });
  events.push(
    event("message_delta", {
      delta: { stop_reason: message.stopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: 80 },
    }),
    event("message_stop", {}),
  );
  return events.join("");
}

export function createFakeClaude() {
  const queue: Reply[] = [];
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const reply = queue.shift();
    if (!reply) {
      throw new Error("The fake Claude API has no reply queued");
    }
    if (reply.kind === "network") {
      throw new TypeError("fetch failed");
    }
    if (reply.kind === "status") {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: reply.errorType, message: "SECRET-PROVIDER-DETAIL" },
        }),
        {
          status: reply.status,
          headers: { "content-type": "application/json", "request-id": "req_fake" },
        },
      );
    }
    return new Response(streamBody(reply.message), {
      status: 200,
      headers: { "content-type": "text/event-stream", "request-id": "req_fake" },
    });
  };

  return {
    fetch: fakeFetch,
    requests,
    replyMessage(message: FakeMessage) {
      queue.push({ kind: "message", message });
    },
    replyJson(value: unknown, overrides: Partial<FakeMessage> = {}) {
      queue.push({
        kind: "message",
        message: { blocks: [{ type: "text", text: JSON.stringify(value) }], ...overrides },
      });
    },
    replyStatus(status: number, errorType = "api_error") {
      queue.push({ kind: "status", status, errorType });
    },
    replyNetworkFailure() {
      queue.push({ kind: "network" });
    },
  };
}

// A stand-in for the OpenAI Responses API at the HTTP level, so tests run the real SDK and the real
// adapter. It proves how the code behaves against the documented API, and says nothing about how a
// real model reads a real photo.

type OutputItem =
  | { type: "text"; text: string }
  | { type: "refusal"; refusal: string }
  | { type: "reasoning" }
  | { type: "function_call"; callId: string; name: string; arguments: string };

export type FakeResponse = {
  items: OutputItem[];
  status?: "completed" | "incomplete" | "failed";
  incompleteReason?: "max_output_tokens" | "content_filter";
  model?: string;
};

type Reply =
  | { kind: "response"; response: FakeResponse }
  | { kind: "status"; status: number; code: string }
  | { kind: "network" };

function outputItem(item: OutputItem, index: number) {
  switch (item.type) {
    case "text":
      return {
        type: "message",
        id: `msg_fake_${index}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: item.text, annotations: [] }],
      };
    case "refusal":
      return {
        type: "message",
        id: `msg_fake_${index}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "refusal", refusal: item.refusal }],
      };
    case "reasoning":
      return { type: "reasoning", id: `rs_fake_${index}`, summary: [] };
    case "function_call":
      return {
        type: "function_call",
        id: `fc_fake_${index}`,
        call_id: item.callId,
        name: item.name,
        arguments: item.arguments,
        status: "completed",
      };
  }
}

export function responseBody(response: FakeResponse) {
  const status = response.status ?? "completed";
  return {
    id: "resp_fake",
    object: "response",
    created_at: 1_794_000_000,
    status,
    model: response.model ?? "gpt-6-astra",
    output: response.items.map(outputItem),
    incomplete_details:
      status === "incomplete" ? { reason: response.incompleteReason ?? "max_output_tokens" } : null,
    error: null,
    usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
  };
}

export function createFakeOpenAi() {
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
      throw new Error("The fake OpenAI API has no reply queued");
    }
    if (reply.kind === "network") {
      throw new TypeError("fetch failed");
    }
    if (reply.kind === "status") {
      return new Response(
        JSON.stringify({
          error: { type: "invalid_request_error", code: reply.code, message: "SECRET-PROVIDER-DETAIL" },
        }),
        {
          status: reply.status,
          headers: { "content-type": "application/json", "x-request-id": "req_fake" },
        },
      );
    }
    return new Response(JSON.stringify(responseBody(reply.response)), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req_fake" },
    });
  };

  return {
    fetch: fakeFetch,
    requests,
    replyResponse(response: FakeResponse) {
      queue.push({ kind: "response", response });
    },
    replyJson(value: unknown, overrides: Partial<FakeResponse> = {}) {
      queue.push({
        kind: "response",
        response: { items: [{ type: "reasoning" }, { type: "text", text: JSON.stringify(value) }], ...overrides },
      });
    },
    replyStatus(status: number, code = "server_error") {
      queue.push({ kind: "status", status, code });
    },
    replyNetworkFailure() {
      queue.push({ kind: "network" });
    },
  };
}

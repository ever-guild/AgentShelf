import type {
  AgAiConversationItem,
  AgAiEvent,
  AgAiOutputItem,
  AgAiTool,
  AgLlmAdapter,
  AgLlmExecuteTurnOptions,
  AgLlmRequest,
  AgLlmResponse,
  AgLlmResponseHandler,
} from "ag-studio";

import {
  ASSISTANT_TOOLS,
  ASSISTANT_TOOL_NAMES,
  READ_GROUPS_TOOL,
  READ_GROUP_TOOL,
  SHOW_CHART_TOOL,
  showChartArguments,
  type AssistantToolName,
  type AssistantTurnItem,
  type AssistantTurnReply,
  type DemandChartMeasure,
} from "@/server/contracts/seller-insights";

// The seller's assistant as Studio sees it: an adapter and three tools. Studio runs its loop in the
// browser and the model key never comes here. The adapter sends only the conversation, because the
// server owns the instructions and the tool list, and it drops what Studio offers in their place.

const TURN_TIMEOUT_MS = 90_000;
const READ_TIMEOUT_MS = 15_000;

const FAILED_MESSAGE = "The assistant could not answer just now. The counts on the page are still correct. Try again.";

const isAllowedTool = (name: string): name is AssistantToolName =>
  (ASSISTANT_TOOL_NAMES as readonly string[]).includes(name);

// Studio's items in the narrower form the route accepts. A system message has no way through,
// because instructions are the server's. Reasoning stays behind: the provider does not need it back.
export function toTurnItems(items: readonly AgAiConversationItem[]): AssistantTurnItem[] {
  return items.flatMap((item): AssistantTurnItem[] => {
    switch (item.type) {
      case "message": {
        if (item.kind === "input") {
          if (item.role !== "user") {
            return [];
          }
          const text = item.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
          return text ? [{ type: "user_text", text }] : [];
        }
        const text = item.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
        return text ? [{ type: "assistant_text", text }] : [];
      }
      case "function_call":
        return isAllowedTool(item.name)
          ? [{ type: "tool_call", callId: item.callId, name: item.name, arguments: item.arguments }]
          : [];
      case "function_call_output":
        return [{ type: "tool_result", callId: item.callId, output: item.output }];
      default:
        return [];
    }
  });
}

function responseOf(reply: AssistantTurnReply, createdAt: number): AgLlmResponse {
  const output: AgAiOutputItem[] = [];
  if (reply.text) {
    output.push({
      id: `${reply.id}-text`,
      kind: "output",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "text", text: reply.text, annotations: [] }],
    });
  }
  for (const call of reply.toolCalls) {
    output.push({
      id: call.callId,
      kind: "output",
      type: "function_call",
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    });
  }
  return {
    id: reply.id,
    createdAt,
    status: reply.status,
    output,
    model: reply.model,
    ...(reply.status === "incomplete" ? { incompleteDetails: { reason: "max_output_tokens" as const } } : {}),
  };
}

function eventsOf(reply: AssistantTurnReply): AgAiEvent[] {
  const events: AgAiEvent[] = [];
  if (reply.text) {
    const messageId = `${reply.id}-text`;
    events.push(
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: reply.text },
      { type: "TEXT_MESSAGE_END", messageId },
    );
  }
  for (const call of reply.toolCalls) {
    events.push(
      { type: "TOOL_CALL_START", toolCallId: call.callId, toolCallName: call.name },
      { type: "TOOL_CALL_ARGS", toolCallId: call.callId, delta: call.arguments },
      { type: "TOOL_CALL_END", toolCallId: call.callId },
    );
  }
  return events;
}

function failedResponse(code: string, message: string): AgLlmResponse {
  return { id: code, createdAt: Date.now(), status: "failed", output: [], error: { code, message } };
}

async function messageOf(response: Response): Promise<{ code: string; message: string }> {
  if (response.status === 401) {
    return {
      code: "UNAUTHORIZED",
      message: "The shop is no longer signed in here. Sign in again to use the assistant.",
    };
  }
  const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return { code: body?.error?.code ?? "FAILED", message: body?.error?.message ?? FAILED_MESSAGE };
}

// Talks to the seller-authenticated route. A failure is a failed response, so Studio shows it in the
// chat and the handler's promises never reject on their own. The route answers once the model has
// finished, because each answer is checked before it leaves the server, so the whole message arrives
// as one delta.
export function createAssistantAdapter(fetchFn: typeof fetch = fetch): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options?: AgLlmExecuteTurnOptions): AgLlmResponseHandler {
      const answer: Promise<{ response: AgLlmResponse; events: AgAiEvent[] }> = (async () => {
        const startedAt = Date.now();
        try {
          const response = await fetchFn("/api/seller/assistant/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: toTurnItems(request.input) }),
            cache: "no-store",
            signal: options?.signal
              ? AbortSignal.any([options.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)])
              : AbortSignal.timeout(TURN_TIMEOUT_MS),
          });
          if (!response.ok) {
            const { code, message } = await messageOf(response);
            return { response: failedResponse(code, message), events: [] };
          }
          const reply = (await response.json()) as AssistantTurnReply;
          return { response: responseOf(reply, startedAt), events: eventsOf(reply) };
        } catch {
          return options?.signal?.aborted
            ? {
                response: { ...failedResponse("CANCELLED", FAILED_MESSAGE), status: "cancelled" as const },
                events: [],
              }
            : { response: failedResponse("NETWORK", FAILED_MESSAGE), events: [] };
        }
      })();

      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            const { events } = await answer;
            yield* events;
          },
        },
        complete: answer.then(({ response }) => response),
      };
    },
  };
}

const definitionOf = (name: AssistantToolName) => {
  const definition = ASSISTANT_TOOLS.find((tool) => tool.name === name);
  if (!definition) {
    throw new Error(`Unknown assistant tool ${name}`);
  }
  return definition;
};

type ToolHost = {
  // The shop this page was opened for. An answer about any other is not for this page.
  shopId: string;
  // The period the seller has chosen, for a read that names none.
  days: () => string;
  showChart: (measure: DemandChartMeasure) => void;
  fetch?: typeof fetch;
};

function readTool(name: AssistantToolName, host: ToolHost): AgAiTool {
  const { description, parameters } = definitionOf(name);
  return {
    name,
    description,
    kind: "client",
    schema: () => ({ name, description, parameters, kind: "client" }) as ReturnType<AgAiTool["schema"]>,
    async execute(call, ctx) {
      const query = new URLSearchParams({ days: host.days() });
      for (const [key, value] of Object.entries(call.args)) {
        // A value of the wrong shape goes on as text, so the route's strict check refuses it.
        query.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
      const fetchFn = host.fetch ?? fetch;
      const response = await fetchFn(`/api/seller/assistant/demand?${query}`, {
        cache: "no-store",
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
      }).catch(() => null);
      if (!response) {
        return ctx.error("Could not read the demand data. Say so, and do not guess.");
      }
      const body = (await response.json().catch(() => null)) as
        | { shopId?: string; error?: { message?: string; details?: unknown } }
        | null;
      if (!response.ok || !body) {
        return ctx.error(
          response.status === 400
            ? `These filters were refused: ${JSON.stringify(body?.error?.details ?? {})}. Only the listed parameters are accepted.`
            : "Could not read the demand data. Say so, and do not guess.",
        );
      }
      if (body.shopId !== host.shopId) {
        return ctx.error("The signed-in shop changed. Ask the seller to reload the page.");
      }
      return ctx.success(JSON.stringify(body));
    },
  };
}

function chartTool(host: ToolHost): AgAiTool {
  const { name, description, parameters } = definitionOf(SHOW_CHART_TOOL);
  return {
    name,
    description,
    kind: "client",
    schema: () => ({ name, description, parameters, kind: "client" }) as ReturnType<AgAiTool["schema"]>,
    async execute(call, ctx) {
      const parsed = showChartArguments.safeParse(call.args);
      if (!parsed.success) {
        return ctx.error("measure must be one of all, recorded or demo_sample.");
      }
      host.showChart(parsed.data.measure);
      return ctx.success(`The demand chart now shows ${parsed.data.measure} searches.`);
    },
  };
}

// Only these. Studio's own tools can read every table on the page, payments among them, or change
// any widget, so none of them is on this list.
export function assistantTools(host: ToolHost): AgAiTool[] {
  return [readTool(READ_GROUPS_TOOL, host), readTool(READ_GROUP_TOOL, host), chartTool(host)];
}

export const ASSISTANT_STARTERS = [
  { label: "What could buyers not find?", prompt: "What did buyers look for and not find in my shop?" },
  { label: "Chart recorded searches", prompt: "Show a chart of recorded searches only." },
];

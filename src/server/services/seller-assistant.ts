import "server-only";

import { AiFailure, type AssistantMessage, type DemandAi } from "../ai/types";
import type { Db } from "../db/client";
import {
  ASSISTANT_TOOL_NAMES,
  assistantTurnRequest,
  type AssistantToolName,
  type AssistantTurnItem,
  type AssistantTurnReply,
} from "../contracts/seller-insights";
import { withoutLinks } from "../domain/demand-claims";
import { parseInput, ServiceError } from "../errors";
import type { DashboardShop } from "./seller-dashboard";
import { takeAiCall } from "./demand-insights";

// One round of the seller's assistant. The browser runs Studio's loop and holds the conversation, and
// this holds the key, the instructions and the tool list. What goes back is text and calls to
// allowlisted tools, each of which the browser can only run against a session-scoped route or the
// page's own layout. Nothing here can reach a payment, an order or another shop.

const ALLOWED_TOOLS: ReadonlySet<string> = new Set(ASSISTANT_TOOL_NAMES);

function isAllowedTool(name: string): name is AssistantToolName {
  return ALLOWED_TOOLS.has(name);
}

function argumentsOf(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Treated as no arguments below, and the tool's own check answers for it.
  }
  return {};
}

// A cancelled run can leave a call with no result, and the provider refuses that, so a call without
// its result and a result without its call are dropped. Neighbouring items of one side share a
// message, as the provider expects of parallel calls.
export function toAssistantMessages(items: readonly AssistantTurnItem[]): AssistantMessage[] {
  const answered = new Set(items.flatMap((item) => (item.type === "tool_result" ? [item.callId] : [])));
  const called = new Set(items.flatMap((item) => (item.type === "tool_call" ? [item.callId] : [])));
  const messages: AssistantMessage[] = [];

  const onSide = (role: AssistantMessage["role"]) => {
    const last = messages.at(-1);
    if (last?.role === role) {
      return last;
    }
    const message = { role, content: [] } as AssistantMessage;
    messages.push(message);
    return message;
  };

  for (const item of items) {
    switch (item.type) {
      case "user_text":
        (onSide("user").content as object[]).push({ type: "text", text: item.text });
        break;
      case "assistant_text":
        (onSide("assistant").content as object[]).push({ type: "text", text: item.text });
        break;
      case "tool_call":
        if (answered.has(item.callId)) {
          (onSide("assistant").content as object[]).push({
            type: "tool_call",
            callId: item.callId,
            name: item.name,
            input: argumentsOf(item.arguments),
          });
        }
        break;
      case "tool_result":
        if (called.has(item.callId)) {
          (onSide("user").content as object[]).push({
            type: "tool_result",
            callId: item.callId,
            output: item.output,
          });
        }
        break;
    }
  }

  // A model answers the user's side, and starts from it.
  if (messages[0]?.role !== "user" || messages.at(-1)?.role !== "user") {
    throw new ServiceError("INVALID_INPUT", "The conversation must start and end on the seller's side.");
  }
  return messages;
}

export async function runAssistantTurn(
  db: Db,
  shop: DashboardShop,
  rawBody: unknown,
  ai: DemandAi | undefined,
  { now = new Date() }: { now?: Date } = {},
): Promise<AssistantTurnReply> {
  const { items } = parseInput(assistantTurnRequest, rawBody);
  const messages = toAssistantMessages(items);
  if (!ai) {
    throw new ServiceError(
      "AI_NOT_CONFIGURED",
      "The assistant is not set up on this service. The counts on the page are still correct.",
    );
  }
  await takeAiCall(db, shop.id, now);

  let reading;
  try {
    reading = await ai.assistantTurn(messages);
  } catch (error) {
    if (error instanceof AiFailure) {
      throw new ServiceError(
        "AI_UNAVAILABLE",
        "The assistant could not answer just now. The counts on the page are still correct. Try again in a minute.",
        { reason: error.code },
      );
    }
    throw error;
  }

  const toolCalls = reading.toolCalls.flatMap(({ callId, name, input }) =>
    isAllowedTool(name) ? [{ callId, name, arguments: JSON.stringify(input ?? {}) }] : [],
  );
  if (toolCalls.length < reading.toolCalls.length) {
    console.error("The assistant asked for a tool it was never given");
  }
  return {
    id: crypto.randomUUID(),
    status: reading.complete ? "completed" : "incomplete",
    text: withoutLinks(reading.text),
    toolCalls,
    model: reading.model,
  };
}

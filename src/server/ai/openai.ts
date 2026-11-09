import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";

import { descriptionSuggestions, priceListExtraction, searchTermsReply } from "../contracts/imports";
import { ASSISTANT_TOOLS, demandExplanationReply } from "../contracts/seller-insights";
import { tolerateEnumValues } from "../imports/extraction";
import {
  DEMAND_ASSISTANT_PROMPT_VERSION,
  DEMAND_ASSISTANT_SYSTEM,
  DEMAND_EXPLANATION_PROMPT_VERSION,
  DEMAND_EXPLANATION_SYSTEM,
  DESCRIPTIONS_PROMPT_VERSION,
  DESCRIPTIONS_SYSTEM,
  PRICE_LIST_PROMPT_VERSION,
  PRICE_LIST_REQUEST,
  PRICE_LIST_SYSTEM,
  SEARCH_TERMS_PROMPT_VERSION,
  SEARCH_TERMS_SYSTEM,
  demandMessage,
  rowsMessage,
} from "./prompts";
import {
  AiFailure,
  type AiConnection,
  type AiUsage,
  type AssistantMessage,
  type DemandAi,
  type DemandFacts,
  type ImportAi,
  type SearchAi,
  type SearchTermFacts,
  type SuggestionFacts,
} from "./types";

// The OpenAI adapter, the same contracts as claude.ts on the Responses API. This is the only file
// that knows this provider. Like claude.ts it has no `server-only` guard, because a workflow task
// loads it outside Next.js, and the key never reaches a client.

export const OPENAI_MODEL = "gpt-6.1-terra";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

// The same limits as the Claude adapter, so either provider fits a workflow task's five minutes and
// keeps a seller waiting no longer.
const REQUEST_TIMEOUT_MS = 4 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 64_000;
const EFFORT = "medium";
const DEMAND_TIMEOUT_MS = 60 * 1000;
const DEMAND_MAX_OUTPUT_TOKENS = 8_000;
const DEMAND_EFFORT = "low";

// Strict structured output. The helper turns optional and nullable fields into what strict mode
// accepts. The reply is still validated like any input in `readJson`.
function textFormat(schema: z.ZodType, name: string) {
  const { type, schema: jsonSchema, strict } = zodTextFormat(schema as never, name);
  return { type, name, schema: jsonSchema, strict };
}

const PRICE_LIST_FORMAT = textFormat(priceListExtraction, "price_list");
const SUGGESTIONS_FORMAT = textFormat(descriptionSuggestions, "descriptions");
const SEARCH_TERMS_FORMAT = textFormat(searchTermsReply, "search_terms");
const DEMAND_EXPLANATION_FORMAT = textFormat(demandExplanationReply, "demand_notes");

// Not strict, because the read tools' arguments are all optional, and strict mode requires each one.
// The service checks every argument against the contract before a tool runs.
const ASSISTANT_API_TOOLS = ASSISTANT_TOOLS.map(({ name, description, parameters }) => ({
  type: "function" as const,
  name,
  description,
  parameters: parameters as Record<string, unknown>,
  strict: false,
}));

type Reply = OpenAI.Responses.Response;
type InputItem = OpenAI.Responses.ResponseInputItem;

// A short record for the server log. A provider's message can quote the request, so it stays out.
function logFailure(operation: string, error: unknown): void {
  const apiError = error instanceof OpenAI.APIError ? error : undefined;
  console.error(`${operation} failed`, {
    name: error instanceof Error ? error.name : "unknown",
    status: apiError?.status,
    requestId: apiError?.requestID,
  });
}

function failureFrom(error: unknown): AiFailure {
  // Order matters: the connection errors extend APIError and have no status.
  if (
    error instanceof OpenAI.BadRequestError ||
    error instanceof OpenAI.UnprocessableEntityError ||
    (error instanceof OpenAI.APIError && error.status === 413)
  ) {
    return new AiFailure("SOURCE_REJECTED");
  }
  if (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError ||
    error instanceof OpenAI.NotFoundError ||
    (error instanceof OpenAI.APIError && error.status === 402)
  ) {
    return new AiFailure("PROVIDER_REJECTED");
  }
  return new AiFailure("PROVIDER_UNAVAILABLE");
}

async function ask(
  client: OpenAI,
  operation: string,
  params: {
    instructions: string;
    input: InputItem[];
    format?: ReturnType<typeof textFormat>;
    tools?: typeof ASSISTANT_API_TOOLS;
    effort?: "low" | "medium";
    maxTokens?: number;
    timeoutMs?: number;
  },
): Promise<Reply> {
  try {
    return await client.responses.create(
      {
        model: OPENAI_MODEL,
        instructions: params.instructions,
        input: params.input,
        max_output_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS,
        reasoning: { effort: params.effort ?? EFFORT },
        // Nothing a shop sends is kept by the provider for later turns. Every turn sends its own
        // conversation.
        store: false,
        ...(params.format ? { text: { format: params.format } } : {}),
        ...(params.tools ? { tools: params.tools } : {}),
      },
      { signal: AbortSignal.timeout(params.timeoutMs ?? REQUEST_TIMEOUT_MS) },
    );
  } catch (error) {
    if (!(error instanceof OpenAI.OpenAIError)) {
      throw error;
    }
    logFailure(operation, error);
    throw failureFrom(error);
  }
}

function messageParts(reply: Reply) {
  return reply.output.flatMap((item) => (item.type === "message" ? item.content : []));
}

function finalText(reply: Reply): string {
  return messageParts(reply)
    .flatMap((part) => (part.type === "output_text" ? [part.text] : []))
    .join("");
}

// A refusal comes back as its own part, and a content filter as an incomplete reply. Both mean the
// model declined, which a repeat would not change.
function refused(reply: Reply): boolean {
  return (
    messageParts(reply).some((part) => part.type === "refusal") ||
    (reply.status === "incomplete" && reply.incomplete_details?.reason === "content_filter")
  );
}

function cutOff(reply: Reply): boolean {
  return reply.status === "incomplete" && reply.incomplete_details?.reason === "max_output_tokens";
}

function readJson<Schema extends z.ZodType>(
  operation: string,
  reply: Reply,
  schema: Schema,
  normalize: (raw: unknown) => unknown = (raw) => raw,
): z.output<Schema> {
  if (refused(reply)) {
    throw new AiFailure("REFUSED");
  }
  if (cutOff(reply)) {
    throw new AiFailure("TOO_LONG");
  }
  if (reply.status !== "completed") {
    logFailure(operation, new Error(`Reply ended as ${reply.status ?? "unknown"}`));
    throw new AiFailure("PROVIDER_UNAVAILABLE");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(finalText(reply));
  } catch {
    logFailure(operation, new Error("Reply was not JSON"));
    throw new AiFailure("MALFORMED_OUTPUT");
  }
  const parsed = schema.safeParse(normalize(raw));
  if (!parsed.success) {
    // Paths only: the values are the source's content.
    console.error(`${operation} returned an unusable reply`, {
      paths: parsed.error.issues.slice(0, 5).map((issue) => issue.path.join(".")),
    });
    throw new AiFailure("MALFORMED_OUTPUT");
  }
  return parsed.data;
}

function usageOf(reply: Reply): AiUsage {
  return {
    inputTokens: reply.usage?.input_tokens ?? 0,
    outputTokens: reply.usage?.output_tokens ?? 0,
  };
}

function textInput(text: string): InputItem[] {
  return [{ role: "user", content: [{ type: "input_text", text }] }];
}

// The neutral conversation as Responses input: a tool's answer is its own item, after the call it
// answers, and an earlier call is replayed with the arguments it was made with.
function apiInput(messages: readonly AssistantMessage[]): InputItem[] {
  return messages.flatMap((message): InputItem[] => {
    if (message.role === "user") {
      const results = message.content.flatMap((block): InputItem[] =>
        block.type === "tool_result"
          ? [{ type: "function_call_output", call_id: block.callId, output: block.output }]
          : [],
      );
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
      return text.length > 0 ? [...results, ...textInput(text.join("\n\n"))] : results;
    }
    return message.content.map((block): InputItem =>
      block.type === "text"
        ? { role: "assistant", content: block.text }
        : {
            type: "function_call",
            call_id: block.callId,
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
    );
  });
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new AiFailure("MALFORMED_OUTPUT");
  }
}

// The SDK's own retries are off because each caller already has a bounded retry, and two layers
// would multiply into many paid requests. The key and endpoint are always passed, and the
// organization and project are pinned to none, so the SDK never reads OPENAI_* variables itself.
export function connectOpenAi(
  connection: AiConnection,
  options: { fetch?: typeof fetch } = {},
): ImportAi & SearchAi & DemandAi {
  const client = new OpenAI({
    apiKey: connection.apiKey,
    baseURL: connection.baseURL,
    organization: null,
    project: null,
    webhookSecret: null,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
    fetch: options.fetch,
  });

  return {
    async readPriceList({ bytes, mediaType }) {
      const reply = await ask(client, "Reading a price list", {
        instructions: PRICE_LIST_SYSTEM,
        format: PRICE_LIST_FORMAT,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                detail: "high",
                image_url: `data:${mediaType};base64,${bytes.toString("base64")}`,
              },
              { type: "input_text", text: PRICE_LIST_REQUEST },
            ],
          },
        ],
      });
      const { items } = readJson(
        "Reading a price list",
        reply,
        priceListExtraction,
        tolerateEnumValues,
      );
      return {
        items,
        model: reply.model,
        promptVersion: PRICE_LIST_PROMPT_VERSION,
        usage: usageOf(reply),
      };
    },

    async suggestDescriptions(rows: readonly SuggestionFacts[]) {
      const reply = await ask(client, "Suggesting descriptions", {
        instructions: DESCRIPTIONS_SYSTEM,
        format: SUGGESTIONS_FORMAT,
        input: textInput(rowsMessage(rows)),
      });
      const { rows: suggestions } = readJson(
        "Suggesting descriptions",
        reply,
        descriptionSuggestions,
      );
      return {
        suggestions,
        model: reply.model,
        promptVersion: DESCRIPTIONS_PROMPT_VERSION,
        usage: usageOf(reply),
      };
    },

    async suggestSearchTerms(rows: readonly SearchTermFacts[]) {
      const reply = await ask(client, "Suggesting search terms", {
        instructions: SEARCH_TERMS_SYSTEM,
        format: SEARCH_TERMS_FORMAT,
        input: textInput(rowsMessage(rows)),
      });
      const { rows: suggested } = readJson("Suggesting search terms", reply, searchTermsReply);
      return {
        rows: suggested,
        model: reply.model,
        promptVersion: SEARCH_TERMS_PROMPT_VERSION,
        usage: usageOf(reply),
      };
    },

    async explainDemand(facts: DemandFacts) {
      const reply = await ask(client, "Explaining demand", {
        instructions: DEMAND_EXPLANATION_SYSTEM,
        format: DEMAND_EXPLANATION_FORMAT,
        effort: DEMAND_EFFORT,
        maxTokens: DEMAND_MAX_OUTPUT_TOKENS,
        timeoutMs: DEMAND_TIMEOUT_MS,
        input: textInput(demandMessage(facts)),
      });
      const { items } = readJson("Explaining demand", reply, demandExplanationReply);
      return {
        items,
        model: reply.model,
        promptVersion: DEMAND_EXPLANATION_PROMPT_VERSION,
        usage: usageOf(reply),
      };
    },

    async assistantTurn(messages: readonly AssistantMessage[]) {
      const reply = await ask(client, "Answering a seller", {
        instructions: DEMAND_ASSISTANT_SYSTEM,
        tools: ASSISTANT_API_TOOLS,
        effort: DEMAND_EFFORT,
        maxTokens: DEMAND_MAX_OUTPUT_TOKENS,
        timeoutMs: DEMAND_TIMEOUT_MS,
        input: apiInput(messages),
      });
      if (refused(reply)) {
        throw new AiFailure("REFUSED");
      }
      const complete = !cutOff(reply);
      if (complete && reply.status !== "completed") {
        logFailure("Answering a seller", new Error(`Reply ended as ${reply.status ?? "unknown"}`));
        throw new AiFailure("PROVIDER_UNAVAILABLE");
      }
      return {
        complete,
        text: finalText(reply),
        // A call cut off by the limit holds arguments nobody meant, so it is never passed on.
        toolCalls: complete
          ? reply.output.flatMap((item) =>
              item.type === "function_call"
                ? [{ callId: item.call_id, name: item.name, input: parseArguments(item.arguments) }]
                : [],
            )
          : [],
        model: reply.model,
        promptVersion: DEMAND_ASSISTANT_PROMPT_VERSION,
        usage: usageOf(reply),
      };
    },
  };
}

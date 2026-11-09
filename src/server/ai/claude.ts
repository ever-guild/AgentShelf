import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
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
  type AiUsage,
  type AssistantMessage,
  type DemandAi,
  type DemandFacts,
  type ImportAi,
  type SearchAi,
  type SearchTermFacts,
  type SuggestionFacts,
} from "./types";

// The Claude adapter for catalog import, search terms and demand. This is the only file that knows the provider.
//
// This file and the import runner carry no `server-only` guard, like db/client.ts, because a
// workflow task runs them outside Next.js, where that guard cannot load. The key is read from the
// environment on the server, and no route or page hands it to a client.

export const IMPORT_MODEL = "claude-opus-5-5";
// Re-exported for the callers and tests that read them from here.
export {
  DEMAND_ASSISTANT_PROMPT_VERSION,
  DEMAND_EXPLANATION_PROMPT_VERSION,
  DESCRIPTIONS_PROMPT_VERSION,
  PRICE_LIST_PROMPT_VERSION,
  SEARCH_TERMS_PROMPT_VERSION,
};

// Below a workflow task's five-minute limit, so a run that times out can still record the failure.
const REQUEST_TIMEOUT_MS = 4 * 60 * 1000;
// A long list needs room, and streaming keeps a response of this size from hitting an HTTP timeout.
const MAX_OUTPUT_TOKENS = 64_000;
const EFFORT = "medium";
// A seller is waiting on these two, and short answers need less room and less depth than a photo.
const DEMAND_TIMEOUT_MS = 60 * 1000;
const DEMAND_MAX_OUTPUT_TOKENS = 8_000;
const DEMAND_EFFORT = "low";

// The SDK's helper builds the schema. Its parser is left out because it would throw on a refusal or
// a truncated answer before the stop reason could be read, so the answer is checked in `readJson`.
// The helper also turns an enum into a note in the field's description, so a model can return a
// value outside it. `tolerateEnumValues` deals with that.
function outputFormat(schema: z.ZodType) {
  const { type, schema: jsonSchema } = zodOutputFormat(schema);
  return { type, schema: jsonSchema };
}

const PRICE_LIST_FORMAT = outputFormat(priceListExtraction);
const SUGGESTIONS_FORMAT = outputFormat(descriptionSuggestions);
const SEARCH_TERMS_FORMAT = outputFormat(searchTermsReply);
const DEMAND_EXPLANATION_FORMAT = outputFormat(demandExplanationReply);

const ASSISTANT_API_TOOLS = ASSISTANT_TOOLS.map(({ name, description, parameters }) => ({
  name,
  description,
  input_schema: parameters,
}));

type Reply = Anthropic.Beta.BetaMessage;

// A short record for the server log. A provider's message can quote the request, so it stays out.
function logFailure(operation: string, error: unknown): void {
  const apiError = error instanceof Anthropic.APIError ? error : undefined;
  console.error(`${operation} failed`, {
    name: error instanceof Error ? error.name : "unknown",
    status: apiError?.status,
    requestId: apiError?.requestID,
  });
}

function failureFrom(error: unknown): AiFailure {
  // Order matters: the connection errors extend APIError and have no status.
  if (
    error instanceof Anthropic.BadRequestError ||
    error instanceof Anthropic.UnprocessableEntityError ||
    (error instanceof Anthropic.APIError && error.status === 413)
  ) {
    return new AiFailure("SOURCE_REJECTED");
  }
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.NotFoundError ||
    (error instanceof Anthropic.APIError && error.status === 402)
  ) {
    return new AiFailure("PROVIDER_REJECTED");
  }
  return new AiFailure("PROVIDER_UNAVAILABLE");
}

async function ask(
  client: Anthropic,
  operation: string,
  params: {
    system: string;
    messages: Anthropic.Beta.BetaMessageParam[];
    format?: ReturnType<typeof outputFormat>;
    tools?: typeof ASSISTANT_API_TOOLS;
    effort?: "low" | "medium";
    maxTokens?: number;
    timeoutMs?: number;
  },
): Promise<Reply> {
  try {
    return await client.beta.messages
      .stream(
        {
          model: IMPORT_MODEL,
          max_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS,
          // If the model's safety classifiers decline a harmless list, the API retries on the model
          // it recommends instead of failing the import. That is why the job records `reply.model`.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: params.effort ?? EFFORT, format: params.format },
          system: params.system,
          tools: params.tools,
          messages: params.messages,
        },
        { signal: AbortSignal.timeout(params.timeoutMs ?? REQUEST_TIMEOUT_MS) },
      )
      .finalMessage();
  } catch (error) {
    if (!(error instanceof Anthropic.AnthropicError)) {
      throw error;
    }
    logFailure(operation, error);
    throw failureFrom(error);
  }
}

// When a fallback model takes over mid-stream, the reply keeps the first model's partial text
// before the switch, so only what follows the last switch is the answer.
function finalBlocks(
  content: readonly Anthropic.Beta.BetaContentBlock[],
): readonly Anthropic.Beta.BetaContentBlock[] {
  const lastSwitch = content.findLastIndex((block) => block.type === "fallback");
  return content.slice(lastSwitch + 1);
}

function finalText(content: readonly Anthropic.Beta.BetaContentBlock[]): string {
  return finalBlocks(content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

function apiMessage(message: AssistantMessage): Anthropic.Beta.BetaMessageParam {
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content.map((block) =>
        block.type === "text"
          ? block
          : { type: "tool_result" as const, tool_use_id: block.callId, content: block.output },
      ),
    };
  }
  return {
    role: "assistant",
    content: message.content.map((block) =>
      block.type === "text"
        ? block
        : { type: "tool_use" as const, id: block.callId, name: block.name, input: block.input },
    ),
  };
}

// Structured output narrows what a model can return, and it does not hold on a refusal or a
// truncated answer, so the reply is judged by its stop reason and then validated like any input.
function readJson<Schema extends z.ZodType>(
  operation: string,
  reply: Reply,
  schema: Schema,
  normalize: (raw: unknown) => unknown = (raw) => raw,
): z.output<Schema> {
  if (reply.stop_reason === "refusal") {
    throw new AiFailure("REFUSED");
  }
  if (reply.stop_reason === "max_tokens") {
    throw new AiFailure("TOO_LONG");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(finalText(reply.content));
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
    inputTokens: reply.usage.input_tokens,
    outputTokens: reply.usage.output_tokens,
  };
}

// Undefined when no key is configured. The SDK's own retries are off because each caller already
// has a bounded retry, and two layers would multiply into many paid requests.
export function createClaudeAi(
  env: Record<string, string | undefined> = process.env,
  options: { fetch?: typeof fetch } = {},
): (ImportAi & SearchAi & DemandAi) | undefined {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return undefined;
  }
  const client = new Anthropic({
    apiKey,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
    fetch: options.fetch,
  });

  return {
    async readPriceList({ bytes, mediaType }) {
      const reply = await ask(client, "Reading a price list", {
        system: PRICE_LIST_SYSTEM,
        format: PRICE_LIST_FORMAT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
              },
              { type: "text", text: PRICE_LIST_REQUEST },
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
        system: DESCRIPTIONS_SYSTEM,
        format: SUGGESTIONS_FORMAT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: rowsMessage(rows) }],
          },
        ],
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
        system: SEARCH_TERMS_SYSTEM,
        format: SEARCH_TERMS_FORMAT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: rowsMessage(rows) }],
          },
        ],
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
        system: DEMAND_EXPLANATION_SYSTEM,
        format: DEMAND_EXPLANATION_FORMAT,
        effort: DEMAND_EFFORT,
        maxTokens: DEMAND_MAX_OUTPUT_TOKENS,
        timeoutMs: DEMAND_TIMEOUT_MS,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: demandMessage(facts) }],
          },
        ],
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
        system: DEMAND_ASSISTANT_SYSTEM,
        tools: ASSISTANT_API_TOOLS,
        effort: DEMAND_EFFORT,
        maxTokens: DEMAND_MAX_OUTPUT_TOKENS,
        timeoutMs: DEMAND_TIMEOUT_MS,
        messages: messages.map(apiMessage),
      });
      if (reply.stop_reason === "refusal") {
        throw new AiFailure("REFUSED");
      }
      const complete = reply.stop_reason !== "max_tokens";
      return {
        complete,
        text: finalText(reply.content),
        // A call cut off by the limit holds arguments nobody meant, so it is never passed on.
        toolCalls: complete
          ? finalBlocks(reply.content).flatMap((block) =>
              block.type === "tool_use"
                ? [{ callId: block.id, name: block.name, input: block.input }]
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

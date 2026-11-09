import { createClaudeAi } from "./claude";
import { createOpenAiAi } from "./openai";
import type { DemandAi, ImportAi, SearchAi } from "./types";

// The one place that picks the provider. AI_PROVIDER names one, `anthropic` or `openai`. With no
// choice, Claude when its key is set, then OpenAI. A named provider without its key, or a name that
// is not one of these, leaves AI off rather than quietly using the other: CSV import keeps working,
// and photo import, suggestions and insights say that AI is not configured.

export type AiProvider = "anthropic" | "openai";

export function chooseAiProvider(env: Record<string, string | undefined>): AiProvider | undefined {
  const choice = env.AI_PROVIDER?.trim().toLowerCase();
  if (choice === "anthropic") {
    return env.ANTHROPIC_API_KEY ? "anthropic" : undefined;
  }
  if (choice === "openai") {
    return env.OPENAI_API_KEY ? "openai" : undefined;
  }
  if (choice) {
    return undefined;
  }
  if (env.ANTHROPIC_API_KEY) {
    return "anthropic";
  }
  return env.OPENAI_API_KEY ? "openai" : undefined;
}

export function isAiConfigured(env: Record<string, string | undefined>): boolean {
  return chooseAiProvider(env) !== undefined;
}

function createAi(
  env: Record<string, string | undefined>,
): (ImportAi & SearchAi & DemandAi) | undefined {
  switch (chooseAiProvider(env)) {
    case "anthropic":
      return createClaudeAi(env);
    case "openai":
      return createOpenAiAi(env);
    default:
      return undefined;
  }
}

export function createImportAi(env: Record<string, string | undefined>): ImportAi | undefined {
  return createAi(env);
}

export function createSearchAi(env: Record<string, string | undefined>): SearchAi | undefined {
  return createAi(env);
}

export function createDemandAi(env: Record<string, string | undefined>): DemandAi | undefined {
  return createAi(env);
}

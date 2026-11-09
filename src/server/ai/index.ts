import { CLAUDE_BASE_URL, connectClaude } from "./claude";
import { OPENAI_BASE_URL, connectOpenAi } from "./openai";
import type { AiConnection, DemandAi, ImportAi, SearchAi } from "./types";

// The one place that picks the provider, from the operator's configuration:
//
//   AGENT_SHELF_AI_PROVIDER           openai or anthropic
//   AGENT_SHELF_AI_PROVIDER_BASE_URL  the provider's API root, https only. Blank means its default
//   AGENT_SHELF_AI_PROVIDER_API_KEY   the key for that provider
//
// A named provider without a key, an unknown name or an unusable base URL leaves AI off rather than
// falling back to anything else: CSV import keeps working, and photo import, suggestions and
// insights say that AI is not configured. With no provider named, a deployment that only has
// ANTHROPIC_API_KEY keeps running on Claude, as before these names existed.

export type AiProvider = "anthropic" | "openai";

export type AiConfiguration = AiConnection & { provider: AiProvider };

const DEFAULT_BASE_URL: Record<AiProvider, string> = {
  anthropic: CLAUDE_BASE_URL,
  openai: OPENAI_BASE_URL,
};

function isProvider(name: string): name is AiProvider {
  return name === "anthropic" || name === "openai";
}

// An https URL with no credentials, query or fragment, without a trailing slash.
function trustedBaseUrl(raw: string | undefined, provider: AiProvider): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_BASE_URL[provider];
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return undefined;
  }
  return url.href.replace(/\/+$/, "");
}

export function aiConfiguration(
  env: Record<string, string | undefined>,
): AiConfiguration | undefined {
  const named = env.AGENT_SHELF_AI_PROVIDER?.trim().toLowerCase();
  if (named) {
    if (!isProvider(named)) {
      return undefined;
    }
    const apiKey = env.AGENT_SHELF_AI_PROVIDER_API_KEY?.trim();
    const baseURL = trustedBaseUrl(env.AGENT_SHELF_AI_PROVIDER_BASE_URL, named);
    return apiKey && baseURL ? { provider: named, apiKey, baseURL } : undefined;
  }
  const legacyKey = env.ANTHROPIC_API_KEY?.trim();
  return legacyKey
    ? { provider: "anthropic", apiKey: legacyKey, baseURL: CLAUDE_BASE_URL }
    : undefined;
}

export function chooseAiProvider(env: Record<string, string | undefined>): AiProvider | undefined {
  return aiConfiguration(env)?.provider;
}

export function isAiConfigured(env: Record<string, string | undefined>): boolean {
  return aiConfiguration(env) !== undefined;
}

function createAi(
  env: Record<string, string | undefined>,
): (ImportAi & SearchAi & DemandAi) | undefined {
  const configuration = aiConfiguration(env);
  if (!configuration) {
    return undefined;
  }
  const { provider, apiKey, baseURL } = configuration;
  return provider === "openai"
    ? connectOpenAi({ apiKey, baseURL })
    : connectClaude({ apiKey, baseURL });
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

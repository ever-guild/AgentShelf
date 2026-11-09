import { describe, expect, it } from "vitest";

import { aiConfiguration, chooseAiProvider, createDemandAi, createImportAi, isAiConfigured } from ".";

const OPENAI = {
  AGENT_SHELF_AI_PROVIDER: "openai",
  AGENT_SHELF_AI_PROVIDER_BASE_URL: "https://api.openai.com/v1",
  AGENT_SHELF_AI_PROVIDER_API_KEY: "openai-key",
};

describe("the AI configuration", () => {
  it.each([
    ["nothing set", {}, undefined],
    ["the agreed OpenAI settings", OPENAI, { provider: "openai", apiKey: "openai-key", baseURL: "https://api.openai.com/v1" }],
    [
      "OpenAI with a blank base URL, which takes its default",
      { ...OPENAI, AGENT_SHELF_AI_PROVIDER_BASE_URL: " " },
      { provider: "openai", apiKey: "openai-key", baseURL: "https://api.openai.com/v1" },
    ],
    [
      "a base URL with a trailing slash and spaces",
      { ...OPENAI, AGENT_SHELF_AI_PROVIDER: " OpenAI ", AGENT_SHELF_AI_PROVIDER_BASE_URL: " https://gateway.example/openai/v1/ " },
      { provider: "openai", apiKey: "openai-key", baseURL: "https://gateway.example/openai/v1" },
    ],
    [
      "Claude named the same way",
      { AGENT_SHELF_AI_PROVIDER: "anthropic", AGENT_SHELF_AI_PROVIDER_API_KEY: "anthropic-key" },
      { provider: "anthropic", apiKey: "anthropic-key", baseURL: "https://api.anthropic.com" },
    ],
    [
      "only the older Claude key, as deployments had before these names",
      { ANTHROPIC_API_KEY: "anthropic-key" },
      { provider: "anthropic", apiKey: "anthropic-key", baseURL: "https://api.anthropic.com" },
    ],
    ["OpenAI named with no key, even with a Claude key present", { ...OPENAI, AGENT_SHELF_AI_PROVIDER_API_KEY: "", ANTHROPIC_API_KEY: "anthropic-key" }, undefined],
    ["a provider that is not one of the two", { ...OPENAI, AGENT_SHELF_AI_PROVIDER: "gemini" }, undefined],
    ["a key with no provider named", { AGENT_SHELF_AI_PROVIDER_API_KEY: "openai-key" }, undefined],
    ["an http base URL", { ...OPENAI, AGENT_SHELF_AI_PROVIDER_BASE_URL: "http://api.openai.com/v1" }, undefined],
    ["a base URL with credentials", { ...OPENAI, AGENT_SHELF_AI_PROVIDER_BASE_URL: "https://user:pass@api.openai.com/v1" }, undefined],
    ["a base URL with a query", { ...OPENAI, AGENT_SHELF_AI_PROVIDER_BASE_URL: "https://api.openai.com/v1?key=x" }, undefined],
    ["a base URL that is not one", { ...OPENAI, AGENT_SHELF_AI_PROVIDER_BASE_URL: "api.openai.com" }, undefined],
    ["the superseded names", { AI_PROVIDER: "openai", OPENAI_API_KEY: "openai-key" }, undefined],
  ])("with %s", (_case, env: Record<string, string>, expected) => {
    expect(aiConfiguration(env)).toEqual(expected);
    expect(chooseAiProvider(env)).toBe(expected?.provider);
    expect(isAiConfigured(env)).toBe(expected !== undefined);
    expect(createImportAi(env) === undefined).toBe(expected === undefined);
    expect(createDemandAi(env) === undefined).toBe(expected === undefined);
  });
});

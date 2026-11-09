import { describe, expect, it } from "vitest";

import { chooseAiProvider, createDemandAi, createImportAi, isAiConfigured } from ".";

const BOTH = { ANTHROPIC_API_KEY: "anthropic-key", OPENAI_API_KEY: "openai-key" };

describe("choosing the AI provider", () => {
  it.each([
    ["no key", {}, undefined],
    ["only Claude's key", { ANTHROPIC_API_KEY: "anthropic-key" }, "anthropic"],
    ["only OpenAI's key", { OPENAI_API_KEY: "openai-key" }, "openai"],
    ["both keys and no choice", BOTH, "anthropic"],
    ["both keys and OpenAI chosen", { ...BOTH, AI_PROVIDER: "openai" }, "openai"],
    ["both keys and Claude chosen", { ...BOTH, AI_PROVIDER: " Anthropic " }, "anthropic"],
    ["OpenAI chosen without its key", { ANTHROPIC_API_KEY: "anthropic-key", AI_PROVIDER: "openai" }, undefined],
    ["Claude chosen without its key", { OPENAI_API_KEY: "openai-key", AI_PROVIDER: "anthropic" }, undefined],
    ["a name that is not a provider", { ...BOTH, AI_PROVIDER: "gemini" }, undefined],
    ["an empty choice", { ...BOTH, AI_PROVIDER: "" }, "anthropic"],
  ])("with %s", (_case, env: Record<string, string>, provider) => {
    expect(chooseAiProvider(env)).toBe(provider);
    expect(isAiConfigured(env)).toBe(provider !== undefined);
    expect(createImportAi(env) === undefined).toBe(provider === undefined);
    expect(createDemandAi(env) === undefined).toBe(provider === undefined);
  });
});

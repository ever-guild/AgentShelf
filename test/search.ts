import { AiFailure, type SearchAi, type SearchTermFacts } from "../src/server/ai/types";

export type FakeTerms = {
  english?: string[];
  latvian?: string[];
  russian?: string[];
  places?: string[];
};

// A model that answers from a table of listing titles and remembers what it was asked. It stands in
// at the seam the search code uses, and the real adapter has its own tests against an HTTP stand-in.
// `failWith` makes every request fail. `onRequest` runs while the model is thinking.
export function createFakeSearchAi(table: Record<string, FakeTerms> = {}) {
  const requests: SearchTermFacts[][] = [];
  const state: {
    failWith: AiFailure | undefined;
    onRequest: (() => Promise<void>) | undefined;
    skip: Set<string>;
  } = { failWith: undefined, onRequest: undefined, skip: new Set() };

  const ai: SearchAi = {
    searchTermsPromptVersion: "fake-prompt",
    async suggestSearchTerms(rows) {
      requests.push([...rows]);
      await state.onRequest?.();
      if (state.failWith) {
        throw state.failWith;
      }
      return {
        rows: rows
          .filter((row) => !state.skip.has(row.title))
          .map((row) => ({
            position: row.position,
            english: table[row.title]?.english ?? [],
            latvian: table[row.title]?.latvian ?? [],
            russian: table[row.title]?.russian ?? [],
            places: table[row.title]?.places ?? [],
          })),
        model: "fake-model",
        promptVersion: "fake-prompt",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  return { ai, requests, state };
}

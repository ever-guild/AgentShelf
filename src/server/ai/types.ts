import type { ExtractedItem } from "../contracts/imports";
import type { ImageMediaType } from "../imports/file-type";

// What catalog import needs from a vision-capable model. The rest of the code knows only this, so
// choosing another provider means writing another adapter and nothing else.

export type AiUsage = { inputTokens: number; outputTokens: number };

export type PriceListReading = {
  items: ExtractedItem[];
  // The model that answered, which is not always the one asked: see the note in claude.ts.
  model: string;
  promptVersion: string;
  usage: AiUsage;
};

export type SuggestionFacts = {
  position: number;
  title: string;
  kind: "product" | "service" | null;
  description: string | null;
};

export type DescriptionSuggestion = { position: number; english: string; latvian: string };

export type SuggestionReading = {
  suggestions: DescriptionSuggestion[];
  model: string;
  promptVersion: string;
  usage: AiUsage;
};

export type ImportAi = {
  readPriceList(image: { bytes: Buffer; mediaType: ImageMediaType }): Promise<PriceListReading>;
  suggestDescriptions(rows: readonly SuggestionFacts[]): Promise<SuggestionReading>;
};

// A published listing's public text and nothing else, since a draft must never reach a model.
export type SearchTermFacts = {
  position: number;
  title: string;
  kind: "product" | "service";
  description: string | null;
  descriptionLv: string | null;
  location: string | null;
};

export type SuggestedSearchTerms = {
  position: number;
  english: string[];
  latvian: string[];
  russian: string[];
  places: string[];
};

export type SearchTermsReading = {
  rows: SuggestedSearchTerms[];
  model: string;
  promptVersion: string;
  usage: AiUsage;
};

export type SearchAi = {
  suggestSearchTerms(rows: readonly SearchTermFacts[]): Promise<SearchTermsReading>;
};

// One shop's unmet demand as counted by the database, and nothing else. No event reference, order,
// payment or customer reaches a model. Query text and titles are untrusted data.
export type DemandFacts = {
  window: { startDate: string; endDate: string; days: number; timezone: string };
  unmetSearches: number;
  groups: {
    groupId: string;
    label: string;
    searches: number;
    recordedSearches: number;
    sampleSearches: number;
    degradedSearches: number;
    examples: { query: string; searches: number }[];
    sharedWords: string[];
    closestListings: string[];
    locations: string[];
  }[];
};

export type DemandExplanationReading = {
  items: { groupId: string; explanation: string; suggestedAction: string }[];
  model: string;
  promptVersion: string;
  usage: AiUsage;
};

// A conversation in neutral form, already checked: it starts and ends on the user's side, and every
// tool call has its result.
export type AssistantMessage =
  | {
      role: "user";
      content: (
        | { type: "text"; text: string }
        | { type: "tool_result"; callId: string; output: string }
      )[];
    }
  | {
      role: "assistant";
      content: (
        | { type: "text"; text: string }
        | { type: "tool_call"; callId: string; name: string; input: Record<string, unknown> }
      )[];
    };

export type AssistantReading = {
  // False when the answer ran out of room, so what is there may stop short.
  complete: boolean;
  text: string;
  toolCalls: { callId: string; name: string; input: unknown }[];
  model: string;
  promptVersion: string;
  usage: AiUsage;
};

// The instructions and the tool list are the adapter's and the contract's, never a caller's.
export type DemandAi = {
  explainDemand(facts: DemandFacts): Promise<DemandExplanationReading>;
  assistantTurn(messages: readonly AssistantMessage[]): Promise<AssistantReading>;
};

export type AiFailureCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REJECTED"
  | "SOURCE_REJECTED"
  | "MALFORMED_OUTPUT"
  | "REFUSED"
  | "TOO_LONG";

// Only a failure that a repeat could change is worth an automatic retry. The others cost money and
// come back the same, so they go straight to the seller.
const AUTOMATICALLY_RETRIED: ReadonlySet<AiFailureCode> = new Set([
  "PROVIDER_UNAVAILABLE",
  "MALFORMED_OUTPUT",
]);

export class AiFailure extends Error {
  constructor(readonly code: AiFailureCode) {
    super(`AI request failed: ${code}`);
    this.name = "AiFailure";
  }

  get retriedAutomatically(): boolean {
    return AUTOMATICALLY_RETRIED.has(this.code);
  }
}

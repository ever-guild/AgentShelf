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

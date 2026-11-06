import type { DemandGroup, DemandInsightItem } from "../contracts/seller-insights";

// What stands between a model's words and a seller. Counts on the page come from the database, so the
// model has no reason to state a number, an amount or a link. A reply that does gets rejected whole,
// and the seller sees the counts alone.

const MAX_EXPLANATION = 400;
const MAX_ACTION = 240;

const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|io|lv|ru)\b/i;
const MONEY =
  /[€$£₽]|\b(?:eur|euros?|usd|dollars?|gbp|pounds?|rub|revenue|profit|income|turnover|earn(?:s|ed|ings)?|uplift|margin|lost sales?)\b/i;
const NUMBER = /\p{N}+/gu;
const NUMBER_WORDS = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozens?|hundreds?|thousands?)\b/gi;
const NUMBER_WORD_VALUES: Record<string, string> = {
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};

function supportedNumbers(group: DemandGroup, periodDays: number): Set<string> {
  const supported = new Set<string>(
    [
      periodDays,
      group.searches,
      group.recordedSearches,
      group.sampleSearches,
      group.degradedSearches,
      ...group.examples.map(({ searches }) => searches),
    ].map(String),
  );
  const named = [group.label, ...group.examples.map(({ query }) => query), ...group.sharedWords, ...group.listings];
  for (const text of named) {
    for (const number of text.match(NUMBER) ?? []) {
      supported.add(number);
    }
  }
  return supported;
}

function claimProblem(text: string, supported: Set<string>): string | null {
  if (LINK.test(text)) {
    return "link";
  }
  if (MONEY.test(text)) {
    return "money";
  }
  if ((text.match(NUMBER) ?? []).some((number) => !supported.has(number))) {
    return "number";
  }
  const words = (text.match(NUMBER_WORDS) ?? []).map((word) => word.toLowerCase());
  if (words.some((word) => !supported.has(NUMBER_WORD_VALUES[word] ?? "none"))) {
    return "number";
  }
  return null;
}

export type ExplanationCheck =
  | { ok: true; items: DemandInsightItem[] }
  | { ok: false; problem: string };

// Only groups the seller is entitled to and the model was shown can come back, once each.
export function checkDemandExplanation(
  reply: { items: { groupId: string; explanation: string; suggestedAction: string }[] },
  groups: readonly DemandGroup[],
  periodDays: number,
): ExplanationCheck {
  const byId = new Map(groups.map((group) => [group.groupId, group]));
  const seen = new Set<string>();
  const items: DemandInsightItem[] = [];

  for (const { groupId, explanation: rawExplanation, suggestedAction: rawAction } of reply.items) {
    const group = byId.get(groupId);
    if (!group) {
      return { ok: false, problem: "unknown_group" };
    }
    if (seen.has(groupId)) {
      return { ok: false, problem: "repeated_group" };
    }
    seen.add(groupId);

    const explanation = rawExplanation.trim();
    const suggestedAction = rawAction.trim();
    if (
      !explanation ||
      !suggestedAction ||
      explanation.length > MAX_EXPLANATION ||
      suggestedAction.length > MAX_ACTION
    ) {
      return { ok: false, problem: "length" };
    }
    const supported = supportedNumbers(group, periodDays);
    const problem = claimProblem(explanation, supported) ?? claimProblem(suggestedAction, supported);
    if (problem) {
      return { ok: false, problem };
    }
    items.push({ groupId, label: group.label, searchesAtWriting: group.searches, explanation, suggestedAction });
  }

  return items.length > 0 ? { ok: true, items } : { ok: false, problem: "empty" };
}

const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const BARE_LINK = /\b(?:[a-z][a-z\d+.-]*:\/\/|mailto:|www\.)\S+|(?<![\w/:])\/\/\S+/gi;

// An assistant's chat answer is free text and a stranger's words can reach it, so a link never does.
// The chat renders markdown, and its link and image syntax makes a live anchor of almost any target,
// so that syntax goes whatever it points at. Breaking what is left of "](" means removing one link
// cannot leave the pieces of another.
export function withoutLinks(text: string): string {
  return text
    .replace(MARKDOWN_LINK, "$1 (link removed)")
    .replaceAll("](", "] (")
    .replace(BARE_LINK, "(link removed)");
}

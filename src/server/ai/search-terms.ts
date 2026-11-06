import type { SearchTermFacts, SuggestedSearchTerms } from "./types";

// What a model's suggestion has to pass before it can make a product findable. A model's reply is
// untrusted, and a listing it read may be hostile, so a term that could not honestly come from the
// listing is dropped here, whatever the prompt said. Dropping is per term: an honest row keeps the
// rest, and an empty result still counts as indexed, since the listing's own words always match.

const MAX_TERM_LENGTH = 60;
const MAX_TERM_WORDS = 6;
const MAX_PER_LANGUAGE = 15;
const MAX_PLACES = 12;

// Words, numbers and the punctuation that real names use. No markup, links or addresses.
const TERM_SHAPE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} +\-./'’&]*$/u;
const LINK_SHAPE = /\/\/|www\.|\.(com|lv|ru|net|org)\b/iu;

const numbersIn = (text: string): string[] => text.match(/\p{N}+/gu) ?? [];

function cleanList(
  list: readonly string[],
  allowed: (term: string) => boolean,
  max: number,
  seen: Set<string>,
): string[] {
  const kept: string[] = [];
  for (const raw of list) {
    const term = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
    const key = term.toLocaleLowerCase("und");
    if (
      kept.length === max ||
      term.length === 0 ||
      term.length > MAX_TERM_LENGTH ||
      term.split(" ").length > MAX_TERM_WORDS ||
      !TERM_SHAPE.test(term) ||
      LINK_SHAPE.test(term) ||
      seen.has(key) ||
      !allowed(term)
    ) {
      continue;
    }
    seen.add(key);
    kept.push(term);
  }
  return kept;
}

export function cleanSearchTerms(
  facts: SearchTermFacts,
  suggested: SuggestedSearchTerms,
): { terms: string[]; placeTerms: string[] } {
  // A number the listing does not state would sell an "iPhone 14" or a "5000 mAh" that is not there,
  // which is the one invention that can be checked.
  const stated = new Set(
    numbersIn([facts.title, facts.description, facts.descriptionLv].join(" ")),
  );
  const onlyStatedNumbers = (term: string) => numbersIn(term).every((n) => stated.has(n));

  const seen = new Set<string>();
  const terms = [suggested.english, suggested.latvian, suggested.russian].flatMap((list) =>
    cleanList(list, onlyStatedNumbers, MAX_PER_LANGUAGE, seen),
  );
  const placeTerms = facts.location
    ? cleanList(suggested.places, (term) => numbersIn(term).length === 0, MAX_PLACES, new Set())
    : [];
  return { terms, placeTerms };
}

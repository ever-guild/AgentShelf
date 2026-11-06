import "server-only";

import { and, eq, or, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client";
import { productSearchTerms, products } from "../db/schema";

// How a search is read and matched, shared by the search itself and by demand attribution so the two
// cannot disagree about what a word matches. Everything here is deterministic Postgres: a query makes
// no model call. Folding is `agentshelf_fold` in drizzle/0008_search_vectors.sql, the one definition
// used for listings and queries alike.

const MAX_SEARCH_WORDS = 12;
const MAX_NORMALIZED_LENGTH = 200;
// Below this a prefix matches too much: "car" would find "card".
const MIN_PREFIX_LENGTH = 4;
// A near spelling covers endings, which Latvian and Russian change constantly and a term list cannot
// cover: "разбитого" against "разбитый", "repairs" against "repair". It compares a word's start, up to
// three letters short. A word with a number is never near-matched, because "S21" is not "S22".
const NEAR_SPELLING_MIN_LENGTH = 5;
const NEAR_SPELLING_MAX_ENDING = 3;

// Already folded, since they are compared after folding. Words that say nothing about the item, in
// the three languages buyers use here. Price words are here because maxPriceMinor is how to ask.
const STOP_WORDS = new Set(
  `a an and any are at best buy can cheap cheapest could do does for from get have i in is looking me
   my near need of on or our please some the there to want we where who with would you your
   ar es gribu ir ka kas kur lai lets man mana mans nepieciesama nepieciesams no nopirkt pakalpojums
   par pie pirkt un uz vai vajag velos
   а в во где дешево для есть и из к кто купить куплю мне можно мое мой моя на недорого нужен нужна
   нужно нужны о от по пожалуйста с со у хочу`.split(/\s+/),
);

// Contact details and long numbers, removed before a query is searched or recorded. A person's name
// cannot be recognised this way, which is why tools ask assistants not to send one, and why events
// have a retention limit.
const CONTACT_DETAILS = [
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+/gu,
  /\b(?:https?:\/\/|www\.)\S+/giu,
  /(?<![\p{L}\p{N}])\+?\p{N}(?:[ ().-]?\p{N}){6,}(?![\p{L}\p{N}])/gu,
];

// Control characters go too, because Postgres refuses a NUL in any text.
function withoutContactDetails(text: string): string {
  return CONTACT_DETAILS.reduce(
    (rest, pattern) => rest.replace(pattern, " "),
    text.replace(/\p{Cc}/gu, " "),
  );
}

function wordsOf(folded: string): string[] {
  const words = folded.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  const meaningful = words.filter((word) => !STOP_WORDS.has(word));
  return (meaningful.length > 0 ? meaningful : words).slice(0, MAX_SEARCH_WORDS);
}

export type ReadQuery = {
  words: string[];
  locationWords: string[];
  // True when a location was asked for and nothing in it could be matched.
  locationUnreadable: boolean;
  // What an event stores. Empty when nothing of the query is left.
  normalizedQuery: string;
  normalizedLocation: string | null;
};

export async function readQuery(
  db: Db,
  input: { query: string; location?: string },
): Promise<ReadQuery> {
  const result = await db.execute<{ query: string; location: string | null }>(
    sql`SELECT agentshelf_fold(${withoutContactDetails(input.query)}::text) AS query,
               agentshelf_fold(${input.location === undefined ? null : withoutContactDetails(input.location)}::text) AS location`,
  );
  const [folded] = result.rows;
  const words = wordsOf(folded.query);
  const locationWords = folded.location ? wordsOf(folded.location) : [];
  return {
    words,
    locationWords,
    locationUnreadable: input.location !== undefined && locationWords.length === 0,
    normalizedQuery: words.join(" ").slice(0, MAX_NORMALIZED_LENGTH),
    normalizedLocation: locationWords.length > 0 ? locationWords.join(" ") : null,
  };
}

// The vectors are generated columns the Drizzle schema leaves out. Weights say where a word came
// from: A title, B description, C model terms or shop name, D shop location or place terms.
const productVector = sql`"products"."search_vector"`;
const shopVector = sql`"shops"."search_vector"`;
const termsVector = sql`coalesce("product_search_terms"."search_vector", ''::tsvector)`;
const wholeVector = sql`(${productVector} || ${shopVector} || ${termsVector})`;
const listingVector = sql`(${productVector} || ${termsVector})`;

const hasNumber = (word: string) => /\p{N}/u.test(word);
const nearSpellingApplies = (word: string) =>
  word.length >= NEAR_SPELLING_MIN_LENGTH && !hasNumber(word);

export const nearSpellingCouldHelp = (query: ReadQuery): boolean =>
  [...query.words, ...query.locationWords].some(nearSpellingApplies);

// Words hold only letters, marks and digits, and each is a bound parameter inside a quoted lexeme,
// so a query cannot change the shape of what is asked.
function lexeme(word: string, weights = ""): SQL {
  const prefix = word.length >= MIN_PREFIX_LENGTH && !hasNumber(word) ? "*" : "";
  const flags = prefix + weights;
  const text = `'${word}'${flags ? `:${flags}` : ""}`;
  return sql`to_tsquery('simple'::regconfig, ${text}::text)`;
}

function matching(word: string, vector: SQL, weights: string, near: boolean): SQL {
  const exact = sql`${vector} @@ ${lexeme(word, weights)}`;
  if (!near || !nearSpellingApplies(word)) {
    return exact;
  }
  const start = word.slice(
    0,
    Math.max(NEAR_SPELLING_MIN_LENGTH, word.length - NEAR_SPELLING_MAX_ENDING),
  );
  return or(exact, sql`${vector} @@ ${lexeme(start, weights)}`) as SQL;
}

// A word of the query, against the listing, its terms and its shop.
export const matchesAnywhere = (word: string, near: boolean): SQL =>
  matching(word, wholeVector, "", near);

// A word against what is on sale, leaving out the shop's name and place.
export const matchesListing = (word: string, near: boolean): SQL =>
  matching(word, listingVector, "ABC", near);

// A word against where the shop is, in any spelling. Free text only, for attribution.
export const matchesPlace = (word: string, near: boolean): SQL =>
  matching(word, sql`(${shopVector} || ${termsVector})`, "D", near);

// The location filter reads the seller's own field and nothing a model wrote, so a listing cannot
// talk its way into another city.
export const inLocation = (words: readonly string[], near: boolean): SQL | undefined =>
  and(...words.map((word) => matching(word, shopVector, "D", near)));

// Title beats description beats everything else, and repeating a word earns nothing. A sum over
// fixed tiers rather than ts_rank, so a seller cannot climb by stuffing a listing.
export const relevance = (words: readonly string[]): SQL =>
  sql.join(
    words.map(
      (word) => sql`(CASE
        WHEN ${wholeVector} @@ ${lexeme(word, "A")} THEN 4
        WHEN ${wholeVector} @@ ${lexeme(word, "B")} THEN 2
        ELSE 1 END)`,
    ),
    sql` + `,
  );

// What a listing's terms were made from. It covers exactly what the model is shown, so a change of
// price or stock costs no model call, and any change of text retires the old terms at once.
export const listingHash = sql<string>`md5(concat_ws(chr(31),
  "products"."kind"::text, "products"."title", "products"."description",
  "products"."description_lv", "shops"."location"
))`;

// Joined to a product, this yields a row only for terms that are finished and still true of it.
export const currentTerms = and(
  eq(productSearchTerms.productId, products.id),
  eq(productSearchTerms.status, "indexed"),
  eq(productSearchTerms.sourceHash, listingHash),
);


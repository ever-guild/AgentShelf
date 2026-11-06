import { createHash } from "node:crypto";

import type { DemandGroup } from "../contracts/seller-insights";

// How one shop's attributed misses become query groups. Queries are already normalized by search, so
// a group is about words. Two queries belong together when they hold the same words in any order, or
// when one holds every word of a shorter one that has at least two. So "wireless magsafe charger"
// joins "magsafe charger", and a single word never gathers everything that mentions it: "charger"
// says nothing about whether two people wanted the same thing.

export type DemandQueryStats = {
  query: string;
  searches: number;
  sampleSearches: number;
  degradedSearches: number;
  firstSearchedLocal: string;
  lastSearchedLocal: string;
  sharedWords: string[];
  listings: string[];
  locations: string[];
  kinds: ("product" | "service")[];
  eventRefs: string[];
};

const MAX_EXAMPLES = 5;
const MAX_EVENT_REFS = 40;
const MIN_WORDS_TO_GATHER = 2;

function wordsOf(query: string): string[] {
  return [...new Set(query.split(/\s+/).filter(Boolean))].sort();
}

export function demandGroupId(words: readonly string[]): string {
  const hash = createHash("sha256").update(words.join(" ")).digest("hex");
  return `dg_${hash.slice(0, 12)}`;
}

function union<T extends string>(lists: readonly T[][]): T[] {
  return [...new Set(lists.flat())].sort();
}

function bySearches(a: DemandQueryStats, b: DemandQueryStats): number {
  return b.searches - a.searches || a.query.localeCompare(b.query);
}

// Deterministic for the same input in any order, because the result is hashed into a snapshot.
export function groupDemandQueries(stats: readonly DemandQueryStats[]): DemandGroup[] {
  const shortestFirst = stats
    .map((stat) => ({ stat, words: wordsOf(stat.query) }))
    .sort(
      (a, b) =>
        a.words.length - b.words.length || bySearches(a.stat, b.stat),
    );

  const seeds: { words: string[]; members: DemandQueryStats[] }[] = [];
  for (const { stat, words } of shortestFirst) {
    const seed = seeds.find(
      (candidate) =>
        (candidate.words.length >= MIN_WORDS_TO_GATHER || candidate.words.length === words.length) &&
        candidate.words.every((word) => words.includes(word)),
    );
    if (seed) {
      seed.members.push(stat);
    } else {
      seeds.push({ words, members: [stat] });
    }
  }

  return seeds
    .map(({ words, members }): DemandGroup => {
      const ordered = [...members].sort(bySearches);
      const searches = members.reduce((sum, member) => sum + member.searches, 0);
      const sampleSearches = members.reduce((sum, member) => sum + member.sampleSearches, 0);
      // References stay in query order within the limit, so the list never depends on input order.
      const eventRefs = ordered.flatMap((member) => member.eventRefs).slice(0, MAX_EVENT_REFS);
      return {
        groupId: demandGroupId(words),
        // The shortest wording is what the group is about, and ties go to the most searched.
        label: [...members].sort((a, b) => a.query.length - b.query.length || bySearches(a, b))[0].query,
        searches,
        recordedSearches: searches - sampleSearches,
        sampleSearches,
        degradedSearches: members.reduce((sum, member) => sum + member.degradedSearches, 0),
        firstSearchedLocal: members.map((member) => member.firstSearchedLocal).sort()[0],
        lastSearchedLocal: members.map((member) => member.lastSearchedLocal).sort().at(-1) as string,
        examples: ordered.slice(0, MAX_EXAMPLES).map(({ query, searches: count }) => ({ query, searches: count })),
        examplesOmitted: Math.max(0, ordered.length - MAX_EXAMPLES),
        sharedWords: union(members.map((member) => member.sharedWords)),
        listings: union(members.map((member) => member.listings)),
        locations: union(members.map((member) => member.locations)),
        kinds: union(members.map((member) => member.kinds)),
        eventRefs,
        eventRefsOmitted: searches - eventRefs.length,
      };
    })
    .sort((a, b) => b.searches - a.searches || a.label.localeCompare(b.label));
}

import { describe, expect, it } from "vitest";

import { demandGroupId, groupDemandQueries, type DemandQueryStats } from "./demand-groups";

function stat(query: string, searches: number, overrides: Partial<DemandQueryStats> = {}): DemandQueryStats {
  return {
    query,
    searches,
    sampleSearches: 0,
    degradedSearches: 0,
    firstSearchedLocal: "2026-11-01T10:00:00",
    lastSearchedLocal: "2026-11-02T10:00:00",
    sharedWords: ["charger"],
    listings: ["USB-C wall charger"],
    locations: [],
    kinds: [],
    eventRefs: Array.from({ length: Math.min(searches, 20) }, (_, n) => `${query}-${n}`),
    ...overrides,
  };
}

describe("grouping a shop's unmet queries", () => {
  it("gathers a longer wording under the shorter one, and adds the counts", () => {
    const [group, ...rest] = groupDemandQueries([
      stat("wireless magsafe charger", 1, { sampleSearches: 1, lastSearchedLocal: "2026-11-05T09:00:00" }),
      stat("magsafe charger", 2, { sampleSearches: 2, firstSearchedLocal: "2026-10-30T08:00:00", degradedSearches: 1 }),
    ]);

    expect(rest).toEqual([]);
    expect(group).toMatchObject({
      label: "magsafe charger",
      searches: 3,
      sampleSearches: 3,
      recordedSearches: 0,
      degradedSearches: 1,
      firstSearchedLocal: "2026-10-30T08:00:00",
      lastSearchedLocal: "2026-11-05T09:00:00",
      examples: [
        { query: "magsafe charger", searches: 2 },
        { query: "wireless magsafe charger", searches: 1 },
      ],
      eventRefsOmitted: 0,
    });
    expect(group.eventRefs).toHaveLength(3);
  });

  it("treats the same words in another order as one group", () => {
    const groups = groupDemandQueries([stat("charger magsafe", 1), stat("magsafe charger", 1)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].searches).toBe(2);
  });

  it("never lets one word gather everything that mentions it", () => {
    const groups = groupDemandQueries([stat("charger", 5), stat("magsafe charger", 1), stat("car charger", 1)]);
    expect(groups.map(({ label }) => label)).toEqual(["charger", "car charger", "magsafe charger"]);
  });

  it("gives the same answer in any order, so a snapshot does not change for nothing", () => {
    const input = [stat("magsafe charger", 2), stat("iphone 15 repair", 1), stat("wireless magsafe charger", 1)];
    expect(JSON.stringify(groupDemandQueries([...input].reverse()))).toBe(JSON.stringify(groupDemandQueries(input)));
  });

  it("keeps the id for the same words, whichever wording came first", () => {
    const [group] = groupDemandQueries([stat("magsafe charger", 1)]);
    expect(group.groupId).toBe(demandGroupId(["charger", "magsafe"]));
    expect(group.groupId).toMatch(/^dg_[0-9a-f]{12}$/);
  });

  it("counts every event, and says how many it did not name", () => {
    const [group] = groupDemandQueries([stat("magsafe charger", 50)]);
    expect(group.searches).toBe(50);
    expect(group.eventRefs).toHaveLength(20);
    expect(group.eventRefsOmitted).toBe(30);
  });

  it("returns nothing for nothing", () => {
    expect(groupDemandQueries([])).toEqual([]);
  });
});

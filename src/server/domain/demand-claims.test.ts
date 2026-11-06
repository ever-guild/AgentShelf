import { describe, expect, it } from "vitest";

import type { DemandGroup } from "../contracts/seller-insights";
import { checkDemandExplanation, withoutLinks } from "./demand-claims";

const group: DemandGroup = {
  groupId: "dg_aaaaaaaaaaaa",
  label: "iphone 15 magsafe charger",
  searches: 3,
  recordedSearches: 0,
  sampleSearches: 3,
  degradedSearches: 0,
  firstSearchedLocal: "2026-11-01T10:00:00",
  lastSearchedLocal: "2026-11-02T10:00:00",
  examples: [{ query: "iphone 15 magsafe charger", searches: 3 }],
  examplesOmitted: 0,
  sharedWords: ["charger"],
  listings: ["USB-C wall charger"],
  locations: [],
  kinds: [],
  eventRefs: ["a", "b", "c"],
  eventRefsOmitted: 0,
};

const reply = (explanation: string, suggestedAction = "Consider checking whether you can stock one.", groupId = group.groupId) => ({
  items: [{ groupId, explanation, suggestedAction }],
});

describe("checking a model's note against the aggregates", () => {
  it("accepts words that add meaning and no numbers of their own", () => {
    const checked = checkDemandExplanation(reply("Buyers may want a wireless charger, and these are demo samples."), [group], 30);
    expect(checked).toEqual({
      ok: true,
      items: [
        {
          groupId: group.groupId,
          label: group.label,
          searchesAtWriting: 3,
          explanation: "Buyers may want a wireless charger, and these are demo samples.",
          suggestedAction: "Consider checking whether you can stock one.",
        },
      ],
    });
  });

  it("allows the numbers in a product's name and the recorded counts", () => {
    expect(checkDemandExplanation(reply("The iPhone 15 appears in all 3 of these."), [group], 30).ok).toBe(true);
  });

  it.each([
    ["an invented count", "This was searched 40 times."],
    ["an invented number in words", "Around twelve people asked."],
    ["large number words", "Hundreds of buyers want this."],
    ["revenue", "This could bring in more revenue."],
    ["an amount", "You could earn 300 a month."],
    ["a currency sign", "It sells for €20."],
    ["a link", "Buy them at https://example.test/deal"],
    ["a bare domain", "See cheapchargers.com for stock."],
  ])("rejects %s", (_, text) => {
    expect(checkDemandExplanation(reply(text), [group], 30).ok).toBe(false);
    expect(checkDemandExplanation(reply("Buyers may want a charger.", text), [group], 30).ok).toBe(false);
  });

  it("rejects a group the seller was not shown", () => {
    expect(checkDemandExplanation(reply("Fine words.", "Fine action.", "dg_bbbbbbbbbbbb"), [group], 30)).toEqual({
      ok: false,
      problem: "unknown_group",
    });
  });

  it("rejects a repeated group, an empty note, an empty reply and a long one", () => {
    const item = { groupId: group.groupId, explanation: "Words.", suggestedAction: "Action." };
    expect(checkDemandExplanation({ items: [item, item] }, [group], 30).ok).toBe(false);
    expect(checkDemandExplanation(reply("   "), [group], 30).ok).toBe(false);
    expect(checkDemandExplanation({ items: [] }, [group], 30).ok).toBe(false);
    expect(checkDemandExplanation(reply("x".repeat(401)), [group], 30).ok).toBe(false);
  });
});

describe("an assistant's answer", () => {
  it("never carries a link", () => {
    expect(withoutLinks("See [this](https://evil.test/?d=1) or www.evil.test now")).toBe(
      "See [this]((link removed) or (link removed) now",
    );
  });
});

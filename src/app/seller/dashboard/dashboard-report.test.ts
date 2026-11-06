import type { AgReportState } from "ag-studio";
import { describe, expect, it } from "vitest";

import { defaultReport, layoutOnly, parseSavedLayout } from "./dashboard-report";

describe("a saved layout", () => {
  const withFilters = () => {
    const report = defaultReport();
    const page = report.pages[0] as unknown as Record<string, unknown>;
    page.filter = {
      page: [{ field: { id: "demand.query" }, model: { operator: "isIn", value: ["a buyer's search"] } }],
    };
    page.crossFilter = { selections: ["order-1"] };
    page.selection = { widgetId: "orders" };
    return report;
  };

  it("keeps widgets and their places, and no filter value", () => {
    const saved = JSON.stringify(layoutOnly(withFilters()));
    const page = JSON.parse(saved).pages[0];

    expect(saved).not.toContain("a buyer's search");
    expect(saved).not.toContain("order-1");
    expect(page.filter).toBeUndefined();
    expect(page.crossFilter).toBeUndefined();
    expect(page.selection).toBeUndefined();
    expect(Object.keys(page.widgetLayout)).toEqual(Object.keys(page.widgets));
  });

  it("round trips, and strips filters from an older value too", () => {
    const parsed = parseSavedLayout(JSON.stringify(withFilters())) as AgReportState;
    expect(parsed.selectedPageId).toBe(defaultReport().selectedPageId);
    expect(JSON.stringify(parsed)).not.toContain("a buyer's search");
  });

  it.each([
    [null],
    [""],
    ["not json"],
    ["null"],
    ["{}"],
    ['{"selectedPageId":"a","pages":[]}'],
    ['{"selectedPageId":"a","pages":[{"id":"b","widgets":{},"widgetLayout":{}}]}'],
    ['{"selectedPageId":"a","pages":[{"id":"a","widgets":null,"widgetLayout":{}}]}'],
    ['{"selectedPageId":"a","pages":[null]}'],
  ])("falls back to the default dashboard for %j", (stored) => {
    expect(parseSavedLayout(stored)).toBeNull();
  });
});

describe("the default dashboard", () => {
  it("places every widget, and only widgets that exist", () => {
    const [page] = defaultReport().pages;
    expect(Object.keys(page.widgetLayout ?? {}).sort()).toEqual(Object.keys(page.widgets ?? {}).sort());
  });

  it("holds nothing overlapping on the 24 column canvas", () => {
    const [page] = defaultReport().pages;
    const cells = new Set<string>();
    for (const layout of Object.values(page.widgetLayout ?? {})) {
      if (!layout) {
        continue;
      }
      expect(layout.xTrack + layout.xSpan).toBeLessThanOrEqual(24);
      for (let x = layout.xTrack; x < layout.xTrack + layout.xSpan; x += 1) {
        for (let y = layout.yTrack; y < layout.yTrack + layout.ySpan; y += 1) {
          expect(cells.has(`${x},${y}`)).toBe(false);
          cells.add(`${x},${y}`);
        }
      }
    }
  });
});

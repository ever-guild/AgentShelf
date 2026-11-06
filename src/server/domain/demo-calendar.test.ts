import { describe, expect, it } from "vitest";

import {
  addDays,
  formatLocalDate,
  parseLocalDate,
  resolveDemoDate,
  tomorrowBeforeNoon,
} from "./demo-calendar";

describe("the demo date", () => {
  it("uses DEMO_DATE when it is set", () => {
    expect(resolveDemoDate({ DEMO_DATE: "2026-11-09" })).toEqual({
      year: 2026,
      month: 11,
      day: 9,
    });
  });

  it("otherwise uses today in Riga, not in UTC", () => {
    // 23:30 UTC on 8 November is already 9 November in Riga.
    const late = new Date("2026-11-08T23:30:00Z");
    expect(formatLocalDate(resolveDemoDate({}, late))).toBe("2026-11-09");
    expect(formatLocalDate(resolveDemoDate({ DEMO_DATE: "  " }, late))).toBe("2026-11-09");
  });

  it.each(["2026-02-30", "2026-13-01", "tomorrow", "09.11.2026", "2026-1-9"])(
    "refuses %s",
    (value) => {
      expect(() => parseLocalDate(value)).toThrow("DEMO_DATE");
    },
  );

  it("counts days across month ends and backwards", () => {
    expect(formatLocalDate(addDays(parseLocalDate("2026-12-30"), 3))).toBe("2027-01-02");
    expect(formatLocalDate(addDays(parseLocalDate("2026-03-01"), -1))).toBe("2026-02-28");
  });
});

describe("tomorrow before noon", () => {
  it("is the next day from midnight to 12:00 in Riga", () => {
    const { from, to } = tomorrowBeforeNoon(parseLocalDate("2026-11-09"));
    expect(from.toISOString()).toBe("2026-11-09T22:00:00.000Z");
    expect(to.toISOString()).toBe("2026-11-10T10:00:00.000Z");
  });

  it("keeps Riga's clock when it goes forward overnight", () => {
    // Clocks go forward at 03:00 on 29 March 2026, so that morning is only 11 hours long.
    const { from, to } = tomorrowBeforeNoon(parseLocalDate("2026-03-28"));
    expect(from.toISOString()).toBe("2026-03-28T22:00:00.000Z");
    expect(to.toISOString()).toBe("2026-03-29T09:00:00.000Z");
  });
});

import { describe, expect, it } from "vitest";

import { barStateForms } from "./schedule-labels";
import { BAR_INSET_PX, NARROW_BAR_INSET_PX, fitBarState } from "./timeline-size";

// Widths in pixels of the state line's words in Geist at 12 px and weight 500, as measured in the
// browser, with 3 px for a space. The timeline measures the real ones the same way.
const WORDS: Record<string, number> = {
  Held: 25.9,
  Confirmed: 58.6,
  "Confirmed,": 61.2,
  Booked: 42.8,
  Expired: 42.4,
  "Expired,": 44.9,
  Cancelled: 56.3,
  "Cancelled,": 58.9,
  Free: 24.8,
  again: 30.9,
  Needs: 36,
  review: 36.9,
  Check: 36.2,
  check: 34.3,
  payment: 48.9,
};

function measure(text: string): number {
  const words = text.split(" ");
  return Math.ceil(words.reduce((sum, word) => sum + WORDS[word], 3 * (words.length - 1)));
}

// What Bryntum gives as a bar's width, at 110 px an hour on a phone and 125.2 px an hour when a
// working day fills a 1280 px window.
const PHONE = { halfHour: 55, hour: 110 };
const DESKTOP = { halfHour: 62.6, hour: 125.2 };

const fit = (forms: string[], width: number) => fitBarState(forms, width, measure);

describe("fitBarState", () => {
  it("keeps the full words on a bar with room for them", () => {
    for (const width of [PHONE.hour, DESKTOP.hour]) {
      expect(fit(barStateForms("confirmed", "paid"), width)).toEqual({ lines: ["Confirmed"], narrow: false });
      expect(fit(barStateForms("cancelled", "cancelled"), width).lines).toEqual(["Cancelled"]);
      expect(fit(barStateForms("review_required", "paid"), width).lines).toEqual(["Needs review"]);
    }
    expect(fit(barStateForms("confirmed", "review_required"), DESKTOP.hour)).toEqual({
      lines: ["Confirmed, check", "payment"],
      narrow: false,
    });
    expect(fit(barStateForms("expired", "paid"), PHONE.hour).lines).toEqual([
      "Expired, check",
      "payment",
    ]);
  });

  it("gives a half-hour bar whole words, shorter ones only where the full ones cannot fit", () => {
    expect(fit(barStateForms("held", "pending"), DESKTOP.halfHour).lines).toEqual(["Held"]);
    expect(fit(barStateForms("confirmed", "paid"), DESKTOP.halfHour).lines).toEqual(["Booked"]);
    expect(fit(barStateForms("expired", "cancelled"), DESKTOP.halfHour).lines).toEqual(["Expired"]);
    expect(fit(barStateForms("cancelled", "cancelled"), DESKTOP.halfHour).lines).toEqual([
      "Free",
      "again",
    ]);
    expect(fit(barStateForms("review_required", "paid"), DESKTOP.halfHour).lines).toEqual([
      "Needs",
      "review",
    ]);
    expect(fit(barStateForms("confirmed", "review_required"), DESKTOP.halfHour)).toEqual({
      lines: ["Check", "payment"],
      narrow: true,
    });
  });

  it("takes the narrow inset on a phone before it gives up a word", () => {
    expect(fit(barStateForms("expired", "cancelled"), PHONE.halfHour)).toEqual({
      lines: ["Expired"],
      narrow: true,
    });
    expect(fit(barStateForms("confirmed", "paid"), PHONE.halfHour)).toEqual({
      lines: ["Booked"],
      narrow: true,
    });
    expect(fit(barStateForms("cancelled", "approved"), PHONE.halfHour)).toEqual({
      lines: ["Check"],
      narrow: false,
    });
  });

  it("never draws a line wider than the bar has room for, at any width", () => {
    const states = [
      ["held", "pending"],
      ["confirmed", "paid"],
      ["confirmed", "review_required"],
      ["expired", "cancelled"],
      ["expired", "paid"],
      ["cancelled", "failed"],
      ["cancelled", "approved"],
      ["review_required", "paid"],
    ] as const;
    for (let width = 10; width <= 260; width += 0.5) {
      for (const [status, payment] of states) {
        const state = fit(barStateForms(status, payment), width);
        const room = width - 1 - 2 * (state.narrow ? NARROW_BAR_INSET_PX : BAR_INSET_PX);
        expect(state.lines.length).toBeLessThanOrEqual(2);
        for (const line of state.lines) {
          expect(measure(line)).toBeLessThanOrEqual(room);
        }
      }
    }
  });

  it("shows no state words on a bar too short for any of them, rather than part of one", () => {
    expect(fit(barStateForms("confirmed", "paid"), 36)).toEqual({ lines: [], narrow: true });
    expect(fit(barStateForms("held", "pending"), 36)).toEqual({ lines: ["Held"], narrow: true });
    expect(fit(barStateForms("held", "pending"), 30)).toEqual({ lines: [], narrow: true });
  });
});

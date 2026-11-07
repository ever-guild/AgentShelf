// The timeline's sizes, shared with the page so it can keep the timeline's place free while
// Bryntum loads. Kept apart from the timeline itself, which only this page loads, and only later.

export const ROW_HEIGHT_PX = 88;
export const BAR_MARGIN_PX = 4;

// From a bar's outer edge to its text, border included, as schedule-timeline.css sets them. A bar
// too short for its words takes the narrow inset before it gives up a word. Bryntum draws a bar a
// pixel narrower than its time on the axis.
export const BAR_INSET_PX = 8;
export const NARROW_BAR_INSET_PX = 4;
const BAR_SHORTFALL_PX = 1;

// A bar has room for four lines: its time, its name and its state. The state takes up to two, and
// the name gives one back when it does.
const STATE_LINES = 2;

export type BarState = { lines: string[]; narrow: boolean };

// Lays a form out in lines no wider than `width`, breaking only between words, or says it does not
// fit. This is how the browser would wrap it, so the bar draws exactly these lines.
function wrapWords(form: string, width: number, measure: (text: string) => number): string[] | null {
  const lines: string[] = [];
  for (const word of form.split(" ")) {
    const last = lines.at(-1);
    if (last !== undefined && measure(`${last} ${word}`) <= width) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else if (measure(word) <= width) {
      lines.push(word);
    } else {
      return null;
    }
  }
  return lines.length <= STATE_LINES ? lines : null;
}

// The first of a state's forms, longest first, that fits a bar whole, at the usual inset or else at
// the narrow one, so no word is ever cut. A bar too short for any of them shows no state words: its
// edge still marks the state, and its label and the list under the timeline say it in full.
export function fitBarState(
  forms: string[],
  barWidthPx: number,
  measure: (text: string) => number,
): BarState {
  for (const form of forms) {
    for (const inset of [BAR_INSET_PX, NARROW_BAR_INSET_PX]) {
      const lines = wrapWords(form, barWidthPx - BAR_SHORTFALL_PX - 2 * inset, measure);
      if (lines) {
        return { lines, narrow: inset === NARROW_BAR_INSET_PX };
      }
    }
  }
  return { lines: [], narrow: true };
}

// Bryntum's header row with the rules above and below the timeline.
const HEADER_HEIGHT_PX = 44;

type Span = { technicianId: string; startsLocal: string; barEndLocal: string };

// The most bookings one technician has at the same moment, which is how many lines the timeline
// stacks in that row. Shop wall clock strings compare in time order.
function stackedLines(spans: Span[], technicianId: string): number {
  const own = spans.filter((span) => span.technicianId === technicianId);
  let most = 1;
  for (const { startsLocal } of own) {
    const atOnce = own.filter(
      (other) => other.startsLocal <= startsLocal && other.barEndLocal > startsLocal,
    ).length;
    most = Math.max(most, atOnce);
  }
  return most;
}

export function timelineHeight(technicianIds: string[], spans: Span[]): number {
  return technicianIds.reduce((height, technicianId) => {
    const lines = stackedLines(spans, technicianId);
    return height + lines * (ROW_HEIGHT_PX - BAR_MARGIN_PX) + BAR_MARGIN_PX;
  }, HEADER_HEIGHT_PX);
}

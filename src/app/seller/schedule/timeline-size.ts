// The timeline's sizes, shared with the page so it can keep the timeline's place free while
// Bryntum loads. Kept apart from the timeline itself, which only this page loads, and only later.

export const ROW_HEIGHT_PX = 88;
export const BAR_MARGIN_PX = 4;

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

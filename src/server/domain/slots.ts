import {
  isoWeekday,
  localDateOf,
  localToInstant,
  nextLocalDate,
  type LocalDate,
} from "./shop-time";

// Which appointment times a technician's weekly pattern offers. No clock and no database here:
// get_slots and book_slot both call this, so a slot is checked by the rule that produced it.

const MINUTE_MS = 60_000;
const SECOND_MS = 1000;
const SLOT_FORMAT =
  /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.(\d{1,12})\.(\d{1,5})$/;

export type WeeklyWindow = {
  technicianId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
};

export type GeneratedSlot = {
  technicianId: string;
  startsAt: Date;
  endsAt: Date;
};

export type SlotQuery = {
  windows: readonly WeeklyWindow[];
  timezone: string;
  durationMinutes: number;
  stepMinutes: number;
  from: Date;
  to: Date;
  // Nothing starts before this.
  earliestStart: Date;
};

function isAfter(date: LocalDate, other: LocalDate): boolean {
  return (
    Date.UTC(date.year, date.month - 1, date.day) >
    Date.UTC(other.year, other.month - 1, other.day)
  );
}

// Every slot that lies wholly inside the range, in time order. Window edges come from the shop's
// wall clock, and everything inside a window is elapsed time, so a 60-minute appointment is 60 real
// minutes, and the night the clocks change simply has fewer or more slots.
export function generateSlots({
  windows,
  timezone,
  durationMinutes,
  stepMinutes,
  from,
  to,
  earliestStart,
}: SlotQuery): GeneratedSlot[] {
  const durationMs = durationMinutes * MINUTE_MS;
  const stepMs = stepMinutes * MINUTE_MS;
  const firstStart = Math.max(from.getTime(), earliestStart.getTime());
  const lastDate = localDateOf(to, timezone);
  const slots: GeneratedSlot[] = [];

  for (
    let date = localDateOf(from, timezone);
    !isAfter(date, lastDate);
    date = nextLocalDate(date)
  ) {
    const weekday = isoWeekday(date);
    for (const window of windows) {
      if (window.weekday !== weekday) {
        continue;
      }
      const windowStart = localToInstant(date, window.startMinute, timezone).getTime();
      const windowEnd = localToInstant(date, window.endMinute, timezone).getTime();
      for (
        let start = windowStart;
        start + durationMs <= windowEnd;
        start += stepMs
      ) {
        if (start >= firstStart && start + durationMs <= to.getTime()) {
          slots.push({
            technicianId: window.technicianId,
            startsAt: new Date(start),
            endsAt: new Date(start + durationMs),
          });
        }
      }
    }
  }
  return slots.sort(
    (a, b) =>
      a.startsAt.getTime() - b.startsAt.getTime() ||
      a.technicianId.localeCompare(b.technicianId),
  );
}

export type SlotReference = {
  serviceId: string;
  technicianId: string;
  startsAt: Date;
  durationMinutes: number;
};

// A slot ID names what was offered, so nothing has to be stored for it. It grants nothing: book_slot
// checks it against the service and the working windows as they are then, so a made-up ID can only
// reach a slot that get_slots would have offered anyway.
export function encodeSlotId({
  serviceId,
  technicianId,
  startsAt,
  durationMinutes,
}: SlotReference): string {
  const seconds = Math.floor(startsAt.getTime() / SECOND_MS);
  return Buffer.from(
    `${serviceId}.${technicianId}.${seconds}.${durationMinutes}`,
  ).toString("base64url");
}

export function decodeSlotId(slotId: string): SlotReference | undefined {
  const match = SLOT_FORMAT.exec(Buffer.from(slotId, "base64url").toString());
  if (!match) {
    return undefined;
  }
  return {
    serviceId: match[1],
    technicianId: match[2],
    startsAt: new Date(Number(match[3]) * SECOND_MS),
    durationMinutes: Number(match[4]),
  };
}

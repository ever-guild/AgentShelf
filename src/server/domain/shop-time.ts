// Turns a shop's wall clock into instants. A shop's day has 23 or 25 hours twice a year, so a local
// time is only meaningful together with its date and timezone.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type LocalDate = { year: number; month: number; day: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "iso8601",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

// The shop's wall clock at this instant, written as if it were UTC.
function wallClockAt(instantMs: number, timezone: string): number {
  const parts: Record<string, number> = {};
  for (const { type, value } of formatterFor(timezone).formatToParts(instantMs)) {
    if (type !== "literal") {
      parts[type] = Number(value);
    }
  }
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function offsetAt(instantMs: number, timezone: string): number {
  // Whole seconds, because the wall clock has no milliseconds.
  return wallClockAt(instantMs, timezone) - Math.floor(instantMs / 1000) * 1000;
}

// The instant of a local time, counted in minutes from that date's midnight. 1440 is the next
// midnight. The two awkward cases follow Temporal's "compatible" rule:
// - A time that happens twice, in the hour the clocks go back, means the first time.
// - A time that does not exist, in the hour the clocks go forward, moves forward by the size of the
//   gap, so 03:30 becomes 04:30 in a shop that jumps from 03:00 to 04:00.
export function localToInstant(
  { year, month, day }: LocalDate,
  minuteOfDay: number,
  timezone: string,
): Date {
  const wallClock = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const offsetBefore = offsetAt(wallClock - DAY_MS, timezone);
  const offsetAfter = offsetAt(wallClock + DAY_MS, timezone);

  const matches = [wallClock - offsetBefore, wallClock - offsetAfter].filter(
    (instant) => wallClockAt(instant, timezone) === wallClock,
  );
  return new Date(
    matches.length > 0 ? Math.min(...matches) : wallClock - offsetBefore,
  );
}

export function localDateOf(instant: Date, timezone: string): LocalDate {
  const wallClock = new Date(wallClockAt(instant.getTime(), timezone));
  return {
    year: wallClock.getUTCFullYear(),
    month: wallClock.getUTCMonth() + 1,
    day: wallClock.getUTCDate(),
  };
}

export function nextLocalDate({ year, month, day }: LocalDate): LocalDate {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

// 1 is Monday and 7 is Sunday.
export function isoWeekday({ year, month, day }: LocalDate): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

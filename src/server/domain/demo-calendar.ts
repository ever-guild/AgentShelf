import { localDateOf, localToInstant, type LocalDate } from "./shop-time";

// The demo's idea of "today", kept apart from the clock so a demo can be set up, repeated and checked
// for any date. It is a date in the shop's own time, never an instant.

export const DEMO_TIMEZONE = "Europe/Riga";

const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatLocalDate({ year, month, day }: LocalDate): string {
  return [year, month, day]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

// Reads YYYY-MM-DD and refuses a day that does not exist, such as 2026-02-30.
export function parseLocalDate(value: string): LocalDate {
  const match = DATE_FORMAT.exec(value.trim());
  if (match) {
    const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
    if (
      check.getUTCFullYear() === date.year &&
      check.getUTCMonth() + 1 === date.month &&
      check.getUTCDate() === date.day
    ) {
      return date;
    }
  }
  throw new Error("DEMO_DATE must be a real date written as YYYY-MM-DD.");
}

// DEMO_DATE when it is set, otherwise today in Riga.
export function resolveDemoDate(
  env: Record<string, string | undefined>,
  now: Date = new Date(),
): LocalDate {
  const explicit = env.DEMO_DATE?.trim();
  return explicit ? parseLocalDate(explicit) : localDateOf(now, DEMO_TIMEZONE);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

// The instant of a clock time on a demo day in Riga.
export function demoInstant(date: LocalDate, hour: number, minute = 0): Date {
  return localToInstant(date, hour * 60 + minute, DEMO_TIMEZONE);
}

// The range a buyer means by "tomorrow before noon": from the start of the next day to 12:00,
// both in Riga time. A slot is offered when it starts inside this range.
export function tomorrowBeforeNoon(today: LocalDate): { from: Date; to: Date } {
  const tomorrow = addDays(today, 1);
  return { from: demoInstant(tomorrow, 0), to: demoInstant(tomorrow, 12) };
}

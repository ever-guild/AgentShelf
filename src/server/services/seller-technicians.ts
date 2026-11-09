import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  addTechnicianBody,
  setWeekBody,
  type TechnicianWeek,
  type WeeklyWindow,
} from "../contracts/seller-schedule";
import type { Db } from "../db/client";
import { technicians, technicianWindows } from "../db/schema";
import { parseInput, ServiceError } from "../errors";

// The owner's own setup of who works and when, for /seller/schedule. The shop always comes from the
// session. Bookings are never touched here: held and confirmed ones stay as they are when a week
// changes, and only new slots follow the new windows.

const DAY_MINUTES = 24 * 60;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type Window = { weekday: number; startMinute: number; endMinute: number };

const technicianId = z.uuid();

function notFound(): ServiceError {
  return new ServiceError("TECHNICIAN_NOT_FOUND", "This shop has no such technician.");
}

function toMinute(clock: string): number {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
}

function toClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function byDayAndStart(a: Window, b: Window): number {
  return a.weekday - b.weekday || a.startMinute - b.startMinute;
}

// What the database's own checks would refuse, said in the seller's words before any write.
function toWindows(windows: WeeklyWindow[]): Window[] {
  const parsed = windows
    .map(({ weekday, start, end }) => ({
      weekday,
      startMinute: toMinute(start),
      endMinute: toMinute(end),
    }))
    .sort(byDayAndStart);
  parsed.forEach((window, index) => {
    const day = WEEKDAYS[window.weekday - 1];
    if (window.startMinute >= DAY_MINUTES || window.endMinute <= window.startMinute) {
      throw new ServiceError(
        "WORKING_HOURS_INVALID",
        `On ${day}, the end has to be later than the start on the same day.`,
        { weekday: window.weekday },
      );
    }
    const previous = parsed[index - 1];
    if (previous && previous.weekday === window.weekday && window.startMinute < previous.endMinute) {
      throw new ServiceError(
        "WORKING_HOURS_INVALID",
        `On ${day}, two working windows overlap.`,
        { weekday: window.weekday },
      );
    }
  });
  return parsed;
}

function toWeek(technician: { id: string; name: string }, windows: Window[]): TechnicianWeek {
  return {
    technicianId: technician.id,
    name: technician.name,
    windows: [...windows].sort(byDayAndStart).map(({ weekday, startMinute, endMinute }) => ({
      weekday,
      start: toClock(startMinute),
      end: toClock(endMinute),
    })),
  };
}

function sqlState(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && depth < 3; depth += 1) {
    if (typeof current !== "object") return undefined;
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

// A technician with an empty week. They take no slots until the owner sets one.
export async function addTechnician(
  db: Db,
  shop: { id: string },
  rawBody: unknown,
): Promise<TechnicianWeek> {
  const { name } = parseInput(addTechnicianBody, rawBody);
  const [created] = await db
    .insert(technicians)
    .values({ shopId: shop.id, name })
    .onConflictDoNothing({ target: [technicians.shopId, technicians.name] })
    .returning({ id: technicians.id, name: technicians.name });
  if (!created) {
    throw new ServiceError("TECHNICIAN_EXISTS", "A technician with this name is already set up.");
  }
  return toWeek(created, []);
}

// Replaces a technician's whole weekly pattern, so the same request twice leaves the same week.
export async function setTechnicianWeek(
  db: Db,
  shop: { id: string },
  rawTechnicianId: unknown,
  rawBody: unknown,
): Promise<TechnicianWeek> {
  const parsedId = technicianId.safeParse(rawTechnicianId);
  if (!parsedId.success) {
    throw notFound();
  }
  const windows = toWindows(parseInput(setWeekBody, rawBody).windows);

  try {
    return await db.transaction(async (tx) => {
      // The lock makes two saves of one technician's week take turns.
      const [technician] = await tx
        .select({ id: technicians.id, name: technicians.name })
        .from(technicians)
        .where(and(eq(technicians.id, parsedId.data), eq(technicians.shopId, shop.id)))
        .for("update");
      if (!technician) {
        throw notFound();
      }
      const current = await tx
        .select({
          weekday: technicianWindows.weekday,
          startMinute: technicianWindows.startMinute,
          endMinute: technicianWindows.endMinute,
        })
        .from(technicianWindows)
        .where(
          and(
            eq(technicianWindows.technicianId, technician.id),
            eq(technicianWindows.shopId, shop.id),
          ),
        )
        .orderBy(asc(technicianWindows.weekday), asc(technicianWindows.startMinute));
      const same =
        current.length === windows.length &&
        current.every(
          (window, index) =>
            window.weekday === windows[index].weekday &&
            window.startMinute === windows[index].startMinute &&
            window.endMinute === windows[index].endMinute,
        );
      if (same) {
        return toWeek(technician, current);
      }
      await tx
        .delete(technicianWindows)
        .where(
          and(
            eq(technicianWindows.technicianId, technician.id),
            eq(technicianWindows.shopId, shop.id),
          ),
        );
      if (windows.length > 0) {
        await tx
          .insert(technicianWindows)
          .values(windows.map((window) => ({ ...window, technicianId: technician.id, shopId: shop.id })));
      }
      return toWeek(technician, windows);
    });
  } catch (error) {
    // The exclusion and check constraints stay the last guard, and say the same as the checks above.
    const state = sqlState(error);
    if (state === "23P01" || state === "23514") {
      throw new ServiceError("WORKING_HOURS_INVALID", "These working windows overlap or leave the day.");
    }
    throw error;
  }
}

// Technicians with nothing in their week, so the page can offer to finish setting them up.
export async function techniciansWithoutHours(
  db: Db,
  shop: { id: string },
): Promise<{ technicianId: string; name: string }[]> {
  const rows = await db
    .select({ technicianId: technicians.id, name: technicians.name, windowId: technicianWindows.id })
    .from(technicians)
    .leftJoin(
      technicianWindows,
      and(
        eq(technicianWindows.technicianId, technicians.id),
        eq(technicianWindows.shopId, technicians.shopId),
      ),
    )
    .where(eq(technicians.shopId, shop.id))
    .orderBy(asc(technicians.name), asc(technicians.id));
  const seen = new Map<string, { technicianId: string; name: string; hasHours: boolean }>();
  for (const row of rows) {
    const entry = seen.get(row.technicianId) ?? { technicianId: row.technicianId, name: row.name, hasHours: false };
    entry.hasHours ||= row.windowId !== null;
    seen.set(row.technicianId, entry);
  }
  return [...seen.values()]
    .filter(({ hasHours }) => !hasHours)
    .map(({ technicianId: id, name }) => ({ technicianId: id, name }));
}

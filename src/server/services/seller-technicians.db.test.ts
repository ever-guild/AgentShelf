import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  book,
  createBookingHarness,
  MONDAY_MORNING,
  NOON_SLOT,
  slotAt,
  type BookingHarness,
} from "../../../test/bookings";
import { setupMigratedDatabase } from "../../../test/database";
import { createService, createShop, createTechnician, createWindow } from "../../../test/fixtures";
import { technicians, technicianWindows } from "../db/schema";
import { ServiceError } from "../errors";
import { getSlots } from "./bookings";
import { getSellerSchedule } from "./seller-schedule";
import { addTechnician, setTechnicianWeek, techniciansWithoutHours } from "./seller-technicians";

const getDb = setupMigratedDatabase();

const WEEKDAYS_NINE_TO_SIX = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  start: "09:00",
  end: "18:00",
}));

let harness: BookingHarness;

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  harness = createBookingHarness();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function refusal(promise: Promise<unknown>): Promise<ServiceError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ServiceError);
  return error as ServiceError;
}

const windowsOf = (technicianId: string) =>
  getDb()
    .select()
    .from(technicianWindows)
    .where(eq(technicianWindows.technicianId, technicianId))
    .orderBy(technicianWindows.weekday, technicianWindows.startMinute);

// A shop as registration leaves it: published repair service, PayPal connected, nobody to do the work.
async function newlyRegisteredWorkshop() {
  const shop = await createShop(getDb());
  const service = await createService(getDb(), shop.id);
  return { shop, service };
}

describe("adding a technician", () => {
  it("adds one with an empty week, under the session's shop", async () => {
    const { shop } = await newlyRegisteredWorkshop();

    const added = await addTechnician(getDb(), shop, { name: "  Anna  " });

    expect(added).toEqual({ technicianId: expect.any(String), name: "Anna", windows: [] });
    const [row] = await getDb().select().from(technicians).where(eq(technicians.id, added.technicianId));
    expect(row).toMatchObject({ shopId: shop.id, name: "Anna" });
  });

  it("refuses a repeated name with a conflict and adds no second row", async () => {
    const { shop } = await newlyRegisteredWorkshop();
    await addTechnician(getDb(), shop, { name: "Anna" });

    const error = await refusal(addTechnician(getDb(), shop, { name: "Anna" }));

    expect(error.code).toBe("TECHNICIAN_EXISTS");
    expect(error.httpStatus).toBe(409);
    const rows = await getDb().select().from(technicians).where(eq(technicians.shopId, shop.id));
    expect(rows).toHaveLength(1);
  });

  it("lets two submissions of the same name race and still keeps one", async () => {
    const { shop } = await newlyRegisteredWorkshop();

    const results = await Promise.allSettled([
      addTechnician(getDb(), shop, { name: "Marek" }),
      addTechnician(getDb(), shop, { name: "Marek" }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rows = await getDb().select().from(technicians).where(eq(technicians.shopId, shop.id));
    expect(rows).toHaveLength(1);
  });

  it("allows the same name in another shop", async () => {
    const first = await newlyRegisteredWorkshop();
    const second = await newlyRegisteredWorkshop();
    await addTechnician(getDb(), first.shop, { name: "Anna" });

    await expect(addTechnician(getDb(), second.shop, { name: "Anna" })).resolves.toMatchObject({
      name: "Anna",
    });
  });

  it.each([
    ["an empty name", { name: "   " }],
    ["a name over 80 characters", { name: "A".repeat(81) }],
    ["a line break", { name: "Anna\nMarek" }],
    ["a shop named in the body", { name: "Anna", shopId: randomUUID() }],
  ])("refuses %s", async (_case, body) => {
    const { shop } = await newlyRegisteredWorkshop();

    const error = await refusal(addTechnician(getDb(), shop, body));

    expect(error.code).toBe("INVALID_INPUT");
    expect(await getDb().select().from(technicians).where(eq(technicians.shopId, shop.id))).toEqual([]);
  });
});

describe("setting a technician's week", () => {
  it("stores the windows in shop minutes and returns them as wall clock", async () => {
    const { shop } = await newlyRegisteredWorkshop();
    const { technicianId } = await addTechnician(getDb(), shop, { name: "Anna" });

    const week = await setTechnicianWeek(getDb(), shop, technicianId, {
      windows: [
        { weekday: 6, start: "10:00", end: "14:00" },
        { weekday: 1, start: "13:00", end: "24:00" },
        { weekday: 1, start: "09:00", end: "12:30" },
      ],
    });

    expect(week.windows).toEqual([
      { weekday: 1, start: "09:00", end: "12:30" },
      { weekday: 1, start: "13:00", end: "24:00" },
      { weekday: 6, start: "10:00", end: "14:00" },
    ]);
    const rows = await windowsOf(technicianId);
    expect(rows.map(({ weekday, startMinute, endMinute }) => [weekday, startMinute, endMinute])).toEqual([
      [1, 540, 750],
      [1, 780, 1440],
      [6, 600, 840],
    ]);
    expect(rows.every((row) => row.shopId === shop.id)).toBe(true);
  });

  it("changes nothing when the same week is sent again", async () => {
    const { shop } = await newlyRegisteredWorkshop();
    const { technicianId } = await addTechnician(getDb(), shop, { name: "Anna" });
    const first = await setTechnicianWeek(getDb(), shop, technicianId, { windows: WEEKDAYS_NINE_TO_SIX });
    const before = await windowsOf(technicianId);

    const second = await setTechnicianWeek(getDb(), shop, technicianId, {
      windows: [...WEEKDAYS_NINE_TO_SIX].reverse(),
    });

    expect(second).toEqual(first);
    expect(await windowsOf(technicianId)).toEqual(before);
  });

  it("replaces the whole week, and an empty week takes the technician out of new slots", async () => {
    const { shop, service } = await newlyRegisteredWorkshop();
    const { technicianId } = await addTechnician(getDb(), shop, { name: "Anna" });
    await setTechnicianWeek(getDb(), shop, technicianId, { windows: WEEKDAYS_NINE_TO_SIX });

    await setTechnicianWeek(getDb(), shop, technicianId, {
      windows: [{ weekday: 3, start: "08:00", end: "10:00" }],
    });
    expect((await windowsOf(technicianId)).map(({ weekday }) => weekday)).toEqual([3]);

    await setTechnicianWeek(getDb(), shop, technicianId, { windows: [] });
    expect(await windowsOf(technicianId)).toEqual([]);
    const { slots } = await getSlots(
      getDb(),
      {
        shopId: shop.id,
        serviceId: service.id,
        from: MONDAY_MORNING.toISOString(),
        to: new Date(MONDAY_MORNING.getTime() + 7 * 24 * 3_600_000).toISOString(),
      },
      harness.now(),
    );
    expect(slots).toEqual([]);
  });

  it.each([
    ["an end before the start", [{ weekday: 1, start: "18:00", end: "09:00" }], "WORKING_HOURS_INVALID"],
    ["an empty window", [{ weekday: 1, start: "09:00", end: "09:00" }], "WORKING_HOURS_INVALID"],
    ["a start at the end of the day", [{ weekday: 1, start: "24:00", end: "24:00" }], "WORKING_HOURS_INVALID"],
    [
      "overlapping windows on one day",
      [
        { weekday: 2, start: "09:00", end: "13:00" },
        { weekday: 2, start: "12:00", end: "18:00" },
      ],
      "WORKING_HOURS_INVALID",
    ],
    ["weekday 8", [{ weekday: 8, start: "09:00", end: "18:00" }], "INVALID_INPUT"],
    ["weekday 0", [{ weekday: 0, start: "09:00", end: "18:00" }], "INVALID_INPUT"],
    ["a clock without a leading zero", [{ weekday: 1, start: "9:00", end: "18:00" }], "INVALID_INPUT"],
    ["a time past the end of the day", [{ weekday: 1, start: "09:00", end: "24:30" }], "INVALID_INPUT"],
  ])("refuses %s and keeps the week it had", async (_case, windows, code) => {
    const { shop } = await newlyRegisteredWorkshop();
    const { technicianId } = await addTechnician(getDb(), shop, { name: "Anna" });
    await setTechnicianWeek(getDb(), shop, technicianId, { windows: WEEKDAYS_NINE_TO_SIX });
    const before = await windowsOf(technicianId);

    const error = await refusal(setTechnicianWeek(getDb(), shop, technicianId, { windows }));

    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(code === "INVALID_INPUT" ? 400 : 422);
    expect(await windowsOf(technicianId)).toEqual(before);
  });

  it("allows windows that touch, since one ends where the next starts", async () => {
    const { shop } = await newlyRegisteredWorkshop();
    const { technicianId } = await addTechnician(getDb(), shop, { name: "Anna" });

    await expect(
      setTechnicianWeek(getDb(), shop, technicianId, {
        windows: [
          { weekday: 2, start: "09:00", end: "12:00" },
          { weekday: 2, start: "12:00", end: "18:00" },
        ],
      }),
    ).resolves.toMatchObject({ windows: expect.arrayContaining([expect.anything()]) });
  });

  it("answers not found for another shop's technician and leaves their week alone", async () => {
    const mine = await newlyRegisteredWorkshop();
    const theirs = await newlyRegisteredWorkshop();
    const foreign = await createTechnician(getDb(), theirs.shop.id);
    await createWindow(getDb(), foreign, { weekday: 1 });

    const error = await refusal(
      setTechnicianWeek(getDb(), mine.shop, foreign.id, { windows: [] }),
    );

    expect(error.code).toBe("TECHNICIAN_NOT_FOUND");
    expect(error.httpStatus).toBe(404);
    expect(await windowsOf(foreign.id)).toHaveLength(1);
  });

  it.each([["an unknown id", randomUUID()], ["an id that is not one", "anna"]])(
    "answers not found for %s",
    async (_case, id) => {
      const { shop } = await newlyRegisteredWorkshop();

      const error = await refusal(setTechnicianWeek(getDb(), shop, id, { windows: [] }));

      expect(error.code).toBe("TECHNICIAN_NOT_FOUND");
    },
  );

  it("refuses a body naming a shop", async () => {
    const { shop } = await newlyRegisteredWorkshop();
    const { technicianId } = await addTechnician(getDb(), shop, { name: "Anna" });

    const error = await refusal(
      setTechnicianWeek(getDb(), shop, technicianId, { windows: [], shopId: shop.id }),
    );

    expect(error.code).toBe("INVALID_INPUT");
  });
});

describe("a newly registered workshop after setup", () => {
  it("offers repair slots through get_slots and lists the technician in its schedule", async () => {
    const { shop, service } = await newlyRegisteredWorkshop();
    const window = {
      shopId: shop.id,
      serviceId: service.id,
      from: MONDAY_MORNING.toISOString(),
      to: new Date(MONDAY_MORNING.getTime() + 24 * 3_600_000).toISOString(),
    };
    expect((await getSlots(getDb(), window, harness.now())).slots).toEqual([]);
    expect((await getSellerSchedule(getDb(), shop, { date: "2026-11-09" }, harness.now())).technicians).toEqual([]);

    const { technicianId } = await addTechnician(getDb(), shop, { name: "Anna" });
    await setTechnicianWeek(getDb(), shop, technicianId, { windows: WEEKDAYS_NINE_TO_SIX });

    const { slots } = await getSlots(getDb(), window, harness.now());
    expect(slots.length).toBeGreaterThanOrEqual(3);
    expect(new Set(slots.map(({ startsAt }) => startsAt)).size).toBe(slots.length);
    expect(slots.every((slot) => slot.technicianId === technicianId && slot.technicianName === "Anna")).toBe(true);

    const schedule = await getSellerSchedule(getDb(), shop, { date: "2026-11-09" }, harness.now());
    expect(schedule.technicians).toEqual([{ technicianId, name: "Anna" }]);
  });

  it("keeps a held booking when the week changes", async () => {
    const { shop, service } = await newlyRegisteredWorkshop();
    const { technicianId } = await addTechnician(getDb(), shop, { name: "Anna" });
    await setTechnicianWeek(getDb(), shop, technicianId, { windows: WEEKDAYS_NINE_TO_SIX });
    const slotId = await slotAt(getDb(), harness, { shop, service }, NOON_SLOT);
    const held = await book(getDb(), harness, slotId, service.id);

    await setTechnicianWeek(getDb(), shop, technicianId, { windows: [] });

    const { bookings } = await getSellerSchedule(getDb(), shop, { date: "2026-11-09" }, harness.now());
    expect(bookings).toEqual([
      expect.objectContaining({ bookingId: held.bookingId, technicianId, status: "held" }),
    ]);
  });
});

describe("technicians without hours", () => {
  it("lists only the session shop's technicians whose week is empty", async () => {
    const { shop } = await newlyRegisteredWorkshop();
    const other = await newlyRegisteredWorkshop();
    const working = await addTechnician(getDb(), shop, { name: "Anna" });
    await setTechnicianWeek(getDb(), shop, working.technicianId, { windows: WEEKDAYS_NINE_TO_SIX });
    const idle = await addTechnician(getDb(), shop, { name: "Marek" });
    await addTechnician(getDb(), other.shop, { name: "Zane" });

    expect(await techniciansWithoutHours(getDb(), shop)).toEqual([
      { technicianId: idle.technicianId, name: "Marek" },
    ]);
  });
});

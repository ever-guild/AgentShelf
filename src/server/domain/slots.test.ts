import { describe, expect, it } from "vitest";

import { BOOKING_POLICY } from "./booking-policy";
import {
  isoWeekday,
  localDateOf,
  localToInstant,
  nextLocalDate,
} from "./shop-time";
import {
  decodeSlotId,
  encodeSlotId,
  generateSlots,
  type SlotQuery,
} from "./slots";

const RIGA = "Europe/Riga";
const iso = (date: Date) => date.toISOString();
const atMinute = (hour: number, minute = 0) => hour * 60 + minute;

describe("localToInstant", () => {
  it("uses the offset of that date, either side of a clock change", () => {
    expect(
      iso(localToInstant({ year: 2027, month: 3, day: 27 }, atMinute(9), RIGA)),
    ).toBe("2027-03-27T07:00:00.000Z");
    expect(
      iso(localToInstant({ year: 2027, month: 3, day: 29 }, atMinute(9), RIGA)),
    ).toBe("2027-03-29T06:00:00.000Z");
    expect(
      iso(localToInstant({ year: 2027, month: 10, day: 30 }, atMinute(9), RIGA)),
    ).toBe("2027-10-30T06:00:00.000Z");
    expect(
      iso(localToInstant({ year: 2027, month: 11, day: 1 }, atMinute(9), RIGA)),
    ).toBe("2027-11-01T07:00:00.000Z");
  });

  it("moves a time that does not exist forward by the size of the gap", () => {
    const spring = { year: 2027, month: 3, day: 28 };
    expect(iso(localToInstant(spring, atMinute(2, 59), RIGA))).toBe(
      "2027-03-28T00:59:00.000Z",
    );
    // 03:00 to 03:59 never happen in Riga on this date.
    expect(iso(localToInstant(spring, atMinute(3), RIGA))).toBe(
      "2027-03-28T01:00:00.000Z",
    );
    expect(iso(localToInstant(spring, atMinute(3, 30), RIGA))).toBe(
      "2027-03-28T01:30:00.000Z",
    );
    expect(iso(localToInstant(spring, atMinute(4), RIGA))).toBe(
      "2027-03-28T01:00:00.000Z",
    );
  });

  it("takes the first occurrence of a time that happens twice", () => {
    const autumn = { year: 2027, month: 10, day: 31 };
    expect(iso(localToInstant(autumn, atMinute(2, 59), RIGA))).toBe(
      "2027-10-30T23:59:00.000Z",
    );
    expect(iso(localToInstant(autumn, atMinute(3, 30), RIGA))).toBe(
      "2027-10-31T00:30:00.000Z",
    );
    expect(iso(localToInstant(autumn, atMinute(4), RIGA))).toBe(
      "2027-10-31T02:00:00.000Z",
    );
  });

  it("treats minute 1440 as the next midnight", () => {
    expect(
      iso(localToInstant({ year: 2026, month: 11, day: 9 }, 1440, RIGA)),
    ).toBe(
      iso(localToInstant({ year: 2026, month: 11, day: 10 }, 0, RIGA)),
    );
  });

  it.each([
    // Half-hour offset, no daylight saving.
    ["Asia/Kolkata", { year: 2027, month: 1, day: 4 }, atMinute(9), "2027-01-04T03:30:00.000Z"],
    // The other hemisphere, and a clock change of 30 minutes.
    ["Australia/Lord_Howe", { year: 2027, month: 1, day: 4 }, atMinute(9), "2027-01-03T22:00:00.000Z"],
    ["Australia/Lord_Howe", { year: 2027, month: 7, day: 5 }, atMinute(9), "2027-07-04T22:30:00.000Z"],
    // A gap at 02:00, and a repeat at 01:00.
    ["America/New_York", { year: 2027, month: 3, day: 14 }, atMinute(2, 30), "2027-03-14T07:30:00.000Z"],
    ["America/New_York", { year: 2027, month: 11, day: 7 }, atMinute(1, 30), "2027-11-07T05:30:00.000Z"],
    // A gap at midnight.
    ["America/Havana", { year: 2027, month: 3, day: 14 }, 0, "2027-03-14T05:00:00.000Z"],
    ["UTC", { year: 2027, month: 3, day: 14 }, atMinute(9), "2027-03-14T09:00:00.000Z"],
  ])("%s %o minute %i is %s", (timezone, date, minute, expected) => {
    expect(iso(localToInstant(date, minute, timezone))).toBe(expected);
  });
});

describe("local dates", () => {
  it("names the shop's date, which can differ from the UTC date", () => {
    expect(localDateOf(new Date("2026-11-09T22:30:00Z"), RIGA)).toEqual({
      year: 2026,
      month: 11,
      day: 10,
    });
    expect(localDateOf(new Date("2026-11-09T22:30:00Z"), "UTC")).toEqual({
      year: 2026,
      month: 11,
      day: 9,
    });
  });

  it("counts weekdays from Monday and steps over a month end", () => {
    expect(isoWeekday({ year: 2026, month: 11, day: 9 })).toBe(1);
    expect(isoWeekday({ year: 2026, month: 11, day: 15 })).toBe(7);
    expect(nextLocalDate({ year: 2026, month: 12, day: 31 })).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
  });
});

describe("generateSlots", () => {
  const technicianId = "30000000-0000-4000-8000-000000000001";
  const query = (changes: Partial<SlotQuery>): SlotQuery => ({
    windows: [
      { technicianId, weekday: 1, startMinute: atMinute(9), endMinute: atMinute(12) },
    ],
    timezone: RIGA,
    durationMinutes: 60,
    stepMinutes: 30,
    from: new Date("2026-11-09T00:00:00Z"),
    to: new Date("2026-11-10T00:00:00Z"),
    earliestStart: new Date("2026-01-01T00:00:00Z"),
    ...changes,
  });
  const starts = (changes: Partial<SlotQuery>) =>
    generateSlots(query(changes)).map((slot) => iso(slot.startsAt));

  it("fits the service's duration into the window at each step", () => {
    const slots = generateSlots(query({}));
    expect(slots.map((slot) => [iso(slot.startsAt), iso(slot.endsAt)])).toEqual([
      ["2026-11-09T07:00:00.000Z", "2026-11-09T08:00:00.000Z"],
      ["2026-11-09T07:30:00.000Z", "2026-11-09T08:30:00.000Z"],
      ["2026-11-09T08:00:00.000Z", "2026-11-09T09:00:00.000Z"],
      ["2026-11-09T08:30:00.000Z", "2026-11-09T09:30:00.000Z"],
      ["2026-11-09T09:00:00.000Z", "2026-11-09T10:00:00.000Z"],
    ]);
  });

  it("offers nothing when the service does not fit the window", () => {
    expect(starts({ durationMinutes: 181 })).toEqual([]);
    expect(starts({ durationMinutes: 180 })).toEqual(["2026-11-09T07:00:00.000Z"]);
  });

  it("keeps a slot only when all of it is in the range", () => {
    expect(
      starts({
        from: new Date("2026-11-09T07:30:00Z"),
        to: new Date("2026-11-09T09:00:00Z"),
      }),
    ).toEqual([
      "2026-11-09T07:30:00.000Z",
      "2026-11-09T08:00:00.000Z",
    ]);
  });

  it("starts nothing before the earliest start", () => {
    expect(starts({ earliestStart: new Date("2026-11-09T08:30:00Z") })).toEqual([
      "2026-11-09T08:30:00.000Z",
      "2026-11-09T09:00:00.000Z",
    ]);
  });

  it("uses the shop's weekday, not the UTC one", () => {
    // 00:30 on Monday in Riga is still Sunday in UTC.
    expect(
      starts({
        windows: [
          { technicianId, weekday: 1, startMinute: atMinute(0, 30), endMinute: atMinute(1, 30) },
        ],
      }),
    ).toEqual([]);
    expect(
      starts({
        windows: [
          { technicianId, weekday: 1, startMinute: atMinute(0, 30), endMinute: atMinute(1, 30) },
        ],
        from: new Date("2026-11-08T00:00:00Z"),
      }),
    ).toEqual(["2026-11-08T22:30:00.000Z"]);
  });

  const nightWindow = {
    technicianId,
    weekday: 7,
    startMinute: atMinute(2),
    endMinute: atMinute(6),
  };

  it("has fewer slots on the night the clocks go forward", () => {
    const slots = generateSlots(
      query({
        windows: [nightWindow],
        from: new Date("2027-03-27T12:00:00Z"),
        to: new Date("2027-03-28T12:00:00Z"),
      }),
    );
    // 02:00 to 06:00 is only three hours that night. 03:00 to 04:00 does not exist.
    expect(slots.map((slot) => iso(slot.startsAt))).toEqual([
      "2027-03-28T00:00:00.000Z",
      "2027-03-28T00:30:00.000Z",
      "2027-03-28T01:00:00.000Z",
      "2027-03-28T01:30:00.000Z",
      "2027-03-28T02:00:00.000Z",
    ]);
    for (const slot of slots) {
      expect(slot.endsAt.getTime() - slot.startsAt.getTime()).toBe(3_600_000);
    }
  });

  it("has more slots on the night the clocks go back, each a distinct instant", () => {
    const slots = generateSlots(
      query({
        windows: [nightWindow],
        from: new Date("2027-10-30T12:00:00Z"),
        to: new Date("2027-10-31T12:00:00Z"),
      }),
    );
    // 02:00 to 06:00 is five hours that night, and 03:00 to 04:00 happens twice.
    expect(slots.map((slot) => iso(slot.startsAt))).toEqual([
      "2027-10-30T23:00:00.000Z",
      "2027-10-30T23:30:00.000Z",
      "2027-10-31T00:00:00.000Z",
      "2027-10-31T00:30:00.000Z",
      "2027-10-31T01:00:00.000Z",
      "2027-10-31T01:30:00.000Z",
      "2027-10-31T02:00:00.000Z",
      "2027-10-31T02:30:00.000Z",
      "2027-10-31T03:00:00.000Z",
    ]);
    expect(new Set(slots.map((slot) => iso(slot.startsAt))).size).toBe(slots.length);
  });

  it("keeps 09:00 at 09:00 across a clock change", () => {
    const windows = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      technicianId,
      weekday,
      startMinute: atMinute(9),
      endMinute: atMinute(10),
    }));
    expect(
      starts({
        windows,
        from: new Date("2027-03-27T00:00:00Z"),
        to: new Date("2027-03-30T00:00:00Z"),
      }),
    ).toEqual([
      "2027-03-27T07:00:00.000Z",
      "2027-03-28T06:00:00.000Z",
      "2027-03-29T06:00:00.000Z",
    ]);
  });

  it("orders several technicians by time", () => {
    const other = "30000000-0000-4000-8000-000000000002";
    const slots = generateSlots(
      query({
        windows: [
          { technicianId: other, weekday: 1, startMinute: atMinute(9), endMinute: atMinute(10) },
          { technicianId, weekday: 1, startMinute: atMinute(9), endMinute: atMinute(10) },
        ],
      }),
    );
    expect(slots.map((slot) => slot.technicianId)).toEqual([technicianId, other]);
  });
});

describe("slot IDs", () => {
  const reference = {
    serviceId: "20000000-0000-4000-8000-000000000002",
    technicianId: "30000000-0000-4000-8000-000000000001",
    startsAt: new Date("2026-11-09T07:30:00Z"),
    durationMinutes: 60,
  };

  it("round-trips and stays within the contract's length", () => {
    const slotId = encodeSlotId(reference);
    expect(decodeSlotId(slotId)).toEqual(reference);
    expect(slotId.length).toBeLessThanOrEqual(512);
    expect(slotId).toMatch(/^[\w-]+$/);
  });

  it.each(["", "not-a-slot", Buffer.from("a.b.c.d").toString("base64url")])(
    "refuses %j",
    (slotId) => {
      expect(decodeSlotId(slotId)).toBeUndefined();
    },
  );
});

describe("the booking policy", () => {
  it("always lets a hold run out before its appointment starts", () => {
    expect(BOOKING_POLICY.minLeadMinutes).toBeGreaterThan(BOOKING_POLICY.holdMinutes);
  });
});

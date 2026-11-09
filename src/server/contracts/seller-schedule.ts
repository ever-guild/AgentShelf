import { z } from "zod";

// What a seller may ask of their schedule: one day, in shop time. Strict, so a request naming a
// shop is refused rather than ignored. The shop always comes from the session.

export const scheduleDate = z.iso
  .date()
  .refine((date) => date >= "2000-01-01" && date <= "2099-12-31");

export const scheduleQuery = z.strictObject({ date: scheduleDate.optional() });

// Setting up who works and when, by the shop's owner. Each body is strict, so naming a shop is
// refused rather than ignored.

export const technicianName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}]*$/u, "Use letters, numbers and spaces only");

export const addTechnicianBody = z.strictObject({ name: technicianName });

// Shop wall clock, as the seller reads it. 24:00 is the end of the day and can only end a window.
export const wallClock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use HH:MM");

export const weeklyWindow = z.strictObject({
  // ISO weekday: 1 is Monday, 7 is Sunday.
  weekday: z.number().int().min(1).max(7),
  start: wallClock,
  end: wallClock,
});

// Seven days with up to four windows each is more than a workshop needs.
export const MAX_WEEKLY_WINDOWS = 28;

export const setWeekBody = z.strictObject({
  windows: z.array(weeklyWindow).max(MAX_WEEKLY_WINDOWS),
});

export type WeeklyWindow = z.infer<typeof weeklyWindow>;

export type TechnicianWeek = {
  technicianId: string;
  name: string;
  // Sorted by weekday, then start.
  windows: WeeklyWindow[];
};

export type ScheduleStatus =
  | "held"
  | "confirmed"
  | "expired"
  | "cancelled"
  | "review_required";

export type ScheduleBooking = {
  bookingId: string;
  technicianId: string;
  serviceTitle: string;
  status: ScheduleStatus;
  reviewReason: "late_capture" | "captured_after_cancel" | null;
  paymentStatus:
    | "pending"
    | "approved"
    | "paid"
    | "cancelled"
    | "failed"
    | "review_required";
  // Shop wall clock with no offset, because Bryntum Community has no timezone setting and reads
  // these as written.
  startsLocal: string;
  endsLocal: string;
  // Where the bar ends. Differs from endsLocal only when the clocks going back would make the bar
  // end where it starts.
  barEndLocal: string;
  holdExpiresAt: string;
  holdExpiresLocal: string;
  depositMinor: number;
  remainingMinor: number;
  currency: string;
};

export type ScheduleView = {
  // The session's shop. An open page compares this, because a sign-in to another shop in the same
  // browser changes whose schedule its next refresh brings back.
  shopId: string;
  timezone: string;
  // The server's clock when this was read. Every age on the page is measured from it.
  generatedAt: string;
  // The day shown, and today, both in shop time.
  date: string;
  today: string;
  // The hours the timeline shows, as shop wall clock.
  timelineStart: string;
  timelineEnd: string;
  // The closest days outside this one with a booking that still matters, for jumping past empty
  // days. Expired and cancelled bookings do not count.
  previousBookingDate: string | null;
  nextBookingDate: string | null;
  technicians: { technicianId: string; name: string }[];
  bookings: ScheduleBooking[];
};

import { z } from "zod";

// What a seller may ask of their schedule: one day, in shop time. Strict, so a request naming a
// shop is refused rather than ignored. The shop always comes from the session.

export const scheduleDate = z.iso
  .date()
  .refine((date) => date >= "2000-01-01" && date <= "2099-12-31");

export const scheduleQuery = z.strictObject({ date: scheduleDate.optional() });

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

"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type {
  ScheduleBooking,
  ScheduleStatus,
  ScheduleView,
} from "@/server/contracts/seller-schedule";

import {
  barStateForms,
  depositText,
  effectiveStatus,
  longDate,
  paymentToCheck,
  shiftDate,
  shopTime,
  shortDate,
  statusLabel,
} from "./schedule-labels";
import type { TimelineBooking } from "./schedule-timeline";
import { TechnicianSetup } from "./technician-setup";
import { timelineHeight } from "./timeline-size";
import "./schedule-status.css";

// Bryntum does not support server rendering, and only this page should pay for its size.
const ScheduleTimeline = dynamic(() => import("./schedule-timeline"), {
  ssr: false,
  loading: () => <p className={`py-3 text-sm ${SECONDARY_TEXT}`}>Loading the timeline</p>,
});

// Five seconds between answers keeps a new confirmation inside the ten seconds the seller is
// promised, even if a request is slow. A request is given up on after REQUEST_TIMEOUT_MS.
const POLL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 4_000;
const STALE_AFTER_MS = 15_000;

const button =
  "inline-flex h-10 items-center rounded-lg border border-zinc-300 px-3 text-sm font-medium transition-[background-color,transform] enabled:hover:bg-zinc-100 enabled:active:scale-[0.98] disabled:opacity-60 sm:h-9 dark:border-zinc-700 dark:enabled:hover:bg-zinc-800";
const SECONDARY_TEXT = "text-zinc-600 dark:text-zinc-400";

class TimelineBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <p className="border-l-4 border-blocked pl-4 text-sm">
        The timeline could not load. The list below has every booking. Reload the page to try again.
      </p>
    ) : (
      this.props.children
    );
  }
}

function changeSignature(view: ScheduleView): string {
  return JSON.stringify(
    view.bookings.map(({ bookingId, status, paymentStatus, technicianId, startsLocal, endsLocal }) => [
      bookingId,
      status,
      paymentStatus,
      technicianId,
      startsLocal,
      endsLocal,
    ]),
  );
}

function timeOnDay(local: string, date: string): string {
  return local.slice(0, 10) === date
    ? shopTime(local)
    : `${shopTime(local)} on ${shortDate(local.slice(0, 10))}`;
}

function timeRange(booking: ScheduleBooking, date: string): string {
  return `${timeOnDay(booking.startsLocal, date)} to ${timeOnDay(booking.endsLocal, date)}`;
}

// A booking whose payment needs a check keeps the shape of its state but takes the color of
// something to check, as its words say.
function stateClasses(status: ScheduleStatus, paymentStatus: ScheduleBooking["paymentStatus"]): string {
  return paymentToCheck(status, paymentStatus)
    ? `booking-state-${status} booking-state-unsettled`
    : `booking-state-${status}`;
}

export function ScheduleBoard({
  initial,
  waiting,
}: {
  initial: ScheduleView;
  // A technician with no working hours yet, whom the setup offers to finish.
  waiting: { technicianId: string; name: string } | null;
}) {
  const dateParam = useSearchParams().get("date");
  // Stays open once shown, so a save that fails halfway keeps its message while the timeline
  // changes underneath, and a finished one keeps its confirmation.
  const [setupOpen] = useState(() => initial.technicians.length === 0 || waiting !== null);

  const [{ view, receivedAt }, setLatest] = useState<{
    view: ScheduleView;
    // The browser's clock when `view` arrived, set from the first tick for the server's answer.
    receivedAt: number | null;
  }>({ view: initial, receivedAt: null });
  const [clock, setClock] = useState(() => Date.parse(initial.generatedAt));
  const [refresh, setRefresh] = useState<"ok" | "failed" | "signed_out">("ok");
  const [retries, setRetries] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const isFirstRun = useRef(true);
  const signature = useRef(changeSignature(initial));

  useEffect(() => {
    const ticker = setInterval(() => {
      const browserNow = Date.now();
      setClock(browserNow);
      setLatest((latest) =>
        latest.receivedAt === null ? { ...latest, receivedAt: browserNow } : latest,
      );
    }, 1_000);
    return () => clearInterval(ticker);
  }, []);

  // One request at a time, and the next is planned only when this one has ended, so slow answers
  // cannot pile up or arrive out of order. Changing day abandons whatever is in flight.
  useEffect(() => {
    let abandoned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | undefined;
    const url = dateParam
      ? `/api/seller/schedule?date=${encodeURIComponent(dateParam)}`
      : "/api/seller/schedule";

    async function poll() {
      const controller = new AbortController();
      inFlight = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (abandoned) {
          return;
        }
        if (response.status === 401) {
          setRefresh("signed_out");
          return;
        }
        if (!response.ok) {
          throw new Error("Refresh failed");
        }
        const next = (await response.json()) as ScheduleView;
        if (abandoned) {
          return;
        }
        // Another shop signed in from this browser. Its schedule is not for this page's header.
        if (next.shopId !== initial.shopId) {
          setRefresh("signed_out");
          return;
        }
        const nextSignature = changeSignature(next);
        if (nextSignature !== signature.current) {
          signature.current = nextSignature;
          const confirmed = next.bookings.filter(({ status }) => status === "confirmed").length;
          setAnnouncement(
            `Schedule changed. ${next.bookings.length} bookings on this day, ${confirmed} confirmed.`,
          );
        }
        setLatest({ view: next, receivedAt: Date.now() });
        setClock(Date.now());
        setRefresh("ok");
      } catch {
        if (abandoned) {
          return;
        }
        setRefresh("failed");
      } finally {
        clearTimeout(timeout);
        inFlight = undefined;
      }
      if (!abandoned) {
        timer = setTimeout(poll, POLL_MS);
      }
    }

    // A tab coming back from the background checks at once, because its timers were slowed down.
    function onVisible() {
      if (document.visibilityState === "visible" && !inFlight) {
        clearTimeout(timer);
        void poll();
      }
    }
    document.addEventListener("visibilitychange", onVisible);

    if (isFirstRun.current) {
      isFirstRun.current = false;
      timer = setTimeout(poll, POLL_MS);
    } else {
      void poll();
    }

    return () => {
      abandoned = true;
      clearTimeout(timer);
      inFlight?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [dateParam, retries, initial.shopId]);

  const goTo = useCallback((date: string | null) => {
    window.history.pushState(null, "", date ? `?date=${date}` : window.location.pathname);
  }, []);

  const requestedDate = dateParam ?? view.today;
  const dayIsLoaded = view.date === requestedDate;

  // The server's clock now, as far as the browser can tell, so a wrong clock on the seller's
  // computer does not end a hold early.
  const generatedAtMs = Date.parse(view.generatedAt);
  const serverNow = generatedAtMs + (receivedAt === null ? 0 : Math.max(0, clock - receivedAt));
  const isStale = serverNow - generatedAtMs > STALE_AFTER_MS;

  const updatedAt = new Intl.DateTimeFormat("en-GB", {
    timeStyle: "medium",
    timeZone: view.timezone,
  }).format(generatedAtMs);

  // Handed to the timeline as text, so that it can tell when its data has really changed. A refresh
  // or a tick of the clock usually changes nothing, and reloading its stores would be wasted work.
  const display = view.bookings.map((booking) => {
    const status = effectiveStatus(booking, serverNow);
    return {
      booking,
      status,
      stateClass: stateClasses(status, booking.paymentStatus),
      label: statusLabel(status, booking.paymentStatus),
      detail: depositText(booking, status),
    };
  });
  const timelineData = JSON.stringify(
    display.map(({ booking, status, stateClass, label, detail }): TimelineBooking => ({
      id: booking.bookingId,
      resourceId: booking.technicianId,
      startDate: booking.startsLocal,
      endDate: booking.barEndLocal,
      name: booking.serviceTitle,
      stateClass,
      label,
      barForms: barStateForms(status, booking.paymentStatus),
      detail,
      start: timeOnDay(booking.startsLocal, view.date),
      times: timeRange(booking, view.date),
    })),
  );
  if (refresh === "signed_out") {
    return (
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-8 sm:px-6">
        <h1 className="text-3xl font-medium">Schedule</h1>
        <p className="border-l-4 border-blocked pl-4">
          This shop is no longer signed in here, so its schedule is hidden.{" "}
          <Link href="/seller/sign-in" className="underline underline-offset-4">
            Sign in again
          </Link>{" "}
          to see it.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6">
      {/* A page of the diary is headed by its day. */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-medium text-balance">
            <span className="sr-only">Schedule, </span>
            {longDate(requestedDate)}
          </h1>
          <p className={SECONDARY_TEXT}>Times are shop time, {view.timezone}</p>
          <p className={`text-sm ${SECONDARY_TEXT}`}>
            Buyers’ assistants hold and book these slots, and a booking is confirmed once its PayPal
            deposit is captured
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <nav aria-label="Choose a day" className="flex flex-wrap items-center gap-2">
            <button type="button" className={button} onClick={() => goTo(shiftDate(requestedDate, -1))}>
              Previous day
            </button>
            <button
              type="button"
              className={button}
              disabled={requestedDate === view.today}
              onClick={() => goTo(null)}
            >
              Today
            </button>
            <button type="button" className={button} onClick={() => goTo(shiftDate(requestedDate, 1))}>
              Next day
            </button>
            <DatePicker date={requestedDate} today={view.today} onPick={goTo} />
          </nav>

          <RefreshLine
            state={refresh}
            isStale={isStale}
            updatedAt={updatedAt}
            onRetry={() => setRetries((count) => count + 1)}
          />
        </div>
      </div>
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {setupOpen && (
        <TechnicianSetup
          timezone={view.timezone}
          waiting={waiting}
          onSaved={() => setRetries((count) => count + 1)}
        />
      )}

      {!dayIsLoaded ? (
        <p className={SECONDARY_TEXT}>Loading {longDate(requestedDate)}</p>
      ) : view.technicians.length === 0 ? (
        setupOpen ? null : (
          <p className="max-w-prose">
            This shop has no technicians set up, so buyers cannot book repairs and there is nothing
            to schedule.
          </p>
        )
      ) : (
        <>
          {/* The timeline's place stays free while it loads, so the list below does not jump. */}
          <section
            aria-label="Timeline"
            className="flex flex-col gap-2"
            style={{
              minHeight: timelineHeight(
                view.technicians.map(({ technicianId }) => technicianId),
                view.bookings,
              ),
            }}
          >
            <a
              href="#schedule-list"
              className="sr-only self-start text-sm underline underline-offset-4 focus:not-sr-only"
            >
              Skip to the list of bookings
            </a>
            <TimelineBoundary>
              <ScheduleTimeline
                key={view.date}
                start={view.timelineStart}
                end={view.timelineEnd}
                techniciansJson={JSON.stringify(
                  view.technicians.map(({ technicianId, name }) => ({ id: technicianId, name })),
                )}
                bookingsJson={timelineData}
              />
            </TimelineBoundary>
          </section>

          <section className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <h2 id="schedule-list" tabIndex={-1} className="text-lg font-medium">
                  Bookings on this day
                </h2>
                <div className="flex flex-wrap items-center gap-2 empty:hidden">
                  {view.previousBookingDate && (
                    <button type="button" className={button} onClick={() => goTo(view.previousBookingDate)}>
                      Earlier booking, {shortDate(view.previousBookingDate)}
                    </button>
                  )}
                  {view.nextBookingDate && (
                    <button type="button" className={button} onClick={() => goTo(view.nextBookingDate)}>
                      Next booking, {shortDate(view.nextBookingDate)}
                    </button>
                  )}
                </div>
              </div>
              {view.bookings.length === 0 && (
                <p className="max-w-prose">
                  Nothing is booked on {longDate(view.date)}. Bookings appear here as soon as a
                  buyer&apos;s assistant holds a slot.
                </p>
              )}
            </div>
            {view.bookings.length > 0 &&
              view.technicians.map(({ technicianId, name }) => {
                const own = display.filter(({ booking }) => booking.technicianId === technicianId);
                return (
                  <div key={technicianId} className="flex flex-col gap-2">
                    <h3 className="font-medium">{name}</h3>
                    {own.length === 0 ? (
                      <p className={`text-sm ${SECONDARY_TEXT}`}>Nothing booked</p>
                    ) : (
                      <ul className="flex flex-col border-t border-zinc-200 dark:border-zinc-800">
                        {own.map(({ booking, status, stateClass, label, detail }) => {
                          // What fell through stays in the diary, crossed out.
                          const fellThrough = status === "expired" || status === "cancelled";
                          return (
                            <li
                              key={booking.bookingId}
                              data-booking={booking.bookingId}
                              className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 border-b border-zinc-200 py-3 sm:grid-cols-[8rem_minmax(0,1fr)_14rem] dark:border-zinc-800"
                            >
                              <span className={`text-sm tabular-nums ${fellThrough ? SECONDARY_TEXT : ""}`}>
                                {timeRange(booking, view.date)}
                              </span>
                              <span className="col-span-2 row-start-2 flex min-w-0 flex-col gap-1 break-words sm:col-span-1 sm:row-start-auto">
                                <span className={fellThrough ? `line-through ${SECONDARY_TEXT}` : "font-medium"}>
                                  {booking.serviceTitle}
                                </span>
                                <span className={`text-sm tabular-nums ${SECONDARY_TEXT}`}>{detail}</span>
                              </span>
                              <span
                                className={`booking-state booking-pill ${stateClass} col-start-2 row-start-1 justify-self-end text-sm font-medium sm:col-start-auto sm:row-start-auto sm:justify-self-start`}
                              >
                                {label}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
          </section>
        </>
      )}
    </div>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FIRST_MONTH = "2000-01";
const LAST_MONTH = "2099-12";
const monthName = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const pickedDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

// Dates here are the shop's calendar days, so every step is done in UTC and no time zone moves a day.
function shiftMonth(month: string, by: number): string {
  const [year = 2000, index = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index - 1 + by, 1)).toISOString().slice(0, 7);
}

function daysOf(month: string): { blanks: number; days: string[] } {
  const [year = 2000, index = 1] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year, index, 0)).getUTCDate();
  // Weeks start on Monday, as they do where the demo shops are.
  const blanks = (new Date(Date.UTC(year, index - 1, 1)).getUTCDay() + 6) % 7;
  return {
    blanks,
    days: Array.from({ length: count }, (_, day) => `${month}-${String(day + 1).padStart(2, "0")}`),
  };
}

// The page's own calendar, so the day is picked in the page's language and colors on every system.
function DatePicker({ date, today, onPick }: { date: string; today: string; onPick: (date: string) => void }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(date.slice(0, 7));
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const { blanks, days } = daysOf(month);
  const step =
    "inline-flex size-9 items-center justify-center rounded-lg transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800";

  return (
    <div ref={root} className={`relative flex items-center gap-2 text-sm ${SECONDARY_TEXT}`}>
      <span id="go-to-label">Go to</span>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby="go-to-label go-to-value"
        onClick={() => {
          // The calendar always opens on the month of the day being shown.
          setMonth(date.slice(0, 7));
          setOpen((current) => !current);
        }}
        className="inline-flex h-10 items-center rounded-lg border border-zinc-300 px-3 text-base text-foreground tabular-nums transition-colors hover:bg-zinc-100 sm:h-9 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        <span id="go-to-value">{pickedDate.format(new Date(`${date}T00:00:00Z`))}</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Choose a date"
          className="absolute top-full left-0 z-20 mt-2 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl border border-zinc-200 bg-background p-3 text-foreground shadow-lg dark:border-zinc-800"
        >
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label="Previous month"
              disabled={month <= FIRST_MONTH}
              onClick={() => setMonth(shiftMonth(month, -1))}
              className={step}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 3 5 8l5 5" />
              </svg>
            </button>
            <p aria-live="polite" className="font-medium">
              {monthName.format(new Date(`${month}-01T00:00:00Z`))}
            </p>
            <button
              type="button"
              aria-label="Next month"
              disabled={month >= LAST_MONTH}
              onClick={() => setMonth(shiftMonth(month, 1))}
              className={step}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 3 5 5-5 5" />
              </svg>
            </button>
          </div>
          <div className="grid grid-cols-7 text-center tabular-nums">
            {WEEKDAYS.map((weekday) => (
              <span key={weekday} className={`py-1 text-xs ${SECONDARY_TEXT}`}>
                {weekday}
              </span>
            ))}
            {Array.from({ length: blanks }, (_, blank) => (
              <span key={`blank-${blank}`} />
            ))}
            {days.map((day) => {
              const shown = day === date;
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={shown}
                  aria-current={day === today ? "date" : undefined}
                  onClick={() => {
                    setOpen(false);
                    onPick(day);
                  }}
                  className={`inline-flex size-9 items-center justify-center justify-self-center rounded-lg transition-colors ${
                    shown
                      ? "bg-ink font-medium text-background"
                      : `hover:bg-zinc-100 dark:hover:bg-zinc-800 ${day === today ? "font-medium text-ink" : ""}`
                  }`}
                >
                  {Number(day.slice(8))}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RefreshLine({
  state,
  isStale,
  updatedAt,
  onRetry,
}: {
  state: "ok" | "failed";
  isStale: boolean;
  updatedAt: string;
  onRetry: () => void;
}) {
  if (state === "failed") {
    return (
      <div role="alert" className="flex w-full flex-wrap items-center gap-3 border-l-4 border-blocked pl-4 text-sm">
        <p>
          Could not refresh. This is the schedule as it was at {updatedAt}, so a recent payment may be
          missing. Still trying every few seconds.
        </p>
        <button type="button" className={button} onClick={onRetry}>
          Try now
        </button>
      </div>
    );
  }
  if (isStale) {
    return (
      <p role="alert" className="w-full border-l-4 border-doubt pl-4 text-sm">
        This may be out of date. Last updated at {updatedAt}, and the next update is late.
      </p>
    );
  }
  return (
    <p className={`text-sm tabular-nums ${SECONDARY_TEXT}`}>
      Updated at {updatedAt}. Refreshes every few seconds.
    </p>
  );
}

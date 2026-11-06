"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { ScheduleBooking, ScheduleView } from "@/server/contracts/seller-schedule";

import {
  depositText,
  effectiveStatus,
  longDate,
  shiftDate,
  shopTime,
  shortDate,
  statusLabel,
} from "./schedule-labels";
import type { TimelineBooking } from "./schedule-timeline";
import "./schedule-status.css";

// Bryntum does not support server rendering, and only this page should pay for its size.
const ScheduleTimeline = dynamic(() => import("./schedule-timeline"), {
  ssr: false,
  loading: () => <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading the timeline</p>,
});

// Five seconds between answers keeps a new confirmation inside the ten seconds the seller is
// promised, even if a request is slow. A request is given up on after REQUEST_TIMEOUT_MS.
const POLL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 4_000;
const STALE_AFTER_MS = 15_000;

const button =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900";

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

function timeRange(booking: ScheduleBooking, date: string): string {
  const onDay = (local: string) =>
    local.slice(0, 10) === date ? shopTime(local) : `${shopTime(local)} on ${shortDate(local.slice(0, 10))}`;
  return `${onDay(booking.startsLocal)} to ${onDay(booking.endsLocal)}`;
}

export function ScheduleBoard({ initial }: { initial: ScheduleView }) {
  const dateParam = useSearchParams().get("date");

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
      label: statusLabel(status, booking.paymentStatus),
      detail: depositText(booking, status),
    };
  });
  const timelineData = JSON.stringify(
    display.map(({ booking, status, label, detail }): TimelineBooking => ({
      id: booking.bookingId,
      resourceId: booking.technicianId,
      startDate: booking.startsLocal,
      endDate: booking.barEndLocal,
      name: booking.serviceTitle,
      stateClass: `booking-state-${status}`,
      label,
      detail,
      times: timeRange(booking, view.date),
    })),
  );
  if (refresh === "signed_out") {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-8 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight">Schedule</h1>
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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Schedule</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          {longDate(requestedDate)}. Times are shop time, {view.timezone}.
        </p>
      </div>

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
        <DatePicker date={requestedDate} onPick={goTo} />
      </nav>

      <RefreshLine
        state={refresh}
        isStale={isStale}
        updatedAt={updatedAt}
        onRetry={() => setRetries((count) => count + 1)}
      />
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {!dayIsLoaded ? (
        <p className="text-zinc-600 dark:text-zinc-400">Loading {longDate(requestedDate)}</p>
      ) : view.technicians.length === 0 ? (
        <p className="max-w-prose">
          This shop has no technicians set up, so buyers cannot book repairs and there is nothing to
          schedule.
        </p>
      ) : (
        <>
          <section aria-label="Timeline" className="flex flex-col gap-2">
            <a
              href="#schedule-list"
              className="self-start text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
            >
              Skip the timeline and go to the list of bookings
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

          <section className="flex flex-col gap-4">
            <h2
              id="schedule-list"
              tabIndex={-1}
              className="text-xl font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              Bookings on this day
            </h2>
            {view.bookings.length === 0 && (
              <p className="max-w-prose">
                Nothing is booked on {longDate(view.date)}. Bookings appear here as soon as a buyer&apos;s
                assistant holds a slot.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
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
            {view.bookings.length > 0 &&
              view.technicians.map(({ technicianId, name }) => {
                const own = display.filter(({ booking }) => booking.technicianId === technicianId);
                return (
                  <div key={technicianId} className="flex flex-col gap-2">
                    <h3 className="font-medium">{name}</h3>
                    {own.length === 0 ? (
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">Nothing booked.</p>
                    ) : (
                      <ul className="flex flex-col border-t border-zinc-200 dark:border-zinc-800">
                        {own.map(({ booking, status, label, detail }) => (
                          <li
                            key={booking.bookingId}
                            data-booking={booking.bookingId}
                            className="grid gap-x-4 gap-y-1 border-b border-zinc-200 py-3 sm:grid-cols-[9rem_1fr_auto] dark:border-zinc-800"
                          >
                            <span className="text-sm tabular-nums">{timeRange(booking, view.date)}</span>
                            <span className="flex min-w-0 flex-col gap-1 break-words">
                              <span className="font-medium">{booking.serviceTitle}</span>
                              <span className="text-sm text-zinc-600 dark:text-zinc-400">{detail}</span>
                            </span>
                            <span
                              className={`booking-state booking-state-${status} self-start justify-self-start px-2 py-0.5 text-sm font-medium`}
                            >
                              {label}
                            </span>
                          </li>
                        ))}
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

// Typing a year passes through dates like 0002-11-09, which are not days to navigate to, so this
// leaves the field alone until what is typed can be shown.
function DatePicker({ date, onPick }: { date: string; onPick: (date: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) {
      input.current.value = date;
    }
  }, [date]);
  return (
    <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
      Go to
      <input
        ref={input}
        type="date"
        defaultValue={date}
        min="2000-01-01"
        max="2099-12-31"
        onChange={(event) => {
          const picked = event.target.value;
          if (picked >= "2000-01-01" && picked <= "2099-12-31") {
            onPick(picked);
          }
        }}
        className="rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink md:text-sm dark:border-zinc-700"
      />
    </label>
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
      <div role="alert" className="flex flex-wrap items-center gap-3 border-l-4 border-blocked pl-4 text-sm">
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
      <p role="alert" className="border-l-4 border-doubt pl-4 text-sm">
        This may be out of date. Last updated at {updatedAt}, and the next update is late.
      </p>
    );
  }
  return (
    <p className="text-sm text-zinc-600 tabular-nums dark:text-zinc-400">
      Updated at {updatedAt}. Refreshes every few seconds.
    </p>
  );
}

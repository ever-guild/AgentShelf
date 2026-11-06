"use client";

import type { AgStudioApi, AgStudioMode } from "ag-studio";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  DASHBOARD_PERIODS,
  DEFAULT_DASHBOARD_PERIOD,
  type DashboardPeriod,
} from "@/server/contracts/seller-dashboard";

import { buildStudioData } from "./dashboard-data";
import { ORDER_KIND_LABELS, money, orderMoneyText, orderStatusLabel, shopDateTime } from "./dashboard-labels";
import { clearSavedLayout, defaultReport } from "./dashboard-report";
import {
  DATASET_NAMES,
  resetDashboardState,
  setDashboardState,
  useDashboardState,
  type DatasetName,
  type Datasets,
} from "./dashboard-store";
import "./dashboard.css";

// Only this route should pay for Studio's size.
const DashboardStudio = dynamic(() => import("./dashboard-studio"), {
  ssr: false,
  loading: () => <p className="px-4 py-8 text-zinc-600 sm:px-6 dark:text-zinc-400">Loading the dashboard</p>,
});

const POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CLOCK_TICK_MS = 5_000;
const PERIOD_STORAGE_KEY = "agentshelf.dashboard.period";

const DATASET_LABELS: Record<DatasetName, string> = {
  orders: "orders",
  payments: "payments",
  bookings: "bookings",
  demand: "search demand",
  insights: "search groups",
};

const button =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900";

class StudioBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <p className="mx-4 my-6 border-l-4 border-blocked pl-4 text-sm sm:mx-6">
        The dashboard could not load. Reload the page to try again. Bookings are also on the{" "}
        <Link className="underline underline-offset-4" href="/seller/schedule">
          schedule
        </Link>
        .
      </p>
    ) : (
      this.props.children
    );
  }
}

function readSavedPeriod(): DashboardPeriod {
  try {
    const saved = window.localStorage.getItem(PERIOD_STORAGE_KEY);
    return DASHBOARD_PERIODS.find((period) => period === saved) ?? DEFAULT_DASHBOARD_PERIOD;
  } catch {
    return DEFAULT_DASHBOARD_PERIOD;
  }
}

function savePeriod(period: DashboardPeriod) {
  try {
    window.localStorage.setItem(PERIOD_STORAGE_KEY, period);
  } catch {
    // A browser that keeps nothing starts from the default next time.
  }
}

// The same answer apart from its time, so Studio is not asked to redraw for nothing.
function sameAnswer(a: object | null, b: object): boolean {
  if (!a) {
    return false;
  }
  return JSON.stringify({ ...a, generatedAt: "" }) === JSON.stringify({ ...b, generatedAt: "" });
}

function clockTime(instant: string, timezone: string | undefined): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: timezone,
  }).format(new Date(instant));
}

function OrderDetails() {
  const { openOrder: order } = useDashboardState();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (order && element && !element.open) {
      element.showModal();
    }
  }, [order]);

  return (
    <dialog
      ref={dialog}
      onClose={() => setDashboardState({ openOrder: null })}
      aria-label="Order details"
      className="m-auto w-[calc(100vw-2rem)] max-w-lg rounded-md border border-zinc-300 bg-background p-5 text-sm text-foreground backdrop:bg-black/40 dark:border-zinc-700"
    >
      {order ? (
        <div className="space-y-3">
          <h2 className="text-base font-semibold">Order {order.reference}</h2>
          <p>
            {orderStatusLabel(order)}. {ORDER_KIND_LABELS[order.kind]}.
          </p>
          <p>{orderMoneyText(order)}</p>
          <table className="w-full text-left tabular-nums">
            <thead className="text-zinc-600 dark:text-zinc-400">
              <tr>
                <th className="py-1 pr-2 font-medium">Item</th>
                <th className="py-1 pr-2 font-medium">Quantity</th>
                <th className="py-1 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.productId} className="border-t border-zinc-200 dark:border-zinc-800">
                  <td className="py-1 pr-2 break-words">{line.title}</td>
                  <td className="py-1 pr-2">{line.quantity}</td>
                  <td className="py-1 text-right">{money(line.lineTotalMinor, order.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
            <dt className="text-zinc-600 dark:text-zinc-400">Order total</dt>
            <dd>{money(order.totalMinor, order.currency)}</dd>
            {order.booking ? (
              <>
                <dt className="text-zinc-600 dark:text-zinc-400">Service price</dt>
                <dd>{money(order.booking.servicePriceMinor, order.currency)}</dd>
                <dt className="text-zinc-600 dark:text-zinc-400">Due at the shop</dt>
                <dd>{money(order.booking.remainingMinor, order.currency)}</dd>
                <dt className="text-zinc-600 dark:text-zinc-400">Appointment</dt>
                <dd>{shopDateTime(order.booking.startsLocal)}</dd>
              </>
            ) : null}
            <dt className="text-zinc-600 dark:text-zinc-400">Created</dt>
            <dd>{shopDateTime(order.createdLocal)}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">Last changed</dt>
            <dd>{shopDateTime(order.updatedLocal)}</dd>
            {order.captureId ? (
              <>
                <dt className="text-zinc-600 dark:text-zinc-400">PayPal capture</dt>
                <dd className="break-all">{order.captureId}</dd>
              </>
            ) : null}
          </dl>
          <form method="dialog">
            <button type="submit" className={button}>
              Close
            </button>
          </form>
        </div>
      ) : null}
    </dialog>
  );
}

export default function DashboardBoard({
  shopId,
  licenseKey,
  currency,
}: {
  shopId: string;
  licenseKey: string | undefined;
  currency: string;
}) {
  const state = useDashboardState();
  const [period, setPeriod] = useState<DashboardPeriod>(readSavedPeriod);
  const [signedOut, setSignedOut] = useState(false);
  const [mode, setMode] = useState<AgStudioMode>("view");
  const [asking, setAsking] = useState(false);
  const [retries, setRetries] = useState(0);
  const api = useRef<AgStudioApi | null>(null);
  const data = useRef<Datasets>(state.data);
  const clockOffset = useRef(0);

  useEffect(() => {
    const ticker = setInterval(
      () => setDashboardState({ serverNow: Date.now() + clockOffset.current }),
      CLOCK_TICK_MS,
    );
    return () => {
      clearInterval(ticker);
      resetDashboardState();
    };
  }, []);

  // One round of requests at a time, and the next is planned only when this one has ended, so slow
  // answers cannot pile up or arrive out of order. Changing the period abandons what is in flight.
  useEffect(() => {
    let abandoned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | undefined;

    async function readDataset(name: DatasetName, signal: AbortSignal) {
      const response = await fetch(`/api/seller/dashboard/${name}?days=${period}`, {
        cache: "no-store",
        signal,
      });
      if (response.status === 401) {
        return "signed_out" as const;
      }
      if (!response.ok) {
        throw new Error("Refresh failed");
      }
      return response.json();
    }

    async function poll() {
      const controller = new AbortController();
      inFlight = controller;
      setDashboardState({ loading: true });
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const answers = await Promise.allSettled(DATASET_NAMES.map((name) => readDataset(name, controller.signal)));
      clearTimeout(timeout);
      inFlight = undefined;
      if (abandoned) {
        return;
      }

      const next: Datasets = { ...data.current };
      const failed: DatasetName[] = [];
      let generatedAt: string | null = null;
      for (const [index, answer] of answers.entries()) {
        const name = DATASET_NAMES[index];
        if (answer.status === "rejected") {
          failed.push(name);
          continue;
        }
        // Another shop signed in from this browser, or none is. Its data is not for this page.
        if (answer.value === "signed_out" || answer.value.shopId !== shopId) {
          setSignedOut(true);
          resetDashboardState();
          return;
        }
        generatedAt = answer.value.generatedAt;
        if (!sameAnswer(next[name], answer.value)) {
          (next as Record<DatasetName, unknown>)[name] = answer.value;
        }
      }
      data.current = next;
      if (generatedAt) {
        clockOffset.current = Date.parse(generatedAt) - Date.now();
      }
      setDashboardState({
        data: next,
        failed,
        loading: false,
        serverNow: Date.now() + clockOffset.current,
        // The time on the page says when everything was last read together.
        ...(failed.length === 0 && generatedAt ? { refreshedAt: generatedAt } : {}),
      });
      timer = setTimeout(poll, POLL_MS);
    }

    // A tab coming back from the background checks at once, because its timers were slowed down.
    function onVisible() {
      if (document.visibilityState === "visible" && !inFlight) {
        clearTimeout(timer);
        void poll();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    void poll();

    return () => {
      abandoned = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(timer);
      inFlight?.abort();
    };
  }, [period, retries, shopId]);

  const onApi = useCallback((studioApi: AgStudioApi) => {
    api.current = studioApi;
  }, []);

  function resetLayout() {
    clearSavedLayout(shopId);
    api.current?.setState(defaultReport());
    api.current?.clearHistory();
    setMode("view");
  }

  const arranging = mode === "edit" && !asking;
  const loaded = DATASET_NAMES.some((name) => state.data[name] !== null);
  const studioData = useMemo(() => buildStudioData(state.data, currency), [state.data, currency]);
  const timezone = state.data.orders?.timezone ?? state.data.payments?.timezone;
  const truncated = (["orders", "payments", "bookings", "demand", "insights"] as const).filter(
    (name) => state.data[name]?.truncated,
  );

  if (signedOut) {
    return (
      <p className="mx-4 my-8 border-l-4 border-blocked pl-4 text-sm sm:mx-6">
        The shop is no longer signed in here.{" "}
        <Link className="underline underline-offset-4" href="/seller/sign-in">
          Sign in again
        </Link>{" "}
        to see its dashboard.
      </p>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-zinc-600 tabular-nums dark:text-zinc-400">
            {state.refreshedAt
              ? `Updated at ${clockTime(state.refreshedAt, timezone)}, shop time`
              : state.loading
                ? "Loading your numbers"
                : "Not updated yet"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Period" className="flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
            {DASHBOARD_PERIODS.map((days) => (
              <button
                key={days}
                type="button"
                aria-pressed={period === days}
                onClick={() => {
                  setPeriod(days);
                  savePeriod(days);
                }}
                className={`px-3 py-1.5 text-sm tabular-nums focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink ${
                  period === days
                    ? "bg-ink font-medium text-background"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-900"
                }`}
              >
                {days} days
              </button>
            ))}
          </div>
          <button type="button" className={button} disabled={state.loading} onClick={() => setRetries((n) => n + 1)}>
            Refresh
          </button>
          <button
            type="button"
            className={`${button} max-md:hidden`}
            aria-pressed={arranging}
            onClick={() => {
              setAsking(false);
              setMode(arranging ? "view" : "edit");
            }}
          >
            {arranging ? "Done arranging" : "Arrange"}
          </button>
          {state.data.insights?.aiAvailable ? (
            <button
              type="button"
              className={`${button} max-md:hidden`}
              aria-pressed={asking}
              onClick={() => {
                setAsking(!asking);
                setMode(asking ? "view" : "edit");
              }}
            >
              {asking ? "Back to the dashboard" : "Ask about demand"}
            </button>
          ) : null}
          {arranging ? (
            <button type="button" className={`${button} max-md:hidden`} onClick={resetLayout}>
              Reset layout
            </button>
          ) : null}
        </div>
      </div>

      {state.failed.length > 0 ? (
        <div role="alert" className="mx-4 mb-3 flex flex-wrap items-center gap-3 border-l-4 border-blocked pl-4 text-sm sm:mx-6">
          <p>
            Could not refresh {state.failed.map((name) => DATASET_LABELS[name]).join(", ")}.{" "}
            {loaded && state.refreshedAt
              ? `Showing what was read at ${clockTime(state.refreshedAt, timezone)}.`
              : "Nothing could be read for these yet."}
          </p>
          <button type="button" className={button} disabled={state.loading} onClick={() => setRetries((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : null}

      {truncated.length > 0 ? (
        <p className="mx-4 mb-3 border-l-4 border-doubt pl-4 text-sm sm:mx-6">
          Showing the newest rows of {truncated.map((name) => DATASET_LABELS[name]).join(", ")}. Payment status still
          counts every order. Choose a shorter period to see every row.
        </p>
      ) : null}

      {loaded ? (
        <div className="relative h-[calc(100dvh-7.5rem)] min-h-[32rem] w-full border-t border-zinc-200 dark:border-zinc-800">
          <StudioBoundary>
            <DashboardStudio
              licenseKey={licenseKey}
              shopId={shopId}
              data={studioData}
              mode={mode}
              asking={asking}
              onApi={onApi}
            />
          </StudioBoundary>
        </div>
      ) : state.loading ? (
        <p className="px-4 py-8 text-zinc-600 sm:px-6 dark:text-zinc-400">Loading your numbers</p>
      ) : null}

      <OrderDetails />
    </div>
  );
}

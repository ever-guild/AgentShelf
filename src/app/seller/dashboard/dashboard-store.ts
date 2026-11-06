import { useSyncExternalStore } from "react";

import type {
  DashboardBookings,
  DashboardDemand,
  DashboardOrder,
  DashboardOrders,
  DashboardPayments,
} from "@/server/contracts/seller-dashboard";

// What the page knows about its four datasets, shared with the widgets. Studio mounts widgets in
// its own tree and keeps their rows in its data engine, so the rows reach them through Studio and
// only the state around the rows comes through here: whether a dataset has loaded or failed.

export const DATASET_NAMES = ["orders", "payments", "bookings", "demand"] as const;
export type DatasetName = (typeof DATASET_NAMES)[number];

export type Datasets = {
  orders: DashboardOrders | null;
  payments: DashboardPayments | null;
  bookings: DashboardBookings | null;
  demand: DashboardDemand | null;
};

export type DashboardState = {
  data: Datasets;
  // Datasets whose last request failed. What they last answered stays up.
  failed: readonly DatasetName[];
  loading: boolean;
  // The server's clock when the last full refresh was read, and the time to show for it.
  refreshedAt: string | null;
  // The server's clock as the page estimates it, moved along by a timer. A hold ends at its exact
  // instant, even if the next refresh has not arrived, and a wrong clock on the seller's computer
  // does not end one early.
  serverNow: number;
  // The order the seller opened from the grid.
  openOrder: DashboardOrder | null;
};

export const EMPTY_STATE: DashboardState = {
  data: { orders: null, payments: null, bookings: null, demand: null },
  failed: [],
  loading: true,
  refreshedAt: null,
  serverNow: 0,
  openOrder: null,
};

let state = EMPTY_STATE;
const listeners = new Set<() => void>();

export function setDashboardState(next: Partial<DashboardState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

export function resetDashboardState() {
  state = EMPTY_STATE;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDashboardState(): DashboardState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY_STATE,
  );
}

export function openOrderDetails(orderId: string) {
  const order = state.data.orders?.orders.find((row) => row.orderId === orderId) ?? null;
  setDashboardState({ openOrder: order });
}

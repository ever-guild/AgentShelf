"use client";

import dynamic from "next/dynamic";

// Studio only runs in a browser, and the page's period and layout live in the browser too, so the
// whole dashboard starts there.
export const DashboardLoader = dynamic(() => import("./dashboard-board"), {
  ssr: false,
  loading: () => <p className="px-4 py-8 text-zinc-600 sm:px-6 dark:text-zinc-400">Loading your dashboard</p>,
});

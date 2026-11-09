import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { currentSellerOrSignIn } from "@/server/auth/current-seller";
import { scheduleDate } from "@/server/contracts/seller-schedule";
import { getDb } from "@/server/db";
import { getSellerSchedule } from "@/server/services/seller-schedule";
import { techniciansWithoutHours } from "@/server/services/seller-technicians";

import { SellerHeader } from "../seller-header";
import { ScheduleBoard } from "./schedule-board";

export const metadata: Metadata = {
  title: "Schedule | AgentShelf",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<{ date?: string | string[] }>;

async function Schedule({ searchParams }: { searchParams: SearchParams }) {
  const shop = await currentSellerOrSignIn();
  const { date } = await searchParams;
  // A date the schedule cannot show goes to today, so the page's polling only ever asks for a day
  // that exists.
  if (date !== undefined && !scheduleDate.safeParse(date).success) {
    redirect("/seller/schedule");
  }
  const [view, [waiting]] = await Promise.all([
    getSellerSchedule(getDb(), shop, date ? { date } : {}),
    techniciansWithoutHours(getDb(), shop),
  ]);
  return (
    <>
      <SellerHeader shopName={shop.name} />
      <ScheduleBoard initial={view} waiting={waiting ?? null} />
    </>
  );
}

export default function SchedulePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="flex flex-1 flex-col">
      <Suspense
        fallback={
          <p className="mx-auto w-full max-w-7xl px-4 py-8 text-zinc-600 sm:px-6 dark:text-zinc-400">
            Loading your schedule
          </p>
        }
      >
        <Schedule searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

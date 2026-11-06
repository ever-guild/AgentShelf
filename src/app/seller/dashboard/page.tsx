import type { Metadata } from "next";
import { Suspense } from "react";

import { currentSellerOrSignIn } from "@/server/auth/current-seller";

import { SellerHeader } from "../seller-header";
import { DashboardLoader } from "./dashboard-loader";

export const metadata: Metadata = {
  title: "Dashboard | AgentShelf",
  robots: { index: false, follow: false },
};

async function Dashboard() {
  const shop = await currentSellerOrSignIn();
  // AG Studio checks its licence in the browser, so this key reaches the browser by design. With no
  // key Studio still runs, and shows its trial watermark.
  const licenseKey = process.env.AG_STUDIO || undefined;
  return (
    <>
      <SellerHeader shopName={shop.name} />
      <DashboardLoader shopId={shop.id} licenseKey={licenseKey} currency={shop.currency} />
    </>
  );
}

export default function DashboardPage() {
  return (
    <main className="flex flex-1 flex-col">
      <Suspense fallback={<p className="px-6 py-8 text-zinc-600 dark:text-zinc-400">Loading your dashboard</p>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}

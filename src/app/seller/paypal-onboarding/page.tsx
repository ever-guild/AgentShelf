import type { Metadata } from "next";
import { Suspense } from "react";

import { paypalLoginErrorMessage } from "./messages";
import { PayPalOnboarding } from "./paypal-onboarding";

export const metadata: Metadata = {
  title: "Sign in with PayPal Sandbox | AgentShelf",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<{ error?: string | string[] }>;

async function PayPalOnboardingContent({ searchParams }: { searchParams: SearchParams }) {
  const { error } = await searchParams;

  return <PayPalOnboarding initialMessage={paypalLoginErrorMessage(error)} />;
}

export default function PayPalOnboardingPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<main className="mx-auto flex w-full max-w-xl flex-1 items-center px-4 py-10 sm:px-8"><p className="text-sm text-zinc-600 dark:text-zinc-400">Loading seller access</p></main>}>
      <PayPalOnboardingContent searchParams={searchParams} />
    </Suspense>
  );
}

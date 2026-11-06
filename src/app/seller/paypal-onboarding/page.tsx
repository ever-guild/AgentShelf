import type { Metadata } from "next";

import { paypalLoginErrorMessage } from "./messages";
import { PayPalOnboarding } from "./paypal-onboarding";

export const metadata: Metadata = {
  title: "Sign in with PayPal Sandbox | AgentShelf",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<{ error?: string | string[] }>;

export default async function PayPalOnboardingPage({ searchParams }: { searchParams: SearchParams }) {
  const { error } = await searchParams;

  return <PayPalOnboarding initialMessage={paypalLoginErrorMessage(error)} />;
}

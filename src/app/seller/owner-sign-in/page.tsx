import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { IdentityForm } from "../identity/identity-form";
import { paypalLoginErrorMessage } from "../paypal-onboarding/messages";
import { PayPalLoginButton } from "../../paypal-login-button";

export const metadata: Metadata = {
  title: "Owner sign in | AgentShelf",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<{ error?: string | string[] }>;

async function PayPalLoginNotice({ searchParams }: { searchParams: SearchParams }) {
  const { error } = await searchParams;
  const paypalError = paypalLoginErrorMessage(error);
  if (!paypalError) return null;
  return <p role="status" className="rounded-lg bg-zinc-100 p-4 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{paypalError}</p>;
}

export default function OwnerSignInPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <header className="px-4 pt-6 sm:px-8 lg:px-12">
        <Link href="/" className="font-medium">AgentShelf</Link>
      </header>
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Owner account</p>
          <h1 className="text-3xl font-medium tracking-tight">Continue with PayPal</h1>
          <p className="text-pretty text-zinc-600 dark:text-zinc-400">Use your PayPal Sandbox account. Your AgentShelf account is created on your first sign-in.</p>
        </div>
        <Suspense fallback={null}><PayPalLoginNotice searchParams={searchParams} /></Suspense>
        <PayPalLoginButton />
        <details className="group rounded-lg border border-zinc-200 px-4 dark:border-zinc-800">
          <summary className="cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            Other sign-in options
          </summary>
          <div className="flex flex-col gap-4 border-t border-zinc-200 py-4 dark:border-zinc-800">
            <IdentityForm mode="sign-in" />
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Need an owner account? <Link href="/seller/register" className="font-medium text-foreground underline underline-offset-4">Register</Link>
            </p>
            <Link href="/seller/sign-in" className="w-fit text-sm underline underline-offset-4">Use existing shop access</Link>
          </div>
        </details>
      </main>
    </>
  );
}

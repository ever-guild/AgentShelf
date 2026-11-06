import type { Metadata } from "next";

import { OwnerNav } from "../identity/owner-nav";
import { PayPalConnection } from "./paypal-connection";

export const metadata: Metadata = {
  title: "PayPal Sandbox connection | AgentShelf",
  robots: { index: false, follow: false },
};

export default function PayPalConnectionPage() {
  return (
    <>
      <OwnerNav />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-8">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Owner account</p>
          <h1 className="text-3xl font-medium tracking-tight">Connect PayPal Sandbox</h1>
          <p className="max-w-2xl text-pretty text-zinc-600 dark:text-zinc-400">
            Let a shop receive payments through its own PayPal Sandbox account. You approve the connection on PayPal; AgentShelf never asks for your PayPal password.
          </p>
        </div>
        <PayPalConnection />
      </main>
    </>
  );
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Back from PayPal | AgentShelf",
  robots: { index: false, follow: false },
};

// PayPal sends the buyer here after approval. Arriving proves nothing, so this page changes no
// state and never says an order is paid.
export default function CheckoutReturnPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">
        You are back from PayPal
      </h1>
      <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
        This page does not confirm a payment. An order counts as paid only once
        AgentShelf has verified it with PayPal. You can close this tab.
      </p>
    </main>
  );
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Checkout cancelled | AgentShelf",
  robots: { index: false, follow: false },
};

export default function CheckoutCancelPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">
        Checkout cancelled
      </h1>
      <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
        If you left PayPal without approving, nothing was charged. You can close
        this tab, or ask your assistant to start again.
      </p>
    </main>
  );
}

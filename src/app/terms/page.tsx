import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "User agreement | AgentShelf",
  description: "Practical rules for using the AgentShelf PayPal Sandbox hackathon prototype.",
};

const quiet = "text-zinc-600 dark:text-zinc-400";

export default function TermsPage() {
  return (
    <>
      <header className="px-4 pt-6 sm:px-8 lg:px-12">
        <Link href="/" className="font-medium">AgentShelf</Link>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-medium tracking-tight">User agreement</h1>
          <p className={quiet}>AgentShelf PayPal Sandbox demo · Updated November 8, 2026</p>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">A Sandbox demo</h2>
          <p className={quiet}>
            AgentShelf is an experimental prototype for testing shop catalogs and assistant workflows. PayPal use is limited to Sandbox accounts; the demo does not take live payments or promise real order fulfilment. PayPal sign-in does not connect a shop for payments: an owner must separately review and approve that connection on PayPal, and a buyer confirms any Sandbox payment there.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Content and assistant access</h2>
          <p className={quiet}>
            Submit only content you own or are allowed to use. Do not upload sensitive customer information. Published shop profiles and catalogs are public. AI output is a draft and can be wrong; review it before publishing or using it to make a decision. Only give an assistant the permissions it needs, and keep its access credential private.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Using the prototype</h2>
          <p className={quiet}>
            Do not attempt to access another owner&rsquo;s data, bypass permissions, or disrupt the service. Keep your account and assistant credentials secure. The demo may change or be unavailable, and demo data is not guaranteed to persist. To ask about deletion, contact the maintainers through <a href="https://github.com/ever-guild/AgentShelf/issues" className="underline underline-offset-4">GitHub issues</a> without posting personal details or credentials. PayPal and connected services have their own terms. If these conditions do not work for you, do not use the demo.
          </p>
        </section>

        <nav aria-label="Policy links" className={`flex flex-wrap gap-x-5 gap-y-2 border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800 ${quiet}`}>
          <Link href="/privacy" className="underline underline-offset-4">Privacy policy</Link>
          <Link href="/" className="underline underline-offset-4">Back to AgentShelf</Link>
        </nav>
      </main>
    </>
  );
}

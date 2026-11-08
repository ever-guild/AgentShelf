import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy policy | AgentShelf",
  description: "What the AgentShelf Sandbox demo processes and how to contact its maintainers about your data.",
};

const quiet = "text-zinc-600 dark:text-zinc-400";

export default function PrivacyPage() {
  return (
    <>
      <header className="px-4 pt-6 sm:px-8 lg:px-12">
        <Link href="/" className="font-medium">AgentShelf</Link>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-medium tracking-tight">Privacy policy</h1>
          <p className={quiet}>AgentShelf PayPal Sandbox demo · Updated November 8, 2026</p>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Information the demo handles</h2>
          <p className={quiet}>
            Owner sign-in uses profile information returned by PayPal, such as a display name or email, and session cookies. Shop use may involve shop details, price-list uploads, catalog entries, booking and order details, search queries, filters and results, and permissions given to an assistant. Published shop profiles, catalogs, available appointment times, and staff names are public and may be read by visitors and connected agents. Search activity may be recorded to show shop owners what people looked for.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Services and AI processing</h2>
          <p className={quiet}>
            Render hosts the application and its database. When you use an AI feature, the relevant content may be sent to Anthropic for processing; this can include a price-list photo, catalog text, or search terms. PayPal handles PayPal sign-in, seller approval, and buyer payment. AgentShelf does not ask for PayPal passwords or payment-card details.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Use and requests</h2>
          <p className={quiet}>
            Submit only uploads you are allowed to use; do not include sensitive customer information. Session cookies are needed to keep owner and seller sessions working. Demo availability and data are not guaranteed. For access or deletion requests, open an issue in the <a href="https://github.com/ever-guild/AgentShelf/issues" className="underline underline-offset-4">public repository</a>. Do not put personal details, passwords, authorization codes, or agent credentials in a public issue.
          </p>
        </section>

        <nav aria-label="Policy links" className={`flex flex-wrap gap-x-5 gap-y-2 border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800 ${quiet}`}>
          <Link href="/terms" className="underline underline-offset-4">User agreement</Link>
          <Link href="/" className="underline underline-offset-4">Back to AgentShelf</Link>
        </nav>
      </main>
    </>
  );
}

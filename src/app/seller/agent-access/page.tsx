import type { Metadata } from "next";

import { OwnerNav } from "../identity/owner-nav";
import { AgentAccessManager } from "./agent-access-manager";

export const metadata: Metadata = {
  title: "Agent access | AgentShelf",
  robots: { index: false, follow: false },
};

export default function AgentAccessPage() {
  return (
    <>
      <OwnerNav />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-8">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Owner account</p>
          <h1 className="text-3xl font-medium tracking-tight">Agent access</h1>
          <p className="max-w-2xl text-pretty text-zinc-600 dark:text-zinc-400">
            Review the permissions before issuing a short-lived credential. The assistant cannot approve its own access.
          </p>
        </div>
        <AgentAccessManager />
      </main>
    </>
  );
}

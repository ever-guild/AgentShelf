import type { Metadata } from "next";
import Link from "next/link";

import { IdentityForm } from "../identity/identity-form";

export const metadata: Metadata = {
  title: "Owner sign in | AgentShelf",
  robots: { index: false, follow: false },
};

export default function OwnerSignInPage() {
  return (
    <>
      <header className="px-4 pt-6 sm:px-8 lg:px-12">
        <Link href="/" className="font-medium">AgentShelf</Link>
      </header>
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Owner account</p>
          <h1 className="text-3xl font-medium tracking-tight">Sign in to AgentShelf</h1>
          <p className="text-pretty text-zinc-600 dark:text-zinc-400">Manage your shop access and the assistants you authorize.</p>
        </div>
        <IdentityForm mode="sign-in" />
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Need an owner account? <Link href="/seller/register" className="font-medium text-foreground underline underline-offset-4">Register</Link>
        </p>
      </main>
    </>
  );
}

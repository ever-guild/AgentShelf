import type { Metadata } from "next";
import Link from "next/link";

import { IdentityForm } from "../identity/identity-form";

export const metadata: Metadata = {
  title: "Register your shop | AgentShelf",
  robots: { index: false, follow: false },
};

export default function SellerRegistrationPage() {
  return (
    <>
      <header className="px-4 pt-6 sm:px-8 lg:px-12">
        <Link href="/" className="font-medium">AgentShelf</Link>
      </header>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-4 py-12">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Owner account</p>
          <h1 className="text-3xl font-medium tracking-tight">Bring your shop online for assistants</h1>
          <p className="max-w-lg text-pretty text-zinc-600 dark:text-zinc-400">
            Create an owner account, then add a shop yourself or give your agent a short-lived permission to create one.
          </p>
        </div>
        <IdentityForm mode="register" />
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Already registered? <Link href="/seller/owner-sign-in" className="font-medium text-foreground underline underline-offset-4">Sign in</Link>
        </p>
      </main>
    </>
  );
}

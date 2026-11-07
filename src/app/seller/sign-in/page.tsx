import type { Metadata } from "next";
import Link from "next/link";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in | AgentShelf",
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  return (
    <>
      <header className="px-4 pt-6 sm:px-8 lg:px-12">
        <Link href="/" className="font-medium">
          AgentShelf
        </Link>
      </header>
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-medium text-balance">Sign in to your shop</h1>
          <p className="text-pretty text-zinc-600 dark:text-zinc-400">
            Use the shop name and access code you were given. Inside are your price lists, catalog,
            schedule and what people searched for and did not find.
          </p>
        </div>
        <SignInForm />
      </main>
    </>
  );
}

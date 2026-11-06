import type { Metadata } from "next";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in | AgentShelf",
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Sign in to your shop</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Use the shop name and access code you were given.
        </p>
      </div>
      <SignInForm />
    </main>
  );
}

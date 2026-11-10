import Link from "next/link";

// One line on a seller screen saying that the same work can be asked of the owner's own assistant.
// The words in ink are an example of what the owner would say.
export function AssistantHint({ ask }: { ask: string }) {
  return (
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      Or ask your assistant, for example <span className="text-ink">{ask}</span>.{" "}
      <Link href="/seller/assistant" className="underline underline-offset-4 transition-colors hover:text-ink">
        How to connect it
      </Link>
    </p>
  );
}

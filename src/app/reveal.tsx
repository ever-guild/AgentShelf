"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Plays a section's entrance once, when the reader scrolls to it. A section that is already on
// screen, a reader who asked for reduced motion and a page without scripts all keep the resting
// style, which is the finished section. The attribute is set on the node itself, because it is an
// enhancement the first render must not know about.
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    if (node.getBoundingClientRect().top < window.innerHeight) {
      return;
    }
    node.dataset.reveal = "pending";
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          node.dataset.reveal = "play";
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

// Starts the opening scene again. A new key remounts the scene, and its styles play from the start.
export function Replay({ children, caption }: { children: ReactNode; caption: string }) {
  const [run, setRun] = useState(0);

  return (
    <>
      <div key={run}>{children}</div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-sm text-zinc-400">
        <p>{caption}</p>
        <button
          type="button"
          onClick={() => setRun((current) => current + 1)}
          className="min-h-11 font-medium text-zinc-50 underline underline-offset-4 transition-colors hover:text-zinc-300"
        >
          Play again
        </button>
      </div>
    </>
  );
}

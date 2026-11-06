import type { Metadata } from "next";
import type { ReactNode } from "react";

// A seller's work is private and has no use in a search engine.
export const metadata: Metadata = {
  title: "Seller | AgentShelf",
  robots: { index: false, follow: false },
};

export default function SellerLayout({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col">{children}</div>;
}

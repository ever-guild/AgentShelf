import { SandboxNotice } from "./sandbox-notice";

export default function ShopsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SandboxNotice />
      <main className="flex flex-1 flex-col">{children}</main>
    </>
  );
}

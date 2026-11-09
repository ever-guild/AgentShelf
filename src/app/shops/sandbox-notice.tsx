// Shown above every public page, including the ones where no shop could be found, so it speaks for
// the whole service rather than for one shop.
export function SandboxNotice() {
  return (
    <div className="border-b border-zinc-200">
      <p className="mx-auto w-full max-w-3xl px-4 py-2 text-sm text-pretty sm:px-6">
        <span className="font-medium text-doubt">PayPal sandbox.</span> Every payment here is a test
        payment, and no real money moves.
      </p>
    </div>
  );
}

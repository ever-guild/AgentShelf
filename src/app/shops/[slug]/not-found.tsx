export default function ShopNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-2 px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">We cannot find that</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        This shop or product is not on sale here. Check the link you were given, or ask the shop for
        a new one.
      </p>
    </div>
  );
}

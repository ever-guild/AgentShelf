// Runs once when a server process starts.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.DATABASE_URL) {
    const { startOrderSweep } = await import("./server/services/order-sweep");
    const { startImportSweep } = await import("./server/services/import-sweep");
    const { startSearchIndexSweep } = await import("./server/services/search-index");
    startOrderSweep();
    startImportSweep();
    startSearchIndexSweep();
  }
}

export type InventoryAvailability = {
  mode: string | null;
  onHand: number | null;
  reserved: number | null;
};

/**
 * The legacy product flag still applies to every listing. Physical products additionally need an
 * explicit stock policy before buyers should see them as purchasable; services remain separate.
 */
export function effectiveProductAvailability(
  kind: "product" | "service",
  availability: "available" | "unavailable",
  inventory: InventoryAvailability,
): "available" | "unavailable" {
  if (kind === "service" || availability === "unavailable") return availability;
  if (inventory.mode === "untracked") return "available";
  if (inventory.mode !== "tracked" || inventory.onHand === null || inventory.reserved === null) {
    return "unavailable";
  }
  return inventory.onHand - inventory.reserved > 0 ? "available" : "unavailable";
}

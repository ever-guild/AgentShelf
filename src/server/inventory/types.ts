export type InventoryMode = "tracked" | "untracked";
export type ReservationState = "reserved" | "committed" | "released" | "review_required";

export type StockLevel = Readonly<{
  productId: string;
  mode: InventoryMode;
  onHand: number | null;
  reserved: number | null;
  available: number | null;
  version: number;
}>;

export type ReservationLine = Readonly<{ productId: string; quantity: number }>;
export type Reservation = Readonly<{
  id: string;
  shopId: string;
  idempotencyKey: string;
  state: ReservationState;
  expiresAt: Date;
  lines: readonly ReservationLine[];
}>;

export type InventoryPrincipal = Readonly<{ shopId: string; actorId: string }>;

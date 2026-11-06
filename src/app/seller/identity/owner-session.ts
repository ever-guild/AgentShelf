export type OwnerShop = {
  id: string;
  slug: string;
  name: string;
  location: string;
  currency: "EUR";
  timezone: string;
};

export type OwnerSession = {
  owner: { ownerId: string; username: string };
  shops: OwnerShop[];
  selectedShopId: string | null;
};

export async function readOwnerSession(): Promise<OwnerSession> {
  const response = await fetch("/api/seller/identity/me", { cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 401 ? "UNAUTHORIZED" : "LOAD_FAILED");
  return (await response.json()) as OwnerSession;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && error.message === "UNAUTHORIZED";
}

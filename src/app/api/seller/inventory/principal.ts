import type { SellerShopPrincipal } from "@/server/contracts/seller-identity";
import { currentSeller } from "@/server/auth/current-seller";
import {
  currentOwnerShopPrincipal,
  hasOwnerSessionCookie,
} from "@/server/seller-identity/http-auth";

/**
 * Resolve the shop through the canonical seller-session boundary. Owner sessions retain the
 * real owner actor for audit; a legacy access-code session has no individual identity, so its
 * shop ID is the stable shop-session actor (not an owner ID).
 */
export async function currentInventoryPrincipal(request: Request): Promise<SellerShopPrincipal> {
  const seller = await currentSeller(request);
  if (await hasOwnerSessionCookie(request)) {
    return currentOwnerShopPrincipal(request, seller.id);
  }
  return { shopId: seller.id, actorId: seller.id };
}

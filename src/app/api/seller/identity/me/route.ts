import {
  clearSelectedOwnerShopCookie,
  currentOwner,
  currentOwnerShopPrincipal,
  currentOwnerShops,
  identityErrorResponse,
  identityJsonResponse,
  ownerCookieValue,
  OWNER_SELECTED_SHOP_COOKIE,
} from "@/server/seller-identity/http-auth";
import { IdentityError } from "@/server/seller-identity/service";
import { ownerIdentityRuntime } from "@/server/seller-identity/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const owner = await currentOwner(request);
    const { store } = ownerIdentityRuntime();
    const profile = await store.findOwnerById(owner.ownerId);
    if (!profile) throw new IdentityError("UNAUTHORIZED", "Sign in to continue.");
    const paypalProfile = await store.findPayPalProfileByOwnerId(owner.ownerId);
    const shops = await currentOwnerShops(owner);
    const storedSelection = await ownerCookieValue(OWNER_SELECTED_SHOP_COOKIE, request);
    let selectedShopId: string | null = null;
    let clearSelection = false;
    if (storedSelection) {
      try {
        const principal = await currentOwnerShopPrincipal(request, storedSelection);
        selectedShopId = principal.shopId;
      } catch (error) {
        if (error instanceof IdentityError && error.code === "UNAUTHORIZED") {
          clearSelection = true;
        } else {
          throw error;
        }
      }
    }
    return identityJsonResponse(
      { owner: { ...profile, paypalProfile }, shops, selectedShopId },
      200,
      clearSelection ? [clearSelectedOwnerShopCookie()] : [],
    );
  } catch (error) {
    return identityErrorResponse(error);
  }
}

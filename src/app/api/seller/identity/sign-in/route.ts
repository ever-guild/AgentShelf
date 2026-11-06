import { ownerSignInInput } from "@/server/contracts/seller-identity";
import {
  clearSelectedOwnerShopCookie,
  clearLegacySellerSessionCookie,
  currentOwnerShops,
  identityErrorResponse,
  identityJsonResponse,
  ownerCookieValue,
  ownerSessionCookie,
  OWNER_SELECTED_SHOP_COOKIE,
  OWNER_SESSION_COOKIE,
  parseJsonBody,
  requireSameOriginJson,
  selectedOwnerShopCookie,
} from "@/server/seller-identity/http-auth";
import { ownerIdentityRuntime } from "@/server/seller-identity/runtime";
import {
  IdentityError,
  requireOwnerShop,
  signInOwner,
  signOutOwner,
} from "@/server/seller-identity/service";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOriginJson(request);
    const parsed = ownerSignInInput.safeParse(await parseJsonBody(request));
    if (!parsed.success) throw new IdentityError("INVALID_INPUT", "The request is not valid.");
    const { store, limiter } = ownerIdentityRuntime();
    const previousSession = await ownerCookieValue(OWNER_SESSION_COOKIE, request);
    const result = await signInOwner(store, limiter, parsed.data, "owner-sign-in-global");
    const owner = { ownerId: result.owner.id, expiresAt: result.expiresAt };
    const shops = await currentOwnerShops(owner);
    let selectedShopId: string | null = null;
    let clearSelection = false;
    const previousSelection = await ownerCookieValue(OWNER_SELECTED_SHOP_COOKIE, request);
    if (previousSelection) {
      try {
        await requireOwnerShop(store, owner, previousSelection);
        selectedShopId = previousSelection;
      } catch (error) {
        if (error instanceof IdentityError && error.code === "UNAUTHORIZED") {
          clearSelection = true;
        } else {
          throw error;
        }
      }
    }
    if (!selectedShopId && shops.length === 1) selectedShopId = shops[0].id;
    if (previousSession) await signOutOwner(store, previousSession);

    const cookies = [ownerSessionCookie(result.sessionToken, result.expiresAt), clearLegacySellerSessionCookie()];
    if (selectedShopId) {
      cookies.push(selectedOwnerShopCookie(selectedShopId, result.expiresAt));
    } else if (clearSelection || previousSelection) {
      cookies.push(clearSelectedOwnerShopCookie());
    }
    return identityJsonResponse({ owner: result.owner, shops, selectedShopId }, 200, cookies);
  } catch (error) {
    return identityErrorResponse(error);
  }
}

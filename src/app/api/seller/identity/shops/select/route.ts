import { ownerShopSelectionInput } from "@/server/contracts/seller-identity";
import {
  currentOwner,
  identityErrorResponse,
  identityJsonResponse,
  ownerShopResponse,
  parseJsonBody,
  requireSameOriginJson,
  selectedOwnerShopCookie,
} from "@/server/seller-identity/http-auth";
import { ownerIdentityRuntime } from "@/server/seller-identity/runtime";
import { IdentityError, requireOwnerShop } from "@/server/seller-identity/service";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOriginJson(request);
    const owner = await currentOwner(request);
    const parsed = ownerShopSelectionInput.safeParse(await parseJsonBody(request));
    if (!parsed.success) throw new IdentityError("INVALID_INPUT", "The request is not valid.");
    const shop = await requireOwnerShop(ownerIdentityRuntime().store, owner, parsed.data.shopId);
    return identityJsonResponse(
      { shop: ownerShopResponse(shop), selectedShopId: shop.id },
      200,
      [selectedOwnerShopCookie(shop.id, owner.expiresAt)],
    );
  } catch (error) {
    return identityErrorResponse(error);
  }
}

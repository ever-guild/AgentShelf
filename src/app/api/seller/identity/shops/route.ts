import { ownerCreateShopInput } from "@/server/contracts/seller-identity";
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
import { createOwnedShop, IdentityError } from "@/server/seller-identity/service";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOriginJson(request);
    const owner = await currentOwner(request);
    const { store, limiter } = ownerIdentityRuntime();
    if (!(await limiter.consume(`owner-create-shop:${owner.ownerId}`, 10, 60 * 60_000, new Date()))) {
      throw new IdentityError("RATE_LIMITED", "Please try again later.");
    }
    const parsed = ownerCreateShopInput.safeParse(await parseJsonBody(request));
    if (!parsed.success) throw new IdentityError("INVALID_INPUT", "The request is not valid.");
    const result = await createOwnedShop(store, owner, parsed.data);
    return identityJsonResponse(
      { shop: ownerShopResponse(result.shop), paymentStatus: result.paymentStatus },
      201,
      [selectedOwnerShopCookie(result.shop.id, owner.expiresAt)],
    );
  } catch (error) {
    return identityErrorResponse(error);
  }
}

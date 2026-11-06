import {
  ownerRegistrationRequestInput,
  type AuthenticatedOwner,
} from "@/server/contracts/seller-identity";
import {
  identityErrorResponse,
  identityJsonResponse,
  ownerSessionCookie,
  OWNER_SELECTED_SHOP_COOKIE,
  ownerCookieValue,
  requireSameOriginJson,
  selectedOwnerShopCookie,
  clearSelectedOwnerShopCookie,
  parseJsonBody,
} from "@/server/seller-identity/http-auth";
import { ownerIdentityRuntime } from "@/server/seller-identity/runtime";
import {
  IdentityError,
  listOwnerShops,
  registerOwner,
  registerOwnerAndShop,
} from "@/server/seller-identity/service";

function safeShop(shop: {
  id: string;
  name: string;
  slug: string;
  location: string;
  currency: "EUR";
  timezone: string;
}) {
  return {
    id: shop.id,
    name: shop.name,
    slug: shop.slug,
    location: shop.location,
    currency: shop.currency,
    timezone: shop.timezone,
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOriginJson(request);
    const parsed = ownerRegistrationRequestInput.safeParse(await parseJsonBody(request));
    if (!parsed.success) {
      throw new IdentityError("INVALID_INPUT", "The request is not valid.");
    }
    const { store, limiter } = ownerIdentityRuntime();
    const { shop, ...ownerInput } = parsed.data;
    let owner: { id: string; username: string };
    let sessionToken: string;
    let expiresAt: Date;
    let selectedShopId: string | null = null;
    if (shop) {
      const result = await registerOwnerAndShop(store, limiter, { ...ownerInput, shop }, "owner-registration-global");
      owner = result.owner;
      sessionToken = result.sessionToken;
      expiresAt = result.expiresAt;
      selectedShopId = result.shop.id;
    } else {
      const result = await registerOwner(store, limiter, ownerInput, "owner-registration-global");
      owner = result.owner;
      sessionToken = result.sessionToken;
      expiresAt = result.expiresAt;
    }
    const ownerContext: AuthenticatedOwner = { ownerId: owner.id, expiresAt };
    const shops = (await listOwnerShops(store, ownerContext)).map(safeShop);
    const cookies = [ownerSessionCookie(sessionToken, expiresAt)];
    if (selectedShopId) {
      cookies.push(selectedOwnerShopCookie(selectedShopId, expiresAt));
    } else {
      const selected = await ownerCookieValue(OWNER_SELECTED_SHOP_COOKIE, request);
      if (selected) cookies.push(clearSelectedOwnerShopCookie());
    }
    return identityJsonResponse({
      owner,
      shops,
      selectedShopId,
    }, 201, cookies);
  } catch (error) {
    return identityErrorResponse(error);
  }
}

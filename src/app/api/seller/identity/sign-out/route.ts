import {
  clearOwnerCookies,
  clearLegacySellerSessionCookie,
  identityErrorResponse,
  identityNoContentResponse,
  ownerCookieValue,
  OWNER_SESSION_COOKIE,
  requireSameOriginJson,
} from "@/server/seller-identity/http-auth";
import { ownerIdentityRuntime } from "@/server/seller-identity/runtime";
import { signOutOwner } from "@/server/seller-identity/service";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOriginJson(request);
    const token = await ownerCookieValue(OWNER_SESSION_COOKIE, request);
    if (token) await signOutOwner(ownerIdentityRuntime().store, token);
    return identityNoContentResponse([...clearOwnerCookies(), clearLegacySellerSessionCookie()]);
  } catch (error) {
    return identityErrorResponse(error);
  }
}

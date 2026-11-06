import { ownerAgentGrantInput } from "@/server/contracts/seller-identity";
import {
  currentOwner,
  identityErrorResponse,
  identityJsonResponse,
  parseJsonBody,
  requireSameOriginJson,
} from "@/server/seller-identity/http-auth";
import { ownerIdentityRuntime } from "@/server/seller-identity/runtime";
import { authorizeSellerAgent, IdentityError } from "@/server/seller-identity/service";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOriginJson(request);
    const owner = await currentOwner(request);
    const { store, limiter } = ownerIdentityRuntime();
    const now = new Date();
    if (!(await limiter.consume(`owner-agent-grant:${owner.ownerId}`, 20, 60 * 60_000, now))) {
      throw new IdentityError("RATE_LIMITED", "Please try again later.");
    }
    const parsed = ownerAgentGrantInput.safeParse(await parseJsonBody(request));
    if (!parsed.success) throw new IdentityError("INVALID_INPUT", "The request is not valid.");
    const grant = await authorizeSellerAgent(
      store,
      owner,
      parsed.data.shopId,
      parsed.data.scopes,
      now,
      parsed.data.shareDataConsent === true,
    );
    return identityJsonResponse({
      grantToken: grant.grantToken,
      shopId: grant.shopId,
      scopes: grant.scopes,
      expiresAt: grant.expiresAt.toISOString(),
    }, 201);
  } catch (error) {
    return identityErrorResponse(error);
  }
}

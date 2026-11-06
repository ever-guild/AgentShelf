import { ownerAgentGrantRevokeInput } from "@/server/contracts/seller-identity";
import {
  currentOwner,
  identityErrorResponse,
  identityNoContentResponse,
  parseJsonBody,
  requireSameOriginJson,
} from "@/server/seller-identity/http-auth";
import { ownerIdentityRuntime } from "@/server/seller-identity/runtime";
import { IdentityError, revokeSellerAgent } from "@/server/seller-identity/service";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOriginJson(request);
    const owner = await currentOwner(request);
    const { store, limiter } = ownerIdentityRuntime();
    const now = new Date();
    if (!(await limiter.consume(`owner-agent-grant-revoke:${owner.ownerId}`, 30, 60 * 60_000, now))) {
      throw new IdentityError("RATE_LIMITED", "Please try again later.");
    }
    const parsed = ownerAgentGrantRevokeInput.safeParse(await parseJsonBody(request));
    if (!parsed.success) throw new IdentityError("INVALID_INPUT", "The request is not valid.");
    await revokeSellerAgent(store, owner, parsed.data.grantToken, now);
    return identityNoContentResponse();
  } catch (error) {
    return identityErrorResponse(error);
  }
}

import "server-only";

import { IdentityError } from "../seller-identity/service";
import { errorResponse } from "../http";
import { InventoryError } from "./postgres";

const IDENTITY_STATUS: Record<IdentityError["code"], number> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  REGISTRATION_CONFLICT: 409,
  SHOP_SLUG_UNAVAILABLE: 409,
  AGENT_AUTHORIZATION_REQUIRED: 401,
};

const INVENTORY_STATUS: Record<InventoryError["code"], number> = {
  INVALID: 400,
  NOT_FOUND: 404,
  INSUFFICIENT: 409,
  CONFLICT: 409,
  REVIEW_REQUIRED: 409,
};

export function inventoryHttpErrorResponse(error: unknown): Response {
  if (error instanceof IdentityError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: IDENTITY_STATUS[error.code] },
    );
  }
  if (error instanceof InventoryError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: INVENTORY_STATUS[error.code] },
    );
  }
  return errorResponse(error);
}

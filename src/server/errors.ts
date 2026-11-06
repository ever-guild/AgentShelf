import type { z } from "zod";

// Messages and details are safe to return to a buyer's assistant or a seller. Nothing here
// may carry credentials, merchant identifiers or provider diagnostics.
const HTTP_STATUS = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  SHOP_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  ORDER_STATUS_UNAVAILABLE: 404,
  IMPORT_NOT_FOUND: 404,
  IMPORT_ROW_NOT_FOUND: 404,
  PRODUCT_UNAVAILABLE: 409,
  PRODUCT_REQUIRES_BOOKING: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CHECKOUT_NEEDS_REVIEW: 409,
  IMPORT_NOT_EDITABLE: 409,
  IMPORT_NOT_RETRYABLE: 409,
  IMPORT_FILE_TOO_LARGE: 413,
  IMPORT_FILE_UNSUPPORTED: 415,
  IMPORT_FILE_INVALID: 422,
  IMPORT_ROW_INVALID: 422,
  IMPORT_ROW_BLOCKED: 422,
  IMPORT_REVIEW_INCOMPLETE: 422,
  IMPORT_LIMIT_REACHED: 429,
  IMPORT_NOT_CONFIGURED: 503,
  SUGGESTIONS_UNAVAILABLE: 503,
  MIXED_SHOPS: 422,
  UNSUPPORTED_CURRENCY: 422,
  AMOUNT_OUT_OF_RANGE: 422,
  PAYMENT_DECLINED: 422,
  PAYMENT_NOT_CONFIGURED: 503,
  PAYMENT_UNAVAILABLE: 503,
  PAYMENT_TIMEOUT: 504,
  SERVER_MISCONFIGURED: 500,
} as const;

export type ServiceErrorCode = keyof typeof HTTP_STATUS;

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  raw: unknown,
): z.output<Schema> {
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  // Paths and messages only: the rejected values are not echoed back.
  throw new ServiceError("INVALID_INPUT", "The request is not valid.", {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  });
}

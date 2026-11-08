import { z } from "zod";

const slug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const shopRegistrationInput = z.strictObject({
  name: z.string().trim().min(2).max(120),
  slug,
  location: z.string().trim().min(2).max(160),
  currency: z.literal("EUR"),
  timezone: z.string().trim().min(1).max(80),
});

export const ownerRegistrationInput = z.strictObject({
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(12).max(128),
  shop: shopRegistrationInput,
  idempotencyKey: z.string().uuid(),
});

export const ownerAccountRegistrationInput = z.strictObject({
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(12).max(128),
  idempotencyKey: z.string().uuid(),
});

export const ownerRegistrationRequestInput = z.strictObject({
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(12).max(128),
  idempotencyKey: z.string().uuid(),
  shop: shopRegistrationInput.optional(),
});

export const ownerSignInInput = z.strictObject({
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(1).max(128),
});

export const ownerCreateShopInput = z.strictObject({
  shop: shopRegistrationInput,
  idempotencyKey: z.string().uuid(),
});

export const ownerShopSelectionInput = z.strictObject({ shopId: z.uuid() });
export const ownerAgentGrantInput = z.strictObject({
  shopId: z.uuid().nullable(),
  scopes: z.array(z.enum(["create_shop", "read_shop", "manage_catalog", "manage_inventory", "connect_paypal"])).min(1).max(4),
  shareDataConsent: z.boolean().optional(),
});
export const ownerAgentGrantRevokeInput = z.strictObject({ grantToken: z.string().min(32).max(128) });

export type ShopRegistration = z.infer<typeof shopRegistrationInput>;
export type PayPalLoginProfile = {
  displayName: string | null;
  email: string | null;
  /** PayPal address scope may omit either field; street and other address data are never stored. */
  city: string | null;
  country: string | null;
};
/** Seller MCP `create_shop` input; authorization is supplied out-of-band by server auth. */
export type SellerAgentCreateShopInput = z.infer<typeof ownerCreateShopInput>;
export type SellerAgentCreateShopResult = {
  shop: {
    id: string;
    name: string;
    slug: string;
    location: string;
    currency: "EUR";
    timezone: string;
  };
  paymentStatus: "not_configured";
};

/** Server-authenticated context; never deserialize this from a request body. */
export type AuthenticatedOwner = { ownerId: string; expiresAt: Date };
/** Tenant boundary for seller services after membership has been checked. */
export type SellerShopPrincipal = { actorId: string; shopId: string };
/** Shop principal after owner consent to sharing data with PayPal was validated. */
export type SellerPayPalShopPrincipal = SellerShopPrincipal & {
  shareDataConsent: true;
  shareDataConsentAt: Date;
};
export const SELLER_AGENT_SCOPES = [
  "create_shop",
  "read_shop",
  "manage_catalog",
  "manage_inventory",
  "connect_paypal",
] as const;
export type SellerAgentScope = (typeof SELLER_AGENT_SCOPES)[number];
export type SellerAgentGrantPrincipal = {
  actorId: string;
  shopId: string | null;
  scopes: SellerAgentScope[];
  expiresAt: Date;
  shareDataConsent: boolean;
  shareDataConsentAt: Date | null;
};

# Seller identity module: integration contract

This module defines owner credentials, PayPal Sandbox owner sign-in, revocable owner sessions, owner-to-shop membership and scoped seller-agent grants. Runtime HTTP handlers live at `/api/seller/identity/*` with the PostgreSQL adapter (`0011_identity_registration.sql` and `0014_paypal_owner_identity.sql`), and the owner guard is wired into `currentSeller` while preserving legacy demo access-code sessions when no owner session cookie is present.

## Service boundary

`src/server/seller-identity/service.ts` owns identity behavior; `PostgresIdentityStore` and `PostgresAttemptLimiter` in `postgres-store.ts` implement durable writes through PostgreSQL. `requireOwnerShop` and `listOwnerShops` resolve shops from the owner ID obtained from an authenticated session; routes must not substitute a request-provided owner ID. The in-memory fake in `service.test.ts` is test-only and not a production persistence option.

`PostgresAttemptLimiter` stores shared bounded attempt windows and HMACs limiter keys with `APP_SIGNING_SECRET` (at least 32 characters). Owner sign-in allows 8 attempts per normalized username per 15 minutes; registration allows 5 per normalized username per hour plus a 1000/hour coarse service-wide cap. Routes do not trust caller-provided forwarding headers for rate-limit identity.

Passwords use Node `scrypt` with a random 16-byte salt and parameters `N=16384,r=8,p=1`, encoded as `scrypt$16384$8$1$<salt>$<hash>`. Session and agent bearer tokens are 256-bit random values; only their SHA-256 hashes are stored. Owner sessions expire after 12 hours and are immediately revocable. Agent grants expire after 15 minutes and are revocable by the owner. Owner-level `create_shop` grants authorize one successful shop creation; retries with the same idempotency key replay the result, and a different key is rejected. Shop-scoped grants authorize only the named shop and selected scopes from `read_shop`, `manage_catalog`, `manage_inventory`, and `connect_paypal`. Every management grant requires current owner membership when issued.

The HTTP handlers set the owner session token in an `HttpOnly`, `Secure` in production, `SameSite=Lax` cookie, require JSON plus exact same-origin `Origin` for mutations, cap request bodies, return `Cache-Control: no-store`, and do not log passwords, session tokens or agent grants. The selected-shop cookie is only a selector; the owner session membership check is authoritative. Invalid owner cookies fail closed and never fall through to the legacy seller session. Do not put a bearer grant in an MCP tool argument that can be copied to conversation history; MCP consumes it from the server-side bearer header.

## Registration and MCP contract

`POST /api/seller/identity/register` accepts normalized username, password and UUID idempotency key, with an optional shop profile. Account-only signup supports the owner authorizing a `create_shop` grant before any shop exists. Supplying a shop creates owner, membership and shop in one transaction. A duplicate username or slug fails without attaching the new owner to an existing shop. Store uniqueness constraints, not preflight reads, decide races. A same-key replay also verifies the supplied password before issuing a new session.

`POST /api/seller/identity/sign-in` accepts `{ "username", "password" }`; `POST /api/seller/identity/sign-out` revokes the current owner session; `GET /api/seller/identity/me` returns the sanitized owner profile, owned shops and membership-checked selection. `POST /api/seller/identity/shops` accepts `{ "shop", "idempotencyKey" }`; `POST /api/seller/identity/shops/select` accepts `{ "shopId" }`. The `agentshelf_owner_session` and `agentshelf_owner_shop` cookies are separate from the legacy demo cookie.

`POST /api/seller/identity/agent-grants` accepts `{ "shopId": null | UUID, "scopes": [...] }`. A `null` shop permits only the owner-level `create_shop` scope. Shop-scoped grants permit only `read_shop`, `manage_catalog`, `manage_inventory`, and `connect_paypal` for a shop the owner belongs to. The raw token is returned once as `grantToken`; only its hash is stored and grants are not listable/recoverable. `POST /api/seller/identity/agent-grants/revoke` accepts that raw token and revokes only a grant belonging to the authenticated owner. Grants expire after 15 minutes.

Issuing `connect_paypal` additionally requires the explicit owner field `shareDataConsent: true`; the adapter persists `share_data_consent_at` on that grant, and SQL rejects connect grants without the recorded acknowledgment. The resolver returns `shareDataConsent: true` and the persisted `shareDataConsentAt` only for a valid grant whose consent timestamp exists. A downstream connection record must copy this timestamp rather than minting a new one. Consent is not a tool argument and cannot be added or escalated by the MCP agent.

The external seller MCP should use `SellerAgentCreateShopInput` from `src/server/contracts/seller-identity.ts`:

```json
{
  "shop": {
    "name": "Repair Shop",
    "slug": "repair-shop",
    "location": "Liepaja, Latvia",
    "currency": "EUR",
    "timezone": "Europe/Riga"
  },
  "idempotencyKey": "d3e6de14-0d4e-4726-9190-2c1de1d2e21d"
}
```

The agent does not supply an owner ID, PayPal merchant ID, credentials, price, or payment state. `createShopForAuthorizedAgent` receives the owner-approved grant through server authentication. Without consent it returns `AGENT_AUTHORIZATION_REQUIRED` and the integration-provided human action URL; expired and revoked grants return `UNAUTHORIZED`. The grant can create only one shop for its authenticated owner and only while active; the owner must separately issue a shop-scoped management grant for that new shop.

For later seller-agent actions, `authorizeSellerAgent(store, authenticatedOwner, shopId, scopes)` issues an owner-consented grant. `resolveAuthorizedSellerAgent(store, token, requiredScope, requestedShopId)` returns the shared `{ actorId, shopId }` principal only when the token is active, includes the requested scope, and names exactly the requested shop; the `connect_paypal` overload also returns `shareDataConsent: true` and the original persisted `shareDataConsentAt: Date`. Owner-level grants cannot be used for shop management; shop-scoped grants cannot create shops or cross tenant boundaries. MCP code consumes this resolver and never issues or revokes bearer tokens.

Successful agent creation returns `SellerAgentCreateShopResult` with `paymentStatus: "not_configured"`. Set `shops.paypalCredentialRef` to the safe sentinel `UNCONFIGURED`, keep `paypalMerchantId` null, and do not provision a merchant app or per-shop environment variables. The current `checkout-quote.ts` guard rejects checkout without `paypalMerchantId` using the existing `PAYMENT_NOT_CONFIGURED` error. Catalog preparation remains available.

## Persistence adapter requirements

The adapter must enforce the following in SQL:

- `seller_owners`: unique normalized username and a constrained scrypt hash representation
- `shop_memberships`: primary key `(owner_id, shop_id)`; owner IDs and shop IDs are foreign keys
- `owner_sessions`: token hash, expiry, revocation timestamp; lookup requires `expires_at > now()` and `revoked_at IS NULL`
- `seller_agent_grants`: token hash, nullable shop scope, allowed scope array, expiry and revocation timestamp; management grants reference an owner membership
- `seller_identity_operations`: idempotency key, operation, request fingerprint, owner and resulting shop; same key plus same request replays, changed request conflicts; the in-transaction reservation allows both result IDs to be null before the transaction fills its final result
- `seller_identity_attempt_windows`: hashed limiter key and bounded counter updated atomically

Owner registration and shop creation write the operation row, owner, membership and shop in one transaction. An agent request must validate the grant and perform its idempotency lookup and writes in the same transaction. Unique slug errors must never trigger a second attempt that reuses an existing shop. The identity route suite runs the registered migration journal, including `0011_identity_registration.sql`, against a disposable PostgreSQL database. The lower-level `postgres-store.db.test.ts` also applies the DDL draft to a minimal shops fixture to isolate adapter constraints.

## Runtime integration and verification

- Schema migrations `0011_identity_registration.sql` and `0014_paypal_owner_identity.sql` are registered in the migration journal and applied in production.
- Owner registration, password sign-in, PayPal Sandbox sign-in (`/seller/paypal-onboarding`, `/seller/owner-sign-in`), shop creation/selection (`/seller/shops`, `/seller/shops/new`), and scoped agent grant management (`/seller/agent-access`) route through `currentOwnerShopPrincipal` and `currentSeller`.
- Every seller mutation obtains the shop from membership/session server state, not request input.
- Unconfigured and pending-consent shops remain available in catalog flows while the checkout guard (`resolveShopPayPalRoute` in `src/server/paypal/merchant-eligibility.ts`) rejects payment until a verified `ready` PayPal connection exists.

The HTTP route suite exercises registration, sign-in, sign-out, shop selection, grant issuance, PayPal consent evidence and revocation against an isolated temporary PostgreSQL database with the registered migrations. Legacy seeded shop access-code sessions continue to work alongside owner sessions when demo access codes are configured.

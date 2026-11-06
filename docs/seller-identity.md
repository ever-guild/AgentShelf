# Seller identity module: integration contract

This module defines owner credentials, revocable owner sessions, owner-to-shop membership and scoped seller-agent grants. It includes a PostgreSQL adapter and isolated database tests, but is not wired into the app's migration journal or seller routes. The current demo access-code session remains active until a reviewed integration changes it.

## Service boundary

`src/server/seller-identity/service.ts` owns identity behavior; `PostgresIdentityStore` and `PostgresAttemptLimiter` in `postgres-store.ts` implement durable writes through PostgreSQL. `requireOwnerShop` and `listOwnerShops` resolve shops from the owner ID obtained from an authenticated session; routes must not substitute a request-provided owner ID. The in-memory fake in `service.test.ts` is test-only and not a production persistence option.

`AttemptLimiter` must be backed by a shared durable store or an edge/platform limiter in deployment. The service has bounded policies of 5 registrations per client key/hour and 8 sign-in attempts per client key plus normalized username/15 minutes. `PostgresAttemptLimiter` HMACs limiter keys with the existing `APP_SIGNING_SECRET` (at least 32 characters); the route must derive client identity from a trusted proxy configuration and must not trust arbitrary forwarding headers.

Passwords use Node `scrypt` with a random 16-byte salt and parameters `N=16384,r=8,p=1`, encoded as `scrypt$16384$8$1$<salt>$<hash>`. Session and agent bearer tokens are 256-bit random values; only their SHA-256 hashes are stored. Owner sessions expire after 12 hours and are immediately revocable. Agent grants expire after 15 minutes and are revocable by the owner. Owner-level `create_shop` grants authorize one successful shop creation; retries with the same idempotency key replay the result, and a different key is rejected. Shop-scoped grants authorize only the named shop and selected scopes from `read_shop`, `manage_catalog`, `manage_inventory`, and `connect_paypal`. Every management grant requires current owner membership when issued.

The HTTP integration must set the owner session token in an `HttpOnly`, `Secure` in production, `SameSite=Lax` cookie, apply CSRF protection to mutations, and never log passwords, session tokens or agent grants. Do not put a bearer grant in an MCP tool argument that can be copied to conversation history; use a server-side credential channel or an explicit owner consent callback.

## Registration and MCP contract

`registerOwnerAndShop` accepts `ownerRegistrationInput`: normalized username, password, shop profile and UUID idempotency key. It writes an owner, owner membership and shop in one transaction, then issues an owner session. A duplicate username or slug fails without attaching the new owner to an existing shop. Store uniqueness constraints, not preflight reads, decide races.

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

For later seller-agent actions, `authorizeSellerAgent(store, authenticatedOwner, shopId, scopes)` issues an owner-consented grant. `resolveAuthorizedSellerAgent(store, token, requiredScope, requestedShopId)` returns the shared `{ actorId, shopId }` principal only when the token is active, includes the requested scope, and names exactly the requested shop. Owner-level grants cannot be used for shop management; shop-scoped grants cannot create shops or cross tenant boundaries. MCP code consumes this resolver and never issues or revokes bearer tokens.

Successful agent creation returns `SellerAgentCreateShopResult` with `paymentStatus: "not_configured"`. Set `shops.paypalCredentialRef` to the safe sentinel `UNCONFIGURED`, keep `paypalMerchantId` null, and do not provision a merchant app or per-shop environment variables. The current `checkout-quote.ts` guard rejects checkout without `paypalMerchantId` using the existing `PAYMENT_NOT_CONFIGURED` error. Catalog preparation remains available.

## Persistence adapter requirements

The adapter must enforce the following in SQL:

- `seller_owners`: unique normalized username and a constrained scrypt hash representation
- `shop_memberships`: primary key `(owner_id, shop_id)`; owner IDs and shop IDs are foreign keys
- `owner_sessions`: token hash, expiry, revocation timestamp; lookup requires `expires_at > now()` and `revoked_at IS NULL`
- `seller_agent_grants`: token hash, nullable shop scope, allowed scope array, expiry and revocation timestamp; management grants reference an owner membership
- `seller_identity_operations`: idempotency key, operation, request fingerprint, owner and resulting shop; same key plus same request replays, changed request conflicts
- `seller_identity_attempt_windows`: hashed limiter key and bounded counter updated atomically

Owner registration and shop creation write the operation row, owner, membership and shop in one transaction. An agent request must validate the grant and perform its idempotency lookup and writes in the same transaction. Unique slug errors must never trigger a second attempt that reuses an existing shop. `postgres-store.db.test.ts` applies the draft DDL from `drizzle/drafts/identity-registration.sql` against a disposable database with a minimal shops fixture. The draft is not numbered, wired to the migration journal, or applied to a shared database.

## Integration points awaiting review

- Add identity table definitions to `src/server/db/schema.ts` and register the coordinated numbered migration
- Extend seller sign-in and session resolution while retaining the existing seeded access-code path until migration is verified
- Add registration, sign-in, sign-out, owner shop list and owner-consent routes/pages; connect the current catalog/import routes through an owner-to-shop authorization adapter
- Ensure every seller mutation obtains the shop from membership/session server state, not request input
- Keep unconfigured shops in catalog flows and rely on the current checkout guard for payment rejection

These changes are not made by this isolated module. No registration UI, migration registration, session routes, catalog adapter, live PayPal flow or end-to-end onboarding test is included.

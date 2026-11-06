# Seller MCP contract

`src/server/mcp/seller-server.ts` builds a separate MCP server named `agentshelf-seller`. It does not change the buyer connector at `/mcp`. The current factory is an isolated server integration seam, not a deployed endpoint.

## Contract and authorization

The Zod contracts in `src/server/contracts/seller-agent.ts` reject unknown fields. Tool arguments never choose a shop, owner, inventory actor, PayPal recipient, or credential. A transport adapter must provide the verified opaque seller-grant token through `grantTokenFromRequest` and selected tenant through `shopIdFromRequest` from trusted server/route context. Tenant tools must resolve the grant against that exact shop and required persisted scope, then use the returned `{shopId, actorId}`. The shop ID never comes from MCP tool arguments. The token is not exposed as a business argument, and this server neither issues nor revokes grants. Seller outputs use explicit allowlisted schemas; provider product IDs, credentials and unmodeled fields are excluded.

The Identity integration contract being implemented separately uses `create_shop` for one owner-authorized shop creation, and shop-bound `read_shop`, `manage_catalog`, `manage_inventory`, or `connect_paypal` scopes for subsequent tools. A newly created shop needs an owner-issued management grant before store operations are available. Revocation and expiry must take effect in the identity resolver, not in MCP-local state.

## Seller tools

| Tool | Operation | Contract rule |
| --- | --- | --- |
| `seller_create_shop` | Create a shop with idempotency under owner-level `create_shop` authorization | Shop data only; no shop ID, seller ID, merchant, credentials or payee |
| `seller_import_price_list` | Upload CSV/photo for AI extraction to a review draft | Does not publish; each upload creates a new job, so retry after a lost response can duplicate a draft |
| `seller_review_import` | Read/edit/remove rows, accept clean rows, set missing currency, or publish a completed review | Seller review remains explicit before publication |
| `seller_manage_catalog` | List/edit/publish/unpublish catalog entries | Direct create is omitted until the catalog service adds it; CSV/photo import plus review publishes new products. `inputSchema.action` and description are narrowed to adapter-supported actions at server construction |
| `seller_manage_stock` | Read quantities, configure tracked/untracked mode, or make versioned stock adjustments | Read requires `read_shop`; mode setup and adjustment require `manage_inventory`, explicit reason/idempotency key; adjustments also require expected version |
| `seller_connect_paypal` | Start sandbox seller consent with an idempotency key | Returns public connection status/next action and a validated PayPal Sandbox Partner Referrals action link when available. The owner completes PayPal consent. No payment approval, capture or refund operation exists here |

Only a capability with an injected service adapter and the required grant resolver is registered. A production composition root must provide adapters only for operations with implemented backend support. `availableSellerAgentTools` reports what that composition can actually expose. This prevents a mock or a tool name from being treated as backend readiness.

## HTTP routes and current gate

The isolated Streamable HTTP route is mounted at `POST /mcp/seller/onboarding` for owner-level `create_shop` grants and `POST /mcp/seller/shop/{shopId}` for a shop-bound grant. The shop ID is selected from the URL and rechecked against persisted grant scope. Each request requires a Bearer grant, checks exact configured Host and allowed Origin, enables the SDK's DNS rebinding checks, and caps JSON bodies at 10 MiB for photo uploads. The existing buyer MCP route remains separate.

The composition root calls existing identity, import/review/publication, catalog and inventory services. Supported catalog actions are list/edit/publish/unpublish; product creation uses the existing CSV/photo import and seller review flow. PayPal connection is not registered until the shared durable merchant-connection runtime accepts persisted `SHARE_DATA_CONSENT` and is wired here. Runtime integration still requires review and end-to-end verification against the owner grant UI, migrations, real Postgres, and sandbox partner referrals. Contract tests and adapters alone do not prove deployment readiness. No PayPal API, seller credential, or external MCP client was exercised here.

## MCP client support

The official MCP TypeScript SDK v1 documentation identifies `StreamableHTTPClientTransport` as its remote HTTP client and Streamable HTTP as the recommended modern transport. This repository currently pins `@modelcontextprotocol/sdk` 1.32.2. The SDK does not issue seller grants; the identity subsystem owns grant issuance and revocation. Tests exercise the pinned SDK `Client` and `McpServer` over an in-memory protocol transport, and boundary tests cover Host, Origin and missing-grant rejection. A remote Streamable HTTP SDK smoke and a real Claude Code session have not yet been run.

- [MCP TypeScript SDK v1 client guide](https://ts.sdk.modelcontextprotocol.io/client)
- [MCP TypeScript SDK v1 server guide](https://ts.sdk.modelcontextprotocol.io/server)
- [MCP TypeScript SDK v2 authorization overview](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization) (consulted as current protocol guidance; implementation must follow the repository's pinned v1 API)

Claude Code supports a remote HTTP MCP server with a custom `Authorization` header. After an owner creates a shop-bound grant, keep the token in a local shell variable and register that shop's endpoint:

```sh
read -s SELLER_MCP_TOKEN
claude mcp add --transport http --header "Authorization: Bearer ${SELLER_MCP_TOKEN}" agentshelf-seller "https://<deployment-host>/mcp/seller/shop/<shop-id>"
unset SELLER_MCP_TOKEN
```

The owner-level onboarding endpoint is `/mcp/seller/onboarding`. ChatGPT custom connectors require OAuth or no authentication in the documented setup; this Bearer-header route is not presented as a ChatGPT connector. No client session has been connected yet.

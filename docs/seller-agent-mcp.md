# Seller MCP contract

`src/server/mcp/seller-server.ts` builds a separate MCP server named `agentshelf-seller`. It does not change the buyer connector at `/mcp`. The production composition is served by the routes below and is deployed with the application.

## Contract and authorization

The Zod contracts in `src/server/contracts/seller-agent.ts` reject unknown fields. Tool arguments never choose a shop, owner, inventory actor, PayPal recipient, or credential. A transport adapter must provide the verified opaque seller-grant token through `grantTokenFromRequest` and selected tenant through `shopIdFromRequest` from trusted server/route context. Tenant tools must resolve the grant against that exact shop and required persisted scope, then use the returned `{shopId, actorId}`. The shop ID never comes from MCP tool arguments. The token is not exposed as a business argument, and this server neither issues nor revokes grants. Seller outputs use explicit allowlisted schemas; provider product IDs, credentials and unmodeled fields are excluded.

The owner issues grants in `/seller/agent-access`: an owner-level `create_shop` grant authorizes one shop creation, and a shop-bound grant carries any of `read_shop`, `manage_catalog`, `manage_inventory` and `connect_paypal`. A newly created shop needs its own shop-bound grant before store operations are available. Grants are shown once, expire after 15 minutes and can be revoked; revocation and expiry take effect in the identity resolver, not in MCP-local state. See [seller identity](seller-identity.md).

## Seller tools

| Tool | Operation | Contract rule |
| --- | --- | --- |
| `seller_create_shop` | Create a shop with idempotency under owner-level `create_shop` authorization | Shop data only; no shop ID, seller ID, merchant, credentials or payee |
| `seller_import_price_list` | Upload CSV/photo for AI extraction to a review draft | Does not publish; each upload creates a new job, so retry after a lost response can duplicate a draft |
| `seller_review_import` | Read/edit/remove rows, accept clean rows, set missing currency, or publish a completed review | Seller review remains explicit before publication |
| `seller_manage_catalog` | List/edit/publish/unpublish catalog entries | Direct create is omitted until the catalog service adds it; CSV/photo import plus review publishes new products. `inputSchema.action` and description are narrowed to adapter-supported actions at server construction |
| `seller_manage_stock` | Read quantities, configure tracked/untracked mode, or make versioned stock adjustments | Read requires `read_shop`; mode setup and adjustment require `manage_inventory`, explicit reason/idempotency key; adjustments also require expected version |
| `seller_connect_paypal` | Start sandbox seller consent with an idempotency key | Requires an owner-issued `connect_paypal` grant with persisted `SHARE_DATA_CONSENT`; the server forwards that verified consent to the shared Partner Referrals service. It returns public connection status/next action and a validated PayPal Sandbox action link. No payment approval, capture or refund operation exists here |

Only a capability with an injected service adapter and the required grant resolver is registered. A production composition root must provide adapters only for operations with implemented backend support. `availableSellerAgentTools` reports what that composition can actually expose. This prevents a mock or a tool name from being treated as backend readiness.

## HTTP routes

| Route | Grant | Tools |
| --- | --- | --- |
| `POST /mcp/seller/onboarding` | Owner-level `create_shop` | `seller_create_shop` |
| `POST /mcp/seller/shop/{shopId}` | Live grant for exactly that shop | Import, review, catalog, stock and PayPal connection tools |

The shop ID is selected from the URL and rechecked against the persisted grant. Each request requires a Bearer grant, checks the exact configured Host and allowed Origin, enables the SDK DNS rebinding checks and caps JSON bodies at 10 MiB for photo uploads. An invalid, expired, revoked or foreign-shop grant is rejected with HTTP 401 before discovery. The buyer route stays separate.

The route lists every tool its composition supports; each call then checks the scope it needs:

| Operation | Scope |
| --- | --- |
| Import, review and every catalog action, including `list` | `manage_catalog` |
| Stock `read` | `read_shop` |
| Stock `set_mode` and `adjust` | `manage_inventory` |
| `seller_connect_paypal` | `connect_paypal` with recorded data-sharing consent |

A newly published product has no inventory policy, so buyers cannot check it out and stock `read`/`adjust` return `NOT_FOUND` until `set_mode` chooses `tracked` with `onHand` or `untracked`. Adjustments need the current `version` from `read`; a stale version returns `CONFLICT`.

Errors return a stable `code` with fixed recovery guidance. Service messages, row data and the existence of records in other shops are not exposed.

## Connect Claude Code

`external client verified` with Claude Code 2.1.319 only, against the deployed demo at commit `0c8e262` on 8 November 2026, see [rehearsal evidence](seller-agent-rehearsal.md#external-claude-code-session). Claude Code connects through its `http` (Streamable HTTP) transport with a static `Authorization` header.

1. Sign in as the owner and open `/seller/agent-access`. Issue an owner-level grant with `create_shop`, copy the token, it is shown once and expires after 15 minutes.
2. Keep the token in an environment variable and reference it from a private config file outside the repository, so it never appears in a shared config or command line:

```json
{
  "mcpServers": {
    "agentshelf-seller": {
      "type": "http",
      "url": "https://<deployment-host>/mcp/seller/onboarding",
      "headers": { "Authorization": "Bearer ${SELLER_MCP_TOKEN}" }
    }
  }
}
```

```sh
read -rs SELLER_MCP_TOKEN && export SELLER_MCP_TOKEN
claude --mcp-config ./agentshelf-seller.json --strict-mcp-config
```

3. Ask the assistant to create the shop with `seller_create_shop`. The result returns the shop ID and `paymentStatus: "not_configured"`.
4. Back in `/seller/agent-access`, select the new shop and issue a shop grant with only the scopes the task needs, for example `read_shop`, `manage_catalog` and `manage_inventory`. Point the config at `/mcp/seller/shop/<shop-id>`, set the new token and start a new session.
5. Import a CSV or photo once, review and publish the rows, then choose a stock policy for every published product.
6. Revoke the grants in `/seller/agent-access` when finished, `unset SELLER_MCP_TOKEN` and delete the config file.

A rejected grant shows as a failed `agentshelf-seller` server in `/mcp` with `AUTH_HEADER_REJECTED`; issue a new grant rather than retrying the old one.

## Supported clients

| Client | Status |
| --- | --- |
| Claude Code with an `http` server entry and an `Authorization` header | `external client verified`: Claude Code 2.1.319, deployed demo at `0c8e262`, 8 November 2026, see above |
| Other MCP clients that send a static `Authorization: Bearer` header over Streamable HTTP | Should work by protocol, `not tested` |
| ChatGPT | **Not offered.** Its documented custom connector setup uses OAuth or no authentication, and this route accepts only a Bearer grant. There is no OAuth flow for seller MCP |
| Claude custom connector (claude.ai) | **Not offered** for the same reason |

The buyer connector at `/mcp` is separate and needs no grant; never configure a seller grant there, see [MCP setup](mcp.md).

The pinned `@modelcontextprotocol/sdk` 1.32.2 contract tests and `npm run smoke:runtime` cover the same routes locally, see [local setup](seller-agent-rehearsal.md#local-setup); they do not replace the external client evidence above.

- [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)
- [MCP TypeScript SDK v1 server guide](https://ts.sdk.modelcontextprotocol.io/server)

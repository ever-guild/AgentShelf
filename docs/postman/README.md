# Postman smoke collection

[`agentshelf-smoke.postman_collection.json`](agentshelf-smoke.postman_collection.json) checks a running AgentShelf over HTTP: health, the catalog, checkout and order status. It holds no credentials, no hostnames and no live-payment endpoints. PayPal is sandbox only.

## Configure

`baseUrl` is empty on purpose. Set it to the origin of the app you want to check, with no trailing slash, for example `http://localhost:3000`. The checks that find the seeded product need the demo data (`npm run db:seed`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | empty | Origin of the running app |
| `shopSlug` | `demo-phone-workshop` | Seeded shop used for checkout |
| `productId` | seeded screen protector | Public synthetic id from the demo data |
| `statusToken` | empty | Private order capability. Request 3.1 fills it. Paste one from a connector order to read that order. Never share or commit it |
| `orderId` | empty | Filled by request 3.1 |

To get your own test ids, call `search_products` (request 2.3) and read `productId` from the answer, or run `npm run db:seed` and use the ids it prints in [`src/server/db/seed.ts`](../../src/server/db/seed.ts).

## Run

In Postman, import the file, set `baseUrl` in the collection variables and run the collection.

From a terminal:

```bash
npx newman run docs/postman/agentshelf-smoke.postman_collection.json --env-var baseUrl=http://localhost:3000
```

## What is covered

| Folder | Requests |
| --- | --- |
| 1 Health | `GET /api/health`, `GET /api/health/ready` |
| 2 Catalog through MCP | initialize, tools/list, `search_products`, and one malformed search |
| 3 Checkout | `POST /api/shops/{slug}/checkout`, and one malformed checkout |
| 4 Order status | `get_order_status` with a real token, and with a wrong one |

## Creates a sandbox order

Request 3.1 is the only one that writes. It creates one unpaid PayPal sandbox order and returns `approvalUrl`. Nothing here approves or captures payment: a person has to open that link and approve as the sandbox buyer. Until sandbox credentials are configured the app answers `503` with `PAYMENT_NOT_CONFIGURED`, and the collection accepts that. Request 4.1 is skipped when no token is set. After approval, run 4.1 again to see the status change.

## MCP requests

The catalog, slots and order status are reachable only through MCP, so there is no REST endpoint for them and the collection does not invent one. Calls are JSON-RPC over `POST /mcp`:

- Send `Accept: application/json, text/event-stream`.
- There are no sessions and no session header. Each request stands alone, so `initialize` is a handshake you can repeat, not a prerequisite.
- A tool failure is HTTP 200 with `isError: true` in the result. HTTP errors are for transport problems only.
- `get_slots` and `book_slot` are not in the collection, because booking holds a real slot. Use `npm run smoke:booking`, see [mcp.md](../mcp.md#smoke-check).

## Not covered

Seller routes need a seller session, webhooks need a PayPal signature, and the buyer's approval and capture happen in PayPal, so none of them are in this collection.

# Capability matrix and verification evidence

This matrix summarizes the implemented capabilities of AgentShelf, where they are implemented, the verified environments, references to public verification evidence, known operational limits, and acceptance criteria for final release rehearsals.

## Evidence levels

- **Code:** Implemented in the repository and validated by automated unit or static checks.
- **Mock / Local PG:** Verified in local automated tests or browser automation against a temporary PostgreSQL 17 database and an in-process fake PayPal provider (`test/payments.ts`).
- **Sandbox Live:** Verified against live PayPal Sandbox REST APIs, webhooks, or live hosted Render deployment (`https://agentshelf-e5bk.onrender.com`).
- **External Client:** Verified through an actual external client implementation calling remote endpoints over HTTPS (e.g., Claude Code CLI).

---

## Capabilities table

| Capability | Implementation paths | Verified environments | Public evidence & commits | Current limits & caveats | Acceptance criteria for release (#18) |
| --- | --- | --- | --- | --- | --- |
| **Owner registration & shop management** | `src/app/seller/register`, `src/app/seller/identity`, `src/server/seller-identity/` | Local PG, Live Sandbox | Commits `114c54c`, `a53533f`, `37fea91`; [CI run 42513603581](https://github.com/ever-guild/AgentShelf/actions/runs/42513603581) | Owner registration requires username and 12+ char password or PayPal Login. | Owner registers in UI, creates shop, and manages schedule without direct DB edits. |
| **Log in with PayPal (Identity)** | `src/app/seller/owner-sign-in`, `src/server/seller-identity/paypal-auth.ts`, `src/app/api/seller/identity/paypal/` | Local PG, Live Sandbox | Commits `34503a5`, `7807e98`, `2e8cb8d`; [CI run 42513603581](https://github.com/ever-guild/AgentShelf/actions/runs/42513603581) | Sandbox only. Requires `PAYPAL_PLATFORM_CLIENT_ID` and secret configured on server. | Owner logs in via PayPal Sandbox identity and shop is linked to profile. |
| **Platform merchant connection (Consent)** | `src/app/seller/paypal-connection`, `src/server/paypal/merchant-connection.ts` | Local PG, Live Sandbox | Commits `8362999`, `a6272d5`; Issue [#35](https://github.com/ever-guild/AgentShelf/issues/35); [CI run 42513603581](https://github.com/ever-guild/AgentShelf/actions/runs/42513603581) | Sandbox Partner Referrals only. Two distinct sandbox merchants verified (`TEST_SHOP_2`, `TEST_SHOP_3`). | Human merchant confirms PayPal consent, status reports `ready`, webhooks subscribed. |
| **Price list import (CSV & review)** | `src/server/imports/csv.ts`, `src/app/seller/imports`, `src/server/services/imports.ts` | Local PG, Live Sandbox | Commits `4966471`, `f384c7e`; Issue [#8](https://github.com/ever-guild/AgentShelf/issues/8) | CSV parsing is fully deterministic without model calls. Photo OCR requires the configured AI provider. | Owner uploads CSV, inspects rows, edits missing fields, and publishes catalog items. |
| **Physical stock policy & adjustments** | `src/app/seller/catalog`, `src/server/inventory/`, `src/server/contracts/inventory.ts` | Local PG, Live Sandbox | Commits `67bbfef`, `791f30d`, `2b741d0`; Issue [#36](https://github.com/ever-guild/AgentShelf/issues/36) | Explicit decision (`tracked` with `onHand >= 0` or `untracked`) required before purchase. 409 conflict requires reconfirmation without auto-apply. | Newly published physical product blocks checkout until stock policy is set in UI or seller MCP. |
| **Buyer discovery (Search & Storefront)** | `src/server/services/catalog.ts`, `src/server/services/storefront.ts`, `/shops/[slug]` | Local PG, Live Sandbox | Commits `30af30d`, `2b741d0`; Issue [#36](https://github.com/ever-guild/AgentShelf/issues/36) | Search matches text across products and shops; effective availability derives from inventory stock without hiding listings. | Products without stock decision or with 0 available units report `unavailable` or out of stock. |
| **Buyer remote MCP (`/mcp`)** | `src/app/mcp/route.ts`, `src/server/contracts/commerce.ts` | Local PG, Live Sandbox | Commits `cd1e197`, `13ed920`; Issue [#5](https://github.com/ever-guild/AgentShelf/issues/5) | Exposes `search_products`, `get_slots`, `book_slot`, `create_checkout`, `get_order_status`. Streamable HTTP POST. | Remote AI assistant discovers tools, reads catalog, and requests approval link. |
| **Seller agent remote MCP (`/mcp/seller/`)** | `src/app/mcp/seller/`, `src/server/seller-mcp/` | Local PG, Live Sandbox (Claude Code) | Commits `86397b0`, `3da6aeb`; Issue [#37](https://github.com/ever-guild/AgentShelf/issues/37) | Requires scoped bearer token (`create_shop`, `manage_catalog`, `manage_inventory`). Verified with Claude Code CLI 2.1.319. | External seller agent with valid grant creates shop, imports price list, sets stock policy. |
| **PayPal Orders v2 payment & capture** | `src/server/paypal/orders.ts`, `src/server/services/checkout.ts`, `src/server/services/payment-reconciliation.ts` | Local PG, Live Sandbox | Commits `06aa89c`, `33bb848`, `3a04f75`; Issues [#2](https://github.com/ever-guild/AgentShelf/issues/2), [#36](https://github.com/ever-guild/AgentShelf/issues/36) | Money routes directly to seller `payee`. In-flight capture conflict retains allocation. Human confirms in Sandbox. | Order created, approved by buyer in Sandbox, captured by server, stock deducted once. |
| **Repair booking & Bryntum scheduler** | `src/app/seller/schedule`, `src/server/services/booking.ts`, `src/server/services/schedule.ts` | Local PG, Live Sandbox | Commits `37fea91`, `80347`; Issue [#13](https://github.com/ever-guild/AgentShelf/issues/13) | Uses Bryntum 8.0 Community (MIT). Technician hours configurable on `/seller/schedule`. Single €1 product verified live; real deposit live run pending in #18. | Buyer reserves technician slot via MCP/storefront, pays deposit, appointment renders in schedule. |
| **Seller dashboard & AI insights** | `src/app/seller/dashboard`, `src/server/services/demand-insights.ts` | Local PG, Live Sandbox | Issue [#15](https://github.com/ever-guild/AgentShelf/issues/15); implementation in the linked source paths | AG Studio UI renders orders, bookings, and unmet search demand. AI insights require a configured server-side AI provider. The current demo configuration selects OpenAI-compatible `gpt-6-astra` at high effort. | Dashboard reflects live orders and bookings, and summarizes unmet customer demand. |

---

## Explicit non-goals & out-of-scope boundaries

1. **No Live Money or Real Banking:** AgentShelf operates exclusively against PayPal Sandbox. No live PayPal credentials or production merchant onboarding are supported.
2. **Human Payment Confirmation Always Required:** Autonomous agents never charge customer payment methods directly. Agents only generate PayPal approval URLs; human buyers must log in to PayPal Sandbox to authorize the charge.
3. **No Unbounded General Client Promises:**
   - **Seller MCP:** Tested and verified with Claude Code CLI (Bearer token authentication). Third-party web agents without custom HTTP authorization headers (e.g., standard ChatGPT web MCP connectors) cannot pass seller bearer grants.
   - **Buyer MCP:** Standard Streamable HTTP `/mcp` without sign-in, protected by strict schema parsing and allowed origin filtering (`claude.ai`, `chatgpt.com`, or configured allowed origins).
4. **No Automated Unlimited Inventory:** Products imported from CSV or photo never default to infinite stock. Sellers must explicitly configure tracked quantity or choose untracked mode before checkout is allowed.

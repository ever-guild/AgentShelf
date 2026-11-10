# Channel3 Catalog Enrichment Integration

This document outlines the architecture, API contract, matching rules, and operational setup for Channel3 product data and price comparison enrichment in AgentShelf (Issue [#24](https://github.com/ever-guild/AgentShelf/issues/24)).

---

## 1. Architectural Principles

1. **Seller-Controlled Enrichment**:
   - Channel3 data serves strictly as **reference suggestions**.
   - Suggestions **never** automatically overwrite product title, description, price, deposit, currency, stock levels, or publication status.
   - The seller explicitly inspects suggestions and decides whether to apply a reference price or review suggested specifications.

2. **Server-Side Isolation**:
   - All Channel3 API calls occur strictly on the server (`/src/server/channel3/*` and `/api/seller/catalog/[id]/enrichment`).
   - The API key (`CHANNEL3_API_KEY`) is never exposed to the client bundle, network payloads, or client logs.
   - If `CHANNEL3_API_KEY` is not configured, the catalog operates normally without errors (`status: "not_configured"`).

3. **Content Rights & Image Safety**:
   - Third-party images from external retailer sites are **not** downloaded, mirrored, or republished without verified intellectual property licenses.
   - Only factual technical specifications (e.g., brand, model, compatibility, color) and source retailer domain links are presented.

4. **Zero SDK Bloat**:
   - Built using Node.js / Web native `fetch` with strict 5-second `AbortSignal.timeout(5000)` and payload size limits. No additional third-party dependencies.

---

## 2. Channel3 API Specifications

- **Search Endpoint**: `POST https://api.trychannel3.com/v1/search`
- **Authentication**: `x-api-key: $CHANNEL3_API_KEY`
- **Content Type**: `application/json`
- **Request Body**:
  ```json
  {
    "query": "iPhone 15 Pro Silicone Case",
    "limit": 5
  }
  ```
- **Response**: the raw HTTP response uses `products: Product[]` and optional `next_page_token`. The Channel3 TypeScript SDK wraps this in a `Page` whose `.data` property contains those products; that SDK wrapper is not the wire response schema.
- **Response Format**:
  ```json
  {
    "products": [
      {
        "id": "prod_123",
        "title": "Apple iPhone 15 Pro Silicone Case with MagSafe",
        "description": "Designed by Apple to complement iPhone 15 Pro...",
        "images": ["https://..."],
        "offers": [
          {
            "domain": "target.com",
              "price": { "price": 49.0, "currency": "USD" },
            "availability": "InStock",
              "url": "https://www.target.com/..."
          }
        ]
      }
    ]
  }
  ```

The Channel3 API reference defines `ProductOffer.price` as `{ price: number, currency: string }`; the response adapter validates this wire shape and caps response bodies at 1 MiB. Offer URLs are affiliate-tracked and short-lived, so they are used only as immediate source links and are never persisted by AgentShelf. See the [Channel3 API reference](https://raw.githubusercontent.com/channel3-ai/skills/main/skills/channel3-api/references/api-reference.md).

---

## 3. Matching & Ambiguity Resolution

1. **Brand vs. Model/Variant Discrimination**:
   - Matching solely by brand is treated as insufficient.
   - Specific device generations, models, sizes, and compatibility attributes are checked against the seller's catalog item.
   - If returned results span multiple distinct variants (e.g. iPhone 14 case vs. iPhone 15 Pro case), the response is classified as `ambiguous` with candidate details.

2. **Currency & Variant Comparability**:
   - Offers are tagged with `isComparableCurrency: boolean`.
   - If an offer's currency differs from the seller shop's configured currency (e.g., USD vs. EUR), the UI marks the price comparison as incomparable and advises the seller rather than attempting inaccurate automated forex conversion.

3. **Safe Error Handling**:
   - **Missing Key**: Returns `status: "not_configured"`.
   - **429 Rate Limit**: Returns `status: "rate_limited"` with retry guidance.
   - **401/403 Auth**: Returns `status: "provider_error"` ("Channel3 authentication failed").
   - **Timeout / Network Error**: Returns `status: "provider_error"` ("Channel3 provider unavailable").
   - **No Results**: Returns `status: "no_match"`.

---

## 4. UI States (`product-enrichment.tsx`)

Following the `unslop` design direction and neutral styling:
- `idle`: Subdued "Check market specs & price" trigger.
- `loading`: Subtle inline loading notice.
- `not_configured`: Clean notification that Channel3 is not configured in this environment.
- `no_match`: Notification that no reference matches were found.
- `ambiguous`: Review card listing alternative candidates without auto-applying changes.
- `exact_match`: Verified suggestion card displaying:
  - Canonical product title & factual specifications.
  - Retailer offers with domain, price, currency, retrieval timestamp, and external provenance link.
  - Explicit "Apply reference price" button connected to the existing `PATCH /api/seller/catalog/[id]` contract.
  - "Dismiss" action.
- `rate_limited`: Rate limit advisory notice.
- `provider_error`: Provider connection error notice.
- `applied`: Confirmation that reference price was applied to the product form.

---

## 5. Configuration & Setup

1. **Acquiring Credentials**:
   - Register at [Channel3 Developer Dashboard](https://trychannel3.com/developers).
   - Apply the hackathon promo code: `PAYPAL-HACKATHON-2026`.
   - Generate your API key.

2. **Environment Variable**:
   ```bash
   CHANNEL3_API_KEY=ch3_live_...
   ```
   Add to `.env.local` for local development or configure in Render environment settings.

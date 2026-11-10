# Channel3 catalog suggestions

Channel3 can help a seller review reference specifications and retailer offers for a physical catalog product. It is optional; the catalog works when no key is configured. This is an assistive lookup, not SKU verification or automatic catalog enrichment.

## Seller flow

1. In `/seller/catalog`, the seller chooses **Check market specs & price** on a product.
2. AgentShelf sends the product title to Channel3 and shows suggested attributes, a source link, and returned offers. Provider marketing descriptions and images are not shown or copied.
3. The seller checks the source listing's exact model and condition. Matching is heuristic and does not verify an exact SKU. A matching label is not proof that the returned item is identical.
4. Offers in another currency are shown as incomparable; AgentShelf does not convert currencies. Shipping and tax are not verified; check the source listing before applying a price.
5. The seller may choose **Apply reference price**. This sends only the price through the existing catalog `PATCH`; it does not save automatically when results arrive. The seller's currency, stock, deposit, and publication status are not changed by this action. **Dismiss** leaves the catalog unchanged.

Channel3 results are short-lived references. Source links are shown for immediate review and are not persisted. AgentShelf does not download, mirror, or publish Channel3 images.

## Request and safeguards

The server sends `POST https://api.trychannel3.com/v1/search` with `x-api-key` authentication and a JSON body containing the title as `query` and `limit: 5`. The raw HTTP response contains `products`; product offers use `price: { price, currency }`. The key is server-side only and is never included in the browser response.

The adapter limits requests to five results, times out after 5 seconds, and rejects response bodies larger than 1 MiB. The seller endpoint permits 10 lookups per shop per hour when the provider key is configured. Missing configuration, no match, ambiguous match, rate limiting, provider errors, and timeouts leave the catalog available.

Matching uses title-derived brand, model, generation, tier, category, and compatibility clues. Brand-only or conflicting variant results are marked ambiguous. These rules reduce obvious mismatches but cannot confirm product identity or item condition; inspect the source before applying a price.

## Configuration

For local development, put the key in the ignored `.env.local` file:

```dotenv
CHANNEL3_API_KEY=
```

For Render, the optional GitHub Environment secret `CHANNEL3_API_KEY` is synchronized to the Render web service after CI validation. It is not sent to Render Workflows. If the GitHub secret is absent or blank, the sync skips this setting and leaves any existing Render value untouched. To disable Channel3 on Render, remove the GitHub secret and explicitly remove `CHANNEL3_API_KEY` from the web service environment in Render. See [deployment configuration](deployment.md#environment-variables).

A real-provider acceptance check is separate from fixture-based adapter and UI tests. Do not describe those tests as proof of live Channel3 use.

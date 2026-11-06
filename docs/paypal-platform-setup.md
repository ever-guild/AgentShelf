# PayPal platform sandbox setup

This setup uses one AgentShelf platform REST app and seller consent through PayPal Partner Referrals. A shop in AgentShelf and a PayPal merchant account are separate records: creating a shop does not itself connect a PayPal seller. The current `paypal:preflight` script checks the older direct-merchant demo apps; it does not establish platform authorization.

## What the owner configures

1. Sign in to the Sandbox API-caller account that represents AgentShelf, then create one REST app in the PayPal Developer Dashboard. PayPal's [platform getting-started guide](https://developer.paypal.com/platforms/get-started) says to create a Platform REST app under the sandbox API-caller account. Sandbox API calls can be tested before partner approval; live use requires approval.
2. Configure the Partner Referrals features and product for the intended PayPal Checkout flow. The app settings and the `features` sent by Partner Referrals must match. Start with only the required capabilities; confirm the account intent and country/payment eligibility with the PayPal onboarding checklist.
3. Keep the app's client secret private. Configure these values locally in `.env.local` or in the deployment's secret store; never commit or paste values into issues/logs:

   | Variable | Value |
   | --- | --- |
   | `PAYPAL_PLATFORM_CLIENT_ID` | Platform REST app client ID |
   | `PAYPAL_PLATFORM_CLIENT_SECRET` | Platform REST app secret |
   | `PAYPAL_PLATFORM_MERCHANT_ID` | Merchant ID of the platform's Sandbox API-caller account |
   | `PAYPAL_PARTNER_ATTRIBUTION_ID` | BN code for the platform REST app |

4. The operator configures one AgentShelf platform REST app. Each seller then opens the PayPal connection page at `/seller/paypal-connection`, signs in to or creates a PayPal account, and grants the requested permissions. For PayPal Checkout, PayPal documents that a seller may use a Personal account; country and product eligibility still apply. No per-seller REST app or seller API secret is required for this platform flow. The code path exists, but callback origin handling still needs verification and real Sandbox consent and payment evidence are pending
5. After PayPal returns the seller, treat browser query parameters as hints only. Use the merchant-integration status GET to confirm the seller ID, `payments_receivable`, `primary_email_confirmed`, an active `EXPRESS_CHECKOUT` product, and the required `payment/authcapture` scope before enabling checkout.

## Safe local check

`npm run paypal:platform-preflight` is offline by default. It reports only missing variable names and does not contact PayPal. With the four variables configured, it checks presence only:

```sh
npm run paypal:platform-preflight
```

An explicit online OAuth check makes one client-credentials request to the fixed Sandbox host. Supplying `--seller-id` additionally performs a read-only merchant-integration status GET for that Sandbox seller:

```sh
npm run paypal:platform-preflight -- --online
npm run paypal:platform-preflight -- --online --seller-id SANDBOX_SELLER_MERCHANT_ID
```

The script never prints credentials, access tokens, assertion values, or response bodies, and caps PayPal response reads. This check does not verify a shop-to-tracking-ID mapping, create referrals, prove an owner consented for a shop, create an order, capture a payment, verify webhooks, or prove the application runtime uses this configuration. Do not run the online check until the owner has configured the platform app values. Live credentials and live API hosts are unsupported by this command.

## References

- [PayPal platform getting started](https://developer.paypal.com/platforms/get-started)
- [Seller onboarding overview](https://developer.paypal.com/platforms/seller-onboarding)
- [Seller onboarding checklist: intent, features, products](https://developer.paypal.com/platforms/seller-onboarding/onboarding-checklist/)
- [Partner Referrals: signup link, callback, and status check](https://developer.paypal.com/platforms/seller-onboarding/before-payment/)
- [PayPal REST request headers](https://developer.paypal.com/api/make-api-requests)

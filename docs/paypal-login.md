# Seller login with PayPal

Seller sign-in uses a Sandbox PayPal account to create or recover an AgentShelf owner account, then the owner confirms the shop details
Login identifies the owner, payment permissions require the separate [merchant connection](paypal-platform-setup.md)

## Configure the demo

1. Open [Apps & Credentials](https://developer.paypal.com/dashboard/applications), select a Sandbox REST app, enable **Other features → Log in with PayPal → Advanced Settings**
2. Allow the basic profile and email information used by the `openid profile email` scopes
3. Set the exact Return URL to `https://agentshelf-e5bk.onrender.com/api/seller/identity/paypal/callback`, for a local app use `http://localhost:3000/api/seller/identity/paypal/callback`
4. Set Privacy policy URL to `https://agentshelf-e5bk.onrender.com/privacy` and User agreement URL to `https://agentshelf-e5bk.onrender.com/terms`
5. Leave **Enable customers who have not yet confirmed their email with PayPal to log in to your app** unchecked for the demo; use confirmed Sandbox accounts. AgentShelf identifies owners by PayPal `sub`, not by email
6. Store `PAYPAL_LOGIN_CLIENT_ID` and `PAYPAL_LOGIN_CLIENT_SECRET` in `.env.local` or Render's environment settings, restart or redeploy after changing configuration

Login settings are separate from `PAYPAL_PLATFORM_*`, verify whether your Platform app exposes the Login feature before reusing its credentials, otherwise use a separate Sandbox Login app
Never enter a seller password or API secret into AgentShelf

## Try it

1. Select **Seller sign-in** on the home page and sign in with a Sandbox seller at PayPal
2. Confirm the shop name, public slug, location and timezone, profile fields are suggestions and do not establish merchant readiness
3. Continue to **PayPal connection**, acknowledge data sharing and complete PayPal's seller-consent flow
4. Sign out and repeat login with the same Sandbox account, the existing owner and shops should be recovered

Password owners can still use [owner sign-in](https://agentshelf-e5bk.onrender.com/seller/owner-sign-in), existing accounts are never silently linked by matching email
Without Login configuration, the page explains that PayPal sign-in is unavailable and offers the existing access paths

## Verification boundary

Automated checks use mocked PayPal responses, actual Login, consent and payment checks require configured Sandbox apps and human actions
The adapter follows the current [Identity API schema](https://developer.paypal.com/api/identity/v1/schema.json) UserInfo path, `/v1/identity/openidconnect/userinfo`, the Login guide still shows an older path, confirm the response in the first Sandbox login
Record sanitized results in [#45](https://github.com/ever-guild/AgentShelf/issues/45), keep authorization codes, tokens and profile values out of logs and issues

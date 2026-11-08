# Seller login with PayPal

Seller sign-in uses a Sandbox PayPal account to create or recover an AgentShelf owner account, then the owner confirms the shop details
Login identifies the owner, payment permissions require the separate [merchant connection](paypal-platform-setup.md)

## Configure the demo

1. Open [Apps & Credentials](https://developer.paypal.com/dashboard/applications), select a Sandbox REST app with **Other features → Log in with PayPal → Advanced Settings** enabled, this may be the Platform app or a separate Login app
2. Allow the basic profile and email information used by the `openid profile email` scopes
3. Set the exact Return URL to `https://agentshelf-e5bk.onrender.com/api/seller/identity/paypal/callback`, for a local app use `http://localhost:3000/api/seller/identity/paypal/callback`
4. Set Privacy policy URL to `https://agentshelf-e5bk.onrender.com/privacy` and User agreement URL to `https://agentshelf-e5bk.onrender.com/terms`
5. Leave **Enable customers who have not yet confirmed their email with PayPal to log in to your app** unchecked for the demo; use confirmed Sandbox accounts. AgentShelf identifies owners by PayPal `sub`, not by email
6. Put the two values in `.env.local` for local testing; for the hosted demo, add them to the existing Render service environment through the Dashboard or API and redeploy

A local `.env.local` change does not update Render, preserve the existing `DATABASE_URL`, `APP_SIGNING_SECRET` and `APP_ORIGIN` values when changing service variables, and leave Render-managed `RENDER_EXTERNAL_URL` untouched

The environment names `PAYPAL_LOGIN_CLIENT_ID` and `PAYPAL_LOGIN_CLIENT_SECRET` stay separate from `PAYPAL_PLATFORM_*`, copy the Platform app's values into them only when that app exposes Log in with PayPal, otherwise configure a separate Sandbox Login app
Never enter a seller password or API secret into AgentShelf

## Try it

1. Select **Log in with PayPal** on the home page and sign in with a Sandbox seller at PayPal, no AgentShelf username, password or separate registration is required
2. Confirm the shop name, public slug, location and timezone, profile fields are suggestions and do not establish merchant readiness
3. Continue to **PayPal connection**, acknowledge data sharing and complete PayPal's seller-consent flow
4. Sign out and repeat login with the same Sandbox account, the existing owner and shops should be recovered

Password owners can still use [owner sign-in](https://agentshelf-e5bk.onrender.com/seller/owner-sign-in), existing accounts are never silently linked by matching email
On the owner sign-in page, open **Other sign-in options** for the AgentShelf password, registration or existing shop access
Without Login configuration, the page explains that PayPal sign-in is unavailable and offers the existing access paths

The button uses [PayPal's hosted image](https://developer.paypal.com/log-in/build-button/) without alteration or local hosting; it links to the server start route, which creates the one-time state and browser cookie

## If PayPal rejects the login

For `invalid client_id or redirect_uri`, check the same app under **Apps & Credentials → Sandbox**:

1. **Log in with PayPal** is enabled and its settings are saved
2. **Return URL** exactly matches `https://agentshelf-e5bk.onrender.com/api/seller/identity/paypal/callback`, including HTTPS and no trailing slash
3. The deployed `PAYPAL_LOGIN_CLIENT_ID` and `PAYPAL_LOGIN_CLIENT_SECRET` belong to that app; redeploy after changing them

MCP authorization and client-credentials OAuth do not verify these Login settings. Changing the button appearance does not resolve this provider error

If AgentShelf returns a generic sign-in failure after PayPal, inspect the Render logs for `paypal_login_failed`. Its JSON event identifies the failed step, a fixed reason, and an HTTP status or invalid field names when available; it contains no tokens, authorization codes, cookies or profile values

```bash
render logs --resources srv-dbm8a6e1egvs73bl8d90 --text paypal_login_failed --limit 20 --output json
```

Use the recorded step to distinguish code exchange, token refresh, profile retrieval/validation and owner-session persistence before changing credentials or retrying

## Verification boundary

Automated checks use mocked PayPal responses, actual Login, consent and payment checks require configured Sandbox apps and human actions
Following the [PayPal Login guide](https://developer.paypal.com/log-in/build/), the server exchanges the authorization code, exchanges the returned refresh token once, then requests UserInfo with the new access token; both tokens stay in memory for that callback only
The adapter uses the [Identity API](https://developer.paypal.com/api/identity/v1/schema.json) UserInfo path with `?schema=openid` to request the `sub` identity claim, as shown in [PayPal's profile-sharing example](https://github.com/paypal/PayPal-Android-SDK/blob/master/docs/profile_sharing_server.md#retrieve-customer-information-using-a-valid-access-token)
The database regression covers callback cookies accepted by the next `/api/seller/identity/me` request for both a new owner and a returning owner with a shop
Record sanitized results in [#45](https://github.com/ever-guild/AgentShelf/issues/45), keep authorization codes, tokens and profile values out of logs and issues

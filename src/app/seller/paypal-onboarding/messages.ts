const PAYPAL_LOGIN_ERRORS: Record<string, string> = {
  paypal_not_configured: "PayPal Sandbox sign-in is not available right now. Use your AgentShelf owner account or existing shop access instead.",
  paypal_login_denied: "PayPal sign-in was canceled. You can try again or use an existing sign-in.",
  paypal_login_failed: "PayPal could not complete the sign-in. Try again in a moment or use an existing sign-in.",
  paypal_login_state_invalid: "This PayPal sign-in expired or could not be verified. Start again.",
  paypal_login_rate_limited: "There have been too many PayPal sign-in attempts. Wait a little before trying again.",
  paypal_login_already_signed_in: "An owner account is already signed in. Open your shops before using a different PayPal account.",
};

export function paypalLoginErrorMessage(code: string | string[] | undefined): string | null {
  if (typeof code !== "string") return null;
  return PAYPAL_LOGIN_ERRORS[code] ?? null;
}

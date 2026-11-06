import "server-only";

import { getDb } from "../db";
import { reconcileForBuyer, defaultReconcileDeps } from "./payment-reconciliation";

// PayPal sends the buyer back with a GET. Settling first and then redirecting to a read-only page
// means a reload of that page cannot repeat anything. The capability in the URL is what authorizes
// this, so without a valid one nothing happens and the result page shows nothing.
export async function buyerReturnResponse(
  request: Request,
  options: { buyerCancelled?: boolean } = {},
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const orderId = query.get("order");
  const statusToken = query.get("status");

  let accepted = false;
  try {
    accepted = await reconcileForBuyer(
      getDb(),
      { orderId, statusToken },
      defaultReconcileDeps,
      options,
    );
  } catch (error) {
    console.error("Could not settle an order on the buyer's return", {
      error: error instanceof Error ? error.name : "unknown",
    });
    accepted = true;
  }

  const target = accepted
    ? `/checkout/result?${new URLSearchParams({
        order: orderId ?? "",
        status: statusToken ?? "",
      })}`
    : "/checkout/result";
  return new Response(null, {
    status: 303,
    headers: {
      Location: target,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

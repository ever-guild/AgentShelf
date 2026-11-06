import "server-only";

import { and, eq, or } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/client";
import { orders, shops, webhookReceipts } from "../db/schema";
import { describePayPalFailure, type WebhookSignature } from "../paypal/orders";
import {
  defaultReconcileDeps,
  reconcileOrder,
  type ReconcileDeps,
} from "./payment-reconciliation";

// Each shop has its own URL, because each seller's app has its own subscription. Nothing in the
// body is trusted before PayPal has verified the signature, and even then the event only says
// which order to look at: reconcileOrder reads what actually happened from PayPal.
const HANDLED_EVENTS = new Set([
  "CHECKOUT.ORDER.APPROVED",
  "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
]);

const webhookEvent = z.object({
  id: z.string().min(1).max(255),
  event_type: z.string().min(1).max(255),
  create_time: z.string().optional(),
  resource_type: z.string().optional(),
  resource: z.record(z.string(), z.unknown()),
});
type WebhookEvent = z.infer<typeof webhookEvent>;

function readEvent(rawBody: string): WebhookEvent | undefined {
  try {
    const parsed = webhookEvent.safeParse(JSON.parse(rawBody));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readSignature(headers: Headers): WebhookSignature | undefined {
  const authAlgo = headers.get("paypal-auth-algo");
  const certUrl = headers.get("paypal-cert-url");
  const transmissionId = headers.get("paypal-transmission-id");
  const transmissionSig = headers.get("paypal-transmission-sig");
  const transmissionTime = headers.get("paypal-transmission-time");
  return authAlgo && certUrl && transmissionId && transmissionSig && transmissionTime
    ? { authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime }
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// A capture event names its order under related_ids. On an order event, the resource is the order.
function paypalOrderIdOf({ event_type, resource }: WebhookEvent): string | undefined {
  const supplementary = resource.supplementary_data as
    | { related_ids?: { order_id?: unknown } }
    | undefined;
  return (
    asString(supplementary?.related_ids?.order_id) ??
    asString(resource.order_id) ??
    (event_type.startsWith("CHECKOUT.ORDER.") ? asString(resource.id) : undefined)
  );
}

// Enough to trace a delivery. Order events carry the payer's name, email and address, which this
// service has no reason to keep.
function receiptPayload(event: WebhookEvent) {
  return {
    id: event.id,
    event_type: event.event_type,
    create_time: event.create_time,
    resource_type: event.resource_type,
    resource: {
      id: event.resource.id,
      status: event.resource.status,
      custom_id: event.resource.custom_id,
      order_id: paypalOrderIdOf(event),
    },
  };
}

async function findEventOrder(db: Db, shopId: string, event: WebhookEvent) {
  const paypalOrderId = paypalOrderIdOf(event);
  // Our own order ID comes back on the capture as custom_id, if the event names no order.
  const parsedCustomId = z.uuid().safeParse(event.resource.custom_id);
  const localId = parsedCustomId.success ? parsedCustomId.data : undefined;
  if (!paypalOrderId && !localId) {
    return undefined;
  }
  const [order] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.shopId, shopId),
        or(
          paypalOrderId ? eq(orders.paypalOrderId, paypalOrderId) : undefined,
          localId ? eq(orders.id, localId) : undefined,
        ),
      ),
    );
  return order;
}

export type WebhookDelivery = {
  shopSlug: string;
  rawBody: string;
  headers: Headers;
};

// Returns the HTTP status to answer with. PayPal repeats a delivery that gets anything but 2xx,
// up to 25 times over 3 days, so a 5xx is how a failure here gets retried. A 4xx means this was
// not a usable delivery at all, and it writes nothing.
export async function handlePayPalWebhook(
  db: Db,
  { shopSlug, rawBody, headers }: WebhookDelivery,
  deps: ReconcileDeps = defaultReconcileDeps,
): Promise<number> {
  const [shop] = await db
    .select({ id: shops.id, credentialRef: shops.paypalCredentialRef })
    .from(shops)
    .where(eq(shops.slug, shopSlug));
  if (!shop) {
    return 404;
  }

  const signature = readSignature(headers);
  const event = readEvent(rawBody);
  if (!signature || !event) {
    return 400;
  }

  const paypal = deps.paypalFor(shop.credentialRef);
  if (!paypal?.webhookId) {
    console.error("PayPal webhook arrived for a shop with no webhook configured", {
      shopId: shop.id,
    });
    return 503;
  }

  let verified: boolean;
  try {
    verified = await paypal.verifyWebhookSignature(
      paypal.webhookId,
      signature,
      rawBody,
    );
  } catch (thrown) {
    console.error("PayPal webhook verification could not run", {
      shopId: shop.id,
      ...describePayPalFailure(thrown),
    });
    return 503;
  }
  if (!verified) {
    console.warn("Rejected a PayPal webhook with an invalid signature", {
      shopId: shop.id,
    });
    return 400;
  }

  const handled = HANDLED_EVENTS.has(event.event_type);
  const order = handled ? await findEventOrder(db, shop.id, event) : undefined;

  const [inserted] = await db
    .insert(webhookReceipts)
    .values({
      providerEventId: event.id,
      eventType: event.event_type,
      resourceId: asString(event.resource.id),
      shopId: shop.id,
      orderId: order?.id,
      status: order ? "received" : "ignored",
      payload: receiptPayload(event),
    })
    .onConflictDoNothing({ target: webhookReceipts.providerEventId })
    .returning({ id: webhookReceipts.id });

  if (!inserted) {
    const [existing] = await db
      .select({ status: webhookReceipts.status })
      .from(webhookReceipts)
      .where(eq(webhookReceipts.providerEventId, event.id));
    // Anything else is an attempt that failed or stopped halfway, and this is its redelivery.
    if (existing?.status === "processed" || existing?.status === "ignored") {
      return 200;
    }
  }
  if (!order) {
    return 200;
  }

  const settle = (status: "processed" | "failed") =>
    db
      .update(webhookReceipts)
      .set({ status, processedAt: status === "processed" ? new Date() : null })
      .where(eq(webhookReceipts.providerEventId, event.id));

  try {
    await reconcileOrder(db, order.id, deps);
  } catch (error) {
    console.error("PayPal webhook could not settle its order", {
      orderId: order.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    await settle("failed");
    return 503;
  }
  await settle("processed");
  return 200;
}

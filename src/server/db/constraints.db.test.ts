import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import {
  NOON,
  createBooking,
  createOrder,
  createOrderLine,
  createProduct,
  createService,
  createShop,
  createTechnician,
  hoursAfterNoon,
  violatedConstraint,
} from "../../../test/fixtures";
import {
  bookings,
  importJobs,
  orderLines,
  orders,
  products,
  searchEvents,
  webhookReceipts,
} from "./schema";

const getDb = setupMigratedDatabase();

const twoShops = async () => [
  await createShop(getDb()),
  await createShop(getDb()),
];

describe("tenant ownership", () => {
  it("rejects an order line for another shop's product", async () => {
    const [shopA, shopB] = await twoShops();
    const order = await createOrder(getDb(), shopA.id);
    const foreignProduct = await createProduct(getDb(), shopB.id);
    expect(
      await violatedConstraint(
        createOrderLine(getDb(), order, foreignProduct.id),
      ),
    ).toBe("order_lines_product_shop_fk");
  });

  it("rejects an order line claiming a different shop than its order", async () => {
    const [shopA, shopB] = await twoShops();
    const order = await createOrder(getDb(), shopA.id);
    const product = await createProduct(getDb(), shopB.id);
    expect(
      await violatedConstraint(
        createOrderLine(getDb(), { ...order, shopId: shopB.id }, product.id),
      ),
    ).toBe("order_lines_order_shop_fk");
  });

  it("rejects a booking that mixes shops", async () => {
    const [shopA, shopB] = await twoShops();
    const service = await createService(getDb(), shopA.id);
    const technician = await createTechnician(getDb(), shopA.id);
    const foreignService = await createService(getDb(), shopB.id);
    const foreignTechnician = await createTechnician(getDb(), shopB.id);
    const foreignOrder = await createOrder(getDb(), shopB.id);

    expect(
      await violatedConstraint(
        createBooking(getDb(), shopA.id, foreignService.id, technician.id),
      ),
    ).toBe("bookings_service_shop_fk");
    expect(
      await violatedConstraint(
        createBooking(getDb(), shopA.id, service.id, foreignTechnician.id),
      ),
    ).toBe("bookings_technician_shop_fk");
    expect(
      await violatedConstraint(
        createBooking(getDb(), shopA.id, service.id, technician.id, {
          orderId: foreignOrder.id,
        }),
      ),
    ).toBe("bookings_order_shop_fk");
  });

  it("rejects a product for a shop that does not exist", async () => {
    expect(
      await violatedConstraint(
        createProduct(getDb(), "99999999-9999-4999-8999-999999999999"),
      ),
    ).toBe("products_shop_id_shops_id_fk");
  });
});

describe("unique provider identifiers", () => {
  it("rejects a repeated PayPal order, capture and idempotency key", async () => {
    const shop = await createShop(getDb());
    await createOrder(getDb(), shop.id, {
      idempotencyKey: "same-key-0000000",
      paypalOrderId: "PAYPAL-ORDER-1",
      paypalCaptureId: "PAYPAL-CAPTURE-1",
    });
    expect(
      await violatedConstraint(
        createOrder(getDb(), shop.id, { paypalOrderId: "PAYPAL-ORDER-1" }),
      ),
    ).toBe("orders_paypal_order_id_unique");
    expect(
      await violatedConstraint(
        createOrder(getDb(), shop.id, { paypalCaptureId: "PAYPAL-CAPTURE-1" }),
      ),
    ).toBe("orders_paypal_capture_id_unique");
    expect(
      await violatedConstraint(
        createOrder(getDb(), shop.id, { idempotencyKey: "same-key-0000000" }),
      ),
    ).toBe("orders_idempotency_key_unique");
  });

  it("applies across shops, so one PayPal order cannot belong to two sellers", async () => {
    const [shopA, shopB] = await twoShops();
    await createOrder(getDb(), shopA.id, { paypalOrderId: "PAYPAL-ORDER-2" });
    expect(
      await violatedConstraint(
        createOrder(getDb(), shopB.id, { paypalOrderId: "PAYPAL-ORDER-2" }),
      ),
    ).toBe("orders_paypal_order_id_unique");
  });

  it("rejects a repeated webhook event", async () => {
    const receipt = {
      providerEventId: "WH-EVENT-1",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      payload: {},
    };
    await getDb().insert(webhookReceipts).values(receipt);
    expect(
      await violatedConstraint(
        getDb().insert(webhookReceipts).values(receipt),
      ),
    ).toBe("webhook_receipts_provider_event_id_unique");
  });

  it("rejects a repeated PayPal product, merchant and workflow run", async () => {
    const shop = await createShop(getDb(), { paypalMerchantId: "MERCHANT-1" });
    await createProduct(getDb(), shop.id, { paypalProductId: "PROD-1" });
    expect(
      await violatedConstraint(
        createProduct(getDb(), shop.id, { paypalProductId: "PROD-1" }),
      ),
    ).toBe("products_paypal_product_id_unique");
    expect(
      await violatedConstraint(
        createShop(getDb(), { paypalMerchantId: "MERCHANT-1" }),
      ),
    ).toBe("shops_paypal_merchant_id_unique");

    const job = {
      shopId: shop.id,
      sourceKind: "csv",
      workflowRunId: "RUN-1",
    } as const;
    await getDb().insert(importJobs).values(job);
    expect(
      await violatedConstraint(getDb().insert(importJobs).values(job)),
    ).toBe("import_jobs_workflow_run_id_unique");
  });
});

describe("money", () => {
  it("rejects a zero or negative price", async () => {
    const shop = await createShop(getDb());
    for (const priceMinor of [0, -100]) {
      expect(
        await violatedConstraint(
          createProduct(getDb(), shop.id, { priceMinor }),
        ),
      ).toBe("products_price_positive");
    }
  });

  it("cannot store a fractional amount", async () => {
    const shop = await createShop(getDb());
    await expect(
      createProduct(getDb(), shop.id, { priceMinor: 12.5 }),
    ).rejects.toThrow();
    await expect(
      createOrder(getDb(), shop.id, { totalMinor: 9.9 }),
    ).rejects.toThrow();
  });

  it("rejects an order with no amount and a line whose total does not add up", async () => {
    const shop = await createShop(getDb());
    const product = await createProduct(getDb(), shop.id);
    expect(
      await violatedConstraint(
        createOrder(getDb(), shop.id, { totalMinor: 0 }),
      ),
    ).toBe("orders_total_positive");

    const order = await createOrder(getDb(), shop.id);
    expect(
      await violatedConstraint(
        createOrderLine(getDb(), order, product.id, {
          quantity: 2,
          lineTotalMinor: 1,
        }),
      ),
    ).toBe("order_lines_total_matches");
  });

  it("rejects a deposit above the service price", async () => {
    const shop = await createShop(getDb());
    expect(
      await violatedConstraint(
        createService(getDb(), shop.id, { priceMinor: 1000, depositMinor: 1001 }),
      ),
    ).toBe("products_deposit_within_price");
  });
});

describe("publication rules", () => {
  it("lets a draft have an unknown price but never a published product", async () => {
    const shop = await createShop(getDb());
    const draft = await createProduct(getDb(), shop.id, {
      status: "draft",
      priceMinor: null,
    });
    expect(draft.priceMinor).toBeNull();
    expect(
      await violatedConstraint(
        getDb()
          .update(products)
          .set({ status: "published" })
          .where(eq(products.id, draft.id)),
      ),
    ).toBe("products_published_requires_price");
  });

  it("requires duration and deposit before a service is published", async () => {
    const shop = await createShop(getDb());
    expect(
      await violatedConstraint(
        createService(getDb(), shop.id, { serviceDurationMinutes: null }),
      ),
    ).toBe("products_published_service_requires_terms");
  });

  it("keeps service terms off ordinary products", async () => {
    const shop = await createShop(getDb());
    expect(
      await violatedConstraint(
        createProduct(getDb(), shop.id, { depositMinor: 100 }),
      ),
    ).toBe("products_service_fields_only_on_services");
  });
});

describe("order state", () => {
  it("cannot be paid without a capture", async () => {
    const shop = await createShop(getDb());
    expect(
      await violatedConstraint(
        createOrder(getDb(), shop.id, { paymentStatus: "paid" }),
      ),
    ).toBe("orders_paid_requires_capture");

    const order = await createOrder(getDb(), shop.id);
    expect(
      await violatedConstraint(
        getDb()
          .update(orders)
          .set({ paymentStatus: "paid" })
          .where(eq(orders.id, order.id)),
      ),
    ).toBe("orders_paid_requires_capture");

    const [paid] = await getDb()
      .update(orders)
      .set({ paymentStatus: "paid", paypalCaptureId: "PAYPAL-CAPTURE-3" })
      .where(eq(orders.id, order.id))
      .returning();
    expect(paid.paymentStatus).toBe("paid");
  });

  it.each([
    ["total", { totalMinor: 1 }],
    ["currency", { currency: "USD" }],
    ["recipient", { payeeMerchantId: "ATTACKER" }],
  ])("cannot have its %s changed after creation", async (_name, change) => {
    const shop = await createShop(getDb());
    const order = await createOrder(getDb(), shop.id);
    expect(
      await violatedConstraint(
        getDb().update(orders).set(change).where(eq(orders.id, order.id)),
      ),
    ).toBe("orders_terms_immutable");
  });

  it("keeps line snapshots immutable while the catalog changes", async () => {
    const shop = await createShop(getDb());
    const product = await createProduct(getDb(), shop.id);
    const order = await createOrder(getDb(), shop.id);
    const line = await createOrderLine(getDb(), order, product.id);

    expect(
      await violatedConstraint(
        getDb()
          .update(orderLines)
          .set({ title: "Changed" })
          .where(eq(orderLines.id, line.id)),
      ),
    ).toBe("order_lines_immutable");
    expect(
      await violatedConstraint(
        getDb().delete(orderLines).where(eq(orderLines.id, line.id)),
      ),
    ).toBe("order_lines_immutable");

    await getDb()
      .update(products)
      .set({ priceMinor: 5000, title: "Renamed" })
      .where(eq(products.id, product.id));
    const [unchanged] = await getDb()
      .select()
      .from(orderLines)
      .where(eq(orderLines.id, line.id));
    expect(unchanged).toMatchObject({
      unitPriceMinor: 990,
      title: "Test cable",
    });
  });

  it("does not let a sold product be deleted", async () => {
    const shop = await createShop(getDb());
    const product = await createProduct(getDb(), shop.id);
    const order = await createOrder(getDb(), shop.id);
    await createOrderLine(getDb(), order, product.id);
    expect(
      await violatedConstraint(
        getDb().delete(products).where(eq(products.id, product.id)),
      ),
    ).toBe("order_lines_product_shop_fk");
  });
});

describe("bookings", () => {
  const bookingContext = async () => {
    const shop = await createShop(getDb());
    const service = await createService(getDb(), shop.id);
    const technician = await createTechnician(getDb(), shop.id);
    return { shop, service, technician };
  };

  it("cannot overlap for one technician", async () => {
    const { shop, service, technician } = await bookingContext();
    await createBooking(getDb(), shop.id, service.id, technician.id);
    expect(
      await violatedConstraint(
        createBooking(getDb(), shop.id, service.id, technician.id, {
          startsAt: hoursAfterNoon(0.5),
          endsAt: hoursAfterNoon(1.5),
        }),
      ),
    ).toBe("bookings_technician_no_overlap");
  });

  it("gives one winner when requests for the same interval race", async () => {
    const { shop, service, technician } = await bookingContext();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        createBooking(getDb(), shop.id, service.id, technician.id),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("allows adjacent appointments and other technicians", async () => {
    const { shop, service, technician } = await bookingContext();
    const other = await createTechnician(getDb(), shop.id);
    await createBooking(getDb(), shop.id, service.id, technician.id);
    await createBooking(getDb(), shop.id, service.id, technician.id, {
      startsAt: hoursAfterNoon(1),
      endsAt: hoursAfterNoon(2),
    });
    await createBooking(getDb(), shop.id, service.id, other.id);
  });

  it.each(["expired", "cancelled", "review_required"] as const)(
    "releases the slot once a booking is %s",
    async (status) => {
      const { shop, service, technician } = await bookingContext();
      const first = await createBooking(
        getDb(),
        shop.id,
        service.id,
        technician.id,
      );
      await getDb()
        .update(bookings)
        .set({ status })
        .where(eq(bookings.id, first.id));
      await createBooking(getDb(), shop.id, service.id, technician.id);
    },
  );

  it("cannot be confirmed without its own order's capture", async () => {
    const { shop, service, technician } = await bookingContext();
    const booking = await createBooking(
      getDb(),
      shop.id,
      service.id,
      technician.id,
    );
    const confirm = (depositCaptureId: string | null) =>
      getDb()
        .update(bookings)
        .set({ status: "confirmed", depositCaptureId })
        .where(eq(bookings.id, booking.id))
        .returning();

    expect(await violatedConstraint(confirm(null))).toBe(
      "bookings_confirmed_requires_capture",
    );

    await createOrder(getDb(), shop.id, { paypalCaptureId: "OTHER-CAPTURE" });
    expect(await violatedConstraint(confirm("OTHER-CAPTURE"))).toBe(
      "bookings_order_capture_fk",
    );

    await getDb()
      .update(orders)
      .set({ paymentStatus: "paid", paypalCaptureId: "OWN-CAPTURE" })
      .where(eq(orders.id, booking.orderId));
    const [confirmed] = await confirm("OWN-CAPTURE");
    expect(confirmed.status).toBe("confirmed");
  });

  it("allows one booking per deposit order and needs a real interval", async () => {
    const { shop, service, technician } = await bookingContext();
    const first = await createBooking(
      getDb(),
      shop.id,
      service.id,
      technician.id,
    );
    expect(
      await violatedConstraint(
        createBooking(getDb(), shop.id, service.id, technician.id, {
          orderId: first.orderId,
          startsAt: hoursAfterNoon(3),
          endsAt: hoursAfterNoon(4),
        }),
      ),
    ).toBe("bookings_order_id_unique");
    expect(
      await violatedConstraint(
        createBooking(getDb(), shop.id, service.id, technician.id, {
          startsAt: NOON,
          endsAt: NOON,
        }),
      ),
    ).toBe("bookings_ends_after_start");
  });
});

describe("value formats", () => {
  it("rejects malformed shop values", async () => {
    expect(
      await violatedConstraint(createShop(getDb(), { currency: "eur" })),
    ).toBe("shops_currency_format");
    expect(
      await violatedConstraint(createShop(getDb(), { slug: "Not A Slug" })),
    ).toBe("shops_slug_format");
    expect(
      await violatedConstraint(
        createShop(getDb(), { paypalCredentialRef: "secret-value!" }),
      ),
    ).toBe("shops_paypal_credential_ref_format");
  });

  it("bounds what a search event can store", async () => {
    expect(
      await violatedConstraint(
        getDb()
          .insert(searchEvents)
          .values({ queryNormalized: "x".repeat(201), resultCount: 0 }),
      ),
    ).toBe("search_events_query_length");
  });
});

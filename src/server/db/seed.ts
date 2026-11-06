import { hashAccessCode } from "../auth/access-code";
import type { Db } from "./client";
import { products, shops, technicians, technicianWindows } from "./schema";

// Synthetic demo data. The identifiers are fixed, so seeding again updates these rows
// instead of adding new ones. Every other row in the database is left alone.
export const DEMO_SHOP_ID = "10000000-0000-4000-8000-000000000001";
export const DEMO_PRODUCT_ID = "20000000-0000-4000-8000-000000000001";
export const DEMO_SERVICE_ID = "20000000-0000-4000-8000-000000000002";
export const DEMO_TECHNICIAN_IDS = [
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
] as const;

type SeedEnv = Record<string, string | undefined>;

export async function seedDemoData(
  db: Db,
  env: SeedEnv = process.env,
): Promise<void> {
  const merchantId = env.DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID || undefined;
  const accessCode = env.DEMO_PHONE_WORKSHOP_SELLER_CODE || undefined;

  // Optional, and only written when provided, so a seed without them keeps existing values.
  const accountSettings = {
    ...(merchantId ? { paypalMerchantId: merchantId } : {}),
    ...(accessCode
      ? { sellerAccessCodeHash: await hashAccessCode(accessCode) }
      : {}),
  };

  const shop = {
    slug: "demo-phone-workshop",
    name: "Demo Phone Workshop",
    location: "Liepaja",
    currency: "EUR",
    timezone: "Europe/Riga",
    paypalCredentialRef: "DEMO_PHONE_WORKSHOP",
  };

  const product = {
    shopId: DEMO_SHOP_ID,
    kind: "product",
    status: "published",
    title: "iPhone 13 tempered glass screen protector",
    description: "Synthetic demo listing. 9H tempered glass for iPhone 13.",
    priceMinor: 990,
    availability: "available",
  } as const;

  const service = {
    shopId: DEMO_SHOP_ID,
    kind: "service",
    status: "published",
    title: "iPhone 13 screen replacement",
    description:
      "Synthetic demo listing. Screen replacement for iPhone 13, done at the workshop while you wait.",
    priceMinor: 8000,
    serviceDurationMinutes: 60,
    depositMinor: 2000,
    availability: "available",
  } as const;

  const staff = [
    { id: DEMO_TECHNICIAN_IDS[0], shopId: DEMO_SHOP_ID, name: "Technician Anna" },
    { id: DEMO_TECHNICIAN_IDS[1], shopId: DEMO_SHOP_ID, name: "Technician Marek" },
  ];

  // Monday to Friday, 09:00 to 18:00 in the shop's time, and Anna also on Saturday mornings.
  const windows = [
    ...staff.flatMap(({ id: technicianId }, person) =>
      [1, 2, 3, 4, 5].map((weekday) => ({
        id: `40000000-0000-4000-8000-0000000000${person}${weekday}`,
        shopId: DEMO_SHOP_ID,
        technicianId,
        weekday,
        startMinute: 9 * 60,
        endMinute: 18 * 60,
      })),
    ),
    {
      id: "40000000-0000-4000-8000-000000000006",
      shopId: DEMO_SHOP_ID,
      technicianId: DEMO_TECHNICIAN_IDS[0],
      weekday: 6,
      startMinute: 10 * 60,
      endMinute: 14 * 60,
    },
  ];

  await db.transaction(async (tx) => {
    await tx
      .insert(shops)
      .values({ id: DEMO_SHOP_ID, ...shop, ...accountSettings })
      .onConflictDoUpdate({
        target: shops.id,
        set: { ...shop, ...accountSettings },
      });
    await tx
      .insert(products)
      .values({ id: DEMO_PRODUCT_ID, ...product })
      .onConflictDoUpdate({ target: products.id, set: product });
    await tx
      .insert(products)
      .values({ id: DEMO_SERVICE_ID, ...service })
      .onConflictDoUpdate({ target: products.id, set: service });
    for (const person of staff) {
      await tx
        .insert(technicians)
        .values(person)
        .onConflictDoUpdate({ target: technicians.id, set: { name: person.name } });
    }
    for (const window of windows) {
      await tx
        .insert(technicianWindows)
        .values(window)
        .onConflictDoUpdate({
          target: technicianWindows.id,
          set: {
            weekday: window.weekday,
            startMinute: window.startMinute,
            endMinute: window.endMinute,
          },
        });
    }
  });
}

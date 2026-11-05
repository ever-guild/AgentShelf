import { hashAccessCode } from "../auth/access-code";
import type { Db } from "./client";
import { products, shops } from "./schema";

// Synthetic demo data. The identifiers are fixed, so seeding again updates these rows
// instead of adding new ones. Every other row in the database is left alone.
export const DEMO_SHOP_ID = "10000000-0000-4000-8000-000000000001";
export const DEMO_PRODUCT_ID = "20000000-0000-4000-8000-000000000001";

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
  });
}

import { hashAccessCode } from "../auth/access-code";
import { addDays, demoInstant, resolveDemoDate } from "../domain/demo-calendar";
import type { Db } from "./client";
import {
  products,
  searchEvents,
  shops,
  technicians,
  technicianWindows,
} from "./schema";

// Synthetic demo data, written for this repository. No real shop, person or customer is behind any
// of it, and none of it records a payment. docs/architecture.md says where each part comes from.
// The identifiers are fixed, so seeding again updates these rows instead of adding new ones. Every
// other row in the database is left alone.
export const DEMO_SHOP_ID = "10000000-0000-4000-8000-000000000001";
export const DEMO_SECOND_SHOP_ID = "10000000-0000-4000-8000-000000000002";
export const DEMO_SHOP_IDS = [DEMO_SHOP_ID, DEMO_SECOND_SHOP_ID] as const;
export const DEMO_PRODUCT_ID = "20000000-0000-4000-8000-000000000001";
export const DEMO_SERVICE_ID = "20000000-0000-4000-8000-000000000002";
export const DEMO_CHARGER_ID = "20000000-0000-4000-8000-000000000003";
export const DEMO_CABLE_ID = "20000000-0000-4000-8000-000000000004";
export const DEMO_CANDLE_ID = "20000000-0000-4000-8000-000000000101";
export const DEMO_TECHNICIAN_IDS = [
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
] as const;

type SeedEnv = Record<string, string | undefined>;

type DemoProduct = typeof products.$inferInsert;

const phoneProducts: DemoProduct[] = [
  {
    id: DEMO_PRODUCT_ID,
    shopId: DEMO_SHOP_ID,
    kind: "product",
    status: "published",
    title: "iPhone 13 tempered glass screen protector",
    description: "Synthetic demo listing. 9H tempered glass for iPhone 13.",
    priceMinor: 990,
    availability: "available",
  },
  {
    id: DEMO_SERVICE_ID,
    shopId: DEMO_SHOP_ID,
    kind: "service",
    status: "published",
    title: "iPhone 13 screen replacement",
    description:
      "Synthetic demo listing. Screen repair for iPhone 13: a cracked screen replaced at the workshop while you wait.",
    priceMinor: 8000,
    serviceDurationMinutes: 60,
    depositMinor: 2000,
    availability: "available",
  },
  // Selling a charger is what makes a missing MagSafe charger this shop's unmet demand.
  {
    id: DEMO_CHARGER_ID,
    shopId: DEMO_SHOP_ID,
    kind: "product",
    status: "published",
    title: "USB-C wall charger",
    description: "Synthetic demo listing. Wall charger with one USB-C port.",
    priceMinor: 1490,
    availability: "available",
  },
  {
    id: DEMO_CABLE_ID,
    shopId: DEMO_SHOP_ID,
    kind: "product",
    status: "published",
    title: "USB-C to Lightning cable, 1 m",
    description: "Synthetic demo listing. Lightning cable, one metre, for sync and power.",
    priceMinor: 750,
    availability: "available",
  },
];

// A shop of another kind, with no repairs and no appointments, to show that nothing is built for
// phones alone.
const candleProducts: DemoProduct[] = [
  {
    id: DEMO_CANDLE_ID,
    shopId: DEMO_SECOND_SHOP_ID,
    kind: "product",
    status: "published",
    title: "Soy candle, vanilla, 180 g",
    description: "Synthetic demo listing. Hand-poured soy wax candle with a cotton wick.",
    priceMinor: 1250,
    availability: "available",
  },
  {
    id: "20000000-0000-4000-8000-000000000102",
    shopId: DEMO_SECOND_SHOP_ID,
    kind: "product",
    status: "published",
    title: "Soy candle, cedar, 180 g",
    description: "Synthetic demo listing. Hand-poured soy wax candle scented with cedar.",
    priceMinor: 1250,
    availability: "available",
  },
  {
    id: "20000000-0000-4000-8000-000000000103",
    shopId: DEMO_SECOND_SHOP_ID,
    kind: "product",
    status: "published",
    title: "Candle gift set of three",
    description: "Synthetic demo listing. Three small soy candles in a paper box.",
    priceMinor: 3200,
    availability: "available",
  },
  {
    id: "20000000-0000-4000-8000-000000000104",
    shopId: DEMO_SECOND_SHOP_ID,
    kind: "product",
    status: "published",
    title: "Brass wick trimmer",
    description: "Synthetic demo listing. Trims a wick to the right length.",
    priceMinor: 900,
    availability: "available",
  },
];

export const DEMO_PRODUCTS: readonly DemoProduct[] = [...phoneProducts, ...candleProducts];

const staff = [
  { id: DEMO_TECHNICIAN_IDS[0], shopId: DEMO_SHOP_ID, name: "Technician Anna" },
  { id: DEMO_TECHNICIAN_IDS[1], shopId: DEMO_SHOP_ID, name: "Technician Marek" },
];

// Monday to Friday, 09:00 to 18:00 in the shop's time, Anna on Saturday mornings and Marek on
// Sunday mornings, so that "tomorrow before noon" has a slot whatever day tomorrow is.
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
  {
    id: "40000000-0000-4000-8000-000000000017",
    shopId: DEMO_SHOP_ID,
    technicianId: DEMO_TECHNICIAN_IDS[1],
    weekday: 7,
    startMinute: 10 * 60,
    endMinute: 14 * 60,
  },
];

export const DEMO_TECHNICIANS = staff;
export const DEMO_WINDOWS = windows;

// Labeled demand, not anyone's activity: every row says origin `fixture`, and none of it is a payment.
// What the attribution columns hold is what the search code would have written for that miss.
// `daysAgo` counts back from the demo date.
type Fixture = {
  n: number;
  daysAgo: number;
  query: string;
  matched?: string[];
  shopId?: string;
  words?: string[];
  basis?: string[];
};

const fixtures: Fixture[] = [
  { n: 1, daysAgo: 6, query: "magsafe charger", shopId: DEMO_SHOP_ID, words: ["charger"], basis: [DEMO_CHARGER_ID] },
  { n: 2, daysAgo: 5, query: "magsafe charger", shopId: DEMO_SHOP_ID, words: ["charger"], basis: [DEMO_CHARGER_ID] },
  { n: 3, daysAgo: 3, query: "wireless magsafe charger", shopId: DEMO_SHOP_ID, words: ["charger"], basis: [DEMO_CHARGER_ID] },
  { n: 4, daysAgo: 2, query: "iphone 15 screen repair", shopId: DEMO_SHOP_ID, words: ["iphone", "screen", "repair"], basis: [DEMO_SERVICE_ID] },
  { n: 5, daysAgo: 4, query: "beeswax candle", shopId: DEMO_SECOND_SHOP_ID, words: ["candle"], basis: [DEMO_CANDLE_ID] },
  { n: 6, daysAgo: 1, query: "horse saddle" },
  { n: 7, daysAgo: 2, query: "iphone 13 screen protector", matched: [DEMO_PRODUCT_ID] },
  { n: 8, daysAgo: 3, query: "soy candle", matched: [DEMO_CANDLE_ID, "20000000-0000-4000-8000-000000000102"] },
];

export const DEMO_FIXTURE_EVENT_IDS = fixtures.map(
  ({ n }) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
);

export async function seedDemoData(
  db: Db,
  env: SeedEnv = process.env,
): Promise<void> {
  const phoneMerchant = env.DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID || undefined;
  const secondMerchant = env.DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID || undefined;
  if (phoneMerchant && phoneMerchant === secondMerchant) {
    // Each shop is paid into its own account, and the database allows an account to belong to one.
    throw new Error("The two demo shops need different PayPal merchant IDs.");
  }
  const demoDate = resolveDemoDate(env);

  // Optional, and only written when provided, so a seed without them keeps existing values.
  const settingsFor = async (merchantId?: string, accessCode?: string) => ({
    ...(merchantId ? { paypalMerchantId: merchantId } : {}),
    ...(accessCode
      ? { sellerAccessCodeHash: await hashAccessCode(accessCode) }
      : {}),
  });

  const demoShops = [
    {
      id: DEMO_SHOP_ID,
      slug: "demo-phone-workshop",
      name: "Demo Phone Workshop",
      location: "Liepaja",
      currency: "EUR",
      timezone: "Europe/Riga",
      paypalCredentialRef: "DEMO_PHONE_WORKSHOP",
      ...(await settingsFor(
        phoneMerchant,
        env.DEMO_PHONE_WORKSHOP_SELLER_CODE || undefined,
      )),
    },
    {
      id: DEMO_SECOND_SHOP_ID,
      slug: "demo-candle-studio",
      name: "Demo Candle Studio",
      location: "Riga",
      currency: "EUR",
      timezone: "Europe/Riga",
      paypalCredentialRef: "DEMO_SECOND_SHOP",
      ...(await settingsFor(
        secondMerchant,
        env.DEMO_SECOND_SHOP_SELLER_CODE || undefined,
      )),
    },
  ];

  await db.transaction(async (tx) => {
    for (const { id, ...shop } of demoShops) {
      await tx
        .insert(shops)
        .values({ id, ...shop })
        .onConflictDoUpdate({ target: shops.id, set: shop });
    }
    for (const { id, ...product } of DEMO_PRODUCTS) {
      await tx
        .insert(products)
        .values({ id, ...product })
        .onConflictDoUpdate({ target: products.id, set: product });
    }
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
    for (const [index, fixture] of fixtures.entries()) {
      const row = {
        searchId: `51000000-0000-4000-8000-${String(fixture.n).padStart(12, "0")}`,
        queryNormalized: fixture.query,
        resultCount: fixture.matched?.length ?? 0,
        matchedProductIds: fixture.matched ?? [],
        attributedShopId: fixture.shopId ?? null,
        attributionWords: fixture.words ?? [],
        attributionProductIds: fixture.basis ?? [],
        origin: "fixture" as const,
        createdAt: demoInstant(addDays(demoDate, -fixture.daysAgo), 10 + (index % 6)),
      };
      await tx
        .insert(searchEvents)
        .values({ id: DEMO_FIXTURE_EVENT_IDS[index], ...row })
        .onConflictDoUpdate({ target: searchEvents.id, set: row });
    }
  });
}

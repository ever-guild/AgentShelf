import { z } from "zod";

const id = z.uuid();
export const inventoryQuantity = z.int().min(1).max(1_000_000);
export const inventoryIdempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const inventoryLine = z.strictObject({ productId: id, quantity: inventoryQuantity });
export const inventoryLines = z
  .array(inventoryLine)
  .min(1)
  .max(50)
  .refine((lines) => new Set(lines.map((line) => line.productId)).size === lines.length, {
    message: "Each product may appear once; combine duplicate quantities.",
  });

export const adjustInventoryInput = z.strictObject({
  productId: id,
  delta: z.int().min(-1_000_000).max(1_000_000).refine((value) => value !== 0),
  expectedVersion: z.int().min(0),
  idempotencyKey: inventoryIdempotencyKey,
  reason: z.string().trim().min(3).max(500),
});

export type InventoryLine = z.infer<typeof inventoryLine>;
export type AdjustInventoryInput = z.infer<typeof adjustInventoryInput>;

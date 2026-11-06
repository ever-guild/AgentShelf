WITH seeded AS (
  INSERT INTO "inventory_stock" ("shop_id", "product_id", "mode", "on_hand", "reserved", "version")
  SELECT p."shop_id", p."id", 'untracked', NULL, 0, 0
  FROM "products" AS p
  WHERE p."kind" = 'product' AND p."import_job_id" IS NULL
  ON CONFLICT ("shop_id", "product_id") DO NOTHING
  RETURNING "shop_id", "product_id"
)
INSERT INTO "inventory_audit" (
  "shop_id", "product_id", "actor_id", "event_type", "quantity_delta", "reason", "idempotency_key", "version_after"
)
SELECT
  seeded."shop_id",
  seeded."product_id",
  '00000000-0000-0000-0000-000000000000'::uuid,
  'mode_set',
  NULL,
  'Legacy product quantity was unknown; kept untracked for compatibility.',
  'migration:0015:legacy-untracked:' || seeded."product_id"::text,
  0
FROM seeded
ON CONFLICT ("shop_id", "idempotency_key") DO NOTHING;

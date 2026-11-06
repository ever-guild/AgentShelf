-- Standalone draft for #36. Do not apply until merged into the repository migration chain.
-- A missing row means inventory policy is undecided and checkout must fail closed.
CREATE TABLE inventory_stock (
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('tracked', 'untracked')),
  on_hand integer,
  reserved integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, product_id),
  FOREIGN KEY (product_id, shop_id) REFERENCES products(id, shop_id) ON DELETE CASCADE,
  CHECK (reserved >= 0 AND reserved <= 1000000),
  CHECK (version >= 0),
  CHECK ((mode = 'tracked' AND on_hand IS NOT NULL AND on_hand >= reserved AND on_hand <= 1000000) OR
         (mode = 'untracked' AND on_hand IS NULL AND reserved = 0))
);

CREATE TABLE inventory_reservations (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  state text NOT NULL CHECK (state IN ('reserved', 'committed', 'released', 'review_required')),
  expires_at timestamptz NOT NULL,
  capture_id text UNIQUE,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, idempotency_key),
  UNIQUE (id, shop_id),
  CHECK ((state = 'committed' AND capture_id IS NOT NULL) OR state <> 'committed'),
  CHECK (state <> 'released' OR release_reason IS NOT NULL)
);

CREATE TABLE inventory_reservation_lines (
  reservation_id uuid NOT NULL,
  shop_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (reservation_id, product_id),
  FOREIGN KEY (reservation_id, shop_id) REFERENCES inventory_reservations(id, shop_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, product_id) REFERENCES inventory_stock(shop_id, product_id)
);

CREATE TABLE inventory_adjustments (
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  result_version integer NOT NULL CHECK (result_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, idempotency_key)
);

CREATE TABLE inventory_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Historical identifiers are kept even if a shop or product is later removed.
  shop_id uuid NOT NULL,
  product_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('mode_set', 'adjusted')),
  quantity_delta integer,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL,
  version_after integer NOT NULL CHECK (version_after >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, idempotency_key)
);

CREATE INDEX inventory_reservations_expiry_idx
  ON inventory_reservations(expires_at) WHERE state = 'reserved';

CREATE FUNCTION inventory_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory audit rows are immutable';
END;
$$;

CREATE TRIGGER inventory_audit_immutable_trigger
  BEFORE UPDATE OR DELETE ON inventory_audit
  FOR EACH ROW EXECUTE FUNCTION inventory_audit_immutable();

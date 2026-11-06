-- Review draft only: do not apply or register until migration ordering and #35 review align.
-- The action_url is intentionally never stored. referral_self_url is the GET-only resource URL
-- used to refresh the single-use action_url after an idempotent start replay.

CREATE TABLE paypal_merchant_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'revoked', 'error')),
  tracking_id text NOT NULL UNIQUE CHECK (tracking_id ~ '^[A-Za-z0-9_-]{40,64}$'),
  request_key_hash text NOT NULL CHECK (request_key_hash ~ '^[a-f0-9]{64}$'),
  consented_by_owner_id uuid NOT NULL,
  share_data_consent_at timestamptz NOT NULL,
  referral_self_url text,
  seller_merchant_id text CHECK (seller_merchant_id IS NULL OR seller_merchant_id ~ '^[A-Za-z0-9_-]{3,128}$'),
  status_evidence jsonb CHECK (status_evidence IS NULL OR jsonb_typeof(status_evidence) = 'object'),
  error_code text CHECK (error_code IS NULL OR error_code IN ('referral_rejected', 'provider_outcome_unknown', 'status_unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paypal_merchant_connections_shop_request_key_unique UNIQUE (shop_id, request_key_hash),
  CONSTRAINT paypal_merchant_connections_consent_membership_fk
    FOREIGN KEY (consented_by_owner_id, shop_id)
    REFERENCES shop_memberships(owner_id, shop_id) ON DELETE RESTRICT
);

-- A shop can have one active referral/connection. Reconnect is allowed only after revocation or
-- a definite failure, and idempotency history remains retained in the rows above.
CREATE UNIQUE INDEX paypal_merchant_connections_one_active_per_shop
  ON paypal_merchant_connections(shop_id)
  WHERE status IN ('pending', 'ready')
    OR (status = 'error' AND (error_code = 'status_unavailable' OR referral_self_url IS NOT NULL));

CREATE INDEX paypal_merchant_connections_shop_latest
  ON paypal_merchant_connections(shop_id, created_at DESC);

-- An active or recoverable merchant account cannot be mapped to more than one shop.
CREATE UNIQUE INDEX paypal_merchant_connections_one_active_seller
  ON paypal_merchant_connections(seller_merchant_id)
  WHERE seller_merchant_id IS NOT NULL AND (
    status IN ('pending', 'ready') OR
    (status = 'error' AND (error_code = 'status_unavailable' OR referral_self_url IS NOT NULL))
  );

CREATE TABLE paypal_merchant_connection_webhook_events (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 200),
  -- NULL is a verified revocation tombstone received before an in-flight referral callback
  -- has persisted the merchant ID. Status refresh checks this ledger before marking ready.
  connection_id uuid REFERENCES paypal_merchant_connections(id) ON DELETE SET NULL,
  seller_merchant_id text NOT NULL CHECK (seller_merchant_id ~ '^[A-Za-z0-9_-]{3,128}$'),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paypal_merchant_connection_webhook_merchant_received_idx
  ON paypal_merchant_connection_webhook_events(seller_merchant_id, received_at);

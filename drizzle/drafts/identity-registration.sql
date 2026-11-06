-- Draft only: merge with the next numbered migration after coordination.
-- This migration deliberately adds tables without changing the existing seller session.
CREATE TABLE seller_owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_owners_username_format CHECK (username ~ '^[a-z0-9_.-]{3,64}$'),
  CONSTRAINT seller_owners_password_hash_format CHECK (
    split_part(password_hash, '$', 1) = 'scrypt' AND
    split_part(password_hash, '$', 2) = '16384' AND
    split_part(password_hash, '$', 3) = '8' AND
    split_part(password_hash, '$', 4) = '1' AND
    split_part(password_hash, '$', 5) ~ '^[A-Za-z0-9_-]{22}$' AND
    split_part(password_hash, '$', 6) ~ '^[A-Za-z0-9_-]{43}$' AND
    split_part(password_hash, '$', 7) = ''
  )
);
CREATE UNIQUE INDEX seller_owners_username_unique ON seller_owners (lower(username));

CREATE TABLE shop_memberships (
  owner_id uuid NOT NULL REFERENCES seller_owners(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'owner',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, shop_id),
  CONSTRAINT shop_memberships_owner_role CHECK (role = 'owner')
);
CREATE INDEX shop_memberships_shop_idx ON shop_memberships (shop_id);

CREATE TABLE owner_sessions (
  token_hash text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES seller_owners(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_sessions_token_hash_format CHECK (token_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX owner_sessions_owner_idx ON owner_sessions (owner_id);

CREATE TABLE seller_agent_grants (
  token_hash text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES seller_owners(id) ON DELETE CASCADE,
  shop_id uuid,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_idempotency_key uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_agent_grants_hash_format CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT seller_agent_grants_membership_fk FOREIGN KEY (owner_id, shop_id) REFERENCES shop_memberships(owner_id, shop_id) ON DELETE CASCADE,
  CONSTRAINT seller_agent_grants_scope CHECK (
    (shop_id IS NULL AND scopes = ARRAY['create_shop']::text[]) OR
    (shop_id IS NOT NULL AND cardinality(scopes) > 0 AND scopes <@ ARRAY['read_shop', 'manage_catalog', 'manage_inventory', 'connect_paypal']::text[])
  ),
  CONSTRAINT seller_agent_grants_consumed_key CHECK ((consumed_at IS NULL) = (consumed_idempotency_key IS NULL))
);
CREATE INDEX seller_agent_grants_owner_idx ON seller_agent_grants (owner_id);

CREATE TABLE seller_identity_operations (
  idempotency_key uuid PRIMARY KEY,
  operation text NOT NULL,
  owner_id uuid REFERENCES seller_owners(id) ON DELETE CASCADE,
  shop_id uuid REFERENCES shops(id) ON DELETE RESTRICT,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_identity_operations_kind CHECK (operation IN ('register_owner_shop', 'create_shop')),
  CONSTRAINT seller_identity_operations_request_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT seller_identity_operations_result_pair CHECK ((owner_id IS NULL) = (shop_id IS NULL))
);

CREATE TABLE seller_identity_attempt_windows (
  key_hash text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL,
  CONSTRAINT seller_identity_attempts_bounded CHECK (attempts BETWEEN 0 AND 1000),
  CONSTRAINT seller_identity_attempt_key_format CHECK (key_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX seller_identity_attempt_window_idx ON seller_identity_attempt_windows (window_started_at);

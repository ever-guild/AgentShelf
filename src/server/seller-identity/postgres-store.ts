import "server-only";

import { createHash, createHmac } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import type {
  SellerAgentGrantPrincipal,
  SellerAgentScope,
  ShopRegistration,
} from "../contracts/seller-identity";
import type {
  AttemptLimiter,
  IdentityStore,
  OwnerRecord,
  OwnerShopRegistration,
  ShopRecord,
} from "./service";
import { IdentityStoreConflict } from "./service";

type Queryable = Pick<Pool, "query">;
type OwnerRow = { id: string; username: string; password_hash: string };
type ShopRow = {
  id: string;
  slug: string;
  name: string;
  location: string | null;
  currency: "EUR";
  timezone: string;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function registrationFingerprint(username: string, shop: ShopRegistration): string {
  return digest(JSON.stringify({ username, name: shop.name, slug: shop.slug, location: shop.location, currency: shop.currency, timezone: shop.timezone }));
}

function shopFingerprint(shop: ShopRegistration): string {
  return digest(JSON.stringify({ name: shop.name, slug: shop.slug, location: shop.location, currency: shop.currency, timezone: shop.timezone }));
}

function mapShop(row: ShopRow): ShopRecord {
  if (row.location === null) throw new Error("Persisted registered shop has no location");
  return { id: row.id, slug: row.slug, name: row.name, location: row.location, currency: row.currency, timezone: row.timezone };
}

async function inTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function reserveOperation(
  client: PoolClient,
  input: { idempotencyKey: string; operation: "register_owner" | "register_owner_shop" | "create_shop"; requestHash: string },
) {
  await client.query(
    `INSERT INTO seller_identity_operations (idempotency_key, operation, request_hash)
     VALUES ($1, $2, $3) ON CONFLICT (idempotency_key) DO NOTHING`,
    [input.idempotencyKey, input.operation, input.requestHash],
  );
  const result = await client.query<{
    operation: string;
    request_hash: string;
    owner_id: string | null;
    shop_id: string | null;
  }>(
    `SELECT operation, request_hash, owner_id, shop_id
       FROM seller_identity_operations WHERE idempotency_key = $1 FOR UPDATE`,
    [input.idempotencyKey],
  );
  const operation = result.rows[0];
  if (!operation || operation.operation !== input.operation || operation.request_hash !== input.requestHash) {
    throw new IdentityStoreConflict("Idempotency conflict");
  }
  return operation;
}

async function fetchShop(client: Queryable, shopId: string): Promise<ShopRecord> {
  const result = await client.query<ShopRow>(
    `SELECT id, slug, name, location, currency, timezone FROM shops WHERE id = $1`,
    [shopId],
  );
  if (!result.rows[0]) throw new Error("Idempotent shop result is unavailable");
  return mapShop(result.rows[0]);
}

async function insertShop(client: PoolClient, shop: ShopRegistration): Promise<ShopRecord> {
  const result = await client.query<ShopRow>(
    `INSERT INTO shops (slug, name, location, currency, timezone, paypal_credential_ref, paypal_merchant_id)
     VALUES ($1, $2, $3, $4, $5, 'UNCONFIGURED', NULL)
     RETURNING id, slug, name, location, currency, timezone`,
    [shop.slug, shop.name, shop.location, shop.currency, shop.timezone],
  );
  return mapShop(result.rows[0]);
}

export class PostgresIdentityStore implements IdentityStore {
  constructor(private readonly pool: Pool) {}

  async findOwnerByUsername(username: string): Promise<OwnerRecord | null> {
    const result = await this.pool.query<OwnerRow>(
      `SELECT id, username, password_hash FROM seller_owners WHERE username = $1`,
      [username],
    );
    const row = result.rows[0];
    return row ? { id: row.id, username: row.username, passwordHash: row.password_hash } : null;
  }

  async findOwnerById(ownerId: string): Promise<Pick<OwnerRecord, "id" | "username"> | null> {
    const result = await this.pool.query<{ id: string; username: string }>(
      `SELECT id, username FROM seller_owners WHERE id = $1`,
      [ownerId],
    );
    return result.rows[0] ?? null;
  }

  async registerOwnerAtomic(input: {
    username: string;
    passwordHash: string;
    idempotencyKey: string;
  }): Promise<{ owner: Pick<OwnerRecord, "id" | "username">; storedPasswordHash: string; replayed: boolean }> {
    return inTransaction(this.pool, async (client) => {
      const operation = await reserveOperation(client, {
        idempotencyKey: input.idempotencyKey,
        operation: "register_owner",
        requestHash: digest(JSON.stringify({ username: input.username })),
      });
      if (operation.owner_id && operation.shop_id === null) {
        const ownerResult = await client.query<OwnerRow>(
          `SELECT id, username, password_hash FROM seller_owners WHERE id = $1`,
          [operation.owner_id],
        );
        const owner = ownerResult.rows[0];
        if (!owner) throw new Error("Idempotent owner result is unavailable");
        return {
          owner: { id: owner.id, username: owner.username },
          storedPasswordHash: owner.password_hash,
          replayed: true,
        };
      }
      if (operation.owner_id || operation.shop_id) throw new IdentityStoreConflict("Owner-only registration key has a different result");
      const ownerResult = await client.query<OwnerRow>(
        `INSERT INTO seller_owners (username, password_hash) VALUES ($1, $2)
         RETURNING id, username, password_hash`,
        [input.username, input.passwordHash],
      );
      const owner = ownerResult.rows[0];
      await client.query(
        `UPDATE seller_identity_operations SET owner_id = $2 WHERE idempotency_key = $1`,
        [input.idempotencyKey, owner.id],
      );
      return {
        owner: { id: owner.id, username: owner.username },
        storedPasswordHash: owner.password_hash,
        replayed: false,
      };
    });
  }

  async registerOwnerAndShopAtomic(input: {
    username: string;
    passwordHash: string;
    shop: ShopRegistration;
    idempotencyKey: string;
  }): Promise<{ registration: OwnerShopRegistration; storedPasswordHash: string; replayed: boolean }> {
    return inTransaction(this.pool, async (client) => {
      const operation = await reserveOperation(client, {
        idempotencyKey: input.idempotencyKey,
        operation: "register_owner_shop",
        requestHash: registrationFingerprint(input.username, input.shop),
      });
      if (operation.owner_id && operation.shop_id) {
        const ownerResult = await client.query<OwnerRow>(
          `SELECT id, username, password_hash FROM seller_owners WHERE id = $1`,
          [operation.owner_id],
        );
        if (!ownerResult.rows[0]) throw new Error("Idempotent owner result is unavailable");
        const owner = ownerResult.rows[0];
        const shop = await fetchShop(client, operation.shop_id);
        return {
          registration: { owner: { id: owner.id, username: owner.username }, shop, role: "owner" },
          storedPasswordHash: owner.password_hash,
          replayed: true,
        };
      }

      const ownerResult = await client.query<OwnerRow>(
        `INSERT INTO seller_owners (username, password_hash) VALUES ($1, $2)
         RETURNING id, username, password_hash`,
        [input.username, input.passwordHash],
      );
      const owner = ownerResult.rows[0];
      const shop = await insertShop(client, input.shop);
      await client.query(
        `INSERT INTO shop_memberships (owner_id, shop_id, role) VALUES ($1, $2, 'owner')`,
        [owner.id, shop.id],
      );
      await client.query(
        `UPDATE seller_identity_operations SET owner_id = $2, shop_id = $3 WHERE idempotency_key = $1`,
        [input.idempotencyKey, owner.id, shop.id],
      );
      return {
        registration: { owner: { id: owner.id, username: owner.username }, shop, role: "owner" },
        storedPasswordHash: owner.password_hash,
        replayed: false,
      };
    });
  }

  async createOwnedShopAtomic(input: {
    ownerId: string;
    shop: ShopRegistration;
    idempotencyKey: string;
  }): Promise<ShopRecord> {
    return inTransaction(this.pool, async (client) => {
      const operation = await reserveOperation(client, {
        idempotencyKey: input.idempotencyKey,
        operation: "create_shop",
        requestHash: digest(JSON.stringify({ ownerId: input.ownerId, shop: shopFingerprint(input.shop) })),
      });
      if (operation.owner_id && operation.shop_id) {
        if (operation.owner_id !== input.ownerId) throw new Error("Idempotency owner mismatch");
        return fetchShop(client, operation.shop_id);
      }
      const shop = await insertShop(client, input.shop);
      await client.query(
        `INSERT INTO shop_memberships (owner_id, shop_id, role) VALUES ($1, $2, 'owner')`,
        [input.ownerId, shop.id],
      );
      await client.query(
        `UPDATE seller_identity_operations SET owner_id = $2, shop_id = $3 WHERE idempotency_key = $1`,
        [input.idempotencyKey, input.ownerId, shop.id],
      );
      return shop;
    });
  }

  async listOwnerShops(ownerId: string): Promise<ShopRecord[]> {
    const result = await this.pool.query<ShopRow>(
      `SELECT s.id, s.slug, s.name, s.location, s.currency, s.timezone
         FROM shop_memberships m JOIN shops s ON s.id = m.shop_id
        WHERE m.owner_id = $1 ORDER BY s.created_at, s.id`,
      [ownerId],
    );
    return result.rows.map(mapShop);
  }

  async findOwnedShop(ownerId: string, shopId: string): Promise<ShopRecord | null> {
    const result = await this.pool.query<ShopRow>(
      `SELECT s.id, s.slug, s.name, s.location, s.currency, s.timezone
         FROM shop_memberships m JOIN shops s ON s.id = m.shop_id
        WHERE m.owner_id = $1 AND m.shop_id = $2`,
      [ownerId, shopId],
    );
    return result.rows[0] ? mapShop(result.rows[0]) : null;
  }

  async createSession(input: { ownerId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await this.pool.query(
      `INSERT INTO owner_sessions (token_hash, owner_id, expires_at) VALUES ($1, $2, $3)`,
      [input.tokenHash, input.ownerId, input.expiresAt],
    );
  }

  async findActiveSession(tokenHash: string, now: Date) {
    const result = await this.pool.query<{ owner_id: string; expires_at: Date }>(
      `SELECT owner_id, expires_at FROM owner_sessions
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [tokenHash, now],
    );
    const row = result.rows[0];
    return row ? { ownerId: row.owner_id, expiresAt: row.expires_at } : null;
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE owner_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE token_hash = $1`,
      [tokenHash, now],
    );
  }

  async createAgentGrant(input: {
    ownerId: string;
    shopId: string | null;
    scopes: SellerAgentScope[];
    tokenHash: string;
    expiresAt: Date;
    shareDataConsentAt: Date | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO seller_agent_grants (token_hash, owner_id, shop_id, scopes, expires_at, share_data_consent_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.tokenHash, input.ownerId, input.shopId, input.scopes, input.expiresAt, input.shareDataConsentAt],
    );
  }

  async findActiveAgentGrant(tokenHash: string, now: Date): Promise<SellerAgentGrantPrincipal | null> {
    const result = await this.pool.query<{
      owner_id: string;
      shop_id: string | null;
      scopes: SellerAgentScope[];
      expires_at: Date;
      revoked_at: Date | null;
      share_data_consent_at: Date | null;
    }>(
      `SELECT owner_id, shop_id, scopes, expires_at, revoked_at, share_data_consent_at FROM seller_agent_grants
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [tokenHash, now],
    );
    const row = result.rows[0];
    return row ? {
      actorId: row.owner_id,
      shopId: row.shop_id,
      scopes: row.scopes,
      expiresAt: row.expires_at,
      shareDataConsent: row.share_data_consent_at !== null,
      shareDataConsentAt: row.share_data_consent_at,
    } : null;
  }

  async revokeAgentGrant(tokenHash: string, ownerId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE seller_agent_grants SET revoked_at = COALESCE(revoked_at, $3)
        WHERE token_hash = $1 AND owner_id = $2`,
      [tokenHash, ownerId, now],
    );
  }

  async createAgentShopAtomic(input: {
    grantTokenHash: string;
    shop: ShopRegistration;
    idempotencyKey: string;
    now: Date;
  }): Promise<{ ownerId: string; shop: ShopRecord } | null> {
    return inTransaction(this.pool, async (client) => {
      const grantResult = await client.query<{
        owner_id: string;
        shop_id: string | null;
        scopes: SellerAgentScope[];
        consumed_idempotency_key: string | null;
      }>(
        `SELECT owner_id, shop_id, scopes, consumed_idempotency_key FROM seller_agent_grants
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2 FOR UPDATE`,
        [input.grantTokenHash, input.now],
      );
      const grant = grantResult.rows[0];
      if (!grant || grant.shop_id !== null || !grant.scopes.includes("create_shop")) return null;
      if (grant.consumed_idempotency_key && grant.consumed_idempotency_key !== input.idempotencyKey) return null;

      const operation = await reserveOperation(client, {
        idempotencyKey: input.idempotencyKey,
        operation: "create_shop",
        requestHash: digest(JSON.stringify({ ownerId: grant.owner_id, shop: shopFingerprint(input.shop) })),
      });
      if (operation.owner_id && operation.shop_id) {
        if (operation.owner_id !== grant.owner_id) throw new Error("Idempotency owner mismatch");
        return { ownerId: grant.owner_id, shop: await fetchShop(client, operation.shop_id) };
      }
      const shop = await insertShop(client, input.shop);
      await client.query(
        `INSERT INTO shop_memberships (owner_id, shop_id, role) VALUES ($1, $2, 'owner')`,
        [grant.owner_id, shop.id],
      );
      await client.query(
        `UPDATE seller_identity_operations SET owner_id = $2, shop_id = $3 WHERE idempotency_key = $1`,
        [input.idempotencyKey, grant.owner_id, shop.id],
      );
      await client.query(
        `UPDATE seller_agent_grants SET consumed_at = COALESCE(consumed_at, $2), consumed_idempotency_key = $3 WHERE token_hash = $1`,
        [input.grantTokenHash, input.now, input.idempotencyKey],
      );
      return { ownerId: grant.owner_id, shop };
    });
  }
}

export class PostgresAttemptLimiter implements AttemptLimiter {
  constructor(
    private readonly pool: Pool,
    private readonly keyHashSecret: string,
  ) {
    if (keyHashSecret.length < 32) throw new Error("Attempt limiter secret is not configured");
  }

  async consume(key: string, limit: number, windowMs: number, now: Date): Promise<boolean> {
    const windowStart = new Date(now.getTime() - windowMs);
    await this.pool.query(
      `DELETE FROM seller_identity_attempt_windows WHERE window_started_at < $1`,
      [new Date(now.getTime() - 24 * 60 * 60_000)],
    );
    const result = await this.pool.query<{ attempts: number }>(
      `INSERT INTO seller_identity_attempt_windows (key_hash, window_started_at, attempts)
       VALUES ($1, $2, 1)
       ON CONFLICT (key_hash) DO UPDATE SET
         attempts = CASE WHEN seller_identity_attempt_windows.window_started_at <= $3
                         THEN 1 ELSE LEAST(seller_identity_attempt_windows.attempts + 1, 1000) END,
         window_started_at = CASE WHEN seller_identity_attempt_windows.window_started_at <= $3
                                  THEN $2 ELSE seller_identity_attempt_windows.window_started_at END
       RETURNING attempts`,
      [createHmac("sha256", this.keyHashSecret).update(key).digest("hex"), now, windowStart],
    );
    return result.rows[0].attempts <= limit;
  }
}

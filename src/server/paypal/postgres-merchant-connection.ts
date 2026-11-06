import "server-only";

import type { Pool, PoolClient } from "pg";

import type {
  MerchantConnectionRecord,
  MerchantConnectionRepository,
  MerchantStatusEvidence,
} from "./merchant-connection";

type ConnectionRow = {
  shop_id: string;
  status: MerchantConnectionRecord["status"];
  tracking_id: string;
  request_key_hash: string;
  referral_self_url: string | null;
  seller_merchant_id: string | null;
  status_evidence: MerchantStatusEvidence | null;
  error_code: MerchantConnectionRecord["errorCode"] | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function mapRow(row: ConnectionRow): MerchantConnectionRecord {
  return {
    shopId: row.shop_id,
    status: row.status,
    trackingId: row.tracking_id,
    requestKeyHash: row.request_key_hash,
    ...(row.referral_self_url ? { referralUrl: row.referral_self_url } : {}),
    ...(row.seller_merchant_id ? { sellerMerchantId: row.seller_merchant_id } : {}),
    ...(row.status_evidence ? { evidence: row.status_evidence } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const byShopAndTracking = `SELECT shop_id, status, tracking_id, request_key_hash,
  referral_self_url, seller_merchant_id, status_evidence, error_code, created_at, updated_at
  FROM paypal_merchant_connections WHERE shop_id = $1 AND tracking_id = $2 FOR UPDATE`;

/** Durable repository for the Partner Referrals domain service. The database migration is owned separately. */
export class PostgresMerchantConnectionRepository implements MerchantConnectionRepository {
  constructor(private readonly pool: Pool) {}

  async reserveStart(input: Parameters<MerchantConnectionRepository["reserveStart"]>[0]) {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.shopId]);
      const same = await client.query<ConnectionRow>(
        `SELECT shop_id, status, tracking_id, request_key_hash, referral_self_url,
          seller_merchant_id, status_evidence, error_code, created_at, updated_at
         FROM paypal_merchant_connections WHERE shop_id = $1 AND request_key_hash = $2`,
        [input.shopId, input.requestKeyHash],
      );
      if (same.rows[0]) return { kind: "replay" as const, record: mapRow(same.rows[0]) };

      const active = await client.query<ConnectionRow>(
        `SELECT shop_id, status, tracking_id, request_key_hash, referral_self_url,
          seller_merchant_id, status_evidence, error_code, created_at, updated_at
         FROM paypal_merchant_connections
         WHERE shop_id = $1 AND (
           status IN ('pending', 'ready') OR
           (status = 'error' AND (error_code = 'status_unavailable' OR referral_self_url IS NOT NULL))
         ) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [input.shopId],
      );
      if (active.rows[0]) return { kind: "active" as const, record: mapRow(active.rows[0]) };

      const inserted = await client.query<ConnectionRow>(
        `INSERT INTO paypal_merchant_connections
          (shop_id, status, tracking_id, request_key_hash, created_at, updated_at)
         VALUES ($1, 'pending', $2, $3, $4, $4)
         RETURNING shop_id, status, tracking_id, request_key_hash, referral_self_url,
           seller_merchant_id, status_evidence, error_code, created_at, updated_at`,
        [input.shopId, input.trackingId, input.requestKeyHash, input.now],
      );
      return { kind: "created" as const, record: mapRow(inserted.rows[0]) };
    });
  }

  async getByShop(shopId: string) {
    const result = await this.pool.query<ConnectionRow>(
      `SELECT shop_id, status, tracking_id, request_key_hash, referral_self_url,
        seller_merchant_id, status_evidence, error_code, created_at, updated_at
       FROM paypal_merchant_connections WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [shopId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async getByTrackingId(trackingId: string) {
    const result = await this.pool.query<ConnectionRow>(
      `SELECT shop_id, status, tracking_id, request_key_hash, referral_self_url,
        seller_merchant_id, status_evidence, error_code, created_at, updated_at
       FROM paypal_merchant_connections WHERE tracking_id = $1`,
      [trackingId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async saveReferral(input: Parameters<MerchantConnectionRepository["saveReferral"]>[0]) {
    return transaction(this.pool, async (client) => {
      const current = await client.query<ConnectionRow>(byShopAndTracking, [input.shopId, input.trackingId]);
      const row = current.rows[0];
      if (!row) throw new Error("PayPal connection reservation not found");
      if (row.referral_self_url && row.referral_self_url !== input.referralUrl) {
        throw new Error("PayPal referral resource changed for an existing tracking ID");
      }
      const updated = await client.query<ConnectionRow>(
        `UPDATE paypal_merchant_connections SET referral_self_url = $3, updated_at = $4
         WHERE shop_id = $1 AND tracking_id = $2
         RETURNING shop_id, status, tracking_id, request_key_hash, referral_self_url,
           seller_merchant_id, status_evidence, error_code, created_at, updated_at`,
        [input.shopId, input.trackingId, input.referralUrl, input.now],
      );
      return mapRow(updated.rows[0]);
    });
  }

  async markStartFailure(input: Parameters<MerchantConnectionRepository["markStartFailure"]>[0]) {
    const result = await this.pool.query(
      `UPDATE paypal_merchant_connections SET status = $3, error_code = $4, updated_at = $5
       WHERE shop_id = $1 AND tracking_id = $2 AND status NOT IN ('ready', 'revoked')`,
      [input.shopId, input.trackingId, input.status, input.errorCode, input.now],
    );
    if (result.rowCount !== 1) {
      const current = await this.pool.query(
        "SELECT 1 FROM paypal_merchant_connections WHERE shop_id = $1 AND tracking_id = $2",
        [input.shopId, input.trackingId],
      );
      if (!current.rowCount) throw new Error("PayPal connection reservation not found");
    }
  }

  async saveStatus(input: Parameters<MerchantConnectionRepository["saveStatus"]>[0]) {
    return transaction(this.pool, async (client) => {
      const current = await client.query<ConnectionRow>(byShopAndTracking, [input.shopId, input.trackingId]);
      const row = current.rows[0];
      if (!row) throw new Error("PayPal connection reservation not found");
      if (row.status === "revoked") return mapRow(row);
      if (row.seller_merchant_id && row.seller_merchant_id !== input.sellerMerchantId) {
        throw new Error("PayPal seller is already bound to another merchant ID");
      }
      const updated = await client.query<ConnectionRow>(
        `UPDATE paypal_merchant_connections SET status = $3, seller_merchant_id = $4,
          status_evidence = $5::jsonb, error_code = NULL, updated_at = $6
         WHERE shop_id = $1 AND tracking_id = $2 AND status <> 'revoked'
         RETURNING shop_id, status, tracking_id, request_key_hash, referral_self_url,
           seller_merchant_id, status_evidence, error_code, created_at, updated_at`,
        [input.shopId, input.trackingId, input.status, input.sellerMerchantId, JSON.stringify(input.evidence), input.now],
      );
      return mapRow(updated.rows[0] ?? row);
    });
  }

  async markRevoked(input: Parameters<MerchantConnectionRepository["markRevoked"]>[0]) {
    return transaction(this.pool, async (client) => {
      const matching = await client.query<{ id: string }>(
        `SELECT id FROM paypal_merchant_connections
         WHERE seller_merchant_id = $1
         ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        [input.sellerMerchantId],
      );
      const connectionId = matching.rows[0]?.id;
      if (!connectionId) return "unmatched" as const;
      const event = await client.query(
        `INSERT INTO paypal_merchant_connection_webhook_events (event_id, connection_id, seller_merchant_id, received_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [input.eventId, connectionId, input.sellerMerchantId, input.now],
      );
      if (!event.rowCount) return "duplicate" as const;
      await client.query(
        `UPDATE paypal_merchant_connections SET status = 'revoked', error_code = NULL,
          updated_at = $2 WHERE id = $1 AND status IN ('pending', 'ready', 'error')`,
        [connectionId, input.now],
      );
      return "revoked" as const;
    });
  }
}

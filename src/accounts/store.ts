import type { Pool } from 'pg';
import { digest } from './crypto.js';

/** The account identity limits and counters are keyed on, derived exclusively from the authenticated user. */
export const personalOwner = (userId: string) => `user:${userId}`;

export interface Consumption { allowed: boolean; /** When the bucket's window ends, in epoch milliseconds. */ resetAt: number }

/**
 * What account mode keeps besides Better Auth's own tables: fixed-window counters. There is
 * nothing secret to store (ClinicalTrials.gov needs no key), so there is no keyring.
 */
export class Store {
  constructor(readonly pool: Pool) {}
  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // IF NOT EXISTS alone does not serialize simultaneous first-time DDL.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('ctgov-store-migration'))");
      await client.query(`
      CREATE TABLE IF NOT EXISTS request_limits (
        bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL
      );
      `);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  /** Counts one use of `bucket` in a window of `seconds` that starts at its first use. */
  async consume(bucket: string, maximum: number, seconds: number): Promise<Consumption> {
    const result = await this.pool.query(
      `INSERT INTO request_limits(bucket,count,expires_at) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN request_limits.expires_at<=now() THEN 1 ELSE request_limits.count+1 END,
      expires_at=CASE WHEN request_limits.expires_at<=now() THEN now()+$2*interval '1 second' ELSE request_limits.expires_at END
      RETURNING count, expires_at`,
      [digest(bucket), seconds],
    );
    const row = result.rows[0] as { count: number; expires_at: Date };
    return { allowed: row.count <= maximum, resetAt: new Date(row.expires_at).getTime() };
  }
  async allow(bucket: string, maximum: number, seconds: number) {
    return (await this.consume(bucket, maximum, seconds)).allowed;
  }
  async cleanup() {
    await this.pool.query('DELETE FROM request_limits WHERE expires_at<now()');
  }
}

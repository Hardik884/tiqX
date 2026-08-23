import { Pool } from 'pg';
import type { PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const poolConfig: PoolConfig = {
  connectionString: config.database.url,
  max: config.database.poolMax,
  idleTimeoutMillis: config.database.idleTimeoutMs,
  connectionTimeoutMillis: config.database.connectionTimeoutMs,
  statement_timeout: config.database.statementTimeoutMs,
  application_name: 'tiqx-api',
  // Every session speaks UTC so timestamptz values are read and written
  // consistently regardless of the host's local timezone.
  options: '-c timezone=UTC',
  ...(config.database.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
};

/**
 * Anything that can run a query: the pool itself, or a client bound to an open
 * transaction. Repositories accept this so the same function works inside and
 * outside a transaction.
 */
export type Queryable = Pick<PoolClient, 'query'>;

/**
 * The single connection pool for the process. Every module must query through
 * this file so pool sizing, timeouts and shutdown live in one place.
 */
export const pool = new Pool(poolConfig);

pool.on('error', (error: Error) => {
  // Raised for idle clients dropped by the server; the pool replaces them.
  logger.error('Unexpected PostgreSQL client error', { error: error.message });
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as unknown[] | undefined);
}

/**
 * Runs `fn` inside a transaction, committing on success and rolling back on
 * failure. The client is always returned to the pool.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Cheap liveness probe for the database; throws when unreachable. */
export async function verifyDatabaseConnection(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closePool(): Promise<void> {
  await pool.end();
}

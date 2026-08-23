import type { Queryable } from '../../db/pool.js';
import type { IdempotencyRecord, IdempotencyStatus } from './idempotency.types.js';

interface RecordRow {
  id: string;
  request_hash: string;
  status: IdempotencyStatus;
  response_status: number | null;
  response_body: unknown;
}

/**
 * Tries to claim (user_id, key) for this transaction, returning the new row's
 * id, or null if somebody else already owns the key.
 *
 * This single statement is the whole synchronisation mechanism, and its
 * blocking behaviour is the point rather than a side effect:
 *
 *  - Key is free           -> the row is inserted and the id comes back. This
 *                             transaction owns the key and does the work.
 *  - Key held, uncommitted -> the statement WAITS on the unique index until the
 *                             other transaction commits or aborts. It does not
 *                             fail, and it does not race ahead.
 *  - That other transaction committed -> no row comes back; the caller reads
 *                             the finished record and replays its response.
 *  - That other transaction aborted    -> the insert succeeds after all, so a
 *                             retry of a failed attempt genuinely re-runs.
 *
 * `ON CONFLICT DO NOTHING` is used instead of letting the unique violation
 * raise, because an error would poison the surrounding transaction and this one
 * has a hold to create afterwards.
 *
 * Because the coordination lives in the index, it holds across processes: two
 * API instances behave exactly like two connections from one instance. An
 * in-memory map could not make that claim.
 */
export async function claimIdempotencyKey(
  db: Queryable,
  userId: string,
  key: string,
  requestHash: string,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO idempotency_keys (user_id, "key", request_hash, status)
     VALUES ($1, $2, $3, 'processing')
     ON CONFLICT (user_id, "key") DO NOTHING
     RETURNING id`,
    [userId, key, requestHash],
  );

  return result.rows[0]?.id ?? null;
}

/**
 * Reads the record for one user's key. Scoped by user_id, so a key belonging to
 * another customer is simply not found rather than returned.
 */
export async function findIdempotencyRecord(
  db: Queryable,
  userId: string,
  key: string,
): Promise<IdempotencyRecord | null> {
  const result = await db.query<RecordRow>(
    `SELECT id, request_hash, status, response_status, response_body
     FROM idempotency_keys
     WHERE user_id = $1 AND "key" = $2`,
    [userId, key],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    requestHash: row.request_hash,
    status: row.status,
    responseStatus: row.response_status,
    responseBody: row.response_body,
  };
}

/**
 * Stores the response and marks the record finished. Runs in the same
 * transaction as the work it describes, so the stored response can never
 * outlive - or precede - the thing it claims happened.
 */
export async function completeIdempotencyRecord(
  db: Queryable,
  id: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  await db.query(
    `UPDATE idempotency_keys
     SET status = 'completed', response_status = $2, response_body = $3::jsonb
     WHERE id = $1`,
    [id, responseStatus, JSON.stringify(responseBody)],
  );
}

import type { Queryable } from '../../db/pool.js';

export interface PendingOutboxRow {
  id: string;
  holdId: string;
  attempts: number;
  /**
   * Seconds until the hold expires, computed by PostgreSQL. Floored at 1
   * because Redis rejects a non-positive TTL; a hold that is already past its
   * expiry gets a key that lapses almost immediately, which is harmless since
   * the sweep reads PostgreSQL rather than waiting for the key.
   */
  ttlSeconds: number;
}

export interface DueHoldRow {
  id: string;
}

export interface ActiveHoldRow {
  id: string;
  ttlSeconds: number;
}

/**
 * Claims a batch of unpublished outbox rows for this worker.
 *
 * FOR UPDATE SKIP LOCKED is what makes the worker horizontally scalable. A
 * plain FOR UPDATE would make worker B queue behind worker A on the same row,
 * so two workers would be no faster than one and a slow publish would stall
 * everyone. SKIP LOCKED instead hands B the rows A has not taken:
 *
 *   worker A locks row 1, publishes it
 *   worker B skips row 1, takes row 2
 *
 * The rows stay locked until the caller's transaction ends, which is why the
 * publish and the bookkeeping happen inside that transaction.
 *
 * This is deliberately the opposite of the customer seat path, which uses a
 * plain FOR UPDATE and *waits*. There, skipping a locked seat would mean
 * silently ignoring a seat someone asked for; here, skipping a locked row just
 * means another worker already has it.
 *
 * `available_at <= now()` is what implements backoff: a failed row is pushed
 * into the future and stops being claimed until then.
 */
export async function claimPendingOutboxRows(
  db: Queryable,
  batchSize: number,
): Promise<PendingOutboxRow[]> {
  const result = await db.query<{
    id: string;
    hold_id: string;
    attempts: number;
    ttl_seconds: string;
  }>(
    `SELECT id,
            hold_id,
            attempts,
            GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - now()))))::text AS ttl_seconds
     FROM hold_expiration_outbox
     WHERE processed_at IS NULL
       AND available_at <= now()
     ORDER BY available_at, created_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [batchSize],
  );

  return result.rows.map((row) => ({
    id: row.id,
    holdId: row.hold_id,
    attempts: row.attempts,
    ttlSeconds: Number(row.ttl_seconds),
  }));
}

/** Marks a claimed row published. */
export async function markOutboxProcessed(db: Queryable, id: string): Promise<void> {
  await db.query(
    `UPDATE hold_expiration_outbox
     SET processed_at = now(), last_error = NULL
     WHERE id = $1`,
    [id],
  );
}

/**
 * Records a failed publish and pushes the row into the future.
 *
 * The delay is computed by PostgreSQL from the attempt count, so a worker with
 * a skewed clock cannot schedule a retry in the past and spin on it. Capped, so
 * repeated failures settle into a steady slow retry rather than growing without
 * bound and effectively abandoning the row.
 */
export async function recordOutboxFailure(
  db: Queryable,
  id: string,
  message: string,
  retryBaseMs: number,
  retryMaxMs: number,
): Promise<void> {
  await db.query(
    `UPDATE hold_expiration_outbox
     SET attempts = attempts + 1,
         last_error = left($2, 500),
         available_at = now() + make_interval(
           secs => LEAST($4::double precision, $3::double precision * power(2, attempts)) / 1000.0
         )
     WHERE id = $1`,
    [id, message, retryBaseMs, retryMaxMs],
  );
}

/**
 * Holds whose time is up and which nobody has resolved yet.
 *
 * Served by `reservation_holds_active_expires_at_idx`, the partial index on
 * `(expires_at) WHERE status = 'active'` created with the table - which is
 * exactly this query, so no new index was needed.
 *
 * Deliberately no row lock. Locking holds here would take them *before* the
 * seats, the reverse of the order the reservation path uses, and two
 * transactions taking the same two locks in opposite orders is the definition
 * of a deadlock. This is a candidate list; the locks are taken per hold, seats
 * first, by the caller. Two workers may pick the same candidate, and the loser
 * simply finds the work already done.
 */
export async function findDueHoldIds(db: Queryable, batchSize: number): Promise<string[]> {
  const result = await db.query<DueHoldRow>(
    `SELECT id
     FROM reservation_holds
     WHERE status = 'active' AND expires_at <= now()
     ORDER BY expires_at
     LIMIT $1`,
    [batchSize],
  );
  return result.rows.map((row) => row.id);
}

/** The seats one hold covers, in id order - the order they must be locked in. */
export async function findHoldSeatIds(db: Queryable, holdId: string): Promise<string[]> {
  const result = await db.query<{ show_seat_id: string }>(
    `SELECT show_seat_id
     FROM reservation_hold_seats
     WHERE hold_id = $1
     ORDER BY show_seat_id`,
    [holdId],
  );
  return result.rows.map((row) => row.show_seat_id);
}

/**
 * Takes the write locks on a hold's seats, in id order.
 *
 * Same statement shape and same ordering as the reservation path's seat lock,
 * which is the whole point: both sides of the race take seat locks in ascending
 * id order before touching any hold, so they serialise instead of deadlocking.
 */
export async function lockSeats(db: Queryable, showSeatIds: readonly string[]): Promise<void> {
  if (showSeatIds.length === 0) {
    return;
  }
  await db.query(
    `SELECT id FROM show_seats WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [showSeatIds],
  );
}

export interface LockedHold {
  status: string;
  due: boolean;
  userId: string;
  eventId: string;
}

/**
 * Locks one hold and reports whether it is genuinely expired.
 *
 * `expires_at <= now()` is evaluated here, by PostgreSQL, at the moment the
 * lock is held - not against a timestamp the worker was handed earlier. That
 * re-check is what makes Redis non-authoritative: a signal only ever prompts a
 * look at the database, and the database decides.
 *
 * `user_id`/`event_id` are read alongside the status this function already
 * needed, not for anything expiry itself does with them - they exist so a
 * caller that finds this hold was backing a waitlist offer (see
 * expireHoldInTransaction) can build that offer's expiry notification without
 * a second round trip.
 */
export async function lockHold(db: Queryable, holdId: string): Promise<LockedHold | null> {
  const result = await db.query<{ status: string; due: boolean; user_id: string; event_id: string }>(
    `SELECT status, (expires_at <= now()) AS due, user_id, event_id
     FROM reservation_holds
     WHERE id = $1
     FOR UPDATE`,
    [holdId],
  );

  const row = result.rows[0];
  return row ? { status: row.status, due: row.due, userId: row.user_id, eventId: row.event_id } : null;
}

/** Transitions a locked, verified hold to expired. Returns whether it changed. */
export async function markHoldExpired(db: Queryable, holdId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE reservation_holds
     SET status = 'expired'
     WHERE id = $1 AND status = 'active'`,
    [holdId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Active holds expiring soon, for reconciliation.
 *
 * Bounded by a window and a batch size, and served by the same partial index as
 * the sweep, so this never degenerates into a scan of every hold ever created.
 */
export async function findActiveHoldsExpiringWithin(
  db: Queryable,
  windowSeconds: number,
  batchSize: number,
): Promise<ActiveHoldRow[]> {
  const result = await db.query<{ id: string; ttl_seconds: string }>(
    `SELECT id,
            GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - now()))))::text AS ttl_seconds
     FROM reservation_holds
     WHERE status = 'active'
       AND expires_at > now()
       AND expires_at <= now() + make_interval(secs => $1::double precision)
     ORDER BY expires_at
     LIMIT $2`,
    [windowSeconds, batchSize],
  );

  return result.rows.map((row) => ({ id: row.id, ttlSeconds: Number(row.ttl_seconds) }));
}

/** Counts for the periodic worker summary. */
export async function countPendingOutbox(db: Queryable): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM hold_expiration_outbox WHERE processed_at IS NULL',
  );
  return Number(result.rows[0]!.count);
}

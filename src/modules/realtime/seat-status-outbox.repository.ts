import type { Queryable } from '../../db/pool.js';

export const SEAT_EVENT_TYPES = ['SEAT_HELD', 'SEAT_RELEASED', 'SEAT_BOOKED'] as const;
export type SeatEventType = (typeof SEAT_EVENT_TYPES)[number];

export interface PendingSeatStatusEvent {
  id: string;
  eventId: string;
  showSeatId: string;
  status: 'available' | 'held' | 'booked';
  eventType: SeatEventType;
  seatVersion: string;
  occurredAt: Date;
  attempts: number;
}

/**
 * Claims a batch of unpublished seat-status events.
 *
 * `FOR UPDATE SKIP LOCKED`, identical in shape and purpose to every other
 * outbox claim in this codebase (`claimPendingOutboxRows`,
 * `claimPendingAllocations`): a second worker instance takes whatever this
 * one has not claimed rather than queuing behind it.
 *
 * No coalescing here - see the migration's top comment. Every row is a
 * distinct transition a subscriber must see, so the claim returns rows in
 * the order they occurred, not deduplicated.
 */
export async function claimPendingSeatStatusEvents(
  db: Queryable,
  batchSize: number,
): Promise<PendingSeatStatusEvent[]> {
  const result = await db.query<{
    id: string;
    event_id: string;
    show_seat_id: string;
    status: 'available' | 'held' | 'booked';
    event_type: SeatEventType;
    seat_version: string;
    occurred_at: Date;
    attempts: number;
  }>(
    `SELECT id, event_id, show_seat_id, status, event_type, seat_version, occurred_at, attempts
     FROM seat_status_outbox
     WHERE processed_at IS NULL AND available_at <= now()
     ORDER BY available_at, created_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [batchSize],
  );

  return result.rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    showSeatId: row.show_seat_id,
    status: row.status,
    eventType: row.event_type,
    seatVersion: row.seat_version,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
  }));
}

export async function markSeatStatusEventProcessed(db: Queryable, id: string): Promise<void> {
  await db.query(
    `UPDATE seat_status_outbox SET processed_at = now(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

/** Records a failed publish and backs the row off - the same expression every outbox uses. */
export async function recordSeatStatusEventFailure(
  db: Queryable,
  id: string,
  message: string,
  retryBaseMs: number,
  retryMaxMs: number,
): Promise<void> {
  await db.query(
    `UPDATE seat_status_outbox
     SET attempts = attempts + 1,
         last_error = left($2, 500),
         available_at = now() + make_interval(
           secs => LEAST($4::double precision, $3::double precision * power(2, attempts)) / 1000.0
         )
     WHERE id = $1`,
    [id, message, retryBaseMs, retryMaxMs],
  );
}

/** Pending count for the worker's periodic summary. */
export async function countPendingSeatStatusEvents(db: Queryable): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM seat_status_outbox WHERE processed_at IS NULL',
  );
  return Number(result.rows[0]!.count);
}

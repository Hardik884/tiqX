import type { Queryable } from '../../db/pool.js';
import type { PendingTicketEmailRow, TicketEmailContext } from './ticket-email.types.js';

/**
 * Requests one ticket-delivery email for a booking.
 *
 * `ON CONFLICT (booking_id) DO NOTHING`, exactly like
 * `enqueueHoldExpiration`: the unique index is what makes this idempotent,
 * not application logic. A defensive re-run of ticket issuance that finds
 * tickets already present, and therefore never reaches this call, needs no
 * special-casing here - and if it ever did call this again, the row would
 * simply already exist.
 */
export async function enqueueTicketEmail(db: Queryable, bookingId: string): Promise<void> {
  await db.query(
    `INSERT INTO ticket_email_outbox (booking_id)
     VALUES ($1)
     ON CONFLICT (booking_id) DO NOTHING`,
    [bookingId],
  );
}

/**
 * Claims a batch of unsent ticket emails for this worker.
 *
 * Same statement shape as `claimPendingOutboxRows` in the expiration module:
 * `FOR UPDATE SKIP LOCKED` so multiple worker instances divide the batch
 * instead of queuing behind each other, and `available_at <= now()` is what
 * backoff actually is - a failed row simply is not claimable again until its
 * delay has passed.
 */
export async function claimPendingTicketEmails(
  db: Queryable,
  batchSize: number,
): Promise<PendingTicketEmailRow[]> {
  const result = await db.query<{ id: string; booking_id: string; attempts: number }>(
    `SELECT id, booking_id, attempts
     FROM ticket_email_outbox
     WHERE processed_at IS NULL
       AND available_at <= now()
     ORDER BY available_at, created_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [batchSize],
  );

  return result.rows.map((row) => ({ id: row.id, bookingId: row.booking_id, attempts: row.attempts }));
}

export async function markTicketEmailProcessed(db: Queryable, id: string): Promise<void> {
  await db.query(
    `UPDATE ticket_email_outbox
     SET processed_at = now(), last_error = NULL
     WHERE id = $1`,
    [id],
  );
}

/**
 * Records a failed send and pushes the row into the future.
 *
 * Identical formula to `recordOutboxFailure`: PostgreSQL computes the delay
 * from the attempt count so a skewed worker clock cannot schedule a retry in
 * the past, and it is capped so repeated failures settle into a steady slow
 * retry instead of growing without bound.
 */
export async function recordTicketEmailFailure(
  db: Queryable,
  id: string,
  message: string,
  retryBaseMs: number,
  retryMaxMs: number,
): Promise<void> {
  await db.query(
    `UPDATE ticket_email_outbox
     SET attempts = attempts + 1,
         last_error = left($2, 500),
         available_at = now() + make_interval(
           secs => LEAST($4::double precision, $3::double precision * power(2, attempts)) / 1000.0
         )
     WHERE id = $1`,
    [id, message, retryBaseMs, retryMaxMs],
  );
}

export async function countPendingTicketEmails(db: Queryable): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM ticket_email_outbox WHERE processed_at IS NULL',
  );
  return Number(result.rows[0]!.count);
}

/**
 * Everything needed to compose one booking's ticket email, in one statement.
 *
 * One row per ticket; the header fields (email, booking reference, event,
 * venue, start time) repeat identically on every row and are read from the
 * first one. Ordered by seat position so the email lists tickets the way a
 * customer would expect to see them, matching the seat-map ordering used
 * elsewhere in this codebase.
 *
 * Joins only tables this booking already legitimately reaches - no new
 * coupling, and nothing here is a hold, a reservation, or another booking.
 */
export async function findTicketEmailContext(db: Queryable, bookingId: string): Promise<TicketEmailContext | null> {
  const result = await db.query<{
    to_email: string;
    booking_reference: string;
    event_title: string;
    venue_name: string;
    starts_at: Date;
    ticket_id: string;
    ticket_reference: string;
    seat_label: string;
  }>(
    `SELECT u.email AS to_email,
            b.booking_reference,
            e.title AS event_title,
            v.name AS venue_name,
            e.starts_at,
            t.id AS ticket_id,
            t.ticket_reference,
            vs.row_label || vs.seat_number AS seat_label
     FROM bookings b
     JOIN users u ON u.id = b.user_id
     JOIN events e ON e.id = b.event_id
     JOIN venues v ON v.id = e.venue_id
     JOIN tickets t ON t.booking_id = b.id
     JOIN booking_seats bs ON bs.id = t.booking_seat_id
     JOIN show_seats ss ON ss.id = bs.show_seat_id
     JOIN venue_seats vs ON vs.id = ss.venue_seat_id
     WHERE b.id = $1
     ORDER BY vs.row_label, vs.seat_number`,
    [bookingId],
  );

  const first = result.rows[0];
  if (!first) {
    return null;
  }

  return {
    to: first.to_email,
    bookingReference: first.booking_reference,
    eventTitle: first.event_title,
    venueName: first.venue_name,
    startsAt: first.starts_at,
    tickets: result.rows.map((row) => ({
      ticketReference: row.ticket_reference,
      seatLabel: row.seat_label,
      qrPayload: { v: 1 as const, ticketId: row.ticket_id, ticketReference: row.ticket_reference },
    })),
  };
}

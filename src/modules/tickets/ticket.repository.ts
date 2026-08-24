import { randomBytes } from 'node:crypto';

import type { Queryable } from '../../db/pool.js';
import type { TicketRecord, TicketStatus } from './ticket.types.js';

interface TicketRow {
  id: string;
  booking_id: string;
  booking_seat_id: string;
  ticket_reference: string;
  status: TicketStatus;
  issued_at: Date;
  used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toTicketRecord(row: TicketRow): TicketRecord {
  return {
    id: row.id,
    bookingId: row.booking_id,
    bookingSeatId: row.booking_seat_id,
    ticketReference: row.ticket_reference,
    status: row.status,
    issuedAt: row.issued_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A public ticket reference, e.g. TKT-8K3M9QP2XW7R.
 *
 * Deliberately not the ticket's UUID and not derived from it: a primary key
 * is an internal handle, and a QR code is going to carry this string past the
 * trust boundary into a customer's phone and a door scanner. Crockford-style
 * base32 without the characters people misread aloud - the same alphabet
 * `generateBookingReference` uses, for the same reason: a support agent may
 * read this back over the phone.
 *
 * 12 characters is 60 bits, well past the point where enumeration is
 * practical - unlike `TICKET-1`, `TICKET-2`, which would leak sales volume
 * and let anyone holding one ticket guess the shape of another. The unique
 * constraint on the column is the real collision guarantee; the caller
 * retries on the rare violation, exactly as booking reference generation
 * does.
 */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REFERENCE_BYTES = 12;

export function generateTicketReference(): string {
  const bytes = randomBytes(REFERENCE_BYTES);
  let suffix = '';
  for (const byte of bytes) {
    suffix += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  return `TKT-${suffix}`;
}

export interface LockedBookingForTickets {
  userId: string;
  eventId: string;
  eventOrganiserId: string;
  status: string;
}

/**
 * Locks the booking and reports what issuance, verification and cancellation
 * all need to judge it, joined with the owning event's organiser in the same
 * statement so authorisation needs no second round trip.
 *
 * `FOR UPDATE OF b` takes the lock on `bookings` alone - `events` is read,
 * not locked, the same way `insertBooking` reads `events.currency` without
 * locking it. This is the resource every ticket path shares with booking
 * cancellation, and taking it here first is what makes issuance, verification
 * and cancellation serialise instead of racing - see ticket.service.ts.
 */
export async function lockBookingForTickets(
  db: Queryable,
  bookingId: string,
): Promise<LockedBookingForTickets | null> {
  const result = await db.query<{
    user_id: string;
    event_id: string;
    organiser_id: string;
    status: string;
  }>(
    `SELECT b.user_id, b.event_id, e.organiser_id, b.status
     FROM bookings b
     JOIN events e ON e.id = b.event_id
     WHERE b.id = $1
     FOR UPDATE OF b`,
    [bookingId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    userId: row.user_id,
    eventId: row.event_id,
    eventOrganiserId: row.organiser_id,
    status: row.status,
  };
}

/** How many tickets already exist for a booking - the repeat-issuance guard. */
export async function countTicketsForBooking(db: Queryable, bookingId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM tickets WHERE booking_id = $1',
    [bookingId],
  );
  return Number(result.rows[0]!.count);
}

/**
 * The booking's live seats - the ones a cancellation has not already retired.
 * One ticket is created per row this returns.
 */
export async function findLiveBookingSeatIds(db: Queryable, bookingId: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM booking_seats WHERE booking_id = $1 AND cancelled_at IS NULL ORDER BY id`,
    [bookingId],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Creates one ticket per booking seat, in a single statement.
 *
 * Set-based, like `insertBookingSeats`: a per-seat INSERT would be an N+1
 * round trip for a large booking, inside a transaction already holding the
 * booking's row lock. `unnest` over two parallel arrays pairs each seat with
 * the reference generated for it, so every row gets its own random reference
 * in one round trip rather than one INSERT per ticket.
 */
export async function insertTicketsForSeats(
  db: Queryable,
  bookingId: string,
  bookingSeatIds: readonly string[],
  ticketReferences: readonly string[],
): Promise<TicketRecord[]> {
  const result = await db.query<TicketRow>(
    `INSERT INTO tickets (booking_id, booking_seat_id, ticket_reference, status, issued_at)
     SELECT $1, seat.booking_seat_id, seat.ticket_reference, 'issued', now()
     FROM unnest($2::uuid[], $3::text[]) AS seat(booking_seat_id, ticket_reference)
     RETURNING *`,
    [bookingId, bookingSeatIds, ticketReferences],
  );
  return result.rows.map(toTicketRecord);
}

export async function findTicketsForBooking(db: Queryable, bookingId: string): Promise<TicketRecord[]> {
  const result = await db.query<TicketRow>(
    'SELECT * FROM tickets WHERE booking_id = $1 ORDER BY id',
    [bookingId],
  );
  return result.rows.map(toTicketRecord);
}

/** Which booking a ticket belongs to. Set once at insert and never changed. */
export async function findTicketBookingId(db: Queryable, ticketId: string): Promise<string | null> {
  const result = await db.query<{ booking_id: string }>(
    'SELECT booking_id FROM tickets WHERE id = $1',
    [ticketId],
  );
  return result.rows[0]?.booking_id ?? null;
}

export async function findTicketById(db: Queryable, ticketId: string): Promise<TicketRecord | null> {
  const result = await db.query<TicketRow>('SELECT * FROM tickets WHERE id = $1', [ticketId]);
  const row = result.rows[0];
  return row ? toTicketRecord(row) : null;
}

/**
 * The guarded, atomic accept: `issued` -> `used`, or zero rows if the ticket
 * was not eligible.
 *
 * This single UPDATE *is* the concurrency control for a double scan. Every
 * concurrent caller targets the same row; PostgreSQL lets exactly one of them
 * acquire the row lock and perform the write, and every other one blocks
 * until it commits, then re-evaluates `status = 'issued'` against the row it
 * just committed and finds it false. Nothing in the application decides who
 * won - a second SELECT-then-UPDATE could not make that guarantee, because
 * two callers could both pass the SELECT before either UPDATEs.
 */
export async function markTicketUsed(db: Queryable, ticketId: string): Promise<TicketRecord | null> {
  const result = await db.query<TicketRow>(
    `UPDATE tickets
     SET status = 'used', used_at = now()
     WHERE id = $1 AND status = 'issued'
     RETURNING *`,
    [ticketId],
  );
  const row = result.rows[0];
  return row ? toTicketRecord(row) : null;
}

export interface TicketVerificationContext {
  eventId: string;
  showSeatId: string;
}

/** The event and seat a ticket resolves to, for the verification response. */
export async function findTicketVerificationContext(
  db: Queryable,
  ticketId: string,
): Promise<TicketVerificationContext | null> {
  const result = await db.query<{ event_id: string; show_seat_id: string }>(
    `SELECT b.event_id, bs.show_seat_id
     FROM tickets t
     JOIN booking_seats bs ON bs.id = t.booking_seat_id
     JOIN bookings b ON b.id = t.booking_id
     WHERE t.id = $1`,
    [ticketId],
  );
  const row = result.rows[0];
  return row ? { eventId: row.event_id, showSeatId: row.show_seat_id } : null;
}

/**
 * Whether any ticket of a booking has already been used.
 *
 * The guard that closes the cancellation/verification race: called only after
 * the caller already holds `bookings` FOR UPDATE (see
 * `lockBookingForTickets`), so a concurrent verification has either already
 * committed its `used` row - and this sees it - or is blocked behind the same
 * lock and cannot commit one until this transaction ends.
 */
export async function hasUsedTickets(db: Queryable, bookingId: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM tickets WHERE booking_id = $1 AND status = 'used'
     ) AS exists`,
    [bookingId],
  );
  return result.rows[0]!.exists;
}

import { randomUUID } from 'node:crypto';

import { query, withTransaction } from '../../src/db/pool.js';
import { confirmHoldInTransaction } from '../../src/modules/bookings/booking.service.js';
import { createEvent } from '../../src/modules/events/event.service.js';
import { createHold } from '../../src/modules/reservations/reservation.service.js';

interface IdRow {
  id: string;
}

const createdEventIds: string[] = [];
const createdVenueIds: string[] = [];
const createdUserIds: string[] = [];

export function trackEvent(eventId: string): void {
  createdEventIds.push(eventId);
}

async function seedUser(role: 'customer' | 'organiser'): Promise<string> {
  const result = await query<IdRow>(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [`Test ${role}`, `${role}-${randomUUID()}@example.test`, 'not-a-real-hash', role],
  );

  const id = result.rows[0]!.id;
  createdUserIds.push(id);
  return id;
}

export async function seedOrganiser(): Promise<string> {
  return seedUser('organiser');
}

/** A customer is who places a reservation hold. */
export async function seedCustomer(): Promise<string> {
  return seedUser('customer');
}

export interface SeededVenue {
  venueId: string;
  seatIds: string[];
}

/**
 * Creates a venue with `seatCount` seats in a single row, e.g. A1..A3.
 * `firstSeatNumber` shifts the numbering, so A12..A14 is seedVenue(3, 'A', 12).
 */
export async function seedVenue(
  seatCount: number,
  rowLabel = 'A',
  firstSeatNumber = 1,
  city: string | null = null,
): Promise<SeededVenue> {
  const venue = await query<IdRow>(
    `INSERT INTO venues (name, description, city) VALUES ($1, $2, $3) RETURNING id`,
    [`Test Venue ${randomUUID()}`, 'Created by the test suite', city],
  );

  const venueId = venue.rows[0]!.id;
  createdVenueIds.push(venueId);

  const seatIds: string[] = [];
  const lastSeatNumber = firstSeatNumber + seatCount - 1;
  for (let seatNumber = firstSeatNumber; seatNumber <= lastSeatNumber; seatNumber += 1) {
    const seat = await query<IdRow>(
      `INSERT INTO venue_seats (venue_id, row_label, seat_number, category)
       VALUES ($1, $2, $3, 'standard')
       RETURNING id`,
      [venueId, rowLabel, seatNumber],
    );
    seatIds.push(seat.rows[0]!.id);
  }

  return { venueId, seatIds };
}

/**
 * Removes everything the suite created, in foreign-key safe order. Deleting an
 * event cascades its show_seats, which releases the ON DELETE RESTRICT on the
 * venue seats those rows referenced.
 */
export async function cleanupSeedData(): Promise<void> {
  // Tickets first. Their booking and booking_seat foreign keys are ON DELETE
  // RESTRICT - a ticket must not vanish with a cascade either - so a booking
  // that has tickets cannot be deleted until they are gone.
  await query(
    `DELETE FROM tickets
     WHERE booking_id IN (
       SELECT id FROM bookings
       WHERE user_id = ANY($1::uuid[])
          OR event_id = ANY($2::uuid[])
          OR event_id IN (SELECT id FROM events WHERE venue_id = ANY($3::uuid[]))
     )`,
    [createdUserIds, createdEventIds, createdVenueIds],
  );
  // Bookings next. Their user and event foreign keys are ON DELETE RESTRICT -
  // a financial record must not vanish with a cascade - so nothing below can be
  // removed while a booking still points at it. Deleting the booking takes its
  // booking_seats with it, which in turn releases the RESTRICT those rows hold
  // on show_seats.
  await query(
    `DELETE FROM bookings
     WHERE user_id = ANY($1::uuid[])
        OR event_id = ANY($2::uuid[])
        OR event_id IN (SELECT id FROM events WHERE venue_id = ANY($3::uuid[]))`,
    [createdUserIds, createdEventIds, createdVenueIds],
  );
  await query('DELETE FROM events WHERE venue_id = ANY($1::uuid[])', [createdVenueIds]);
  await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEventIds]);
  await query('DELETE FROM venue_seats WHERE venue_id = ANY($1::uuid[])', [createdVenueIds]);
  await query('DELETE FROM venues WHERE id = ANY($1::uuid[])', [createdVenueIds]);
  await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
}

export interface SeededSeat {
  id: string;
  label: string;
}

export interface SeededShow {
  eventId: string;
  venueId: string;
  organiserId: string;
  seats: SeededSeat[];
}

/**
 * Creates an event whose inventory is A<firstSeatNumber>.., e.g. A12..A14, and
 * returns its show seats in seat order. Everything it creates is tracked for
 * cleanup.
 */
export async function seedShow(seatCount: number, firstSeatNumber = 12): Promise<SeededShow> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', firstSeatNumber);

  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Hold Test ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
  });
  trackEvent(event.id);

  const seats = await query<SeededSeat>(
    `SELECT ss.id, vs.row_label || vs.seat_number AS label
     FROM show_seats ss
     JOIN venue_seats vs ON vs.id = ss.venue_seat_id
     WHERE ss.event_id = $1
     ORDER BY vs.seat_number`,
    [event.id],
  );

  return { eventId: event.id, venueId, organiserId, seats: seats.rows };
}

/**
 * Reproduces the state a lapsed hold leaves behind: an `active` hold whose
 * `expires_at` is already in the past, with its seats still flagged `held`.
 * Nothing rewrites those rows on its own, which is exactly the situation the
 * reservation service has to reclaim.
 */
export async function seedLapsedHold(
  eventId: string,
  userId: string,
  showSeatIds: readonly string[],
  secondsAgo = 60,
): Promise<string> {
  const hold = await query<IdRow>(
    `INSERT INTO reservation_holds (event_id, user_id, status, expires_at)
     VALUES ($1, $2, 'active', now() - make_interval(secs => $3::double precision))
     RETURNING id`,
    [eventId, userId, secondsAgo],
  );
  const holdId = hold.rows[0]!.id;

  await query(
    `INSERT INTO reservation_hold_seats (hold_id, show_seat_id)
     SELECT $1, show_seat_id FROM unnest($2::uuid[]) AS show_seat_id`,
    [holdId, showSeatIds],
  );
  await query("UPDATE show_seats SET status = 'held' WHERE id = ANY($1::uuid[])", [showSeatIds]);

  return holdId;
}

/** An `active` hold that is still alive, with its seats flagged `held`. */
export async function seedLiveHold(
  eventId: string,
  userId: string,
  showSeatIds: readonly string[],
  ttlSeconds = 600,
): Promise<string> {
  const hold = await query<IdRow>(
    `INSERT INTO reservation_holds (event_id, user_id, status, expires_at)
     VALUES ($1, $2, 'active', now() + make_interval(secs => $3::double precision))
     RETURNING id`,
    [eventId, userId, ttlSeconds],
  );
  const holdId = hold.rows[0]!.id;

  await query(
    `INSERT INTO reservation_hold_seats (hold_id, show_seat_id)
     SELECT $1, show_seat_id FROM unnest($2::uuid[]) AS show_seat_id`,
    [holdId, showSeatIds],
  );
  await query("UPDATE show_seats SET status = 'held' WHERE id = ANY($1::uuid[])", [showSeatIds]);

  return holdId;
}

export interface SeededBooking {
  eventId: string;
  organiserId: string;
  userId: string;
  seatIds: string[];
  bookingId: string;
}

/**
 * Seeds a priced show, holds every seat and confirms the booking directly
 * through the service layer - no HTTP round trip, since the ticket suites this
 * exists for are testing what happens *after* a booking exists, not
 * confirmation itself.
 */
export async function seedConfirmedBooking(
  seatCount: number,
  price = '250.00',
): Promise<SeededBooking> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', 12);
  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Ticket Test ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
    pricing: { standard: price },
  });
  trackEvent(event.id);

  const seats = await query<IdRow>(
    'SELECT id FROM show_seats WHERE event_id = $1 ORDER BY id',
    [event.id],
  );
  const seatIds = seats.rows.map((row) => row.id);

  const userId = await seedCustomer();
  const hold = await createHold({ eventId: event.id, userId, showSeatIds: seatIds, ttlSeconds: 600 });

  const result = await withTransaction((client) =>
    confirmHoldInTransaction(
      client,
      { userId, eventId: event.id, holdId: hold.holdId },
      undefined,
    ),
  );

  return { eventId: event.id, organiserId, userId, seatIds, bookingId: result.booking.id };
}

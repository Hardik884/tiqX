import { randomUUID } from 'node:crypto';

import { query } from '../../src/db/pool.js';

interface IdRow {
  id: string;
}

const createdEventIds: string[] = [];
const createdVenueIds: string[] = [];
const createdUserIds: string[] = [];

export function trackEvent(eventId: string): void {
  createdEventIds.push(eventId);
}

export async function seedOrganiser(): Promise<string> {
  const result = await query<IdRow>(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'organiser')
     RETURNING id`,
    ['Test Organiser', `organiser-${randomUUID()}@example.test`, 'not-a-real-hash'],
  );

  const id = result.rows[0]!.id;
  createdUserIds.push(id);
  return id;
}

export interface SeededVenue {
  venueId: string;
  seatIds: string[];
}

/** Creates a venue with `seatCount` seats in a single row, e.g. A1..A3. */
export async function seedVenue(seatCount: number, rowLabel = 'A'): Promise<SeededVenue> {
  const venue = await query<IdRow>(
    `INSERT INTO venues (name, description) VALUES ($1, $2) RETURNING id`,
    [`Test Venue ${randomUUID()}`, 'Created by the test suite'],
  );

  const venueId = venue.rows[0]!.id;
  createdVenueIds.push(venueId);

  const seatIds: string[] = [];
  for (let seatNumber = 1; seatNumber <= seatCount; seatNumber += 1) {
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
  await query('DELETE FROM events WHERE venue_id = ANY($1::uuid[])', [createdVenueIds]);
  await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEventIds]);
  await query('DELETE FROM venue_seats WHERE venue_id = ANY($1::uuid[])', [createdVenueIds]);
  await query('DELETE FROM venues WHERE id = ANY($1::uuid[])', [createdVenueIds]);
  await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
}

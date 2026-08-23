import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { PG_ERROR, pgErrorCode } from '../src/db/pg-error.js';
import { closePool, query } from '../src/db/pool.js';
import { createEvent } from '../src/modules/events/event.service.js';
import type { CreateEventInput } from '../src/modules/events/event.types.js';
import { cleanupSeedData, seedOrganiser, seedVenue, trackEvent } from './helpers/seed.js';

const STARTS_AT = new Date('2030-01-01T18:00:00.000Z');
const ENDS_AT = new Date('2030-01-01T20:00:00.000Z');

function eventInput(organiserId: string, venueId: string, title: string): CreateEventInput {
  return {
    organiserId,
    venueId,
    title,
    eventType: 'concert',
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
  };
}

async function countEventsAtVenue(venueId: string): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM events WHERE venue_id = $1',
    [venueId],
  );
  return Number(result.rows[0]!.count);
}

after(async () => {
  await cleanupSeedData();
  await closePool();
});

describe('show_seats inventory', () => {
  it('creates one show_seat per venue_seat when an event is created', async () => {
    const organiserId = await seedOrganiser();
    const { venueId, seatIds } = await seedVenue(3);

    const result = await createEvent(eventInput(organiserId, venueId, 'Three Seat Show'));
    trackEvent(result.event.id);

    assert.equal(result.seatInventoryCount, 3);

    const inventory = await query<{ venue_seat_id: string; status: string }>(
      'SELECT venue_seat_id, status FROM show_seats WHERE event_id = $1 ORDER BY venue_seat_id',
      [result.event.id],
    );

    assert.equal(inventory.rowCount, 3);
    assert.deepEqual(
      inventory.rows.map((row) => row.venue_seat_id).sort(),
      [...seatIds].sort(),
    );
    assert.ok(inventory.rows.every((row) => row.status === 'available'));
  });

  it('gives each event its own inventory row for the same physical seat', async () => {
    const organiserId = await seedOrganiser();
    const { venueId, seatIds } = await seedVenue(3);
    const seatA1 = seatIds[0]!;

    const first = await createEvent(eventInput(organiserId, venueId, 'Event One'));
    const second = await createEvent(eventInput(organiserId, venueId, 'Event Two'));
    trackEvent(first.event.id);
    trackEvent(second.event.id);

    const rows = await query<{ event_id: string; status: string }>(
      'SELECT event_id, status FROM show_seats WHERE venue_seat_id = $1 ORDER BY event_id',
      [seatA1],
    );
    assert.equal(rows.rowCount, 2);

    // The two records are independent: booking A1 for one event must not
    // change A1 for the other.
    await query('UPDATE show_seats SET status = $1 WHERE event_id = $2 AND venue_seat_id = $3', [
      'booked',
      first.event.id,
      seatA1,
    ]);

    const statuses = await query<{ event_id: string; status: string }>(
      'SELECT event_id, status FROM show_seats WHERE venue_seat_id = $1',
      [seatA1],
    );
    const byEvent = new Map(statuses.rows.map((row) => [row.event_id, row.status]));
    assert.equal(byEvent.get(first.event.id), 'booked');
    assert.equal(byEvent.get(second.event.id), 'available');
  });

  it('rejects the same (event_id, venue_seat_id) twice', async () => {
    const organiserId = await seedOrganiser();
    const { venueId, seatIds } = await seedVenue(2);

    const { event } = await createEvent(eventInput(organiserId, venueId, 'Duplicate Guard'));
    trackEvent(event.id);

    await assert.rejects(
      query('INSERT INTO show_seats (event_id, venue_seat_id) VALUES ($1, $2)', [
        event.id,
        seatIds[0]!,
      ]),
      (error: unknown) => pgErrorCode(error) === PG_ERROR.UNIQUE_VIOLATION,
    );
  });

  it('rejects a show_seat referencing a nonexistent event', async () => {
    const { seatIds } = await seedVenue(1);

    await assert.rejects(
      query('INSERT INTO show_seats (event_id, venue_seat_id) VALUES ($1, $2)', [
        randomUUID(),
        seatIds[0]!,
      ]),
      (error: unknown) => pgErrorCode(error) === PG_ERROR.FOREIGN_KEY_VIOLATION,
    );
  });

  it('rejects a show_seat referencing a nonexistent venue seat', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(1);
    const { event } = await createEvent(eventInput(organiserId, venueId, 'Bad Seat Reference'));
    trackEvent(event.id);

    await assert.rejects(
      query('INSERT INTO show_seats (event_id, venue_seat_id) VALUES ($1, $2)', [
        event.id,
        randomUUID(),
      ]),
      (error: unknown) => pgErrorCode(error) === PG_ERROR.FOREIGN_KEY_VIOLATION,
    );
  });

  it('rejects an invalid status', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(1);
    const { event } = await createEvent(eventInput(organiserId, venueId, 'Status Guard'));
    trackEvent(event.id);

    await assert.rejects(
      query('UPDATE show_seats SET status = $1 WHERE event_id = $2', ['reserved', event.id]),
      (error: unknown) => pgErrorCode(error) === PG_ERROR.CHECK_VIOLATION,
    );
  });

  it('maintains updated_at with a trigger, like the other tables', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(1);
    const { event } = await createEvent(eventInput(organiserId, venueId, 'Timestamps'));
    trackEvent(event.id);

    const before = await query<{ created_at: Date; updated_at: Date }>(
      'SELECT created_at, updated_at FROM show_seats WHERE event_id = $1',
      [event.id],
    );
    const initial = before.rows[0]!;
    assert.equal(initial.updated_at.getTime(), initial.created_at.getTime());

    await query('UPDATE show_seats SET status = $1 WHERE event_id = $2', ['held', event.id]);

    const after = await query<{ created_at: Date; updated_at: Date }>(
      'SELECT created_at, updated_at FROM show_seats WHERE event_id = $1',
      [event.id],
    );
    const updated = after.rows[0]!;
    assert.equal(updated.created_at.getTime(), initial.created_at.getTime());
    assert.ok(updated.updated_at.getTime() > initial.updated_at.getTime());
  });
});

describe('event creation atomicity', () => {
  it('does not persist the event when the venue has no seats', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(0);

    await assert.rejects(createEvent(eventInput(organiserId, venueId, 'Seatless Venue')), /no seats/);

    assert.equal(await countEventsAtVenue(venueId), 0);
  });

  it('rolls the event back when inventory creation fails', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(2);

    // Fault injection: force every show_seats insert to fail. NOT VALID leaves
    // rows created by earlier tests untouched.
    await query('ALTER TABLE show_seats ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID');

    try {
      await assert.rejects(
        createEvent(eventInput(organiserId, venueId, 'Rolled Back Event')),
        (error: unknown) => pgErrorCode(error) === PG_ERROR.CHECK_VIOLATION,
      );

      assert.equal(await countEventsAtVenue(venueId), 0);
    } finally {
      await query('ALTER TABLE show_seats DROP CONSTRAINT tmp_force_failure');
    }
  });

  it('does not persist the event when the organiser does not exist', async () => {
    const { venueId } = await seedVenue(2);

    await assert.rejects(
      createEvent(eventInput(randomUUID(), venueId, 'Unknown Organiser')),
      /organiserId does not reference an existing user/,
    );

    assert.equal(await countEventsAtVenue(venueId), 0);
  });
});

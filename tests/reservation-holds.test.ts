import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { PG_ERROR, pgErrorCode } from '../src/db/pg-error.js';
import { closePool, query } from '../src/db/pool.js';
import { createEvent } from '../src/modules/events/event.service.js';
import { cleanupSeedData, seedCustomer, seedOrganiser, seedVenue, trackEvent } from './helpers/seed.js';

const STARTS_AT = new Date('2030-01-01T18:00:00.000Z');
const ENDS_AT = new Date('2030-01-01T20:00:00.000Z');

interface ShowSeatRow {
  id: string;
  label: string;
}

interface SeededShow {
  eventId: string;
  venueId: string;
  seats: ShowSeatRow[];
}

/**
 * Creates an event whose inventory is A<firstSeatNumber>.. , e.g. A12..A14,
 * and returns its show seats in seat order.
 */
async function seedShow(seatCount: number, firstSeatNumber = 12): Promise<SeededShow> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', firstSeatNumber);

  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Hold Test ${randomUUID()}`,
    eventType: 'concert',
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
  });
  trackEvent(event.id);

  const seats = await query<ShowSeatRow>(
    `SELECT ss.id, vs.row_label || vs.seat_number AS label
     FROM show_seats ss
     JOIN venue_seats vs ON vs.id = ss.venue_seat_id
     WHERE ss.event_id = $1
     ORDER BY vs.seat_number`,
    [event.id],
  );

  return { eventId: event.id, venueId, seats: seats.rows };
}

/** Inserts an active hold expiring `ttlSeconds` from now. */
async function insertHold(
  eventId: string,
  userId: string,
  ttlSeconds = 300,
  status = 'active',
): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO reservation_holds (event_id, user_id, status, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision))
     RETURNING id`,
    [eventId, userId, status, ttlSeconds],
  );
  return result.rows[0]!.id;
}

async function addSeatsToHold(holdId: string, showSeatIds: readonly string[]): Promise<void> {
  await query(
    `INSERT INTO reservation_hold_seats (hold_id, show_seat_id)
     SELECT $1, show_seat_id FROM unnest($2::uuid[]) AS show_seat_id`,
    [holdId, showSeatIds],
  );
}

async function countRows(table: string, column: string, value: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE ${column} = $1`,
    [value],
  );
  return Number(result.rows[0]!.count);
}

after(async () => {
  await cleanupSeedData();
  await closePool();
});

describe('reservation_holds', () => {
  it('creates a valid hold with defaults applied', async () => {
    const { eventId } = await seedShow(1);
    const userId = await seedCustomer();

    const before = new Date();
    const holdId = await insertHold(eventId, userId);

    const rows = await query<{
      event_id: string;
      user_id: string;
      status: string;
      expires_at: Date;
      created_at: Date;
      updated_at: Date;
    }>('SELECT * FROM reservation_holds WHERE id = $1', [holdId]);

    const hold = rows.rows[0]!;
    assert.equal(hold.event_id, eventId);
    assert.equal(hold.user_id, userId);
    assert.equal(hold.status, 'active');
    // expires_at is timezone-aware and comes back as a real instant in the
    // future; nothing in the database enforces that, it is just what we wrote.
    assert.ok(hold.expires_at.getTime() > before.getTime());
    assert.equal(hold.updated_at.getTime(), hold.created_at.getTime());
  });

  it('stores a hold covering several show seats', async () => {
    const { eventId, seats } = await seedShow(3); // A12, A13, A14
    const userId = await seedCustomer();
    assert.deepEqual(
      seats.map((seat) => seat.label),
      ['A12', 'A13', 'A14'],
    );

    const holdId = await insertHold(eventId, userId);
    await addSeatsToHold(holdId, seats.map((seat) => seat.id));

    const held = await query<{ label: string }>(
      `SELECT vs.row_label || vs.seat_number AS label
       FROM reservation_hold_seats rhs
       JOIN show_seats ss ON ss.id = rhs.show_seat_id
       JOIN venue_seats vs ON vs.id = ss.venue_seat_id
       WHERE rhs.hold_id = $1
       ORDER BY vs.seat_number`,
      [holdId],
    );

    assert.deepEqual(
      held.rows.map((row) => row.label),
      ['A12', 'A13', 'A14'],
    );
  });

  it('lets separate holds reference the same show seat', async () => {
    const { eventId, seats } = await seedShow(1);
    const seatId = seats[0]!.id;
    const firstUser = await seedCustomer();
    const secondUser = await seedCustomer();

    // A hold that ran out, then a fresh one for the same seat. The expired hold
    // must keep its seat list: the schema stores history, it does not police
    // who currently owns a seat - that is the reservation service's job.
    const expiredHold = await insertHold(eventId, firstUser, -60, 'expired');
    await addSeatsToHold(expiredHold, [seatId]);

    const activeHold = await insertHold(eventId, secondUser);
    await addSeatsToHold(activeHold, [seatId]);

    assert.equal(await countRows('reservation_hold_seats', 'show_seat_id', seatId), 2);
    assert.equal(await countRows('reservation_hold_seats', 'hold_id', expiredHold), 1);
  });

  it('rejects a hold for a nonexistent user', async () => {
    const { eventId } = await seedShow(1);

    await assert.rejects(
      insertHold(eventId, randomUUID()),
      (error: unknown) => pgErrorCode(error) === PG_ERROR.FOREIGN_KEY_VIOLATION,
    );
  });

  it('rejects a hold for a nonexistent event', async () => {
    const userId = await seedCustomer();

    await assert.rejects(
      insertHold(randomUUID(), userId),
      (error: unknown) => pgErrorCode(error) === PG_ERROR.FOREIGN_KEY_VIOLATION,
    );
  });

  it('rejects an invalid status', async () => {
    const { eventId } = await seedShow(1);
    const userId = await seedCustomer();

    await assert.rejects(
      insertHold(eventId, userId, 300, 'reserved'),
      (error: unknown) => pgErrorCode(error) === PG_ERROR.CHECK_VIOLATION,
    );

    const holdId = await insertHold(eventId, userId);
    await assert.rejects(
      query('UPDATE reservation_holds SET status = $1 WHERE id = $2', ['released', holdId]),
      (error: unknown) => pgErrorCode(error) === PG_ERROR.CHECK_VIOLATION,
    );
  });

  it('accepts every documented status', async () => {
    const { eventId } = await seedShow(1);
    const userId = await seedCustomer();

    for (const status of ['active', 'expired', 'converted', 'cancelled']) {
      const holdId = await insertHold(eventId, userId, 300, status);
      const stored = await query<{ status: string }>(
        'SELECT status FROM reservation_holds WHERE id = $1',
        [holdId],
      );
      assert.equal(stored.rows[0]!.status, status);
    }
  });

  it('maintains updated_at with the shared trigger', async () => {
    const { eventId } = await seedShow(1);
    const userId = await seedCustomer();
    const holdId = await insertHold(eventId, userId);

    const before = await query<{ created_at: Date; updated_at: Date }>(
      'SELECT created_at, updated_at FROM reservation_holds WHERE id = $1',
      [holdId],
    );
    const initial = before.rows[0]!;
    assert.equal(initial.updated_at.getTime(), initial.created_at.getTime());

    await query('UPDATE reservation_holds SET status = $1 WHERE id = $2', ['cancelled', holdId]);

    const after = await query<{ created_at: Date; updated_at: Date }>(
      'SELECT created_at, updated_at FROM reservation_holds WHERE id = $1',
      [holdId],
    );
    const updated = after.rows[0]!;
    assert.equal(updated.created_at.getTime(), initial.created_at.getTime());
    assert.ok(updated.updated_at.getTime() > initial.updated_at.getTime());
  });

  it('keeps a hold usable after its expires_at has passed', async () => {
    const { eventId, seats } = await seedShow(1);
    const userId = await seedCustomer();

    // No CHECK constrains expires_at against now(), so a hold may be written
    // already in the past and an active row may be updated long after it
    // lapsed. Expiry is interpreted, never enforced by the schema.
    const holdId = await insertHold(eventId, userId, -3600);
    await addSeatsToHold(holdId, [seats[0]!.id]);

    await query('UPDATE reservation_holds SET status = $1 WHERE id = $2', ['expired', holdId]);

    const stored = await query<{ status: string }>(
      'SELECT status FROM reservation_holds WHERE id = $1 AND expires_at < now()',
      [holdId],
    );
    assert.equal(stored.rows[0]!.status, 'expired');
  });
});

describe('reservation_hold_seats', () => {
  it('rejects a row for a nonexistent hold', async () => {
    const { seats } = await seedShow(1);

    await assert.rejects(
      addSeatsToHold(randomUUID(), [seats[0]!.id]),
      (error: unknown) => pgErrorCode(error) === PG_ERROR.FOREIGN_KEY_VIOLATION,
    );
  });

  it('rejects a row for a nonexistent show seat', async () => {
    const { eventId } = await seedShow(1);
    const userId = await seedCustomer();
    const holdId = await insertHold(eventId, userId);

    await assert.rejects(
      addSeatsToHold(holdId, [randomUUID()]),
      (error: unknown) => pgErrorCode(error) === PG_ERROR.FOREIGN_KEY_VIOLATION,
    );
  });

  it('rejects the same seat twice in one hold', async () => {
    const { eventId, seats } = await seedShow(1);
    const userId = await seedCustomer();
    const holdId = await insertHold(eventId, userId);
    const seatId = seats[0]!.id;

    await addSeatsToHold(holdId, [seatId]);

    await assert.rejects(
      addSeatsToHold(holdId, [seatId]),
      (error: unknown) => pgErrorCode(error) === PG_ERROR.UNIQUE_VIOLATION,
    );
  });
});

describe('reservation hold deletion behaviour', () => {
  it('removes the seat associations when a hold is deleted', async () => {
    const { eventId, seats } = await seedShow(3);
    const userId = await seedCustomer();
    const holdId = await insertHold(eventId, userId);
    await addSeatsToHold(holdId, seats.map((seat) => seat.id));

    await query('DELETE FROM reservation_holds WHERE id = $1', [holdId]);

    assert.equal(await countRows('reservation_hold_seats', 'hold_id', holdId), 0);
    // The seats themselves survive: only the association was transient.
    assert.equal(await countRows('show_seats', 'event_id', eventId), 3);
  });

  it('removes holds and their seat rows when the event is deleted', async () => {
    const { eventId, seats } = await seedShow(3);
    const userId = await seedCustomer();
    const holdId = await insertHold(eventId, userId);
    await addSeatsToHold(holdId, seats.map((seat) => seat.id));

    await query('DELETE FROM events WHERE id = $1', [eventId]);

    assert.equal(await countRows('reservation_holds', 'event_id', eventId), 0);
    assert.equal(await countRows('reservation_hold_seats', 'hold_id', holdId), 0);
    assert.equal(await countRows('show_seats', 'event_id', eventId), 0);
    // The customer is untouched; only the event's own children went away.
    assert.equal(await countRows('users', 'id', userId), 1);
  });

  it('removes holds and their seat rows when the user is deleted', async () => {
    const { eventId, seats } = await seedShow(3);
    const userId = await seedCustomer();
    const holdId = await insertHold(eventId, userId);
    await addSeatsToHold(holdId, seats.map((seat) => seat.id));

    await query('DELETE FROM users WHERE id = $1', [userId]);

    assert.equal(await countRows('reservation_holds', 'user_id', userId), 0);
    assert.equal(await countRows('reservation_hold_seats', 'hold_id', holdId), 0);
    // The event and its inventory are unaffected: a hold is transient, the
    // seat map is not.
    assert.equal(await countRows('show_seats', 'event_id', eventId), 3);
  });

  it('cascades the association away when a show seat itself is deleted', async () => {
    const { eventId, seats } = await seedShow(2);
    const userId = await seedCustomer();
    const holdId = await insertHold(eventId, userId);
    const heldSeatId = seats[0]!.id;
    await addSeatsToHold(holdId, [heldSeatId]);

    // Deleting a show seat on its own cascades the association away rather than
    // leaving it dangling; the hold itself survives with one fewer seat. Direct
    // show_seat deletion is not something the application does - inventory
    // disappears with its event - so this documents the fallback, and the FK is
    // what guarantees a hold-seat row can never point at a missing seat.
    await query('DELETE FROM show_seats WHERE id = $1', [heldSeatId]);

    assert.equal(await countRows('reservation_hold_seats', 'show_seat_id', heldSeatId), 0);
    assert.equal(await countRows('reservation_holds', 'id', holdId), 1);
  });

  it('leaves no reservation_hold_seats row without a live hold and seat', async () => {
    const orphans = await query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM reservation_hold_seats rhs
       LEFT JOIN reservation_holds h ON h.id = rhs.hold_id
       LEFT JOIN show_seats ss ON ss.id = rhs.show_seat_id
       WHERE h.id IS NULL OR ss.id IS NULL`,
    );
    assert.equal(Number(orphans.rows[0]!.count), 0);
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { createEvent } from '../src/modules/events/event.service.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import { accessTokenForUser } from './helpers/auth.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace } from './helpers/redis.js';
import { cleanupSeedData, seedCustomer, seedOrganiser, seedVenue } from './helpers/seed.js';

let server: Server;
let baseUrl: string;

before(async () => {
  await connectTestRedis();
  await flushTestNamespace();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await query('DELETE FROM idempotency_keys');
  await flushTestNamespace();
  await closeTestRedis();
  await cleanupSeedData();
  await closePool();
});

interface ConfirmResponse {
  bookingId?: string;
  bookingReference?: string;
  eventId?: string;
  holdId?: string;
  status?: string;
  seatCount?: number;
  totalAmount?: string;
  currency?: string;
  createdAt?: string;
  error?: { code: string; message: string; details?: { reason?: string } };
}

interface Reply {
  status: number;
  json: ConfirmResponse;
  raw: string;
}

async function confirm(
  eventId: string,
  holdId: string,
  options: { userId?: string | null; key?: string | null } = {},
): Promise<Reply> {
  const key = options.key === undefined ? randomUUID() : options.key;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== null) {
    headers['idempotency-key'] = key;
  }
  if (options.userId != null) {
    headers.authorization = `Bearer ${await accessTokenForUser(options.userId)}`;
  }

  const response = await fetch(`${baseUrl}/api/v1/events/${eventId}/holds/${holdId}/confirm`, {
    method: 'POST',
    headers,
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? (JSON.parse(raw) as ConfirmResponse) : {}, raw };
}

interface Show {
  eventId: string;
  seats: { id: string; label: string }[];
}

/** An event whose seats carry real prices, so totals are meaningful. */
async function seedPricedShow(
  seatCount: number,
  pricing: { standard?: string; premium?: string } = { standard: '450.10' },
  currency = 'INR',
): Promise<Show> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', 12);

  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Priced ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
    pricing,
    currency,
  });

  const seats = await query<{ id: string; label: string }>(
    `SELECT ss.id, vs.row_label || vs.seat_number AS label
     FROM show_seats ss JOIN venue_seats vs ON vs.id = ss.venue_seat_id
     WHERE ss.event_id = $1 ORDER BY vs.seat_number`,
    [event.id],
  );

  return { eventId: event.id, seats: seats.rows };
}

async function holdStatus(holdId: string): Promise<string | null> {
  const result = await query<{ status: string }>(
    'SELECT status FROM reservation_holds WHERE id = $1',
    [holdId],
  );
  return result.rows[0]?.status ?? null;
}

async function seatStatuses(ids: readonly string[]): Promise<Record<string, string>> {
  const result = await query<{ id: string; status: string }>(
    'SELECT id, status FROM show_seats WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return Object.fromEntries(result.rows.map((row) => [row.id, row.status]));
}

async function countBookings(eventId: string): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM bookings WHERE event_id = $1',
    [eventId],
  );
  return Number(result.rows[0]!.count);
}

describe('confirming a hold', () => {
  it('creates the booking, its seats, and moves both state machines', async () => {
    const { eventId, seats } = await seedPricedShow(3, { standard: '450.10' });
    const userId = await seedCustomer();
    const seatIds = seats.map((seat) => seat.id);
    const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 600 });

    const reply = await confirm(eventId, hold.holdId, { userId });

    assert.equal(reply.status, 201);
    assert.equal(reply.json.status, 'confirmed');
    assert.equal(reply.json.eventId, eventId);
    assert.equal(reply.json.holdId, hold.holdId);
    assert.equal(reply.json.seatCount, 3);
    assert.equal(reply.json.currency, 'INR');
    assert.match(reply.json.bookingReference!, /^TX-\d{4}-[0-9A-HJKMNP-TV-Z]{8}$/);

    // 450.10 x 3 = 1350.30. In binary floating point it is not, which is the
    // whole reason PostgreSQL does this sum.
    assert.equal(reply.json.totalAmount, '1350.30');

    const booking = await query<{ total_amount: string; status: string; user_id: string }>(
      'SELECT total_amount, status, user_id FROM bookings WHERE id = $1',
      [reply.json.bookingId],
    );
    assert.equal(booking.rows[0]!.total_amount, '1350.30');
    assert.equal(booking.rows[0]!.status, 'confirmed');
    assert.equal(booking.rows[0]!.user_id, userId, 'the booking belongs to the authenticated user');

    const bookingSeats = await query<{ show_seat_id: string; price: string }>(
      'SELECT show_seat_id, price FROM booking_seats WHERE booking_id = $1 ORDER BY show_seat_id',
      [reply.json.bookingId],
    );
    assert.deepEqual(bookingSeats.rows.map((r) => r.show_seat_id), [...seatIds].sort());
    assert.ok(bookingSeats.rows.every((r) => r.price === '450.10'), 'each seat snapshots its price');

    assert.equal(await holdStatus(hold.holdId), 'converted');
    const statuses = await seatStatuses(seatIds);
    assert.ok(seatIds.every((id) => statuses[id] === 'booked'), 'every seat is booked');
  });

  it('totals a mixed-price booking exactly', async () => {
    const { eventId, seats } = await seedPricedShow(4, { standard: '333.33' });
    const userId = await seedCustomer();
    const seatIds = seats.map((seat) => seat.id);
    const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 600 });

    const reply = await confirm(eventId, hold.holdId, { userId });

    // 333.33 x 4 = 1333.32 exactly. A float sum gives 1333.3200000000002.
    assert.equal(reply.json.totalAmount, '1333.32');
  });

  it('keeps the price snapshot after the source price changes', async () => {
    const { eventId, seats } = await seedPricedShow(2, { standard: '500.00' });
    const userId = await seedCustomer();
    const seatIds = seats.map((seat) => seat.id);
    const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 600 });

    const reply = await confirm(eventId, hold.holdId, { userId });
    assert.equal(reply.json.totalAmount, '1000.00');

    // The event is repriced afterwards, as it might be for a later sale.
    await query('UPDATE show_seats SET price = 9999.99 WHERE id = ANY($1::uuid[])', [seatIds]);

    const after = await query<{ price: string }>(
      'SELECT price FROM booking_seats WHERE booking_id = $1',
      [reply.json.bookingId],
    );
    assert.ok(after.rows.every((r) => r.price === '500.00'), 'the snapshot is untouched');

    const booking = await query<{ total_amount: string }>(
      'SELECT total_amount FROM bookings WHERE id = $1',
      [reply.json.bookingId],
    );
    assert.equal(booking.rows[0]!.total_amount, '1000.00', 'the total is historical, not recomputed');
  });

  it('never books a seat that was merely available', async () => {
    const { eventId, seats } = await seedPricedShow(3);
    const userId = await seedCustomer();
    // Hold only the first seat.
    const hold = await createHold({
      eventId,
      userId,
      showSeatIds: [seats[0]!.id],
      ttlSeconds: 600,
    });

    await confirm(eventId, hold.holdId, { userId });

    const statuses = await seatStatuses(seats.map((s) => s.id));
    assert.equal(statuses[seats[0]!.id], 'booked');
    assert.equal(statuses[seats[1]!.id], 'available', 'an unheld seat is not swept into the booking');
    assert.equal(statuses[seats[2]!.id], 'available');
  });
});

describe('confirmation is refused when it should be', () => {
  it('requires authentication', async () => {
    const { eventId, seats } = await seedPricedShow(1);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: [seats[0]!.id], ttlSeconds: 600 });

    const reply = await confirm(eventId, hold.holdId, { userId: null });

    assert.equal(reply.status, 401);
    assert.equal(await countBookings(eventId), 0);
    assert.equal(await holdStatus(hold.holdId), 'active');
  });

  it('requires an Idempotency-Key', async () => {
    const { eventId, seats } = await seedPricedShow(1);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: [seats[0]!.id], ttlSeconds: 600 });

    const reply = await confirm(eventId, hold.holdId, { userId, key: null });

    assert.equal(reply.status, 400);
    assert.match(reply.json.error!.message, /idempotency-key/i);
    assert.equal(await countBookings(eventId), 0);
  });

  it('refuses another user\'s hold without revealing that it exists', async () => {
    const { eventId, seats } = await seedPricedShow(1);
    const owner = await seedCustomer();
    const attacker = await seedCustomer();
    const hold = await createHold({ eventId, userId: owner, showSeatIds: [seats[0]!.id], ttlSeconds: 600 });

    const stolen = await confirm(eventId, hold.holdId, { userId: attacker });

    // 404, not 403: a 403 would confirm to the attacker that the hold is real.
    assert.equal(stolen.status, 404);
    assert.equal(stolen.json.error?.details?.reason, 'HOLD_NOT_FOUND');

    // Indistinguishable from a hold id that never existed.
    const imaginary = await confirm(eventId, randomUUID(), { userId: attacker });
    assert.equal(imaginary.status, stolen.status);
    assert.equal(imaginary.json.error?.code, stolen.json.error?.code);
    assert.equal(imaginary.json.error?.message, stolen.json.error?.message);

    assert.equal(await countBookings(eventId), 0);
    assert.equal(await holdStatus(hold.holdId), 'active', 'the owner keeps their hold');
    assert.equal((await seatStatuses([seats[0]!.id]))[seats[0]!.id], 'held');
  });

  it('refuses a hold that belongs to a different event', async () => {
    const first = await seedPricedShow(1);
    const second = await seedPricedShow(1);
    const userId = await seedCustomer();
    const hold = await createHold({
      eventId: first.eventId,
      userId,
      showSeatIds: [first.seats[0]!.id],
      ttlSeconds: 600,
    });

    // The URL says one event, the hold belongs to another. Neither is trusted
    // on its own; they must agree.
    const reply = await confirm(second.eventId, hold.holdId, { userId });

    assert.equal(reply.status, 404);
    assert.equal(await countBookings(second.eventId), 0);
    assert.equal(await holdStatus(hold.holdId), 'active');
  });

  it('refuses an expired hold', async () => {
    const { eventId, seats } = await seedPricedShow(1);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: [seats[0]!.id], ttlSeconds: 1 });

    await delay(1_200);

    const reply = await confirm(eventId, hold.holdId, { userId });

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'HOLD_EXPIRED');
    assert.equal(await countBookings(eventId), 0);
    // The seat is not booked; it stays as it was for the sweep to release.
    assert.notEqual((await seatStatuses([seats[0]!.id]))[seats[0]!.id], 'booked');
  });

  it('refuses a hold that is already confirmed', async () => {
    const { eventId, seats } = await seedPricedShow(2);
    const userId = await seedCustomer();
    const seatIds = seats.map((s) => s.id);
    const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 600 });

    const first = await confirm(eventId, hold.holdId, { userId });
    assert.equal(first.status, 201);

    // A *different* idempotency key, so this is a genuinely new request rather
    // than a replay: the state machine, not idempotency, must refuse it.
    const second = await confirm(eventId, hold.holdId, { userId });

    assert.equal(second.status, 409);
    assert.equal(second.json.error?.details?.reason, 'HOLD_ALREADY_CONFIRMED');
    assert.equal(await countBookings(eventId), 1, 'still exactly one booking');
  });

  it('refuses a cancelled hold', async () => {
    const { eventId, seats } = await seedPricedShow(1);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: [seats[0]!.id], ttlSeconds: 600 });
    await query("UPDATE reservation_holds SET status = 'cancelled' WHERE id = $1", [hold.holdId]);

    const reply = await confirm(eventId, hold.holdId, { userId });

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'HOLD_INVALID');
    assert.equal(await countBookings(eventId), 0);
    assert.equal(await holdStatus(hold.holdId), 'cancelled', 'the status is not overwritten');
  });

  it('leaks no database detail on any rejection', async () => {
    const { eventId, seats } = await seedPricedShow(1);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: [seats[0]!.id], ttlSeconds: 600 });
    await query("UPDATE reservation_holds SET status = 'cancelled' WHERE id = $1", [hold.holdId]);

    const reply = await confirm(eventId, hold.holdId, { userId });

    for (const leak of ['reservation_holds', 'show_seats', 'SELECT', 'FOR UPDATE', 'pg', 'stack']) {
      assert.ok(!reply.raw.includes(leak), `the response must not mention ${leak}`);
    }
  });
});

describe('confirmation idempotency', () => {
  it('replays the original booking for a repeated key', async () => {
    const { eventId, seats } = await seedPricedShow(2, { standard: '200.00' });
    const userId = await seedCustomer();
    const seatIds = seats.map((s) => s.id);
    const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 600 });
    const key = randomUUID();

    const first = await confirm(eventId, hold.holdId, { userId, key });
    const retry = await confirm(eventId, hold.holdId, { userId, key });

    assert.equal(first.status, 201);
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.json, first.json, 'byte-for-byte the same booking');
    assert.equal(await countBookings(eventId), 1);

    const seatRows = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM booking_seats WHERE booking_id = $1',
      [first.json.bookingId],
    );
    assert.equal(seatRows.rows[0]!.count, '2', 'no duplicate booking seats');
  });

  it('conflicts when the same key is reused for a different hold', async () => {
    const { eventId, seats } = await seedPricedShow(3);
    const userId = await seedCustomer();
    const holdA = await createHold({ eventId, userId, showSeatIds: [seats[0]!.id], ttlSeconds: 600 });
    const holdB = await createHold({ eventId, userId, showSeatIds: [seats[1]!.id], ttlSeconds: 600 });
    const key = randomUUID();

    assert.equal((await confirm(eventId, holdA.holdId, { userId, key })).status, 201);

    const reused = await confirm(eventId, holdB.holdId, { userId, key });

    assert.equal(reused.status, 409);
    assert.equal(reused.json.error?.details?.reason, 'idempotency_key_reuse');
    assert.equal(await countBookings(eventId), 1);
    assert.equal(await holdStatus(holdB.holdId), 'active', 'the second hold is untouched');
  });

  it('scopes the key to the user', async () => {
    const first = await seedPricedShow(1);
    const second = await seedPricedShow(1);
    const userOne = await seedCustomer();
    const userTwo = await seedCustomer();
    const sharedKey = `shared-${randomUUID()}`;

    const holdOne = await createHold({
      eventId: first.eventId,
      userId: userOne,
      showSeatIds: [first.seats[0]!.id],
      ttlSeconds: 600,
    });
    const holdTwo = await createHold({
      eventId: second.eventId,
      userId: userTwo,
      showSeatIds: [second.seats[0]!.id],
      ttlSeconds: 600,
    });

    const a = await confirm(first.eventId, holdOne.holdId, { userId: userOne, key: sharedKey });
    const b = await confirm(second.eventId, holdTwo.holdId, { userId: userTwo, key: sharedKey });

    // The same key string, two users, two independent bookings.
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.json.bookingId, b.json.bookingId);
  });
});

describe('failure injection rolls the whole confirmation back', () => {
  async function withBrokenTable<T>(
    table: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await query(`ALTER TABLE ${table} ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID`);
    try {
      return await fn();
    } finally {
      await query(`ALTER TABLE ${table} DROP CONSTRAINT tmp_force_failure`);
    }
  }

  for (const table of ['bookings', 'booking_seats']) {
    it(`leaves nothing behind when the ${table} insert fails`, async () => {
      const { eventId, seats } = await seedPricedShow(2);
      const userId = await seedCustomer();
      const seatIds = seats.map((s) => s.id);
      const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 600 });

      const reply = await withBrokenTable(table, () => confirm(eventId, hold.holdId, { userId }));

      assert.equal(reply.status, 500);
      assert.equal(reply.json.error?.code, 'INTERNAL_SERVER_ERROR');

      // No booking, no seats sold, and the hold is exactly as it was.
      assert.equal(await countBookings(eventId), 0);
      assert.equal(await holdStatus(hold.holdId), 'active');
      const statuses = await seatStatuses(seatIds);
      assert.ok(seatIds.every((id) => statuses[id] === 'held'), 'seats stay held, not booked');

      // And the idempotency claim rolled back with it, so the key is reusable.
      const keys = await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM idempotency_keys WHERE user_id = $1',
        [userId],
      );
      assert.equal(keys.rows[0]!.count, '0');
    });
  }

  it('leaves nothing behind when the seat update fails', async () => {
    const { eventId, seats } = await seedPricedShow(2);
    const userId = await seedCustomer();
    const seatIds = seats.map((s) => s.id);
    const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 600 });

    const reply = await withBrokenTable('show_seats', () =>
      confirm(eventId, hold.holdId, { userId }),
    );

    assert.equal(reply.status, 500);
    assert.equal(await countBookings(eventId), 0);
    assert.equal(await holdStatus(hold.holdId), 'active');
    assert.ok(
      Object.values(await seatStatuses(seatIds)).every((s) => s === 'held'),
      'no seat was left booked without a booking',
    );
  });

  it('leaves nothing behind when the idempotency record cannot be stored', async () => {
    const { eventId, seats } = await seedPricedShow(1);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: [seats[0]!.id], ttlSeconds: 600 });

    const reply = await withBrokenTable('idempotency_keys', () =>
      confirm(eventId, hold.holdId, { userId }),
    );

    assert.equal(reply.status, 500);
    assert.equal(await countBookings(eventId), 0);
    assert.equal(await holdStatus(hold.holdId), 'active');
    assert.equal((await seatStatuses([seats[0]!.id]))[seats[0]!.id], 'held');
  });
});

describe('database invariants', () => {
  it('refuses a second booking for the same hold, even bypassing the service', async () => {
    const { eventId, seats } = await seedPricedShow(1);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: [seats[0]!.id], ttlSeconds: 600 });
    const reply = await confirm(eventId, hold.holdId, { userId });

    // Straight to the table, with no service logic in the way. The constraint
    // is what guarantees this, not the code path above it.
    await assert.rejects(
      query(
        `INSERT INTO bookings (booking_reference, user_id, event_id, hold_id, total_amount, currency)
         VALUES ($1, $2, $3, $4, 0, 'INR')`,
        [`TX-2026-DUPE${Date.now() % 1000}`, userId, eventId, hold.holdId],
      ),
      /bookings_hold_id_key|duplicate key/,
    );
    assert.equal(await countBookings(eventId), 1);
    assert.ok(reply.json.bookingId);
  });

  it('refuses to sell one show seat into two bookings', async () => {
    const { eventId, seats } = await seedPricedShow(2);
    const userId = await seedCustomer();
    const seatId = seats[0]!.id;
    const hold = await createHold({ eventId, userId, showSeatIds: [seatId], ttlSeconds: 600 });
    await confirm(eventId, hold.holdId, { userId });

    // A second booking row is legitimate; attaching the *same seat* to it is not.
    const other = await createHold({ eventId, userId, showSeatIds: [seats[1]!.id], ttlSeconds: 600 });
    const second = await confirm(eventId, other.holdId, { userId });

    await assert.rejects(
      query(
        'INSERT INTO booking_seats (booking_id, show_seat_id, price) VALUES ($1, $2, 1.00)',
        [second.json.bookingId, seatId],
      ),
      /booking_seats_show_seat_id_key|duplicate key/,
      'a show seat must never belong to two bookings',
    );
  });

  it('rejects negative money and invalid statuses at the database level', async () => {
    const { eventId, seats } = await seedPricedShow(1);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: [seats[0]!.id], ttlSeconds: 600 });

    await assert.rejects(
      query(
        `INSERT INTO bookings (booking_reference, user_id, event_id, hold_id, total_amount, currency)
         VALUES ($1, $2, $3, $4, -1, 'INR')`,
        [`TX-2026-NEG${Date.now() % 1000}`, userId, eventId, hold.holdId],
      ),
      /bookings_total_amount_check/,
    );

    await assert.rejects(
      query(
        `INSERT INTO bookings (booking_reference, user_id, event_id, hold_id, status, total_amount, currency)
         VALUES ($1, $2, $3, $4, 'refunded', 0, 'INR')`,
        [`TX-2026-BAD${Date.now() % 1000}`, userId, eventId, hold.holdId],
      ),
      /bookings_status_check/,
    );
  });
});

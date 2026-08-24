import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { createEvent } from '../src/modules/events/event.service.js';
import { runIdempotently } from '../src/modules/idempotency/idempotency.service.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import {
  lockBookingForCancellation,
  lockBookingSeats,
} from '../src/modules/bookings/booking.repository.js';
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

interface Body {
  bookingId?: string;
  bookingReference?: string;
  eventId?: string;
  holdId?: string;
  status?: string;
  seatCount?: number;
  releasedSeatCount?: number;
  totalAmount?: string;
  currency?: string;
  createdAt?: string;
  cancelledAt?: string;
  error?: { code: string; message: string; details?: { reason?: string } };
}

interface Reply {
  status: number;
  json: Body;
  raw: string;
}

async function post(path: string, options: { userId?: string | null; key?: string | null } = {}) {
  const key = options.key === undefined ? randomUUID() : options.key;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== null) {
    headers['idempotency-key'] = key;
  }
  if (options.userId != null) {
    headers.authorization = `Bearer ${await accessTokenForUser(options.userId)}`;
  }

  const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers });
  const raw = await response.text();
  return { status: response.status, json: raw ? (JSON.parse(raw) as Body) : {}, raw } as Reply;
}

async function confirm(eventId: string, holdId: string, userId: string): Promise<Reply> {
  return post(`/api/v1/events/${eventId}/holds/${holdId}/confirm`, { userId });
}

async function cancel(
  bookingId: string,
  options: { userId?: string | null; key?: string | null } = {},
): Promise<Reply> {
  return post(`/api/v1/bookings/${bookingId}/cancel`, options);
}

interface Show {
  eventId: string;
  seatIds: string[];
}

async function seedPricedShow(seatCount: number, price = '450.10'): Promise<Show> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', 12);
  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Cancel ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
    pricing: { standard: price },
  });
  const seats = await query<{ id: string }>(
    'SELECT id FROM show_seats WHERE event_id = $1 ORDER BY id',
    [event.id],
  );
  return { eventId: event.id, seatIds: seats.rows.map((row) => row.id) };
}

/** Seeds a show, holds every seat and confirms it. Returns the booking. */
async function seedBooking(seatCount: number, price = '450.10') {
  const { eventId, seatIds } = await seedPricedShow(seatCount, price);
  const userId = await seedCustomer();
  const hold = await createHold({ eventId, userId, showSeatIds: seatIds, ttlSeconds: 600 });
  const reply = await confirm(eventId, hold.holdId, userId);
  assert.equal(reply.status, 201, 'setup: the booking must confirm');
  return { eventId, seatIds, userId, holdId: hold.holdId, bookingId: reply.json.bookingId! };
}

async function seatStatuses(ids: readonly string[]): Promise<string[]> {
  const result = await query<{ status: string }>(
    'SELECT status FROM show_seats WHERE id = ANY($1::uuid[]) ORDER BY id',
    [ids],
  );
  return result.rows.map((row) => row.status);
}

async function bookingRow(bookingId: string) {
  const result = await query<{
    status: string;
    total_amount: string;
    currency: string;
    updated_at: Date;
  }>('SELECT status, total_amount, currency, updated_at FROM bookings WHERE id = $1', [bookingId]);
  return result.rows[0]!;
}

async function holdStatus(holdId: string): Promise<string> {
  const result = await query<{ status: string }>(
    'SELECT status FROM reservation_holds WHERE id = $1',
    [holdId],
  );
  return result.rows[0]!.status;
}

describe('cancelling a booking', () => {
  it('cancels the booking and puts every seat back on sale', async () => {
    const { seatIds, userId, bookingId, eventId } = await seedBooking(3);

    const reply = await cancel(bookingId, { userId });

    assert.equal(reply.status, 200);
    assert.equal(reply.json.status, 'cancelled');
    assert.equal(reply.json.bookingId, bookingId);
    assert.equal(reply.json.eventId, eventId);
    assert.equal(reply.json.releasedSeatCount, 3);
    assert.ok(reply.json.cancelledAt, 'the response says when');

    assert.equal((await bookingRow(bookingId)).status, 'cancelled');
    assert.deepEqual(await seatStatuses(seatIds), ['available', 'available', 'available']);
  });

  it('keeps the seat rows as history rather than deleting them', async () => {
    const { seatIds, userId, bookingId } = await seedBooking(2, '333.33');

    await cancel(bookingId, { userId });

    const seats = await query<{ show_seat_id: string; price: string; cancelled_at: Date | null }>(
      'SELECT show_seat_id, price, cancelled_at FROM booking_seats WHERE booking_id = $1 ORDER BY show_seat_id',
      [bookingId],
    );
    assert.equal(seats.rowCount, 2, 'the seat rows survive the cancellation');
    assert.deepEqual(seats.rows.map((row) => row.show_seat_id), [...seatIds].sort());
    assert.ok(seats.rows.every((row) => row.price === '333.33'), 'prices are untouched');
    assert.ok(seats.rows.every((row) => row.cancelled_at !== null), 'each row is stamped');
  });

  it('never rewrites the money', async () => {
    const { userId, bookingId } = await seedBooking(3, '450.10');
    const before = await bookingRow(bookingId);
    assert.equal(before.total_amount, '1350.30');

    const reply = await cancel(bookingId, { userId });

    const after = await bookingRow(bookingId);
    assert.equal(after.total_amount, '1350.30', 'the total is historical');
    assert.equal(after.currency, before.currency);
    assert.equal(reply.json.totalAmount, '1350.30', 'and the response still shows what was paid');
  });

  it('leaves the original hold converted', async () => {
    const { userId, bookingId, holdId } = await seedBooking(2);
    assert.equal(await holdStatus(holdId), 'converted');

    await cancel(bookingId, { userId });

    // Cancelling a booking is not undoing its confirmation. Resurrecting the
    // hold would hand the seats back to a reservation nobody asked for.
    assert.equal(await holdStatus(holdId), 'converted', 'converted stays converted');
  });

  it('releases only its own seats', async () => {
    const { eventId, seatIds } = await seedPricedShow(3);
    const userId = await seedCustomer();
    const mine = seatIds.slice(0, 1);
    const theirs = seatIds.slice(1);

    const holdA = await createHold({ eventId, userId, showSeatIds: mine, ttlSeconds: 600 });
    const booking = await confirm(eventId, holdA.holdId, userId);
    const holdB = await createHold({ eventId, userId, showSeatIds: theirs, ttlSeconds: 600 });
    const other = await confirm(eventId, holdB.holdId, userId);

    await cancel(booking.json.bookingId!, { userId });

    assert.deepEqual(await seatStatuses(mine), ['available']);
    assert.deepEqual(await seatStatuses(theirs), ['booked', 'booked'], "the other booking's seats stay sold");
    assert.equal((await bookingRow(other.json.bookingId!)).status, 'confirmed');
  });

  it('frees the seat for a genuinely new booking', async () => {
    const { seatIds, userId, bookingId, eventId } = await seedBooking(1);
    await cancel(bookingId, { userId });

    // The whole point of the release: someone else can now buy the seat, which
    // the old unique constraint on booking_seats.show_seat_id made impossible.
    const buyer = await seedCustomer();
    const hold = await createHold({ eventId, userId: buyer, showSeatIds: seatIds, ttlSeconds: 600 });
    const rebooked = await confirm(eventId, hold.holdId, buyer);

    assert.equal(rebooked.status, 201);
    assert.notEqual(rebooked.json.bookingId, bookingId);
    assert.deepEqual(await seatStatuses(seatIds), ['booked']);

    const history = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM booking_seats WHERE show_seat_id = $1',
      [seatIds[0]],
    );
    assert.equal(history.rows[0]!.count, '2', 'both sales are on record');
  });
});

describe('cancellation is refused when it should be', () => {
  it('requires authentication', async () => {
    const { bookingId, seatIds } = await seedBooking(1);

    const reply = await cancel(bookingId, { userId: null });

    assert.equal(reply.status, 401);
    assert.equal((await bookingRow(bookingId)).status, 'confirmed');
    assert.deepEqual(await seatStatuses(seatIds), ['booked']);
  });

  it('requires an Idempotency-Key', async () => {
    const { bookingId, userId } = await seedBooking(1);

    const reply = await cancel(bookingId, { userId, key: null });

    assert.equal(reply.status, 400);
    assert.match(reply.json.error!.message, /idempotency-key/i);
    assert.equal((await bookingRow(bookingId)).status, 'confirmed');
  });

  it('rejects a booking id that is not a uuid', async () => {
    const userId = await seedCustomer();

    const reply = await cancel('not-a-uuid', { userId });

    assert.equal(reply.status, 400);
    assert.equal(reply.json.error?.code, 'BAD_REQUEST');
  });

  it("refuses another user's booking without revealing that it exists", async () => {
    const { bookingId, seatIds } = await seedBooking(1);
    const attacker = await seedCustomer();

    const stolen = await cancel(bookingId, { userId: attacker });

    // 404, not 403: a 403 would confirm the booking id is real, and a real
    // booking reference is worth something at a support desk.
    assert.equal(stolen.status, 404);
    assert.equal(stolen.json.error?.details?.reason, 'BOOKING_NOT_FOUND');

    const imaginary = await cancel(randomUUID(), { userId: attacker });
    assert.equal(imaginary.status, stolen.status);
    assert.equal(imaginary.json.error?.code, stolen.json.error?.code);
    assert.equal(imaginary.json.error?.message, stolen.json.error?.message);
    assert.deepEqual(imaginary.json.error?.details, stolen.json.error?.details);

    assert.equal((await bookingRow(bookingId)).status, 'confirmed', 'the owner keeps their booking');
    assert.deepEqual(await seatStatuses(seatIds), ['booked']);
  });

  it('refuses a second cancellation under a different key', async () => {
    const { bookingId, userId, seatIds } = await seedBooking(2);

    const first = await cancel(bookingId, { userId });
    assert.equal(first.status, 200);

    // A different key, so this is a new request rather than a replay: the state
    // machine has to refuse it.
    const second = await cancel(bookingId, { userId });

    assert.equal(second.status, 409);
    assert.equal(second.json.error?.details?.reason, 'BOOKING_ALREADY_CANCELLED');
    assert.deepEqual(await seatStatuses(seatIds), ['available', 'available']);
  });

  it('does not release a seat twice when cancelled, resold and cancelled again', async () => {
    const { bookingId, userId, seatIds, eventId } = await seedBooking(1);
    await cancel(bookingId, { userId });

    const buyer = await seedCustomer();
    const hold = await createHold({ eventId, userId: buyer, showSeatIds: seatIds, ttlSeconds: 600 });
    const second = await confirm(eventId, hold.holdId, buyer);
    assert.deepEqual(await seatStatuses(seatIds), ['booked']);

    // The first booking is already cancelled; retrying it must not reach into
    // the seat that now belongs to someone else.
    const stale = await cancel(bookingId, { userId });
    assert.equal(stale.status, 409);
    assert.deepEqual(await seatStatuses(seatIds), ['booked'], "the new owner's seat is untouched");
    assert.equal((await bookingRow(second.json.bookingId!)).status, 'confirmed');
  });

  it('leaks no database detail on any rejection', async () => {
    const { bookingId } = await seedBooking(1);
    const attacker = await seedCustomer();

    const reply = await cancel(bookingId, { userId: attacker });

    for (const leak of ['bookings', 'show_seats', 'booking_seats', 'SELECT', 'FOR UPDATE', 'stack']) {
      assert.ok(!reply.raw.includes(leak), `the response must not mention ${leak}`);
    }
  });
});

describe('cancellation idempotency', () => {
  it('replays the original response for a repeated key', async () => {
    const { bookingId, userId, seatIds } = await seedBooking(2);
    const key = randomUUID();

    const first = await cancel(bookingId, { userId, key });
    const retry = await cancel(bookingId, { userId, key });

    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.json, first.json, 'byte-for-byte the same response');

    // And the work happened once: two seats released, two rows stamped.
    assert.deepEqual(await seatStatuses(seatIds), ['available', 'available']);
    const stamped = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM booking_seats WHERE booking_id = $1 AND cancelled_at IS NOT NULL',
      [bookingId],
    );
    assert.equal(stamped.rows[0]!.count, '2');
  });

  it('conflicts when the same key is reused for a different booking', async () => {
    const one = await seedBooking(1);
    const { eventId, seatIds } = await seedPricedShow(1);
    const hold = await createHold({
      eventId,
      userId: one.userId,
      showSeatIds: seatIds,
      ttlSeconds: 600,
    });
    const two = await confirm(eventId, hold.holdId, one.userId);
    const key = randomUUID();

    assert.equal((await cancel(one.bookingId, { userId: one.userId, key })).status, 200);

    const reused = await cancel(two.json.bookingId!, { userId: one.userId, key });

    assert.equal(reused.status, 409);
    assert.equal(reused.json.error?.details?.reason, 'idempotency_key_reuse');
    assert.equal((await bookingRow(two.json.bookingId!)).status, 'confirmed', 'untouched');
    assert.deepEqual(await seatStatuses(seatIds), ['booked']);
  });

  it('does not collide with a confirmation using the same key', async () => {
    const { eventId, seatIds } = await seedPricedShow(2);
    const userId = await seedCustomer();
    const key = randomUUID();

    const holdA = await createHold({
      eventId,
      userId,
      showSeatIds: [seatIds[0]!],
      ttlSeconds: 600,
    });
    const booked = await post(`/api/v1/events/${eventId}/holds/${holdA.holdId}/confirm`, {
      userId,
      key,
    });
    assert.equal(booked.status, 201);

    // Same user, same key, a different operation. The digests are tagged by
    // operation, so this is a reuse conflict rather than a replayed 201.
    const reply = await cancel(booked.json.bookingId!, { userId, key });

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'idempotency_key_reuse');
    assert.equal((await bookingRow(booked.json.bookingId!)).status, 'confirmed');
  });

  it('scopes the key to the user', async () => {
    const one = await seedBooking(1);
    const two = await seedBooking(1);
    const sharedKey = `shared-${randomUUID()}`;

    const a = await cancel(one.bookingId, { userId: one.userId, key: sharedKey });
    const b = await cancel(two.bookingId, { userId: two.userId, key: sharedKey });

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(a.json.bookingId, b.json.bookingId);
  });
});

/**
 * Raises an exception at a chosen point inside the cancellation transaction.
 *
 * A trigger rather than a CHECK constraint, because the six injection points
 * the spec asks for are not six tables: the idempotency claim and the stored
 * idempotency response are an INSERT and an UPDATE of the *same* row, and a
 * constraint cannot tell them apart. A `WHEN` clause can.
 */
async function withFailureAfter<T>(
  point: 'idempotency-claim' | 'booking-update' | 'seat-row-update' | 'seat-update' | 'idempotency-response',
  fn: () => Promise<T>,
): Promise<T> {
  const triggers = {
    'idempotency-claim': ['idempotency_keys', 'BEFORE INSERT', ''],
    'idempotency-response': ['idempotency_keys', 'BEFORE UPDATE', "WHEN (NEW.status = 'completed')"],
    'booking-update': ['bookings', 'BEFORE UPDATE', "WHEN (NEW.status = 'cancelled')"],
    'seat-row-update': ['booking_seats', 'BEFORE UPDATE', 'WHEN (NEW.cancelled_at IS NOT NULL)'],
    'seat-update': ['show_seats', 'BEFORE UPDATE', "WHEN (NEW.status = 'available')"],
  } as const;

  const [table, timing, when] = triggers[point];

  await query(`CREATE OR REPLACE FUNCTION tmp_inject_failure() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'injected failure'; END; $$ LANGUAGE plpgsql`);
  await query(`CREATE TRIGGER tmp_inject_failure ${timing} ON ${table}
    FOR EACH ROW ${when} EXECUTE FUNCTION tmp_inject_failure()`);

  try {
    return await fn();
  } finally {
    await query(`DROP TRIGGER tmp_inject_failure ON ${table}`);
    await query('DROP FUNCTION tmp_inject_failure()');
  }
}

describe('failure injection rolls the whole cancellation back', () => {
  const points = [
    'idempotency-claim',
    'booking-update',
    'seat-row-update',
    'seat-update',
    'idempotency-response',
  ] as const;

  for (const point of points) {
    it(`leaves the booking confirmed when ${point} fails`, async () => {
      const { bookingId, userId, seatIds, holdId } = await seedBooking(2);
      const key = randomUUID();

      const reply = await withFailureAfter(point, () => cancel(bookingId, { userId, key }));

      assert.equal(reply.status, 500);
      assert.equal(reply.json.error?.code, 'INTERNAL_SERVER_ERROR');

      // Nothing partial: the booking, its seat rows and the inventory are all
      // exactly as they were.
      assert.equal((await bookingRow(bookingId)).status, 'confirmed');
      assert.deepEqual(await seatStatuses(seatIds), ['booked', 'booked']);
      assert.equal(await holdStatus(holdId), 'converted');

      const stamped = await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM booking_seats WHERE booking_id = $1 AND cancelled_at IS NOT NULL',
        [bookingId],
      );
      assert.equal(stamped.rows[0]!.count, '0', 'no seat row was retired');

      // The claim rolled back with everything else, so the key is free again.
      // (The user already owns the confirmation's key, so this asks about this
      // request's key specifically.)
      const keys = await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM idempotency_keys WHERE user_id = $1 AND key = $2',
        [userId, key],
      );
      assert.equal(keys.rows[0]!.count, '0');
    });
  }

  for (const step of ['booking-lock', 'seat-lock'] as const) {
    it(`leaves the booking confirmed when the transaction dies after the ${step}`, async () => {
      const { bookingId, userId, seatIds } = await seedBooking(2);
      const key = randomUUID();

      // A lock cannot be broken by a constraint - SELECT ... FOR UPDATE has
      // nothing to violate - so this drives the same transaction directly and
      // throws at the point in question.
      await assert.rejects(
        runIdempotently(
          { userId, key, requestHash: 'failure-injection', successStatus: 200 },
          async (client) => {
            await lockBookingForCancellation(client, bookingId);
            if (step === 'seat-lock') {
              await lockBookingSeats(client, bookingId);
            }
            throw new Error('injected failure');
          },
        ),
        /injected failure/,
      );

      assert.equal((await bookingRow(bookingId)).status, 'confirmed');
      assert.deepEqual(await seatStatuses(seatIds), ['booked', 'booked']);

      const keys = await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM idempotency_keys WHERE user_id = $1 AND key = $2',
        [userId, key],
      );
      assert.equal(keys.rows[0]!.count, '0', 'the claim rolled back too');

      // And the booking is still cancellable afterwards - the failure left no
      // lock, no claim and no state behind.
      assert.equal((await cancel(bookingId, { userId })).status, 200);
      assert.deepEqual(await seatStatuses(seatIds), ['available', 'available']);
    });
  }

  it('commits everything or nothing, never a released seat under a confirmed booking', async () => {
    const { bookingId, userId, seatIds } = await seedBooking(3);

    // The seat release is the last write. Failing it must take the booking
    // transition back with it, which is the invariant the ordering exists for.
    await withFailureAfter('seat-update', () => cancel(bookingId, { userId }));

    const orphaned = await query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM booking_seats bs
       JOIN bookings b ON b.id = bs.booking_id
       JOIN show_seats ss ON ss.id = bs.show_seat_id
       WHERE b.id = $1 AND b.status = 'confirmed' AND ss.status <> 'booked'`,
      [bookingId],
    );
    assert.equal(orphaned.rows[0]!.count, '0', 'no seat is free while its booking still claims it');
    assert.deepEqual(await seatStatuses(seatIds), ['booked', 'booked', 'booked']);
  });
});

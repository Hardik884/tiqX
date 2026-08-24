import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query, withTransaction } from '../src/db/pool.js';
import { createEvent, publishEvent } from '../src/modules/events/event.service.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import { expireHold } from '../src/modules/expiration/expiration.service.js';
import {
  claimPendingSeatStatusEvents,
  markSeatStatusEventProcessed,
} from '../src/modules/realtime/seat-status-outbox.repository.js';
import { attachWebSocketServer, closeWebSocketServer } from '../src/realtime/websocket-server.js';
import { getRedis } from '../src/redis/client.js';
import { seatEventsChannel } from '../src/redis/keys.js';
import { runAllocationPass } from '../src/modules/waitlist/waitlist.service.js';
import { claimPendingAllocations, markAllocationProcessed } from '../src/modules/waitlist/waitlist-outbox.repository.js';
import { accessTokenForUser } from './helpers/auth.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace } from './helpers/redis.js';
import { cleanupSeedData, seedCustomer, seedOrganiser, seedVenue } from './helpers/seed.js';
import { connectClient, send, waitForMessage, waitForOpen } from './helpers/ws.js';
import type { ServerMessage } from '../src/realtime/message-types.js';

let server: Server;
let baseUrl: string;

before(async () => {
  await connectTestRedis();
  await flushTestNamespace();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await attachWebSocketServer(server);
});

after(async () => {
  await closeWebSocketServer();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await query('DELETE FROM idempotency_keys');
  await flushTestNamespace();
  await closeTestRedis();
  await cleanupSeedData();
  await closePool();
});

/**
 * Claims and publishes every pending seat-status event once - the worker's
 * own loop, run inline rather than as a spawned process, matching every other
 * outbox-driven test in this suite (`processAllocationOutbox`,
 * `processAllocationOutboxConcurrently` in the waitlist tests).
 */
async function processSeatStatusOutbox(): Promise<number> {
  return withTransaction(async (client) => {
    const rows = await claimPendingSeatStatusEvents(client, 200);
    for (const row of rows) {
      const message: ServerMessage = {
        type: row.eventType,
        version: 1,
        eventId: row.eventId,
        seatId: row.showSeatId,
        status: row.status,
        seatVersion: row.seatVersion,
        occurredAt: row.occurredAt.toISOString(),
      };
      await getRedis().publish(seatEventsChannel(row.eventId), JSON.stringify(message));
      await markSeatStatusEventProcessed(client, row.id);
    }
    return rows.length;
  });
}

async function processAllocationOutbox(): Promise<void> {
  await withTransaction(async (client) => {
    const rows = await claimPendingAllocations(client, 100);
    for (const row of rows) {
      await runAllocationPass(client, row.eventId, row.seatCategory, undefined);
      await markAllocationProcessed(client, row.id);
    }
  });
}

async function post(path: string, userId: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await accessTokenForUser(userId)}`,
      'idempotency-key': randomUUID(),
    },
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} };
}

interface Show {
  eventId: string;
  organiserId: string;
  seatIds: string[];
}

async function seedPublishedShow(seatCount: number): Promise<Show> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', 12);
  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Realtime events ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
    pricing: { standard: '100.00' },
  });
  await publishEvent({ eventId: event.id, userId: organiserId, userRole: 'organiser' }, undefined);
  const seats = await query<{ id: string }>('SELECT id FROM show_seats WHERE event_id = $1 ORDER BY id', [
    event.id,
  ]);
  return { eventId: event.id, organiserId, seatIds: seats.rows.map((row) => row.id) };
}

async function subscribedClient(eventId: string) {
  const ws = connectClient(baseUrl);
  await waitForOpen(ws);
  send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
  await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED');
  return ws;
}

/**
 * TEST-HELPER RACE, NOT AN APPLICATION BUG - worth documenting because it
 * cost real time to track down.
 *
 * Every test below calls `waitForMessage` in a way that registers the
 * listener *before* the action that triggers the message, e.g.:
 *
 *     const expectHeld = waitForMessage(ws, (m) => m.type === 'SEAT_HELD');
 *     await createHold(...);
 *     await processSeatStatusOutbox();
 *     const message = await expectHeld;
 *
 * not the more natural-looking
 *
 *     await createHold(...);
 *     await processSeatStatusOutbox();
 *     const message = await waitForMessage(ws, ...);   // WRONG
 *
 * The second form loses the message outright on a fast, local connection: a
 * localhost round trip can complete inside the same tick sequence that
 * `processSeatStatusOutbox`'s own `await`s already span, so the client's
 * underlying `message` event can fire - and be silently dropped, since
 * `EventEmitter` never queues an event for a listener that isn't attached
 * yet - before `waitForMessage` gets around to attaching one. A real client
 * never hits this: a browser (or `ws.on('message', ...)` called immediately
 * after connecting) always has its listener in place well before any
 * message could exist. `waitForMessage`'s Promise executor runs
 * synchronously, so calling it (without awaiting yet) is what attaches the
 * listener in time; only the `await` needs to move to after the trigger.
 */
describe('SEAT_HELD, SEAT_BOOKED, SEAT_RELEASED end to end', () => {
  it('delivers SEAT_HELD when a customer places a hold', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const ws = await subscribedClient(eventId);
    const userId = await seedCustomer();

    const expectHeld = waitForMessage(ws, (m) => m.type === 'SEAT_HELD');
    const hold = await createHold({ eventId, userId, showSeatIds: [seatIds[0]!], ttlSeconds: 600 });
    await processSeatStatusOutbox();
    const message = await expectHeld;

    assert.deepEqual(message, {
      type: 'SEAT_HELD',
      version: 1,
      eventId,
      seatId: seatIds[0],
      status: 'held',
      seatVersion: '1',
      occurredAt: (message as { occurredAt: string }).occurredAt,
    });
    assert.ok(hold.holdId);

    ws.close();
  });

  it('delivers SEAT_BOOKED when the hold is confirmed, with seatVersion advancing', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const ws = await subscribedClient(eventId);
    const userId = await seedCustomer();

    const expectHeld = waitForMessage(ws, (m) => m.type === 'SEAT_HELD');
    const hold = await createHold({ eventId, userId, showSeatIds: [seatIds[0]!], ttlSeconds: 600 });
    await processSeatStatusOutbox();
    await expectHeld;

    const expectBooked = waitForMessage(ws, (m) => m.type === 'SEAT_BOOKED');
    const confirm = await post(`/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`, userId);
    assert.equal(confirm.status, 201);
    await processSeatStatusOutbox();
    const booked = await expectBooked;

    assert.equal((booked as { status: string }).status, 'booked');
    assert.equal((booked as { seatVersion: string }).seatVersion, '2', 'strictly greater than the held event');

    ws.close();
  });

  it('delivers SEAT_RELEASED when a booking is cancelled', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const ws = await subscribedClient(eventId);
    const userId = await seedCustomer();

    const expectHeld = waitForMessage(ws, (m) => m.type === 'SEAT_HELD');
    const hold = await createHold({ eventId, userId, showSeatIds: [seatIds[0]!], ttlSeconds: 600 });
    const expectBooked = waitForMessage(ws, (m) => m.type === 'SEAT_BOOKED');
    const confirm = await post(`/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`, userId);
    await processSeatStatusOutbox();
    await expectHeld;
    await expectBooked;

    const expectReleased = waitForMessage(ws, (m) => m.type === 'SEAT_RELEASED');
    const cancel = await post(`/api/v1/bookings/${confirm.json.bookingId}/cancel`, userId);
    assert.equal(cancel.status, 200);
    await processSeatStatusOutbox();
    const released = await expectReleased;

    assert.equal((released as { status: string }).status, 'available');
    assert.equal((released as { seatVersion: string }).seatVersion, '3');

    ws.close();
  });

  it('delivers SEAT_RELEASED when a hold expires, never leaking who held it', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const ws = await subscribedClient(eventId);
    const userId = await seedCustomer();

    const expectHeld = waitForMessage(ws, (m) => m.type === 'SEAT_HELD');
    const hold = await createHold({ eventId, userId, showSeatIds: [seatIds[0]!], ttlSeconds: 1 });
    await processSeatStatusOutbox();
    await expectHeld;

    await query("UPDATE reservation_holds SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      hold.holdId,
    ]);
    const expectReleased = waitForMessage(ws, (m) => m.type === 'SEAT_RELEASED');
    assert.equal(await expireHold(hold.holdId), 'expired');
    await processSeatStatusOutbox();
    const released = await expectReleased;

    const raw = JSON.stringify(released);
    assert.ok(!raw.includes(userId), 'no user id in a seat event, ever');
    assert.ok(!raw.includes(hold.holdId), 'no hold id in a seat event, ever');

    ws.close();
  });

  it('delivers SEAT_HELD for a waitlist offer, and SEAT_BOOKED when it is accepted', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const owner = await seedCustomer();
    const hold = await createHold({ eventId, userId: owner, showSeatIds: [seatIds[0]!], ttlSeconds: 600 });
    const confirm = await post(`/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`, owner);
    await processSeatStatusOutbox();

    const waiter = await seedCustomer();
    await fetch(`${baseUrl}/api/v1/events/${eventId}/waitlist`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await accessTokenForUser(waiter)}`,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ seatCategory: 'standard' }),
    });

    const ws = await subscribedClient(eventId);

    const expectHeld = waitForMessage(ws, (m) => m.type === 'SEAT_HELD');
    await post(`/api/v1/bookings/${confirm.json.bookingId}/cancel`, owner);
    await processAllocationOutbox();
    await processSeatStatusOutbox();
    const offeredHeld = await expectHeld;
    assert.equal((offeredHeld as { status: string }).status, 'held');

    const offer = await query<{ id: string }>('SELECT id FROM waitlist_offers WHERE show_seat_id = $1', [
      seatIds[0],
    ]);
    const expectBooked = waitForMessage(ws, (m) => m.type === 'SEAT_BOOKED');
    const acceptReply = await post(`/api/v1/waitlist/offers/${offer.rows[0]!.id}/accept`, waiter);
    assert.equal(acceptReply.status, 200);
    await processSeatStatusOutbox();
    const booked = await expectBooked;

    assert.equal((booked as { status: string }).status, 'booked');

    ws.close();
  });
});

describe('version monotonicity', () => {
  it('never delivers a seatVersion out of order for one seat', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const ws = await subscribedClient(eventId);
    const userId = await seedCustomer();

    const seen: number[] = [];
    const collectNext = () =>
      waitForMessage(ws, (m) => 'seatVersion' in m && Number(m.seatVersion) > (seen.at(-1) ?? 0));

    const first = collectNext();
    const hold = await createHold({ eventId, userId, showSeatIds: [seatIds[0]!], ttlSeconds: 600 });
    await processSeatStatusOutbox();
    seen.push(Number((await first as { seatVersion: string }).seatVersion));

    const second = collectNext();
    const confirm = await post(`/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`, userId);
    await processSeatStatusOutbox();
    seen.push(Number((await second as { seatVersion: string }).seatVersion));

    const third = collectNext();
    await post(`/api/v1/bookings/${confirm.json.bookingId}/cancel`, userId);
    await processSeatStatusOutbox();
    seen.push(Number((await third as { seatVersion: string }).seatVersion));

    assert.deepEqual(seen, [1, 2, 3]);
    ws.close();
  });
});

describe('duplicate outbox delivery', () => {
  it('is safe: a re-delivered event just repeats, and a client can detect it via seatVersion', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const ws = await subscribedClient(eventId);
    const userId = await seedCustomer();

    const expectHeld = waitForMessage(ws, (m) => m.type === 'SEAT_HELD');
    await createHold({ eventId, userId, showSeatIds: [seatIds[0]!], ttlSeconds: 600 });
    await processSeatStatusOutbox();
    const first = await expectHeld;

    // Simulate the worker's own documented failure mode: it published
    // successfully but crashed before marking the row processed, so a later
    // pass (by this worker or another) re-delivers the identical event.
    const expectRedelivery = waitForMessage(ws, (m) => m.type === 'SEAT_HELD');
    await getRedis().publish(seatEventsChannel(eventId), JSON.stringify(first));
    const second = await expectRedelivery;

    assert.deepEqual(second, first, 'the redelivered event is byte-identical');
    // A client dedupes on (seatId, seatVersion) - both copies carry the same
    // version, which is exactly what tells it these are the same fact twice.
    assert.equal((second as { seatVersion: string }).seatVersion, (first as { seatVersion: string }).seatVersion);

    ws.close();
  });
});

describe('outbox atomicity', () => {
  it('produces zero seat-status events when the confirming transaction rolls back', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: [seatIds[0]!], ttlSeconds: 600 });
    await processSeatStatusOutbox();

    const before = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM seat_status_outbox WHERE show_seat_id = $1',
      [seatIds[0]],
    );

    await query(`ALTER TABLE bookings ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID`);
    try {
      const reply = await post(`/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`, userId);
      assert.equal(reply.status, 500);
    } finally {
      await query(`ALTER TABLE bookings DROP CONSTRAINT tmp_force_failure`);
    }

    const after = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM seat_status_outbox WHERE show_seat_id = $1',
      [seatIds[0]],
    );
    assert.equal(after.rows[0]!.count, before.rows[0]!.count, 'no event for a transaction that never committed');

    const seat = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [seatIds[0]]);
    assert.equal(seat.rows[0]!.status, 'held', 'and the seat itself is unchanged');
  });

  it('produces exactly one event per committed transition, however many statements it took', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const userId = await seedCustomer();

    const hold = await createHold({ eventId, userId, showSeatIds: [seatIds[0]!], ttlSeconds: 600 });
    const confirm = await post(`/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`, userId);
    assert.equal(confirm.status, 201);

    const events = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM seat_status_outbox WHERE show_seat_id = $1 AND event_type = 'SEAT_BOOKED'`,
      [seatIds[0]],
    );
    assert.equal(events.rows[0]!.count, '1');
  });
});

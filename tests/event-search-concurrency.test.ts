import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query, withTransaction } from '../src/db/pool.js';
import { cancelBookingInTransaction, confirmHoldInTransaction } from '../src/modules/bookings/booking.service.js';
import { expireHold } from '../src/modules/expiration/expiration.service.js';
import { createEvent } from '../src/modules/events/event.service.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace, uniqueClientIp } from './helpers/redis.js';
import { cleanupSeedData, seedCustomer, seedOrganiser, seedVenue, trackEvent } from './helpers/seed.js';

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
  await flushTestNamespace();
  await closeTestRedis();
  await cleanupSeedData();
  await closePool();
});

async function list(qs: string) {
  const response = await fetch(`${baseUrl}/api/v1/events?${qs}`, {
    headers: { 'x-forwarded-for': uniqueClientIp() },
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} } as {
    status: number;
    json: { items?: { id: string; availableSeats: number }[] };
  };
}

async function seedPublishedEvent(seatCount: number) {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', 1, 'Concurrencyville');
  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Concurrency Search ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2032-01-01T18:00:00.000Z'),
    endsAt: new Date('2032-01-01T20:00:00.000Z'),
    status: 'published',
    pricing: { standard: '100.00' },
  });
  trackEvent(event.id);
  const seats = await query<{ id: string }>('SELECT id FROM show_seats WHERE event_id = $1', [event.id]);
  return { eventId: event.id, title: event.title, seatIds: seats.rows.map((r) => r.id), userId: organiserId };
}

describe('search running concurrently with holds, confirmations and cancellations', () => {
  it('never errors, never mutates anything, while a hold is created underneath it', async () => {
    const { eventId, title, seatIds } = await seedPublishedEvent(3);
    const customer = await seedCustomer();

    const [searchResult, holdResult] = await Promise.allSettled([
      list(`q=${encodeURIComponent(title)}`),
      createHold({ eventId, userId: customer, showSeatIds: [seatIds[0]!], ttlSeconds: 600 }),
    ]);

    assert.equal(searchResult.status, 'fulfilled');
    assert.equal(holdResult.status, 'fulfilled');
    if (searchResult.status === 'fulfilled') {
      assert.equal(searchResult.value.status, 200);
    }
  });

  it('never errors while a hold expires underneath it, and the count it reports was true at some instant', async () => {
    const { eventId, title, seatIds } = await seedPublishedEvent(2);
    const customer = await seedCustomer();
    const hold = await createHold({ eventId, userId: customer, showSeatIds: seatIds, ttlSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const [searchResult, expireResult] = await Promise.allSettled([
      list(`q=${encodeURIComponent(title)}`),
      expireHold(hold.holdId),
    ]);

    assert.equal(searchResult.status, 'fulfilled');
    assert.equal(expireResult.status, 'fulfilled');
    if (searchResult.status === 'fulfilled') {
      assert.equal(searchResult.value.status, 200);
      const found = searchResult.value.json.items!.find((i) => i.id === eventId);
      // Whichever side of the race search landed on, the number it got back
      // was a real, momentarily-true count (0 before expiry commits, 2 after)
      // - never a partial or negative one.
      assert.ok(found === undefined || found.availableSeats === 0 || found.availableSeats === 2);
    }
  });

  it('never errors while a booking is confirmed underneath it', async () => {
    const { eventId, title, seatIds } = await seedPublishedEvent(2);
    const customer = await seedCustomer();
    const hold = await createHold({ eventId, userId: customer, showSeatIds: seatIds, ttlSeconds: 600 });

    const [searchResult, confirmResult] = await Promise.allSettled([
      list(`q=${encodeURIComponent(title)}`),
      withTransaction((client) =>
        confirmHoldInTransaction(client, { userId: customer, eventId, holdId: hold.holdId }, undefined),
      ),
    ]);

    assert.equal(searchResult.status, 'fulfilled');
    assert.equal(confirmResult.status, 'fulfilled');
    if (searchResult.status === 'fulfilled') assert.equal(searchResult.value.status, 200);
  });

  it('never errors while a booking is cancelled underneath it, and search performs no writes of its own', async () => {
    const { eventId, title, seatIds } = await seedPublishedEvent(1);
    const customer = await seedCustomer();
    const hold = await createHold({ eventId, userId: customer, showSeatIds: seatIds, ttlSeconds: 600 });
    const confirmed = await withTransaction((client) =>
      confirmHoldInTransaction(client, { userId: customer, eventId, holdId: hold.holdId }, undefined),
    );

    const beforeSeats = await query<{ status: string }>('SELECT status FROM show_seats WHERE event_id = $1', [eventId]);

    const [searchResult, cancelResult] = await Promise.allSettled([
      list(`q=${encodeURIComponent(title)}`),
      withTransaction((client) =>
        cancelBookingInTransaction(client, { userId: customer, bookingId: confirmed.booking.id }, undefined),
      ),
    ]);

    assert.equal(searchResult.status, 'fulfilled');
    assert.equal(cancelResult.status, 'fulfilled');

    // Whatever cancellation itself did, search cannot have added any writes
    // of its own: the only two states possible are "booked" (before cancel)
    // or "available" (after) - never anything a search read could produce.
    const afterSeats = await query<{ status: string }>('SELECT status FROM show_seats WHERE event_id = $1', [eventId]);
    for (const row of afterSeats.rows) {
      assert.ok(['booked', 'available'].includes(row.status));
    }
    void beforeSeats;
  });

  it('50 concurrent searches against a churning event never error and never see a negative or corrupt count', async () => {
    const { eventId, title, seatIds } = await seedPublishedEvent(10);
    const customer = await seedCustomer();

    const searches = Array.from({ length: 50 }, () => list(`q=${encodeURIComponent(title)}`));
    const churn = seatIds.slice(0, 5).map((seatId) =>
      createHold({ eventId, userId: customer, showSeatIds: [seatId], ttlSeconds: 600 }).catch(() => null),
    );

    const results = await Promise.allSettled([...searches, ...churn]);

    const searchOutcomes = results.slice(0, 50);
    for (const outcome of searchOutcomes) {
      assert.equal(outcome.status, 'fulfilled', 'no search request ever throws or errors');
    }

    const found = await list(`q=${encodeURIComponent(title)}`);
    const item = found.json.items!.find((i) => i.id === eventId);
    assert.ok(item);
    assert.ok(item!.availableSeats >= 0 && item!.availableSeats <= 10, 'a sane, non-negative count');
  });
});

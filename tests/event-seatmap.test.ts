import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { accessTokenForUser } from './helpers/auth.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace } from './helpers/redis.js';
import { cleanupSeedData, seedCustomer, seedShow } from './helpers/seed.js';

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

interface SeatEntry {
  id: string;
  rowLabel: string;
  seatNumber: number;
  price: string;
  status: string;
}

interface Reply {
  status: number;
  json: { seats?: SeatEntry[]; error?: { code: string; details?: { reason?: string } } };
}

async function seatMap(eventId: string, userId?: string | null): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (userId != null) {
    headers.authorization = `Bearer ${await accessTokenForUser(userId)}`;
  }
  const response = await fetch(`${baseUrl}/api/v1/events/${eventId}/seats`, { headers });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} };
}

describe('GET /api/v1/events/:eventId/seats', () => {
  it('returns row, seat number, price and status for a published event, anonymously', async () => {
    const { eventId, organiserId } = await seedShow(3);
    await query("UPDATE events SET status = 'published' WHERE id = $1", [eventId]);

    const reply = await seatMap(eventId);

    assert.equal(reply.status, 200);
    assert.equal(reply.json.seats!.length, 3);
    for (const seat of reply.json.seats!) {
      assert.ok(seat.rowLabel);
      assert.ok(typeof seat.seatNumber === 'number');
      assert.ok(typeof seat.price === 'string');
      assert.ok(['available', 'held', 'booked'].includes(seat.status));
    }
    void organiserId;
  });

  it('never exposes hold id, hold owner, user id or reservation id', async () => {
    const { eventId } = await seedShow(2);
    await query("UPDATE events SET status = 'published' WHERE id = $1", [eventId]);

    const reply = await seatMap(eventId);
    const text = JSON.stringify(reply.json);

    assert.ok(!text.includes('holdId'));
    assert.ok(!text.includes('userId'));
    assert.ok(!text.includes('reservationId'));
    assert.ok(!text.includes('expiresAt'));
  });

  it('reflects held and booked status without revealing who holds/booked them', async () => {
    const { eventId } = await seedShow(2);
    await query("UPDATE events SET status = 'published' WHERE id = $1", [eventId]);
    const seats = await query<{ id: string }>('SELECT id FROM show_seats WHERE event_id = $1 ORDER BY id', [eventId]);
    await query("UPDATE show_seats SET status = 'held' WHERE id = $1", [seats.rows[0]!.id]);
    await query("UPDATE show_seats SET status = 'booked' WHERE id = $1", [seats.rows[1]!.id]);

    const reply = await seatMap(eventId);
    const statuses = reply.json.seats!.map((s) => s.status).sort();
    assert.deepEqual(statuses, ['booked', 'held']);
  });

  it('hides the seat map of a draft event from anonymous callers, same as the event itself', async () => {
    const { eventId } = await seedShow(2);
    const reply = await seatMap(eventId);
    assert.equal(reply.status, 404);
  });

  it('hides the seat map of a draft event from a customer', async () => {
    const { eventId } = await seedShow(2);
    const customer = await seedCustomer();
    const reply = await seatMap(eventId, customer);
    assert.equal(reply.status, 404);
  });

  it('shows the seat map of a draft event to its own organiser', async () => {
    const { eventId, organiserId } = await seedShow(2);
    const reply = await seatMap(eventId, organiserId);
    assert.equal(reply.status, 200);
    assert.equal(reply.json.seats!.length, 2);
  });

  it('answers a nonexistent event with 404', async () => {
    const reply = await seatMap(randomUUID());
    assert.equal(reply.status, 404);
  });

  it('never mutates anything - repeated reads leave every seat status untouched', async () => {
    const { eventId } = await seedShow(2);
    await query("UPDATE events SET status = 'published' WHERE id = $1", [eventId]);

    const before = await query<{ status: string }>(
      'SELECT status FROM show_seats WHERE event_id = $1 ORDER BY id',
      [eventId],
    );

    for (let i = 0; i < 5; i += 1) {
      await seatMap(eventId);
    }

    const after = await query<{ status: string }>(
      'SELECT status FROM show_seats WHERE event_id = $1 ORDER BY id',
      [eventId],
    );
    assert.deepEqual(after.rows, before.rows);
  });
});

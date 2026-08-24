import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { createEvent } from '../src/modules/events/event.service.js';
import { publishEvent } from '../src/modules/events/event.service.js';
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
  waitlistEntryId?: string;
  eventId?: string;
  seatCategory?: string;
  status?: string;
  error?: { code: string; message: string; details?: { reason?: string } };
}

interface Reply {
  status: number;
  json: Body;
  raw: string;
}

async function post(
  path: string,
  options: { userId?: string | null; key?: string | null; body?: unknown } = {},
): Promise<Reply> {
  const key = options.key === undefined ? randomUUID() : options.key;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== null) {
    headers['idempotency-key'] = key;
  }
  if (options.userId != null) {
    headers.authorization = `Bearer ${await accessTokenForUser(options.userId)}`;
  }

  const init: RequestInit = { method: 'POST', headers };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const raw = await response.text();
  return { status: response.status, json: raw ? (JSON.parse(raw) as Body) : {}, raw };
}

async function join(
  eventId: string,
  options: { userId?: string | null; key?: string | null; seatCategory?: string } = {},
): Promise<Reply> {
  const postOptions: Parameters<typeof post>[1] = {
    body: { seatCategory: options.seatCategory ?? 'standard' },
  };
  if (options.userId !== undefined) {
    postOptions.userId = options.userId;
  }
  if (options.key !== undefined) {
    postOptions.key = options.key;
  }
  return post(`/api/v1/events/${eventId}/waitlist`, postOptions);
}

async function leave(
  eventId: string,
  entryId: string,
  options: { userId?: string | null } = {},
): Promise<Reply> {
  const postOptions: Parameters<typeof post>[1] = { key: null };
  if (options.userId !== undefined) {
    postOptions.userId = options.userId;
  }
  return post(`/api/v1/events/${eventId}/waitlist/${entryId}/leave`, postOptions);
}

interface Show {
  eventId: string;
  organiserId: string;
  seatIds: string[];
}

/** A published event with `seatCount` standard seats, ready to be waitlisted for. */
async function seedPublishedShow(seatCount: number, category: 'standard' | 'premium' = 'standard'): Promise<Show> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', 12, null, category);
  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Waitlist ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
    pricing: { standard: '100.00', premium: '250.00' },
  });
  await publishEvent({ eventId: event.id, userId: organiserId, userRole: 'organiser' }, undefined);

  const seats = await query<{ id: string }>('SELECT id FROM show_seats WHERE event_id = $1 ORDER BY id', [
    event.id,
  ]);
  return { eventId: event.id, organiserId, seatIds: seats.rows.map((row) => row.id) };
}

async function entryStatus(entryId: string): Promise<string> {
  const result = await query<{ status: string }>('SELECT status FROM waitlist_entries WHERE id = $1', [
    entryId,
  ]);
  return result.rows[0]!.status;
}

describe('joining the waitlist', () => {
  it('creates a waiting entry', async () => {
    const { eventId } = await seedPublishedShow(2);
    const userId = await seedCustomer();

    const reply = await join(eventId, { userId, seatCategory: 'standard' });

    assert.equal(reply.status, 201);
    assert.equal(reply.json.eventId, eventId);
    assert.equal(reply.json.seatCategory, 'standard');
    assert.equal(reply.json.status, 'waiting');
    assert.ok(reply.json.waitlistEntryId);

    assert.equal(await entryStatus(reply.json.waitlistEntryId!), 'waiting');
  });

  it('joins even when seats of that category are currently available', async () => {
    // The task is explicit: a join must not be made impossible by a seat
    // freeing up between a check and the transaction, and its own validation
    // list does not include an availability gate. This proves the join is not
    // blocked just because the event is not actually sold out.
    const { eventId } = await seedPublishedShow(3);
    const userId = await seedCustomer();

    const reply = await join(eventId, { userId });

    assert.equal(reply.status, 201);
  });

  it('lets a customer queue for two different categories of the same event', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(1, 'A', 12, null, 'standard');
    await query(
      `INSERT INTO venue_seats (venue_id, row_label, seat_number, category) VALUES ($1, 'B', 1, 'premium')`,
      [venueId],
    );
    const { event } = await createEvent({
      organiserId,
      venueId,
      title: `Mixed ${randomUUID()}`,
      eventType: 'concert',
      startsAt: new Date('2030-01-01T18:00:00.000Z'),
      endsAt: new Date('2030-01-01T20:00:00.000Z'),
    });
    await publishEvent({ eventId: event.id, userId: organiserId, userRole: 'organiser' }, undefined);
    const userId = await seedCustomer();

    const standard = await join(event.id, { userId, seatCategory: 'standard' });
    const premium = await join(event.id, { userId, seatCategory: 'premium' });

    assert.equal(standard.status, 201);
    assert.equal(premium.status, 201);
    assert.notEqual(standard.json.waitlistEntryId, premium.json.waitlistEntryId);
  });
});

describe('joining is refused when it should be', () => {
  it('requires authentication', async () => {
    const { eventId } = await seedPublishedShow(1);

    const reply = await join(eventId, { userId: null });

    assert.equal(reply.status, 401);
  });

  it('requires an Idempotency-Key', async () => {
    const { eventId } = await seedPublishedShow(1);
    const userId = await seedCustomer();

    const reply = await join(eventId, { userId, key: null });

    assert.equal(reply.status, 400);
    assert.match(reply.json.error!.message, /idempotency-key/i);
  });

  it('rejects an invalid seat category', async () => {
    const { eventId } = await seedPublishedShow(1);
    const userId = await seedCustomer();

    const reply = await join(eventId, { userId, seatCategory: 'vip' });

    assert.equal(reply.status, 400);
  });

  it('404s for an event that does not exist', async () => {
    const userId = await seedCustomer();

    const reply = await join(randomUUID(), { userId });

    assert.equal(reply.status, 404);
  });

  it('refuses a draft event', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(1, 'A', 12);
    const { event } = await createEvent({
      organiserId,
      venueId,
      title: `Draft ${randomUUID()}`,
      eventType: 'concert',
      startsAt: new Date('2030-01-01T18:00:00.000Z'),
      endsAt: new Date('2030-01-01T20:00:00.000Z'),
    });
    const userId = await seedCustomer();

    const reply = await join(event.id, { userId });

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'EVENT_NOT_JOINABLE');
  });

  it('404s for a category the venue has no seats of', async () => {
    const { eventId } = await seedPublishedShow(1, 'standard');
    const userId = await seedCustomer();

    const reply = await join(eventId, { userId, seatCategory: 'premium' });

    assert.equal(reply.status, 404);
    assert.equal(reply.json.error?.details?.reason, 'CATEGORY_NOT_FOUND');
  });

  it('refuses a second active membership for the same event and category', async () => {
    const { eventId } = await seedPublishedShow(1);
    const userId = await seedCustomer();

    const first = await join(eventId, { userId });
    assert.equal(first.status, 201);

    const second = await join(eventId, { userId });

    assert.equal(second.status, 409);
    assert.equal(second.json.error?.details?.reason, 'ALREADY_ON_WAITLIST');
  });
});

describe('waitlist join idempotency', () => {
  it('replays the original entry for a repeated key', async () => {
    const { eventId } = await seedPublishedShow(1);
    const userId = await seedCustomer();
    const key = randomUUID();

    const first = await join(eventId, { userId, key });
    const retry = await join(eventId, { userId, key });

    assert.equal(first.status, 201);
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.json, first.json);

    const count = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waitlist_entries WHERE event_id = $1 AND user_id = $2',
      [eventId, userId],
    );
    assert.equal(count.rows[0]!.count, '1', 'no duplicate entry');
  });

  it('conflicts when the same key is reused for a different category', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(1, 'A', 12, null, 'standard');
    await query(
      `INSERT INTO venue_seats (venue_id, row_label, seat_number, category) VALUES ($1, 'B', 1, 'premium')`,
      [venueId],
    );
    const { event } = await createEvent({
      organiserId,
      venueId,
      title: `Reuse ${randomUUID()}`,
      eventType: 'concert',
      startsAt: new Date('2030-01-01T18:00:00.000Z'),
      endsAt: new Date('2030-01-01T20:00:00.000Z'),
    });
    await publishEvent({ eventId: event.id, userId: organiserId, userRole: 'organiser' }, undefined);
    const userId = await seedCustomer();
    const key = randomUUID();

    assert.equal((await join(event.id, { userId, key, seatCategory: 'standard' })).status, 201);

    const reused = await join(event.id, { userId, key, seatCategory: 'premium' });

    assert.equal(reused.status, 409);
    assert.equal(reused.json.error?.details?.reason, 'idempotency_key_reuse');
  });
});

describe('leaving the waitlist', () => {
  it('cancels a waiting entry', async () => {
    const { eventId } = await seedPublishedShow(1);
    const userId = await seedCustomer();
    const entry = await join(eventId, { userId });

    const reply = await leave(eventId, entry.json.waitlistEntryId!, { userId });

    assert.equal(reply.status, 200);
    assert.equal(reply.json.status, 'cancelled');
    assert.equal(await entryStatus(entry.json.waitlistEntryId!), 'cancelled');
  });

  it('lets the customer join again after leaving', async () => {
    const { eventId } = await seedPublishedShow(1);
    const userId = await seedCustomer();
    const entry = await join(eventId, { userId });
    await leave(eventId, entry.json.waitlistEntryId!, { userId });

    const rejoined = await join(eventId, { userId });

    assert.equal(rejoined.status, 201);
    assert.notEqual(rejoined.json.waitlistEntryId, entry.json.waitlistEntryId);
  });

  it("refuses another user's entry without revealing that it exists", async () => {
    const { eventId } = await seedPublishedShow(1);
    const owner = await seedCustomer();
    const attacker = await seedCustomer();
    const entry = await join(eventId, { userId: owner });

    const stolen = await leave(eventId, entry.json.waitlistEntryId!, { userId: attacker });

    assert.equal(stolen.status, 404);
    assert.equal(stolen.json.error?.details?.reason, 'WAITLIST_ENTRY_NOT_FOUND');

    const imaginary = await leave(eventId, randomUUID(), { userId: attacker });
    assert.equal(imaginary.status, stolen.status);
    assert.equal(imaginary.json.error?.code, stolen.json.error?.code);
    assert.equal(imaginary.json.error?.message, stolen.json.error?.message);

    assert.equal(await entryStatus(entry.json.waitlistEntryId!), 'waiting', 'the owner keeps their place');
  });

  it('refuses a second leave under an already-left entry', async () => {
    const { eventId } = await seedPublishedShow(1);
    const userId = await seedCustomer();
    const entry = await join(eventId, { userId });
    assert.equal((await leave(eventId, entry.json.waitlistEntryId!, { userId })).status, 200);

    const second = await leave(eventId, entry.json.waitlistEntryId!, { userId });

    assert.equal(second.status, 409);
    assert.equal(second.json.error?.details?.reason, 'WAITLIST_ENTRY_NOT_WAITING');
  });
});

describe('failure injection rolls the whole join back', () => {
  it('leaves nothing behind when the entry insert fails', async () => {
    const { eventId } = await seedPublishedShow(1);
    const userId = await seedCustomer();

    await query(`ALTER TABLE waitlist_entries ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID`);
    let reply: Reply;
    try {
      reply = await join(eventId, { userId });
    } finally {
      await query(`ALTER TABLE waitlist_entries DROP CONSTRAINT tmp_force_failure`);
    }

    assert.equal(reply.status, 500);

    const count = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waitlist_entries WHERE event_id = $1 AND user_id = $2',
      [eventId, userId],
    );
    assert.equal(count.rows[0]!.count, '0');

    const keys = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM idempotency_keys WHERE user_id = $1',
      [userId],
    );
    assert.equal(keys.rows[0]!.count, '0', 'the claim rolled back too, so the key is reusable');

    // And a clean retry now succeeds.
    assert.equal((await join(eventId, { userId })).status, 201);
  });
});

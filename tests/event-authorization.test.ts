import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { accessTokenForUser } from './helpers/auth.js';
import { cleanupSeedData, seedCustomer, seedOrganiser, seedShow, seedVenue } from './helpers/seed.js';

let server: Server;
let baseUrl: string;

before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await cleanupSeedData();
  await closePool();
});

interface Reply {
  status: number;
  json: Record<string, unknown> & {
    event?: Record<string, unknown>;
    events?: Record<string, unknown>[];
    error?: { code: string; message: string; details?: { reason?: string } };
  };
}

async function request(
  method: string,
  path: string,
  options: { userId?: string | null | undefined; body?: unknown } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.userId != null) {
    headers.authorization = `Bearer ${await accessTokenForUser(options.userId)}`;
  }
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} };
}

const get = (path: string, userId?: string | null) => request('GET', path, { userId });
const patch = (path: string, userId: string, body: unknown) => request('PATCH', path, { userId, body });
const del = (path: string, userId: string) => request('DELETE', path, { userId });
const publish = (path: string, userId: string) => request('POST', path, { userId });

async function makeAdmin(userId: string): Promise<void> {
  await query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
}

describe('cross-organiser attacks on event ownership', () => {
  it('lets each organiser manage their own event and no one else\'s', async () => {
    const a = await seedShow(1);
    const b = await seedShow(1);

    assert.equal((await patch(`/events/${a.eventId}`, a.organiserId, { title: 'A2' })).status, 200);
    assert.equal((await patch(`/events/${b.eventId}`, b.organiserId, { title: 'B2' })).status, 200);

    // The critical IDOR check: A knows B's real UUID and tries it directly.
    const aOnB = await patch(`/events/${b.eventId}`, a.organiserId, { title: 'Hijacked' });
    assert.equal(aOnB.status, 404);
    assert.equal(aOnB.json.error?.details?.reason, 'EVENT_NOT_FOUND');

    const bOnA = await patch(`/events/${a.eventId}`, b.organiserId, { title: 'Hijacked' });
    assert.equal(bOnA.status, 404);

    // Neither attempt actually changed anything.
    const bRow = await query<{ title: string }>('SELECT title FROM events WHERE id = $1', [b.eventId]);
    assert.equal(bRow.rows[0]!.title, 'B2');
    const aRow = await query<{ title: string }>('SELECT title FROM events WHERE id = $1', [a.eventId]);
    assert.equal(aRow.rows[0]!.title, 'A2');
  });

  it('rejects A deleting, publishing or reading the private view of B\'s event', async () => {
    const a = await seedShow(1);
    const b = await seedShow(1);

    assert.equal((await del(`/events/${b.eventId}`, a.organiserId)).status, 404);
    assert.equal((await publish(`/events/${b.eventId}/publish`, a.organiserId)).status, 404);

    const privateView = await get(`/events/${b.eventId}`, a.organiserId);
    assert.equal(privateView.status, 404, 'A gets no private view of B\'s draft event');

    // B is untouched: still draft, still exists.
    const row = await query<{ status: string }>('SELECT status FROM events WHERE id = $1', [b.eventId]);
    assert.equal(row.rows[0]!.status, 'draft');
  });

  it('does not let a customer create, update, publish or delete any event', async () => {
    const a = await seedShow(1);
    const customer = await seedCustomer();
    const { venueId } = await seedVenue(1);

    const create = await request('POST', '/events', {
      userId: customer,
      body: {
        venueId,
        title: 'Customer Event',
        eventType: 'concert',
        startsAt: '2031-01-01T18:00:00.000Z',
        endsAt: '2031-01-01T20:00:00.000Z',
      },
    });
    assert.equal(create.status, 403);

    assert.equal((await patch(`/events/${a.eventId}`, customer, { title: 'x' })).status, 403);
    assert.equal((await del(`/events/${a.eventId}`, customer)).status, 403);
    assert.equal((await publish(`/events/${a.eventId}/publish`, customer)).status, 403);
  });

  it('lets an admin manage an event owned by someone else', async () => {
    const a = await seedShow(1);
    const admin = await seedCustomer();
    await makeAdmin(admin);

    assert.equal((await patch(`/events/${a.eventId}`, admin, { title: 'Admin Edited' })).status, 200);
    assert.equal((await publish(`/events/${a.eventId}/publish`, admin)).status, 200);

    const other = await seedShow(1);
    assert.equal((await del(`/events/${other.eventId}`, admin)).status, 204);
  });
});

describe('organiserId cannot be spoofed', () => {
  it('ignores/rejects organiserId in the create-event body; the row uses the authenticated user', async () => {
    const organiserId = await seedOrganiser();
    const victim = await seedOrganiser();
    const { venueId } = await seedVenue(1);

    const reply = await request('POST', '/events', {
      userId: organiserId,
      body: {
        organiserId: victim, // attempting to attribute the event to someone else
        venueId,
        title: 'Spoofed Organiser',
        eventType: 'concert',
        startsAt: '2031-01-01T18:00:00.000Z',
        endsAt: '2031-01-01T20:00:00.000Z',
      },
    });

    // `.strict()` on createEventSchema rejects the unknown field outright,
    // which is a stronger guarantee than silently dropping it.
    assert.equal(reply.status, 400);
  });
});

describe('GET /api/v1/organiser/events', () => {
  it('lists only the authenticated organiser\'s own events, database-scoped', async () => {
    const a = await seedShow(1);
    const b = await seedShow(1);

    const aList = await get('/organiser/events', a.organiserId);
    assert.equal(aList.status, 200);
    const aIds = aList.json.events!.map((e) => e.id);
    assert.ok(aIds.includes(a.eventId));
    assert.ok(!aIds.includes(b.eventId), 'A must not see B\'s event');

    const bList = await get('/organiser/events', b.organiserId);
    const bIds = bList.json.events!.map((e) => e.id);
    assert.ok(bIds.includes(b.eventId));
    assert.ok(!bIds.includes(a.eventId));
  });

  it('paginates database-side with a bounded page size', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(1);
    const { createEvent } = await import('../src/modules/events/event.service.js');
    for (let i = 0; i < 5; i += 1) {
      await createEvent({
        organiserId,
        venueId,
        title: `Paged Event ${i} ${randomUUID()}`,
        eventType: 'concert',
        startsAt: new Date('2031-01-01T18:00:00.000Z'),
        endsAt: new Date('2031-01-01T20:00:00.000Z'),
      });
    }

    const page1 = await get(`/organiser/events?page=1&limit=2`, organiserId);
    assert.equal(page1.status, 200);
    assert.equal(page1.json.events!.length, 2);
    assert.equal(page1.json.total, 5);
    assert.equal(page1.json.totalPages, 3);

    const page2 = await get(`/organiser/events?page=2&limit=2`, organiserId);
    const page1Ids = new Set(page1.json.events!.map((e) => e.id));
    const page2Ids = new Set(page2.json.events!.map((e) => e.id));
    assert.equal([...page1Ids].some((id) => page2Ids.has(id)), false, 'pages do not overlap');
  });

  it('rejects a page size above the maximum', async () => {
    const organiserId = await seedOrganiser();
    const reply = await get('/organiser/events?limit=1000', organiserId);
    assert.equal(reply.status, 400);
  });

  it('scopes an organiser to their own events even when they ask for all=true', async () => {
    const a = await seedShow(1);
    const b = await seedShow(1);

    const reply = await get('/organiser/events?all=true', a.organiserId);
    const ids = reply.json.events!.map((e) => e.id);

    assert.ok(ids.includes(a.eventId));
    assert.ok(!ids.includes(b.eventId), 'all=true is silently ignored for a non-admin');
  });

  it('lets an admin see every organiser\'s events with all=true, and only their own without it', async () => {
    const a = await seedShow(1);
    const b = await seedShow(1);
    const admin = await seedCustomer();
    await makeAdmin(admin);

    const scoped = await get('/organiser/events', admin);
    const scopedIds = scoped.json.events!.map((e) => e.id);
    assert.ok(!scopedIds.includes(a.eventId));
    assert.ok(!scopedIds.includes(b.eventId));

    const all = await get('/organiser/events?all=true', admin);
    const allIds = all.json.events!.map((e) => e.id);
    assert.ok(allIds.includes(a.eventId));
    assert.ok(allIds.includes(b.eventId));
  });

  it('requires authentication and the organiser/admin role', async () => {
    assert.equal((await get('/organiser/events', null)).status, 401);
    const customer = await seedCustomer();
    assert.equal((await get('/organiser/events', customer)).status, 403);
  });
});

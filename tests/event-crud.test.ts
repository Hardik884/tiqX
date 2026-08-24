import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import { accessTokenForUser } from './helpers/auth.js';
import { cleanupSeedData, seedCustomer, seedShow } from './helpers/seed.js';

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

async function forceStatus(eventId: string, status: string): Promise<void> {
  await query('UPDATE events SET status = $2 WHERE id = $1', [eventId, status]);
}

describe('GET /api/v1/events/:eventId - public vs private', () => {
  it('shows the public shape to an anonymous caller for a published event', async () => {
    const { eventId, organiserId } = await seedShow(2);
    await forceStatus(eventId, 'published');

    const reply = await get(`/events/${eventId}`);

    assert.equal(reply.status, 200);
    assert.equal(reply.json.status, 'published');
    assert.ok((reply.json.venue as { name?: string })?.name);
    assert.equal(typeof reply.json.availableSeats, 'number');
    // Private-only fields must not leak.
    assert.equal(reply.json.organiserId, undefined);
    assert.equal(reply.json.currency, undefined);
    assert.equal(reply.json.createdAt, undefined);
    void organiserId;
  });

  it('hides a draft event from an anonymous caller as if it did not exist', async () => {
    const { eventId } = await seedShow(2);

    const reply = await get(`/events/${eventId}`);

    assert.equal(reply.status, 404);
    assert.equal(reply.json.error?.details?.reason, 'EVENT_NOT_FOUND');
  });

  it('hides a draft event from a customer too', async () => {
    const { eventId } = await seedShow(2);
    const customer = await seedCustomer();

    const reply = await get(`/events/${eventId}`, customer);

    assert.equal(reply.status, 404);
  });

  it('shows the private shape to the owning organiser, even in draft', async () => {
    const { eventId, organiserId } = await seedShow(2);

    const reply = await get(`/events/${eventId}`, organiserId);

    assert.equal(reply.status, 200);
    assert.equal(reply.json.status, 'draft');
    assert.equal(reply.json.organiserId, organiserId);
    assert.ok(reply.json.currency);
  });

  it('shows the private shape to an admin, even in draft', async () => {
    const { eventId } = await seedShow(2);
    const admin = await seedCustomer();
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [admin]);

    const reply = await get(`/events/${eventId}`, admin);

    assert.equal(reply.status, 200);
    assert.equal(reply.json.status, 'draft');
  });

  it('answers a nonexistent event with 404', async () => {
    const reply = await get(`/events/${randomUUID()}`);
    assert.equal(reply.status, 404);
  });
});

describe('PATCH /api/v1/events/:eventId', () => {
  it('lets the owning organiser edit title, description and schedule while draft', async () => {
    const { eventId, organiserId } = await seedShow(2);

    const reply = await patch(`/events/${eventId}`, organiserId, {
      title: 'Renamed Show',
      description: 'Updated description',
      startsAt: '2031-01-01T18:00:00.000Z',
      endsAt: '2031-01-01T20:00:00.000Z',
    });

    assert.equal(reply.status, 200);
    assert.equal(reply.json.event?.title, 'Renamed Show');
    assert.equal(reply.json.event?.description, 'Updated description');
  });

  it('rejects venueId, eventType and status - they are not accepted fields at all', async () => {
    const { eventId, organiserId } = await seedShow(2);

    for (const body of [
      { venueId: randomUUID() },
      { eventType: 'movie' },
      { status: 'published' },
    ]) {
      const reply = await patch(`/events/${eventId}`, organiserId, body);
      assert.equal(reply.status, 400, JSON.stringify(body));
    }
  });

  it('rejects an empty patch body', async () => {
    const { eventId, organiserId } = await seedShow(2);
    const reply = await patch(`/events/${eventId}`, organiserId, {});
    assert.equal(reply.status, 400);
  });

  it('rejects endsAt before startsAt via the database constraint', async () => {
    const { eventId, organiserId } = await seedShow(2);

    const reply = await patch(`/events/${eventId}`, organiserId, {
      startsAt: '2031-01-01T20:00:00.000Z',
      endsAt: '2031-01-01T18:00:00.000Z',
    });

    assert.equal(reply.status, 400);
  });

  it('refuses to reschedule an event that already has a booking, but still allows metadata edits', async () => {
    const { eventId, organiserId, seats } = await seedShow(1);
    const customer = await seedCustomer();
    const showSeatIds = seats.map((seat) => seat.id);
    const hold = await createHold({ eventId, userId: customer, showSeatIds, ttlSeconds: 600 });
    const confirmReply = await fetch(
      `${baseUrl}/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await accessTokenForUser(customer)}`,
          'idempotency-key': randomUUID(),
        },
      },
    );
    assert.equal(confirmReply.status, 201, 'setup: booking must confirm');

    const reschedule = await patch(`/events/${eventId}`, organiserId, {
      startsAt: '2031-01-01T18:00:00.000Z',
      endsAt: '2031-01-01T20:00:00.000Z',
    });
    assert.equal(reschedule.status, 409);
    assert.equal(reschedule.json.error?.details?.reason, 'EVENT_HAS_BOOKINGS');

    const metadataEdit = await patch(`/events/${eventId}`, organiserId, { title: 'Still Editable' });
    assert.equal(metadataEdit.status, 200);
    assert.equal(metadataEdit.json.event?.title, 'Still Editable');
  });

  it('refuses to edit a completed event', async () => {
    const { eventId, organiserId } = await seedShow(2);
    await forceStatus(eventId, 'completed');

    const reply = await patch(`/events/${eventId}`, organiserId, { title: 'Too Late' });
    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'INVALID_EVENT_STATE');
  });

  it('refuses to edit a cancelled event', async () => {
    const { eventId, organiserId } = await seedShow(2);
    await forceStatus(eventId, 'cancelled');

    const reply = await patch(`/events/${eventId}`, organiserId, { title: 'Too Late' });
    assert.equal(reply.status, 409);
  });
});

describe('POST /api/v1/events/:eventId/publish', () => {
  it('publishes a draft event', async () => {
    const { eventId, organiserId } = await seedShow(2);

    const reply = await publish(`/events/${eventId}/publish`, organiserId);

    assert.equal(reply.status, 200);
    assert.equal(reply.json.event?.status, 'published');
  });

  it('rejects publishing an already-published event', async () => {
    const { eventId, organiserId } = await seedShow(2);
    await publish(`/events/${eventId}/publish`, organiserId);

    const reply = await publish(`/events/${eventId}/publish`, organiserId);

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'EVENT_ALREADY_PUBLISHED');
  });

  it('rejects publishing a completed or cancelled event', async () => {
    const { eventId, organiserId } = await seedShow(2);
    await forceStatus(eventId, 'completed');

    const reply = await publish(`/events/${eventId}/publish`, organiserId);
    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'INVALID_EVENT_STATE');
  });

  it('refuses to publish an event with zero seat inventory', async () => {
    const { eventId, organiserId } = await seedShow(2);
    await query('DELETE FROM show_seats WHERE event_id = $1', [eventId]);

    const reply = await publish(`/events/${eventId}/publish`, organiserId);

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'EVENT_HAS_NO_SEATS');
  });
});

describe('DELETE /api/v1/events/:eventId', () => {
  it('deletes a pristine draft with no history', async () => {
    const { eventId, organiserId } = await seedShow(2);

    const reply = await del(`/events/${eventId}`, organiserId);
    assert.equal(reply.status, 204);

    const row = await query('SELECT id FROM events WHERE id = $1', [eventId]);
    assert.equal(row.rowCount, 0);
    const seats = await query('SELECT id FROM show_seats WHERE event_id = $1', [eventId]);
    assert.equal(seats.rowCount, 0, 'inventory cascades away with the event');
  });

  it('refuses to delete an event that has a booking', async () => {
    const { eventId, organiserId, seats } = await seedShow(1);
    const customer = await seedCustomer();
    const hold = await createHold({
      eventId,
      userId: customer,
      showSeatIds: seats.map((s) => s.id),
      ttlSeconds: 600,
    });
    await fetch(`${baseUrl}/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await accessTokenForUser(customer)}`,
        'idempotency-key': randomUUID(),
      },
    });

    const reply = await del(`/events/${eventId}`, organiserId);

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'EVENT_HAS_BOOKINGS');

    const row = await query('SELECT id FROM events WHERE id = $1', [eventId]);
    assert.equal(row.rowCount, 1, 'the event survives');
  });

  it('refuses to delete an event that only has a hold, never converted', async () => {
    const { eventId, organiserId, seats } = await seedShow(1);
    const customer = await seedCustomer();
    await createHold({
      eventId,
      userId: customer,
      showSeatIds: seats.map((s) => s.id),
      ttlSeconds: 600,
    });

    const reply = await del(`/events/${eventId}`, organiserId);

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'EVENT_HAS_BOOKINGS');
  });

  it('refuses to delete a published event, even with zero bookings', async () => {
    const { eventId, organiserId } = await seedShow(2);
    const publishReply = await publish(`/events/${eventId}/publish`, organiserId);
    assert.equal(publishReply.status, 200, 'setup: must publish');

    const reply = await del(`/events/${eventId}`, organiserId);

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'INVALID_EVENT_STATE');

    const row = await query('SELECT id FROM events WHERE id = $1', [eventId]);
    assert.equal(row.rowCount, 1);
  });

  it('answers a nonexistent event with 404', async () => {
    const organiserId = await seedCustomer();
    await query("UPDATE users SET role = 'organiser' WHERE id = $1", [organiserId]);
    const reply = await del(`/events/${randomUUID()}`, organiserId);
    assert.equal(reply.status, 404);
  });
});

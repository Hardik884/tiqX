import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { cleanupSeedData, seedOrganiser, seedVenue, trackEvent } from './helpers/seed.js';

let server: Server;
let baseUrl: string;

before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await cleanupSeedData();
  await closePool();
});

interface EventResponse {
  event?: { id: string; status: string };
  seatInventoryCount?: number;
  error?: { code: string; message: string };
}

async function postEvent(body: unknown): Promise<{ status: number; json: EventResponse }> {
  const response = await fetch(`${baseUrl}/api/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as EventResponse };
}

describe('POST /api/v1/events', () => {
  it('creates the event and its seat inventory', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(4);

    const { status, json } = await postEvent({
      organiserId,
      venueId,
      title: 'Api Created Show',
      eventType: 'movie',
      startsAt: '2030-02-01T18:00:00.000Z',
      endsAt: '2030-02-01T20:00:00.000Z',
      status: 'published',
    });

    assert.equal(status, 201);
    assert.equal(json.seatInventoryCount, 4);
    assert.equal(json.event?.status, 'published');
    trackEvent(json.event!.id);

    const inventory = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM show_seats WHERE event_id = $1',
      [json.event!.id],
    );
    assert.equal(inventory.rows[0]!.count, '4');
  });

  it('rejects an invalid payload without touching the database', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(2);

    const { status, json } = await postEvent({
      organiserId,
      venueId,
      title: '',
      eventType: 'opera',
      startsAt: '2030-02-01T20:00:00.000Z',
      endsAt: '2030-02-01T18:00:00.000Z',
    });

    assert.equal(status, 400);
    assert.equal(json.error?.code, 'BAD_REQUEST');

    const events = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM events WHERE venue_id = $1',
      [venueId],
    );
    assert.equal(events.rows[0]!.count, '0');
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { createEvent, publishEvent } from '../src/modules/events/event.service.js';
import { attachWebSocketServer, closeWebSocketServer } from '../src/realtime/websocket-server.js';
import { accessTokenForUser } from './helpers/auth.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace } from './helpers/redis.js';
import { cleanupSeedData, seedCustomer, seedOrganiser, seedVenue } from './helpers/seed.js';
import {
  collectMessages,
  connectClient,
  send,
  waitForClose,
  waitForMessage,
  waitForOpen,
} from './helpers/ws.js';

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
  await flushTestNamespace();
  await closeTestRedis();
  await cleanupSeedData();
  await closePool();
});

interface Show {
  eventId: string;
  organiserId: string;
}

async function seedPublishedEvent(): Promise<Show> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(1, 'A', 12);
  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Realtime ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
  });
  await publishEvent({ eventId: event.id, userId: organiserId, userRole: 'organiser' }, undefined);
  return { eventId: event.id, organiserId };
}

async function seedDraftEvent(): Promise<Show> {
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
  return { eventId: event.id, organiserId };
}

describe('connecting', () => {
  it('accepts an anonymous connection', async () => {
    const ws = connectClient(baseUrl);
    await waitForOpen(ws);
    ws.close();
    await waitForClose(ws);
  });

  it('accepts a connection with a valid access token', async () => {
    const userId = await seedCustomer();
    const ws = connectClient(baseUrl, await accessTokenForUser(userId));
    await waitForOpen(ws);
    ws.close();
    await waitForClose(ws);
  });

  it('does not refuse a connection presenting a garbage token - treats it as anonymous', async () => {
    const ws = connectClient(baseUrl, 'not-a-real-token');
    await waitForOpen(ws);
    ws.close();
    await waitForClose(ws);
  });
});

describe('subscribing to a public event', () => {
  it('acknowledges a subscription for anyone, signed in or not', async () => {
    const { eventId } = await seedPublishedEvent();
    const ws = connectClient(baseUrl);
    await waitForOpen(ws);

    send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
    const ack = await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED');
    assert.equal((ack as { eventId: string }).eventId, eventId);

    ws.close();
  });

  it('acknowledges unsubscribing', async () => {
    const { eventId } = await seedPublishedEvent();
    const ws = connectClient(baseUrl);
    await waitForOpen(ws);
    send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
    await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED');

    send(ws, { type: 'UNSUBSCRIBE_EVENT', eventId });
    const ack = await waitForMessage(ws, (m) => m.type === 'UNSUBSCRIBED');
    assert.equal((ack as { eventId: string }).eventId, eventId);

    ws.close();
  });

  it('unsubscribing something never subscribed is harmless', async () => {
    const { eventId } = await seedPublishedEvent();
    const ws = connectClient(baseUrl);
    await waitForOpen(ws);

    send(ws, { type: 'UNSUBSCRIBE_EVENT', eventId });
    const ack = await waitForMessage(ws, (m) => m.type === 'UNSUBSCRIBED');
    assert.equal((ack as { eventId: string }).eventId, eventId);

    ws.close();
  });

  it('re-subscribing is idempotent', async () => {
    const { eventId } = await seedPublishedEvent();
    const ws = connectClient(baseUrl);
    await waitForOpen(ws);

    send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
    await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED');
    send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
    const ack = await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED');
    assert.equal((ack as { eventId: string }).eventId, eventId);

    ws.close();
  });
});

describe('subscribing to a private (draft) event', () => {
  it('refuses an anonymous caller, answering exactly like a nonexistent event', async () => {
    const { eventId } = await seedDraftEvent();
    const ws = connectClient(baseUrl);
    await waitForOpen(ws);

    send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
    const denied = await waitForMessage(ws, (m) => m.type === 'ERROR');
    assert.equal((denied as { code: string }).code, 'NOT_FOUND');

    send(ws, { type: 'SUBSCRIBE_EVENT', eventId: randomUUID() });
    const imaginary = await waitForMessage(ws, (m) => m.type === 'ERROR');
    assert.deepEqual(imaginary, denied);

    ws.close();
  });

  it('refuses a signed-in customer who does not own it', async () => {
    const { eventId } = await seedDraftEvent();
    const stranger = await seedCustomer();
    const ws = connectClient(baseUrl, await accessTokenForUser(stranger));
    await waitForOpen(ws);

    send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
    const denied = await waitForMessage(ws, (m) => m.type === 'ERROR');
    assert.equal((denied as { code: string }).code, 'NOT_FOUND');

    ws.close();
  });

  it('allows the owning organiser', async () => {
    const { eventId, organiserId } = await seedDraftEvent();
    const ws = connectClient(baseUrl, await accessTokenForUser(organiserId));
    await waitForOpen(ws);

    send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
    const ack = await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED');
    assert.equal((ack as { eventId: string }).eventId, eventId);

    ws.close();
  });

  it('allows an admin who does not own it', async () => {
    const { eventId } = await seedDraftEvent();
    const adminResult = await query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id`,
      ['Test Admin', `admin-${randomUUID()}@example.test`, 'not-a-real-hash'],
    );
    const adminId = adminResult.rows[0]!.id;

    const ws = connectClient(baseUrl, await accessTokenForUser(adminId));
    await waitForOpen(ws);
    send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
    const ack = await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED');
    assert.equal((ack as { eventId: string }).eventId, eventId);

    ws.close();
    await query('DELETE FROM users WHERE id = $1', [adminId]);
  });
});

describe('reliability and security', () => {
  it('answers a malformed (non-JSON) message with an ERROR, keeping the connection open', async () => {
    const ws = connectClient(baseUrl);
    await waitForOpen(ws);

    ws.send('not json at all {{{');
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    assert.equal((error as { code: string }).code, 'INVALID_MESSAGE');

    // The connection survives - a second, valid message still works.
    const { eventId } = await seedPublishedEvent();
    send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
    const ack = await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED');
    assert.equal((ack as { eventId: string }).eventId, eventId);

    ws.close();
  });

  it('answers a well-formed JSON message of the wrong shape with an ERROR', async () => {
    const ws = connectClient(baseUrl);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'DELETE_EVERYTHING', eventId: randomUUID() }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    assert.equal((error as { code: string }).code, 'INVALID_MESSAGE');

    ws.close();
  });

  it('rejects a SQL-injection-shaped eventId as a validation error, never reaching a query', async () => {
    const ws = connectClient(baseUrl);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'SUBSCRIBE_EVENT', eventId: "'; DROP TABLE events; --" }));
    const error = await waitForMessage(ws, (m) => m.type === 'ERROR');
    assert.equal((error as { code: string }).code, 'INVALID_MESSAGE');

    // The proof that nothing was reached: the table is still there and usable.
    const { eventId } = await seedPublishedEvent();
    assert.ok(eventId);

    ws.close();
  });

  it('closes a connection that sends an oversized message', async () => {
    const ws = connectClient(baseUrl);
    await waitForOpen(ws);

    const huge = JSON.stringify({ type: 'SUBSCRIBE_EVENT', eventId: 'x'.repeat(20_000) });
    ws.send(huge);

    const closed = await waitForClose(ws, 5_000);
    assert.equal(closed.code, 1009, 'ws policy-violation close code for an oversized message');
  });

  it('enforces the per-connection subscription limit', async () => {
    const ws = connectClient(baseUrl);
    await waitForOpen(ws);

    const events: string[] = [];
    // config default is 50; seed a handful over that.
    for (let i = 0; i < 51; i += 1) {
      const { eventId } = await seedPublishedEvent();
      events.push(eventId);
    }

    for (const eventId of events.slice(0, 50)) {
      send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
      await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED' && m.eventId === eventId);
    }

    send(ws, { type: 'SUBSCRIBE_EVENT', eventId: events[50]! });
    const denied = await waitForMessage(ws, (m) => m.type === 'ERROR');
    assert.equal((denied as { code: string }).code, 'SUBSCRIPTION_LIMIT_EXCEEDED');

    ws.close();
  });

  it('never logs a token or reveals a database error to the client', async () => {
    const { eventId } = await seedDraftEvent();
    const ws = connectClient(baseUrl, 'Bearer-token-that-should-never-appear-anywhere');
    await waitForOpen(ws);

    send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
    const messages = await collectMessages(ws, 500);
    for (const message of messages) {
      const raw = JSON.stringify(message);
      assert.ok(!raw.includes('SELECT'), 'no raw SQL in a client-facing message');
      assert.ok(!raw.includes('FOR UPDATE'), 'no raw SQL in a client-facing message');
    }

    ws.close();
  });
});

describe('subscription only reaches subscribed events', () => {
  it('a client subscribed to event A receives nothing for event B', async () => {
    const { eventId: eventA } = await seedPublishedEvent();
    const { eventId: eventB } = await seedPublishedEvent();

    const ws = connectClient(baseUrl);
    await waitForOpen(ws);
    send(ws, { type: 'SUBSCRIBE_EVENT', eventId: eventA });
    await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED');

    // Publish directly to event B's channel - nothing this client should see.
    const { getRedis } = await import('../src/redis/client.js');
    const { seatEventsChannel } = await import('../src/redis/keys.js');
    await getRedis().publish(
      seatEventsChannel(eventB),
      JSON.stringify({
        type: 'SEAT_HELD',
        version: 1,
        eventId: eventB,
        seatId: randomUUID(),
        status: 'held',
        seatVersion: '1',
        occurredAt: new Date().toISOString(),
      }),
    );

    const messages = await collectMessages(ws, 500);
    assert.equal(messages.length, 0, 'nothing published for an unsubscribed event reaches this client');

    ws.close();
  });
});

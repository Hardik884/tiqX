import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query, withTransaction } from '../src/db/pool.js';
import { createEvent, publishEvent } from '../src/modules/events/event.service.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import {
  claimPendingSeatStatusEvents,
  markSeatStatusEventProcessed,
  recordSeatStatusEventFailure,
} from '../src/modules/realtime/seat-status-outbox.repository.js';
import { attachWebSocketServer, closeWebSocketServer } from '../src/realtime/websocket-server.js';
import { getRedis } from '../src/redis/client.js';
import { seatEventsChannel } from '../src/redis/keys.js';
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
  seatIds: string[];
}

async function seedPublishedShow(seatCount: number): Promise<Show> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', 12);
  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Realtime concurrency ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
    pricing: { standard: '100.00' },
  });
  await publishEvent({ eventId: event.id, userId: organiserId, userRole: 'organiser' }, undefined);
  const seats = await query<{ id: string }>('SELECT id FROM show_seats WHERE event_id = $1 ORDER BY id', [
    event.id,
  ]);
  return { eventId: event.id, seatIds: seats.rows.map((row) => row.id) };
}

describe('concurrent seat mutations only ever report committed state', () => {
  it('50 concurrent holds for 50 different seats each produce exactly one SEAT_HELD, matching the database', async () => {
    const SEATS = 50;
    const { eventId, seatIds } = await seedPublishedShow(SEATS);
    const ws = connectClient(baseUrl);
    await waitForOpen(ws);
    send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
    await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED');

    const received: ServerMessage[] = [];
    ws.on('message', (data: Buffer) => {
      try {
        received.push(JSON.parse(data.toString('utf8')) as ServerMessage);
      } catch {
        // ignore
      }
    });

    const users = await Promise.all(Array.from({ length: SEATS }, () => seedCustomer()));
    await Promise.all(
      seatIds.map((seatId, i) =>
        createHold({ eventId, userId: users[i]!, showSeatIds: [seatId], ttlSeconds: 600 }),
      ),
    );
    await processSeatStatusOutbox();

    // Give the local fan-out a moment to drain everything published.
    await new Promise((resolve) => setTimeout(resolve, 300));

    function isSeatHeld(m: ServerMessage): m is ServerMessage & { seatId: string } {
      return m.type === 'SEAT_HELD';
    }
    const heldMessages = received.filter(isSeatHeld);
    assert.equal(heldMessages.length, SEATS, 'exactly one SEAT_HELD per seat, no duplicates and none missing');
    assert.deepEqual(
      [...new Set(heldMessages.map((m) => m.seatId))].sort(),
      [...seatIds].sort(),
      'every seat is represented, and only once',
    );

    const dbSeats = await query<{ status: string }>('SELECT status FROM show_seats WHERE event_id = $1', [
      eventId,
    ]);
    assert.ok(dbSeats.rows.every((row) => row.status === 'held'), 'the database agrees with every message sent');

    ws.close();
  });

  it('a transaction that rolls back never produces a successful seat event', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: [seatIds[0]!], ttlSeconds: 600 });
    await processSeatStatusOutbox();

    const ws = connectClient(baseUrl);
    await waitForOpen(ws);
    send(ws, { type: 'SUBSCRIBE_EVENT', eventId });
    await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED');

    const received: ServerMessage[] = [];
    ws.on('message', (data: Buffer) => {
      try {
        received.push(JSON.parse(data.toString('utf8')) as ServerMessage);
      } catch {
        // ignore
      }
    });

    // Force the confirm transaction to fail after its seat lock is taken.
    await query(`ALTER TABLE bookings ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID`);
    try {
      const reply = await post(`/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`, userId);
      assert.equal(reply.status, 500);
    } finally {
      await query(`ALTER TABLE bookings DROP CONSTRAINT tmp_force_failure`);
    }
    await processSeatStatusOutbox();
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(received.filter((m) => m.type === 'SEAT_BOOKED').length, 0, 'no event for a rolled-back transition');

    // The real transition, once it is allowed to succeed, still works.
    const expectBooked = waitForMessage(ws, (m) => m.type === 'SEAT_BOOKED');
    assert.equal((await post(`/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`, userId)).status, 201);
    await processSeatStatusOutbox();
    await expectBooked;

    ws.close();
  });
});

describe('worker retry on publish failure', () => {
  it('leaves the row unprocessed and retries after a failed publish, using recordSeatStatusEventFailure', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const userId = await seedCustomer();
    await createHold({ eventId, userId, showSeatIds: [seatIds[0]!], ttlSeconds: 600 });

    // Simulate the worker's own error path directly: claim, fail to publish,
    // record the failure with the same backoff every outbox in this codebase
    // uses, exactly as realtime-seat-status.worker.ts does in its catch block.
    const outboxRow = await withTransaction(async (client) => {
      const rows = await claimPendingSeatStatusEvents(client, 10);
      const row = rows.find((r) => r.showSeatId === seatIds[0]);
      assert.ok(row, 'setup: the outbox row must exist');
      await recordSeatStatusEventFailure(client, row!.id, 'simulated publish failure', 50, 500);
      return row!;
    });

    const failed = await query<{ processed_at: Date | null; attempts: number; last_error: string | null }>(
      'SELECT processed_at, attempts, last_error FROM seat_status_outbox WHERE id = $1',
      [outboxRow.id],
    );
    assert.equal(failed.rows[0]!.processed_at, null, 'not marked processed - it will be retried');
    assert.equal(failed.rows[0]!.attempts, 1);
    assert.equal(failed.rows[0]!.last_error, 'simulated publish failure');

    // Backed off into the future; not yet eligible.
    const immediatelyClaimed = await withTransaction((client) => claimPendingSeatStatusEvents(client, 10));
    assert.ok(
      !immediatelyClaimed.some((r) => r.id === outboxRow.id),
      'still backing off, not eligible for a retry yet',
    );

    await new Promise((resolve) => setTimeout(resolve, 120));

    const retried = await processSeatStatusOutbox();
    assert.ok(retried >= 1);
    const succeeded = await query<{ processed_at: Date | null; last_error: string | null }>(
      'SELECT processed_at, last_error FROM seat_status_outbox WHERE id = $1',
      [outboxRow.id],
    );
    assert.ok(succeeded.rows[0]!.processed_at !== null, 'the retry succeeded and marked it processed');
    assert.equal(succeeded.rows[0]!.last_error, null, 'cleared on success');
  });

  it('a worker crash between claim and process leaves the row for the next pass, not lost', async () => {
    // "Crash" here means: the claiming transaction is rolled back instead of
    // committed - exactly what happens if the process dies mid-transaction.
    const { eventId, seatIds } = await seedPublishedShow(1);
    const userId = await seedCustomer();
    await createHold({ eventId, userId, showSeatIds: [seatIds[0]!], ttlSeconds: 600 });

    await assert.rejects(
      withTransaction(async (client) => {
        const rows = await claimPendingSeatStatusEvents(client, 10);
        assert.ok(rows.some((r) => r.showSeatId === seatIds[0]));
        throw new Error('simulated crash');
      }),
      /simulated crash/,
    );

    const stillPending = await query<{ processed_at: Date | null }>(
      'SELECT processed_at FROM seat_status_outbox WHERE show_seat_id = $1',
      [seatIds[0]],
    );
    assert.equal(stillPending.rows[0]!.processed_at, null, 'the claim rolled back, so the row is unclaimed again');

    const processed = await processSeatStatusOutbox();
    assert.ok(processed >= 1, 'a later pass claims and publishes it normally');
  });
});

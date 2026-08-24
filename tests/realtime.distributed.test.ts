import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { closePool, query } from '../src/db/pool.js';
import { createEvent, publishEvent } from '../src/modules/events/event.service.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import { accessTokenForUser } from './helpers/auth.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace } from './helpers/redis.js';
import { cleanupSeedData, seedCustomer, seedOrganiser, seedVenue } from './helpers/seed.js';
import { connectClient, send, waitForMessage, waitForOpen } from './helpers/ws.js';

/**
 * Real processes: two API instances and the real-time worker, three separate
 * `node` processes sharing one PostgreSQL and one Redis. Everything else in
 * this feature's test suite calls `attachWebSocketServer` and the worker's
 * publish loop in-process, which proves the logic but not the architecture -
 * see rate-limit.distributed.test.ts for the same reasoning applied to the
 * rate limiter.
 *
 * The test below deliberately subscribes on one instance and triggers the
 * seat change through a *different* instance. If that works, the full
 * pipeline this feature actually depends on is real: instance B's HTTP
 * handler commits a `show_seats` UPDATE, the trigger writes an outbox row in
 * the same transaction, a separately-spawned worker process claims and
 * publishes it to Redis, and instance A - which never saw the HTTP request at
 * all - receives it over Redis and forwards it to a client instance A does
 * not otherwise know anything about.
 */
interface Instance {
  child: ChildProcess;
  baseUrl: string;
  output: string[];
}

const instances: Instance[] = [];
let worker: ChildProcess | undefined;
const workerOutput: string[] = [];

async function startInstance(port: number): Promise<Instance> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  const instance: Instance = { child, baseUrl: `http://127.0.0.1:${port}`, output };
  instances.push(instance);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`instance on ${port} did not start in time:\n${output.join('')}`)),
      30_000,
    );
    const onData = (chunk: Buffer): void => {
      if (chunk.toString().includes('Real-time WebSocket server attached')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`instance on ${port} exited with code ${code}:\n${output.join('')}`));
    });
  });

  return instance;
}

async function startWorker(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/workers/realtime-seat-status.worker.ts'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => workerOutput.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => workerOutput.push(chunk.toString()));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`worker did not start in time:\n${workerOutput.join('')}`)),
      30_000,
    );
    const onData = (chunk: Buffer): void => {
      if (chunk.toString().includes('Realtime seat status worker started')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited with code ${code}:\n${workerOutput.join('')}`));
    });
  });

  return child;
}

function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000).unref();
  });
}

let serverA: Instance;
let serverB: Instance;

before(async () => {
  await connectTestRedis();
  await flushTestNamespace();
  // Sequential boot: concurrent tsx compilation is slow enough on a loaded
  // machine to trip the readiness timeout - the same reasoning
  // rate-limit.distributed.test.ts gives for its own two instances.
  serverA = await startInstance(4811);
  serverB = await startInstance(4812);
  worker = await startWorker();
});

after(async () => {
  await Promise.all([...instances.map((i) => killProcess(i.child)), worker ? killProcess(worker) : Promise.resolve()]);
  instances.length = 0;
  await flushTestNamespace();
  await closeTestRedis();
  await cleanupSeedData();
  await closePool();
});

async function post(instance: Instance, path: string, userId: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${instance.baseUrl}${path}`, {
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

describe('real-time seat status across separate processes', () => {
  it('a client on instance A sees a seat change made through instance B, published by the real worker', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(1, 'A', 12);
    const { event } = await createEvent({
      organiserId,
      venueId,
      title: `Distributed realtime ${randomUUID()}`,
      eventType: 'concert',
      startsAt: new Date('2030-01-01T18:00:00.000Z'),
      endsAt: new Date('2030-01-01T20:00:00.000Z'),
    });
    await publishEvent({ eventId: event.id, userId: organiserId, userRole: 'organiser' }, undefined);
    const seats = await query<{ id: string }>('SELECT id FROM show_seats WHERE event_id = $1', [event.id]);
    const seatId = seats.rows[0]!.id;
    const userId = await seedCustomer();

    const ws = connectClient(serverA.baseUrl);
    await waitForOpen(ws);
    send(ws, { type: 'SUBSCRIBE_EVENT', eventId: event.id });
    await waitForMessage(ws, (m) => m.type === 'SUBSCRIBED');

    const expectHeld = waitForMessage(ws, (m) => m.type === 'SEAT_HELD', 15_000);
    const hold = await createHold({ eventId: event.id, userId, showSeatIds: [seatId], ttlSeconds: 600 });
    const message = await expectHeld;

    assert.equal((message as { seatId: string }).seatId, seatId);
    assert.equal((message as { status: string }).status, 'held');
    assert.ok(hold.holdId);

    const expectBooked = waitForMessage(ws, (m) => m.type === 'SEAT_BOOKED', 15_000);
    // Confirmed through instance B - a process serverA's WebSocket layer
    // never received an HTTP request from at all.
    const confirm = await post(serverB, `/api/v1/events/${event.id}/holds/${hold.holdId}/confirm`, userId);
    assert.equal(confirm.status, 201);
    const booked = await expectBooked;
    assert.equal((booked as { status: string }).status, 'booked');

    ws.close();
  });
});

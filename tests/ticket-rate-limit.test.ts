import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { closePool, query } from '../src/db/pool.js';
import { identifierDigest } from '../src/redis/keys.js';
import { accessTokenForUser } from './helpers/auth.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace, scanNamespace } from './helpers/redis.js';
import { cleanupSeedData, seedCustomer } from './helpers/seed.js';

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

interface Reply {
  status: number;
  json: { error?: { code: string; message: string } };
  headers: Headers;
}

async function verify(ticketId: string, authorization: string): Promise<Reply> {
  const response = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {}, headers: response.headers };
}

describe('ticket verification rate limit', () => {
  it('allows up to the policy limit, keyed per authenticated user, then refuses with 429', async () => {
    const organiserId = await seedCustomer();
    await query("UPDATE users SET role = 'organiser' WHERE id = $1", [organiserId]);
    const authorization = `Bearer ${await accessTokenForUser(organiserId)}`;
    const limit = config.rateLimit.ticketVerify.max;

    // A nonexistent ticket every time: the limiter runs before the handler,
    // so what is being counted is attempts, not successful scans - the same
    // property the login limiter test relies on.
    for (let attempt = 1; attempt <= limit; attempt += 1) {
      const reply = await verify(randomUUID(), authorization);
      assert.equal(reply.status, 404, `attempt ${attempt} should reach the handler`);
      assert.equal(reply.headers.get('ratelimit-remaining'), String(limit - attempt));
    }

    const refused = await verify(randomUUID(), authorization);
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error?.code, 'RATE_LIMITED');
  });

  it('gives two organisers independent budgets', async () => {
    const organiserA = await seedCustomer();
    const organiserB = await seedCustomer();
    await query("UPDATE users SET role = 'organiser' WHERE id = ANY($1::uuid[])", [
      [organiserA, organiserB],
    ]);
    const authA = `Bearer ${await accessTokenForUser(organiserA)}`;
    const authB = `Bearer ${await accessTokenForUser(organiserB)}`;
    const limit = config.rateLimit.ticketVerify.max;

    for (let attempt = 1; attempt <= limit; attempt += 1) {
      const reply = await verify(randomUUID(), authA);
      assert.equal(reply.status, 404);
    }
    assert.equal((await verify(randomUUID(), authA)).status, 429, 'A is exhausted');

    // B has spent nothing and is unaffected by A's usage.
    assert.equal((await verify(randomUUID(), authB)).status, 404);
  });

  it('writes a Redis key digested from the user id, not the raw id', async () => {
    const organiserId = await seedCustomer();
    await query("UPDATE users SET role = 'organiser' WHERE id = $1", [organiserId]);
    const authorization = `Bearer ${await accessTokenForUser(organiserId)}`;

    await verify(randomUUID(), authorization);

    const keys = await scanNamespace(`rate-limit:${config.rateLimit.ticketVerify.name}:*`);
    const mine = keys.filter((key) => key.endsWith(identifierDigest(organiserId)));
    assert.equal(mine.length, 1, 'exactly one key for this user, digested');
    assert.ok(!keys.some((key) => key.includes(organiserId)), 'the raw user id is never written to Redis');
  });
});

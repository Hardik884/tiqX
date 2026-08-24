import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { closePool } from '../src/db/pool.js';
import { getRedis } from '../src/redis/client.js';
import { identifierDigest } from '../src/redis/keys.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace, scanNamespace, uniqueClientIp } from './helpers/redis.js';
import { cleanupSeedData } from './helpers/seed.js';

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

async function list(ip: string): Promise<Reply> {
  const response = await fetch(`${baseUrl}/api/v1/events`, { headers: { 'x-forwarded-for': ip } });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {}, headers: response.headers };
}

describe('search rate limit', () => {
  it('allows up to the policy limit per IP, then refuses with 429', async () => {
    const ip = uniqueClientIp();
    const limit = config.rateLimit.search.max;

    for (let attempt = 1; attempt <= limit; attempt += 1) {
      const reply = await list(ip);
      assert.equal(reply.status, 200, `attempt ${attempt}`);
      assert.equal(reply.headers.get('ratelimit-remaining'), String(limit - attempt));
    }

    const refused = await list(ip);
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error?.code, 'RATE_LIMITED');
  });

  it('gives two anonymous callers independent budgets, keyed on ip', async () => {
    const ipA = uniqueClientIp();
    const ipB = uniqueClientIp();
    const limit = config.rateLimit.search.max;

    for (let attempt = 1; attempt <= limit; attempt += 1) {
      assert.equal((await list(ipA)).status, 200);
    }
    assert.equal((await list(ipA)).status, 429);
    assert.equal((await list(ipB)).status, 200, 'B has spent nothing');
  });

  it('writes a Redis key digested from the ip, never the raw ip', async () => {
    const ip = uniqueClientIp();
    await list(ip);

    const keys = await scanNamespace(`rate-limit:${config.rateLimit.search.name}:*`);
    const mine = keys.filter((key) => key.endsWith(identifierDigest(ip)));
    assert.equal(mine.length, 1);
    assert.ok(!keys.some((key) => key.includes(ip)));
  });

  it('fails closed (503) when Redis is unavailable - search never depends on Redis for its results, only for admission', async () => {
    const redis = getRedis();
    const ip = uniqueClientIp();

    // Simulate an outage without tearing down the shared client other test
    // files still use: force the next command to fail.
    const originalEval = redis.eval.bind(redis);
    (redis as unknown as { eval: typeof redis.eval }).eval = (() =>
      Promise.reject(new Error('simulated redis outage'))) as typeof redis.eval;

    try {
      const reply = await list(ip);
      assert.equal(reply.status, 503, 'fails closed, matching the project-wide policy for rate-limited endpoints');
      assert.equal(reply.json.error?.code, 'DEPENDENCY_UNAVAILABLE');
      const text = JSON.stringify(reply.json);
      assert.ok(!text.toLowerCase().includes('redis://'), 'no connection string leaked');
    } finally {
      (redis as unknown as { eval: typeof redis.eval }).eval = originalEval;
    }
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { closePool, query } from '../src/db/pool.js';
import { getRedis } from '../src/redis/client.js';
import {
  closeTestRedis,
  connectTestRedis,
  flushTestNamespace,
  uniqueClientIp,
} from './helpers/redis.js';

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
  await query("DELETE FROM users WHERE email LIKE '%@failtest.test'");
  await flushTestNamespace();
  await closeTestRedis();
  await closePool();
});

interface Reply {
  status: number;
  json: { status?: string; dependencies?: Record<string, string>; error?: { code: string; message: string; details?: unknown } };
  raw: string;
}

async function call(path: string, init?: RequestInit): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {}, raw };
}

async function post(path: string, body: unknown, ip: string): Promise<Reply> {
  return call(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

/**
 * Simulates an outage on the real client rather than swapping in a broken
 * stub. `disconnect()` drops the socket and, because the client is built with
 * `enableOfflineQueue: false`, subsequent commands reject immediately instead
 * of buffering - which is exactly what a production outage looks like to the
 * limiter.
 */
async function withRedisDown<T>(fn: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  redis.disconnect();

  try {
    return await fn();
  } finally {
    await restoreRedis();
  }
}

/**
 * Brings the shared client back into service.
 *
 * `disconnect()` is a deliberate stop: unlike a dropped socket, it also tells
 * ioredis not to reconnect. So this re-dials, retrying because a connect that
 * races with the client's own state transitions throws rather than queues.
 *
 * It waits for a PING to actually succeed rather than for `status` to read
 * `ready` - the flag flips a moment before the socket is usable, and a test
 * that continued on the flag alone would see a spurious 503 from the next
 * request and blame the application for it.
 *
 * Note this simulation is harsher than a real outage: production loses the
 * socket without disabling reconnection, so ioredis retries with backoff on its
 * own. What the tests below establish is the behaviour while Redis is
 * unreachable, and that service resumes once it is reachable again.
 */
async function restoreRedis(): Promise<void> {
  const redis = getRedis();
  let lastError: unknown;

  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (redis.status === 'end' || redis.status === 'close') {
      try {
        await redis.connect();
      } catch (error) {
        lastError = error;
      }
    }

    if (redis.status === 'ready') {
      try {
        if ((await redis.ping()) === 'PONG') {
          return;
        }
      } catch (error) {
        lastError = error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.fail(
    `Redis did not become usable again (status=${redis.status}, lastError=${String(lastError)})`,
  );
}

describe('behaviour when Redis is unavailable', () => {
  it('fails closed on the rate-limited endpoints', async () => {
    const ip = uniqueClientIp();
    const email = `down-${randomUUID()}@failtest.test`;

    const replies = await withRedisDown(async () => ({
      login: await post('/auth/login', { email, password: 'a-sufficiently-long-password' }, ip),
      register: await post('/auth/register', { email, password: 'a-sufficiently-long-password' }, ip),
      refresh: await post('/auth/refresh', { refreshToken: randomUUID() }, ip),
    }));

    for (const [name, reply] of Object.entries(replies)) {
      // 503, not 429: the caller exceeded nothing. And not 200 - refusing to
      // run unprotected is the whole point of the policy.
      assert.equal(reply.status, 503, `${name} should fail closed`);
      assert.equal(reply.json.error?.code, 'DEPENDENCY_UNAVAILABLE');
      assert.equal(
        reply.json.error?.message,
        'Service temporarily unavailable. Please retry shortly.',
      );
    }
  });

  it('never leaks Redis internals to the client', async () => {
    const ip = uniqueClientIp();

    const reply = await withRedisDown(async () =>
      post('/auth/login', { email: `leak-${randomUUID()}@failtest.test`, password: 'a-sufficiently-long-password' }, ip),
    );

    const body = reply.raw;
    for (const forbidden of [
      config.redis.url,
      '6379',
      'ECONNREFUSED',
      'ioredis',
      'Connection is closed',
      'Stream isn',
    ]) {
      assert.ok(!body.includes(forbidden), `429/503 body must not mention ${JSON.stringify(forbidden)}`);
    }
    assert.equal(reply.json.error?.details, undefined);
    // No stack, per the existing rule for deliberate errors.
    assert.ok(!body.includes('stack'));
  });

  it('leaves the endpoints that do not depend on Redis working', async () => {
    // Logout carries no limiter, so an outage must not take it down: a user
    // must always be able to end a session.
    const reply = await withRedisDown(async () =>
      post('/auth/logout', { refreshToken: randomUUID() }, uniqueClientIp()),
    );
    assert.equal(reply.status, 204);
  });

  it('does not silently fall back to an in-process counter', async () => {
    const ip = uniqueClientIp();
    const email = `nofallback-${randomUUID()}@failtest.test`;

    // Many attempts while Redis is down. A process-local fallback would have
    // let some through and started counting them.
    const statuses = await withRedisDown(async () => {
      const out: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        out.push((await post('/auth/login', { email, password: 'wrong' }, ip)).status);
      }
      return out;
    });

    assert.deepEqual(new Set(statuses), new Set([503]), 'every attempt refused, none counted locally');

    // And once Redis is back, the budget is untouched: nothing was recorded
    // anywhere during the outage.
    const first = await post('/auth/login', { email, password: 'wrong' }, ip);
    assert.equal(first.status, 401);
  });

  it('reports not-ready while Redis is down, and ready again afterwards', async () => {
    const down = await withRedisDown(async () => call('/health/ready'));

    assert.equal(down.status, 503);
    assert.equal(down.json.status, 'unavailable');
    assert.deepEqual(down.json.dependencies, { database: 'up', redis: 'down' });
    // Only states, never a host, URL or error text.
    assert.ok(!down.raw.includes(config.redis.url));
    assert.ok(!down.raw.includes('6379'));

    const up = await call('/health/ready');
    assert.equal(up.status, 200);
    assert.deepEqual(up.json.dependencies, { database: 'up', redis: 'up' });
  });

  it('keeps liveness independent of Redis', async () => {
    // A liveness probe that depended on Redis would have the orchestrator
    // restart a perfectly healthy process during a Redis outage - a restart
    // loop that cannot possibly fix the actual problem.
    const live = await withRedisDown(async () => call('/health'));

    assert.equal(live.status, 200);
    assert.equal(live.json.status, 'ok');
  });

  it('recovers on its own once Redis returns', async () => {
    const ip = uniqueClientIp();
    const email = `recover-${randomUUID()}@failtest.test`;

    await withRedisDown(async () => {
      assert.equal((await post('/auth/login', { email, password: 'wrong' }, ip)).status, 503);
    });

    // No restart, no manual intervention: the shared client reconnects and the
    // limiter starts answering again.
    const after = await post('/auth/login', { email, password: 'wrong' }, ip);
    assert.equal(after.status, 401);
  });
});

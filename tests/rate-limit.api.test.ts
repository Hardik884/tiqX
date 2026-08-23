import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { closePool, query } from '../src/db/pool.js';
import { getRedis } from '../src/redis/client.js';
import { identifierDigest, rateLimitKey } from '../src/redis/keys.js';
import {
  closeTestRedis,
  connectTestRedis,
  flushTestNamespace,
  scanNamespace,
  uniqueClientIp,
} from './helpers/redis.js';

let server: Server;
let baseUrl: string;

const PASSWORD = 'a-sufficiently-long-password';

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
  await query("DELETE FROM users WHERE email LIKE '%@ratelimit.test'");
  await flushTestNamespace();
  await closeTestRedis();
  await closePool();
});

interface Reply {
  status: number;
  json: { error?: { code: string; message: string; details?: unknown }; [k: string]: unknown };
  headers: Headers;
}

async function post(path: string, body: unknown, ip: string): Promise<Reply> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Reply['json']) : {},
    headers: response.headers,
  };
}

function freshEmail(): string {
  return `rl-${randomUUID()}@ratelimit.test`;
}

describe('login rate limit', () => {
  it('allows up to the limit then refuses with 429', async () => {
    const ip = uniqueClientIp();
    const email = freshEmail();
    const limit = config.rateLimit.login.max;

    // Wrong credentials throughout: the limiter runs before the handler, so
    // what is being counted is attempts, not successes.
    for (let attempt = 1; attempt <= limit; attempt += 1) {
      const reply = await post('/auth/login', { email, password: 'wrong-password' }, ip);
      assert.equal(reply.status, 401, `attempt ${attempt} should reach the handler`);
      assert.equal(reply.headers.get('ratelimit-remaining'), String(limit - attempt));
    }

    const refused = await post('/auth/login', { email, password: 'wrong-password' }, ip);
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error?.code, 'RATE_LIMITED');
    assert.equal(refused.json.error?.message, 'Too many requests. Try again later.');
  });

  it('sends a usable Retry-After and leaks nothing internal', async () => {
    const ip = uniqueClientIp();
    const email = freshEmail();

    for (let i = 0; i <= config.rateLimit.login.max; i += 1) {
      await post('/auth/login', { email, password: 'wrong-password' }, ip);
    }
    const refused = await post('/auth/login', { email, password: 'wrong-password' }, ip);

    assert.equal(refused.status, 429);
    const retryAfter = Number(refused.headers.get('retry-after'));
    assert.ok(retryAfter > 0 && retryAfter <= config.rateLimit.login.windowSeconds);

    const serialized = JSON.stringify(refused.json);
    for (const leak of ['redis', 'Redis', config.redis.url, config.redis.namespace, 'counter', 'ttl']) {
      assert.ok(!serialized.includes(leak), `429 body must not mention ${leak}`);
    }
    assert.equal(refused.json.error?.details, undefined);
  });

  it('counts each (email, ip) pair separately', async () => {
    const ip = uniqueClientIp();
    const victim = freshEmail();
    const bystander = freshEmail();

    for (let i = 0; i <= config.rateLimit.login.max; i += 1) {
      await post('/auth/login', { email: victim, password: 'wrong-password' }, ip);
    }
    assert.equal((await post('/auth/login', { email: victim, password: 'x' }, ip)).status, 429);

    // Another account from the same address still has its own allowance, so one
    // user cannot be locked out by traffic aimed at someone else.
    const other = await post('/auth/login', { email: bystander, password: 'wrong-password' }, ip);
    assert.equal(other.status, 401);

    // And the same account from a different address is unaffected.
    const elsewhere = await post('/auth/login', { email: victim, password: 'wrong' }, uniqueClientIp());
    assert.equal(elsewhere.status, 401);
  });

  it('treats differently spelled identifiers as the same bucket', async () => {
    const ip = uniqueClientIp();
    const email = freshEmail();

    for (let i = 0; i <= config.rateLimit.login.max; i += 1) {
      await post('/auth/login', { email, password: 'wrong-password' }, ip);
    }
    assert.equal((await post('/auth/login', { email, password: 'x' }, ip)).status, 429);

    // Case and padding must not buy a fresh allowance.
    for (const variant of [email.toUpperCase(), `  ${email}  `]) {
      const reply = await post('/auth/login', { email: variant, password: 'x' }, ip);
      assert.equal(reply.status, 429, `variant ${JSON.stringify(variant)} bypassed the limit`);
    }
  });

  it('does not let a successful login escape the limit', async () => {
    const ip = uniqueClientIp();
    const email = freshEmail();
    await post('/auth/register', { email, password: PASSWORD }, uniqueClientIp());

    for (let i = 0; i < config.rateLimit.login.max; i += 1) {
      await post('/auth/login', { email, password: 'wrong-password' }, ip);
    }

    // Correct credentials, but the budget is spent: the limiter runs first.
    const reply = await post('/auth/login', { email, password: PASSWORD }, ip);
    assert.equal(reply.status, 429);
  });
});

describe('register rate limit', () => {
  it('allows up to the limit then refuses, keyed on address', async () => {
    const ip = uniqueClientIp();
    const limit = config.rateLimit.register.max;

    for (let attempt = 1; attempt <= limit; attempt += 1) {
      const reply = await post('/auth/register', { email: freshEmail(), password: PASSWORD }, ip);
      assert.equal(reply.status, 201, `attempt ${attempt}`);
    }

    // A fresh email does not buy a fresh allowance: the attacker controls the
    // email, so it cannot be the key.
    const refused = await post('/auth/register', { email: freshEmail(), password: PASSWORD }, ip);
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error?.code, 'RATE_LIMITED');

    // A different address is unaffected.
    const elsewhere = await post('/auth/register', { email: freshEmail(), password: PASSWORD }, uniqueClientIp());
    assert.equal(elsewhere.status, 201);
  });
});

describe('refresh rate limit', () => {
  it('allows up to the limit then refuses, keyed on address', async () => {
    const ip = uniqueClientIp();
    const limit = config.rateLimit.refresh.max;

    for (let attempt = 1; attempt <= limit; attempt += 1) {
      const reply = await post('/auth/refresh', { refreshToken: randomUUID() }, ip);
      assert.equal(reply.status, 401, `attempt ${attempt} should reach the handler`);
    }

    // Every attempt used a different token, which is exactly why the token
    // cannot be the key: it would mint a new bucket each time.
    const refused = await post('/auth/refresh', { refreshToken: randomUUID() }, ip);
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error?.code, 'RATE_LIMITED');
  });
});

describe('rate limit keyspace', () => {
  it('writes exactly one namespaced key per policy and identifier, with a TTL', async () => {
    await flushTestNamespace();
    const ip = uniqueClientIp();
    const email = freshEmail();

    await post('/auth/login', { email, password: 'wrong-password' }, ip);

    const keys = await scanNamespace('rate-limit:*');
    assert.equal(keys.length, 1, `expected one key, got ${JSON.stringify(keys)}`);

    const expected = rateLimitKey('login', identifierDigest(email, ip));
    assert.equal(keys[0], expected);

    const ttl = await getRedis().ttl(expected);
    assert.ok(ttl > 0 && ttl <= config.rateLimit.login.windowSeconds, `ttl was ${ttl}`);
    assert.equal(await getRedis().get(expected), '1');
  });

  it('does not write rate-limit keys for unlimited endpoints', async () => {
    await flushTestNamespace();

    await post('/auth/logout', { refreshToken: randomUUID() }, uniqueClientIp());

    assert.deepEqual(await scanNamespace('rate-limit:*'), []);
  });
});

describe('concurrent requests against one identifier', () => {
  it('respects the limit under 50 simultaneous login attempts', async () => {
    const ip = uniqueClientIp();
    const email = freshEmail();
    const limit = config.rateLimit.login.max;
    const ATTEMPTS = 50;

    // Genuinely parallel: every request is in flight before any is awaited.
    const replies = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        post('/auth/login', { email, password: 'wrong-password' }, ip),
      ),
    );

    const reachedHandler = replies.filter((r) => r.status === 401).length;
    const limited = replies.filter((r) => r.status === 429).length;

    assert.equal(reachedHandler + limited, ATTEMPTS, 'no other status codes');
    assert.equal(reachedHandler, limit, `exactly ${limit} may reach the handler`);
    assert.equal(limited, ATTEMPTS - limit);

    // Every attempt was counted, including the refused ones.
    const counter = await getRedis().get(rateLimitKey('login', identifierDigest(email, ip)));
    assert.equal(counter, String(ATTEMPTS));
  });
});

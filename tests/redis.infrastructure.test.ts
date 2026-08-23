import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { config } from '../src/config/index.js';
import { consumeRateLimit, resetRateLimit } from '../src/modules/rate-limit/rate-limit.service.js';
import type { RateLimitPolicy } from '../src/modules/rate-limit/rate-limit.types.js';
import { getRedis, isRedisReady, verifyRedisConnection } from '../src/redis/client.js';
import { identifierDigest, namespacePrefix, rateLimitKey } from '../src/redis/keys.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace, scanNamespace } from './helpers/redis.js';

before(async () => {
  await connectTestRedis();
  await flushTestNamespace();
});

after(async () => {
  await flushTestNamespace();
  await closeTestRedis();
});

describe('redis client lifecycle', () => {
  it('connects and answers PING', async () => {
    assert.equal(isRedisReady(), true);
    await verifyRedisConnection();
    assert.equal(await getRedis().ping(), 'PONG');
  });

  it('shares one client rather than opening a connection per call', () => {
    // Identity, not equality: every caller must get the same instance, or
    // shutdown cannot close them all and the server runs out of clients.
    assert.equal(getRedis(), getRedis());
  });

  it('reports a namespaced connection name to the server', async () => {
    const clients = await getRedis().client('LIST');
    assert.match(String(clients), /name=tiqx-api-/);
  });
});

describe('redis key design', () => {
  it('builds namespaced, versioned, purpose-scoped keys', () => {
    const key = rateLimitKey('login', identifierDigest('user@example.com', '10.0.0.1'));

    assert.ok(key.startsWith(`${config.redis.namespace}:v1:rate-limit:login:`));
    assert.equal(key.split(':').length, 5);
  });

  it('normalizes case and surrounding whitespace to one identifier', () => {
    // Otherwise " User@Example.COM " would get its own allowance, and a limit
    // is bypassed by pressing the space bar.
    assert.equal(
      identifierDigest('User@Example.COM', '10.0.0.1'),
      identifierDigest('  user@example.com  ', '10.0.0.1'),
    );
  });

  it('keeps distinct identifiers distinct', () => {
    assert.notEqual(identifierDigest('a@example.com', '10.0.0.1'), identifierDigest('b@example.com', '10.0.0.1'));
    assert.notEqual(identifierDigest('a@example.com', '10.0.0.1'), identifierDigest('a@example.com', '10.0.0.2'));
  });

  it('cannot be steered into another bucket by embedding the separator', () => {
    // Redis keys have no escaping, so a raw value containing ':' could forge a
    // key. Hashing every component removes the ambiguity entirely.
    const spoofed = identifierDigest('victim@example.com:10.0.0.9', '10.0.0.1');
    const real = identifierDigest('victim@example.com', '10.0.0.9');

    assert.notEqual(spoofed, real);
    assert.match(identifierDigest('a:b:c'), /^[0-9a-f]{32}$/, 'digest never contains a separator');
  });

  it('emits no raw email or address into the keyspace', async () => {
    const policy: RateLimitPolicy = { name: 'keyshape', max: 5, windowSeconds: 60 };
    const email = 'leaky-canary@example.com';
    await consumeRateLimit(policy, identifierDigest(email, '10.11.12.13'));

    const keys = await scanNamespace('rate-limit:keyshape:*');
    assert.equal(keys.length, 1);
    assert.ok(!keys[0]!.includes(email));
    assert.ok(!keys[0]!.includes('10.11.12.13'));
  });
});

describe('atomic counter and TTL', () => {
  const policy: RateLimitPolicy = { name: 'ttl-probe', max: 3, windowSeconds: 60 };
  const identifier = identifierDigest('ttl-probe-identifier');

  it('establishes a positive TTL on the first increment', async () => {
    await resetRateLimit(policy, identifier);

    const first = await consumeRateLimit(policy, identifier);
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 2);

    const ttl = await getRedis().ttl(rateLimitKey(policy.name, identifier));
    assert.ok(ttl > 0, `expected a positive TTL, got ${ttl}`);
    assert.ok(ttl <= policy.windowSeconds);
  });

  it('does not extend the window on later increments', async () => {
    await resetRateLimit(policy, identifier);
    await consumeRateLimit(policy, identifier);

    const key = rateLimitKey(policy.name, identifier);
    // Age the window artificially, then spend another request.
    await getRedis().expire(key, 10);
    await consumeRateLimit(policy, identifier);

    const ttl = await getRedis().ttl(key);
    assert.ok(ttl <= 10, `the window must not be extended by later requests, ttl=${ttl}`);
  });

  it('refuses past the limit and reports a reset time', async () => {
    await resetRateLimit(policy, identifier);

    for (let i = 0; i < policy.max; i += 1) {
      assert.equal((await consumeRateLimit(policy, identifier)).allowed, true, `request ${i + 1}`);
    }

    const refused = await consumeRateLimit(policy, identifier);
    assert.equal(refused.allowed, false);
    assert.equal(refused.remaining, 0);
    assert.ok(refused.resetSeconds > 0);
  });

  it('lets the counter lapse and the key disappear when the window ends', async () => {
    const shortPolicy: RateLimitPolicy = { name: 'ttl-expiry', max: 1, windowSeconds: 1 };
    const id = identifierDigest('expiry-probe');
    const key = rateLimitKey(shortPolicy.name, id);
    await resetRateLimit(shortPolicy, id);

    assert.equal((await consumeRateLimit(shortPolicy, id)).allowed, true);
    assert.equal((await consumeRateLimit(shortPolicy, id)).allowed, false);
    assert.ok((await getRedis().exists(key)) === 1);

    // Wait out the window; Redis removes the key itself.
    await delay(1_400);

    assert.equal(await getRedis().exists(key), 0, 'the key must expire on its own');
    assert.equal(
      (await consumeRateLimit(shortPolicy, id)).allowed,
      true,
      'the allowance returns in the next window',
    );
    await resetRateLimit(shortPolicy, id);
  });

  it('keeps separate identifiers independent', async () => {
    const p: RateLimitPolicy = { name: 'independent', max: 2, windowSeconds: 60 };
    const a = identifierDigest('caller-a');
    const b = identifierDigest('caller-b');
    await resetRateLimit(p, a);
    await resetRateLimit(p, b);

    await consumeRateLimit(p, a);
    await consumeRateLimit(p, a);
    assert.equal((await consumeRateLimit(p, a)).allowed, false, 'a is exhausted');
    assert.equal((await consumeRateLimit(p, b)).allowed, true, 'b is untouched');
  });

  it('keeps separate policies independent for the same identifier', async () => {
    const one: RateLimitPolicy = { name: 'policy-one', max: 1, windowSeconds: 60 };
    const two: RateLimitPolicy = { name: 'policy-two', max: 1, windowSeconds: 60 };
    const id = identifierDigest('same-caller');
    await resetRateLimit(one, id);
    await resetRateLimit(two, id);

    await consumeRateLimit(one, id);
    assert.equal((await consumeRateLimit(one, id)).allowed, false);
    assert.equal((await consumeRateLimit(two, id)).allowed, true, 'a different policy has its own budget');
  });

  it('counts correctly under genuinely concurrent increments', async () => {
    const p: RateLimitPolicy = { name: 'atomicity', max: 20, windowSeconds: 60 };
    const id = identifierDigest('concurrent-caller');
    await resetRateLimit(p, id);

    const ATTEMPTS = 100;
    // Fired together: a read-modify-write limiter loses updates here and lets
    // more than `max` through.
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => consumeRateLimit(p, id)),
    );

    const allowed = results.filter((r) => r.allowed).length;
    assert.equal(allowed, p.max, `exactly ${p.max} may be allowed, got ${allowed}`);
    assert.equal(
      await getRedis().get(rateLimitKey(p.name, id)),
      String(ATTEMPTS),
      'every increment must be counted, none lost',
    );
    await resetRateLimit(p, id);
  });
});

describe('namespace isolation', () => {
  it('leaves keys outside the namespace alone', async () => {
    const redis = getRedis();
    const foreignKey = 'someone-elses-app:v9:important';
    await redis.set(foreignKey, 'do-not-touch');

    try {
      const policy: RateLimitPolicy = { name: 'isolation', max: 5, windowSeconds: 60 };
      await consumeRateLimit(policy, identifierDigest('isolation-probe'));
      const removed = await flushTestNamespace();

      assert.ok(removed > 0, 'the namespace flush should have removed our own keys');
      assert.equal(await redis.get(foreignKey), 'do-not-touch', 'foreign keys survive');

      const ours = await scanNamespace();
      assert.deepEqual(ours, [], 'our namespace is empty');
      assert.ok(namespacePrefix().startsWith(config.redis.namespace));
    } finally {
      await redis.del(foreignKey);
    }
  });
});

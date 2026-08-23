import { randomInt } from 'node:crypto';

import { closeRedis, connectRedis, getRedis } from '../../src/redis/client.js';
import { namespacePrefix } from '../../src/redis/keys.js';

/**
 * Connects the shared client for a test file.
 *
 * Tests build the app with `createApp()` rather than going through the server
 * lifecycle, so nothing has opened Redis for them. This is the same client the
 * application uses against a real Redis server - never a stand-in. A fake Map
 * would pass every test here while proving nothing about atomicity, TTLs or
 * sharing state between processes, which is the entire point of the feature.
 */
export async function connectTestRedis(): Promise<void> {
  await connectRedis();
}

export async function closeTestRedis(): Promise<void> {
  await closeRedis();
}

/**
 * Deletes every key this application owns, leaving anything else on the server
 * untouched.
 *
 * SCAN rather than FLUSHDB, deliberately: a developer's Redis may hold other
 * data, and a test suite that wipes the whole database is a trap. Scoping the
 * delete to the configured namespace also proves the namespace is real.
 */
export async function flushTestNamespace(): Promise<number> {
  const redis = getRedis();
  const match = `${namespacePrefix()}:*`;

  let cursor = '0';
  let deleted = 0;

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== '0');

  return deleted;
}

/** Every key currently under the application namespace. */
export async function scanNamespace(pattern = '*'): Promise<string[]> {
  const redis = getRedis();
  const match = `${namespacePrefix()}:${pattern}`;

  let cursor = '0';
  const found: string[] = [];

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 500);
    cursor = next;
    found.push(...keys);
  } while (cursor !== '0');

  return found.sort();
}

/**
 * A distinct client IP per caller.
 *
 * Rate limits are keyed partly on the client address, so every test hitting a
 * limited endpoint from 127.0.0.1 would otherwise share one bucket and the
 * suites would exhaust each other's allowance. Giving each test its own address
 * isolates identifiers, which is the right fix - disabling the middleware for
 * tests would mean the wiring is never exercised at all.
 *
 * Requires TRUST_PROXY in the test environment so Express honours the header.
 * Tests that mean to *hit* a limit pin one address instead of calling this.
 */
export function uniqueClientIp(): string {
  return `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

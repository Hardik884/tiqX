import { Redis } from 'ioredis';

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * The single Redis connection for the process.
 *
 * One client, created once, shared by everything - the same rule the PostgreSQL
 * pool follows. A connection per request would spend a TCP handshake on every
 * call and exhaust the server's client limit under load, and clients created
 * inside controllers or services are impossible to shut down cleanly.
 *
 * Two options here are load-bearing rather than cosmetic:
 *
 *   enableOfflineQueue: false
 *     By default ioredis buffers commands while disconnected and replays them
 *     on reconnect. For a rate limiter that is exactly wrong: a request would
 *     hang instead of failing, and the limiter's decision would arrive after
 *     the response should already have gone out. With the queue off, a command
 *     issued while Redis is down rejects immediately, which is what lets the
 *     fail-closed policy actually take effect.
 *
 *   maxRetriesPerRequest: 1
 *     Bounds how long a single command may spend retrying, so one sick Redis
 *     cannot turn into a pile of stuck HTTP requests.
 *
 * Reconnection itself is left to ioredis, which retries with backoff in the
 * background; the application does not orchestrate it.
 */
let client: Redis | null = null;

function createClient(): Redis {
  const instance = new Redis(config.redis.url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: config.redis.connectTimeoutMs,
    // Named on the server side, so CLIENT LIST shows who is connected.
    connectionName: `tiqx-api-${config.env}`,
  });

  // The URL can carry a password, which is why nothing here logs the URL, and
  // only the error's message - never the object, which repeats the connection
  // options back.
  instance.on('error', (error: Error) => {
    logger.error('Redis client error', { error: error.message });
  });

  instance.on('reconnecting', (delay: number) => {
    logger.warn('Redis reconnecting', { delayMs: delay });
  });

  instance.on('end', () => {
    logger.warn('Redis connection closed');
  });

  instance.on('ready', () => {
    logger.info('Connected to Redis', { namespace: config.redis.namespace });
  });

  return instance;
}

/**
 * Opens the connection. Called once from the server lifecycle, before the HTTP
 * listener starts accepting traffic.
 */
export async function connectRedis(): Promise<void> {
  client ??= createClient();

  if (client.status === 'ready') {
    return;
  }

  await client.connect();
}

/**
 * The shared client.
 *
 * Throws rather than lazily connecting, so a module reaching for Redis outside
 * the lifecycle is a loud bug instead of a second, unmanaged connection.
 */
export function getRedis(): Redis {
  if (client === null) {
    throw new Error('Redis has not been connected; call connectRedis() during startup');
  }
  return client;
}

/** Cheap liveness probe. Throws when Redis is unreachable. */
export async function verifyRedisConnection(): Promise<void> {
  const response = await getRedis().ping();
  if (response !== 'PONG') {
    throw new Error(`Unexpected PING response: ${response}`);
  }
}

/** True when a command issued now would be attempted rather than rejected. */
export function isRedisReady(): boolean {
  return client !== null && client.status === 'ready';
}

/**
 * Closes the connection, waiting for in-flight commands. Falls back to a hard
 * disconnect if the server does not answer QUIT, so shutdown cannot hang.
 */
export async function closeRedis(): Promise<void> {
  if (client === null) {
    return;
  }

  try {
    await client.quit();
  } catch {
    client.disconnect();
  } finally {
    client = null;
  }
}

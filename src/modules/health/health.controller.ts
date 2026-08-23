import type { Request, Response } from 'express';

import { verifyDatabaseConnection } from '../../db/pool.js';
import { verifyRedisConnection } from '../../redis/client.js';
import { logger } from '../../utils/logger.js';

/**
 * Liveness: confirms the process is up and serving requests. Deliberately does
 * not touch dependencies, and exposes no configuration or credentials.
 */
export function getHealth(_req: Request, res: Response): void {
  res.status(200).json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

type DependencyState = 'up' | 'down';

/** Probes one dependency, turning any failure into a state plus a logged reason. */
async function probe(
  name: string,
  check: () => Promise<unknown>,
  requestId: string | undefined,
): Promise<DependencyState> {
  try {
    await check();
    return 'up';
  } catch (error) {
    // Logged server-side with correlation; never returned. A Redis error can
    // quote the URL it failed to dial, and that URL can carry a password.
    logger.error('Readiness probe failed', {
      requestId,
      dependency: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'down';
  }
}

/**
 * Readiness: confirms the process can reach every dependency it needs to serve
 * traffic correctly - PostgreSQL and Redis.
 *
 * Redis belongs here, unlike in liveness, because the auth endpoints fail
 * closed without it: an instance that cannot reach Redis can still answer
 * requests but cannot serve them safely, which is exactly what "not ready"
 * means. Reporting ready would keep it in the load balancer's rotation while it
 * refuses every login.
 *
 * Both probes run regardless of the other's outcome, so one failure does not
 * mask the other. The response carries states only - no host, no URL, no error
 * text, no stack.
 */
export async function getReadiness(_req: Request, res: Response): Promise<void> {
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  const [database, redis] = await Promise.all([
    probe('database', verifyDatabaseConnection, requestId),
    probe('redis', verifyRedisConnection, requestId),
  ]);

  const ready = database === 'up' && redis === 'up';

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'unavailable',
    dependencies: { database, redis },
    timestamp: new Date().toISOString(),
  });
}

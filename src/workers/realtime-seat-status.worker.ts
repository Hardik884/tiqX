import { config } from '../config/index.js';
import { closePool, verifyDatabaseConnection, withTransaction } from '../db/pool.js';
import {
  claimPendingSeatStatusEvents,
  countPendingSeatStatusEvents,
  markSeatStatusEventProcessed,
  recordSeatStatusEventFailure,
} from '../modules/realtime/seat-status-outbox.repository.js';
import { closeRedis, connectRedis, getRedis, verifyRedisConnection } from '../redis/client.js';
import { seatEventsChannel } from '../redis/keys.js';
import { logger } from '../utils/logger.js';
import type { ServerMessage } from '../realtime/message-types.js';

/**
 * The real-time seat-status worker: `seat_status_outbox` -> Redis Pub/Sub.
 *
 * A separate entrypoint from the API and from the other two workers, sharing
 * only the connection pool, Redis and configuration - the same reasoning
 * `hold-expiration.worker.ts` and `waitlist-allocation.worker.ts` already
 * give for their own separate processes. This one PUBLISHES; it never talks
 * to a WebSocket client directly. Every API process independently SUBSCRIBEs
 * to whichever events its own connected clients care about and re-broadcasts
 * locally - see subscription-registry.ts. That split is what lets the
 * WebSocket-serving tier scale horizontally: this worker does not need to
 * know how many API instances exist or which one holds which client.
 *
 * ONE LOOP: claim a batch of unpublished rows and publish each in the same
 * transaction as its claim - the identical shape `publishPendingExpirations`
 * already uses for the Redis SET behind hold expiration, and for the
 * identical reason: holding the claim open across the network call is what
 * makes this genuinely at-least-once. Marking a row processed *before*
 * confirming the publish succeeded would risk losing an event outright if the
 * publish then failed - at-most-once, the opposite of what is promised - so
 * the row stays claimed, unpublished rows stay unprocessed on failure, and a
 * later attempt (by this worker or another) retries them.
 *
 * This does not violate "never call Redis while holding database locks" from
 * the customer-facing side of this feature: the only lock held during the
 * PUBLISH is on this worker's own outbox row, taken by this worker, for this
 * worker's own bookkeeping - no hold, booking, cancellation or waitlist
 * request is ever waiting on it. Those requests commit and return the moment
 * their `show_seats` UPDATE (and the trigger's outbox INSERT) commits, long
 * before any worker gets around to publishing.
 */

interface WorkerStats {
  claimed: number;
  published: number;
  publishFailures: number;
  loopErrors: number;
}

const stats: WorkerStats = { claimed: 0, published: 0, publishFailures: 0, loopErrors: 0 };

let running = true;
let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function runLoop(name: string, intervalMs: number, job: () => Promise<void>): Promise<void> {
  while (running) {
    try {
      await job();
    } catch (error) {
      stats.loopErrors += 1;
      logger.error('Worker loop iteration failed', {
        loop: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!running) {
      break;
    }
    await sleep(intervalMs);
  }

  logger.info('Worker loop stopped', { loop: name });
}

async function publishLoop(): Promise<void> {
  await withTransaction(async (client) => {
    const rows = await claimPendingSeatStatusEvents(client, config.realtime.outboxBatchSize);
    stats.claimed += rows.length;

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

      try {
        await getRedis().publish(seatEventsChannel(row.eventId), JSON.stringify(message));
        await markSeatStatusEventProcessed(client, row.id);
        stats.published += 1;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        await recordSeatStatusEventFailure(
          client,
          row.id,
          errorMessage,
          config.realtime.outboxRetryBaseMs,
          config.realtime.outboxRetryMaxMs,
        );
        stats.publishFailures += 1;

        logger.warn('Failed to publish seat status event, will retry', {
          outboxId: row.id,
          eventId: row.eventId,
          seatId: row.showSeatId,
          attempts: row.attempts + 1,
          error: errorMessage,
        });
      }
    }
  });
}

async function summaryLoop(): Promise<void> {
  const pending = await withTransaction((client) => countPendingSeatStatusEvents(client));

  logger.info('Realtime seat status worker summary', {
    pendingOutbox: pending,
    claimed: stats.claimed,
    published: stats.published,
    publishFailures: stats.publishFailures,
    loopErrors: stats.loopErrors,
  });
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  running = false;

  logger.info('Realtime seat status worker shutting down', { reason });

  const forceExit = setTimeout(() => {
    logger.error('Forced worker shutdown after timeout', {
      timeoutMs: config.shutdownTimeoutMs,
    });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    // No in-flight work needs draining beyond the current iteration - each
    // unit of work is one transaction, so an interrupted pass either
    // committed or rolled back, and whatever was not finished is still
    // pending in PostgreSQL for the next run to claim.
    await closeRedis();
    await closePool();
    logger.info('Realtime seat status worker stopped');
    process.exit(0);
  } catch (error) {
    logger.error('Error during worker shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

async function start(): Promise<void> {
  try {
    await verifyDatabaseConnection();
    logger.info('Worker connected to PostgreSQL');
  } catch (error) {
    logger.error('Worker cannot reach PostgreSQL, aborting startup', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  try {
    await connectRedis();
    await verifyRedisConnection();
  } catch (error) {
    logger.error('Worker cannot reach Redis, aborting startup', {
      error: error instanceof Error ? error.message : String(error),
    });
    await closeRedis();
    process.exit(1);
  }

  logger.info('Realtime seat status worker started', {
    env: config.env,
    outboxPollIntervalMs: config.realtime.outboxPollIntervalMs,
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await Promise.all([
    runLoop('publish', config.realtime.outboxPollIntervalMs, publishLoop),
    runLoop('summary', 30_000, summaryLoop),
  ]);
}

void start();

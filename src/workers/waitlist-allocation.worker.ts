import { config } from '../config/index.js';
import { closePool, verifyDatabaseConnection, withTransaction } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import {
  claimPendingAllocations,
  countPendingAllocations,
  enqueueWaitlistAllocation,
  findCategoriesNeedingAllocation,
  markAllocationProcessed,
  recordAllocationFailure,
} from '../modules/waitlist/waitlist-outbox.repository.js';
import { runAllocationPass } from '../modules/waitlist/waitlist.service.js';

/**
 * The waitlist allocation worker.
 *
 * A separate entrypoint from both the API and the hold-expiration worker,
 * sharing only the connection pool and configuration. It needs no Redis
 * client at all: PostgreSQL alone decides queue order, seat ownership, offer
 * status and expiration here, matching the task's own instruction that Redis
 * must never be the authority for whether an allocation succeeds.
 *
 * Two loops:
 *
 *   allocate     outbox rows -> offers, via runAllocationPass    (fast)
 *   reconcile    event/categories with no pending signal -> one enqueued (slow, self-healing)
 *
 * There is deliberately no third loop for offer *expiry*. That rides the
 * existing hold-expiration worker instead - see expireHoldInTransaction in
 * expiration.service.ts and the waitlist migration's top comment for why an
 * offer's backing hold already carries its own expiry, and reproducing that
 * here would be a second, redundant clock racing the first one for no
 * benefit.
 */

interface WorkerStats {
  claimed: number;
  offersCreated: number;
  seatsRaced: number;
  allocationFailures: number;
  reconciled: number;
  loopErrors: number;
}

const stats: WorkerStats = {
  claimed: 0,
  offersCreated: 0,
  seatsRaced: 0,
  allocationFailures: 0,
  reconciled: 0,
  loopErrors: 0,
};

let running = true;
let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/** Identical shape to hold-expiration.worker.ts's runLoop - see there for why. */
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

/**
 * Claims a batch of allocation signals and runs one pairing pass per row.
 *
 * Each claimed row gets its own transaction: the claim's `FOR UPDATE SKIP
 * LOCKED` lock, the candidate locks `runAllocationPass` takes, and every offer
 * it creates all commit together, or none of them do. A failure in one row's
 * pass - a bug, a connection drop - is caught, backed off via
 * `recordAllocationFailure`, and logged; it must not stop the batch's other
 * rows from being processed.
 */
async function allocateLoop(): Promise<void> {
  const rows = await withTransaction(async (client) => {
    const claimed = await claimPendingAllocations(client, config.waitlist.allocationBatchSize);

    for (const row of claimed) {
      try {
        const result = await runAllocationPass(client, row.eventId, row.seatCategory, undefined);
        await markAllocationProcessed(client, row.id);

        stats.offersCreated += result.offersCreated;
        stats.seatsRaced += result.seatsRaced;

        if (result.offersCreated > 0) {
          logger.info('Waitlist allocation pass completed', {
            eventId: row.eventId,
            seatCategory: row.seatCategory,
            offersCreated: result.offersCreated,
            seatsRaced: result.seatsRaced,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordAllocationFailure(
          client,
          row.id,
          message,
          config.waitlist.allocationRetryBaseMs,
          config.waitlist.allocationRetryMaxMs,
        );
        stats.allocationFailures += 1;

        logger.warn('Waitlist allocation pass failed, will retry', {
          outboxId: row.id,
          eventId: row.eventId,
          seatCategory: row.seatCategory,
          attempts: row.attempts + 1,
          error: message,
        });
      }
    }

    return claimed;
  });

  stats.claimed += rows.length;
}

/**
 * Self-healing: enqueues a signal for any event/category this worker can see
 * has both a waiting candidate and an available seat but no pending row for -
 * see `findCategoriesNeedingAllocation`.
 */
async function reconcileLoop(): Promise<void> {
  const gaps = await withTransaction((client) =>
    findCategoriesNeedingAllocation(client, config.waitlist.reconcileBatchSize),
  );

  if (gaps.length === 0) {
    return;
  }

  for (const gap of gaps) {
    await withTransaction((client) => enqueueWaitlistAllocation(client, gap.eventId, gap.seatCategory));
  }

  stats.reconciled += gaps.length;
  logger.warn('Enqueued missing waitlist allocation signals', { count: gaps.length });
}

async function summaryLoop(): Promise<void> {
  const pending = await withTransaction((client) => countPendingAllocations(client));

  logger.info('Waitlist allocation worker summary', {
    pendingOutbox: pending,
    claimed: stats.claimed,
    offersCreated: stats.offersCreated,
    seatsRaced: stats.seatsRaced,
    allocationFailures: stats.allocationFailures,
    reconciled: stats.reconciled,
    loopErrors: stats.loopErrors,
  });
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  running = false;

  logger.info('Waitlist allocation worker shutting down', { reason });

  const forceExit = setTimeout(() => {
    logger.error('Forced worker shutdown after timeout', {
      timeoutMs: config.shutdownTimeoutMs,
    });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    // No in-flight work needs draining beyond the current iteration: each
    // unit of work is one transaction, so an interrupted pass either
    // committed or rolled back. Whatever was not finished is still pending in
    // PostgreSQL and will be claimed by the next run - by this worker or
    // another.
    await closePool();
    logger.info('Waitlist allocation worker stopped');
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

  logger.info('Waitlist allocation worker started', {
    env: config.env,
    offerTtlSeconds: config.waitlist.offerTtlSeconds,
    allocationPollIntervalMs: config.waitlist.allocationPollIntervalMs,
    reconcileIntervalMs: config.waitlist.reconcileIntervalMs,
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await Promise.all([
    runLoop('allocate', config.waitlist.allocationPollIntervalMs, allocateLoop),
    runLoop('reconcile', config.waitlist.reconcileIntervalMs, reconcileLoop),
    runLoop('summary', Math.max(config.waitlist.reconcileIntervalMs, 30_000), summaryLoop),
  ]);
}

void start();

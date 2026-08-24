import { config } from '../config/index.js';
import { closePool, verifyDatabaseConnection, withTransaction } from '../db/pool.js';
import { countPendingOutbox } from '../modules/expiration/expiration.repository.js';
import {
  publishPendingExpirations,
  reconcileExpiryKeys,
  sweepExpiredHolds,
} from '../modules/expiration/expiration.service.js';
import { closeRedis, connectRedis, verifyRedisConnection } from '../redis/client.js';
import { logger } from '../utils/logger.js';

/**
 * The hold expiration worker.
 *
 * A separate entrypoint from the API, sharing its configuration, pool and Redis
 * client but starting no HTTP server. Running it inside the API process would
 * tie the two lifecycles together and mean scaling the web tier also multiplies
 * the sweep; here they scale independently, and the worker can be run as many
 * times as needed because every loop is safe under concurrency.
 *
 * Three loops, each with its own cadence:
 *
 *   publish      outbox rows -> Redis expiration keys           (fast)
 *   sweep        PostgreSQL holds past expiry -> expired        (fast, authoritative)
 *   reconcile    active holds missing a Redis key -> restored   (slow, self-healing)
 *
 * They are separate because they fail independently. Redis being down stops
 * publishing and reconciliation but must not stop the sweep, which needs only
 * PostgreSQL - so a Redis outage delays the *signal*, never the expiry itself.
 */

/** Counters for the periodic summary. No metrics framework is introduced. */
interface WorkerStats {
  published: number;
  publishFailures: number;
  expired: number;
  noop: number;
  reconciled: number;
  loopErrors: number;
}

const stats: WorkerStats = {
  published: 0,
  publishFailures: 0,
  expired: 0,
  noop: 0,
  reconciled: 0,
  loopErrors: 0,
};

let running = true;
let shuttingDown = false;

/** Resolves after `ms`, or immediately once shutdown has been requested. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Do not hold the process open purely to finish a sleep.
    timer.unref();
  });
}

/**
 * Runs one job on an interval until shutdown.
 *
 * Errors are caught and logged rather than allowed to kill the loop: a
 * transient database blip should cost one cycle, not the worker. The delay is
 * applied after each pass, so a slow pass does not stack up overlapping runs -
 * this is a polling loop with a floor, not a fixed-rate scheduler, which keeps
 * the number of live timers at one per loop no matter how long work takes.
 */
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
  const result = await publishPendingExpirations();
  stats.published += result.published;
  stats.publishFailures += result.failed;
}

async function sweepLoop(): Promise<void> {
  const result = await sweepExpiredHolds();
  stats.expired += result.expired;
  stats.noop += result.noop;
}

async function reconcileLoop(): Promise<void> {
  const result = await reconcileExpiryKeys();
  stats.reconciled += result.restored;
}

/**
 * Periodic summary.
 *
 * Deliberately the only routine log line: the loops themselves log when they do
 * something, never when they find nothing, so an idle worker is silent rather
 * than writing a line per second per loop. Anything reaching a log aggregator
 * every second at idle is noise that hides the events worth seeing.
 */
async function summaryLoop(): Promise<void> {
  const pending = await withTransaction((client) => countPendingOutbox(client));

  logger.info('Hold expiration worker summary', {
    pendingOutbox: pending,
    published: stats.published,
    publishFailures: stats.publishFailures,
    expired: stats.expired,
    noop: stats.noop,
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

  logger.info('Hold expiration worker shutting down', { reason });

  // Never hang forever on a stuck connection.
  const forceExit = setTimeout(() => {
    logger.error('Forced worker shutdown after timeout', {
      timeoutMs: config.shutdownTimeoutMs,
    });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    // No in-flight work needs draining beyond the current iteration: each unit
    // of work is one transaction, so an interrupted pass either committed or
    // rolled back. Whatever was not finished is still pending in PostgreSQL and
    // will be claimed by the next run - by this worker or another.
    await closeRedis();
    await closePool();
    logger.info('Hold expiration worker stopped');
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

  // Redis is required to start, matching the API. Unlike the API, though, the
  // worker keeps its most important job working if Redis fails later: the sweep
  // needs only PostgreSQL.
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

  logger.info('Hold expiration worker started', {
    env: config.env,
    outboxPollIntervalMs: config.expiration.outboxPollIntervalMs,
    sweepIntervalMs: config.expiration.sweepIntervalMs,
    reconcileIntervalMs: config.expiration.reconcileIntervalMs,
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await Promise.all([
    runLoop('publish', config.expiration.outboxPollIntervalMs, publishLoop),
    runLoop('sweep', config.expiration.sweepIntervalMs, sweepLoop),
    runLoop('reconcile', config.expiration.reconcileIntervalMs, reconcileLoop),
    runLoop('summary', Math.max(config.expiration.reconcileIntervalMs, 30_000), summaryLoop),
  ]);
}

void start();

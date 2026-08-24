import { withTransaction } from '../db/pool.js';
import { config } from '../config/index.js';
import { getRedis } from '../redis/client.js';
import { seatEventsChannel } from '../redis/keys.js';
import { logger } from '../utils/logger.js';
import { countPendingOutbox as countPendingHoldOutbox } from '../modules/expiration/expiration.repository.js';
import {
  publishPendingExpirations,
  reconcileExpiryKeys,
  sweepExpiredHolds,
} from '../modules/expiration/expiration.service.js';
import { countPendingTicketEmails, sendPendingTicketEmails } from '../modules/notifications/ticket-email.service.js';
import {
  claimPendingAllocations,
  countPendingAllocations,
  enqueueWaitlistAllocation,
  findCategoriesNeedingAllocation,
  markAllocationProcessed,
  recordAllocationFailure,
} from '../modules/waitlist/waitlist-outbox.repository.js';
import { runAllocationPass } from '../modules/waitlist/waitlist.service.js';
import {
  claimPendingSeatStatusEvents,
  countPendingSeatStatusEvents,
  markSeatStatusEventProcessed,
  recordSeatStatusEventFailure,
} from '../modules/realtime/seat-status-outbox.repository.js';
import type { ServerMessage } from '../realtime/message-types.js';

/**
 * The three background workers (hold-expiration + ticket email, waitlist
 * allocation, real-time seat status), running as loops inside this same
 * process instead of three separate ones.
 *
 * `hold-expiration.worker.ts`, `waitlist-allocation.worker.ts` and
 * `realtime-seat-status.worker.ts` remain the real, independently-scalable
 * entrypoints - the ones a production deployment with its own worker
 * infrastructure should run. This module exists for a deployment target
 * (a single free-tier web service) that has exactly one process to work
 * with: every loop below is the same job, at the same cadence, against the
 * same tables, just polled from inside the API instead of a sibling process.
 *
 * What is deliberately NOT duplicated here: connecting to PostgreSQL/Redis
 * (the API already does that before calling `startInProcessWorkers`),
 * SIGTERM/SIGINT handling, and `process.exit` (the API's own shutdown owns
 * the process lifecycle; a background loop erroring must never take the HTTP
 * server down with it). `stop()` only flips the loops' running flag and lets
 * server.ts's existing shutdown sequence close Redis and the pool once every
 * loop has actually exited.
 */

interface Stats {
  holdPublished: number;
  holdPublishFailures: number;
  holdExpired: number;
  holdNoop: number;
  holdReconciled: number;
  emailsSent: number;
  emailFailures: number;
  waitlistOffersCreated: number;
  waitlistSeatsRaced: number;
  waitlistAllocationFailures: number;
  waitlistReconciled: number;
  realtimePublished: number;
  realtimePublishFailures: number;
  loopErrors: number;
}

const stats: Stats = {
  holdPublished: 0,
  holdPublishFailures: 0,
  holdExpired: 0,
  holdNoop: 0,
  holdReconciled: 0,
  emailsSent: 0,
  emailFailures: 0,
  waitlistOffersCreated: 0,
  waitlistSeatsRaced: 0,
  waitlistAllocationFailures: 0,
  waitlistReconciled: 0,
  realtimePublished: 0,
  realtimePublishFailures: 0,
  loopErrors: 0,
};

let running = false;
const activeLoops: Promise<void>[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/** Identical shape to every standalone worker's own `runLoop` - see those files. */
async function runLoop(name: string, intervalMs: number, job: () => Promise<void>): Promise<void> {
  while (running) {
    try {
      await job();
    } catch (error) {
      stats.loopErrors += 1;
      logger.error('In-process worker loop iteration failed', {
        loop: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!running) {
      break;
    }
    await sleep(intervalMs);
  }

  logger.info('In-process worker loop stopped', { loop: name });
}

async function holdPublishLoop(): Promise<void> {
  const result = await publishPendingExpirations();
  stats.holdPublished += result.published;
  stats.holdPublishFailures += result.failed;
}

async function holdSweepLoop(): Promise<void> {
  const result = await sweepExpiredHolds();
  stats.holdExpired += result.expired;
  stats.holdNoop += result.noop;
}

async function holdReconcileLoop(): Promise<void> {
  const result = await reconcileExpiryKeys();
  stats.holdReconciled += result.restored;
}

async function ticketEmailLoop(): Promise<void> {
  const result = await sendPendingTicketEmails();
  stats.emailsSent += result.sent;
  stats.emailFailures += result.failed;
}

/** Mirrors waitlist-allocation.worker.ts::allocateLoop exactly. */
async function waitlistAllocateLoop(): Promise<void> {
  await withTransaction(async (client) => {
    const claimed = await claimPendingAllocations(client, config.waitlist.allocationBatchSize);

    for (const row of claimed) {
      try {
        const result = await runAllocationPass(client, row.eventId, row.seatCategory, undefined);
        await markAllocationProcessed(client, row.id);

        stats.waitlistOffersCreated += result.offersCreated;
        stats.waitlistSeatsRaced += result.seatsRaced;

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
        stats.waitlistAllocationFailures += 1;

        logger.warn('Waitlist allocation pass failed, will retry', {
          outboxId: row.id,
          eventId: row.eventId,
          seatCategory: row.seatCategory,
          attempts: row.attempts + 1,
          error: message,
        });
      }
    }
  });
}

/** Mirrors waitlist-allocation.worker.ts::reconcileLoop exactly. */
async function waitlistReconcileLoop(): Promise<void> {
  const gaps = await withTransaction((client) =>
    findCategoriesNeedingAllocation(client, config.waitlist.reconcileBatchSize),
  );

  if (gaps.length === 0) {
    return;
  }

  for (const gap of gaps) {
    await withTransaction((client) => enqueueWaitlistAllocation(client, gap.eventId, gap.seatCategory));
  }

  stats.waitlistReconciled += gaps.length;
  logger.warn('Enqueued missing waitlist allocation signals', { count: gaps.length });
}

/** Mirrors realtime-seat-status.worker.ts::publishLoop exactly. */
async function realtimePublishLoop(): Promise<void> {
  await withTransaction(async (client) => {
    const rows = await claimPendingSeatStatusEvents(client, config.realtime.outboxBatchSize);

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
        stats.realtimePublished += 1;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        await recordSeatStatusEventFailure(
          client,
          row.id,
          errorMessage,
          config.realtime.outboxRetryBaseMs,
          config.realtime.outboxRetryMaxMs,
        );
        stats.realtimePublishFailures += 1;

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
  const [pendingHoldOutbox, pendingEmails, pendingAllocations, pendingSeatEvents] = await Promise.all([
    withTransaction((client) => countPendingHoldOutbox(client)),
    withTransaction((client) => countPendingTicketEmails(client)),
    withTransaction((client) => countPendingAllocations(client)),
    withTransaction((client) => countPendingSeatStatusEvents(client)),
  ]);

  logger.info('In-process background worker summary', {
    pendingHoldOutbox,
    pendingTicketEmails: pendingEmails,
    pendingWaitlistAllocations: pendingAllocations,
    pendingSeatStatusEvents: pendingSeatEvents,
    ...stats,
  });
}

/**
 * Starts every background loop. Call once, after the API has already
 * connected to PostgreSQL and Redis - this assumes both are already up and
 * touches neither's lifecycle itself.
 */
export function startInProcessWorkers(): void {
  if (running) {
    return;
  }
  running = true;

  logger.info('Starting in-process background workers', {
    outboxPollIntervalMs: config.expiration.outboxPollIntervalMs,
    sweepIntervalMs: config.expiration.sweepIntervalMs,
    ticketEmailPollIntervalMs: config.notifications.outboxPollIntervalMs,
    waitlistAllocationPollIntervalMs: config.waitlist.allocationPollIntervalMs,
    realtimeOutboxPollIntervalMs: config.realtime.outboxPollIntervalMs,
    emailProvider: config.email.provider,
  });

  activeLoops.push(
    runLoop('hold-publish', config.expiration.outboxPollIntervalMs, holdPublishLoop),
    runLoop('hold-sweep', config.expiration.sweepIntervalMs, holdSweepLoop),
    runLoop('hold-reconcile', config.expiration.reconcileIntervalMs, holdReconcileLoop),
    runLoop('ticket-email', config.notifications.outboxPollIntervalMs, ticketEmailLoop),
    runLoop('waitlist-allocate', config.waitlist.allocationPollIntervalMs, waitlistAllocateLoop),
    runLoop('waitlist-reconcile', config.waitlist.reconcileIntervalMs, waitlistReconcileLoop),
    runLoop('realtime-publish', config.realtime.outboxPollIntervalMs, realtimePublishLoop),
    runLoop('summary', Math.max(config.expiration.reconcileIntervalMs, 30_000), summaryLoop),
  );
}

/** Stops every loop and waits for the current iteration of each to finish. */
export async function stopInProcessWorkers(): Promise<void> {
  if (!running) {
    return;
  }
  running = false;
  await Promise.all(activeLoops);
  activeLoops.length = 0;
}

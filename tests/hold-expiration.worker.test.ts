import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { closePool, query, withTransaction } from '../src/db/pool.js';
import { claimPendingOutboxRows } from '../src/modules/expiration/expiration.repository.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import { getRedis } from '../src/redis/client.js';
import { holdExpiryKey } from '../src/redis/keys.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace } from './helpers/redis.js';
import { cleanupSeedData, seedCustomer, seedShow } from './helpers/seed.js';

const workers: ChildProcess[] = [];

before(async () => {
  await connectTestRedis();
  await flushTestNamespace();
});

after(async () => {
  await stopWorkers();
  await flushTestNamespace();
  await closeTestRedis();
  await cleanupSeedData();
  await closePool();
});

/**
 * Starts a real worker process.
 *
 * Node directly with tsx as a loader, not through npx: an npm wrapper would sit
 * between the test and the worker, so a kill would reach the wrapper and orphan
 * the process it was meant to stop - which matters enormously in a crash test.
 */
async function startWorker(label: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/workers/hold-expiration.worker.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, OUTBOX_POLL_INTERVAL_MS: '100', EXPIRY_SWEEP_INTERVAL_MS: '200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  workers.push(child);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not start in time:\n${output.join('')}`)),
      30_000,
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Hold expiration worker started')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited with ${code}:\n${output.join('')}`));
    });
  });

  return child;
}

async function stopWorker(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill(signal);
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000).unref();
  });
}

async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((child) => stopWorker(child)));
  workers.length = 0;
}

/** Creates `count` holds, each of which queues one outbox event. */
async function createHolds(count: number, ttlSeconds = 900): Promise<string[]> {
  const { eventId, seats } = await seedShow(count);
  const holdIds: string[] = [];

  for (const seat of seats) {
    const userId = await seedCustomer();
    const hold = await createHold({ eventId, userId, showSeatIds: [seat.id], ttlSeconds });
    holdIds.push(hold.holdId);
  }

  return holdIds;
}

async function pendingCount(holdIds: readonly string[]): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM hold_expiration_outbox
     WHERE hold_id = ANY($1::uuid[]) AND processed_at IS NULL`,
    [holdIds],
  );
  return Number(result.rows[0]!.count);
}

/** Waits until every listed hold's outbox row is processed. */
async function waitForDrain(holdIds: readonly string[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await pendingCount(holdIds)) === 0) {
      return;
    }
    await delay(100);
  }
  assert.fail(`${await pendingCount(holdIds)} outbox rows still pending after ${timeoutMs}ms`);
}

describe('SKIP LOCKED distributes outbox work', () => {
  it('gives two concurrent claimers disjoint rows without either waiting', async () => {
    const holdIds = await createHolds(6);

    // Two transactions claiming at the same time, exactly as two workers would.
    // With a plain FOR UPDATE the second would block behind the first; with
    // SKIP LOCKED it takes what is left.
    let releaseFirst: () => void = () => {};
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstClaim = withTransaction(async (client) => {
      const rows = await claimPendingOutboxRows(client, 3);
      // Hold the lock while the second claimer runs.
      await firstDone;
      return rows.map((row) => row.holdId);
    });

    await delay(150);

    const started = Date.now();
    // A short statement_timeout so this fails fast instead of hanging. Without
    // SKIP LOCKED the claim blocks on rows the first transaction holds, and the
    // first transaction is deliberately still open - so the wait would never
    // end, and a hung suite is a far worse failure signal than a red one.
    const secondClaim = await withTransaction(async (client) => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      try {
        const rows = await claimPendingOutboxRows(client, 3);
        return rows.map((row) => row.holdId);
      } catch (error) {
        releaseFirst();
        assert.fail(
          `the second claimer blocked instead of skipping locked rows: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
    const elapsed = Date.now() - started;

    releaseFirst();
    const firstIds = await firstClaim;

    assert.ok(elapsed < 1_000, `the second claimer must not block (waited ${elapsed}ms)`);
    assert.ok(firstIds.length > 0 && secondClaim.length > 0, 'both claimers got work');

    const overlap = firstIds.filter((id) => secondClaim.includes(id));
    assert.deepEqual(overlap, [], 'the two claimers must not receive the same row');

    // And between them they covered rows without duplication.
    assert.equal(new Set([...firstIds, ...secondClaim]).size, firstIds.length + secondClaim.length);
    assert.ok(holdIds.length >= firstIds.length + secondClaim.length);
  });
});

describe('two worker processes against one database', () => {
  it('drains a backlog exactly once, with no duplicate or lost work', async () => {
    const holdIds = await createHolds(12);
    assert.equal(await pendingCount(holdIds), 12);

    await startWorker('worker A');
    await startWorker('worker B');

    await waitForDrain(holdIds);

    // Every event published exactly once, and none abandoned.
    const rows = await query<{ hold_id: string; attempts: number; processed_at: Date }>(
      `SELECT hold_id, attempts, processed_at FROM hold_expiration_outbox
       WHERE hold_id = ANY($1::uuid[])`,
      [holdIds],
    );
    assert.equal(rows.rowCount, 12);
    assert.ok(rows.rows.every((row) => row.processed_at instanceof Date), 'all processed');
    assert.ok(
      rows.rows.every((row) => row.attempts === 0),
      'no retries were needed, so nothing was double-claimed into failure',
    );

    // And the signals really exist in Redis.
    for (const holdId of holdIds) {
      assert.equal(
        await getRedis().exists(holdExpiryKey(holdId)),
        1,
        `hold ${holdId} should have an expiration key`,
      );
    }

    // The holds themselves are untouched: publishing is not expiring.
    const statuses = await query<{ status: string }>(
      'SELECT DISTINCT status FROM reservation_holds WHERE id = ANY($1::uuid[])',
      [holdIds],
    );
    assert.deepEqual(statuses.rows.map((r) => r.status), ['active']);

    await stopWorkers();
  });

  it('expires due holds and releases seats, with both workers running', async () => {
    const { eventId, seats } = await seedShow(6);
    const holdIds: string[] = [];
    for (const seat of seats) {
      const userId = await seedCustomer();
      const hold = await createHold({ eventId, userId, showSeatIds: [seat.id], ttlSeconds: 1 });
      holdIds.push(hold.holdId);
    }

    await startWorker('worker A');
    await startWorker('worker B');

    // Wait for the sweep to catch up with the expiry.
    const deadline = Date.now() + 30_000;
    let expired = 0;
    while (Date.now() < deadline) {
      const result = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM reservation_holds
         WHERE id = ANY($1::uuid[]) AND status = 'expired'`,
        [holdIds],
      );
      expired = Number(result.rows[0]!.count);
      if (expired === holdIds.length) {
        break;
      }
      await delay(200);
    }

    assert.equal(expired, holdIds.length, 'every due hold is expired by the workers');

    const seatStates = await query<{ status: string }>(
      'SELECT DISTINCT status FROM show_seats WHERE id = ANY($1::uuid[])',
      [seats.map((seat) => seat.id)],
    );
    assert.deepEqual(seatStates.rows.map((r) => r.status), ['available'], 'all seats released');

    // No seat ended up claimed twice by racing workers.
    const doubleClaims = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM (
         SELECT rhs.show_seat_id
         FROM reservation_hold_seats rhs
         JOIN reservation_holds h ON h.id = rhs.hold_id
         WHERE h.status = 'active' AND h.expires_at > now()
         GROUP BY rhs.show_seat_id HAVING count(*) > 1
       ) t`,
    );
    assert.equal(doubleClaims.rows[0]!.count, '0');

    await stopWorkers();
  });
});

describe('worker crash', () => {
  it('loses no work when a worker is killed mid-flight', async () => {
    const holdIds = await createHolds(10);

    const victim = await startWorker('doomed worker');
    // SIGKILL, not SIGTERM: no shutdown handler runs, no chance to tidy up.
    // Any progress that survives must be in PostgreSQL, not process memory.
    victim.kill('SIGKILL');
    await new Promise<void>((resolve) => victim.once('exit', () => resolve()));
    assert.equal(victim.signalCode, 'SIGKILL');

    const stillPending = await pendingCount(holdIds);
    assert.ok(stillPending > 0, 'the crash left work behind, which is the point of the test');

    // A killed process holds no locks: PostgreSQL released them when the
    // connection died, so a fresh worker can claim the rows immediately.
    await startWorker('replacement worker');
    await waitForDrain(holdIds);

    const rows = await query<{ processed_at: Date | null }>(
      'SELECT processed_at FROM hold_expiration_outbox WHERE hold_id = ANY($1::uuid[])',
      [holdIds],
    );
    assert.ok(rows.rows.every((row) => row.processed_at instanceof Date));

    for (const holdId of holdIds) {
      assert.equal(await getRedis().exists(holdExpiryKey(holdId)), 1);
    }

    await stopWorkers();
  });

  it('shuts down cleanly on SIGTERM without abandoning claimed rows', async () => {
    const holdIds = await createHolds(8);

    const worker = await startWorker('graceful worker');
    await delay(400);
    await stopWorker(worker, 'SIGTERM');

    assert.equal(worker.exitCode, 0, 'a graceful shutdown exits zero');

    // Whatever was mid-transaction rolled back rather than being half-applied,
    // so a new worker finishes the job.
    await startWorker('successor');
    await waitForDrain(holdIds);

    assert.equal(await pendingCount(holdIds), 0);
    await stopWorkers();
  });
});

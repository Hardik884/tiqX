import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { closePool, query, withTransaction } from '../src/db/pool.js';
import { indexNames, isApplied, migrate, stepsToRollBack, tableExists } from './helpers/migrate.js';
import { cleanupSeedData, seedShow } from './helpers/seed.js';

const MIGRATION_NAME = '1787518800000_realtime-seat-status';

// Seeded once, not read from ambient state: on a genuinely fresh database
// with every other suite cleaning up strictly after itself (see
// `cleanupSeedData`), `show_seats` can be completely empty by the time this
// file runs. Relying on "some row already exists" only ever worked by
// accident, against a long-lived dev database carrying leftover debris.
let seatId: string;

before(async () => {
  const show = await seedShow(1);
  seatId = show.seats[0]!.id;
});

after(async () => {
  await cleanupSeedData();
  await closePool();
});

async function hasColumn(table: string, column: string): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return Number(result.rows[0]!.count) > 0;
}

async function triggerNames(table: string): Promise<string[]> {
  const result = await query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname`,
    [`public.${table}`],
  );
  return result.rows.map((row) => row.tgname);
}

describe('realtime seat status migration', () => {
  it('rolls back and re-applies against the current database', async () => {
    assert.ok(await isApplied(MIGRATION_NAME), 'run `npm run migrate:up` before the suite');
    assert.ok(await tableExists('seat_status_outbox'));
    assert.ok(await hasColumn('show_seats', 'seat_version'));
    assert.deepEqual(await triggerNames('show_seats'), [
      'show_seats_emit_status_event',
      'show_seats_set_updated_at',
    ]);

    const steps = await stepsToRollBack(MIGRATION_NAME);
    await migrate('down', steps);

    assert.equal(await tableExists('seat_status_outbox'), false);
    assert.equal(await hasColumn('show_seats', 'seat_version'), false);
    assert.deepEqual(await triggerNames('show_seats'), ['show_seats_set_updated_at']);

    for (const table of ['show_seats', 'events', 'reservation_holds', 'bookings', 'waitlist_offers']) {
      assert.ok(await tableExists(table), `${table} must survive the rollback`);
    }

    await migrate('up');

    assert.ok(await tableExists('seat_status_outbox'));
    assert.ok(await hasColumn('show_seats', 'seat_version'));
    assert.deepEqual(await indexNames('seat_status_outbox'), [
      'seat_status_outbox_event_id_idx',
      'seat_status_outbox_pending_idx',
      'seat_status_outbox_pkey',
    ]);
  });

  it('emits exactly one event per real status change, none for a no-op or an unrelated column', async () => {
    await withTransaction(async (client) => {
      await client.query(`UPDATE show_seats SET status = 'held' WHERE id = $1`, [seatId]);
      // A no-op re-set to the same status.
      await client.query(`UPDATE show_seats SET status = 'held' WHERE id = $1`, [seatId]);
      // A column that is not status.
      await client.query(`UPDATE show_seats SET price = price + 1 WHERE id = $1`, [seatId]);
      await client.query(`UPDATE show_seats SET status = 'available' WHERE id = $1`, [seatId]);

      const events = await client.query<{ seat_version: string; status: string; event_type: string }>(
        'SELECT seat_version, status, event_type FROM seat_status_outbox WHERE show_seat_id = $1 ORDER BY seat_version',
        [seatId],
      );
      assert.deepEqual(
        events.rows.map((row) => `${row.seat_version}:${row.status}:${row.event_type}`),
        ['1:held:SEAT_HELD', '2:available:SEAT_RELEASED'],
      );

      const seatRow = await client.query<{ seat_version: string }>(
        'SELECT seat_version FROM show_seats WHERE id = $1',
        [seatId],
      );
      assert.equal(seatRow.rows[0]!.seat_version, '2');

      throw new Error('rollback test fixture');
    }).catch((error: unknown) => {
      assert.match((error as Error).message, /rollback test fixture/);
    });
  });

  it('lets an invalid status still fail its own CHECK constraint, not the trigger', async () => {
    // Before this migration existed, this was the only failure this UPDATE
    // could produce. It must still be the only one: the trigger's mapping
    // has no ELSE case a bad status could fall into and corrupt instead.
    await withTransaction(async (client) => {
      await assert.rejects(
        client.query(`UPDATE show_seats SET status = 'reserved' WHERE id = $1`, [seatId]),
        /show_seats_status_check/,
      );
      throw new Error('rollback test fixture');
    }).catch((error: unknown) => {
      assert.match((error as Error).message, /rollback test fixture/);
    });
  });

  it('has an index that matches the outbox claim query', async () => {
    const plan = await withTransaction(async (client) => {
      await client.query('SET LOCAL enable_seqscan = off');
      const result = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) SELECT id FROM seat_status_outbox
         WHERE processed_at IS NULL AND available_at <= now()
         ORDER BY available_at LIMIT 200 FOR UPDATE SKIP LOCKED`,
      );
      return result.rows.map((row) => row['QUERY PLAN']).join('\n');
    });

    assert.match(plan, /seat_status_outbox_pending_idx/);
    assert.ok(!/Seq Scan/.test(plan), 'must not fall back to a sequential scan');
  });
});

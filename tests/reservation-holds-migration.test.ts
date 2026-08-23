import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { closePool, query } from '../src/db/pool.js';

const run = promisify(execFile);

const NEW_TABLES = ['reservation_holds', 'reservation_hold_seats'] as const;
// Objects created by earlier migrations: rolling this one back must not touch
// them.
const PRE_EXISTING_TABLES = ['users', 'venues', 'venue_seats', 'events', 'show_seats'] as const;

const MIGRATION_NAME = '1787482800000_reservation-holds';

async function tableExists(name: string): Promise<boolean> {
  const result = await query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`public.${name}`],
  );
  return result.rows[0]!.present;
}

async function migrationIsApplied(): Promise<boolean> {
  const result = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM pgmigrations WHERE name = $1',
    [MIGRATION_NAME],
  );
  return Number(result.rows[0]!.count) > 0;
}

/** Names of the indexes PostgreSQL reports for a table. */
async function indexNames(table: string): Promise<string[]> {
  const result = await query<{ indexname: string }>(
    'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname',
    ['public', table],
  );
  return result.rows.map((row) => row.indexname);
}

async function migrate(direction: 'up' | 'down'): Promise<void> {
  // Runs the same command a developer runs, against the same DATABASE_URL.
  await run('npm', ['run', `migrate:${direction}`], { cwd: process.cwd() });
}

after(async () => {
  await closePool();
});

describe('reservation holds migration', () => {
  it('rolls back and re-applies against the current database', async () => {
    // Start from the applied state the rest of the suite relies on.
    assert.ok(await migrationIsApplied(), 'run `npm run migrate:up` before the suite');
    for (const table of NEW_TABLES) {
      assert.ok(await tableExists(table), `${table} should exist before rollback`);
    }

    // --- down -----------------------------------------------------------
    await migrate('down');

    for (const table of NEW_TABLES) {
      assert.equal(await tableExists(table), false, `${table} should be dropped`);
    }
    assert.equal(await migrationIsApplied(), false);

    // The rollback is confined to this migration's own objects.
    for (const table of PRE_EXISTING_TABLES) {
      assert.ok(await tableExists(table), `${table} must survive the rollback`);
    }
    const sharedFunction = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_proc WHERE proname = 'set_updated_at'",
    );
    assert.equal(Number(sharedFunction.rows[0]!.count), 1, 'set_updated_at belongs to migration 1');

    // --- up -------------------------------------------------------------
    await migrate('up');

    for (const table of NEW_TABLES) {
      assert.ok(await tableExists(table), `${table} should be recreated`);
    }
    assert.ok(await migrationIsApplied());

    assert.deepEqual(await indexNames('reservation_holds'), [
      'reservation_holds_active_expires_at_idx',
      'reservation_holds_event_id_status_idx',
      'reservation_holds_pkey',
      'reservation_holds_user_id_status_idx',
    ]);
    assert.deepEqual(await indexNames('reservation_hold_seats'), [
      'reservation_hold_seats_pkey',
      'reservation_hold_seats_show_seat_id_idx',
    ]);

    const trigger = await query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_trigger
       WHERE tgrelid = 'public.reservation_holds'::regclass AND NOT tgisinternal`,
    );
    assert.equal(Number(trigger.rows[0]!.count), 1);
  });
});

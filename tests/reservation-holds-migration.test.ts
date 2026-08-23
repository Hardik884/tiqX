import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, query } from '../src/db/pool.js';
import {
  indexNames,
  isApplied,
  migrate,
  stepsToRollBack,
  tableExists,
  triggerCount,
} from './helpers/migrate.js';

const MIGRATION_NAME = '1787482800000_reservation-holds';

const NEW_TABLES = ['reservation_holds', 'reservation_hold_seats'] as const;
// Created by earlier migrations: rolling this one back must not touch them.
const PRE_EXISTING_TABLES = ['users', 'venues', 'venue_seats', 'events', 'show_seats'] as const;

after(async () => {
  await closePool();
});

describe('reservation holds migration', () => {
  it('rolls back and re-applies against the current database', async () => {
    assert.ok(await isApplied(MIGRATION_NAME), 'run `npm run migrate:up` before the suite');
    for (const table of NEW_TABLES) {
      assert.ok(await tableExists(table), `${table} should exist before rollback`);
    }

    // Roll back far enough to undo this migration, including anything applied
    // on top of it, then restore everything at the end.
    const steps = await stepsToRollBack(MIGRATION_NAME);
    assert.ok(steps >= 1);

    // --- down -----------------------------------------------------------
    await migrate('down', steps);

    for (const table of NEW_TABLES) {
      assert.equal(await tableExists(table), false, `${table} should be dropped`);
    }
    assert.equal(await isApplied(MIGRATION_NAME), false);

    // The rollback is confined to this migration and later ones.
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
    assert.ok(await isApplied(MIGRATION_NAME));

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
    assert.equal(await triggerCount('reservation_holds'), 1);
  });
});

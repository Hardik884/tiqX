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

const MIGRATION_NAME = '1787486400000_idempotency-keys';

const PRE_EXISTING_TABLES = [
  'users',
  'venues',
  'venue_seats',
  'events',
  'show_seats',
  'reservation_holds',
  'reservation_hold_seats',
] as const;

after(async () => {
  await closePool();
});

describe('idempotency keys migration', () => {
  it('rolls back and re-applies against the current database', async () => {
    assert.ok(await isApplied(MIGRATION_NAME), 'run `npm run migrate:up` before the suite');
    assert.ok(await tableExists('idempotency_keys'));

    const steps = await stepsToRollBack(MIGRATION_NAME);

    // --- down -----------------------------------------------------------
    await migrate('down', steps);

    assert.equal(await tableExists('idempotency_keys'), false, 'table should be dropped');
    assert.equal(await isApplied(MIGRATION_NAME), false);

    // Nothing outside this migration is disturbed.
    for (const table of PRE_EXISTING_TABLES) {
      assert.ok(await tableExists(table), `${table} must survive the rollback`);
    }
    const sharedFunction = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_proc WHERE proname = 'set_updated_at'",
    );
    assert.equal(Number(sharedFunction.rows[0]!.count), 1, 'set_updated_at belongs to migration 1');

    // --- up -------------------------------------------------------------
    await migrate('up');

    assert.ok(await tableExists('idempotency_keys'), 'table should be recreated');
    assert.ok(await isApplied(MIGRATION_NAME));

    // The unique constraint's index is the only one: no redundant index is
    // added for (user_id, key) or for user_id alone.
    assert.deepEqual(await indexNames('idempotency_keys'), [
      'idempotency_keys_pkey',
      'idempotency_keys_user_id_key_key',
    ]);
    assert.equal(await triggerCount('idempotency_keys'), 1);
  });

  it('enforces the documented constraints', async () => {
    const constraints = await query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'public.idempotency_keys'::regclass AND contype = 'c'
       ORDER BY conname`,
    );
    assert.deepEqual(
      constraints.rows.map((row) => row.conname),
      [
        'idempotency_keys_completed_has_response_check',
        'idempotency_keys_key_length_check',
        'idempotency_keys_key_not_blank_check',
        'idempotency_keys_status_check',
      ],
    );
  });
});

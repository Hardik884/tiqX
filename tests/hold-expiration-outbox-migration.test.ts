import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, withTransaction } from '../src/db/pool.js';
import { indexNames, isApplied, migrate, stepsToRollBack, tableExists } from './helpers/migrate.js';

const MIGRATION_NAME = '1787493600000_hold-expiration-outbox';

const PRE_EXISTING_TABLES = [
  'users',
  'venues',
  'venue_seats',
  'events',
  'show_seats',
  'reservation_holds',
  'reservation_hold_seats',
  'idempotency_keys',
  'refresh_tokens',
] as const;

after(async () => {
  await closePool();
});

describe('hold expiration outbox migration', () => {
  it('rolls back and re-applies against the current database', async () => {
    assert.ok(await isApplied(MIGRATION_NAME), 'run `npm run migrate:up` before the suite');
    assert.ok(await tableExists('hold_expiration_outbox'));

    // Count-aware, so adding a later migration does not break this test the way
    // it broke the first one written this way.
    const steps = await stepsToRollBack(MIGRATION_NAME);

    await migrate('down', steps);

    assert.equal(await tableExists('hold_expiration_outbox'), false);
    assert.equal(await isApplied(MIGRATION_NAME), false);
    for (const table of PRE_EXISTING_TABLES) {
      assert.ok(await tableExists(table), `${table} must survive the rollback`);
    }

    await migrate('up');

    assert.ok(await tableExists('hold_expiration_outbox'));
    assert.ok(await isApplied(MIGRATION_NAME));

    assert.deepEqual(await indexNames('hold_expiration_outbox'), [
      'hold_expiration_outbox_hold_id_key',
      'hold_expiration_outbox_pending_idx',
      'hold_expiration_outbox_pkey',
    ]);
  });

  it('adds no index to reservation_holds, because the existing one already fits', async () => {
    // The sweep and the reconciliation scan are both
    // "active holds ordered by expires_at", which is exactly the partial index
    // created with reservation_holds. A second index would have been redundant.
    const indexes = await indexNames('reservation_holds');
    assert.deepEqual(indexes, [
      'reservation_holds_active_expires_at_idx',
      'reservation_holds_event_id_status_idx',
      'reservation_holds_pkey',
      'reservation_holds_user_id_status_idx',
    ]);
  });

  it('has indexes that match the sweep and outbox-claim query shapes', async () => {
    // Asserting on the planner's unaided choice would prove nothing here: these
    // tables are near-empty in a test database, and a sequential scan really is
    // cheaper than an index for a handful of rows. What matters is that an
    // index *can* serve each query, so disable the sequential-scan option and
    // see what the planner reaches for instead.
    const plans = await withTransaction(async (client) => {
      await client.query('SET LOCAL enable_seqscan = off');

      const sweep = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) SELECT id FROM reservation_holds
         WHERE status = 'active' AND expires_at <= now() ORDER BY expires_at LIMIT 100`,
      );
      const claim = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) SELECT id FROM hold_expiration_outbox
         WHERE processed_at IS NULL AND available_at <= now() ORDER BY available_at LIMIT 100`,
      );

      return {
        sweep: sweep.rows.map((row) => row['QUERY PLAN']).join('\n'),
        claim: claim.rows.map((row) => row['QUERY PLAN']).join('\n'),
      };
    });

    assert.match(
      plans.sweep,
      /reservation_holds_active_expires_at_idx/,
      'the existing partial index covers the sweep, which is why none was added',
    );
    assert.match(
      plans.claim,
      /hold_expiration_outbox_pending_idx/,
      'the outbox claim is covered by its partial index',
    );
  });
});

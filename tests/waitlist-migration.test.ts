import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, query, withTransaction } from '../src/db/pool.js';
import { indexNames, isApplied, migrate, stepsToRollBack, tableExists } from './helpers/migrate.js';

const MIGRATION_NAME = '1787511600000_waitlist';

after(async () => {
  await closePool();
});

async function constraintDef(name: string): Promise<string> {
  const result = await query<{ def: string }>(
    'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1',
    [name],
  );
  return result.rows[0]?.def ?? '';
}

describe('waitlist migration', () => {
  it('rolls back and re-applies against the current database', async () => {
    assert.ok(await isApplied(MIGRATION_NAME), 'run `npm run migrate:up` before the suite');
    assert.ok(await tableExists('waitlist_entries'));
    assert.ok(await tableExists('waitlist_offers'));
    assert.ok(await tableExists('waitlist_allocation_outbox'));
    assert.ok(await tableExists('waitlist_notification_outbox'));

    const steps = await stepsToRollBack(MIGRATION_NAME);
    await migrate('down', steps);

    assert.equal(await tableExists('waitlist_entries'), false);
    assert.equal(await tableExists('waitlist_offers'), false);
    assert.equal(await tableExists('waitlist_allocation_outbox'), false);
    assert.equal(await tableExists('waitlist_notification_outbox'), false);

    // Nothing this migration did not create is touched.
    for (const table of ['events', 'show_seats', 'reservation_holds', 'bookings', 'booking_seats', 'tickets']) {
      assert.ok(await tableExists(table), `${table} must survive the rollback`);
    }

    await migrate('up');

    assert.ok(await tableExists('waitlist_entries'));
    assert.ok(await tableExists('waitlist_offers'));
    assert.ok(await tableExists('waitlist_allocation_outbox'));
    assert.ok(await tableExists('waitlist_notification_outbox'));

    assert.deepEqual(await indexNames('waitlist_entries'), [
      'waitlist_entries_active_membership_key',
      'waitlist_entries_pkey',
      'waitlist_entries_waiting_fifo_idx',
    ]);
    assert.deepEqual(await indexNames('waitlist_offers'), [
      'waitlist_offers_active_entry_key',
      'waitlist_offers_active_seat_key',
      'waitlist_offers_hold_id_key',
      'waitlist_offers_pkey',
    ]);
    assert.deepEqual(await indexNames('waitlist_allocation_outbox'), [
      'waitlist_allocation_outbox_pending_idx',
      'waitlist_allocation_outbox_pending_key',
      'waitlist_allocation_outbox_pkey',
    ]);
    assert.deepEqual(await indexNames('waitlist_notification_outbox'), [
      'waitlist_notification_outbox_offer_id_idx',
      'waitlist_notification_outbox_pkey',
    ]);
  });

  it('keeps waitlist entry statuses to exactly the five documented states', async () => {
    const def = await constraintDef('waitlist_entries_status_check');
    for (const status of ['waiting', 'offered', 'accepted', 'expired', 'cancelled']) {
      assert.match(def, new RegExp(`'${status}'`));
    }
    // No sixth state slipped in - a literal count of the alternatives.
    assert.equal((def.match(/'/g) ?? []).length, 10);
  });

  it('keeps waitlist offer statuses to exactly the three documented states', async () => {
    const def = await constraintDef('waitlist_offers_status_check');
    for (const status of ['offered', 'accepted', 'expired']) {
      assert.match(def, new RegExp(`'${status}'`));
    }
    assert.equal((def.match(/'/g) ?? []).length, 6);
  });

  it('enforces the accepted_at/expired_at consistency rules', async () => {
    const acceptedDef = await constraintDef('waitlist_offers_accepted_at_consistency_check');
    const expiredDef = await constraintDef('waitlist_offers_expired_at_consistency_check');
    assert.match(acceptedDef, /accepted_at/);
    assert.match(expiredDef, /expired_at/);
  });

  it('has indexes that match every query the waitlist paths run', async () => {
    // Same reasoning as booking-cancellation-migration.test.ts's own EXPLAIN
    // test: disable sequential scans so a near-empty test table cannot make an
    // index look unnecessary, and prove each query shape has one to use.
    const eventId = '00000000-0000-0000-0000-000000000001';
    const category = 'standard';
    const seatId = '00000000-0000-0000-0000-000000000002';
    const holdId = '00000000-0000-0000-0000-000000000003';

    const plans = await withTransaction(async (client) => {
      await client.query('SET LOCAL enable_seqscan = off');

      const explain = async (sql: string, params: unknown[] = []): Promise<string> => {
        const result = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
        return result.rows.map((row) => row['QUERY PLAN']).join('\n');
      };

      return {
        fifoCandidate: await explain(
          `SELECT * FROM waitlist_entries
           WHERE event_id = $1 AND seat_category = $2 AND status = 'waiting'
           ORDER BY joined_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
          [eventId, category],
        ),
        activeMembership: await explain(
          `SELECT 1 FROM waitlist_entries
           WHERE event_id = $1 AND user_id = $2 AND seat_category = $3
             AND status IN ('waiting', 'offered')`,
          [eventId, '00000000-0000-0000-0000-000000000004', category],
        ),
        activeOfferBySeat: await explain(
          `SELECT 1 FROM waitlist_offers WHERE show_seat_id = $1 AND status = 'offered'`,
          [seatId],
        ),
        offerByHold: await explain(`SELECT 1 FROM waitlist_offers WHERE hold_id = $1`, [holdId]),
        pendingAllocation: await explain(
          `SELECT id FROM waitlist_allocation_outbox
           WHERE processed_at IS NULL AND available_at <= now()
           ORDER BY available_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
        ),
      };
    });

    assert.match(plans.fifoCandidate, /waitlist_entries_waiting_fifo_idx/);
    assert.match(plans.activeMembership, /waitlist_entries_active_membership_key/);
    assert.match(plans.activeOfferBySeat, /waitlist_offers_active_seat_key/);
    assert.match(plans.offerByHold, /waitlist_offers_hold_id_key/);
    assert.match(plans.pendingAllocation, /waitlist_allocation_outbox_pending_idx/);

    for (const [name, plan] of Object.entries(plans)) {
      assert.ok(!/Seq Scan/.test(plan), `${name} must not fall back to a sequential scan`);
    }
  });
});

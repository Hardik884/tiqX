import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, query } from '../src/db/pool.js';
import { indexNames, isApplied, migrate, stepsToRollBack, tableExists } from './helpers/migrate.js';

const MIGRATION_NAME = '1787497200000_bookings';

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
  'hold_expiration_outbox',
] as const;

async function hasColumn(table: string, column: string): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return Number(result.rows[0]!.count) > 0;
}

after(async () => {
  await closePool();
});

describe('bookings migration', () => {
  it('rolls back and re-applies against the current database', async () => {
    assert.ok(await isApplied(MIGRATION_NAME), 'run `npm run migrate:up` before the suite');
    assert.ok(await tableExists('bookings'));
    assert.ok(await tableExists('booking_seats'));

    const steps = await stepsToRollBack(MIGRATION_NAME);

    await migrate('down', steps);

    assert.equal(await tableExists('bookings'), false);
    assert.equal(await tableExists('booking_seats'), false);
    // The columns this migration added to existing tables come back off too.
    assert.equal(await hasColumn('show_seats', 'price'), false, 'show_seats.price is dropped');
    assert.equal(await hasColumn('events', 'currency'), false, 'events.currency is dropped');

    for (const table of PRE_EXISTING_TABLES) {
      assert.ok(await tableExists(table), `${table} must survive the rollback`);
    }

    await migrate('up');

    assert.ok(await tableExists('bookings'));
    assert.ok(await tableExists('booking_seats'));
    assert.ok(await hasColumn('show_seats', 'price'));
    assert.ok(await hasColumn('events', 'currency'));

    assert.deepEqual(await indexNames('bookings'), [
      'bookings_booking_reference_key',
      'bookings_event_id_idx',
      'bookings_hold_id_key',
      'bookings_pkey',
      'bookings_user_id_idx',
    ]);
    assert.deepEqual(await indexNames('booking_seats'), [
      'booking_seats_booking_id_idx',
      'booking_seats_pkey',
      'booking_seats_show_seat_id_key',
    ]);
  });

  it('leaves the hold and seat state machines exactly as they were', async () => {
    // The schema already allowed 'converted' for a hold and 'booked' for a
    // seat, so this feature needed no change to either check constraint. If a
    // later migration widens them, this test says so.
    const holdCheck = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'reservation_holds_status_check'`,
    );
    assert.match(holdCheck.rows[0]!.def, /'active'/);
    assert.match(holdCheck.rows[0]!.def, /'expired'/);
    assert.match(holdCheck.rows[0]!.def, /'converted'/);
    assert.match(holdCheck.rows[0]!.def, /'cancelled'/);

    const seatCheck = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'show_seats_status_check'`,
    );
    assert.match(seatCheck.rows[0]!.def, /'available'/);
    assert.match(seatCheck.rows[0]!.def, /'held'/);
    assert.match(seatCheck.rows[0]!.def, /'booked'/);
  });

  it('stores money as NUMERIC, never a float', async () => {
    const columns = await query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name IN ('price', 'total_amount')
       ORDER BY table_name, column_name`,
    );

    assert.ok(columns.rowCount! >= 3, 'price and total columns exist');
    for (const column of columns.rows) {
      assert.equal(
        column.data_type,
        'numeric',
        `${column.table_name}.${column.column_name} must be NUMERIC, not a float type`,
      );
    }
  });
});

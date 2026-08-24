import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, query } from '../src/db/pool.js';
import { indexNames, isApplied, migrate, stepsToRollBack, tableExists } from './helpers/migrate.js';

const MIGRATION_NAME = '1787504400000_tickets';

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
  'bookings',
  'booking_seats',
] as const;

after(async () => {
  await closePool();
});

describe('tickets migration', () => {
  it('rolls back and re-applies against the current database', async () => {
    assert.ok(await isApplied(MIGRATION_NAME), 'run `npm run migrate:up` before the suite');
    assert.ok(await tableExists('tickets'));

    const steps = await stepsToRollBack(MIGRATION_NAME);
    await migrate('down', steps);

    assert.equal(await tableExists('tickets'), false);

    for (const table of PRE_EXISTING_TABLES) {
      assert.ok(await tableExists(table), `${table} must survive the rollback`);
    }

    await migrate('up');

    assert.ok(await tableExists('tickets'));
    assert.deepEqual(await indexNames('tickets'), [
      'tickets_booking_id_idx',
      'tickets_booking_seat_id_key',
      'tickets_pkey',
      'tickets_ticket_reference_key',
    ]);
  });

  it('enforces exactly one ticket per booking seat, in the database', async () => {
    const constraint = await query<{ contype: string }>(
      `SELECT contype FROM pg_constraint WHERE conname = 'tickets_booking_seat_id_key'`,
    );
    assert.equal(constraint.rows[0]?.contype, 'u', 'booking_seat_id is a unique constraint');
  });

  it('keeps status to issued, used or void - no invented states', async () => {
    const check = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'tickets_status_check'`,
    );
    assert.match(check.rows[0]!.def, /'issued'/);
    assert.match(check.rows[0]!.def, /'used'/);
    assert.match(check.rows[0]!.def, /'void'/);
  });

  it('requires used_at exactly when status is used', async () => {
    const check = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conname = 'tickets_used_at_consistency_check'`,
    );
    assert.match(check.rows[0]!.def, /used_at/);
  });

  it('restricts deletion of the booking and the booking seat it references', async () => {
    const fks = await query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'tickets'::regclass AND contype = 'f'
       ORDER BY conname`,
    );
    assert.ok(fks.rowCount! >= 2, 'tickets has foreign keys to bookings and booking_seats');
    for (const fk of fks.rows) {
      assert.equal(fk.confdeltype, 'r', `${fk.conname} must be ON DELETE RESTRICT`);
    }
  });

  it('leaves bookings and booking_seats exactly as they were', async () => {
    // This feature needed no change to either table's own schema - a ticket
    // hangs off booking_seats through a plain foreign key.
    assert.deepEqual(await indexNames('bookings'), [
      'bookings_booking_reference_key',
      'bookings_event_id_idx',
      'bookings_hold_id_key',
      'bookings_pkey',
      'bookings_user_id_idx',
    ]);
    assert.deepEqual(await indexNames('booking_seats'), [
      'booking_seats_booking_id_idx',
      'booking_seats_live_show_seat_key',
      'booking_seats_pkey',
      'booking_seats_show_seat_id_idx',
    ]);
  });
});

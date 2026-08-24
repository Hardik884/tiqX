import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, query, withTransaction } from '../src/db/pool.js';
import { indexNames, isApplied, migrate, stepsToRollBack } from './helpers/migrate.js';

const MIGRATION_NAME = '1787500800000_booking-cancellation';

after(async () => {
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

describe('booking cancellation migration', () => {
  it('rolls back and re-applies against the current database', async () => {
    assert.ok(await isApplied(MIGRATION_NAME), 'run `npm run migrate:up` before the suite');

    const steps = await stepsToRollBack(MIGRATION_NAME);
    await migrate('down', steps);

    assert.equal(await hasColumn('booking_seats', 'cancelled_at'), false);
    assert.deepEqual(await indexNames('booking_seats'), [
      'booking_seats_booking_id_idx',
      'booking_seats_pkey',
      'booking_seats_show_seat_id_key',
    ]);

    await migrate('up');

    assert.ok(await hasColumn('booking_seats', 'cancelled_at'));
    assert.deepEqual(await indexNames('booking_seats'), [
      'booking_seats_booking_id_idx',
      'booking_seats_live_show_seat_key',
      'booking_seats_pkey',
      'booking_seats_show_seat_id_idx',
    ]);
  });

  it('changes no state machine, because none of them needed changing', async () => {
    // The whole schema cost of cancellation is one nullable timestamp and the
    // index it exists for. Every status value this feature uses was already
    // allowed; if a later migration widens any of them, this test says so.
    const constraints = await query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname IN ('bookings_status_check', 'show_seats_status_check', 'reservation_holds_status_check')`,
    );
    const byName = Object.fromEntries(constraints.rows.map((row) => [row.conname, row.def]));

    assert.match(byName.bookings_status_check!, /'confirmed'/);
    assert.match(byName.bookings_status_check!, /'cancelled'/);
    assert.ok(!/'refunded'|'pending'/.test(byName.bookings_status_check!), 'still a two-state booking');

    assert.match(byName.show_seats_status_check!, /'available'/);
    assert.match(byName.show_seats_status_check!, /'booked'/);

    assert.match(byName.reservation_holds_status_check!, /'converted'/);
  });

  it('enforces one live booking per show seat, and allows the history behind it', async () => {
    const index = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'booking_seats_live_show_seat_key'`,
    );
    const definition = index.rows[0]!.indexdef;

    assert.match(definition, /UNIQUE/);
    assert.match(definition, /\(show_seat_id\)/);
    assert.match(definition, /WHERE \(cancelled_at IS NULL\)/, 'partial, so cancelled rows drop out');
  });

  it('keeps a plain index for the ON DELETE RESTRICT check', async () => {
    // The partial index cannot answer "does any row reference this seat?", and
    // that is exactly what PostgreSQL asks when a show_seats row is deleted.
    const index = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'booking_seats_show_seat_id_idx'`,
    );
    const definition = index.rows[0]!.indexdef;

    assert.match(definition, /\(show_seat_id\)/);
    assert.ok(!/UNIQUE/.test(definition), 'not unique - a seat may be sold, cancelled and resold');
    assert.ok(!/WHERE/.test(definition), 'and not partial, or it could not see cancelled rows');
  });

  it('has indexes that match every query the cancellation transaction runs', async () => {
    // The planner's unaided choice would prove nothing here: these tables are
    // near-empty in a test database and a sequential scan genuinely is cheaper
    // for a handful of rows. What matters is that an index *can* serve each
    // query shape, so turn the option off and see what it reaches for.
    const bookingId = '00000000-0000-0000-0000-000000000001';

    const plans = await withTransaction(async (client) => {
      await client.query('SET LOCAL enable_seqscan = off');

      const explain = async (sql: string, params: unknown[] = []): Promise<string> => {
        const result = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (COSTS OFF) ${sql}`,
          params,
        );
        return result.rows.map((row) => row['QUERY PLAN']).join('\n');
      };

      return {
        lockBooking: await explain(
          'SELECT user_id, event_id, status FROM bookings WHERE id = $1 FOR UPDATE',
          [bookingId],
        ),
        lockSeats: await explain(
          `SELECT ss.id, ss.status FROM show_seats ss
           WHERE ss.id IN (
             SELECT bs.show_seat_id FROM booking_seats bs
             WHERE bs.booking_id = $1 AND bs.cancelled_at IS NULL
           )
           ORDER BY ss.id FOR UPDATE`,
          [bookingId],
        ),
        retireSeatRows: await explain(
          `UPDATE booking_seats SET cancelled_at = now()
           WHERE booking_id = $1 AND cancelled_at IS NULL`,
          [bookingId],
        ),
        releaseSeats: await explain(
          `UPDATE show_seats SET status = 'available'
           WHERE id = ANY($1::uuid[]) AND status = 'booked'`,
          [[bookingId]],
        ),
        restrictCheck: await explain('SELECT 1 FROM booking_seats WHERE show_seat_id = $1', [
          bookingId,
        ]),
      };
    });

    assert.match(plans.lockBooking, /Index Scan using bookings_pkey/);
    // Either index answers "the live seats of this booking", and which one the
    // planner combines them into depends on the statistics of the moment. The
    // assertion that matters is the Seq Scan check below; this one only says an
    // index is reachable at all.
    const liveSeatsOfBooking = /booking_seats_(booking_id_idx|live_show_seat_key)/;
    assert.match(plans.lockSeats, liveSeatsOfBooking, 'the seats of a booking');
    assert.match(plans.lockSeats, /Index Scan using show_seats_pkey/, 'then each seat by id');
    assert.match(plans.retireSeatRows, liveSeatsOfBooking);
    assert.match(plans.releaseSeats, /Index Scan using show_seats_pkey/);
    assert.match(
      plans.restrictCheck,
      /booking_seats_show_seat_id_idx/,
      'the plain index is what keeps deleting a show seat from scanning every sale',
    );

    for (const [name, plan] of Object.entries(plans)) {
      assert.ok(!/Seq Scan/.test(plan), `${name} must not fall back to a sequential scan`);
    }
  });
});

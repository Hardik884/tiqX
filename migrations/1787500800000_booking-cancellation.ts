import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Makes a cancelled seat sellable again.
 *
 * Inspection first, and almost nothing turned out to be needed:
 *
 *   bookings.status        already allows 'cancelled'
 *   show_seats.status      already allows 'available'
 *   reservation_holds      untouched - the hold stays 'converted'; cancelling a
 *                          booking is not the same as restoring its hold
 *
 * One thing did block cancellation, and it was demonstrated rather than
 * assumed. `booking_seats_show_seat_id_key` made a show seat unique across
 * *every* booking, so once a seat had been sold it could never be sold again:
 *
 *   ERROR: duplicate key value violates unique constraint
 *          "booking_seats_show_seat_id_key"
 *
 * That constraint was right while cancellation did not exist - a sold seat
 * stayed sold - and is wrong the moment it does. The invariant it was reaching
 * for was never "one booking ever", it was "one *live* booking", and that is
 * what replaces it here.
 *
 * A partial unique index cannot read `bookings.status` from another table, so
 * the liveness has to be visible on the row itself. `cancelled_at` is the
 * smallest thing that does that: one nullable timestamp, written in the same
 * statement and the same transaction as the booking transition. It is not a
 * general audit column and not a cache to be refreshed - it exists so the
 * uniqueness rule can be expressed to PostgreSQL rather than merely intended by
 * the application.
 *
 * The alternative was to drop the constraint entirely and rely on row locks and
 * guarded updates, with `show_seats.status` as the only authority. That would
 * work, and the guards would still catch a double sale - but it would trade a
 * rule the database enforces for one the code has to keep remembering, and the
 * negative control from the previous task showed the constraint doing real work
 * when the locks were removed.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // NULL means "this seat is still sold under this booking". Set when the
  // booking is cancelled; never cleared, because a cancellation is final.
  pgm.addColumn('booking_seats', {
    cancelled_at: { type: 'timestamptz' },
  });

  pgm.dropConstraint('booking_seats', 'booking_seats_show_seat_id_key');

  // The replacement invariant: a show seat belongs to at most one *live*
  // booking. Cancelled rows drop out of the index and stay in the table, which
  // is what keeps the history intact while freeing the seat.
  pgm.createIndex('booking_seats', 'show_seat_id', {
    name: 'booking_seats_live_show_seat_key',
    unique: true,
    where: 'cancelled_at IS NULL',
  });

  // Not redundant with the index above, despite covering the same column. The
  // partial one deliberately excludes cancelled rows, so it cannot answer "does
  // any row reference this seat?" - which is exactly what PostgreSQL asks when
  // the ON DELETE RESTRICT on show_seat_id is checked. Without this, that check
  // degrades to a sequential scan of every booking seat ever written. It also
  // answers "what is this seat's booking history?".
  pgm.createIndex('booking_seats', 'show_seat_id', {
    name: 'booking_seats_show_seat_id_idx',
  });

  // No cancelled_at on `bookings`: status plus the existing updated_at trigger
  // already record that a booking was cancelled and when. The column here earns
  // its place only because an index needs it.
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Restoring the old constraint would fail if any seat had been sold twice -
  // which is possible only if cancellation has been used, i.e. exactly when
  // rolling this back is a bad idea. Left to fail loudly rather than silently
  // dropping the second booking's rows.
  pgm.dropIndex('booking_seats', 'show_seat_id', { name: 'booking_seats_show_seat_id_idx' });
  pgm.dropIndex('booking_seats', 'show_seat_id', { name: 'booking_seats_live_show_seat_key' });

  pgm.addConstraint('booking_seats', 'booking_seats_show_seat_id_key', {
    unique: ['show_seat_id'],
  });

  pgm.dropColumn('booking_seats', 'cancelled_at');
}

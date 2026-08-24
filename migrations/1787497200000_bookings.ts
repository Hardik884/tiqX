import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

const BOOKING_STATUSES = ['confirmed', 'cancelled'] as const;

/** Renders a value list for a CHECK constraint. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * Bookings: the durable result of confirming a hold.
 *
 * Two things this migration deliberately does NOT do, because inspecting the
 * schema first showed they were already there:
 *
 *   reservation_holds.status already allows 'converted' - so a confirmed hold
 *   uses that existing value rather than a new 'confirmed' one that would mean
 *   the same thing and split the vocabulary.
 *
 *   show_seats.status already allows 'booked'. The seat state machine needs no
 *   change at all.
 *
 * What was genuinely missing is money. There is no pricing anywhere in the
 * schema, so this adds the smallest thing that lets a booking record what was
 * actually charged - a price per inventory row - and nothing resembling a
 * pricing engine.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // ---------------------------------------------------------------------------
  // Pricing: the minimum needed to snapshot a booking
  // ---------------------------------------------------------------------------

  // One currency per event. Putting it here rather than per price row means two
  // seats of the same event cannot disagree about their currency, which no
  // amount of application care would otherwise prevent.
  pgm.addColumn('events', {
    currency: { type: 'text', notNull: true, default: 'INR' },
  });
  pgm.addConstraint('events', 'events_currency_check', {
    check: "currency ~ '^[A-Z]{3}$'",
  });

  // Price lives on show_seats - the per-event inventory row - because that is
  // exactly the grain price varies at: the same physical seat costs different
  // amounts at different events. It also means confirmation reads the price
  // from a row it has already locked, with no extra join.
  //
  // NUMERIC, never a float: 450.10 + 900.20 in binary floating point is not
  // 1350.30, and money that does not add up is not a rounding curiosity but a
  // reconciliation failure. Every monetary column here is NUMERIC(12,2) and
  // every sum is computed by PostgreSQL.
  //
  // Defaults to 0 so existing inventory stays valid; a free seat is a coherent
  // thing for a schema to allow, and the check keeps it non-negative.
  pgm.addColumn('show_seats', {
    price: { type: 'numeric(12,2)', notNull: true, default: 0 },
  });
  pgm.addConstraint('show_seats', 'show_seats_price_check', {
    check: 'price >= 0',
  });

  // ---------------------------------------------------------------------------
  // bookings
  // ---------------------------------------------------------------------------
  pgm.createTable('bookings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // Customer-facing identifier for support lookups. Random, not sequential:
    // a counter in a booking reference tells anyone who buys two tickets how
    // much you sold in between.
    booking_reference: { type: 'text', notNull: true },
    // RESTRICT, unlike the CASCADE used for holds and sessions. A booking is a
    // financial record; it must not disappear because a user row was deleted.
    // Deleting a customer with bookings should be a deliberate act that fails
    // loudly, not a silent cascade.
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'RESTRICT',
    },
    event_id: {
      type: 'uuid',
      notNull: true,
      references: 'events(id)',
      onDelete: 'RESTRICT',
    },
    // The hold this booking was converted from. RESTRICT for the same reason,
    // and UNIQUE below for a much stronger one.
    hold_id: {
      type: 'uuid',
      notNull: true,
      references: 'reservation_holds(id)',
      onDelete: 'RESTRICT',
    },
    status: { type: 'text', notNull: true, default: 'confirmed' },
    // The sum of this booking's seat prices, computed and written by
    // PostgreSQL. Never recomputed from current pricing afterwards.
    total_amount: { type: 'numeric(12,2)', notNull: true },
    currency: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // CHECK rather than an enum type, as everywhere else. Only two states: this
  // is a booking lifecycle, not a payment lifecycle, and payment states are
  // deliberately absent until there is a payment.
  pgm.addConstraint('bookings', 'bookings_status_check', {
    check: `status IN (${sqlList(BOOKING_STATUSES)})`,
  });
  pgm.addConstraint('bookings', 'bookings_total_amount_check', {
    check: 'total_amount >= 0',
  });
  pgm.addConstraint('bookings', 'bookings_currency_check', {
    check: "currency ~ '^[A-Z]{3}$'",
  });
  pgm.addConstraint('bookings', 'bookings_booking_reference_key', {
    unique: ['booking_reference'],
  });

  // ONE BOOKING PER HOLD, enforced by the database.
  //
  // This is the constraint that makes double-confirmation impossible rather
  // than merely unlikely. Row locks serialise two concurrent confirmations so
  // the second sees the hold already converted - but locks only help while the
  // code is correct. This index holds even if a future change forgets to check
  // the status: the second INSERT simply cannot happen.
  pgm.addConstraint('bookings', 'bookings_hold_id_key', {
    unique: ['hold_id'],
  });

  // Both foreign keys are RESTRICT, so PostgreSQL checks this table whenever a
  // user or event is deleted. Without these it would scan bookings each time.
  pgm.createIndex('bookings', 'user_id', { name: 'bookings_user_id_idx' });
  pgm.createIndex('bookings', 'event_id', { name: 'bookings_event_id_idx' });

  pgm.createTrigger('bookings', 'bookings_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  // ---------------------------------------------------------------------------
  // booking_seats
  // ---------------------------------------------------------------------------
  pgm.createTable('booking_seats', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    booking_id: {
      type: 'uuid',
      notNull: true,
      references: 'bookings(id)',
      onDelete: 'CASCADE',
    },
    // RESTRICT: an inventory row that has been sold must not be deletable out
    // from under the booking that sold it.
    show_seat_id: {
      type: 'uuid',
      notNull: true,
      references: 'show_seats(id)',
      onDelete: 'RESTRICT',
    },
    // The price snapshot. Copied from show_seats.price at confirmation and
    // never touched again, so repricing an event cannot retroactively change
    // what a customer was charged. A booking must always be able to explain
    // itself without reference to today's prices.
    price: { type: 'numeric(12,2)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('booking_seats', 'booking_seats_price_check', {
    check: 'price >= 0',
  });

  // THE CENTRAL INVARIANT: a show seat belongs to at most one booking.
  //
  // Not "at most one confirmed booking", which is what a partial unique index
  // would express - and cannot, because the status lives on `bookings` and a
  // partial index cannot reach another table. The stricter rule is the correct
  // one today: cancellation does not release seats, so a seat that has been
  // sold stays sold.
  //
  // This also subsumes the weaker UNIQUE (booking_id, show_seat_id): if a seat
  // can appear at most once across every booking, it certainly cannot appear
  // twice within one. A second index would only cost writes.
  //
  // When cancellation eventually releases seats, this becomes a partial unique
  // index over a denormalised status column, maintained by a trigger - a real
  // change, deliberately not made speculatively now.
  pgm.addConstraint('booking_seats', 'booking_seats_show_seat_id_key', {
    unique: ['show_seat_id'],
  });

  // "The seats of this booking" - the read path for rendering a booking - and
  // the index PostgreSQL uses to cascade a booking deletion.
  pgm.createIndex('booking_seats', 'booking_id', { name: 'booking_seats_booking_id_idx' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Child before parent, then the columns added to existing tables. Dropping a
  // table takes its constraints, indexes and trigger with it.
  pgm.dropTable('booking_seats');
  pgm.dropTable('bookings');

  pgm.dropConstraint('show_seats', 'show_seats_price_check');
  pgm.dropColumn('show_seats', 'price');

  pgm.dropConstraint('events', 'events_currency_check');
  pgm.dropColumn('events', 'currency');
}

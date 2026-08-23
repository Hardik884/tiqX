import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

const HOLD_STATUSES = ['active', 'expired', 'converted', 'cancelled'] as const;

/** Renders a value list for a CHECK constraint, e.g. `'active', 'expired'`. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * Temporary seat holds.
 *
 *   reservation_holds      one customer's temporary claim on seats of one event
 *   reservation_hold_seats which show_seats that claim covers
 *
 * This migration establishes the entities only. Status transitions, expiry
 * sweeping and the concurrency rules that decide who wins a contested seat are
 * the reservation service's job and are deliberately absent here:
 *
 *   - no hold_id / user_id column on show_seats
 *   - no partial unique index forbidding two active holds on one seat
 *   - no CHECK on expires_at against now()
 *
 * The last one matters: a CHECK is re-evaluated on write, never on read, so
 * `expires_at > now()` would not keep a row valid over time - it would only
 * make an untouched, naturally expired row impossible to update. Expiry is
 * domain logic reading a timestamp, not a storage constraint.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // ---------------------------------------------------------------------------
  // reservation_holds
  // ---------------------------------------------------------------------------
  pgm.createTable('reservation_holds', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // An event owns its holds: they describe that event's inventory and mean
    // nothing once it is gone. Cascading also keeps the hold-seat rows in step,
    // because show_seats cascades from events too.
    event_id: {
      type: 'uuid',
      notNull: true,
      references: 'events(id)',
      onDelete: 'CASCADE',
    },
    // A hold is a transient claim by one customer, not a financial record, so
    // it has no meaning without its owner and follows the user out. This is
    // deliberately unlike events.organiser_id (RESTRICT), which guards a
    // durable record that other people depend on. The booking that a hold
    // converts into will be its own entity and will make its own choice here.
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    status: { type: 'text', notNull: true, default: 'active' },
    // Timezone-aware like every other timestamp in the schema; the pool runs
    // each connection with timezone=UTC.
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // CHECK rather than a PostgreSQL enum type, matching users.role,
  // venue_seats.category, events.status and show_seats.status: a new status can
  // then be introduced in a plain migration instead of an ALTER TYPE.
  pgm.addConstraint('reservation_holds', 'reservation_holds_status_check', {
    check: `status IN (${sqlList(HOLD_STATUSES)})`,
  });

  // "My active holds" - the customer-facing read. user_id leads because it is
  // always an equality filter, and as the leading column it also lets
  // PostgreSQL find the rows to cascade when a user is deleted, so no separate
  // index on user_id alone is needed.
  pgm.createIndex('reservation_holds', ['user_id', 'status'], {
    name: 'reservation_holds_user_id_status_idx',
  });

  // "Holds on this event" - the organiser/inventory read, and likewise the
  // index PostgreSQL uses to cascade an event deletion.
  pgm.createIndex('reservation_holds', ['event_id', 'status'], {
    name: 'reservation_holds_event_id_status_idx',
  });

  // The expiry sweep: WHERE status = 'active' AND expires_at <= now().
  //
  // Partial, on the one status the sweep ever looks at. Holds are short-lived
  // but their rows are not: over time almost every row is expired, converted or
  // cancelled, and a plain index on expires_at would keep growing with rows the
  // sweep can never match. This one only ever holds the live working set, and a
  // row leaves it as soon as its status moves off 'active'.
  //
  // The predicate cannot mention now() - an index predicate must be immutable,
  // and one built against "now" would be wrong a second later. The time bound
  // stays in the query, which the ordered expires_at column answers as a range
  // scan from the left.
  pgm.createIndex('reservation_holds', 'expires_at', {
    name: 'reservation_holds_active_expires_at_idx',
    where: "status = 'active'",
  });

  pgm.createTrigger('reservation_holds', 'reservation_holds_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  // ---------------------------------------------------------------------------
  // reservation_hold_seats - which show seats one hold covers
  // ---------------------------------------------------------------------------
  //
  // A pure junction row: it carries no user_id, event_id or expires_at, because
  // all three belong to the hold and are reachable through hold_id. Duplicating
  // them here would create a second copy of the truth that could drift.
  //
  // It has no updated_at either: an association is created and destroyed, never
  // amended, so it needs no set_updated_at trigger.
  pgm.createTable('reservation_hold_seats', {
    // The association is part of the hold and dies with it.
    hold_id: {
      type: 'uuid',
      notNull: true,
      references: 'reservation_holds(id)',
      onDelete: 'CASCADE',
    },
    // The FK itself is what forbids pointing at a show seat that does not
    // exist. ON DELETE is CASCADE rather than the RESTRICT used by
    // show_seats.venue_seat_id, and that difference is forced rather than
    // casual: deleting an event cascades down two paths at once - to its
    // show_seats and to its reservation_holds. Under RESTRICT (and equally
    // under NO ACTION) the show_seats leg is checked before the holds leg has
    // cleared the junction, and deleting an event fails outright with
    // "still referenced from table reservation_hold_seats". CASCADE keeps
    // event deletion working, and a junction row genuinely has no meaning once
    // either of its two parents is gone.
    show_seat_id: {
      type: 'uuid',
      notNull: true,
      references: 'show_seats(id)',
      onDelete: 'CASCADE',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // One row per (hold, seat): this is what rejects a seat listed twice in the
  // same hold. The same show seat may still appear in any number of *other*
  // holds - past holds keep their seat lists, and preventing overlap between
  // concurrent active holds is the reservation service's job, not this table's.
  // The backing index is also the read path "which seats does this hold cover?",
  // so no further index on hold_id is added.
  pgm.addConstraint('reservation_hold_seats', 'reservation_hold_seats_pkey', {
    primaryKey: ['hold_id', 'show_seat_id'],
  });

  // show_seat_id is the trailing column of the primary key, so that index
  // cannot answer lookups by seat alone. PostgreSQL needs this one to cascade a
  // show_seat deletion without scanning the table, and it answers the question
  // the reservation service will ask constantly: "is this seat in any hold?".
  pgm.createIndex('reservation_hold_seats', 'show_seat_id', {
    name: 'reservation_hold_seats_show_seat_id_idx',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Child before parent, so the foreign key goes before its target. Dropping a
  // table takes its constraints, indexes and trigger with it. Nothing outside
  // these two tables is touched: the shared set_updated_at() function and every
  // earlier table belong to previous migrations and stay in place.
  pgm.dropTable('reservation_hold_seats');
  pgm.dropTable('reservation_holds');
}

import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

const SHOW_SEAT_STATUSES = ['available', 'held', 'booked'] as const;

/** Renders a value list for a CHECK constraint, e.g. `'available', 'held'`. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * show_seats is the per-event inventory state of a physical seat.
 *
 *   venue_seats = the physical seat that exists in a venue
 *   show_seats  = that seat's state for one specific event
 *
 * Holds and bookings are deliberately NOT modelled here; they will become
 * their own entities (reservation_holds, bookings) in a later migration.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('show_seats', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // An event owns its inventory: deleting the event removes its show seats,
    // so inventory rows can never be orphaned.
    event_id: {
      type: 'uuid',
      notNull: true,
      references: 'events(id)',
      onDelete: 'CASCADE',
    },
    // A physical seat may not be removed while any event's inventory still
    // refers to it; that would silently invalidate a published seat map.
    venue_seat_id: {
      type: 'uuid',
      notNull: true,
      references: 'venue_seats(id)',
      onDelete: 'RESTRICT',
    },
    status: { type: 'text', notNull: true, default: 'available' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('show_seats', 'show_seats_status_check', {
    check: `status IN (${sqlList(SHOW_SEAT_STATUSES)})`,
  });

  // The critical invariant: one inventory row per physical seat per event.
  // The same venue_seat may still appear under many different events.
  // Its backing index is also the primary read path ("all seats for an event"
  // and "one specific seat of an event"), so no further index is added on
  // (event_id) or (event_id, venue_seat_id).
  pgm.addConstraint('show_seats', 'show_seats_event_id_venue_seat_id_key', {
    unique: ['event_id', 'venue_seat_id'],
  });

  // venue_seat_id is the trailing column of the unique index, so that index
  // cannot serve lookups by seat alone. PostgreSQL needs this one to check the
  // ON DELETE RESTRICT rule without scanning the whole table, and it answers
  // "which events still use this seat?".
  pgm.createIndex('show_seats', 'venue_seat_id', { name: 'show_seats_venue_seat_id_idx' });

  // Seat maps are read per event and filtered by state ("how many seats are
  // still available for this event?"). Leading with event_id keeps it useful
  // for that filter while staying narrow.
  pgm.createIndex('show_seats', ['event_id', 'status'], {
    name: 'show_seats_event_id_status_idx',
  });

  pgm.createTrigger('show_seats', 'show_seats_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  // Backfill inventory for events that already exist, so no event is left
  // without a seat map. Existing rows in events/venue_seats are only read.
  // ON CONFLICT keeps the statement safe to re-run.
  pgm.sql(`
    INSERT INTO show_seats (event_id, venue_seat_id, status)
    SELECT e.id, vs.id, 'available'
    FROM events e
    JOIN venue_seats vs ON vs.venue_id = e.venue_id
    ON CONFLICT (event_id, venue_seat_id) DO NOTHING;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Dropping the table also drops its constraints, indexes and trigger.
  // The shared set_updated_at() function belongs to the initial migration and
  // is intentionally left in place. No rows outside show_seats are touched.
  pgm.dropTable('show_seats');
}

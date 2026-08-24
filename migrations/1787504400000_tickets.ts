import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

const TICKET_STATUSES = ['issued', 'used', 'void'] as const;

/** Renders a value list for a CHECK constraint, e.g. `'issued', 'used'`. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * tickets: the entry credential a confirmed booking earns, one per seat.
 *
 * Inspection first, as with every migration in this schema. `bookings` and
 * `booking_seats` already carry everything ticketing needs to attach to -
 * a confirmed sale, snapshotted per seat, with `cancelled_at` already telling
 * a live seat from a historical one. Nothing there needed to change.
 *
 * `booking_seats` is what a ticket belongs to, not `bookings` directly. A
 * booking is the sale; a ticket is one seat's entry credential, and a
 * multi-seat booking earns one of each. Reaching a ticket's booking still
 * takes one join away, through `booking_seat_id`, exactly like `booking_seats`
 * already reaches its booking through `booking_id`.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('tickets', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // RESTRICT, like every other financial/historical reference in this
    // schema: a ticket is proof a seat was sold, and must not disappear
    // because someone deleted the booking or the seat row it was cut from.
    booking_id: {
      type: 'uuid',
      notNull: true,
      references: 'bookings(id)',
      onDelete: 'RESTRICT',
    },
    booking_seat_id: {
      type: 'uuid',
      notNull: true,
      references: 'booking_seats(id)',
      onDelete: 'RESTRICT',
    },
    // Public, high-entropy, unguessable - see ticket.repository.ts. Never the
    // row's own id: a UUID primary key is an internal handle, and this is the
    // credential a QR code and a support call are allowed to carry.
    ticket_reference: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'issued' },
    issued_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // NULL until used; never cleared afterwards - see the consistency check
    // below.
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('tickets', 'tickets_status_check', {
    check: `status IN (${sqlList(TICKET_STATUSES)})`,
  });

  // used_at is present exactly when the ticket is used - not more, not less.
  // A row that somehow carries `used_at` while `void` or `issued`, or claims
  // to be `used` with no timestamp, is a bug the database refuses to store
  // rather than one an application check might forget to make.
  pgm.addConstraint('tickets', 'tickets_used_at_consistency_check', {
    check: `(status = 'used') = (used_at IS NOT NULL)`,
  });

  // Public reference: a support agent or a door scanner looks a ticket up by
  // this, never by its UUID.
  pgm.addConstraint('tickets', 'tickets_ticket_reference_key', {
    unique: ['ticket_reference'],
  });

  // THE CENTRAL INVARIANT: exactly one ticket per booking seat.
  //
  // Unqualified, unlike `booking_seats`' own seat constraint - there is no
  // cancel-and-resell lifecycle for a ticket to make partial. A booking seat
  // row is created once and never deleted; at most one ticket is ever cut for
  // it, for as long as it exists. The database enforces this itself, so
  // issuing tickets twice for the same seat cannot happen even if the
  // application's own "have I already issued these?" check is ever wrong.
  pgm.addConstraint('tickets', 'tickets_booking_seat_id_key', {
    unique: ['booking_seat_id'],
  });

  // "The tickets of this booking" - the read path for issuance, verification
  // and any future retrieval - and what PostgreSQL uses to check the
  // ON DELETE RESTRICT on booking_id without scanning the whole table. Not
  // redundant with the unique index above: that one leads with
  // booking_seat_id and cannot serve a lookup by booking_id.
  pgm.createIndex('tickets', 'booking_id', { name: 'tickets_booking_id_idx' });

  pgm.createTrigger('tickets', 'tickets_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Dropping the table takes its constraints, indexes and trigger with it.
  pgm.dropTable('tickets');
}

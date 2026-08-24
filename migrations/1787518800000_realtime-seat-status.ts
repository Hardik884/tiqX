import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

const SEAT_STATUSES = ['available', 'held', 'booked'] as const;
const EVENT_TYPES = ['SEAT_HELD', 'SEAT_RELEASED', 'SEAT_BOOKED'] as const;

/** Renders a value list for a CHECK constraint, e.g. `'available', 'held'`. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * Real-time seat status: a monotonic per-seat version, and a durable outbox
 * of every status transition for a WebSocket layer to fan out.
 *
 * INSPECTION FIRST. Four statements change `show_seats.status` today -
 * `markSeatsHeld`, `releaseSeatsWithoutLiveHold`, `markSeatsBooked`,
 * `releaseBookedSeats` - reached from six call sites across reservation
 * creation, lapsed-hold reclamation, hold expiration, waitlist offer
 * creation/expiry, booking confirmation, waitlist offer acceptance, and
 * booking cancellation. Instrumenting each call site individually would mean
 * editing four different repository files, and - worse - silently stops
 * working the next time a new path is added that forgets to call the outbox
 * function. A trigger on `show_seats` itself covers all four statements, all
 * six call sites, and every future one, with no application code changed at
 * all.
 *
 * WHY A TRIGGER, NOT APPLICATION CODE, LIKE THE OTHER TWO OUTBOXES.
 * `hold_expiration_outbox` and `waitlist_allocation_outbox` are populated by
 * explicit INSERTs at the one or two places that produce their signal - that
 * reads fine because there really are only one or two producers each. This
 * table has six, all doing the same mechanical thing (record what the status
 * just became), which is exactly the shape a trigger is for: encode the rule
 * once, where the data changes, instead of copying an outbox INSERT into
 * every UPDATE statement.
 *
 * The trigger is also what makes "every seat-state change creates its event
 * in the same transaction" true *by construction* rather than by every
 * caller remembering to do so: a trigger fires inside its statement's own
 * transaction, so a ROLLBACK undoes the outbox row exactly as it undoes the
 * status change.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // ---------------------------------------------------------------------------
  // show_seats.seat_version
  // ---------------------------------------------------------------------------
  // Monotonic per seat, bumped only when status actually changes (never for,
  // say, a price update). This is what lets a client tell a stale or
  // out-of-order WebSocket message from a current one: compare the version in
  // the message to the version it already has for that seat, and discard
  // anything not strictly greater.
  pgm.addColumn('show_seats', {
    seat_version: { type: 'bigint', notNull: true, default: 0 },
  });

  // ---------------------------------------------------------------------------
  // seat_status_outbox
  // ---------------------------------------------------------------------------
  pgm.createTable('seat_status_outbox', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    event_id: {
      type: 'uuid',
      notNull: true,
      references: 'events(id)',
      onDelete: 'CASCADE',
    },
    show_seat_id: {
      type: 'uuid',
      notNull: true,
      references: 'show_seats(id)',
      onDelete: 'CASCADE',
    },
    // The seat's new status, and the WebSocket event type it maps to -
    // computed once, by the trigger, at the moment of change. Carrying both
    // means the worker and every subscriber never re-derive the mapping.
    status: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    seat_version: { type: 'bigint', notNull: true },
    // When PostgreSQL made the change, not when the worker gets to it.
    occurred_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    available_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    processed_at: { type: 'timestamptz' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('seat_status_outbox', 'seat_status_outbox_status_check', {
    check: `status IN (${sqlList(SEAT_STATUSES)})`,
  });
  pgm.addConstraint('seat_status_outbox', 'seat_status_outbox_event_type_check', {
    check: `event_type IN (${sqlList(EVENT_TYPES)})`,
  });
  pgm.addConstraint('seat_status_outbox', 'seat_status_outbox_attempts_check', {
    check: 'attempts >= 0',
  });

  // NO coalescing index here, deliberately unlike waitlist_allocation_outbox.
  // That table merges repeat signals because they mean the same thing ("go
  // look at this category again"); every row here is a distinct, individually
  // meaningful transition a subscriber must see, so held-then-booked-then-
  // available for one seat is three rows, not one.
  //
  // The claim query, identical in shape to every other outbox in this schema:
  // WHERE processed_at IS NULL AND available_at <= now()
  // ORDER BY available_at FOR UPDATE SKIP LOCKED
  pgm.createIndex('seat_status_outbox', 'available_at', {
    name: 'seat_status_outbox_pending_idx',
    where: 'processed_at IS NULL',
  });

  // "Every event for this show" - the read path a future replay/debug tool
  // would use, and never needed for the claim query above, which is global.
  pgm.createIndex('seat_status_outbox', 'event_id', {
    name: 'seat_status_outbox_event_id_idx',
  });

  // ---------------------------------------------------------------------------
  // the trigger
  // ---------------------------------------------------------------------------
  pgm.createFunction(
    'emit_seat_status_event',
    [],
    { returns: 'trigger', language: 'plpgsql', replace: true },
    `
    DECLARE
      v_event_type text;
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        v_event_type := CASE NEW.status
          WHEN 'held' THEN 'SEAT_HELD'
          WHEN 'booked' THEN 'SEAT_BOOKED'
          WHEN 'available' THEN 'SEAT_RELEASED'
          ELSE NULL
        END;

        -- An unrecognised status has no event to emit. Leaving NEW alone and
        -- falling through to RETURN NEW is deliberate: this trigger runs
        -- BEFORE the row's own CHECK constraint is evaluated, so a status
        -- this CASE does not know about is exactly the value
        -- show_seats_status_check exists to reject - that is the error an
        -- invalid status should produce, not a NOT NULL violation on this
        -- table's event_type column from a half-built outbox row.
        IF v_event_type IS NOT NULL THEN
          NEW.seat_version = OLD.seat_version + 1;

          INSERT INTO seat_status_outbox (event_id, show_seat_id, status, event_type, seat_version)
          VALUES (NEW.event_id, NEW.id, NEW.status, v_event_type, NEW.seat_version);
        END IF;
      END IF;

      RETURN NEW;
    END;
    `,
  );

  // BEFORE, not AFTER: the function both rewrites NEW.seat_version (only
  // possible before the row is written) and inserts the outbox row in the
  // same pass, rather than needing a second trigger to do each half.
  pgm.createTrigger('show_seats', 'show_seats_emit_status_event', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'emit_seat_status_event',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger('show_seats', 'show_seats_emit_status_event');
  pgm.dropFunction('emit_seat_status_event', []);
  pgm.dropTable('seat_status_outbox');
  pgm.dropColumn('show_seats', 'seat_version');
}

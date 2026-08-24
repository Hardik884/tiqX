import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * The transactional outbox for ticket delivery email.
 *
 * Not the same table as `hold_expiration_outbox`, deliberately: that table's
 * shape is specific to publishing a Redis signal for one hold (`hold_id`,
 * `expires_at` snapshotted for a TTL) and has no room for a booking. What is
 * genuinely reused is the *mechanism* - claim with `FOR UPDATE SKIP LOCKED`,
 * mark processed, or back off and retry - which this table is built to serve
 * exactly the same way; see ticket-email.repository.ts.
 *
 * `booking_id`, not `ticket_id`: a booking with several seats gets one email
 * listing every ticket, not one email per ticket. Booking confirmation writes
 * one row here, in the same transaction that creates the booking's tickets,
 * so an email is requested if and only if tickets exist to describe.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('ticket_email_outbox', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // The event describes one booking's tickets and is meaningless without it.
    booking_id: {
      type: 'uuid',
      notNull: true,
      references: 'bookings(id)',
      onDelete: 'CASCADE',
    },
    // When this row may next be attempted. Retries push it forward instead of
    // spinning - a failing row yields to healthy ones rather than blocking the
    // batch. Same field, same purpose, as hold_expiration_outbox.available_at.
    available_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    processed_at: { type: 'timestamptz' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    // Message text only. Never the Resend API key, which this never sees
    // anyway - see ticket-email.service.ts.
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('ticket_email_outbox', 'ticket_email_outbox_attempts_check', {
    check: 'attempts >= 0',
  });

  // One email request per booking. Makes the insert naturally idempotent: a
  // booking confirmed exactly once (already guaranteed by
  // `bookings_hold_id_key`) can request its email exactly once, and a
  // defensive re-run of ticket issuance finds this row already present rather
  // than queuing a second email. The backing index also answers "has this
  // booking's email been requested?" and is what PostgreSQL uses to cascade a
  // booking deletion, which does not happen today but costs nothing to keep
  // correct.
  pgm.addConstraint('ticket_email_outbox', 'ticket_email_outbox_booking_id_key', {
    unique: ['booking_id'],
  });

  // The claim query, identical in shape to hold_expiration_outbox's:
  //
  //   WHERE processed_at IS NULL AND available_at <= now()
  //   ORDER BY available_at
  //   FOR UPDATE SKIP LOCKED
  //
  // Partial on unprocessed rows for the same reason: processed rows accumulate
  // forever and can never be claimed again, so indexing them would only grow
  // an index the worker never reads.
  pgm.createIndex('ticket_email_outbox', 'available_at', {
    name: 'ticket_email_outbox_pending_idx',
    where: 'processed_at IS NULL',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Dropping the table takes its constraints and indexes with it. Nothing
  // outside this table is touched.
  pgm.dropTable('ticket_email_outbox');
}

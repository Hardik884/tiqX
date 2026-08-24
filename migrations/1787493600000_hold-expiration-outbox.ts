import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * The transactional outbox for hold expiration.
 *
 * PostgreSQL and Redis cannot share a transaction, so "create the hold, then
 * tell Redis" has a window in which the commit succeeds and the Redis write
 * does not. Rather than pretend that window can be closed, the intent to
 * publish is written *into the same transaction as the hold*. The hold and its
 * expiration event therefore commit together or not at all, and a worker
 * publishes to Redis afterwards, retrying until it succeeds.
 *
 * This buys durability, not exactly-once delivery. A row may be published more
 * than once - the worker can set the Redis key and die before recording that it
 * did - which is fine because setting the key is idempotent, as is the
 * PostgreSQL expiry transition it eventually leads to.
 *
 * No index is added to `reservation_holds` here. The partial index created with
 * that table, `(expires_at) WHERE status = 'active'`, already answers both
 * queries this feature needs - the sweep for holds that are due, and the
 * reconciliation scan for active holds expiring soon - so adding another would
 * duplicate an existing one.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('hold_expiration_outbox', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // The event describes one hold and is meaningless without it.
    hold_id: {
      type: 'uuid',
      notNull: true,
      references: 'reservation_holds(id)',
      onDelete: 'CASCADE',
    },
    // Copied from the hold at insert time, inside the same transaction, so the
    // publisher can derive a Redis TTL without re-reading the hold. It is a
    // snapshot of an authoritative value, never a substitute for it.
    expires_at: { type: 'timestamptz', notNull: true },
    // When this row may next be attempted. Retries push it forward instead of
    // spinning: a failing row yields to healthy ones rather than blocking the
    // batch.
    available_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    processed_at: { type: 'timestamptz' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    // Message text only. Never a Redis URL, which can carry a password.
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('hold_expiration_outbox', 'hold_expiration_outbox_attempts_check', {
    check: 'attempts >= 0',
  });

  // One event per hold. Makes the insert naturally idempotent, and means a
  // retried hold creation cannot queue the same expiration twice. The backing
  // index also answers "has this hold been published?" and is what PostgreSQL
  // uses to cascade a hold deletion.
  pgm.addConstraint('hold_expiration_outbox', 'hold_expiration_outbox_hold_id_key', {
    unique: ['hold_id'],
  });

  // The claim query, and the only hot path on this table:
  //
  //   WHERE processed_at IS NULL AND available_at <= now()
  //   ORDER BY available_at
  //   FOR UPDATE SKIP LOCKED
  //
  // Partial on unprocessed rows because processed ones accumulate forever and
  // can never be claimed again - without the predicate the index would grow
  // with rows the worker will never look at, which is the same reasoning behind
  // the partial index on active holds.
  pgm.createIndex('hold_expiration_outbox', 'available_at', {
    name: 'hold_expiration_outbox_pending_idx',
    where: 'processed_at IS NULL',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Dropping the table takes its constraints and indexes with it. Nothing
  // outside this table is touched: reservation_holds and its indexes belong to
  // an earlier migration.
  pgm.dropTable('hold_expiration_outbox');
}

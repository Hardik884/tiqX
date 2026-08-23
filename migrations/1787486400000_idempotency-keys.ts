import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

const IDEMPOTENCY_STATUSES = ['processing', 'completed'] as const;

/** Matches the header validation in the idempotency module. */
const MAX_KEY_LENGTH = 255;

/** Renders a value list for a CHECK constraint, e.g. `'processing', 'completed'`. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * idempotency_keys makes a retried write safe to repeat.
 *
 * A row is claimed at the start of the operation it protects and finished in
 * the same transaction, so the stored response and the work it describes become
 * visible together or not at all. The unique index on (user_id, key) is the
 * synchronisation primitive: a second request carrying the same key blocks on
 * it until the first transaction ends, then either replays the committed
 * response or, if that transaction rolled back, takes the key over itself.
 * PostgreSQL is therefore the only coordinator, which keeps this correct across
 * however many API processes are running.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('idempotency_keys', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // A key belongs to the customer that issued it, and dies with them.
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    key: { type: 'text', notNull: true },
    // SHA-256 of the request's meaningful fields, so the same key cannot be
    // reused for a materially different request.
    request_hash: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'processing' },
    response_status: { type: 'integer' },
    response_body: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // CHECK rather than a PostgreSQL enum type, as everywhere else in this schema.
  pgm.addConstraint('idempotency_keys', 'idempotency_keys_status_check', {
    check: `status IN (${sqlList(IDEMPOTENCY_STATUSES)})`,
  });

  pgm.addConstraint('idempotency_keys', 'idempotency_keys_key_not_blank_check', {
    check: 'char_length(btrim(key)) > 0',
  });
  pgm.addConstraint('idempotency_keys', 'idempotency_keys_key_length_check', {
    check: `char_length(key) <= ${MAX_KEY_LENGTH}`,
  });

  // A finished record must actually carry the response it promises to replay.
  // Without this a bug could leave a `completed` row that replays nothing.
  pgm.addConstraint('idempotency_keys', 'idempotency_keys_completed_has_response_check', {
    check: `status <> 'completed' OR (response_status IS NOT NULL AND response_body IS NOT NULL)`,
  });

  // The heart of the mechanism. Scoped to the user on purpose: two customers
  // may pick the same key string without colliding, and one customer's key can
  // never reach another's stored response.
  pgm.addConstraint('idempotency_keys', 'idempotency_keys_user_id_key_key', {
    unique: ['user_id', 'key'],
  });

  // No further index is added. The unique constraint's index answers the only
  // lookup this table has - (user_id, key) - and, with user_id leading, it is
  // also what PostgreSQL uses to cascade a user deletion.

  pgm.createTrigger('idempotency_keys', 'idempotency_keys_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Dropping the table takes its constraints, indexes and trigger with it. The
  // shared set_updated_at() function belongs to the first migration and stays.
  pgm.dropTable('idempotency_keys');
}

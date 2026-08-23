import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Durable server-side state for refresh tokens.
 *
 * The `users` table is deliberately untouched by this migration. It already
 * carries everything authentication needs - `password_hash`, a `role` column
 * checked against customer/organiser/admin, and the case-insensitive
 * `users_email_lower_key` unique index - so adding credential columns would
 * have duplicated what exists.
 *
 * Only a digest of each token is stored, never the token itself: reading this
 * table must not hand an attacker a usable credential. Rotation keeps the row
 * and marks it revoked rather than deleting it, so a replayed token is
 * recognisable as revoked instead of merely absent.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('refresh_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // Sessions belong to their user and end with the account.
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    // SHA-256 of the raw token. Deterministic, so it can be looked up directly;
    // the raw value has 256 bits of entropy, so it needs no slow KDF the way a
    // human-chosen password does.
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    // NULL means live. Set on rotation, on logout, and when reuse is detected.
    revoked_at: { type: 'timestamptz' },
    // The token this one replaced, giving each session a traceable chain.
    // SET NULL rather than CASCADE: pruning an old row must never silently
    // delete the live token that succeeded it.
    rotated_from: {
      type: 'uuid',
      references: 'refresh_tokens(id)',
      onDelete: 'SET NULL',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // The lookup path: the server hashes the presented token and finds it here.
  // Unique because two sessions must never collide on one digest.
  pgm.addConstraint('refresh_tokens', 'refresh_tokens_token_hash_key', {
    unique: ['token_hash'],
  });

  // "Every session for this user", used to revoke a user's tokens on reuse
  // detection, and the index PostgreSQL needs to cascade a user deletion.
  pgm.createIndex('refresh_tokens', 'user_id', { name: 'refresh_tokens_user_id_idx' });

  // Needed so the self-referencing SET NULL does not scan the table, and to
  // walk a rotation chain forwards.
  pgm.createIndex('refresh_tokens', 'rotated_from', {
    name: 'refresh_tokens_rotated_from_idx',
  });

  // No updated_at and no trigger here, unlike the other tables: a refresh token
  // is written once and then only revoked, and `revoked_at` already records
  // when that happened.
  //
  // No IP or user-agent columns either. They were considered and left out: they
  // are personal data that nothing in this system reads, and the cheapest way
  // to keep them safe is not to collect them.
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Dropping the table takes its constraints and indexes, including the
  // self-referencing foreign key, with it. No earlier table is touched.
  pgm.dropTable('refresh_tokens');
}

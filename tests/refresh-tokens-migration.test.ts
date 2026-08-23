import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, query } from '../src/db/pool.js';
import { indexNames, isApplied, migrate, stepsToRollBack, tableExists } from './helpers/migrate.js';

const MIGRATION_NAME = '1787490000000_refresh-tokens';

const PRE_EXISTING_TABLES = [
  'users',
  'venues',
  'venue_seats',
  'events',
  'show_seats',
  'reservation_holds',
  'reservation_hold_seats',
  'idempotency_keys',
] as const;

after(async () => {
  await closePool();
});

describe('refresh tokens migration', () => {
  it('rolls back and re-applies against the current database', async () => {
    assert.ok(await isApplied(MIGRATION_NAME), 'run `npm run migrate:up` before the suite');
    assert.ok(await tableExists('refresh_tokens'));

    const steps = await stepsToRollBack(MIGRATION_NAME);

    await migrate('down', steps);

    assert.equal(await tableExists('refresh_tokens'), false);
    assert.equal(await isApplied(MIGRATION_NAME), false);
    for (const table of PRE_EXISTING_TABLES) {
      assert.ok(await tableExists(table), `${table} must survive the rollback`);
    }

    await migrate('up');

    assert.ok(await tableExists('refresh_tokens'));
    assert.ok(await isApplied(MIGRATION_NAME));

    assert.deepEqual(await indexNames('refresh_tokens'), [
      'refresh_tokens_pkey',
      'refresh_tokens_rotated_from_idx',
      'refresh_tokens_token_hash_key',
      'refresh_tokens_user_id_idx',
    ]);
  });

  it('leaves users untouched: this migration adds no credential columns', async () => {
    // The task allowed extending `users`; it was not necessary, because
    // password_hash, role and the case-insensitive email index already existed.
    const columns = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'
       ORDER BY column_name`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ['created_at', 'email', 'id', 'name', 'password_hash', 'role', 'updated_at'],
    );
  });

  it('stores no raw token material: token_hash is a sha256 hex digest', async () => {
    const rows = await query<{ token_hash: string }>('SELECT token_hash FROM refresh_tokens LIMIT 50');
    for (const row of rows.rows) {
      assert.match(row.token_hash, /^[0-9a-f]{64}$/, 'token_hash must be a sha256 hex digest');
    }
  });
});

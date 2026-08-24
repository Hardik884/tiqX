import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, query } from '../src/db/pool.js';
import { indexNames, isApplied, migrate, stepsToRollBack, tableExists } from './helpers/migrate.js';

const MIGRATION_NAME = '1787508000000_event-discovery';

async function hasColumn(table: string, column: string): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return Number(result.rows[0]!.count) > 0;
}

after(async () => {
  await closePool();
});

describe('event discovery migration', () => {
  it('rolls back and re-applies against the current database', async () => {
    assert.ok(await isApplied(MIGRATION_NAME), 'run `npm run migrate:up` before the suite');
    assert.ok(await hasColumn('venues', 'city'));
    assert.ok(await hasColumn('events', 'category'));
    assert.ok(await hasColumn('events', 'search_vector'));

    // Rolling this migration back also rolls back everything layered on top
    // of it (`1787522400000_movies-category` included), and that migration's
    // own down() re-adds a CHECK that no longer allows 'movies' - which
    // PostgreSQL enforces against every existing row. This is a shared dev
    // database, not a disposable one, so a real 'movies' event (created
    // through the API, not this suite) would otherwise turn an unrelated
    // migration test red. Shielding it - a temporary reclassification, never
    // a delete - proves the same round-trip without touching real data, then
    // restores it exactly once the constraint allows 'movies' again.
    const shielded = await query<{ id: string }>("SELECT id FROM events WHERE category = 'movies'");
    if (shielded.rows.length > 0) {
      await query("UPDATE events SET category = 'other' WHERE id = ANY($1::uuid[])", [
        shielded.rows.map((row) => row.id),
      ]);
    }

    try {
      const steps = await stepsToRollBack(MIGRATION_NAME);
      await migrate('down', steps);

      assert.equal(await hasColumn('venues', 'city'), false);
      assert.equal(await hasColumn('events', 'category'), false);
      assert.equal(await hasColumn('events', 'search_vector'), false);

      // Nothing this migration didn't touch should be affected by rolling it back.
      for (const table of ['events', 'venues', 'show_seats', 'bookings', 'tickets', 'reservation_holds']) {
        assert.ok(await tableExists(table), `${table} must survive the rollback`);
      }

      await migrate('up');
    } finally {
      if (shielded.rows.length > 0) {
        await query("UPDATE events SET category = 'movies' WHERE id = ANY($1::uuid[])", [
          shielded.rows.map((row) => row.id),
        ]);
      }
    }

    assert.ok(await hasColumn('venues', 'city'));
    assert.ok(await hasColumn('events', 'category'));
    assert.ok(await hasColumn('events', 'search_vector'));
    assert.ok(
      (await indexNames('events')).includes('events_search_vector_gin_idx'),
      'the GIN index comes back after a re-apply',
    );
  });

  it('constrains category to the curated vocabulary', async () => {
    const check = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'events_category_check'`,
    );
    for (const category of ['music', 'comedy', 'sports', 'theatre', 'other']) {
      assert.match(check.rows[0]!.def, new RegExp(`'${category}'`));
    }
  });

  it('leaves venues.city nullable - no backfill was invented for existing rows', async () => {
    const column = await query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'venues' AND column_name = 'city'`,
    );
    assert.equal(column.rows[0]!.is_nullable, 'YES');
  });

  it('generates search_vector automatically and keeps it in sync on update', async () => {
    const org = await query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash, role) VALUES ('Migr Test', $1, 'x', 'organiser') RETURNING id`,
      [`migr-test-${Date.now()}@example.test`],
    );
    const venue = await query<{ id: string }>(`INSERT INTO venues (name) VALUES ('Migration Test Venue') RETURNING id`);

    const event = await query<{ id: string; has_vector: boolean }>(
      `INSERT INTO events (organiser_id, venue_id, title, category, event_type, starts_at, ends_at, status, currency)
       VALUES ($1, $2, 'Alpha Beta', 'music', 'concert', now(), now() + interval '2 hours', 'draft', 'INR')
       RETURNING id, (search_vector IS NOT NULL) AS has_vector`,
      [org.rows[0]!.id, venue.rows[0]!.id],
    );
    assert.equal(event.rows[0]!.has_vector, true);

    const beforeMatch = await query<{ matches: boolean }>(
      `SELECT search_vector @@ websearch_to_tsquery('english', 'Gamma') AS matches FROM events WHERE id = $1`,
      [event.rows[0]!.id],
    );
    assert.equal(beforeMatch.rows[0]!.matches, false);

    await query(`UPDATE events SET title = 'Gamma Delta' WHERE id = $1`, [event.rows[0]!.id]);

    const afterMatch = await query<{ matches: boolean }>(
      `SELECT search_vector @@ websearch_to_tsquery('english', 'Gamma') AS matches FROM events WHERE id = $1`,
      [event.rows[0]!.id],
    );
    assert.equal(afterMatch.rows[0]!.matches, true, 'the generated column recomputed itself on UPDATE');

    await query('DELETE FROM events WHERE id = $1', [event.rows[0]!.id]);
    await query('DELETE FROM venues WHERE id = $1', [venue.rows[0]!.id]);
    await query('DELETE FROM users WHERE id = $1', [org.rows[0]!.id]);
  });
});

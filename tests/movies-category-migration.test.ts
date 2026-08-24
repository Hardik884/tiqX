import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, query } from '../src/db/pool.js';
import { isApplied, migrate, stepsToRollBack } from './helpers/migrate.js';
import { cleanupSeedData, seedOrganiser, seedVenue } from './helpers/seed.js';

const MIGRATION_NAME = '1787522400000_movies-category';

async function categoryConstraintDef(): Promise<string> {
  const result = await query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'events_category_check'`,
  );
  return result.rows[0]!.def;
}

after(async () => {
  await cleanupSeedData();
  await closePool();
});

describe('movies category migration', () => {
  it('rolls back and re-applies against the current database', async () => {
    assert.ok(await isApplied(MIGRATION_NAME), 'run `npm run migrate:up` before the suite');
    assert.match(await categoryConstraintDef(), /'movies'/);

    // The down migration re-adds a CHECK that no longer allows 'movies', and
    // PostgreSQL enforces a re-added CHECK against every existing row - so
    // rolling back on a database that already has real 'movies' events (this
    // is a shared dev database, not a disposable one) would fail with a
    // constraint violation that has nothing to do with the migration's SQL
    // being wrong. Shielding those rows - temporarily reclassifying them,
    // never deleting them - proves the same round-trip without touching real
    // data, then restores it exactly once the constraint allows 'movies'
    // again.
    const shielded = await query<{ id: string }>("SELECT id FROM events WHERE category = 'movies'");
    if (shielded.rows.length > 0) {
      await query(
        "UPDATE events SET category = 'other' WHERE id = ANY($1::uuid[])",
        [shielded.rows.map((row) => row.id)],
      );
    }

    try {
      const steps = await stepsToRollBack(MIGRATION_NAME);
      await migrate('down', steps);

      assert.doesNotMatch(await categoryConstraintDef(), /'movies'/);
      for (const category of ['music', 'comedy', 'sports', 'theatre', 'other']) {
        assert.match(await categoryConstraintDef(), new RegExp(`'${category}'`));
      }

      await migrate('up');

      assert.match(await categoryConstraintDef(), /'movies'/);
    } finally {
      if (shielded.rows.length > 0) {
        await query(
          "UPDATE events SET category = 'movies' WHERE id = ANY($1::uuid[])",
          [shielded.rows.map((row) => row.id)],
        );
      }
    }
  });

  it('accepts movies as an event category and rejects anything outside the vocabulary', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(1);

    const inserted = await query<{ id: string }>(
      `INSERT INTO events (organiser_id, venue_id, title, event_type, starts_at, ends_at, category)
       VALUES ($1, $2, 'Movies Category Probe', 'movie', now(), now() + interval '1 hour', 'movies')
       RETURNING id`,
      [organiserId, venueId],
    );
    assert.ok(inserted.rows[0]);
    await query('DELETE FROM events WHERE id = $1', [inserted.rows[0]!.id]);

    await assert.rejects(
      query(
        `INSERT INTO events (organiser_id, venue_id, title, event_type, starts_at, ends_at, category)
         VALUES ($1, $2, 'Bad Category Probe', 'movie', now(), now() + interval '1 hour', 'not-a-real-category')`,
        [organiserId, venueId],
      ),
      /events_category_check/,
    );
  });
});

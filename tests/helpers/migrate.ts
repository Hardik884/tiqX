import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { query } from '../../src/db/pool.js';

const run = promisify(execFile);

/**
 * Drives the same migration commands a developer runs, against the same
 * DATABASE_URL.
 *
 * `steps` matters: `down` rolls back the most recent migrations, so a test that
 * wants to undo *its own* migration has to roll back everything applied after
 * it too. Hard-coding 1 quietly breaks the moment another migration is added on
 * top - which is exactly what happened once already - so callers derive the
 * count from the database with {@link stepsToRollBack}.
 */
export async function migrate(direction: 'up' | 'down', steps?: number): Promise<void> {
  // `npm` on Windows is `npm.cmd`, which `execFile` cannot exec directly
  // without a shell - it fails with ENOENT despite npm being on PATH.
  // `shell: true` resolves it the same way a developer's terminal would, on
  // every platform this suite runs on. `steps` is a number this module
  // produced, never external input, so building one command string carries
  // none of the injection risk `shell: true` would otherwise add.
  const command = `npm run migrate:${direction}${steps === undefined ? '' : ` -- ${steps}`}`;
  await run(command, [], { cwd: process.cwd(), shell: true });
}

/** How many applied migrations must be rolled back to undo `migrationName`. */
export async function stepsToRollBack(migrationName: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM pgmigrations
     WHERE name >= $1`,
    [migrationName],
  );
  return Number(result.rows[0]!.count);
}

export async function isApplied(migrationName: string): Promise<boolean> {
  const result = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM pgmigrations WHERE name = $1',
    [migrationName],
  );
  return Number(result.rows[0]!.count) > 0;
}

export async function tableExists(name: string): Promise<boolean> {
  const result = await query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`public.${name}`],
  );
  return result.rows[0]!.present;
}

/** Names of the indexes PostgreSQL reports for a table, sorted. */
export async function indexNames(table: string): Promise<string[]> {
  const result = await query<{ indexname: string }>(
    'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname',
    ['public', table],
  );
  return result.rows.map((row) => row.indexname);
}

/** Number of non-internal triggers on a table. */
export async function triggerCount(table: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM pg_trigger
     WHERE tgrelid = $1::regclass AND NOT tgisinternal`,
    [`public.${table}`],
  );
  return Number(result.rows[0]!.count);
}

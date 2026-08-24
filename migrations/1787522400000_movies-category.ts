import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

const EVENT_CATEGORIES = ['music', 'comedy', 'sports', 'theatre', 'movies', 'other'] as const;
const PREVIOUS_EVENT_CATEGORIES = ['music', 'comedy', 'sports', 'theatre', 'other'] as const;

/** Renders a value list for a CHECK constraint, e.g. `'music', 'comedy'`. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * Adds `movies` to `events.category`'s vocabulary.
 *
 * `event_type` already distinguishes 'movie' from 'concert' as the medium,
 * but `category` (added by `1787508000000_event-discovery`) is the browse
 * genre, and had no film-specific value in it at all - every screening was
 * only ever filed under 'other'. This is the same kind of small, curated
 * addition to that vocabulary the original migration made, not a schema
 * redesign: one CHECK constraint dropped and re-added with one more value.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('events', 'events_category_check');
  pgm.addConstraint('events', 'events_category_check', {
    check: `category IN (${sqlList(EVENT_CATEGORIES)})`,
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('events', 'events_category_check');
  pgm.addConstraint('events', 'events_category_check', {
    check: `category IN (${sqlList(PREVIOUS_EVENT_CATEGORIES)})`,
  });
}

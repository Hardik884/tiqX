import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

const EVENT_CATEGORIES = ['music', 'comedy', 'sports', 'theatre', 'other'] as const;

/** Renders a value list for a CHECK constraint, e.g. `'music', 'comedy'`. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * Adds what public event search genuinely lacked, and nothing it did not.
 *
 * Inspection first, as always, and most of what search needs already existed:
 *
 *   events_status_starts_at_idx    already answers "published, ordered by
 *                                   start time" - exactly query shape #1 of
 *                                   the discovery feed.
 *   events_venue_id_idx            already answers "events at this venue".
 *   show_seats_event_id_status_idx already answers the availability
 *                                   aggregate ("available seats per event").
 *
 * Two real gaps, and one deliberate technology choice:
 *
 *   venues had no `city`           - "filter by city" cannot be built on a
 *                                     column that does not exist.
 *   events had no `category`       - `event_type` ('movie'/'concert') is the
 *                                     medium, not the genre a browse filter
 *                                     like "music" or "comedy" needs. This is
 *                                     a new, small, curated vocabulary - a
 *                                     product decision made for this task,
 *                                     documented in the final report rather
 *                                     than assumed.
 *   full-text search                - see the `search_vector` column below.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // ---------------------------------------------------------------------------
  // venues.city
  // ---------------------------------------------------------------------------
  // Nullable, not backfilled: existing venues (and the ones the test suite has
  // been seeding all along) were never asked for a city, and inventing one
  // would be fabricating data. A venue with no recorded city simply never
  // matches a `city` filter - the correct behaviour for "unknown", not an
  // error.
  pgm.addColumn('venues', {
    city: { type: 'text' },
  });

  // ---------------------------------------------------------------------------
  // events.category
  // ---------------------------------------------------------------------------
  // NOT NULL with a default, like every other classification column in this
  // schema (`users.role`, `events.status`): existing rows must land somewhere
  // sensible, and 'other' is that sensible somewhere rather than NULL, which
  // would need its own case in every filter and CHECK.
  pgm.addColumn('events', {
    category: { type: 'text', notNull: true, default: 'other' },
  });
  pgm.addConstraint('events', 'events_category_check', {
    check: `category IN (${sqlList(EVENT_CATEGORIES)})`,
  });

  // "Published, filtered by category" is the same query shape
  // `events_status_starts_at_idx` already serves for the unfiltered case;
  // whether category additionally needs its own index is an EXPLAIN question
  // against realistic volume, not an assumption - see the final report.

  // ---------------------------------------------------------------------------
  // events.search_vector - PostgreSQL full-text search, not ILIKE
  // ---------------------------------------------------------------------------
  // ILIKE '%term%' cannot use a standard btree index (a leading wildcard rules
  // one out) and does no tokenisation at all: "concert night" would not match
  // a description containing "night concert", plural/singular forms would not
  // match each other, and every request against a large table is a sequential
  // scan by construction. `pg_trgm` would fix the indexability of substring
  // matching, but it still doesn't tokenise or rank - it is the right tool for
  // fuzzy/typo-tolerant matching or autocomplete, not for "search a listing by
  // name and description" the way a customer expects a search box to behave.
  //
  // PostgreSQL's built-in text search gives tokenisation, English stemming,
  // stop-word removal and `websearch_to_tsquery`'s familiar query syntax
  // (quoted phrases, OR, -exclusion) for free, is fully indexable with GIN,
  // and needs no extension - it is core PostgreSQL. That is the deciding
  // factor for tiqX: the workload is a handful of short text fields on a
  // table sized in the thousands to low millions, not a corpus that needs a
  // dedicated search engine, and "PostgreSQL remains the source of truth" is
  // an explicit constraint here, not just the path of least resistance.
  //
  // A GENERATED ALWAYS ... STORED column, not a trigger: PostgreSQL maintains
  // it automatically on every INSERT/UPDATE of the columns it depends on, so
  // there is no separate trigger function to write, forget to attach, or drift
  // from the columns it derives from.
  //
  // `title` outweighs `category`, which outweighs `description` (weights A/B/C):
  // a title match is a stronger signal than a description mention. Venue name
  // deliberately is NOT folded in here - see event.repository.ts for why
  // venue-name matching is handled as a separate, plain condition instead of
  // denormalised into this vector.
  pgm.sql(`
    ALTER TABLE events
    ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(description, '')), 'C')
    ) STORED
  `);

  // GIN is the only sane index type for a tsvector - it is the structure
  // `@@` needs to avoid a sequential scan, and there is no query shape here a
  // GiST index would serve better.
  pgm.createIndex('events', 'search_vector', {
    name: 'events_search_vector_gin_idx',
    method: 'gin',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('events', 'search_vector', { name: 'events_search_vector_gin_idx' });
  pgm.sql('ALTER TABLE events DROP COLUMN search_vector');
  pgm.dropConstraint('events', 'events_category_check');
  pgm.dropColumn('events', 'category');
  pgm.dropColumn('venues', 'city');
}

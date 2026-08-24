import type { Queryable } from '../../db/pool.js';
import type { VenueSummary } from './venue.types.js';

interface IdRow {
  id: string;
}

export async function venueExists(db: Queryable, venueId: string): Promise<boolean> {
  const result = await db.query<IdRow>('SELECT id FROM venues WHERE id = $1', [venueId]);
  return result.rowCount === 1;
}

/**
 * Every venue with its physical seat count - what the organiser create/edit
 * event form needs to let someone pick a venue and see, before they commit,
 * whether it actually has seats configured. Read-only: this codebase has no
 * venue creation API, so this is the entire venues surface.
 */
export async function listVenues(db: Queryable): Promise<VenueSummary[]> {
  const result = await db.query<{
    id: string;
    name: string;
    description: string | null;
    city: string | null;
    seat_count: string;
  }>(
    `SELECT v.id, v.name, v.description, v.city, count(vs.id)::text AS seat_count
     FROM venues v
     LEFT JOIN venue_seats vs ON vs.venue_id = v.id
     GROUP BY v.id
     ORDER BY v.name ASC`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    city: row.city,
    seatCount: Number(row.seat_count),
  }));
}

/**
 * Ids of every physical seat in a venue, ordered by seat map position so
 * derived inventory is created in a predictable order.
 */
export async function listVenueSeatIds(db: Queryable, venueId: string): Promise<string[]> {
  const result = await db.query<IdRow>(
    'SELECT id FROM venue_seats WHERE venue_id = $1 ORDER BY row_label, seat_number',
    [venueId],
  );
  return result.rows.map((row) => row.id);
}

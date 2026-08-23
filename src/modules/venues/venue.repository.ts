import type { Queryable } from '../../db/pool.js';

interface IdRow {
  id: string;
}

export async function venueExists(db: Queryable, venueId: string): Promise<boolean> {
  const result = await db.query<IdRow>('SELECT id FROM venues WHERE id = $1', [venueId]);
  return result.rowCount === 1;
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

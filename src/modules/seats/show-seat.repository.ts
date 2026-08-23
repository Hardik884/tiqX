import type { Queryable } from '../../db/pool.js';

/**
 * Creates the initial inventory row for each given physical seat.
 *
 * A single INSERT ... SELECT over an array parameter keeps this to one
 * round trip whatever the venue's size, and every row lands in the caller's
 * transaction. Status is left to the column default (`available`).
 *
 * Returns the number of inventory rows created.
 */
export async function createShowSeatsForEvent(
  db: Queryable,
  eventId: string,
  venueSeatIds: readonly string[],
): Promise<number> {
  if (venueSeatIds.length === 0) {
    return 0;
  }

  const result = await db.query(
    `INSERT INTO show_seats (event_id, venue_seat_id)
     SELECT $1, venue_seat_id
     FROM unnest($2::uuid[]) AS venue_seat_id`,
    [eventId, venueSeatIds],
  );

  return result.rowCount ?? 0;
}

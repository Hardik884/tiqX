import type { Queryable } from '../../db/pool.js';
import type { SeatPricing } from '../events/event.types.js';

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
  pricing: SeatPricing = {},
): Promise<number> {
  if (venueSeatIds.length === 0) {
    return 0;
  }

  // The price is resolved per row from the physical seat's category, in SQL.
  // The decimal strings are cast to NUMERIC by PostgreSQL and never touched by
  // JavaScript arithmetic. An unpriced category falls back to the column
  // default of 0.
  const result = await db.query(
    `INSERT INTO show_seats (event_id, venue_seat_id, price)
     SELECT $1,
            vs.id,
            CASE vs.category
              WHEN 'standard' THEN COALESCE($3::numeric, 0)
              WHEN 'premium'  THEN COALESCE($4::numeric, 0)
              ELSE 0
            END
     FROM venue_seats vs
     WHERE vs.id = ANY($2::uuid[])`,
    [eventId, venueSeatIds, pricing.standard ?? null, pricing.premium ?? null],
  );

  return result.rowCount ?? 0;
}

import type { Queryable } from '../../db/pool.js';
import type { PublicSeatMapEntry, SeatPricing } from '../events/event.types.js';

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

/**
 * The public seat map for one event: every seat's row/number/price/status,
 * ordered the way a seat picker renders a map.
 *
 * Deliberately narrow. `show_seats` and `reservation_holds` together know
 * exactly who holds a seat and until when, but none of that is public: a
 * `status` of `held` is all a customer ever needs to know, never whose hold
 * it is or when it expires. This query does not join `reservation_holds` or
 * `bookings` at all, so there is no column here that *could* leak a hold id,
 * a hold owner or a booking - the omission is structural, not a filter that
 * could be forgotten.
 */
export async function findPublicSeatMap(db: Queryable, eventId: string): Promise<PublicSeatMapEntry[]> {
  const result = await db.query<{
    id: string;
    row_label: string;
    seat_number: number;
    price: string;
    status: 'available' | 'held' | 'booked';
  }>(
    `SELECT ss.id, vs.row_label, vs.seat_number, ss.price::text AS price, ss.status
     FROM show_seats ss
     JOIN venue_seats vs ON vs.id = ss.venue_seat_id
     WHERE ss.event_id = $1
     ORDER BY vs.row_label, vs.seat_number`,
    [eventId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    price: row.price,
    status: row.status,
  }));
}

import type { Queryable } from '../../db/pool.js';
import type {
  CreateVenueInput,
  SeatCategory,
  SeatRowInput,
  UpdateVenueInput,
  VenueDetail,
  VenueSeat,
  VenueSummary,
} from './venue.types.js';

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

/**
 * Everything the admin venue-detail view shows about one venue: the summary
 * fields, the seat totals split by category, and how many events have already
 * derived their inventory from this layout.
 *
 * The event count is what makes an edit's blast radius visible in the UI:
 * `show_seats` is derived once, when an event is created (see
 * event.service.ts::createEvent), so seats added to a venue afterwards never
 * appear in an existing event's map. That is the existing behaviour and is
 * left exactly as it is; this number is what lets the interface say so.
 */
export async function findVenueDetail(db: Queryable, venueId: string): Promise<VenueDetail | null> {
  const result = await db.query<{
    id: string;
    name: string;
    description: string | null;
    city: string | null;
    seat_count: string;
    standard_count: string;
    premium_count: string;
    event_count: string;
  }>(
    `SELECT v.id,
            v.name,
            v.description,
            v.city,
            (SELECT count(*) FROM venue_seats vs WHERE vs.venue_id = v.id)::text AS seat_count,
            (SELECT count(*) FROM venue_seats vs WHERE vs.venue_id = v.id AND vs.category = 'standard')::text AS standard_count,
            (SELECT count(*) FROM venue_seats vs WHERE vs.venue_id = v.id AND vs.category = 'premium')::text AS premium_count,
            (SELECT count(*) FROM events e WHERE e.venue_id = v.id)::text AS event_count
     FROM venues v
     WHERE v.id = $1`,
    [venueId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    city: row.city,
    seatCount: Number(row.seat_count),
    seatsByCategory: {
      standard: Number(row.standard_count),
      premium: Number(row.premium_count),
    },
    eventCount: Number(row.event_count),
  };
}

export async function insertVenue(db: Queryable, input: CreateVenueInput): Promise<string> {
  const result = await db.query<IdRow>(
    `INSERT INTO venues (name, description, city)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [input.name, input.description ?? null, input.city ?? null],
  );

  // The insert always returns exactly one row or throws.
  return result.rows[0]!.id;
}

/**
 * Applies only the fields the caller actually sent. Built as a parameterised
 * SET list rather than COALESCE so that clearing a nullable column (city,
 * description) stays expressible - COALESCE would read an explicit "" as
 * "leave it alone".
 */
export async function updateVenueRow(db: Queryable, input: UpdateVenueInput): Promise<boolean> {
  const assignments: string[] = [];
  const params: unknown[] = [input.venueId];

  if (input.name !== undefined) {
    params.push(input.name);
    assignments.push(`name = $${params.length}`);
  }
  if (input.description !== undefined) {
    params.push(input.description === '' ? null : input.description);
    assignments.push(`description = $${params.length}`);
  }
  if (input.city !== undefined) {
    params.push(input.city === '' ? null : input.city);
    assignments.push(`city = $${params.length}`);
  }

  if (assignments.length === 0) {
    return true;
  }

  const result = await db.query(
    `UPDATE venues SET ${assignments.join(', ')} WHERE id = $1`,
    params,
  );

  return (result.rowCount ?? 0) === 1;
}

/** The venue's physical layout, ordered the way a seat map renders it. */
export async function listVenueSeats(db: Queryable, venueId: string): Promise<VenueSeat[]> {
  const result = await db.query<{
    id: string;
    row_label: string;
    seat_number: number;
    category: SeatCategory;
  }>(
    `SELECT id, row_label, seat_number, category
     FROM venue_seats
     WHERE venue_id = $1
     ORDER BY row_label, seat_number`,
    [venueId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    category: row.category,
  }));
}

/**
 * Adds every seat in the given blocks, expanding `fromSeat..toSeat` in SQL via
 * generate_series so one statement covers the whole request.
 *
 * `ON CONFLICT DO NOTHING` against `venue_seats_venue_row_seat_key` makes the
 * call idempotent: re-adding a row that partly exists tops it up instead of
 * failing, and a seat that already exists is never silently re-categorised -
 * changing a seat's category is its own explicit operation.
 *
 * Returns how many seats were actually created.
 */
export async function insertVenueSeats(
  db: Queryable,
  venueId: string,
  rows: readonly SeatRowInput[],
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }

  const result = await db.query(
    `INSERT INTO venue_seats (venue_id, row_label, seat_number, category)
     SELECT $1, block.row_label, seat.n, block.category
     FROM unnest($2::text[], $3::int[], $4::int[], $5::text[])
       AS block(row_label, from_seat, to_seat, category),
       LATERAL generate_series(block.from_seat, block.to_seat) AS seat(n)
     ON CONFLICT ON CONSTRAINT venue_seats_venue_row_seat_key DO NOTHING`,
    [
      venueId,
      rows.map((row) => row.rowLabel),
      rows.map((row) => row.fromSeat),
      rows.map((row) => row.toSeat),
      rows.map((row) => row.category),
    ],
  );

  return result.rowCount ?? 0;
}

/**
 * Re-categorises one physical seat. Scoped by venue as well as seat id so a
 * seat id from another venue cannot be edited through this venue's URL.
 *
 * Existing events keep the price they derived at creation: `show_seats.price`
 * is a stored column, not a lookup through `venue_seats.category`, so nothing
 * about an already-sold seat map moves under a customer mid-booking.
 */
export async function updateVenueSeatCategory(
  db: Queryable,
  venueId: string,
  seatId: string,
  category: SeatCategory,
): Promise<boolean> {
  const result = await db.query(
    'UPDATE venue_seats SET category = $3 WHERE id = $2 AND venue_id = $1',
    [venueId, seatId, category],
  );

  return (result.rowCount ?? 0) === 1;
}

/**
 * Removes a physical seat, again scoped by venue.
 *
 * A seat any event's inventory still refers to is protected by
 * `show_seats.venue_seat_id`'s ON DELETE RESTRICT - deleting it would silently
 * invalidate a published seat map. The count is taken here so the caller can
 * answer with a 409 explaining that, rather than letting a driver-level
 * foreign-key error surface as a 500.
 */
export async function countShowSeatsForVenueSeat(db: Queryable, seatId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM show_seats WHERE venue_seat_id = $1',
    [seatId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

export async function deleteVenueSeat(db: Queryable, venueId: string, seatId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM venue_seats WHERE id = $2 AND venue_id = $1', [
    venueId,
    seatId,
  ]);
  return (result.rowCount ?? 0) === 1;
}

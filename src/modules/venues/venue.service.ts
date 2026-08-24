import { pool } from '../../db/pool.js';
import { ConflictError, NotFoundError } from '../../errors/app-error.js';
import {
  countShowSeatsForVenueSeat,
  deleteVenueSeat as deleteVenueSeatRow,
  findVenueDetail,
  insertVenue,
  insertVenueSeats,
  listVenueSeats as listVenueSeatRows,
  listVenues as listVenuesRow,
  updateVenueRow,
  updateVenueSeatCategory,
} from './venue.repository.js';
import type {
  CreateVenueInput,
  SeatCategory,
  SeatRowInput,
  UpdateVenueInput,
  VenueDetail,
  VenueSeat,
  VenueSummary,
} from './venue.types.js';

export async function listVenues(): Promise<VenueSummary[]> {
  return listVenuesRow(pool);
}

/**
 * A venue that does not exist and a venue id that is merely wrong are the same
 * 404 everywhere in this module - the caller learns nothing from the
 * difference, and there is no ownership dimension to a venue: venues are
 * administered centrally, so the role gate at the route is the whole
 * authorization story here (unlike events, where owning *this* event is a
 * separate question answered in the service).
 */
export async function getVenue(venueId: string): Promise<VenueDetail> {
  const venue = await findVenueDetail(pool, venueId);
  if (venue === null) {
    throw new NotFoundError('Venue not found');
  }
  return venue;
}

export async function createVenue(input: CreateVenueInput): Promise<VenueDetail> {
  const venueId = await insertVenue(pool, input);
  // Re-read rather than assembling the response by hand, so the shape a client
  // sees after a create is byte-for-byte the shape it sees on any later read.
  return getVenue(venueId);
}

export async function updateVenue(input: UpdateVenueInput): Promise<VenueDetail> {
  const updated = await updateVenueRow(pool, input);
  if (!updated) {
    throw new NotFoundError('Venue not found');
  }
  return getVenue(input.venueId);
}

export async function listVenueSeats(venueId: string): Promise<VenueSeat[]> {
  // Existence first, so an unknown venue is a 404 rather than an empty layout.
  await getVenue(venueId);
  return listVenueSeatRows(pool, venueId);
}

export interface AddSeatsResult {
  created: number;
  seats: VenueSeat[];
}

/**
 * Adds seats to a venue's physical layout.
 *
 * Deliberately additive-only at the request level: nothing here rewrites or
 * re-derives any event's `show_seats`. Inventory is derived once, when an
 * event is created, and that behaviour is left untouched - so seats added now
 * apply to events created from this point on, and every already-published seat
 * map stays exactly as its customers see it.
 */
export async function addVenueSeats(
  venueId: string,
  rows: readonly SeatRowInput[],
): Promise<AddSeatsResult> {
  await getVenue(venueId);
  const created = await insertVenueSeats(pool, venueId, rows);
  return { created, seats: await listVenueSeatRows(pool, venueId) };
}

export async function setVenueSeatCategory(
  venueId: string,
  seatId: string,
  category: SeatCategory,
): Promise<VenueSeat[]> {
  await getVenue(venueId);
  const updated = await updateVenueSeatCategory(pool, venueId, seatId, category);
  if (!updated) {
    throw new NotFoundError('Seat not found in this venue');
  }
  return listVenueSeatRows(pool, venueId);
}

export async function removeVenueSeat(venueId: string, seatId: string): Promise<VenueSeat[]> {
  await getVenue(venueId);

  const inUse = await countShowSeatsForVenueSeat(pool, seatId);
  if (inUse > 0) {
    // The database would refuse this anyway (ON DELETE RESTRICT). Checking
    // first turns that into an answer an admin can act on.
    throw new ConflictError(
      'This seat is part of an existing event’s seat map and cannot be removed',
    );
  }

  const deleted = await deleteVenueSeatRow(pool, venueId, seatId);
  if (!deleted) {
    throw new NotFoundError('Seat not found in this venue');
  }

  return listVenueSeatRows(pool, venueId);
}

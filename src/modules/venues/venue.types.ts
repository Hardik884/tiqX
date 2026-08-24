import { SEAT_CATEGORIES } from '../events/event.types.js';
import type { SeatCategory } from '../events/event.types.js';

export { SEAT_CATEGORIES };
export type { SeatCategory };

export interface VenueSummary {
  id: string;
  name: string;
  description: string | null;
  city: string | null;
  seatCount: number;
}

/** One physical seat in a venue's layout. */
export interface VenueSeat {
  id: string;
  rowLabel: string;
  seatNumber: number;
  category: SeatCategory;
}

/**
 * A venue with its layout broken down the way the admin seat-layout view
 * renders it: total seats, per-category totals, and the rows themselves.
 */
export interface VenueDetail extends VenueSummary {
  seatsByCategory: Record<SeatCategory, number>;
  /** How many events already derived inventory from this layout - see venue.service.ts. */
  eventCount: number;
}

export interface CreateVenueInput {
  name: string;
  description?: string | undefined;
  city?: string | undefined;
}

export interface UpdateVenueInput {
  venueId: string;
  name?: string | undefined;
  description?: string | undefined;
  city?: string | undefined;
}

/**
 * One contiguous block of seats to add to a layout: row `A`, seats 1..12, all
 * one category. Layouts are built a row at a time in every real seat map, and
 * a block is the smallest unit that spares an admin twelve separate clicks.
 */
export interface SeatRowInput {
  rowLabel: string;
  fromSeat: number;
  toSeat: number;
  category: SeatCategory;
}

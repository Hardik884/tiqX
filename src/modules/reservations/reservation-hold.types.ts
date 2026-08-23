export const RESERVATION_HOLD_STATUSES = ['active', 'expired', 'converted', 'cancelled'] as const;

export type ReservationHoldStatus = (typeof RESERVATION_HOLD_STATUSES)[number];

/**
 * One customer's temporary claim on seats of a single event.
 *
 * `expiresAt` is data, not a rule the database enforces: whether a hold is
 * still usable is decided by the reservation service comparing it to the
 * current time. A row keeps `status = 'active'` until something transitions it,
 * so an active hold whose `expiresAt` has passed is expected and normal.
 */
export interface ReservationHold {
  id: string;
  eventId: string;
  userId: string;
  status: ReservationHoldStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The link between a hold and one show seat it covers.
 *
 * Deliberately narrow: the owning user, the event and the expiry live on the
 * hold and are reached through `holdId`.
 */
export interface ReservationHoldSeat {
  holdId: string;
  showSeatId: string;
  createdAt: Date;
}

/**
 * A seat that could not be acquired, and why. Returned to the client so it can
 * show which specific seats to re-pick.
 */
export interface UnavailableSeat {
  showSeatId: string;
  reason: 'booked' | 'held';
}

export interface CreateHoldInput {
  eventId: string;
  /**
   * TEMPORARY: supplied by the client until authentication exists, at which
   * point it comes from the authenticated principal instead. Never trust it
   * for authorisation.
   */
  userId: string;
  showSeatIds: readonly string[];
  ttlSeconds: number;
}

export interface CreateHoldResult {
  holdId: string;
  eventId: string;
  showSeatIds: string[];
  status: ReservationHoldStatus;
  expiresAt: Date;
}

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

export const SHOW_SEAT_STATUSES = ['available', 'held', 'booked'] as const;

export type ShowSeatStatus = (typeof SHOW_SEAT_STATUSES)[number];

/**
 * The inventory state of one physical seat for one event.
 *
 * Who holds or owns a seat is deliberately not stored here: temporary holds and
 * confirmed purchases become their own entities later.
 */
export interface ShowSeat {
  id: string;
  eventId: string;
  venueSeatId: string;
  status: ShowSeatStatus;
  createdAt: Date;
  updatedAt: Date;
}

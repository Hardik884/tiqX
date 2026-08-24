export const BOOKING_STATUSES = ['confirmed', 'cancelled'] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * A confirmed booking.
 *
 * Monetary values are strings all the way out to the response. PostgreSQL
 * returns NUMERIC as a string precisely so a driver cannot silently round it,
 * and converting to a JavaScript number here to convert back later would throw
 * that guarantee away for no gain: nothing in this service does arithmetic on
 * a total, it only stores and displays one.
 */
export interface BookingRecord {
  id: string;
  bookingReference: string;
  userId: string;
  eventId: string;
  holdId: string;
  status: BookingStatus;
  totalAmount: string;
  currency: string;
  createdAt: Date;
}

export interface BookingSeatRecord {
  showSeatId: string;
  price: string;
}

export interface ConfirmHoldInput {
  /** Always the authenticated principal; never a value from the request body. */
  userId: string;
  eventId: string;
  holdId: string;
}

export interface ConfirmHoldResult {
  booking: BookingRecord;
  seatCount: number;
}

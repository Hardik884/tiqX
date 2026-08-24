export type UserRole = 'customer' | 'organiser' | 'admin';

export interface User {
  id: string;
  role: UserRole;
}

export interface AuthResponse {
  user: { id: string; email: string; name: string | null; role: UserRole };
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export type EventCategory = 'music' | 'comedy' | 'sports' | 'theatre' | 'movies' | 'other';
export type EventType = 'movie' | 'concert';
export type EventSortMode = 'start_asc' | 'start_desc' | 'name_asc' | 'name_desc';

export interface PublicEventView {
  id: string;
  title: string;
  description: string | null;
  category: EventCategory;
  eventType: EventType;
  status: string;
  startsAt: string;
  endsAt: string;
  venue: { id: string; name: string; city: string | null };
  currency: string;
  availableSeats: number;
  startingPrice: string | null;
}

export interface ListEventsResult {
  items: PublicEventView[];
  pagination: { limit: number; nextCursor: string | null; hasMore: boolean };
}

export type SeatStatus = 'available' | 'held' | 'booked';

export interface SeatMapEntry {
  id: string;
  rowLabel: string;
  seatNumber: number;
  price: string;
  status: SeatStatus;
}

export interface HoldResponse {
  holdId: string;
  eventId: string;
  showSeatIds: string[];
  status: string;
  expiresAt: string;
}

export interface BookingResponse {
  bookingId: string;
  bookingReference: string;
  eventId: string;
  holdId: string;
  status: string;
  seatCount: number;
  totalAmount: string;
  currency: string;
  createdAt: string;
}

export interface CancellationResponse {
  bookingId: string;
  bookingReference: string;
  eventId: string;
  status: string;
  releasedSeatCount: number;
  totalAmount: string;
  currency: string;
  cancelledAt: string;
}

export interface MyBookingListItem {
  bookingId: string;
  bookingReference: string;
  status: 'confirmed' | 'cancelled';
  totalAmount: string;
  currency: string;
  createdAt: string;
  eventId: string;
  eventTitle: string;
  eventStartsAt: string;
  venueName: string;
  seatCount: number;
  ticketCount: number;
}

export interface MyBookingsResult {
  bookings: MyBookingListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface BookingDetailSeat {
  showSeatId: string;
  rowLabel: string;
  seatNumber: number;
  price: string;
  cancelled: boolean;
}

export interface BookingDetailTicket {
  id: string;
  ticketReference: string;
  status: 'issued' | 'used' | 'void';
  issuedAt: string;
  usedAt: string | null;
}

export interface BookingDetail {
  bookingId: string;
  bookingReference: string;
  status: 'confirmed' | 'cancelled';
  totalAmount: string;
  currency: string;
  createdAt: string;
  eventId: string;
  eventTitle: string;
  eventStartsAt: string;
  eventEndsAt: string;
  venueName: string;
  venueCity: string | null;
  seats: BookingDetailSeat[];
  tickets: BookingDetailTicket[];
}

export interface IssuedTicket {
  ticketId: string;
  ticketReference: string;
  status: string;
  issuedAt: string;
  qrPayload: { v: 1; ticketId: string; ticketReference: string };
}

export interface IssueTicketsResult {
  bookingId: string;
  eventId: string;
  ticketCount: number;
  tickets: IssuedTicket[];
}

export type SeatCategory = 'standard' | 'premium';

export interface WaitlistJoinResult {
  waitlistEntryId: string;
  eventId: string;
  seatCategory: SeatCategory;
  status: string;
}

export interface MyWaitlistEntry {
  waitlistEntryId: string;
  eventId: string;
  eventTitle: string;
  eventStartsAt: string;
  venueName: string;
  seatCategory: SeatCategory;
  status: 'waiting' | 'offered' | 'accepted' | 'expired' | 'cancelled';
  joinedAt: string;
  offer: { offerId: string; expiresAt: string; status: string } | null;
}

export interface AcceptOfferResult {
  offerId: string;
  eventId: string;
  status: string;
  bookingId: string;
  bookingReference: string;
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
  message?: string;
  code?: string;
  details?: unknown;
}

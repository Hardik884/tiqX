export type UserRole = 'customer' | 'organiser' | 'admin';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

export type EventStatus = 'draft' | 'published' | 'cancelled' | 'completed';
export type EventType = 'movie' | 'concert';
export type EventCategory = 'music' | 'comedy' | 'sports' | 'theatre' | 'movies' | 'other';

export interface EventView {
  id: string;
  title: string;
  description: string | null;
  category: EventCategory;
  eventType: EventType;
  status: EventStatus;
  startsAt: string;
  endsAt: string;
  venue: { id: string; name: string; city: string | null };
  currency: string;
  availableSeats: number;
  startingPrice: string | null;
  organiserId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrganiserEventsResult {
  events: EventView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface DashboardTotals {
  upcomingEvents: number;
  totalBookings: number;
  seatsSold: number;
  availableSeats: number;
  revenue: string;
}

export interface EventBookingSummary {
  totalBookings: number;
  seatsSold: number;
  availableSeats: number;
  revenue: string;
  currency: string;
}

export interface EventBookingListItem {
  id: string;
  bookingReference: string;
  status: string;
  totalAmount: string;
  currency: string;
  seatCount: number;
  customerName: string;
  customerEmail: string;
  createdAt: string;
}

export interface EventBookingsResult {
  bookings: EventBookingListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Venue {
  id: string;
  name: string;
  description: string | null;
  city: string | null;
  seatCount: number;
}

export interface SeatMapEntry {
  id: string;
  rowLabel: string;
  seatNumber: number;
  price: string;
  status: 'available' | 'held' | 'booked';
}

export interface FieldError {
  field: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: FieldError[] | { reason?: string } | unknown;
  };
}

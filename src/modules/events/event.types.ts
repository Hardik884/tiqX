import type { UserRole } from '../users/user.types.js';

export const EVENT_TYPES = ['movie', 'concert'] as const;
export const EVENT_STATUSES = ['draft', 'published', 'cancelled', 'completed'] as const;

/**
 * The genre a customer browses by - "music", "comedy" - distinct from
 * `eventType`, which is the medium ("movie", "concert"). A new, deliberately
 * small, curated vocabulary added for public discovery; see the
 * `1787508000000_event-discovery` migration for why it did not exist before.
 */
export const EVENT_CATEGORIES = ['music', 'comedy', 'sports', 'theatre', 'other'] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export interface EventRecord {
  id: string;
  organiserId: string;
  venueId: string;
  title: string;
  description: string | null;
  category: EventCategory;
  eventType: EventType;
  startsAt: Date;
  endsAt: Date;
  status: EventStatus;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Prices per seat category, as decimal strings.
 *
 * Strings, not numbers: the value goes straight to a NUMERIC column, and
 * parsing it into a JavaScript float on the way would reintroduce exactly the
 * imprecision NUMERIC exists to avoid.
 */
export type SeatPricing = Partial<Record<SeatCategory, string>>;

export const SEAT_CATEGORIES = ['standard', 'premium'] as const;
export type SeatCategory = (typeof SEAT_CATEGORIES)[number];

export interface CreateEventInput {
  organiserId: string;
  venueId: string;
  title: string;
  description?: string | undefined;
  /** Optional so existing callers keep working; defaults to 'other' - see insertEvent. */
  category?: EventCategory | undefined;
  eventType: EventType;
  startsAt: Date;
  endsAt: Date;
  status?: EventStatus | undefined;
  /** Omitted seat categories keep the column default of 0, i.e. a free seat. */
  pricing?: SeatPricing | undefined;
  currency?: string | undefined;
}

/**
 * Always the authenticated principal - see event.service.ts for why every
 * resource-authorization decision is made from these two fields alone.
 */
export interface RequestingUser {
  userId: string;
  userRole: UserRole;
}

/** The event as returned to an anonymous or customer caller - see event.service.ts. */
export interface PublicEventView {
  id: string;
  title: string;
  description: string | null;
  category: EventCategory;
  eventType: EventType;
  status: EventStatus;
  startsAt: Date;
  endsAt: Date;
  venue: { id: string; name: string; city: string | null };
  currency: string;
  availableSeats: number;
  /**
   * The lowest price among this event's currently *available* seats, or null
   * if none are available. Never computed from booking records - see
   * event.repository.ts::getSeatSummaryForEvents. Like `availableSeats`, this
   * is informational: it can change the instant after the response is sent,
   * and the reservation transaction is what actually prices a seat.
   */
  startingPrice: string | null;
}

/**
 * The event as returned to its owning organiser or an admin.
 *
 * `currency` moved onto `PublicEventView` itself when `startingPrice` was
 * added for public discovery - a price with no stated currency is ambiguous,
 * so anywhere a price is shown, the currency must be too. What stays private
 * here is who runs the event and its full audit timestamps.
 */
export interface PrivateEventView extends PublicEventView {
  organiserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateEventInput extends RequestingUser {
  eventId: string;
  title?: string | undefined;
  description?: string | undefined;
  category?: EventCategory | undefined;
  startsAt?: Date | undefined;
  endsAt?: Date | undefined;
}

export interface PublishEventInput extends RequestingUser {
  eventId: string;
}

export interface DeleteEventInput extends RequestingUser {
  eventId: string;
}

export interface ListOrganiserEventsInput extends RequestingUser {
  page: number;
  limit: number;
  /** Admin-only: list every organiser's events rather than just their own. */
  all: boolean;
}

export interface ListOrganiserEventsResult {
  events: PrivateEventView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * The sort allowlist for public discovery. These four strings are the only
 * ones that ever reach SQL, and only as a lookup key into a fixed map of
 * `ORDER BY` fragments - never interpolated. See event.repository.ts.
 */
export const EVENT_SORT_MODES = ['start_asc', 'start_desc', 'name_asc', 'name_desc'] as const;
export type EventSortMode = (typeof EVENT_SORT_MODES)[number];

/**
 * The opaque keyset-pagination cursor. `sort` is encoded *in* the cursor so a
 * cursor minted under one sort can be rejected outright if presented against
 * a different one, rather than silently reinterpreting its `key` under the
 * wrong ordering - see event.schema.ts.
 *
 * `key` is always a string: for the two `start_*` sorts it is the ISO-8601
 * `startsAt` of the last row on the previous page (which, being fixed-width
 * UTC, sorts identically as a string and as a timestamp - no special-casing
 * needed to compare it); for the two `name_*` sorts it is that row's `title`.
 * `id` is the deterministic tie-breaker every sort orders by second.
 */
export interface EventCursor {
  v: 1;
  sort: EventSortMode;
  key: string;
  id: string;
}

export interface PublicEventListFilters {
  q?: string | undefined;
  category?: EventCategory | undefined;
  eventType?: EventType | undefined;
  city?: string | undefined;
  venueId?: string | undefined;
  startFrom?: Date | undefined;
  startTo?: Date | undefined;
}

export interface ListPublicEventsInput {
  filters: PublicEventListFilters;
  sort: EventSortMode;
  limit: number;
  /** Already decoded and validated against `sort` - see event.service.ts. */
  cursor: EventCursor | null;
}

export interface ListPublicEventsResult {
  items: PublicEventView[];
  pagination: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
}

export interface OrganiserDashboardInput extends RequestingUser {
  /** Admin-only: aggregate across every organiser's events rather than just the caller's own. */
  all: boolean;
}

export interface OrganiserDashboardTotals {
  upcomingEvents: number;
  totalBookings: number;
  seatsSold: number;
  availableSeats: number;
  revenue: string;
}

export interface EventSummaryInput extends RequestingUser {
  eventId: string;
}

export interface EventBookingSummaryView {
  totalBookings: number;
  seatsSold: number;
  availableSeats: number;
  revenue: string;
  currency: string;
}

export interface ListEventBookingsInput extends RequestingUser {
  eventId: string;
  page: number;
  limit: number;
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
  createdAt: Date;
}

export interface ListEventBookingsResult {
  bookings: EventBookingListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** One row of the public seat map - see event.service.ts::getPublicSeatMap. */
export interface PublicSeatMapEntry {
  id: string;
  rowLabel: string;
  seatNumber: number;
  price: string;
  status: 'available' | 'held' | 'booked';
}

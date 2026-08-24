export const EVENT_TYPES = ['movie', 'concert'] as const;
export const EVENT_STATUSES = ['draft', 'published', 'cancelled', 'completed'] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface EventRecord {
  id: string;
  organiserId: string;
  venueId: string;
  title: string;
  description: string | null;
  eventType: EventType;
  startsAt: Date;
  endsAt: Date;
  status: EventStatus;
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
  eventType: EventType;
  startsAt: Date;
  endsAt: Date;
  status?: EventStatus | undefined;
  /** Omitted categories keep the column default of 0, i.e. a free seat. */
  pricing?: SeatPricing | undefined;
  currency?: string | undefined;
}

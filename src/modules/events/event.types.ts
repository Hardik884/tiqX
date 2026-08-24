import type { UserRole } from '../users/user.types.js';

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
  eventType: EventType;
  startsAt: Date;
  endsAt: Date;
  status?: EventStatus | undefined;
  /** Omitted categories keep the column default of 0, i.e. a free seat. */
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
  eventType: EventType;
  status: EventStatus;
  startsAt: Date;
  endsAt: Date;
  venue: { id: string; name: string };
  availableSeats: number;
}

/** The event as returned to its owning organiser or an admin. */
export interface PrivateEventView extends PublicEventView {
  organiserId: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateEventInput extends RequestingUser {
  eventId: string;
  title?: string | undefined;
  description?: string | undefined;
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

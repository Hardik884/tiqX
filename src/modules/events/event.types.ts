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

export interface CreateEventInput {
  organiserId: string;
  venueId: string;
  title: string;
  description?: string | undefined;
  eventType: EventType;
  startsAt: Date;
  endsAt: Date;
  status?: EventStatus | undefined;
}

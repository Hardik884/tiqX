import { apiRequest, buildQuery } from './client';
import type { EventCategory, EventSortMode, EventType, ListEventsResult, PublicEventView, SeatMapEntry } from './types';

export interface EventSearchParams extends Record<string, string | number | undefined> {
  q?: string;
  category?: EventCategory;
  eventType?: EventType;
  city?: string;
  startFrom?: string;
  startTo?: string;
  sort?: EventSortMode;
  limit?: number;
  cursor?: string;
}

export function searchEvents(params: EventSearchParams): Promise<ListEventsResult> {
  return apiRequest<ListEventsResult>(`/api/v1/events${buildQuery(params)}`, { anonymous: true });
}

export function getEvent(eventId: string): Promise<PublicEventView> {
  return apiRequest<PublicEventView>(`/api/v1/events/${eventId}`, { anonymous: true });
}

export function getSeatMap(eventId: string): Promise<{ seats: SeatMapEntry[] }> {
  return apiRequest<{ seats: SeatMapEntry[] }>(`/api/v1/events/${eventId}/seats`, { anonymous: true });
}

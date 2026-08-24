import { apiRequest, buildQuery } from './client';
import type {
  CreateEventPayload,
  DashboardTotals,
  EventBookingSummary,
  EventBookingsResult,
  ManagedEventView,
  OrganiserEventsResult,
  SeatMapEntry,
  UpdateEventPayload,
} from './types';

/**
 * The organiser/admin half of the API. Every call here is an endpoint the
 * backend already had before this frontend was unified - see docs/API.md - so
 * nothing in this file introduces business logic; it is transport only.
 *
 * `all: true` is honoured by the backend for admins only. An organiser sending
 * it is silently scoped back to their own events, which is why the admin views
 * can share these functions rather than duplicating them.
 */
export function getDashboardTotals(all = false): Promise<DashboardTotals> {
  return apiRequest<DashboardTotals>(
    `/api/v1/organiser/dashboard${buildQuery({ all: all ? 'true' : undefined })}`,
  );
}

export function listOrganiserEvents(params: {
  page?: number;
  limit?: number;
  all?: boolean;
}): Promise<OrganiserEventsResult> {
  return apiRequest<OrganiserEventsResult>(
    `/api/v1/organiser/events${buildQuery({
      page: params.page,
      limit: params.limit,
      all: params.all === true ? 'true' : undefined,
    })}`,
  );
}

/**
 * The authenticated read of a single event. Deliberately not the `anonymous`
 * request the discovery pages use: the backend widens this same route's
 * response for the event's own organiser or an admin, and a draft event is
 * only visible at all to those callers.
 */
export function getManagedEvent(eventId: string): Promise<ManagedEventView> {
  return apiRequest<ManagedEventView>(`/api/v1/events/${eventId}`);
}

export function getEventSummary(eventId: string): Promise<EventBookingSummary> {
  return apiRequest<EventBookingSummary>(`/api/v1/organiser/events/${eventId}/summary`);
}

export function listEventBookings(
  eventId: string,
  params: { page?: number; limit?: number } = {},
): Promise<EventBookingsResult> {
  return apiRequest<EventBookingsResult>(
    `/api/v1/organiser/events/${eventId}/bookings${buildQuery({
      page: params.page,
      limit: params.limit,
    })}`,
  );
}

export function createEvent(
  payload: CreateEventPayload,
): Promise<{ event: ManagedEventView; seatInventoryCount: number }> {
  return apiRequest('/api/v1/events', { method: 'POST', body: payload });
}

export function updateEvent(
  eventId: string,
  payload: UpdateEventPayload,
): Promise<{ event: ManagedEventView }> {
  return apiRequest(`/api/v1/events/${eventId}`, { method: 'PATCH', body: payload });
}

export function publishEvent(eventId: string): Promise<{ event: ManagedEventView }> {
  return apiRequest(`/api/v1/events/${eventId}/publish`, { method: 'POST' });
}

export function deleteEvent(eventId: string): Promise<void> {
  return apiRequest(`/api/v1/events/${eventId}`, { method: 'DELETE' });
}

/** The seat map of one event, read with the caller's identity so drafts resolve. */
export function getEventSeatMap(eventId: string): Promise<{ seats: SeatMapEntry[] }> {
  return apiRequest<{ seats: SeatMapEntry[] }>(`/api/v1/events/${eventId}/seats`);
}

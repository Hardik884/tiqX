import { apiRequest } from './client';
import type { SeatCategory, SeatRowPayload, VenueDetail, VenueSeat, VenueSummary } from './types';

/**
 * Venues and their physical seat layout.
 *
 * Reads are open to organiser and admin (an organiser has to pick a venue, and
 * see what they are selling); every write is admin-only. The gate that matters
 * is the backend's - see venue.routes.ts - and these functions simply surface
 * whatever it answers.
 */
export function listVenues(): Promise<{ venues: VenueSummary[] }> {
  return apiRequest<{ venues: VenueSummary[] }>('/api/v1/venues');
}

export function getVenue(venueId: string): Promise<{ venue: VenueDetail }> {
  return apiRequest<{ venue: VenueDetail }>(`/api/v1/venues/${venueId}`);
}

export function createVenue(body: {
  name: string;
  description?: string;
  city?: string;
}): Promise<{ venue: VenueDetail }> {
  return apiRequest('/api/v1/venues', { method: 'POST', body });
}

export function updateVenue(
  venueId: string,
  body: { name?: string; description?: string; city?: string },
): Promise<{ venue: VenueDetail }> {
  return apiRequest(`/api/v1/venues/${venueId}`, { method: 'PATCH', body });
}

export function listVenueSeats(venueId: string): Promise<{ seats: VenueSeat[] }> {
  return apiRequest<{ seats: VenueSeat[] }>(`/api/v1/venues/${venueId}/seats`);
}

export function addVenueSeats(
  venueId: string,
  rows: SeatRowPayload[],
): Promise<{ created: number; seats: VenueSeat[] }> {
  return apiRequest(`/api/v1/venues/${venueId}/seats`, { method: 'POST', body: { rows } });
}

export function setSeatCategory(
  venueId: string,
  seatId: string,
  category: SeatCategory,
): Promise<{ seats: VenueSeat[] }> {
  return apiRequest(`/api/v1/venues/${venueId}/seats/${seatId}`, {
    method: 'PATCH',
    body: { category },
  });
}

export function deleteVenueSeat(venueId: string, seatId: string): Promise<{ seats: VenueSeat[] }> {
  return apiRequest(`/api/v1/venues/${venueId}/seats/${seatId}`, { method: 'DELETE' });
}

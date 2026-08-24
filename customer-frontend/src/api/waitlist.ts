import { apiRequest } from './client';
import type { AcceptOfferResult, MyWaitlistEntry, SeatCategory, WaitlistJoinResult } from './types';

export function joinWaitlist(
  eventId: string,
  seatCategory: SeatCategory,
  idempotencyKey: string,
): Promise<WaitlistJoinResult> {
  return apiRequest<WaitlistJoinResult>(`/api/v1/events/${eventId}/waitlist`, {
    method: 'POST',
    body: { seatCategory },
    idempotencyKey,
  });
}

export function leaveWaitlist(eventId: string, entryId: string): Promise<{ waitlistEntryId: string; status: string }> {
  return apiRequest(`/api/v1/events/${eventId}/waitlist/${entryId}/leave`, { method: 'POST' });
}

export function listMyWaitlistEntries(): Promise<{ entries: MyWaitlistEntry[] }> {
  return apiRequest('/api/v1/waitlist/mine');
}

export function acceptWaitlistOffer(offerId: string, idempotencyKey: string): Promise<AcceptOfferResult> {
  return apiRequest<AcceptOfferResult>(`/api/v1/waitlist/offers/${offerId}/accept`, {
    method: 'POST',
    idempotencyKey,
  });
}

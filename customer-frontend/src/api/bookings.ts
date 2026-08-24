import { apiRequest } from './client';
import type {
  BookingDetail,
  BookingResponse,
  CancellationResponse,
  HoldResponse,
  IssueTicketsResult,
  MyBookingsResult,
} from './types';

export function createHold(
  eventId: string,
  showSeatIds: string[],
  ttlSeconds: number | undefined,
  idempotencyKey: string,
): Promise<HoldResponse> {
  return apiRequest<HoldResponse>(`/api/v1/events/${eventId}/holds`, {
    method: 'POST',
    body: { showSeatIds, ttlSeconds },
    idempotencyKey,
  });
}

export function confirmHold(
  eventId: string,
  holdId: string,
  idempotencyKey: string,
): Promise<BookingResponse> {
  return apiRequest<BookingResponse>(`/api/v1/events/${eventId}/holds/${holdId}/confirm`, {
    method: 'POST',
    idempotencyKey,
  });
}

/** Voluntarily gives up a still-active hold so its seats go back to available immediately. */
export function releaseHold(
  eventId: string,
  holdId: string,
): Promise<{ holdId: string; eventId: string; status: string; releasedSeatCount: number }> {
  return apiRequest(`/api/v1/events/${eventId}/holds/${holdId}/release`, { method: 'POST' });
}

export function cancelBooking(bookingId: string, idempotencyKey: string): Promise<CancellationResponse> {
  return apiRequest<CancellationResponse>(`/api/v1/bookings/${bookingId}/cancel`, {
    method: 'POST',
    idempotencyKey,
  });
}

export function issueTickets(bookingId: string, idempotencyKey: string): Promise<IssueTicketsResult> {
  return apiRequest<IssueTicketsResult>(`/api/v1/bookings/${bookingId}/tickets/issue`, {
    method: 'POST',
    idempotencyKey,
  });
}

export function listMyBookings(page: number, limit = 10): Promise<MyBookingsResult> {
  return apiRequest<MyBookingsResult>(`/api/v1/bookings?page=${page}&limit=${limit}`);
}

export function getBookingDetail(bookingId: string): Promise<BookingDetail> {
  return apiRequest<BookingDetail>(`/api/v1/bookings/${bookingId}`);
}

import type { SeatCategory } from '../events/event.types.js';

export const WAITLIST_ENTRY_STATUSES = [
  'waiting',
  'offered',
  'accepted',
  'expired',
  'cancelled',
] as const;
export type WaitlistEntryStatus = (typeof WAITLIST_ENTRY_STATUSES)[number];

export const WAITLIST_OFFER_STATUSES = ['offered', 'accepted', 'expired'] as const;
export type WaitlistOfferStatus = (typeof WAITLIST_OFFER_STATUSES)[number];

export interface WaitlistEntryRecord {
  id: string;
  eventId: string;
  userId: string;
  seatCategory: SeatCategory;
  status: WaitlistEntryStatus;
  joinedAt: Date;
  updatedAt: Date;
}

export interface WaitlistOfferRecord {
  id: string;
  waitlistEntryId: string;
  showSeatId: string;
  holdId: string;
  expiresAt: Date;
  status: WaitlistOfferStatus;
  createdAt: Date;
  acceptedAt: Date | null;
  expiredAt: Date | null;
}

export interface JoinWaitlistInput {
  /** Always the authenticated principal; never a value from the request body. */
  userId: string;
  eventId: string;
  seatCategory: SeatCategory;
}

export interface JoinWaitlistResult {
  entry: WaitlistEntryRecord;
}

export interface LeaveWaitlistInput {
  userId: string;
  entryId: string;
}

export interface AcceptOfferInput {
  userId: string;
  offerId: string;
}

export interface AcceptOfferResult {
  offer: WaitlistOfferRecord;
  eventId: string;
  bookingId: string;
  bookingReference: string;
}

/**
 * The payload a notification worker would need - see
 * waitlist_notification_outbox in the migration. Safe identifiers only:
 * nothing here could stand in for a credential.
 */
export interface WaitlistOfferNotificationPayload {
  v: 1;
  offerId: string;
  waitlistEntryId: string;
  userId: string;
  eventId: string;
  showSeatId: string;
  expiresAt: string;
}

import { createHash } from 'node:crypto';

/**
 * The fields of a hold request that change what the operation actually does.
 * Anything absent from here may differ between a request and its retry without
 * making them different requests.
 */
export interface HoldRequestFingerprint {
  userId: string;
  eventId: string;
  showSeatIds: readonly string[];
  ttlSeconds: number;
}

/**
 * A stable SHA-256 digest of what a hold request means, used to detect a key
 * being reused for a materially different request.
 *
 * The raw body is deliberately not hashed. Key order, whitespace and seat order
 * are all presentation, not meaning: `["A13","A12"]` asks for the same hold as
 * `["A12","A13"]`, and a client that reformats its JSON on retry must still be
 * recognised as retrying. So the digest is taken over a canonical form -
 * fixed field order, seat ids sorted - rather than over the bytes received.
 *
 * The `v` field versions the canonical form. If the shape ever changes, old
 * digests stop matching instead of silently colliding with new ones.
 */
export function hashHoldRequest(fingerprint: HoldRequestFingerprint): string {
  const canonical = JSON.stringify({
    v: 1,
    userId: fingerprint.userId,
    eventId: fingerprint.eventId,
    showSeatIds: [...fingerprint.showSeatIds].sort(),
    ttlSeconds: fingerprint.ttlSeconds,
  });

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The fields that identify one confirmation request.
 *
 * A confirmation has no meaningful body - the hold id is in the URL - so the
 * identity is the tuple that decides what the operation does: who is asking,
 * which event, which hold. Reusing a key for a different hold is therefore a
 * mismatch and is refused, exactly as it is for a hold request.
 */
export interface ConfirmRequestFingerprint {
  userId: string;
  eventId: string;
  holdId: string;
}

/** Versioned separately from the hold digest, so the two can never collide. */
export function hashConfirmRequest(fingerprint: ConfirmRequestFingerprint): string {
  const canonical = JSON.stringify({
    v: 1,
    op: 'confirm-hold',
    userId: fingerprint.userId,
    eventId: fingerprint.eventId,
    holdId: fingerprint.holdId,
  });

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The fields that identify one cancellation request.
 *
 * No event id here, unlike confirmation: the cancellation URL is
 * /bookings/:bookingId/cancel and a booking id is globally unique, so the event
 * would be a derived value rather than part of what the caller asked for.
 * Including it would also mean a caller could not retry without re-deriving it.
 */
export interface CancelRequestFingerprint {
  userId: string;
  bookingId: string;
}

/** Versioned and tagged separately, so no two operations can share a digest. */
export function hashCancelRequest(fingerprint: CancelRequestFingerprint): string {
  const canonical = JSON.stringify({
    v: 1,
    op: 'cancel-booking',
    userId: fingerprint.userId,
    bookingId: fingerprint.bookingId,
  });

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The fields that identify one ticket-issuance request.
 *
 * No `role` here: role decides *authorisation*, checked fresh from the
 * database inside the transaction, not what makes two requests the same
 * request. A caller whose role changed between the original call and a retry
 * still means "issue tickets for this booking" - the same request either way.
 */
export interface IssueTicketsRequestFingerprint {
  userId: string;
  bookingId: string;
}

/** Versioned and tagged separately, so no two operations can share a digest. */
export function hashIssueTicketsRequest(fingerprint: IssueTicketsRequestFingerprint): string {
  const canonical = JSON.stringify({
    v: 1,
    op: 'issue-tickets',
    userId: fingerprint.userId,
    bookingId: fingerprint.bookingId,
  });

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

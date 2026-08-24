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

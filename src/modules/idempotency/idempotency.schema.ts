import { z } from 'zod';

/** Express lowercases incoming header names. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Printable ASCII without spaces: long enough for a UUID or an opaque token,
 * strict enough to keep control characters and stray whitespace out of a value
 * that becomes part of a database key.
 */
const KEY_PATTERN = /^[\x21-\x7e]+$/;

export const idempotencyKeySchema = z
  .string()
  .min(1, 'Idempotency-Key must not be empty')
  .max(MAX_IDEMPOTENCY_KEY_LENGTH, `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`)
  .regex(KEY_PATTERN, 'Idempotency-Key must contain only printable ASCII characters');
